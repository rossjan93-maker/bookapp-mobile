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
// Every query uses ORDER BY id ASC and optionally id > afterId.  The returned
// RepairSummary.lastId is the furthest book id seen across ALL query results in
// this run — including dense p2 rows that were not sparse enough to become
// candidates.  This guarantees the cursor always advances, even in runs where
// eligible=0 (entirely dense window).  Pass lastId as afterId next run to
// continue forward through the dataset without revisiting rows.
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
   * The furthest book id read from any query in this run.
   * Advances past dense windows where no sparse candidates were found, so
   * the next call with afterId=lastId is never stuck at the same position.
   * Null only when no rows exist at or after the current afterId cursor.
   */
  lastId:         string | null;
};

export type SubjectRepairOptions = {
  userId?:    string;
  batchSize?: number;
  dryRun?:    boolean;
  /**
   * Cursor: only consider books with id > afterId (lexicographic / UUID order).
   * Use RepairSummary.lastId from the previous run to page forward deterministically.
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

/** Return the lexicographically larger of two nullable id strings. */
function maxId(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

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

  // lastWindowId: furthest row id seen across all query results (p1 + full p2 window).
  // Used as fallback cursor when eligible=0 so dense windows don't stall the cursor.
  //
  // maxCandidateId: max id of the actual candidate set (before processing loop).
  // When candidates exist, this is the correct cursor — it equals the highest id
  // in the processed batch, so next run with afterId=maxCandidateId continues from
  // there and finds the remaining sparse rows in the same window.
  //
  // summary.lastId = maxCandidateId (when candidates exist) OR lastWindowId (fallback).
  let lastWindowId: string | null = null;

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
  // Order by id ASC + optional cursor so the window is deterministic and
  // does not overlap with previous runs.
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

  // Track window end for the dense-window fallback cursor.
  for (const r of p1) lastWindowId = maxId(lastWindowId, r.id);

  // ── Step 3: Priority-2 candidates — subjects exists but < 3 entries ──────
  // Fetch a bounded window ordered by id, then filter in memory for sparse rows.
  // The window end (last queried id) is captured regardless of how many sparse
  // rows are found — this prevents the cursor stalling if the window is all-dense.
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
      // User-scoped: filterIds already bounds the result set — no extra limit.
      q2 = (q2 as typeof q2).in('id', filterIds);
    } else {
      // Global: batchSize * 10 bounds the DB read to avoid full-table scans.
      // Rows at the end of the window advance the cursor even when not sparse.
      q2 = (q2 as typeof q2).limit(batchSize * 10);
    }

    const { data: p2Raw, error: p2Err } = await (q2 as typeof q2);
    if (p2Err) {
      throw new Error(`${LOG} priority-2 query failed — ${p2Err.message}`);
    }

    // Track the full window end for the dense-window fallback cursor.
    // This ensures that even when all rows in the window are dense (length >= 3),
    // the next run starts after this window rather than rescanning the same rows.
    const p2All = (p2Raw ?? []) as CandidateBook[];
    for (const r of p2All) lastWindowId = maxId(lastWindowId, r.id);

    // In-memory filter: only rows that genuinely have fewer than 3 subjects.
    p2 = p2All
      .filter(b => Array.isArray(b.subjects) && (b.subjects as string[]).length < 3)
      .slice(0, slots);
  }

  // ── Step 4: Merge — books with a valid OL external_id float to the top ────
  const seen = new Set<string>();
  const candidates: CandidateBook[] = [...p1, ...p2]
    .filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; })
    .sort((a, b) => (isOLId(a.external_id) ? 0 : 1) - (isOLId(b.external_id) ? 0 : 1))
    .slice(0, batchSize);

  summary.eligible = candidates.length;

  // maxCandidateId: the highest id among all candidates.
  // Since p2All is ordered by id ASC and we take .slice(0, slots), the candidates
  // set covers the lowest-id sparse rows in the window — not beyond them.
  // Setting the cursor to maxCandidateId guarantees the next run finds the
  // remaining sparse rows (ids > maxCandidateId) still within the window.
  let maxCandidateId: string | null = null;
  for (const c of candidates) maxCandidateId = maxId(maxCandidateId, c.id);

  const withExtId = candidates.filter(b => isOLId(b.external_id)).length;
  console.log(
    `${LOG} eligible=${candidates.length} ` +
    `(p1_null=${p1.length} p2_sparse=${p2.length} with_ext_id=${withExtId}) ` +
    `dryRun=${dryRun}`,
  );

  // ── Step 5: Enrich each candidate (per-book errors are fail-soft) ─────────
  for (const book of candidates) {
    const t = String(book.title  ?? '').trim();
    const a = String(book.author ?? '').trim();
    const currentSubjects: string[] = Array.isArray(book.subjects)
      ? (book.subjects as string[])
      : [];

    // Safety guard — never overwrite subjects already ≥ 3 entries.
    if (currentSubjects.length >= 3) {
      summary.skipped++;
      if (__DEV__) console.log(`${LOG} skip "${t}" — already has ${currentSubjects.length} subjects`);
      continue;
    }

    try {
      let resolvedExtId: string | null = isOLId(book.external_id) ? book.external_id : null;
      let extIdFound = false;

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

        summary.fieldsImproved++;
        if (extIdFound) summary.fieldsImproved++;
      } else {
        summary.fieldsImproved++;
        if (extIdFound) summary.fieldsImproved++;
      }

      summary.enriched++;

    } catch (err) {
      summary.failed++;
      console.log(`${LOG} error processing "${t}" — ${String(err)}`);
    }
  }

  const accounted = summary.enriched + summary.failed + summary.skipped;
  if (accounted < summary.eligible) {
    summary.skipped += summary.eligible - accounted;
  }

  // Cursor semantics:
  // - When candidates exist: use maxCandidateId (highest id in the processed batch).
  //   Since p2 takes the lowest-id sparse rows in the window, the next run with
  //   afterId=maxCandidateId finds the remaining sparse rows in the same window.
  // - When eligible=0 (all-dense window): fall back to lastWindowId so the next
  //   run advances past the dense window rather than stalling.
  summary.lastId = maxCandidateId ?? lastWindowId;

  console.log(
    `${LOG} done — ` +
    `eligible=${summary.eligible} ` +
    `enriched=${summary.enriched} ` +
    `failed=${summary.failed} ` +
    `skipped=${summary.skipped} ` +
    `fieldsImproved=${summary.fieldsImproved} ` +
    `lastId=${summary.lastId ?? 'none'}` +
    (dryRun ? ' [DRY RUN]' : ''),
  );

  return summary;
}
