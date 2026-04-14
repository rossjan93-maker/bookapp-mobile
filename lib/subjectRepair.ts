// =============================================================================
// Subject Repair — targeted enrichment for books with null or sparse subjects
// =============================================================================
// repairSubjectCoverage — queries the books table for rows where subjects is
// null (priority 1) or has fewer than 3 entries (priority 2), then attempts to
// fill them via Open Library.  Books with an existing external_id are processed
// first (no OL search needed).  Subjects are only written when the OL result is
// strictly better (more subjects) than what is already stored.
//
// Cursor-based progression (afterId)
// ───────────────────────────────────
// Every query uses ORDER BY id ASC and optionally id > afterId.  This means
// repeated runs always advance forward through the table.  Failed and skipped
// books are included in the cursor window exactly once per pass — they are not
// re-queued on subsequent runs within the same cursor segment.  The returned
// RepairSummary.lastId is the id of the last candidate processed; pass it as
// the afterId of the next run to continue from where this one left off.
//
// The function requires an explicit Supabase client via opts.client.  This
// keeps lib/subjectRepair.ts free of React Native / AsyncStorage imports so the
// standalone CLI script can run it in a plain Node.js environment.
//
//   In the app:   pass supabase from lib/supabase
//   In scripts:   pass createClient(url, serviceRoleKey) for RLS bypass
//
// Fatal top-level errors throw so scripts can exit non-zero.  Per-book errors
// remain fail-soft (caught and counted as failed).
//
// Used by:
//   - scripts/repairSubjectCoverage.ts  (CLI, injects a Node.js client)
//   - app/settings.tsx                  (__DEV__ developer trigger with alert)
// =============================================================================

import { fetchOLMeta, searchOLWork, isOLId } from './openLibrary';
import type { SupabaseClient }              from '@supabase/supabase-js';

export type RepairSummary = {
  eligible:       number;
  enriched:       number;
  failed:         number;
  skipped:        number;
  fieldsImproved: number;
  /**
   * The id of the last candidate book that entered the processing loop.
   * Pass as opts.afterId in the next call to continue from this point.
   * Null when eligible=0 (nothing was processed).
   */
  lastId:         string | null;
};

export type SubjectRepairOptions = {
  userId?:    string;
  batchSize?: number;
  dryRun?:    boolean;
  /**
   * Cursor: only consider books with id > afterId (lexicographic / UUID order).
   * Use RepairSummary.lastId from the previous run to page through the dataset.
   */
  afterId?:   string;
  /**
   * Supabase client to use.  Required — no internal default.
   * App callers pass the lib/supabase singleton; scripts pass a service-role client.
   */
  client:     SupabaseClient | null;
};

const LOG = '[SUBJECT_REPAIR]';

type CandidateBook = {
  id:          string;
  title:       string | null;
  author:      string | null;
  external_id: string | null;
  subjects:    string[] | null;
};

export async function repairSubjectCoverage(
  opts: SubjectRepairOptions,
): Promise<RepairSummary> {
  const { userId, batchSize = 50, dryRun = false, afterId, client: db } = opts;

  if (!db) {
    throw new Error(`${LOG} No Supabase client provided — pass opts.client`);
  }

  const summary: RepairSummary = {
    eligible: 0, enriched: 0, failed: 0, skipped: 0, fieldsImproved: 0, lastId: null,
  };

  // ── Step 1: resolve book IDs for this user when userId is supplied ────────
  let filterIds: string[] | null = null;
  if (userId) {
    const { data, error } = await db
      .from('user_books')
      .select('book_id')
      .eq('user_id', userId);

    if (error) {
      throw new Error(`${LOG} user_books query failed — ${error.message}`);
    }

    filterIds = (data ?? []).map((r: { book_id: string }) => r.book_id);

    if (filterIds.length === 0) {
      console.log(`${LOG} user has no books — nothing to repair`);
      return summary;
    }

    console.log(`${LOG} user ${userId.slice(0, 8)}… has ${filterIds.length} book(s) in library`);
  }

  if (afterId) {
    console.log(`${LOG} cursor afterId=${afterId}`);
  }

  // ── Step 2: Priority-1 candidates — subjects IS NULL ─────────────────────
  // Order by id ASC with optional cursor so each run window is deterministic
  // and does not re-visit rows from previous runs.
  let q1 = db
    .from('books')
    .select('id, title, author, external_id, subjects')
    .is('subjects', null)
    .order('id', { ascending: true });

  if (afterId) q1 = (q1 as typeof q1).gt('id', afterId);
  if (filterIds) q1 = (q1 as typeof q1).in('id', filterIds);

  const { data: p1Data, error: p1Err } = await (q1 as typeof q1).limit(batchSize);
  if (p1Err) {
    throw new Error(`${LOG} priority-1 query failed — ${p1Err.message}`);
  }
  const p1: CandidateBook[] = (p1Data ?? []) as CandidateBook[];

  // ── Step 3: Priority-2 candidates — subjects exists but < 3 entries ──────
  // DB-side limit: batchSize * 10 bounds the read while providing enough rows
  // to find sparse candidates after the in-memory length filter.  The cursor
  // ensures we advance forward rather than revisiting the same leading rows.
  let p2: CandidateBook[] = [];
  const slots = batchSize - p1.length;

  if (slots > 0) {
    let q2 = db
      .from('books')
      .select('id, title, author, external_id, subjects')
      .not('subjects', 'is', null)
      .order('id', { ascending: true });

    if (afterId) q2 = (q2 as typeof q2).gt('id', afterId);
    if (filterIds) {
      // User-scoped: filterIds bounds the result set to just this user's books.
      q2 = (q2 as typeof q2).in('id', filterIds);
    } else {
      // Global: cap DB read at batchSize * 10 to avoid full-table scans while
      // still giving the in-memory filter enough rows to find sparse candidates.
      q2 = (q2 as typeof q2).limit(batchSize * 10);
    }

    const { data: p2Raw, error: p2Err } = await (q2 as typeof q2);
    if (p2Err) {
      throw new Error(`${LOG} priority-2 query failed — ${p2Err.message}`);
    }

    // In-memory filter for rows that genuinely have < 3 subjects.
    // PostgREST does not expose an array-length predicate, so we prune here.
    p2 = ((p2Raw ?? []) as CandidateBook[])
      .filter(b => Array.isArray(b.subjects) && (b.subjects as string[]).length < 3)
      .slice(0, slots);
  }

  // ── Step 4: Merge — books with a valid OL external_id float to the top ────
  // De-duplicate across priority sets, then prioritize books whose OL work key
  // is already known (no search round-trip needed).
  const seen = new Set<string>();
  const candidates: CandidateBook[] = [...p1, ...p2]
    .filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; })
    .sort((a, b) => (isOLId(a.external_id) ? 0 : 1) - (isOLId(b.external_id) ? 0 : 1))
    .slice(0, batchSize);

  summary.eligible = candidates.length;

  const withExtId = candidates.filter(b => isOLId(b.external_id)).length;
  console.log(
    `${LOG} eligible=${candidates.length} ` +
    `(p1_null=${p1.length} p2_sparse=${p2.length} with_ext_id=${withExtId}) ` +
    `dryRun=${dryRun}`,
  );

  // Track the highest id seen so we can return it as the next cursor.
  // We record every candidate id (including failed/skipped) so the cursor
  // reliably advances past non-enrichable books on repeated runs.
  let lastId: string | null = null;

  // ── Step 5: Enrich each candidate (per-book errors are fail-soft) ─────────
  for (const book of candidates) {
    // Advance cursor for every candidate regardless of outcome.
    lastId = book.id;

    const t = String(book.title  ?? '').trim();
    const a = String(book.author ?? '').trim();
    const currentSubjects: string[] = Array.isArray(book.subjects)
      ? (book.subjects as string[])
      : [];

    // Safety guard — never overwrite subjects already ≥ 3 entries.
    // Normally excluded by the query but guards against races or stale reads.
    if (currentSubjects.length >= 3) {
      summary.skipped++;
      if (__DEV__) console.log(`${LOG} skip "${t}" — already has ${currentSubjects.length} subjects`);
      continue;
    }

    try {
      let resolvedExtId: string | null = isOLId(book.external_id) ? book.external_id : null;
      let extIdFound = false;

      // Search Open Library when there is no valid external_id yet
      if (!resolvedExtId && t) {
        if (__DEV__) console.log(`${LOG} searching OL for "${t}"…`);
        const found = await searchOLWork(t, a);
        if (found) {
          resolvedExtId = found;
          extIdFound    = true;
          console.log(`${LOG} OL work found for "${t}" → ${found}`);
        }
      }

      if (!resolvedExtId) {
        summary.failed++;
        console.log(`${LOG} no OL ID for "${t}" — cannot enrich`);
        continue;
      }

      const ol = await fetchOLMeta(resolvedExtId);

      if (ol.subjects.length === 0) {
        summary.failed++;
        console.log(`${LOG} OL returned 0 subjects for "${t}"`);
        continue;
      }

      // Only write subjects when OL result is strictly better than current.
      // Prevents a 1-subject OL result from displacing an existing 2-entry array.
      if (ol.subjects.length <= currentSubjects.length && currentSubjects.length > 0) {
        summary.skipped++;
        console.log(
          `${LOG} skip "${t}" — OL ${ol.subjects.length} subjects not an improvement over existing ${currentSubjects.length}`,
        );
        continue;
      }

      const preview = ol.subjects.slice(0, 3).join(', ');
      console.log(
        `${LOG} enriched "${t}" [${currentSubjects.length} → ${ol.subjects.length}] ` +
        `(${preview}${ol.subjects.length > 3 ? '…' : ''})`,
      );

      if (!dryRun) {
        const patch: Record<string, unknown> = { subjects: ol.subjects };

        // Back-fill external_id when we had to search for it
        if (extIdFound) patch.external_id = resolvedExtId;

        const { error } = await db
          .from('books')
          .update(patch)
          .eq('id', book.id);

        if (error) {
          summary.failed++;
          console.log(`${LOG} db update failed for "${t}" — ${error.message}`);
          continue;
        }

        summary.fieldsImproved++;               // subjects written
        if (extIdFound) summary.fieldsImproved++; // external_id also written
      } else {
        // Dry run — count what would be improved without writing
        summary.fieldsImproved++;
        if (extIdFound) summary.fieldsImproved++;
      }

      summary.enriched++;

    } catch (err) {
      summary.failed++;
      console.log(`${LOG} error processing "${t}" — ${String(err)}`);
    }
  }

  // Any candidate not enriched, failed, or explicitly skipped (edge case)
  const accounted = summary.enriched + summary.failed + summary.skipped;
  if (accounted < summary.eligible) {
    summary.skipped += summary.eligible - accounted;
  }

  summary.lastId = lastId;

  console.log(
    `${LOG} done — ` +
    `eligible=${summary.eligible} ` +
    `enriched=${summary.enriched} ` +
    `failed=${summary.failed} ` +
    `skipped=${summary.skipped} ` +
    `fieldsImproved=${summary.fieldsImproved} ` +
    `lastId=${lastId ?? 'none'}` +
    (dryRun ? ' [DRY RUN]' : ''),
  );

  return summary;
}
