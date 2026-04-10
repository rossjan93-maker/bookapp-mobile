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
//   20260315000004. `cover_source` and `metadata_confidence` were added in
//   20260409000000.  All are written only when present; missing columns are
//   skipped gracefully.
//
// Provider integration:
//   When Google Books supplies a cover, cover_source='google_books' is written.
//   When Open Library is the only cover source, cover_source='open_library'.
//   metadata_confidence reflects ISBN availability (high > medium > low).
//   Provider links are recorded to book_source_links for audit / debug.
// =============================================================================

import { supabase }                from './supabase';
import { fetchOLMeta, searchOLWork, isOLId } from './openLibrary';
import { fetchGoogleBooksMetadata } from './googleBooks';
import {
  recordProviderLink,
  selectBestCover,
  deriveMetadataConfidence,
  type CoverCandidate,
} from './metadataProvider';

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
  let descColExists   = true;
  let subjColExists   = true;
  let coverSrcExists  = true;
  let confColExists   = true;

  // Attempt 1: full (all optional columns)
  const { data: c1, error: e1 } = await supabase
    .from('books')
    .select('id, isbn13, isbn, title, author, external_id, cover_url, cover_source, metadata_confidence, description, subjects, page_count')
    .in('id', ids)
    .or('cover_url.is.null,description.is.null,subjects.is.null,page_count.is.null');

  if (!e1) {
    candidates = (c1 ?? []) as Record<string, unknown>[];
  } else {
    // cover_source / metadata_confidence may not exist yet — try without them
    coverSrcExists = false;
    confColExists  = false;

    const { data: c2, error: e2 } = await supabase
      .from('books')
      .select('id, isbn13, isbn, title, author, external_id, cover_url, description, subjects, page_count')
      .in('id', ids)
      .or('cover_url.is.null,description.is.null,subjects.is.null,page_count.is.null');

    if (!e2) {
      candidates = (c2 ?? []) as Record<string, unknown>[];
    } else {
      descColExists = false;

      const { data: c3, error: e3 } = await supabase
        .from('books')
        .select('id, isbn13, isbn, title, author, external_id, cover_url, subjects, page_count')
        .in('id', ids)
        .or('cover_url.is.null,subjects.is.null,page_count.is.null');

      if (!e3) {
        candidates = (c3 ?? []) as Record<string, unknown>[];
      } else {
        subjColExists = false;

        const { data: c4 } = await supabase
          .from('books')
          .select('id, isbn13, isbn, title, author, external_id, cover_url, page_count')
          .in('id', ids)
          .or('cover_url.is.null,page_count.is.null');

        candidates = (c4 ?? []) as Record<string, unknown>[];
      }
    }
  }

  const eligible = candidates.slice(0, cap);

  console.log(`[REPAIR] repairBooksMetadata — ${eligible.length} books eligible (of ${bookIds.length} requested)`);

  let covered = 0, described = 0, subjected = 0, paged = 0, total = 0;

  for (const book of eligible) {
    try {
      const patch: Record<string, unknown> = {};
      const bookId = book.id as string;
      const t = String(book.title  ?? '').trim();
      const a = String(book.author ?? '').trim();

      const hasCover    = !!book.cover_url;
      const hasDesc     = descColExists ? !!book.description : false;
      const hasSubjects = subjColExists
        ? Array.isArray(book.subjects) && (book.subjects as string[]).length > 0
        : false;
      const hasPages    = !!book.page_count;

      let foundDesc:     string | null = null;
      let foundSubjects: string[]      = [];
      let foundPages:    number | null = null;
      let gbVolumeId:    string | null = null;
      let gbRawPayload:  unknown       = null;
      let gbCoverUrl:    string | null = null;
      let gbFetchStatus: 'success' | 'failed' | 'rate_limited' = 'failed';

      // ── Phase 1: Open Library ────────────────────────────────────────────
      const rawExtId = (book.external_id as string | null) ?? null;
      let resolvedExtId: string | null = isOLId(rawExtId) ? rawExtId : null;

      if (!resolvedExtId && (!hasDesc || !hasSubjects)) {
        if (t) {
          const found = await searchOLWork(t, a);
          if (found) {
            resolvedExtId     = found;
            patch.external_id = found;
            console.log(`[REPAIR] OL work found for "${t}" → ${found}`);
          }
        }
      }

      if (resolvedExtId && (!hasDesc || !hasSubjects || !hasPages)) {
        const ol = await fetchOLMeta(resolvedExtId);
        if (!hasDesc     && ol.description)         foundDesc     = ol.description;
        if (!hasSubjects && ol.subjects.length > 0) foundSubjects = ol.subjects;
        if (!hasPages    && ol.pageCount)            foundPages    = ol.pageCount;
      }

      // ── Phase 2: Google Books ─────────────────────────────────────────────
      const needGb =
        !hasCover ||
        (!hasDesc  && !foundDesc) ||
        (!hasPages && !foundPages);

      if (needGb && t) {
        const gb = await fetchGoogleBooksMetadata({
          isbn13: (book.isbn13 as string | null) ?? null,
          isbn:   (book.isbn   as string | null) ?? null,
          title:  t,
          author: a,
        });

        if (gb.cover_url || gb.description || gb.page_count) {
          gbFetchStatus = 'success';
          if (gb.volume_id) gbVolumeId = gb.volume_id;
          if (gb.cover_url)  gbCoverUrl = gb.cover_url;
          if (!hasDesc  && !foundDesc  && gb.description) foundDesc  = gb.description;
          if (!hasPages && !foundPages && gb.page_count)  foundPages = gb.page_count;
        } else {
          console.log(`[REPAIR] google_books returned no useful fields for "${t}"`);
        }

        // Record provider link regardless of result (logs fetch attempts).
        // source_book_id MUST be a real GB volume ID (from gb.volume_id) when
        // available.  For failed fetches where no volume was matched, fall back
        // to the book's ISBN (stable per book), then a bookid: sentinel.
        // A title fragment is never an acceptable identifier.
        if (book.id) {
          const sourceBookId =
            gbVolumeId ??
            (book.isbn13 as string | null) ??
            (book.isbn   as string | null) ??
            `bookid:${bookId}`;

          if (!gbVolumeId) {
            console.log(`[REPAIR] no GB volume ID for "${t}" — logging attempt with sourceBookId=${sourceBookId}`);
          }

          recordProviderLink(
            supabase,
            bookId,
            'google_books',
            sourceBookId,
            { title: t, author: a, result: gb },
            gbFetchStatus,
          ).catch(() => {});
        }
      }

      // ── Cover selection — pick best available source ───────────────────────
      if (!hasCover) {
        const candidates: CoverCandidate[] = [];
        if (gbCoverUrl) {
          const hasIsbn = !!(book.isbn13 || book.isbn);
          candidates.push({
            url:        gbCoverUrl,
            source:     hasIsbn ? 'google_books_isbn' : 'google_books_search',
            confidence: hasIsbn ? 'high' : 'medium',
          });
        }

        const best = selectBestCover(candidates);
        if (best?.url) {
          patch.cover_url = best.url;
          if (coverSrcExists) patch.cover_source = best.source.startsWith('google_books') ? 'google_books' : best.source;
          covered++;
          console.log(`[REPAIR] cover set for "${t}" — source=${best.source}`);
        } else {
          console.log(`[REPAIR] no cover available for "${t}"`);
        }
      }

      // ── Collect OL-sourced fields — only write columns that exist ──────────
      if (foundDesc    && !hasDesc     && descColExists) { patch.description = foundDesc;    described++; }
      if (foundSubjects.length         && subjColExists) { patch.subjects    = foundSubjects; subjected++; }
      if (foundPages   && !hasPages)                     { patch.page_count  = foundPages;   paged++; }

      // ── metadata_confidence ───────────────────────────────────────────────
      if (confColExists && !book.metadata_confidence) {
        patch.metadata_confidence = deriveMetadataConfidence({
          isbn_13:    (book.isbn13  as string | null) ?? null,
          isbn_10:    (book.isbn    as string | null) ?? null,
          has_title:  !!t,
          has_author: !!a,
        });
      }

      if (Object.keys(patch).length > 0) {
        await supabase.from('books').update(patch).eq('id', book.id);
        total++;
        console.log(`[REPAIR] patched "${t}" — fields: ${Object.keys(patch).join(', ')}`);
      }
    } catch (err) {
      console.log(`[REPAIR] error processing book ${book.id} — ${String(err)}`);
    }
  }

  console.log(`[REPAIR] done — covered=${covered} described=${described} subjected=${subjected} paged=${paged} total=${total}`);
  return { covered, described, subjected, paged, total };
}
