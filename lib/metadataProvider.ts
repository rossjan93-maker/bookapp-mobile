// =============================================================================
// Metadata Provider — provider-agnostic book metadata abstraction
// =============================================================================
//
// Architecture:
//   ┌─────────────────────────────────────────────┐
//   │           Application code                  │
//   │   (library, add-book, recommendations)      │
//   └──────────────┬──────────────────────────────┘
//                  │ uses
//   ┌──────────────▼──────────────────────────────┐
//   │         BookMetadataProvider interface       │
//   │   search() · getById() · normalize()         │
//   └──────────────┬──────────────────────────────┘
//                  │ implements
//   ┌──────────────▼──────────────────────────────┐
//   │       GoogleBooksProvider (Phase 1)          │
//   │   future: OpenLibraryProvider, etc.          │
//   └─────────────────────────────────────────────┘
//
// The canonical data model is the `books` table.  Providers enrich it —
// they do not own it.  Raw payloads are persisted in `book_source_links`
// for audit, debug, and future re-processing.
//
// Fallback rules (enforced at this layer):
//   • No cover available            → CoverState { available: false }
//   • No description available      → null (callers must handle gracefully)
//   • Provider fetch fails          → null returned, caller uses local data
//   • Metadata confidence is low    → callers should not overwrite existing fields
//   • Any provider error            → fails silently, returns null / empty array
//
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

// ── Constants ──────────────────────────────────────────────────────────────────

const GB_API_KEY: string | null =
  typeof process !== 'undefined' &&
  typeof process.env?.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY === 'string' &&
  process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim().length > 0
    ? process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim()
    : null;

const MIN_CREDIBLE_PAGES = 30;
const MIN_DESCRIPTION_LENGTH = 30;

// ── Canonical normalized provider result ──────────────────────────────────────
// This is the shape the application always receives from any provider.
// Provider-specific quirks (field names, nested objects, missing fields) are
// resolved inside the adapter — callers never touch raw API payloads.

export type ProviderBookResult = {
  title:          string;
  author:         string;
  cover_url:      string | null;     // https:// URL, or null
  description:    string | null;     // ≥ 30 chars, or null
  page_count:     number | null;     // ≥ 30 pages, or null
  isbn_13:        string | null;
  isbn_10:        string | null;
  provider:       string;            // 'google_books' | 'open_library' | …
  provider_id:    string | null;     // provider's own volume/work ID
  raw_payload:    unknown;           // full API response item (for audit log)
  confidence:     'high' | 'medium' | 'low';  // isbn-matched > title-matched > unverified
};

// ── Cover state — explicit fallback signal ────────────────────────────────────
// UI components receive this instead of a raw nullable string.
// Allows the renderer to choose a placeholder without null-checks scattered
// throughout screen code.

export type CoverState =
  | { available: true;  url: string }
  | { available: false; reason: 'no_cover' | 'fetch_failed' | 'pending' };

export function toCoverState(
  url:         string | null | undefined,
  fetchFailed = false,
): CoverState {
  if (url) return { available: true, url };
  return { available: false, reason: fetchFailed ? 'fetch_failed' : 'no_cover' };
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface BookMetadataProvider {
  name: string;

  /** Search for books matching a free-text query. Returns [] on failure. */
  search(query: string): Promise<ProviderBookResult[]>;

  /** Fetch a single book by the provider's own ID. Returns null on failure. */
  getById(id: string): Promise<ProviderBookResult | null>;

  /** Normalize a raw API response item into a ProviderBookResult. Returns null when
   *  the item lacks enough data to be useful (no title, etc.). */
  normalize(rawItem: unknown): ProviderBookResult | null;
}

// =============================================================================
// Google Books Adapter
// =============================================================================

type GBVolumeInfo = {
  title?:               string;
  authors?:             string[];
  imageLinks?:          { thumbnail?: string; smallThumbnail?: string };
  description?:         string;
  pageCount?:           unknown;
  industryIdentifiers?: { type: string; identifier: string }[];
};

type GBItem = {
  id?:         string;
  volumeInfo?: GBVolumeInfo;
};

// ─── Internal rate-limit-aware fetch ─────────────────────────────────────────

type GBFetchResult =
  | { ok: true;  rateLimited: false; status: number; data: unknown }
  | { ok: false; rateLimited: true;  status: 429;    data: null   }
  | { ok: false; rateLimited: false; status: number; data: null   };

async function gbFetch(url: string, tag: string): Promise<GBFetchResult> {
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      console.log(`[METADATA] ${tag} rate-limited (429) — retrying after 1.5 s`);
      await new Promise(r => setTimeout(r, 1500));
      try {
        const retry = await fetch(url);
        if (retry.status === 429) {
          console.log(`[METADATA] ${tag} rate-limited on retry — aborting`);
          return { ok: false, rateLimited: true,  status: 429,         data: null };
        }
        if (!retry.ok) return { ok: false, rateLimited: false, status: retry.status, data: null };
        return { ok: true, rateLimited: false, status: retry.status, data: await retry.json() };
      } catch {
        return { ok: false, rateLimited: true, status: 429, data: null };
      }
    }
    if (!res.ok) {
      console.log(`[METADATA] ${tag} fetch failed — status ${res.status}`);
      return { ok: false, rateLimited: false, status: res.status, data: null };
    }
    return { ok: true, rateLimited: false, status: res.status, data: await res.json() };
  } catch (err) {
    console.log(`[METADATA] ${tag} fetch error — ${String(err)}`);
    return { ok: false, rateLimited: false, status: 0, data: null };
  }
}

// ─── Google Books Adapter implementation ─────────────────────────────────────

class GoogleBooksProviderImpl implements BookMetadataProvider {
  name = 'google_books';

  normalize(rawItem: unknown): ProviderBookResult | null {
    const item = rawItem as GBItem | null;
    if (!item) return null;

    const vi = item.volumeInfo;
    if (!vi?.title) return null;

    const author = (vi.authors ?? [])[0] ?? '';
    const isbns: { type: string; identifier: string }[] = vi.industryIdentifiers ?? [];
    const isbn_13 = isbns.find(x => x.type === 'ISBN_13')?.identifier ?? null;
    const isbn_10 = isbns.find(x => x.type === 'ISBN_10')?.identifier ?? null;

    const rawThumb = vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail ?? null;
    const cover_url = typeof rawThumb === 'string' && rawThumb.length > 0
      ? rawThumb.replace(/^http:\/\//, 'https://')
      : null;

    const rawDesc = vi.description;
    const description = typeof rawDesc === 'string' && rawDesc.length >= MIN_DESCRIPTION_LENGTH
      ? rawDesc
      : null;

    const rawPages = vi.pageCount;
    const page_count = typeof rawPages === 'number' && rawPages >= MIN_CREDIBLE_PAGES
      ? rawPages
      : null;

    const confidence: 'high' | 'medium' | 'low' =
      isbn_13 || isbn_10 ? 'high' : author ? 'medium' : 'low';

    if (!cover_url) {
      console.log(`[METADATA] google_books normalize — no cover for "${vi.title}"`);
    }
    if (!description) {
      console.log(`[METADATA] google_books normalize — no description for "${vi.title}"`);
    }

    return {
      title:       vi.title,
      author,
      cover_url,
      description,
      page_count,
      isbn_13,
      isbn_10,
      provider:    'google_books',
      provider_id: item.id ?? null,
      raw_payload: rawItem,
      confidence,
    };
  }

  async search(query: string): Promise<ProviderBookResult[]> {
    if (!query.trim()) return [];
    const keyParam = GB_API_KEY ? `&key=${GB_API_KEY}` : '';
    const fields = 'items(id,volumeInfo(title,authors,imageLinks(thumbnail,smallThumbnail),description,pageCount,industryIdentifiers))';
    const url =
      `https://www.googleapis.com/books/v1/volumes` +
      `?q=${encodeURIComponent(query)}&maxResults=10&printType=books&fields=${encodeURIComponent(fields)}${keyParam}`;

    const res = await gbFetch(url, `search("${query.slice(0, 30)}")`);
    if (!res.ok) return [];

    const data = res.data as { items?: unknown[] };
    if (!Array.isArray(data.items)) return [];

    const results = data.items
      .map(item => this.normalize(item))
      .filter((r): r is ProviderBookResult => r !== null);

    console.log(`[METADATA] google_books search("${query.slice(0, 30)}") → ${results.length} results`);
    return results;
  }

  async getById(id: string): Promise<ProviderBookResult | null> {
    if (!id.trim()) return null;
    const keyParam = GB_API_KEY ? `?key=${GB_API_KEY}` : '';
    const url = `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(id)}${keyParam}`;

    const res = await gbFetch(url, `getById("${id}")`);
    if (!res.ok) {
      console.log(`[METADATA] google_books getById("${id}") failed`);
      return null;
    }

    const result = this.normalize(res.data);
    if (result) {
      console.log(`[METADATA] google_books getById("${id}") → "${result.title}" confidence=${result.confidence}`);
    }
    return result;
  }
}

// ── Singleton instance ────────────────────────────────────────────────────────

const _googleBooksProvider = new GoogleBooksProviderImpl();

// ── Provider registry / factory ───────────────────────────────────────────────

const _registry: Record<string, BookMetadataProvider> = {
  google_books: _googleBooksProvider,
};

export function getProvider(name: string): BookMetadataProvider | null {
  return _registry[name] ?? null;
}

// Typed overload for known provider names (Phase 1 only has google_books)
export function googleBooksProvider(): BookMetadataProvider {
  return _googleBooksProvider;
}

// =============================================================================
// Provider-link persistence
// =============================================================================
// Records (or updates) a row in `book_source_links` for observability.
// Fails silently — a write failure here must never break the calling flow.

export async function recordProviderLink(
  client:    SupabaseClient,
  bookId:    string,
  provider:  string,
  volumeId:  string,
  payload:   unknown,
  status:    'success' | 'failed' | 'rate_limited',
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { error } = await client
      .from('book_source_links')
      .upsert(
        {
          book_id:         bookId,
          source:          provider,
          source_book_id:  volumeId,
          raw_payload:     payload,
          last_fetched_at: status === 'success' ? now : undefined,
          fetch_status:    status,
        },
        { onConflict: 'source,source_book_id', ignoreDuplicates: false },
      );

    if (error) {
      console.log(`[METADATA] recordProviderLink error — provider=${provider} volumeId=${volumeId} — ${error.message}`);
    } else {
      console.log(`[METADATA] recordProviderLink — provider=${provider} bookId=${bookId} status=${status}`);
    }
  } catch (err) {
    console.log(`[METADATA] recordProviderLink exception — ${String(err)}`);
  }
}

// =============================================================================
// Best-cover selection
// =============================================================================
// Given multiple candidate cover URLs (from different providers or strategies),
// returns the highest-quality available URL.
//
// Current ranking:
//   1. ISBN-sourced Google Books URL  (most reliable)
//   2. Title+author Google Books URL  (good reliability)
//   3. Open Library cover URL         (variable reliability)
//   4. null → callers must render fallback
//
// The cover_source field in the books table records which provider won.

export type CoverCandidate = {
  url:        string | null;
  source:     string;       // 'google_books_isbn' | 'google_books_search' | 'open_library'
  confidence: 'high' | 'medium' | 'low';
};

export function selectBestCover(candidates: CoverCandidate[]): CoverCandidate | null {
  const rank: Record<string, number> = {
    google_books_isbn:   3,
    google_books_search: 2,
    open_library:        1,
  };

  const valid = candidates
    .filter(c => !!c.url)
    .sort((a, b) => (rank[b.source] ?? 0) - (rank[a.source] ?? 0));

  return valid[0] ?? null;
}

// =============================================================================
// Metadata confidence helper
// =============================================================================
// Given a book with ISBNs, derives the appropriate confidence tier.
// Used when writing metadata_confidence to the books table.

export function deriveMetadataConfidence(opts: {
  isbn_13?: string | null;
  isbn_10?: string | null;
  has_title: boolean;
  has_author: boolean;
}): 'high' | 'medium' | 'low' {
  if (opts.isbn_13 || opts.isbn_10) return 'high';
  if (opts.has_title && opts.has_author) return 'medium';
  return 'low';
}
