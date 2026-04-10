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
import { shouldUpgradeCover } from './coverUpgrade';
import {
  recordProviderOutcome,
  recordMissingField,
  logProviderHealthSummary,
} from './providerHealth';

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
  // cover_source.is.null is included so books with all content fields present but
  // missing provenance (e.g. imported before the column existed) still get repaired.
  const { data: c1, error: e1 } = await supabase
    .from('books')
    .select('id, isbn13, isbn, title, author, external_id, cover_url, cover_source, metadata_confidence, description, subjects, page_count')
    .in('id', ids)
    .or('cover_url.is.null,description.is.null,subjects.is.null,page_count.is.null,cover_source.is.null');

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

      // Extract the Google Books volume ID embedded in a google books cover URL.
      // e.g. "https://books.google.com/books/content?id=FMAvBgAAQBAJ&..." → "FMAvBgAAQBAJ"
      // Returns null if the URL is not a GB URL or has no id param.
      function extractGbVolumeIdFromUrl(url: string): string | null {
        if (!url.includes('books.google.com') && !url.includes('googleapis.com/books')) return null;
        const match = url.match(/[?&]id=([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
      }

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
      // We also trigger GB when provenance is missing (cover_source=null) and the
      // existing cover URL is NOT a GB URL (so we can't extract the volume ID from it).
      // If the cover IS a GB URL we extract the volume ID without an API call (below).
      const existingCoverUrl      = String(book.cover_url ?? '');
      const existingCoverGbId     = extractGbVolumeIdFromUrl(existingCoverUrl);
      const needGbForProvenance   =
        coverSrcExists && !book.cover_source && hasCover && !existingCoverGbId;

      const needGb =
        !hasCover ||
        (!hasDesc  && !foundDesc) ||
        (!hasPages && !foundPages) ||
        needGbForProvenance;

      if (needGb && t) {
        const gb = await fetchGoogleBooksMetadata({
          isbn13: (book.isbn13 as string | null) ?? null,
          isbn:   (book.isbn   as string | null) ?? null,
          title:  t,
          author: a,
        });

        if (gb.cover_url || gb.description || gb.page_count) {
          gbFetchStatus = 'success';
          recordProviderOutcome('google_books', 'success');
          if (gb.volume_id) gbVolumeId = gb.volume_id;
          if (gb.cover_url)  gbCoverUrl = gb.cover_url;
          if (!hasDesc  && !foundDesc  && gb.description) foundDesc  = gb.description;
          if (!hasPages && !foundPages && gb.page_count)  foundPages = gb.page_count;
        } else {
          recordProviderOutcome('google_books', 'failed');
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
      } else if (coverSrcExists && !book.cover_source) {
        // Book already has a cover but cover_source was never recorded.
        // This happens when the cover was written before the cover_source column
        // existed (pre-migration) or via an import path that bypassed provenance.
        //
        // Three sub-cases, in priority order:
        //
        // A) Existing cover URL is a Google Books URL.
        //    → Extract the volume ID directly from the URL (no API call needed).
        //    → Set cover_source='google_books' + write a success provenance row.
        //
        // B) Existing cover URL is an Open Library URL.
        //    → Set cover_source='open_library'.
        //    → No book_source_links row needed (OL provenance is tracked via external_id).
        //
        // C) Cover is from another source (e.g. Goodreads CDN) AND GB matched this
        //    session (needGbForProvenance=true → gbVolumeId is now populated).
        //    → Set cover_source='google_books' as the confirmed metadata provider.
        //    → recordProviderLink already called in Phase 2 above with the volume ID.

        if (existingCoverGbId) {
          // Case A: GB cover URL — extract volume ID, write provenance atomically.
          patch.cover_source = 'google_books';
          console.log(`[REPAIR] cover_source='google_books' from existing GB URL for "${t}" (volume_id=${existingCoverGbId})`);
          if (book.id) {
            recordProviderLink(
              supabase,
              bookId,
              'google_books',
              existingCoverGbId,
              { title: t, author: a, source: 'url_extraction', cover_url: existingCoverUrl },
              'success',
            ).catch(() => {});
          }
        } else if (existingCoverUrl.includes('covers.openlibrary.org')) {
          // Case B: Open Library cover URL.
          patch.cover_source = 'open_library';
          console.log(`[REPAIR] cover_source='open_library' from existing OL URL for "${t}"`);
        } else if (gbVolumeId) {
          // Case C: Non-GB cover + GB confirmed match this session.
          // recordProviderLink was already called in Phase 2 with the real volume ID.
          patch.cover_source = 'google_books';
          console.log(`[REPAIR] cover_source='google_books' from GB match (cover URL preserved) for "${t}" (volume_id=${gbVolumeId})`);
        }
      } else if (coverSrcExists && book.cover_source && gbCoverUrl) {
        // ── Cover upgrade evaluation ─────────────────────────────────────────
        // The book already has a cover AND we fetched a new GB cover this session.
        // Apply the conservative upgrade policy from lib/coverUpgrade.ts.
        // Only ISBN-matched GB covers can trigger an upgrade; title-only matches
        // are never sufficient to replace an existing cover.
        const hasIsbn   = !!(book.isbn13 || book.isbn);
        const candidate = {
          url:        gbCoverUrl,
          source:     'google_books' as const,
          confidence: (hasIsbn ? 'high' : 'medium') as 'high' | 'medium' | 'low',
        };
        const decision = shouldUpgradeCover(
          book.cover_source as string,
          (book as { metadata_confidence?: string | null }).metadata_confidence ?? null,
          candidate,
        );
        if (decision.upgrade) {
          patch.cover_url    = gbCoverUrl;
          patch.cover_source = 'google_books';
          covered++;
          console.log(`[REPAIR] cover UPGRADED for "${t}" — ${decision.reason}`);
        } else {
          if (__DEV__) {
            console.log(`[REPAIR] cover upgrade skipped for "${t}" — ${decision.reason}`);
          }
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

      // ── Missing-field telemetry (recorded once per book) ───────────────────
      // Only count books that genuinely have no cover/desc/pages after repair.
      const stillNoCover = !hasCover && !patch.cover_url;
      const stillNoDesc  = !hasDesc  && !foundDesc;
      const stillNoPages = !hasPages && !foundPages;
      if (stillNoCover) recordMissingField('cover');
      if (stillNoDesc)  recordMissingField('description');
      if (stillNoPages) recordMissingField('page_count');

    } catch (err) {
      console.log(`[REPAIR] error processing book ${book.id} — ${String(err)}`);
    }
  }

  console.log(`[REPAIR] done — covered=${covered} described=${described} subjected=${subjected} paged=${paged} total=${total}`);
  logProviderHealthSummary();
  return { covered, described, subjected, paged, total };
}
