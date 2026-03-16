// =============================================================================
// Google Books — lightweight metadata enrichment helpers
// =============================================================================
// fetchGoogleBooksPageCount   — page count for a title+author query.
// fetchGoogleBooksCoverUrl    — cover URL; ISBN preferred, title+author fallback.
// fetchGoogleBooksMetadata    — combined: cover + description + page_count in one
//                              API call.  Use this when hydrating multiple fields.
//
// Optional: set EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY for a higher rate limit.
// Without a key the free anonymous tier is used (adequate for this use case).
// =============================================================================

const API_KEY =
  typeof process !== 'undefined'
    ? (process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY ?? null)
    : null;

// Minimum ratio of significant title words that must appear in the result title.
const TITLE_MATCH_THRESHOLD = 0.6;

// A page count below this is almost certainly wrong (pamphlet/excerpt edition).
const MIN_CREDIBLE_PAGES = 30;

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function titleMatches(expected: string, result: string): boolean {
  const words = significantWords(expected);
  if (words.length === 0) return true; // very short title — trust the API result
  const lower = result.toLowerCase();
  const hits = words.filter(w => lower.includes(w)).length;
  return hits / words.length >= TITLE_MATCH_THRESHOLD;
}

export async function fetchGoogleBooksPageCount(
  title: string,
  author: string,
): Promise<number | null> {
  if (!title.trim()) return null;

  try {
    const authorTrimmed = author.slice(0, 40).trim();
    const skipAuthor = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);
    const qParts = [`intitle:${title.slice(0, 50).trim()}`];
    if (!skipAuthor) qParts.push(`inauthor:${authorTrimmed}`);
    const q = encodeURIComponent(qParts.join(' '));
    const keyParam = API_KEY ? `&key=${API_KEY}` : '';
    const url =
      `https://www.googleapis.com/books/v1/volumes` +
      `?q=${q}&maxResults=5&langRestrict=en&printType=books${keyParam}`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data.items) || data.items.length === 0) return null;

    for (const item of data.items) {
      const vi = item?.volumeInfo;
      if (!vi) continue;

      const pc: unknown = vi.pageCount;
      if (typeof pc !== 'number' || pc < MIN_CREDIBLE_PAGES) continue;

      // Only accept results where the title is a reasonable match.
      if (!titleMatches(title, vi.title ?? '')) continue;

      return pc;
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

  // Strategy 1: ISBN13 (most authoritative)
  // Strategy 2: ISBN10 fallback
  // Strategy 3: title+author text search
  const strategies: Array<{ q: string; skipTitleCheck: boolean }> = [];

  if (isbn13?.trim()) {
    strategies.push({ q: `isbn:${isbn13.trim()}`, skipTitleCheck: true });
  } else if (isbn?.trim()) {
    strategies.push({ q: `isbn:${isbn.trim()}`, skipTitleCheck: true });
  }

  const authorTrimmed = author.slice(0, 40).trim();
  const skipAuthor = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);
  const titleParts = [`intitle:${title.slice(0, 50).trim()}`];
  if (!skipAuthor) titleParts.push(`inauthor:${authorTrimmed}`);
  strategies.push({ q: titleParts.join(' '), skipTitleCheck: false });

  for (const { q, skipTitleCheck } of strategies) {
    try {
      const url =
        `https://www.googleapis.com/books/v1/volumes` +
        `?q=${encodeURIComponent(q)}&maxResults=3&langRestrict=en&printType=books${keyParam}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data.items) || data.items.length === 0) continue;

      for (const item of data.items) {
        const vi = item?.volumeInfo;
        if (!vi) continue;
        if (!skipTitleCheck && !titleMatches(title, vi.title ?? '')) continue;

        const thumbnail: unknown =
          vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail;
        if (typeof thumbnail === 'string' && thumbnail.length > 0) {
          // Google Books returns http:// — upgrade to https
          return thumbnail.replace(/^http:\/\//, 'https://');
        }
      }
    } catch {
      // try next strategy
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
  const skipAuthor = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);
  const titleParts = [`intitle:${title.slice(0, 50).trim()}`];
  if (!skipAuthor) titleParts.push(`inauthor:${authorTrimmed}`);
  strategies.push({ q: titleParts.join(' '), skipTitleCheck: false });

  for (const { q, skipTitleCheck } of strategies) {
    try {
      const url =
        `https://www.googleapis.com/books/v1/volumes` +
        `?q=${encodeURIComponent(q)}&maxResults=5&langRestrict=en&printType=books${keyParam}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data.items) || data.items.length === 0) continue;

      for (const item of data.items) {
        const vi = item?.volumeInfo;
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
    } catch {
      // try next strategy
    }
  }

  return result;
}
