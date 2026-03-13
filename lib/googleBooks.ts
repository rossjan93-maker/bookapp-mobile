// =============================================================================
// Google Books — lightweight page-count enrichment helper
// =============================================================================
// Searches Google Books by title + author when a book has no page_count.
// Returns a page count only when a result matches the expected title closely
// enough to be trustworthy. Falls back gracefully on any error.
//
// Optional: set EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY for a higher rate limit.
// Without a key the free anonymous tier is used (adequate for this use case).
// =============================================================================

const API_KEY =
  typeof process !== 'undefined'
    ? (process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY ?? null)
    : null;

// Minimum ratio of significant title words that must appear in the result title.
const TITLE_MATCH_THRESHOLD = 0.5;

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
    const q = encodeURIComponent(
      `intitle:${title.slice(0, 50).trim()} inauthor:${author.slice(0, 40).trim()}`,
    );
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
