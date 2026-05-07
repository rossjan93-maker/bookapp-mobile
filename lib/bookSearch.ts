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
  first_publish_year?: number;
  _source?: 'ol' | 'gb';
  _gbCoverUrl?: string;
  _gbId?: string;
  _isbn13?: string;
  _isbn10?: string;
};

// ─── API key ──────────────────────────────────────────────────────────────────

const GB_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY ?? '';

// Warn ONCE per JS context if the GB key is missing — anonymous-tier requests
// still work but get rate-limited under any real volume, which presents to the
// user as "search returned nothing".
let _gbKeyWarned = false;
function warnMissingGbKey(): void {
  if (_gbKeyWarned) return;
  _gbKeyWarned = true;
  console.warn(
    '[bookSearch] EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY is not set — falling back to Open Library only. ' +
      'Search results will be sparser and Google Books covers will not be available.',
  );
}

// ─── OL field list ────────────────────────────────────────────────────────────

const OL_FIELDS = 'key,title,author_name,cover_i,cover_edition_key,number_of_pages_median,first_publish_year';

// ─── Typo-tolerant author entity helpers ─────────────────────────────────────
// Damerau-friendly Levenshtein, capped at distance 3 for early exit. Used to
// decide whether an Open Library author hit is a plausible fuzzy match for
// the user's query (e.g. "tara" ↔ "tana" = 1, accept; "tara" ↔ "smith" = 5,
// reject). Kept inline — pulling in a dependency for ~25 lines isn't worth it.
function _editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}

// Author name is "close" to the query when every query token has at least one
// name token within edit-distance 2 AND length-difference 2. This catches
// 1–2 char typos ("tara french" → "Tana French", "stephne king" → "Stephen
// King") without admitting wildly different authors.
function _namesAreClose(query: string, name: string): boolean {
  const qTokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  const nTokens = name.toLowerCase().replace(/[.,]/g, '').split(/\s+/).filter(t => t.length >= 1);
  if (qTokens.length === 0 || nTokens.length === 0) return false;
  return qTokens.every(qt => nTokens.some(nt =>
    Math.abs(qt.length - nt.length) <= 2 && _editDistance(qt, nt) <= 2,
  ));
}

// Open Library has a dedicated author-entity index with built-in fuzzy match.
// We use it as a typo-tolerance layer: when the query looks like a person's
// name (e.g. "tara french") we ask OL "which author entities sound like
// this?", filter to ones whose name is fuzzy-close to the query AND has a
// real catalog (≥ 3 works), then pull each matched author's catalog via
// `author_key=`. The returned books are merged in front of the standard
// scored results — the user typed an author name, so author-confirmed
// books are the strongest possible signal.
async function fetchOLByAuthorEntity(query: string): Promise<BookResult[]> {
  const t0 = Date.now();
  try {
    const authRes = await fetchWithTimeout(
      `https://openlibrary.org/search/authors.json?q=${encodeURIComponent(query)}&limit=5`,
    );
    if (!authRes.ok) {
      if (__DEV__) console.log(`[bookSearch] OL author-entity HTTP ${authRes.status}`);
      return [];
    }
    const authJson = await authRes.json() as {
      docs?: { key?: string; name?: string; work_count?: number }[];
    };
    const candidates = authJson.docs ?? [];

    // Filter to fuzzy-close authors with non-trivial catalogs. Cap at 2 to
    // avoid drowning the result list with similarly-named distant authors.
    const matched = candidates
      .filter(a => typeof a.name === 'string' && a.key
        && (a.work_count ?? 0) >= 3
        && _namesAreClose(query, a.name))
      .slice(0, 2);

    if (__DEV__) {
      console.log(`[bookSearch] OL author-entity q="${query}" ${Date.now() - t0}ms — ${candidates.length} candidates → ${matched.length} matched (${matched.map(a => a.name).join(', ') || 'none'})`);
    }
    if (matched.length === 0) return [];

    const catalogPromises = matched.map(a => {
      const key = (a.key as string).replace(/^\/?authors\//, '');
      const url = `https://openlibrary.org/search.json?author_key=${encodeURIComponent(key)}&fields=${OL_FIELDS}&sort=rating&limit=15`;
      return fetchWithTimeout(url)
        .then(r => r.ok ? r.json() as Promise<{ docs?: BookResult[] }> : { docs: [] as BookResult[] })
        .then(j => j.docs ?? [])
        .catch(() => [] as BookResult[]);
    });
    const catalogs = await Promise.all(catalogPromises);
    return catalogs.flat();
  } catch (err) {
    if (__DEV__) console.log('[bookSearch] OL author-entity failed:', (err as Error)?.message ?? err);
    return [];
  }
}

// ─── Network helpers ──────────────────────────────────────────────────────────
// Mobile networks routinely drop or stall fetches. Without timeouts a single
// hung request will keep the UI's "Searching…" spinner spinning forever and
// the stale-request guard in add-book.tsx will discard the eventual response.

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(
  url: string,
  ms: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Stop-word set (for variant generation) ───────────────────────────────────

const STOP = new Set([
  'the','a','an','of','in','to','for','and','or','but','by',
  'at','as','on','its','is','it','be','my','we','us','if','up','so',
]);

// ─── In-memory result cache ───────────────────────────────────────────────────
// Tiny LRU keyed by normalized query string so repeated searches (typing
// "dune" → backspace → "dune" again, or back-navigation into the add-book
// sheet) don't re-hit the network. TTL is short — book metadata is stable
// minute-to-minute, but we don't want to mask provider issues for long.

const SEARCH_CACHE_MAX_ENTRIES = 24;
const SEARCH_CACHE_TTL_MS      = 5 * 60 * 1000; // 5 min

type CacheEntry = { result: SearchBooksResult; cachedAt: number };
const _searchCache = new Map<string, CacheEntry>();

function cacheKey(rawQuery: string): string {
  return rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCached(rawQuery: string): SearchBooksResult | null {
  const k = cacheKey(rawQuery);
  const hit = _searchCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > SEARCH_CACHE_TTL_MS) {
    _searchCache.delete(k);
    return null;
  }
  // LRU touch — re-insert moves the key to the end of insertion order.
  _searchCache.delete(k);
  _searchCache.set(k, hit);
  return hit.result;
}

function setCached(rawQuery: string, result: SearchBooksResult): void {
  // Don't cache empty/error results — they're often transient network blips
  // and we want the next keystroke to re-attempt the network.
  if (result.results.length === 0) return;
  const k = cacheKey(rawQuery);
  _searchCache.set(k, { result, cachedAt: Date.now() });
  while (_searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = _searchCache.keys().next().value;
    if (oldest === undefined) break;
    _searchCache.delete(oldest);
  }
}

export function _clearSearchCache(): void { _searchCache.clear(); }

// ─── Google Books fetch ───────────────────────────────────────────────────────

export async function fetchGoogleBooks(q: string): Promise<BookResult[]> {
  if (!GB_API_KEY) {
    warnMissingGbKey();
    return [];
  }
  try {
    const fields = 'fields=items(id%2CvolumeInfo(title%2Cauthors%2CimageLinks(thumbnail%2CsmallThumbnail)%2CindustryIdentifiers%2CpageCount))';
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&key=${GB_API_KEY}&maxResults=10&printType=books&${fields}`;
    const res  = await fetchWithTimeout(url);
    if (!res.ok) {
      // 403/429/5xx — surface in dev console so the failure mode is visible.
      // The OL fallback path will still run; we just won't have GB results.
      console.warn('[bookSearch] Google Books returned', res.status, 'for query', JSON.stringify(q));
      return [];
    }
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
  } catch (err) {
    // Network/timeout errors during GB are expected on flaky links; surface
    // them so the search-fallback path is debuggable when users report empty
    // results.
    console.warn('[bookSearch] Google Books request failed:', err);
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
    // Use the same 6s timeout wrapper as the search legs — without it, a hung
    // OL response here would block the user's "Add to Library" tap until the
    // platform's default timeout (often minutes), looking like a frozen UI.
    const res  = await fetchWithTimeout(`https://openlibrary.org/search.json?isbn=${isbn}&fields=key&limit=1`);
    const json = await res.json();
    const key  = (json.docs ?? [])[0]?.key as string | undefined;
    if (key && key.startsWith('/works/')) return key;
  } catch (err) {
    console.warn('[bookSearch] resolveOLKeyFromIsbn failed for isbn', isbn, ':', err);
  }
  return book.key;
}

// ─── Cross-source dedup key ───────────────────────────────────────────────────

export function _dedupKey(title: string, author?: string): string {
  const t = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  const a = (author ?? '').toLowerCase().split(/\s+/).pop()?.replace(/[^a-z0-9]/g, '') ?? '';
  return `${t}::${a}`;
}

// ─── Quality filter ──────────────────────────────────────────────────────────
// Drops results that are almost certainly junk: missing/unknown author *and*
// no cover artwork. A legitimate book may lack a cover OR an author, but
// almost never both — those rows are typically OCR fragments, ghost
// editions, or library catalog placeholders that confuse users.
function isJunkResult(b: BookResult): boolean {
  const rawAuthor = (b.author_name ?? [])[0]?.trim() ?? '';
  const author    = rawAuthor.toLowerCase();
  const hasAuthor = !!author && author !== 'unknown' && author !== 'unknown author';
  const hasCover  = !!b.cover_i || !!(b as { cover_url?: string }).cover_url;
  return !hasAuthor && !hasCover;
}

// ─── Hybrid merge ─────────────────────────────────────────────────────────────
// (1) Dedupe internally within Google Books results by title+author —
//     GB happily returns the same work three times across editions /
//     publisher metadata so the user sees three identical rows.
// (2) Append OL results only when not already represented by GB.
// (3) Drop junk rows (no author + no cover) at every stage.

export function hybridMerge(gbBooks: BookResult[], olBooks: BookResult[]): BookResult[] {
  const seen: Set<string> = new Set();
  const dedupedGb: BookResult[] = [];
  for (const b of gbBooks) {
    if (isJunkResult(b)) continue;
    const k = _dedupKey(b.title, b.author_name?.[0]);
    if (seen.has(k)) continue;
    seen.add(k);
    dedupedGb.push(b);
  }
  const filteredOl = olBooks.filter(b => {
    if (isJunkResult(b)) return false;
    const k = _dedupKey(b.title, b.author_name?.[0]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...dedupedGb, ...filteredOl];
}

// ─── Word completion via Datamuse ─────────────────────────────────────────────
// Free, no-auth API for prefix-based word expansion.
// Returns single-word completions for a given prefix (e.g. "boa" → ["boast","board","boat",...]).
// Only used as a fallback when the primary pipeline returns no HIGH results.

async function fetchCompletions(prefix: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      `https://api.datamuse.com/words?sp=${encodeURIComponent(prefix)}*&max=20`
    );
    if (!res.ok) {
      console.warn(`[bookSearch] Datamuse non-2xx for prefix="${prefix}":`, res.status);
      return [];
    }
    const words: { word: string }[] = await res.json();
    return words
      .map(w => w.word)
      .filter(w =>
        !w.includes(' ') &&             // single word only
        w.length > prefix.length &&     // must be a genuine completion (longer than prefix)
        w.length <= prefix.length + 8 &&// not wildly long
        !STOP.has(w) &&                 // not a function word
        w !== prefix                    // not the prefix itself
      )
      .slice(0, 8);
  } catch (err) {
    console.warn('[bookSearch] Datamuse request failed:', err);
    return [];
  }
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
//
// Streaming
// ---------
// Pass `opts.onPartial` to receive a fast first batch as soon as the Google
// Books leg completes (typically ~300-700 ms on a healthy network). The OL
// variants continue in the background and the final merged/scored result is
// the awaited return value. This keeps the UI from sitting on the spinner
// for the full 6 s timeout when one OL variant is slow.
//
// Caching
// -------
// Recent queries are cached in-memory (LRU, 24 entries, 5 min TTL). Cache
// hits return immediately and do NOT fire `onPartial` (no need — we have
// the full result already).

export type SearchOpts = {
  onPartial?: (partial: SearchBooksResult) => void;
};

export async function searchBooks(
  rawQuery: string,
  opts: SearchOpts = {},
): Promise<SearchBooksResult> {
  // Cache check — instant return for repeats.
  const cached = getCached(rawQuery);
  if (cached) {
    if (__DEV__) console.log('[bookSearch] cache hit:', JSON.stringify(rawQuery));
    return cached;
  }

  const t0 = Date.now();
  const empty: SearchBooksResult = {
    results: [], hasHigh: false, hasMedium: false,
    lastTokenIncomplete: false, noResults: false, weakQuery: false,
  };

  const aliasExpansion = expandAlias(rawQuery);
  const searchQuery    = aliasExpansion ?? rawQuery;
  const tokens         = searchQuery.trim().split(/\s+/);
  const longestToken   = tokens.reduce((m, t) => Math.max(m, t.length), 0);
  const isAliasQuery   = !!aliasExpansion;
  // Allow 3-letter title words ("kid", "war", "sun") through — many real titles
  // contain only short tokens. The abbreviation path below catches single-token
  // queries ≤ 5 chars.  Was: longestToken < 4 (rejected too many real searches).
  const queryTooWeak   = !isAliasQuery && longestToken < 3;

  if (queryTooWeak) return { ...empty, weakQuery: true };

  // ── Abbreviation path ──────────────────────────────────────────────────────
  // Short single-token queries (≤ 5 chars, no alias): trust OL community ranking.
  const isAbbrevQuery = !aliasExpansion && tokens.length === 1 && searchQuery.trim().length <= 5;
  if (isAbbrevQuery) {
    try {
      const url  = `https://openlibrary.org/search.json?q=${encodeURIComponent(searchQuery)}&fields=${OL_FIELDS}&limit=15`;
      const res  = await fetchWithTimeout(url);
      if (!res.ok) {
        console.warn('[bookSearch] OL abbrev returned', res.status, 'for', JSON.stringify(searchQuery));
        return { ...empty, noResults: true };
      }
      const json = await res.json();
      const raw: BookResult[] = json.docs ?? [];
      const abbrevResult: SearchBooksResult = {
        ...empty,
        results: raw.slice(0, 15),
        noResults: raw.length === 0,
      };
      setCached(rawQuery, abbrevResult);
      return abbrevResult;
    } catch (err) {
      console.warn('[bookSearch] OL abbrev failed:', (err as Error)?.message ?? err);
      return { ...empty, noResults: true };
    }
  }

  // ── Hybrid retrieval path ──────────────────────────────────────────────────
  const sigTokens = tokens.filter(t => t.length >= 3 && !STOP.has(t));
  const lastTok   = tokens[tokens.length - 1];

  // ── Person-name detection ───────────────────────────────────────────────
  // Heuristic: 2–4 tokens, every token is purely alphabetic (no digits or
  // punctuation), 2–14 chars, and none are stop words. This catches author
  // queries like "tana french", "george r r martin", "jrr tolkien" without
  // misfiring on titles like "the road" (stop word) or "1984" (digits).
  // When matched we additionally fire author-qualified GB + OL variants so
  // the APIs return the author's catalog instead of guessing at a title.
  const looksLikePersonName = (() => {
    if (tokens.length < 2 || tokens.length > 4) return false;
    return tokens.every(t =>
      /^[a-zA-Z][a-zA-Z.'-]{0,13}$/.test(t) &&
      !STOP.has(t.toLowerCase())
    );
  })();

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

  type Variant = { param: 'title' | 'q' | 'author'; q: string };
  const variantList: Variant[] = [];
  variantList.push({ param: 'title', q: searchQuery });
  variantList.push({ param: 'q',     q: searchQuery });
  if (reduced && reduced !== searchQuery)
    variantList.push({ param: 'title', q: reduced });
  if (coreTwo && coreTwo !== reduced && coreTwo !== searchQuery && sigTokens.length >= 2)
    variantList.push({ param: 'title', q: coreTwo });
  if (headTokens && headTokens !== reduced && headTokens !== coreTwo && headTokens !== searchQuery)
    variantList.push({ param: 'title', q: headTokens });
  // Author-qualified variant: fires when the query looks like a person's
  // name. OL `author=` returns docs ranked by works whose author_name
  // matches, so "tana french" gets her catalog back instead of titles
  // that happen to contain those tokens.
  if (looksLikePersonName)
    variantList.push({ param: 'author', q: searchQuery });

  const seenV = new Set<string>();
  const variants = variantList.filter(v => {
    const k = `${v.param}:${v.q}`;
    if (seenV.has(k)) return false;
    seenV.add(k);
    return true;
  });

  // Fire Google Books + all OL variants in parallel.
  // Wrap each leg with a per-leg timing log so a slow provider is identifiable
  // in the console without instrumenting the call sites.
  const tGb0 = Date.now();
  // For person-name queries we use Google Books' `inauthor:` operator so
  // the result set is the author's catalog rather than fuzzy keyword hits.
  // Combine with the bare query so we still capture title hits when the
  // person-name heuristic fires on a query that's also a real title.
  const gbQuery = looksLikePersonName
    ? `inauthor:"${searchQuery}"`
    : searchQuery;
  const gbPromise = fetchGoogleBooks(gbQuery).then(async books => {
    if (__DEV__) console.log(`[bookSearch] GB leg ${Date.now() - tGb0}ms (${books.length} results) [${looksLikePersonName ? 'author' : 'keyword'}]`);
    // For author queries, also fetch the keyword leg in parallel so we
    // don't miss collaborations / anthologies the inauthor: scope drops.
    if (looksLikePersonName) {
      const extra = await fetchGoogleBooks(searchQuery).catch(() => [] as BookResult[]);
      const seen  = new Set(books.map(b => _dedupKey(b.title, b.author_name?.[0])));
      for (const e of extra) {
        const k = _dedupKey(e.title, e.author_name?.[0]);
        if (!seen.has(k)) { seen.add(k); books.push(e); }
      }
    }
    return books;
  });

  const olFetches = variants.map(v => {
    const url = `https://openlibrary.org/search.json?${v.param}=${encodeURIComponent(v.q)}&fields=${OL_FIELDS}&limit=20`;
    const tOl0 = Date.now();
    return fetchWithTimeout(url)
      .then(r => {
        if (!r.ok) {
          console.warn('[bookSearch] OL variant returned', r.status, 'for', v.param, JSON.stringify(v.q));
          return { docs: [] as BookResult[] };
        }
        return r.json() as Promise<{ docs?: BookResult[] }>;
      })
      .then(json => {
        if (__DEV__) console.log(`[bookSearch] OL ${v.param}="${v.q}" ${Date.now() - tOl0}ms (${(json.docs ?? []).length} results)`);
        return json;
      })
      .catch(err => {
        console.warn('[bookSearch] OL variant failed:', (err as Error)?.message ?? err);
        return { docs: [] as BookResult[] };
      });
  });

  // Stream a partial result as soon as Google Books lands, so the UI can
  // render its first batch quickly. We don't fire onPartial when GB is empty
  // — that would produce a brief "No results" flicker before OL arrives.
  if (opts.onPartial) {
    gbPromise.then(gbBooks => {
      if (gbBooks.length === 0) return;
      const partialScored = scoreAndFilterBooks(searchQuery, gbBooks);
      opts.onPartial!({
        results:             partialScored.results,
        hasHigh:             partialScored.hasHigh,
        hasMedium:           partialScored.hasMedium,
        lastTokenIncomplete: lastTok.length <= 3,
        noResults:           false,
        weakQuery:           false,
      });
    }).catch(() => { /* GB errors logged inside fetchGoogleBooks */ });
  }

  // Author-entity typo fallback fires in parallel — only adds latency when
  // the person-name heuristic matches, and even then it's a single OL call
  // plus up to 2 catalog fetches (worst case ~600ms; usually 200–400ms and
  // overlapped with the much slower OL keyword variants).
  const authorEntityPromise: Promise<BookResult[]> = looksLikePersonName
    ? fetchOLByAuthorEntity(searchQuery)
    : Promise.resolve([]);

  const [gbBooks, authorEntityBooks, ...olResponses] = await Promise.all([
    gbPromise,
    authorEntityPromise,
    ...olFetches,
  ]);

  if (__DEV__) console.log(`[bookSearch] full pipeline ${Date.now() - t0}ms for ${JSON.stringify(rawQuery)}`);

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

  // Prepend author-entity books (deduped) — they're the strongest possible
  // signal for a person-name query because OL's author index resolved the
  // name (typo-tolerantly) to a real author entity. Without this, "tara
  // french" returns only the academic Tara French + Tara Duncan books,
  // even though the user clearly meant "Tana French". The standard scorer
  // can't help here: it requires exact author_name token match, which a
  // typo defeats by definition.
  let finalResults = scored.results;
  let finalHasHigh = scored.hasHigh;
  let finalHasMedium = scored.hasMedium;
  if (authorEntityBooks.length > 0) {
    const seen = new Set(scored.results.map(b => _dedupKey(b.title, b.author_name?.[0])));
    const fresh: BookResult[] = [];
    for (const b of authorEntityBooks) {
      const k = _dedupKey(b.title, b.author_name?.[0]);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(b);
    }
    if (fresh.length > 0) {
      finalResults = [...fresh, ...scored.results];
      finalHasHigh = true;
      finalHasMedium = true;
    }
  }

  if (finalHasHigh || (finalHasMedium && !lastTokenIncomplete)) {
    const mainResult: SearchBooksResult = {
      results: finalResults,
      hasHigh: finalHasHigh,
      hasMedium: finalHasMedium,
      lastTokenIncomplete,
      noResults: false,
      weakQuery: false,
    };
    setCached(rawQuery, mainResult);
    return mainResult;
  }

  // ── Final-token completion fallback ──────────────────────────────────────────
  // When the primary pipeline finds no HIGH results AND the last token looks like
  // an incomplete partial word (2–4 chars), expand it via word completion and
  // retry OL title queries with each candidate.
  //
  // Example: "burn the boa" → Datamuse("boa*") → ["boast","board","boat",...] →
  //   OL title="burn boat" → "Burn the Boats" → prefix-scores 900 HIGH ✅
  //
  // Trigger conditions (narrow, accuracy-safe):
  //   1. No HIGH results from primary pipeline
  //   2. lastTok is 2–4 chars (clearly partial)
  //   3. At least one strong head token exists (sigForReduced ≥ 1)
  //      so we have a meaningful OL query anchor beyond the partial word

  const canTryCompletion =
    !scored.hasHigh &&
    lastTok.length >= 2 &&
    lastTok.length <= 4 &&
    sigForReduced.length >= 1;

  if (canTryCompletion) {
    const completions = await fetchCompletions(lastTok);

    if (completions.length > 0) {
      const headSig = sigForReduced.join(' ');

      const completionFetches = completions.map(word => {
        const q = `${headSig} ${word}`;
        const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}&fields=${OL_FIELDS}&limit=10`;
        // Use the same 6s timeout wrapper as the primary OL leg so a single
        // slow completion variant cannot stall the whole fallback Promise.all.
        return fetchWithTimeout(url)
          .then(r => r.json() as Promise<{ docs?: BookResult[] }>)
          .catch(err => {
            console.warn(`[bookSearch] OL completion fetch failed for "${q}":`, err);
            return { docs: [] as BookResult[] };
          });
      });

      const completionResponses = await Promise.all(completionFetches);

      let completionBooks: BookResult[] = [];
      for (const resp of completionResponses) {
        completionBooks = mergeBookResults(completionBooks, (resp as { docs?: BookResult[] }).docs ?? []);
      }

      if (completionBooks.length > 0) {
        const completionScored = scoreAndFilterBooks(searchQuery, completionBooks);

        if (completionScored.hasHigh) {
          const completionResult: SearchBooksResult = {
            results: completionScored.results,
            hasHigh: true,
            hasMedium: completionScored.hasMedium,
            lastTokenIncomplete,
            noResults: false,
            weakQuery: false,
          };
          setCached(rawQuery, completionResult);
          return completionResult;
        }
      }
    }
  }

  const isDefinitiveQuery = tokens.length >= 2 || searchQuery.trim().length >= 8;
  return {
    ...empty,
    lastTokenIncomplete,
    noResults: isDefinitiveQuery,
    weakQuery: !isDefinitiveQuery,
  };
}
