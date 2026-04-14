// =============================================================================
// Subject Repair — targeted enrichment for books with null or sparse subjects
// =============================================================================
// repairSubjectCoverage — queries the books table for rows where subjects is
// null (priority 1) or has fewer than 3 entries (priority 2), then attempts to
// fill them via Open Library.  Books with an existing external_id are processed
// first (no OL search needed).  Subjects are only written when the OL result is
// strictly better (more subjects) than what is already stored.
//
// Safe for repeated runs: the query filters exclude already-complete rows.
// Each run is bounded by batchSize (default 50).
//
// Used by:
//   - scripts/repairSubjectCoverage.ts  (CLI, passes its own Node.js client)
//   - app/settings.tsx                  (__DEV__ developer trigger with alert)
// =============================================================================

import { supabase as appSupabase }          from './supabase';
import { fetchOLMeta, searchOLWork, isOLId } from './openLibrary';
import type { SupabaseClient }              from '@supabase/supabase-js';

export type RepairSummary = {
  eligible:       number;
  enriched:       number;
  failed:         number;
  skipped:        number;
  fieldsImproved: number;
};

export type SubjectRepairOptions = {
  userId?:    string;
  batchSize?: number;
  dryRun?:    boolean;
  /** Injectable client — used by the CLI script to avoid React Native imports. */
  client?:    SupabaseClient | null;
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
  opts: SubjectRepairOptions = {},
): Promise<RepairSummary> {
  const { userId, batchSize = 50, dryRun = false } = opts;

  // Caller may inject a plain Node.js client; fall back to the app singleton.
  const db: SupabaseClient | null = opts.client ?? appSupabase;

  const summary: RepairSummary = {
    eligible: 0, enriched: 0, failed: 0, skipped: 0, fieldsImproved: 0,
  };

  if (!db) {
    console.log(`${LOG} supabase not available — aborting`);
    return summary;
  }

  // ── Step 1: resolve book IDs for this user when userId is supplied ────────
  let filterIds: string[] | null = null;
  if (userId) {
    const { data, error } = await db
      .from('user_books')
      .select('book_id')
      .eq('user_id', userId);

    if (error) {
      console.log(`${LOG} user_books query failed — ${error.message}`);
      return summary;
    }

    filterIds = (data ?? []).map((r: { book_id: string }) => r.book_id);

    if (filterIds.length === 0) {
      console.log(`${LOG} user has no books — nothing to repair`);
      return summary;
    }

    console.log(`${LOG} user ${userId.slice(0, 8)}… has ${filterIds.length} book(s) in library`);
  }

  // ── Step 2: Priority-1 candidates — subjects IS NULL ─────────────────────
  let q1 = db
    .from('books')
    .select('id, title, author, external_id, subjects')
    .is('subjects', null);

  if (filterIds) q1 = (q1 as typeof q1).in('id', filterIds);

  const { data: p1Data, error: p1Err } = await (q1 as typeof q1).limit(batchSize);
  if (p1Err) {
    console.log(`${LOG} priority-1 query failed — ${p1Err.message}`);
    return summary;
  }
  const p1: CandidateBook[] = (p1Data ?? []) as CandidateBook[];

  // ── Step 3: Priority-2 candidates — subjects exists but < 3 entries ──────
  let p2: CandidateBook[] = [];
  const slots = batchSize - p1.length;

  if (slots > 0) {
    let q2 = db
      .from('books')
      .select('id, title, author, external_id, subjects')
      .not('subjects', 'is', null);

    if (filterIds) q2 = (q2 as typeof q2).in('id', filterIds);

    const { data: p2Raw } = await (q2 as typeof q2).limit(slots * 4);

    p2 = ((p2Raw ?? []) as CandidateBook[])
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

  const withExtId = candidates.filter(b => isOLId(b.external_id)).length;
  console.log(
    `${LOG} eligible=${candidates.length} ` +
    `(p1_null=${p1.length} p2_sparse=${p2.length} with_ext_id=${withExtId}) ` +
    `dryRun=${dryRun}`,
  );

  // ── Step 5: Enrich each candidate ─────────────────────────────────────────
  for (const book of candidates) {
    const t = String(book.title  ?? '').trim();
    const a = String(book.author ?? '').trim();
    const currentSubjects: string[] = Array.isArray(book.subjects)
      ? (book.subjects as string[])
      : [];

    // Safety guard — never overwrite subjects already ≥ 3 entries.
    // This should not normally fire (query already excludes these) but acts as
    // a belt-and-suspenders check in case of race conditions or stale data.
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
      // This prevents a 1-subject OL result from displacing an existing 2-entry
      // subjects array that was already partially enriched.
      if (ol.subjects.length <= currentSubjects.length && currentSubjects.length > 0) {
        summary.skipped++;
        console.log(
          `${LOG} skip "${t}" — OL ${ol.subjects.length} subjects not an improvement over existing ${currentSubjects.length}`,
        );
        continue;
      }

      const preview = ol.subjects.slice(0, 3).join(', ');
      console.log(
        `${LOG} enriched "${t}" [${currentSubjects.length} → ${ol.subjects.length}] (${preview}${ol.subjects.length > 3 ? '…' : ''})`,
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

  // Any candidate not enriched and not failed ended up skipped (safety guard
  // or no-improvement guard fired beyond what was explicitly incremented)
  const accounted = summary.enriched + summary.failed + summary.skipped;
  if (accounted < summary.eligible) {
    summary.skipped += summary.eligible - accounted;
  }

  console.log(
    `${LOG} done — ` +
    `eligible=${summary.eligible} ` +
    `enriched=${summary.enriched} ` +
    `failed=${summary.failed} ` +
    `skipped=${summary.skipped} ` +
    `fieldsImproved=${summary.fieldsImproved}` +
    (dryRun ? ' [DRY RUN]' : ''),
  );

  return summary;
}
