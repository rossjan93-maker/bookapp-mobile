// =============================================================================
// Metadata Repair — shared post-import / self-healing helper
// =============================================================================
// repairBooksMetadata — for a set of book IDs, fetch any that are still missing
// cover_url / description / page_count and attempt to fill them via Google Books.
//
// Used by:
//   - Goodreads import executor (all affected book IDs after each import pass)
//   - Book Detail self-healing effect (single book, on open)
//
// Design:
//   - Queries the DB to find which books in the provided set actually need work
//   - Uses fetchGoogleBooksMetadata (isbn13 → isbn → title+author priority)
//   - Persists any found fields back to the books table
//   - Caps at `cap` books per call (default 50) to keep it bounded
//   - Fails quietly per book; a single fetch failure never aborts the batch
// =============================================================================

import { supabase } from './supabase';
import { fetchGoogleBooksMetadata } from './googleBooks';

export type RepairResult = {
  covered:   number;
  described: number;
  paged:     number;
  total:     number;
};

const DEFAULT_CAP = 50;

export async function repairBooksMetadata(
  bookIds: string[],
  { cap = DEFAULT_CAP }: { cap?: number } = {},
): Promise<RepairResult> {
  if (!supabase || bookIds.length === 0) {
    return { covered: 0, described: 0, paged: 0, total: 0 };
  }

  // Fetch only books that still have at least one missing field.
  // Slice the input to avoid huge IN() clauses; the cap further limits network calls.
  const { data: candidates } = await supabase
    .from('books')
    .select('id, isbn13, isbn, title, author, cover_url, description, page_count')
    .in('id', bookIds.slice(0, 500))
    .or('cover_url.is.null,description.is.null,page_count.is.null');

  const eligible = (candidates ?? []).slice(0, cap);

  let covered = 0, described = 0, paged = 0, total = 0;

  for (const book of eligible) {
    try {
      const gb = await fetchGoogleBooksMetadata({
        isbn13: (book.isbn13 as string | null) ?? null,
        isbn:   (book.isbn   as string | null) ?? null,
        title:  String(book.title  ?? '').trim(),
        author: String(book.author ?? '').trim(),
      });

      const patch: Record<string, unknown> = {};
      if (!book.cover_url   && gb.cover_url)   { patch.cover_url   = gb.cover_url;   covered++; }
      if (!book.description && gb.description) { patch.description = gb.description; described++; }
      if (!book.page_count  && gb.page_count)  { patch.page_count  = gb.page_count;  paged++; }

      if (Object.keys(patch).length > 0) {
        await supabase.from('books').update(patch).eq('id', book.id);
        total++;
      }
    } catch {
      // fail quietly — a single book failure never aborts the batch
    }
  }

  return { covered, described, paged, total };
}
