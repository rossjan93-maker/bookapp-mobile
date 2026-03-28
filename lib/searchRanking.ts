/**
 * Confidence-based scoring and filtering for Open Library book search results.
 *
 * Core principle: "correct book or nothing". Never surface a result just
 * because it is vaguely related. Every visible result must pass a minimum
 * confidence threshold.
 *
 * Confidence levels:
 *   HIGH   (score ≥ 700) — safe to show; strong title match
 *   MEDIUM (score ≥ 500) — fallback candidates when no HIGH results exist
 *   LOW    (score < 500) — never shown; these are the garbage results
 *
 * Retrieval flow (handled by caller):
 *   1. title=<query>  → score → if no HIGH results:
 *   2. q=<query>      → merge with step-1 results → rescore
 *   3. if no HIGH/MEDIUM → show empty state
 *
 * Scoring priority:
 *   1000  exact title match
 *    990  near-exact (title minus leading article = query)
 *    900  title starts with full query (prefix)
 *    890  near-prefix (article-stripped title starts with query)
 *    875  last-token prefix: all head tokens match + last token prefixes a title word
 *    850  title contains query as contiguous substring
 *    840  near-substring (article-stripped)
 *   700–799 strong token overlap (≥80% of query tokens in title)
 *   640–670 last-token prefix: partial head match (≥50%)
 *   600–699 moderate token overlap (≥50%)
 *   500–599 combined title+author token overlap (≥50%)
 *   400+   fuzzy (any query token appears in title)          — LOW, never shown
 *   200+   author-only match                                 — LOW, never shown
 *    50    fallback / noise                                   — LOW, never shown
 */

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export type MatchType =
  | 'exact'
  | 'near_exact'
  | 'prefix'
  | 'near_prefix'
  | 'substring'
  | 'near_substring'
  | 'last_token_prefix'
  | 'strong_token'
  | 'moderate_token'
  | 'title_author'
  | 'fuzzy'
  | 'author_only'
  | 'fallback';

export type BookScore = {
  score:      number;
  confidence: ConfidenceLevel;
  matchType:  MatchType;
  rawRank:    number;
};

const HIGH_THRESHOLD = 700;
const MED_THRESHOLD  = 500;
const MIN_TOKEN_LEN  = 2;

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Lowercase, strip punctuation, collapse whitespace. Apostrophes → removed,
 * dashes → space, so "don't" → "dont" and "well-known" → "well known".
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

function confidence(score: number): ConfidenceLevel {
  if (score >= HIGH_THRESHOLD) return 'HIGH';
  if (score >= MED_THRESHOLD)  return 'MEDIUM';
  return 'LOW';
}

// ── Core scorer ───────────────────────────────────────────────────────────────

export function scoreBookResult(
  rawQuery: string,
  title:    string,
  authors:  string[],
): BookScore {
  const nq      = normalizeText(rawQuery);
  const ntitle  = normalizeText(title);
  const nauthor = normalizeText(authors.join(' '));

  // Article-stripped title for near-* checks ("The Silent Patient" → "silent patient")
  const ntitleNoArticle = ntitle.replace(/^(the|an?)\s+/, '');

  const qTokens        = nq.split(' ').filter(t => t.length >= MIN_TOKEN_LEN);
  const titleTokenArr  = ntitle.split(' ').filter(t => t.length >= MIN_TOKEN_LEN);
  const titleTokenSet  = new Set(titleTokenArr);
  const authorTokenSet = new Set(nauthor.split(' ').filter(t => t.length >= MIN_TOKEN_LEN));

  const mk = (score: number, matchType: MatchType): BookScore =>
    ({ score, confidence: confidence(score), matchType, rawRank: 0 });

  if (qTokens.length === 0) return mk(50, 'fallback');

  // ── 1. Exact title match ──────────────────────────────────────────────────
  if (ntitle === nq)                                          return mk(1000, 'exact');

  // ── 1b. Near-exact (article-stripped equals query) ────────────────────────
  if (ntitleNoArticle !== ntitle && ntitleNoArticle === nq)   return mk(990, 'near_exact');

  // ── 2. Title starts with full query (prefix) ──────────────────────────────
  if (ntitle.startsWith(nq) && nq.length >= 3)               return mk(900, 'prefix');

  // ── 2b. Near-prefix (article-stripped) ────────────────────────────────────
  if (ntitleNoArticle !== ntitle &&
      ntitleNoArticle.startsWith(nq) && nq.length >= 3)       return mk(890, 'near_prefix');

  // ── 3. Last-token prefix (incomplete typing like "burn the boa" → "burn the boats")
  //       Treat the final query token as a prefix of a title word.
  //       All head tokens (everything before the last) must be in the title.
  //
  //       Require lastToken.length >= 3 to avoid stop-words ("of", "in", "to")
  //       triggering prefix matches on unrelated long titles.
  if (qTokens.length >= 2) {
    const headTokens = qTokens.slice(0, -1);
    const lastToken  = qTokens[qTokens.length - 1];

    if (lastToken.length >= 3) {
      const lastPrefixHit = titleTokenArr.some(t => t.startsWith(lastToken));

      if (lastPrefixHit) {
        const headHits    = headTokens.filter(t => titleTokenSet.has(t)).length;
        const headOverlap = headHits / headTokens.length;

        if (headOverlap >= 1.0) {
          // All head tokens present + last token prefixes a title word → HIGH
          return mk(875, 'last_token_prefix');
        }
        if (headOverlap >= 0.5) {
          // Partial head match + last prefix → upper MEDIUM
          return mk(640 + Math.round(headOverlap * 60), 'last_token_prefix');
        }
      }
    }
  }

  // ── 4. Title contains full query as contiguous substring ──────────────────
  if (nq.length >= 4 && ntitle.includes(nq))                 return mk(850, 'substring');

  // ── 4b. Near-substring (article-stripped) ─────────────────────────────────
  if (nq.length >= 4 &&
      ntitleNoArticle !== ntitle &&
      ntitleNoArticle.includes(nq))                           return mk(840, 'near_substring');

  // ── 5. Token overlap in title ─────────────────────────────────────────────
  const titleHits    = qTokens.filter(t => titleTokenSet.has(t)).length;
  const titleOverlap = titleHits / qTokens.length;

  // Title-length penalty: if the title has >4× more meaningful tokens than the
  // query (e.g. a 20-token academic title matched against a 3-token query),
  // the match is coincidental. Cap such matches to upper MEDIUM (649) so they
  // never surface as HIGH and push the real result off the top spot.
  const titleTooLong = titleTokenArr.length > qTokens.length * 4;

  if (titleOverlap >= 0.8) {
    const base = 700 + Math.round(titleOverlap * 99);
    return titleTooLong ? mk(Math.min(base, 649), 'moderate_token') : mk(base, 'strong_token');
  }
  if (titleOverlap >= 0.5) return mk(600 + Math.round(titleOverlap * 99), 'moderate_token');

  // ── 6. Combined title + author token overlap ───────────────────────────────
  const authorHits      = qTokens.filter(t => authorTokenSet.has(t)).length;
  const combinedOverlap = (titleHits + authorHits) / qTokens.length;
  if (combinedOverlap >= 0.5) return mk(500 + Math.round(combinedOverlap * 99), 'title_author');

  // ── 7. Fuzzy — any query token in title (LOW) ─────────────────────────────
  const anyTitleHit = qTokens.some(t => ntitle.includes(t));
  if (anyTitleHit)    return mk(400 + titleHits * 20, 'fuzzy');

  // ── 8. Author-only match (LOW) ────────────────────────────────────────────
  if (authorHits > 0) return mk(200 + authorHits * 20, 'author_only');

  // ── 9. Fallback / noise (LOW) ─────────────────────────────────────────────
  return mk(50, 'fallback');
}

// ── Public API ────────────────────────────────────────────────────────────────

export type BookResultLike = {
  key?:         string;
  title?:       string;
  author_name?: string[];
};

export type FilterResult<T> = {
  results:   T[];
  hasHigh:   boolean;
  hasMedium: boolean;
  topScores: Array<{
    title:      string;
    score:      number;
    confidence: ConfidenceLevel;
    matchType:  MatchType;
    rawRank:    number;
  }>;
};

/**
 * Score every book, apply confidence filtering, and return only results that
 * meet the quality bar.
 *
 * If HIGH-confidence results exist, show those + any MEDIUM results below them.
 * If no HIGH results, show MEDIUM only.
 * If neither, return an empty list (caller should show "no strong matches").
 */
export function scoreAndFilterBooks<T extends BookResultLike>(
  query: string,
  books: T[],
): FilterResult<T> {
  const scored = books.map((book, rawRank) => {
    const s = scoreBookResult(query, book.title ?? '', book.author_name ?? []);
    return { book, rawRank, score: s.score, confidence: s.confidence, matchType: s.matchType };
  });

  scored.sort((a, b) => b.score - a.score || a.rawRank - b.rawRank);

  const high = scored.filter(s => s.confidence === 'HIGH');
  const med  = scored.filter(s => s.confidence === 'MEDIUM');

  const hasHigh   = high.length > 0;
  const hasMedium = med.length > 0;

  // "HIGH or nothing, then MEDIUM as fallback" — never mix the two tiers.
  // When HIGH results exist, show only those; MEDIUM results would pad out the
  // list with near-misses that dilute confidence in the top result.
  const results: T[] = hasHigh
    ? high.map(s => s.book)
    : hasMedium
      ? med.map(s => s.book)
      : [];

  return {
    results,
    hasHigh,
    hasMedium,
    topScores: scored.slice(0, 5).map(s => ({
      title:      s.book.title ?? '',
      score:      s.score,
      confidence: s.confidence,
      matchType:  s.matchType,
      rawRank:    s.rawRank,
    })),
  };
}

/**
 * Merge two raw result arrays, deduplicating by key. Primary list takes
 * precedence over fallback for any matching key.
 */
export function mergeBookResults<T extends BookResultLike>(
  primary:  T[],
  fallback: T[],
): T[] {
  const seen = new Set(primary.map(b => b.key ?? '').filter(Boolean));
  return [...primary, ...fallback.filter(b => b.key && !seen.has(b.key))];
}

// Kept for backward compatibility (used by abbreviation-query path in search.tsx)
export function rankBookResults<T extends BookResultLike>(query: string, books: T[]): T[] {
  const { results } = scoreAndFilterBooks(query, books);
  return results;
}
