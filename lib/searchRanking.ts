/**
 * Local relevance re-ranking for Open Library book search results.
 *
 * Open Library returns results sorted by their own internal relevance (edition
 * count, popularity, etc.) which may surface books where the query appears in
 * description/subjects rather than the title. This module re-ranks on the
 * client side so that strong title matches always rise to the top.
 *
 * Priority (descending):
 *  1. Exact title match
 *  2. Title prefix match (title starts with query)
 *  3. Title contains full query as substring
 *  4. Strong token overlap in title (≥80% of query tokens appear in title)
 *  5. Moderate token overlap in title (≥50%)
 *  6. Combined title + author token overlap (≥50%)
 *  7. Any query token appears in title (fuzzy)
 *  8. Author-only token match
 *  9. Fallback / noise (keeps OL raw rank among equals)
 */

export type RankedBookResult = {
  score:     number;
  matchType: 'exact' | 'prefix' | 'substring' | 'strong_token' | 'moderate_token' | 'title_author' | 'fuzzy' | 'author_only' | 'fallback';
  rawRank:   number;
};

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Lowercase, strip punctuation, collapse whitespace. Apostrophes and dashes
 * become nothing / space respectively so "don't" → "dont", "well-known" →
 * "well known".
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/['''\u2018\u2019\u201B]/g, '')
    .replace(/[-\u2013\u2014\u2012]/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Scoring ───────────────────────────────────────────────────────────────────

const MIN_TOKEN_LEN = 2;

export function scoreBookResult(
  rawQuery: string,
  title: string,
  authors: string[],
): RankedBookResult {
  const nq    = normalizeText(rawQuery);
  const ntitle = normalizeText(title);
  const nauthor = normalizeText(authors.join(' '));

  const qTokens      = nq.split(' ').filter(t => t.length >= MIN_TOKEN_LEN);
  const titleTokenSet = new Set(ntitle.split(' ').filter(t => t.length >= MIN_TOKEN_LEN));
  const authorTokenSet = new Set(nauthor.split(' ').filter(t => t.length >= MIN_TOKEN_LEN));

  if (qTokens.length === 0) {
    return { score: 500, matchType: 'fallback', rawRank: 0 };
  }

  // ── 1. Exact title match ───────────────────────────────────────────────────
  if (ntitle === nq) {
    return { score: 1000, matchType: 'exact', rawRank: 0 };
  }

  // ── 2. Title starts with full query (prefix) ──────────────────────────────
  if (ntitle.startsWith(nq) && nq.length >= 3) {
    return { score: 900, matchType: 'prefix', rawRank: 0 };
  }

  // ── 3. Title contains full query as a contiguous substring ────────────────
  if (nq.length >= 4 && ntitle.includes(nq)) {
    return { score: 850, matchType: 'substring', rawRank: 0 };
  }

  // ── 4 & 5. Token overlap in title ─────────────────────────────────────────
  const titleHits   = qTokens.filter(t => titleTokenSet.has(t)).length;
  const titleOverlap = titleHits / qTokens.length;

  if (titleOverlap >= 0.8) {
    return { score: 700 + Math.round(titleOverlap * 99), matchType: 'strong_token', rawRank: 0 };
  }
  if (titleOverlap >= 0.5) {
    return { score: 600 + Math.round(titleOverlap * 99), matchType: 'moderate_token', rawRank: 0 };
  }

  // ── 6. Combined title + author token overlap ───────────────────────────────
  const authorHits      = qTokens.filter(t => authorTokenSet.has(t)).length;
  const combinedOverlap = (titleHits + authorHits) / qTokens.length;
  if (combinedOverlap >= 0.5) {
    return { score: 500 + Math.round(combinedOverlap * 99), matchType: 'title_author', rawRank: 0 };
  }

  // ── 7. Fuzzy: any query token appears anywhere in title ───────────────────
  const anyTitleHit = qTokens.some(t => ntitle.includes(t));
  if (anyTitleHit) {
    return { score: 400 + titleHits * 20, matchType: 'fuzzy', rawRank: 0 };
  }

  // ── 8. Author-only token match ────────────────────────────────────────────
  if (authorHits > 0) {
    return { score: 200 + authorHits * 20, matchType: 'author_only', rawRank: 0 };
  }

  // ── 9. Fallback — title is noise relative to query ────────────────────────
  return { score: 50, matchType: 'fallback', rawRank: 0 };
}

// ── Public ranking API ────────────────────────────────────────────────────────

export type BookResultLike = {
  title?: string;
  author_name?: string[];
};

/**
 * Re-rank an array of Open Library book results by local relevance score.
 * Ties within the same score are broken by original (upstream) rank so OL's
 * ordering is preserved among equally-matched books.
 *
 * In development, logs each result's rank, score, and match type to the console.
 */
export function rankBookResults<T extends BookResultLike>(
  query: string,
  books: T[],
): T[] {
  if (books.length === 0) return books;

  const scored = books.map((book, rawRank) => {
    const result = scoreBookResult(
      query,
      book.title ?? '',
      book.author_name ?? [],
    );
    return { book, rawRank, score: result.score, matchType: result.matchType };
  });

  scored.sort((a, b) => b.score - a.score || a.rawRank - b.rawRank);

  if (__DEV__) {
    console.log(
      '[SEARCH_RANK]',
      `query="${query}"`,
      scored.slice(0, 5).map(s => ({
        title:     s.book.title,
        rawRank:   s.rawRank,
        score:     s.score,
        matchType: s.matchType,
      })),
    );
  }

  return scored.map(s => s.book);
}
