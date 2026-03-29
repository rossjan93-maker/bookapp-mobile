// =============================================================================
// Google Books — lightweight metadata enrichment helpers
// =============================================================================
// fetchGoogleBooksPageCount   — page count for a title+author query.
// fetchGoogleBooksCoverUrl    — cover URL; ISBN preferred, title+author fallback.
// fetchGoogleBooksMetadata    — combined: cover + description + page_count in one
//                              API call.  Use this when hydrating multiple fields.
//
// API key: set EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY secret for a higher quota.
// Without a key the anonymous tier is used (shared IP quota, easily exhausted).
// The key is inlined by Metro at bundle time via process.env.EXPO_PUBLIC_*.
//
// 429 handling: a single bounded retry after 1.5 s is attempted for any 429
// response.  If the retry is also 429, the strategy loop aborts immediately
// (rateLimited=true) so the caller never hammers an exhausted quota.
// =============================================================================

import { titleSearchVariants } from './titleNormalize';

// Resolved once at bundle time by Metro.  Null when env var is absent.
const API_KEY: string | null =
  (typeof process !== 'undefined' &&
   typeof process.env?.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY === 'string' &&
   process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim().length > 0)
    ? process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim()
    : null;

// Exported so debug / dev tools can surface whether an API key is configured.
export const gbApiKeyPresent: boolean = API_KEY !== null;

// Minimum ratio of significant title words that must appear in the result title.
const TITLE_MATCH_THRESHOLD = 0.6;

// A page count below this is almost certainly wrong (pamphlet/excerpt edition).
const MIN_CREDIBLE_PAGES = 30;

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // strip punctuation so "(the" → "the", "prisoner," → "prisoner"
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function titleMatches(expected: string, result: string): boolean {
  const expWords = significantWords(expected);
  if (expWords.length === 0) return true; // very short title — trust the API result

  const resultClean   = result.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const expectedClean = expected.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

  // Forward: expected words found in result (standard check).
  const fwdHits = expWords.filter(w => resultClean.includes(w)).length;
  if (fwdHits / expWords.length >= TITLE_MATCH_THRESHOLD) return true;

  // Reverse: result words found in expected.
  // Handles cases like expected="Glow (The Plated Prisoner, #4)" and
  // result="Glow" — the short result title IS a valid match for the series entry.
  const resWords = significantWords(result);
  if (resWords.length === 0) return false;
  const revHits = resWords.filter(w => expectedClean.includes(w)).length;
  return revHits / resWords.length >= TITLE_MATCH_THRESHOLD;
}

// ─── gbFetch — rate-limit aware fetch ────────────────────────────────────────
// One bounded retry on 429 after a 1.5 s pause.  If the retry is also 429,
// rateLimited is set to true so callers can bail out of their strategy loop
// without making more requests to an exhausted quota.

type GBFetchResult =
  | { ok: true;  rateLimited: false; status: number; data: unknown }
  | { ok: false; rateLimited: true;  status: 429;    data: null   }
  | { ok: false; rateLimited: false; status: number; data: null   };

async function gbFetch(url: string): Promise<GBFetchResult> {
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(1500);
      try {
        const retry = await fetch(url);
        if (retry.status === 429) return { ok: false, rateLimited: true,  status: 429,        data: null };
        if (!retry.ok)            return { ok: false, rateLimited: false, status: retry.status, data: null };
        return { ok: true, rateLimited: false, status: retry.status, data: await retry.json() };
      } catch {
        return { ok: false, rateLimited: true, status: 429, data: null };
      }
    }
    if (!res.ok) return { ok: false, rateLimited: false, status: res.status, data: null };
    return { ok: true, rateLimited: false, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, rateLimited: false, status: 0, data: null };
  }
}

// ─── Page count enrichment ────────────────────────────────────────────────────

export async function fetchGoogleBooksPageCount(
  title: string,
  author: string,
): Promise<number | null> {
  if (!title.trim()) return null;

  try {
    const authorTrimmed = author.slice(0, 40).trim();
    const skipAuthor    = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);
    const keyParam      = API_KEY ? `&key=${API_KEY}` : '';

    for (const variant of titleSearchVariants(title)) {
      const qParts = [`intitle:${variant.slice(0, 50).trim()}`];
      if (!skipAuthor) qParts.push(`inauthor:${authorTrimmed}`);
      const url =
        `https://www.googleapis.com/books/v1/volumes` +
        `?q=${encodeURIComponent(qParts.join(' '))}&maxResults=3&langRestrict=en&printType=books&fields=items(volumeInfo(title%2CpageCount))${keyParam}`;

      const res = await gbFetch(url);
      if (res.rateLimited) break; // quota exhausted — stop all strategies
      if (!res.ok) continue;

      const data = res.data as { items?: unknown[] };
      if (!Array.isArray(data.items) || data.items.length === 0) continue;

      for (const item of data.items) {
        const vi = (item as { volumeInfo?: { title?: string; pageCount?: unknown } })?.volumeInfo;
        if (!vi) continue;
        const pc: unknown = vi.pageCount;
        if (typeof pc !== 'number' || pc < MIN_CREDIBLE_PAGES) continue;
        if (!titleMatches(title, vi.title ?? '')) continue;
        return pc;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Cover URL enrichment ─────────────────────────────────────────────────────
// Prefers ISBN identifiers (authoritative); falls back to title+author search.
// Returns null and fails quietly on any network or parse error.

export async function fetchGoogleBooksCoverUrl(opts: {
  isbn13?: string | null;
  isbn?: string | null;
  title: string;
  author: string;
}): Promise<string | null> {
  const { isbn13, isbn, title, author } = opts;
  if (!title.trim()) return null;

  const keyParam = API_KEY ? `&key=${API_KEY}` : '';

  const strategies: Array<{ q: string; skipTitleCheck: boolean }> = [];

  if (isbn13?.trim()) {
    strategies.push({ q: `isbn:${isbn13.trim()}`, skipTitleCheck: true });
  } else if (isbn?.trim()) {
    strategies.push({ q: `isbn:${isbn.trim()}`, skipTitleCheck: true });
  }

  const authorTrimmed = author.slice(0, 40).trim();
  const skipAuthor    = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);
  for (const variant of titleSearchVariants(title)) {
    const parts = [`intitle:${variant.slice(0, 50).trim()}`];
    if (!skipAuthor) parts.push(`inauthor:${authorTrimmed}`);
    strategies.push({ q: parts.join(' '), skipTitleCheck: false });
  }

  for (const { q, skipTitleCheck } of strategies) {
    const url =
      `https://www.googleapis.com/books/v1/volumes` +
      `?q=${encodeURIComponent(q)}&maxResults=3&langRestrict=en&printType=books&fields=items(volumeInfo(title%2CimageLinks(thumbnail%2CsmallThumbnail)))${keyParam}`;
    const res = await gbFetch(url);
    if (res.rateLimited) break; // quota exhausted — stop all strategies
    if (!res.ok) continue;

    const data = res.data as { items?: unknown[] };
    if (!Array.isArray(data.items) || data.items.length === 0) continue;

    for (const item of data.items) {
      const vi = (item as { volumeInfo?: { title?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string } } })?.volumeInfo;
      if (!vi) continue;
      if (!skipTitleCheck && !titleMatches(title, vi.title ?? '')) continue;

      const thumbnail: unknown = vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail;
      if (typeof thumbnail === 'string' && thumbnail.length > 0) {
        return thumbnail.replace(/^http:\/\//, 'https://');
      }
    }
  }

  return null;
}

// ─── Combined metadata enrichment ─────────────────────────────────────────────
// Fetches cover_url, description, and page_count in a single API call sequence.
// Uses the same ISBN-priority strategy as fetchGoogleBooksCoverUrl.
// Stops at the first response item that passes the title-match guard and yields
// at least one non-null field.  All fields are populated from that same item
// for consistency (same edition, same API result).

export type GoogleBooksMetadata = {
  cover_url:   string | null;
  description: string | null;
  page_count:  number | null;
};

export async function fetchGoogleBooksMetadata(opts: {
  isbn13?: string | null;
  isbn?:   string | null;
  title:   string;
  author:  string;
}): Promise<GoogleBooksMetadata> {
  const result: GoogleBooksMetadata = { cover_url: null, description: null, page_count: null };
  const { isbn13, isbn, title, author } = opts;
  if (!title.trim()) return result;

  const keyParam = API_KEY ? `&key=${API_KEY}` : '';

  const strategies: Array<{ q: string; skipTitleCheck: boolean }> = [];
  if (isbn13?.trim()) {
    strategies.push({ q: `isbn:${isbn13.trim()}`, skipTitleCheck: true });
  } else if (isbn?.trim()) {
    strategies.push({ q: `isbn:${isbn.trim()}`, skipTitleCheck: true });
  }
  const authorTrimmed = author.slice(0, 40).trim();
  const skipAuthor    = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);
  for (const variant of titleSearchVariants(title)) {
    const parts = [`intitle:${variant.slice(0, 50).trim()}`];
    if (!skipAuthor) parts.push(`inauthor:${authorTrimmed}`);
    strategies.push({ q: parts.join(' '), skipTitleCheck: false });
  }

  for (const { q, skipTitleCheck } of strategies) {
    const url =
      `https://www.googleapis.com/books/v1/volumes` +
      `?q=${encodeURIComponent(q)}&maxResults=3&langRestrict=en&printType=books&fields=items(volumeInfo(title%2CimageLinks(thumbnail%2CsmallThumbnail)%2Cdescription%2CpageCount))${keyParam}`;
    const res = await gbFetch(url);
    if (res.rateLimited) break; // quota exhausted — stop all strategies
    if (!res.ok) continue;

    const data = res.data as { items?: unknown[] };
    if (!Array.isArray(data.items) || data.items.length === 0) continue;

    for (const item of data.items) {
      const vi = (item as { volumeInfo?: { title?: string; imageLinks?: { thumbnail?: string; smallThumbnail?: string }; description?: unknown; pageCount?: unknown } })?.volumeInfo;
      if (!vi) continue;
      if (!skipTitleCheck && !titleMatches(title, vi.title ?? '')) continue;

      const thumbnail: unknown = vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail;
      if (typeof thumbnail === 'string' && thumbnail.length > 0) {
        result.cover_url = thumbnail.replace(/^http:\/\//, 'https://');
      }

      const desc: unknown = vi.description;
      if (typeof desc === 'string' && desc.length > 30) {
        result.description = desc;
      }

      const pc: unknown = vi.pageCount;
      if (typeof pc === 'number' && pc >= MIN_CREDIBLE_PAGES) {
        result.page_count = pc;
      }

      // If this item gave us at least one field, commit to it and stop.
      if (result.cover_url || result.description || result.page_count) {
        return result;
      }
    }
  }

  return result;
}
