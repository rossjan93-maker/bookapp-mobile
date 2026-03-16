// =============================================================================
// Metadata Repair — shared post-import / self-healing helper
// =============================================================================
// repairBooksMetadata — for a set of book IDs, find any that are still missing
// cover_url / description / subjects / page_count and attempt to fill them.
//
// Used by:
//   - Goodreads import executor  (all affected book IDs after each import pass)
//   - Library load               (visible books with any missing field)
//   - Book Detail self-healing   (single-book on open, via the enrich() effect)
//
// Two-phase lookup per book:
//   Phase 1 — Open Library  (requires external_id / OL works identifier)
//             Best source for description, subjects, page_count.
//   Phase 2 — Google Books  (isbn13 → isbn → title+author)
//             Best source for cover_url; fallback for description + page_count.
//
// Fields never overwritten if already present.
// Persists every found field to the books table.
// Caps at `cap` books per call (default 50) to stay bounded.
// Fails quietly per book; a single network failure never aborts the batch.
// =============================================================================

import { supabase }                from './supabase';
import { fetchOLMeta }             from './openLibrary';
import { fetchGoogleBooksMetadata } from './googleBooks';

export type RepairResult = {
  covered:   number;
  described: number;
  subjected: number;
  paged:     number;
  total:     number;
};

const DEFAULT_CAP = 50;

export async function repairBooksMetadata(
  bookIds: string[],
  { cap = DEFAULT_CAP }: { cap?: number } = {},
): Promise<RepairResult> {
  if (!supabase || bookIds.length === 0) {
    return { covered: 0, described: 0, subjected: 0, paged: 0, total: 0 };
  }

  // Fetch only books that still have at least one missing field.
  // Subjects is now included in the completeness model.
  // Slice to 500 to keep the IN() clause reasonable; cap limits API calls.
  const { data: candidates } = await supabase
    .from('books')
    .select('id, isbn13, isbn, title, author, external_id, cover_url, description, subjects, page_count')
    .in('id', bookIds.slice(0, 500))
    .or('cover_url.is.null,description.is.null,subjects.is.null,page_count.is.null');

  const eligible = (candidates ?? []).slice(0, cap);

  let covered = 0, described = 0, subjected = 0, paged = 0, total = 0;

  for (const book of eligible) {
    try {
      const patch: Record<string, unknown> = {};

      const hasCover    = !!book.cover_url;
      const hasDesc     = !!book.description;
      const hasSubjects = Array.isArray(book.subjects) && (book.subjects as string[]).length > 0;
      const hasPages    = !!book.page_count;

      let foundDesc:     string | null = null;
      let foundSubjects: string[]      = [];
      let foundPages:    number | null = null;

      // ── Phase 1: Open Library ────────────────────────────────────────────
      // Only run when the book has an OL external_id AND is still missing
      // at least one of the fields OL is good for.
      const extId = (book.external_id as string | null) ?? null;
      if (extId && (!hasDesc || !hasSubjects || !hasPages)) {
        const ol = await fetchOLMeta(extId);
        if (!hasDesc     && ol.description)        foundDesc     = ol.description;
        if (!hasSubjects && ol.subjects.length > 0) foundSubjects = ol.subjects;
        if (!hasPages    && ol.pageCount)           foundPages    = ol.pageCount;
      }

      // ── Phase 2: Google Books ─────────────────────────────────────────────
      // Run when cover is missing, or when OL didn't fill description / pages.
      const needGb =
        !hasCover ||
        (!hasDesc  && !foundDesc) ||
        (!hasPages && !foundPages);

      if (needGb) {
        const t = String(book.title  ?? '').trim();
        const a = String(book.author ?? '').trim();
        if (t) {
          const gb = await fetchGoogleBooksMetadata({
            isbn13: (book.isbn13 as string | null) ?? null,
            isbn:   (book.isbn   as string | null) ?? null,
            title:  t,
            author: a,
          });
          if (!hasCover                       && gb.cover_url)   { patch.cover_url   = gb.cover_url;   covered++; }
          if (!hasDesc  && !foundDesc         && gb.description) { foundDesc         = gb.description; }
          if (!hasPages && !foundPages        && gb.page_count)  { foundPages        = gb.page_count; }
        }
      }

      // ── Collect OL-sourced fields ─────────────────────────────────────────
      if (foundDesc)            { patch.description = foundDesc;   described++; }
      if (foundSubjects.length) { patch.subjects    = foundSubjects; subjected++; }
      if (foundPages)           { patch.page_count  = foundPages;  paged++; }

      if (Object.keys(patch).length > 0) {
        await supabase.from('books').update(patch).eq('id', book.id);
        total++;
      }
    } catch {
      // fail quietly — a single book error never aborts the batch
    }
  }

  return { covered, described, subjected, paged, total };
}
