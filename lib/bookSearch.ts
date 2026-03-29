/**
 * Shared hybrid Google Books + Open Library search pipeline.
 *
 * Used by every book-search surface in the app:
 *   - app/add-book.tsx          (Add to Library)
 *   - app/(tabs)/search.tsx     (Recommend a Book / friend-send flow)
 *
 * Both surfaces call `searchBooks(query)` and get back the same
 * scored, confidence-filtered result list.
 */

import { scoreAndFilterBooks, mergeBookResults } from './searchRanking';
import { expandAlias } from './searchAliases';

// ─── Shared BookResult type ────────────────────────────────────────────────────
// Extends the OL shape with optional Google Books metadata fields.

export type BookResult = {
  key: string;
  title: string;
  author_name?: string[];
  cover_i?: number;
  cover_edition_key?: string;
  number_of_pages_median?: number;
  _source?: 'ol' | 'gb';
  _gbCoverUrl?: string;
  _gbId?: string;
  _isbn13?: string;
  _isbn10?: string;
};

// ─── API key ──────────────────────────────────────────────────────────────────

const GB_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY ?? '';

// ─── OL field list ────────────────────────────────────────────────────────────

const OL_FIELDS = 'key,title,author_name,cover_i,cover_edition_key,number_of_pages_median';

// ─── Stop-word set (for variant generation) ───────────────────────────────────

const STOP = new Set([
  'the','a','an','of','in','to','for','and','or','but','by',
  'at','as','on','its','is','it','be','my','we','us','if','up','so',
]);

// ─── Google Books fetch ───────────────────────────────────────────────────────

export async function fetchGoogleBooks(q: string): Promise<BookResult[]> {
  if (!GB_API_KEY) return [];
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&key=${GB_API_KEY}&maxResults=20&printType=books`;
    const res  = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    const items: any[] = json.items ?? [];
    return items.map(item => {
      const info   = item.volumeInfo ?? {};
      const isbns: { type: string; identifier: string }[] = info.industryIdentifiers ?? [];
      const isbn13 = isbns.find(x => x.type === 'ISBN_13')?.identifier;
      const isbn10 = isbns.find(x => x.type === 'ISBN_10')?.identifier;
      const thumb  = (info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? '')
        .replace('http://', 'https://');
      return {
        key:                    `gb:${item.id}`,
        title:                  info.title ?? '',
        author_name:            info.authors ?? [],
        number_of_pages_median: typeof info.pageCount === 'number' ? info.pageCount : undefined,
        _source:                'gb' as const,
        _gbCoverUrl:            thumb || undefined,
        _gbId:                  item.id,
        _isbn13:                isbn13,
        _isbn10:                isbn10,
      } satisfies BookResult;
    }).filter(b => b.title.length > 0);
  } catch {
    return [];
  }
}

// ─── OL key resolution (via ISBN) ────────────────────────────────────────────
// Attempt to resolve a Google Books result to an OL work key.
// Fires in parallel with other I/O so net latency ≈ 0.

export async function resolveOLKeyFromIsbn(book: BookResult): Promise<string> {
  const isbn = book._isbn13 ?? book._isbn10;
  if (!isbn) return book.key;
  try {
    const res  = await fetch(`https://openlibrary.org/search.json?isbn=${isbn}&fields=key&limit=1`);
    const json = await res.json();
    const key  = (json.docs ?? [])[0]?.key as string | undefined;
    if (key && key.startsWith('/works/')) return key;
  } catch {}
  return book.key;
}

// ─── Cross-source dedup key ───────────────────────────────────────────────────

export function _dedupKey(title: string, author?: string): string {
  const t = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  const a = (author ?? '').toLowerCase().split(/\s+/).pop()?.replace(/[^a-z0-9]/g, '') ?? '';
  return `${t}::${a}`;
}

// ─── Hybrid merge ─────────────────────────────────────────────────────────────
// GB results first; OL results appended only when not already represented by GB.

export function hybridMerge(gbBooks: BookResult[], olBooks: BookResult[]): BookResult[] {
  const seen = new Set(gbBooks.map(b => _dedupKey(b.title, b.author_name?.[0])));
  const filtered = olBooks.filter(b => {
    const k = _dedupKey(b.title, b.author_name?.[0]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...gbBooks, ...filtered];
}

// ─── Return type from searchBooks() ──────────────────────────────────────────

export type SearchBooksResult = {
  results: BookResult[];
  hasHigh: boolean;
  hasMedium: boolean;
  lastTokenIncomplete: boolean;
  noResults: boolean;
  weakQuery: boolean;
};

// ─── Core search function ─────────────────────────────────────────────────────
// Full hybrid GB + OL retrieval pipeline with confidence scoring.
// Callers are responsible for debouncing and stale-request cancellation.

export async function searchBooks(rawQuery: string): Promise<SearchBooksResult> {
  const empty: SearchBooksResult = {
    results: [], hasHigh: false, hasMedium: false,
    lastTokenIncomplete: false, noResults: false, weakQuery: false,
  };

  const aliasExpansion = expandAlias(rawQuery);
  const searchQuery    = aliasExpansion ?? rawQuery;
  const tokens         = searchQuery.trim().split(/\s+/);
  const longestToken   = tokens.reduce((m, t) => Math.max(m, t.length), 0);
  const isAliasQuery   = !!aliasExpansion;
  const queryTooWeak   = !isAliasQuery && longestToken < 4;

  if (queryTooWeak) return { ...empty, weakQuery: true };

  // ── Abbreviation path ──────────────────────────────────────────────────────
  // Short single-token queries (≤ 5 chars, no alias): trust OL community ranking.
  const isAbbrevQuery = !aliasExpansion && tokens.length === 1 && searchQuery.trim().length <= 5;
  if (isAbbrevQuery) {
    try {
      const url  = `https://openlibrary.org/search.json?q=${encodeURIComponent(searchQuery)}&fields=${OL_FIELDS}&limit=15`;
      const res  = await fetch(url);
      const json = await res.json();
      const raw: BookResult[] = json.docs ?? [];
      return { ...empty, results: raw.slice(0, 15), noResults: raw.length === 0 };
    } catch {
      return { ...empty, noResults: true };
    }
  }

  // ── Hybrid retrieval path ──────────────────────────────────────────────────
  const sigTokens = tokens.filter(t => t.length >= 3 && !STOP.has(t));
  const lastTok   = tokens[tokens.length - 1];

  // When the last token is short (< 4 chars) it's likely an incomplete partial
  // word ("boa" for "boats"). Exclude it from the reduced/coreTwo OL variants
  // so we don't fire useless 0-result word-indexed queries.
  const sigForReduced = (lastTok.length < 4 && sigTokens.length > 1)
    ? sigTokens.filter(t => t !== lastTok)
    : sigTokens;
  const reduced    = sigForReduced.join(' ');
  const coreTwo    = sigForReduced.slice(0, 2).join(' ');
  const headTokens = lastTok.length <= 4 && tokens.length >= 2
    ? tokens.slice(0, -1).join(' ')
    : null;

  type Variant = { param: 'title' | 'q'; q: string };
  const variantList: Variant[] = [];
  variantList.push({ param: 'title', q: searchQuery });
  variantList.push({ param: 'q',     q: searchQuery });
  if (reduced && reduced !== searchQuery)
    variantList.push({ param: 'title', q: reduced });
  if (coreTwo && coreTwo !== reduced && coreTwo !== searchQuery && sigTokens.length >= 2)
    variantList.push({ param: 'title', q: coreTwo });
  if (headTokens && headTokens !== reduced && headTokens !== coreTwo && headTokens !== searchQuery)
    variantList.push({ param: 'title', q: headTokens });

  const seenV = new Set<string>();
  const variants = variantList.filter(v => {
    const k = `${v.param}:${v.q}`;
    if (seenV.has(k)) return false;
    seenV.add(k);
    return true;
  });

  // Fire Google Books + all OL variants in parallel
  const olFetches = variants.map(v => {
    const url = `https://openlibrary.org/search.json?${v.param}=${encodeURIComponent(v.q)}&fields=${OL_FIELDS}&limit=20`;
    return fetch(url)
      .then(r => r.json() as Promise<{ docs?: BookResult[] }>)
      .catch(() => ({ docs: [] as BookResult[] }));
  });

  const [gbBooks, ...olResponses] = await Promise.all([
    fetchGoogleBooks(searchQuery),
    ...olFetches,
  ]);

  // Merge OL results (dedup by OL key within OL pool)
  let olMerged: BookResult[] = [];
  for (const resp of olResponses) {
    olMerged = mergeBookResults(olMerged, (resp as { docs?: BookResult[] }).docs ?? []);
  }

  // hybridMerge: GB first, then OL books not already in GB by title+author
  const merged = hybridMerge(gbBooks as BookResult[], olMerged);

  // Score the merged pool once
  const scored = scoreAndFilterBooks(searchQuery, merged);

  const lastTokenIncomplete = lastTok.length <= 3;

  if (scored.hasHigh || (scored.hasMedium && !lastTokenIncomplete)) {
    return {
      results: scored.results,
      hasHigh: scored.hasHigh,
      hasMedium: scored.hasMedium,
      lastTokenIncomplete,
      noResults: false,
      weakQuery: false,
    };
  }

  const isDefinitiveQuery = tokens.length >= 2 || searchQuery.trim().length >= 8;
  return {
    ...empty,
    lastTokenIncomplete,
    noResults: isDefinitiveQuery,
    weakQuery: !isDefinitiveQuery,
  };
}
