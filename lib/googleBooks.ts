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

// Strip Unicode diacritics and lowercase — used for author comparison only.
// "Renée Carlino" and "Renee Carlino" should compare equal.
function normalizeForCompare(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// True when at least 50% of the meaningful words from `storedAuthor` appear
// in any result author string after diacritic normalization.
// Used by the title-only fallback to avoid accepting a same-title different-author book.
// Returns true when either side is empty/unknown (unverifiable — accept conservatively).
function authorApproxMatches(storedAuthor: string, resultAuthors: string[]): boolean {
  if (!storedAuthor || resultAuthors.length === 0) return true;
  const normStored = normalizeForCompare(storedAuthor);
  const storedWords = normStored.split(/\s+/).filter(w => w.length > 2);
  if (storedWords.length === 0) return true;
  for (const ra of resultAuthors) {
    const normResult = normalizeForCompare(ra);
    const hits = storedWords.filter(w => normResult.includes(w)).length;
    if (hits / storedWords.length >= 0.5) return true;
  }
  return false;
}

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

  type GBCoverStrategy = { q: string; skipTitleCheck: boolean; checkAuthor: boolean };
  const strategies: GBCoverStrategy[] = [];

  if (isbn13?.trim()) {
    strategies.push({ q: `isbn:${isbn13.trim()}`, skipTitleCheck: true, checkAuthor: false });
  } else if (isbn?.trim()) {
    strategies.push({ q: `isbn:${isbn.trim()}`, skipTitleCheck: true, checkAuthor: false });
  }

  const authorTrimmed = author.slice(0, 40).trim();
  const skipAuthor    = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);

  // Primary: title + author
  for (const variant of titleSearchVariants(title)) {
    if (!skipAuthor) {
      strategies.push({ q: `intitle:${variant.slice(0, 50).trim()} inauthor:${authorTrimmed}`, skipTitleCheck: false, checkAuthor: false });
    }
  }

  // Fallback: title-only with diacritic-insensitive author post-check
  for (const variant of titleSearchVariants(title)) {
    strategies.push({ q: `intitle:${variant.slice(0, 50).trim()}`, skipTitleCheck: false, checkAuthor: !skipAuthor });
  }

  for (const { q, skipTitleCheck, checkAuthor } of strategies) {
    const url =
      `https://www.googleapis.com/books/v1/volumes` +
      `?q=${encodeURIComponent(q)}&maxResults=3&langRestrict=en&printType=books&fields=items(volumeInfo(title%2Cauthors%2CimageLinks(thumbnail%2CsmallThumbnail)))${keyParam}`;
    const res = await gbFetch(url);
    if (res.rateLimited) break; // quota exhausted — stop all strategies
    if (!res.ok) continue;

    const data = res.data as { items?: unknown[] };
    if (!Array.isArray(data.items) || data.items.length === 0) continue;

    for (const item of data.items) {
      const vi = (item as { volumeInfo?: { title?: string; authors?: string[]; imageLinks?: { thumbnail?: string; smallThumbnail?: string } } })?.volumeInfo;
      if (!vi) continue;
      if (!skipTitleCheck && !titleMatches(title, vi.title ?? '')) continue;
      if (checkAuthor && !authorApproxMatches(author, vi.authors ?? [])) continue;

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
  /** The real Google Books volume ID (e.g. "XfFvDwAAQBAJ").
   *  Non-null when the API returned a matched item; null when no match was found.
   *  This is the canonical source_book_id for book_source_links — never use
   *  a title fragment or ISBN as a substitute for this field. */
  volume_id:   string | null;
  /**
   * Raw BISAC-style categories from the Google Books API (e.g. ["Fiction / Fantasy / Epic"]).
   * Non-null only when the matched item carries at least one category string.
   * Pass to normalizeGBCategories() to get app-compatible subject strings.
   */
  categories:  string[] | null;
};

// ─── BISAC category → app subject normalization ───────────────────────────────
// Google Books returns categories as BISAC-style hierarchical strings:
//   "Fiction / Fantasy / Epic"
//   "Young Adult Fiction"
//   "Biography & Autobiography / Personal Memoirs"
//
// Strategy:
//   1. Split each category string on " / " to isolate hierarchy segments.
//   2. Normalize each segment: lowercase, " & " → " and ", trim.
//   3. Drop segments that are too generic to be useful as standalone subjects.
//   4. Collect, deduplicate, cap at 15.
//
// The blocklist uses exact post-normalized matching — "juvenile fiction" and
// "young adult fiction" pass through intentionally; "fiction" alone does not.
//
// Exported so callers (lib/subjectRepair.ts, scripts) can use it independently.

const GB_GENERIC_TERMS = new Set([
  'fiction',
  'nonfiction',
  'non-fiction',
  'books',
  'general',
  'literature',
  'electronic books',
  'large print books',
  'audiobooks',
  'ebooks',
  'e-books',
]);

export function normalizeGBCategories(categories: string[]): string[] {
  const out = new Set<string>();

  for (const cat of categories) {
    if (typeof cat !== 'string' || !cat.trim()) continue;

    const segments = cat
      .split('/')
      .map(s => s.trim().replace(/\s*&\s*/g, ' and ').toLowerCase())
      .filter(Boolean);

    for (const seg of segments) {
      if (!GB_GENERIC_TERMS.has(seg)) {
        out.add(seg);
      }
    }
  }

  return Array.from(out).slice(0, 15);
}

export async function fetchGoogleBooksMetadata(opts: {
  isbn13?: string | null;
  isbn?:   string | null;
  title:   string;
  author:  string;
}): Promise<GoogleBooksMetadata> {
  const result: GoogleBooksMetadata = { cover_url: null, description: null, page_count: null, volume_id: null, categories: null };
  const { isbn13, isbn, title, author } = opts;
  if (!title.trim()) return result;

  const keyParam = API_KEY ? `&key=${API_KEY}` : '';

  // ── Strategy building ────────────────────────────────────────────────────────
  // `checkAuthor` is set on title-only fallback strategies so we can verify
  // the result author against the stored author (diacritic-insensitive) before
  // accepting — guards against same-title different-author books (e.g. two
  // books both titled "Before We Were Strangers" by different authors).

  type GBStrategy = { q: string; skipTitleCheck: boolean; checkAuthor: boolean };
  const strategies: GBStrategy[] = [];

  if (isbn13?.trim()) {
    strategies.push({ q: `isbn:${isbn13.trim()}`, skipTitleCheck: true, checkAuthor: false });
  } else if (isbn?.trim()) {
    strategies.push({ q: `isbn:${isbn.trim()}`, skipTitleCheck: true, checkAuthor: false });
  }

  const authorTrimmed = author.slice(0, 40).trim();
  const skipAuthor    = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);

  // Primary: title + author (most specific — fewest false positives)
  for (const variant of titleSearchVariants(title)) {
    if (!skipAuthor) {
      strategies.push({ q: `intitle:${variant.slice(0, 50).trim()} inauthor:${authorTrimmed}`, skipTitleCheck: false, checkAuthor: false });
    }
  }

  // Fallback: title-only variants (activated when author-qualified searches return nothing,
  // e.g. author name stored without diacritics while GB indexes it with diacritics).
  // Each uses authorApproxMatches() — diacritic-insensitive — as a post-filter.
  for (const variant of titleSearchVariants(title)) {
    strategies.push({ q: `intitle:${variant.slice(0, 50).trim()}`, skipTitleCheck: false, checkAuthor: !skipAuthor });
  }

  // NOTE: `id` is included in the fields param so we get the real GB volume ID.
  // This is the canonical identifier for book_source_links.source_book_id.
  // `categories` is included for subject enrichment (see normalizeGBCategories).
  const fields = 'items(id,volumeInfo(title,authors,categories,imageLinks(thumbnail,smallThumbnail),description,pageCount))';

  for (const { q, skipTitleCheck, checkAuthor } of strategies) {
    const url =
      `https://www.googleapis.com/books/v1/volumes` +
      `?q=${encodeURIComponent(q)}&maxResults=3&langRestrict=en&printType=books&fields=${encodeURIComponent(fields)}${keyParam}`;
    const res = await gbFetch(url);
    if (res.rateLimited) break; // quota exhausted — stop all strategies
    if (!res.ok) continue;

    const data = res.data as { items?: unknown[] };
    if (!Array.isArray(data.items) || data.items.length === 0) continue;

    for (const item of data.items) {
      const typedItem = item as {
        id?: string;
        volumeInfo?: {
          title?: string;
          authors?: string[];
          categories?: unknown;
          imageLinks?: { thumbnail?: string; smallThumbnail?: string };
          description?: unknown;
          pageCount?: unknown;
        };
      };
      const vi = typedItem?.volumeInfo;
      if (!vi) continue;
      if (!skipTitleCheck && !titleMatches(title, vi.title ?? '')) continue;

      // For title-only fallback: reject items whose author clearly doesn't match.
      // This prevents accepting a same-title book by a different author.
      if (checkAuthor && !authorApproxMatches(author, vi.authors ?? [])) {
        console.log(`[GB] title-only fallback: author mismatch — result="${(vi.authors ?? [])[0] ?? ''}" stored="${author}" — skipping`);
        continue;
      }

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

      if (Array.isArray(vi.categories)) {
        const cats = (vi.categories as unknown[]).filter(
          (c): c is string => typeof c === 'string' && c.trim().length > 0,
        );
        if (cats.length > 0) result.categories = cats;
      }

      // If this item gave us at least one field, capture its volume ID and commit.
      if (result.cover_url || result.description || result.page_count || result.categories) {
        // Capture the real GB volume ID — this is the canonical source_book_id.
        if (typeof typedItem.id === 'string' && typedItem.id.length > 0) {
          result.volume_id = typedItem.id;
        }
        console.log(`[GB] fetchGoogleBooksMetadata — matched "${vi.title}" id=${result.volume_id ?? 'none'} strategy="${checkAuthor ? 'title-only-fallback' : 'author-qualified'}"`);
        return result;
      }
    }
  }

  return result;
}
