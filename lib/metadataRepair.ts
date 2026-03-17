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
// Persists every found field to the books table — only for columns that exist.
// Caps at `cap` books per call (default 50) to stay bounded.
// Fails quietly per book; a single network failure never aborts the batch.
//
// Column-resilience:
//   `subjects` was added in migration 20260315000002 and `description` in
//   20260315000004.  Both may be absent from the database.  The query degrades
//   gracefully: full → without description → without description+subjects.
//   Patch writes are omitted for columns that are not present.
// =============================================================================

import { supabase }                from './supabase';
import { fetchOLMeta, searchOLWork, isOLId } from './openLibrary';
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

  const ids = bookIds.slice(0, 500);

  // ── Column-resilient candidate fetch ────────────────────────────────────────
  // Try the fullest query first.  If PostgREST rejects it (column absent),
  // retry with progressively fewer optional columns.
  // Track which optional columns actually exist so we can guard patch writes.
  let candidates: Record<string, unknown>[] = [];
  let descColExists = true;
  let subjColExists = true;

  // Attempt 1: full (description + subjects)
  const { data: c1, error: e1 } = await supabase
    .from('books')
    .select('id, isbn13, isbn, title, author, external_id, cover_url, description, subjects, page_count')
    .in('id', ids)
    .or('cover_url.is.null,description.is.null,subjects.is.null,page_count.is.null');

  if (!e1) {
    candidates = (c1 ?? []) as Record<string, unknown>[];
  } else {
    descColExists = false;

    // Attempt 2: without description
    const { data: c2, error: e2 } = await supabase
      .from('books')
      .select('id, isbn13, isbn, title, author, external_id, cover_url, subjects, page_count')
      .in('id', ids)
      .or('cover_url.is.null,subjects.is.null,page_count.is.null');

    if (!e2) {
      candidates = (c2 ?? []) as Record<string, unknown>[];
    } else {
      subjColExists = false;

      // Attempt 3: only guaranteed MVP columns
      const { data: c3 } = await supabase
        .from('books')
        .select('id, isbn13, isbn, title, author, external_id, cover_url, page_count')
        .in('id', ids)
        .or('cover_url.is.null,page_count.is.null');

      candidates = (c3 ?? []) as Record<string, unknown>[];
    }
  }

  const eligible = candidates.slice(0, cap);

  let covered = 0, described = 0, subjected = 0, paged = 0, total = 0;

  for (const book of eligible) {
    try {
      const patch: Record<string, unknown> = {};

      const hasCover    = !!book.cover_url;
      const hasDesc     = descColExists ? !!book.description : false;
      const hasSubjects = subjColExists
        ? Array.isArray(book.subjects) && (book.subjects as string[]).length > 0
        : false;
      const hasPages    = !!book.page_count;

      let foundDesc:     string | null = null;
      let foundSubjects: string[]      = [];
      let foundPages:    number | null = null;

      // ── Phase 1: Open Library ────────────────────────────────────────────
      const rawExtId = (book.external_id as string | null) ?? null;
      // Normalize: only treat the value as an OL id when it starts with /works/OL.
      // Goodreads-prefixed values ("goodreads:{id}") from the old import path must
      // not gate the OL lookup — they must fall through to searchOLWork instead.
      let resolvedExtId: string | null = isOLId(rawExtId) ? rawExtId : null;

      // When no valid OL external_id exists, search OL by title+author to discover
      // the works key, then persist it so future calls skip this search entirely.
      if (!resolvedExtId && (!hasDesc || !hasSubjects)) {
        const t = String(book.title  ?? '').trim();
        const a = String(book.author ?? '').trim();
        if (t) {
          const found = await searchOLWork(t, a);
          if (found) {
            resolvedExtId      = found;
            patch.external_id  = found;
          }
        }
      }

      if (resolvedExtId && (!hasDesc || !hasSubjects || !hasPages)) {
        const ol = await fetchOLMeta(resolvedExtId);
        if (!hasDesc     && ol.description)        foundDesc     = ol.description;
        if (!hasSubjects && ol.subjects.length > 0) foundSubjects = ol.subjects;
        if (!hasPages    && ol.pageCount)           foundPages    = ol.pageCount;
      }

      // ── Phase 2: Google Books ─────────────────────────────────────────────
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
          if (!hasCover                       && gb.cover_url)   { patch.cover_url = gb.cover_url; covered++; }
          if (!hasDesc  && !foundDesc         && gb.description) { foundDesc        = gb.description; }
          if (!hasPages && !foundPages        && gb.page_count)  { foundPages       = gb.page_count; }
        }
      }

      // ── Collect OL-sourced fields — only write columns that exist ─────────
      if (foundDesc    && !hasDesc     && descColExists) { patch.description = foundDesc;    described++; }
      if (foundSubjects.length         && subjColExists) { patch.subjects    = foundSubjects; subjected++; }
      if (foundPages   && !hasPages)                     { patch.page_count  = foundPages;   paged++; }

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
