// =============================================================================
// Recommender — candidate retrieval + scoring + ranking
//
// ── Architecture ─────────────────────────────────────────────────────────────
//
//  Candidate retrieval (getCandidateBooks):
//
//    Source A — Catalog (local DB, 'catalog')
//      Books in the shared `books` table that pass the eligibility filter:
//        subjects present  → OL-classified book
//        description > 30c → enriched via book detail page
//        isbn present      → Goodreads-imported published book
//      Bare recommendation-send entries (title+author+cover only) are
//      automatically excluded — they have none of the three signals.
//
//    Source B — Cached external ('cached_external')
//      Rows in `rec_candidate_cache` for this user, written from previous
//      OL fetches. Used when cache is fresh (< CACHE_TTL_MS).
//      Avoids hitting the OL API on every hub load.
//
//    Source C — Live Open Library ('open_library')
//      Live OL subject-search guided by the user's top genre affinities.
//      Only fires when cache is empty or stale. Results are immediately
//      persisted to `rec_candidate_cache` for next time.
//
//  Ranking (getRankedRecs):
//    1. Score every candidate against the user's taste profile
//    2. Quality gate: return { recs: [], quality_gate: '...' } if pool is
//       too small or no book scores above the minimum threshold
//    3. Sort by score, apply genre diversity cap (max 2 per primary genre)
//    4. Return up to `limit` books with full debug metadata
//
// ── Source tracing ────────────────────────────────────────────────────────────
//
//  Every CandidateBook carries:
//    _source            — 'catalog' | 'cached_external' | 'open_library'
//    _retrieval_reason  — e.g. 'local:eligible', 'ol:genre:thriller_mystery'
//
//  Every ScoredBook additionally carries:
//    score / confidence / reasons / risks — scoring explanation
//    _debug.pool_size  — total candidates before ranking
//    _debug.rank       — 1-based rank within the scored pool
//
//  RankedRecsResult.meta exposes aggregate pipeline stats:
//    sources_used, catalog_count, cached_external_count, live_ol_count,
//    pool_size, quality_gate
//
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TasteProfile }  from './tasteProfile';
import { getBookTraits }       from './bookTraits';
import type { FeedbackContext } from './recFeedback';

// ── Quality gate constants ─────────────────────────────────────────────────────

const MIN_CANDIDATES    = 5;    // Below this the pool is considered insufficient
const MIN_PASS_SCORE    = 0.12; // A book must score at least this to count as passing
const MIN_PASSING_BOOKS = 2;    // At least this many books must pass MIN_PASS_SCORE

// ── Cache constants ────────────────────────────────────────────────────────────

const CACHE_TTL_MS      = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MIN_ROWS    = 5;    // If we have at least this many fresh rows, skip OL

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateSource = 'catalog' | 'cached_external' | 'open_library';

export type CandidateBook = {
  id:                 string;   // DB UUID for catalog, 'ol:<key>' for OL sources
  title:              string;
  author:             string;
  cover_url:          string | null;
  external_id:        string | null;  // Open Library /works/OL... key
  subjects:           string[] | null;
  page_count:         number | null;
  description:        string | null;
  // ── Retrieval provenance ───────────────────────────────────────────────────
  _source:            CandidateSource;
  _retrieval_reason:  string;     // e.g. 'local:eligible', 'ol:genre:mystery'
};

export type ScoredBook = CandidateBook & {
  score:      number;
  confidence: 'low' | 'medium' | 'high';
  reasons:    string[];
  risks:      string[];
  // ── Ranking provenance ─────────────────────────────────────────────────────
  _debug: {
    pool_size: number;   // total candidates before ranking
    rank:      number;   // 1-based rank within the scored pool
  };
};

export type QualityGate =
  | 'passed'
  | 'insufficient_pool'    // fewer than MIN_CANDIDATES candidates total
  | 'insufficient_score';  // pool exists but no book clears MIN_PASS_SCORE

export type RankedRecsResult = {
  recs: ScoredBook[];
  meta: {
    pool_size:              number;
    sources_used:           CandidateSource[];
    catalog_count:          number;
    cached_external_count:  number;
    live_ol_count:          number;
    quality_gate:           QualityGate;
  };
};

// ── Fit label helpers (used by the UI) ────────────────────────────────────────

export function fitLabel(score: number): string {
  if (score > 0.50) return 'Strong fit';
  if (score > 0.28) return 'Good match';
  return 'Worth exploring';
}

export function fitColor(score: number): string {
  if (score > 0.50) return '#16a34a';
  if (score > 0.28) return '#2563eb';
  return '#78716c';
}

// ── Genre → Open Library subject mapping ──────────────────────────────────────
// Two OL subjects per genre for broader coverage.

const GENRE_OL_SUBJECTS: Record<string, [string, string]> = {
  fantasy_scifi:    ['fantasy',          'science fiction'],
  thriller_mystery: ['mystery',          'thriller'],
  romance:          ['romance',          'love stories'],
  horror:           ['horror',           'ghost stories'],
  memoir_bio:       ['biography',        'autobiography'],
  nonfiction:       ['nonfiction',       'self-help'],
  literary:         ['literary fiction', 'fiction'],
  general:          ['fiction',          'contemporary fiction'],
};

// ── OL subject fetcher ────────────────────────────────────────────────────────
// Returns [] on any error or slow response (3s timeout).

type OLDoc = {
  key?:                     string;
  title?:                   string;
  author_name?:             string[];
  cover_i?:                 number;
  number_of_pages_median?:  number;
  subject?:                 string[];
};

async function fetchOLSubject(
  subject: string,
  limit = 20,
  retrieval_reason: string,
): Promise<CandidateBook[]> {
  try {
    const url =
      `https://openlibrary.org/search.json` +
      `?subject=${encodeURIComponent(subject)}` +
      `&fields=key,title,author_name,cover_i,number_of_pages_median,subject` +
      `&limit=${limit}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const json = await res.json() as { docs?: OLDoc[] };

    return (json.docs ?? [])
      .filter(doc => doc.key && doc.title)
      .map((doc): CandidateBook => ({
        id:                `ol:${doc.key}`,
        title:             doc.title ?? '',
        author:            doc.author_name?.[0] ?? 'Unknown author',
        cover_url:         doc.cover_i
                             ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
                             : null,
        external_id:       doc.key ?? null,
        subjects:          doc.subject?.slice(0, 20) ?? null,
        page_count:        typeof doc.number_of_pages_median === 'number'
                             ? doc.number_of_pages_median
                             : null,
        description:       null,
        _source:           'open_library',
        _retrieval_reason: retrieval_reason,
      }));
  } catch {
    return [];
  }
}

// ── Source A: Catalog (local DB, eligibility-filtered) ────────────────────────
// Returns eligibility-filtered catalog books + the user's existing ID sets.

type LocalResult = {
  candidates:      CandidateBook[];
  readIds:         Set<string>;    // DB UUIDs
  readExternalIds: Set<string>;    // OL /works/OL... keys
};

async function getLocalCandidates(
  client: SupabaseClient,
  userId: string,
): Promise<LocalResult> {
  const { data: userBooks } = await client
    .from('user_books')
    .select('book_id, book:books(external_id)')
    .eq('user_id', userId);

  type UBRow = { book_id: string; book: { external_id: string | null } | null };
  const ubRows = (userBooks ?? []) as UBRow[];

  const readIds         = new Set(ubRows.map(r => r.book_id));
  const readExternalIds = new Set(
    ubRows.map(r => r.book?.external_id).filter((x): x is string => !!x)
  );

  const { data: dbBooks } = await client
    .from('books')
    .select('id, title, author, cover_url, external_id, subjects, page_count, description, isbn')
    .or('subjects.not.is.null,description.not.is.null,isbn.not.is.null')
    .limit(120);

  type DBBook = {
    id: string; title: string; author: string; cover_url: string | null;
    external_id: string | null; subjects: string[] | null; page_count: number | null;
    description: string | null; isbn: string | null;
  };

  const candidates: CandidateBook[] = ((dbBooks ?? []) as DBBook[])
    .filter(b => !readIds.has(b.id))
    .filter(b => {
      if (b.subjects && b.subjects.length > 0) return true;
      if (b.description && b.description.trim().length > 30) return true;
      if (b.isbn) return true;
      return false;
    })
    .map((b): CandidateBook => ({
      id:                b.id,
      title:             b.title,
      author:            b.author,
      cover_url:         b.cover_url,
      external_id:       b.external_id,
      subjects:          b.subjects,
      page_count:        b.page_count,
      description:       b.description,
      _source:           'catalog',
      _retrieval_reason: 'local:eligible',
    }));

  return { candidates, readIds, readExternalIds };
}

// ── Source B: Cached external (rec_candidate_cache) ───────────────────────────
// Reads fresh (< CACHE_TTL_MS) rows for this user.
// Returns null if table is missing (migration not yet applied) — fails silently.

type CacheResult = {
  candidates: CandidateBook[];
  isFresh:    boolean;   // true when enough fresh rows exist to skip OL
} | null;

async function getCachedExternalCandidates(
  client: SupabaseClient,
  userId: string,
  excludeExternalIds: Set<string>,
): Promise<CacheResult> {
  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    const { data, error } = await client
      .from('rec_candidate_cache')
      .select('external_id, source, retrieval_reason, title, author, cover_url, subjects, page_count')
      .eq('user_id', userId)
      .gte('cached_at', cutoff)
      .order('cached_at', { ascending: false })
      .limit(80);

    if (error) return null;   // table not yet created — skip gracefully

    type CacheRow = {
      external_id:      string;
      source:           string;
      retrieval_reason: string | null;
      title:            string;
      author:           string | null;
      cover_url:        string | null;
      subjects:         string[] | null;
      page_count:       number | null;
    };

    const rows = (data ?? []) as CacheRow[];
    const isFresh = rows.length >= CACHE_MIN_ROWS;

    const candidates: CandidateBook[] = rows
      .filter(r => !excludeExternalIds.has(r.external_id))
      .map((r): CandidateBook => ({
        id:                `ol:${r.external_id}`,
        title:             r.title,
        author:            r.author ?? 'Unknown author',
        cover_url:         r.cover_url,
        external_id:       r.external_id,
        subjects:          r.subjects,
        page_count:        r.page_count,
        description:       null,
        _source:           'cached_external',
        _retrieval_reason: r.retrieval_reason ?? 'cache:restored',
      }));

    return { candidates, isFresh };
  } catch {
    return null;
  }
}

// ── Source C: Live OL retrieval ───────────────────────────────────────────────
// Guided by the user's genre affinities.

async function getOLCandidates(
  profile: TasteProfile,
  readExternalIds: Set<string>,
  excludeExternalIds: Set<string>,
): Promise<CandidateBook[]> {
  const affinities = profile.genre_affinities ?? {};

  let likedGenres = Object.entries(affinities)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([genre]) => genre)
    .slice(0, 2);

  if (likedGenres.length === 0) {
    const pref = profile.preferred_traits;
    if ((pref['Insight'] ?? 0) + (pref['Evidence'] ?? 0) > 0.4)  likedGenres = ['nonfiction', 'memoir_bio'];
    else if ((pref['Suspense'] ?? 0) + (pref['Pacing'] ?? 0) > 0.5) likedGenres = ['thriller_mystery'];
    else if ((pref['Worldbuilding'] ?? 0) > 0.4)                  likedGenres = ['fantasy_scifi'];
    else                                                           likedGenres = ['literary'];
  }

  const toFetch: Array<{ subject: string; reason: string }> = [];
  for (const genre of likedGenres) {
    const [s1, s2] = GENRE_OL_SUBJECTS[genre] ?? ['fiction', 'general fiction'];
    const reason   = `ol:genre:${genre}`;
    if (toFetch.length < 4) toFetch.push({ subject: s1, reason });
    if (toFetch.length < 4) toFetch.push({ subject: s2, reason });
    if (toFetch.length >= 4) break;
  }

  const resultSets = await Promise.all(
    toFetch.map(({ subject, reason }) => fetchOLSubject(subject, 20, reason))
  );

  const exclude = new Set([...readExternalIds, ...excludeExternalIds]);
  const seen    = new Set<string>();
  const merged: CandidateBook[] = [];

  for (const set of resultSets) {
    for (const book of set) {
      const key = book.external_id ?? book.id;
      if (seen.has(key) || exclude.has(key)) continue;
      seen.add(key);
      merged.push(book);
    }
  }

  return merged;
}

// ── Cache write: persist OL results for this user ─────────────────────────────
// Upserts on (user_id, external_id) — refreshes cached_at on repeat fetch.
// Fails silently if the table doesn't exist yet.

async function persistOLCandidates(
  client: SupabaseClient,
  userId: string,
  books: CandidateBook[],
): Promise<void> {
  if (books.length === 0) return;
  try {
    const rows = books
      .filter(b => b.external_id)
      .map(b => ({
        user_id:          userId,
        external_id:      b.external_id!,
        source:           b._source,
        retrieval_reason: b._retrieval_reason,
        title:            b.title,
        author:           b.author,
        cover_url:        b.cover_url,
        subjects:         b.subjects,
        page_count:       b.page_count,
        cached_at:        new Date().toISOString(),
      }));

    await client
      .from('rec_candidate_cache')
      .upsert(rows, { onConflict: 'user_id,external_id', ignoreDuplicates: false });
  } catch {
    // Cache write is best-effort; failure does not affect the current session
  }
}

// ── Combined retrieval ────────────────────────────────────────────────────────
// Returns merged candidates from all three sources.

export async function getCandidateBooks(
  client:    SupabaseClient,
  userId:    string,
  profile:   TasteProfile,
  feedback?: FeedbackContext,
): Promise<CandidateBook[]> {
  // Source A: catalog (always run — single fast DB query)
  const local = await getLocalCandidates(client, userId);

  const catalogExternalIds = new Set(
    local.candidates.map(c => c.external_id).filter((x): x is string => !!x)
  );

  // Source B: check cache (skip OL fetch if fresh enough)
  const cacheResult = await getCachedExternalCandidates(
    client,
    userId,
    new Set([...local.readExternalIds, ...catalogExternalIds]),
  );

  let externalCandidates: CandidateBook[];

  if (cacheResult?.isFresh) {
    // Cache is warm — use cached external candidates, skip OL API
    externalCandidates = cacheResult.candidates;
  } else {
    // Source C: live OL fetch
    const excludeForOL = new Set([
      ...local.readExternalIds,
      ...catalogExternalIds,
      ...(cacheResult?.candidates.map(c => c.external_id).filter((x): x is string => !!x) ?? []),
    ]);

    const olLive = await getOLCandidates(profile, local.readExternalIds, excludeForOL);

    // Merge fresh OL results on top of any stale cache rows (for breadth)
    const stale = cacheResult?.candidates ?? [];
    const olExternalIds = new Set(olLive.map(b => b.external_id).filter((x): x is string => !!x));
    const nonDupStale   = stale.filter(b => !olExternalIds.has(b.external_id ?? ''));

    externalCandidates = [...olLive, ...nonDupStale];

    // Persist fresh OL results (best-effort, async)
    persistOLCandidates(client, userId, olLive).catch(() => {});
  }

  // External first — genre-matched books score better against subjects;
  // catalog books supplement with richer description/isbn metadata.
  const all = [...externalCandidates, ...local.candidates];

  // Filter out books the user has explicitly dismissed
  if (!feedback?.dismissedIds.size) return all;
  return all.filter(b => {
    if (b.external_id && feedback.dismissedIds.has(b.external_id)) return false;
    if (b._source === 'catalog'  && feedback.dismissedIds.has(b.id))          return false;
    return true;
  });
}

// ── Scoring (pure) ────────────────────────────────────────────────────────────

export function scoreBookForUser(
  book:     CandidateBook,
  profile:  TasteProfile,
  feedback?: FeedbackContext,
): Pick<ScoredBook, 'score' | 'confidence' | 'reasons' | 'risks'> {
  const bt         = getBookTraits(book);
  const pref       = profile.preferred_traits;
  const avoid      = profile.avoided_traits;
  const affinities = profile.genre_affinities ?? {};
  const reasons: string[] = [];
  const risks:   string[] = [];
  let score = 0;

  // 1. Preferred trait alignment
  const prefMatches: string[] = [];
  for (const [trait, userWeight] of Object.entries(pref)) {
    const bookWeight   = bt.traits[trait] ?? 0;
    const contribution = userWeight * bookWeight;
    if (contribution > 0.22) {
      prefMatches.push(trait.toLowerCase());
      score += contribution;
    }
  }
  if (prefMatches.length >= 2) {
    reasons.push(`Aligns with your preference for ${prefMatches.slice(0, 2).join(' and ')}`);
  } else if (prefMatches.length === 1) {
    reasons.push(`Matches your appreciation for ${prefMatches[0]}`);
  }

  // 2. Avoided trait penalties
  const avoidHits: string[] = [];
  for (const [trait, penalty] of Object.entries(avoid)) {
    const bookWeight   = bt.traits[trait] ?? 0;
    const contribution = penalty * bookWeight;
    if (contribution < -0.18) {
      avoidHits.push(trait.toLowerCase());
      score += contribution;
    }
  }
  if (avoidHits.length > 0) {
    risks.push(`Leans toward ${avoidHits[0]} — which hasn't worked well for you`);
  }

  // 3. Genre affinity bonus / penalty
  if (bt.primaryGenre) {
    const affinity = affinities[bt.primaryGenre] ?? 0;
    if (affinity > 0.5) {
      score += 0.28;
      if (reasons.length < 2) reasons.push(`Fits a genre you consistently enjoy`);
    } else if (affinity > 0.2) {
      score += 0.12;
    } else if (affinity < -0.35) {
      score -= 0.22;
      if (risks.length < 1) {
        const label = bt.primaryGenre.replace('_', '/');
        risks.push(`You've had mixed results with ${label} before`);
      }
    }
  }

  // 4. Feedback boosts from "More like this" signals
  // Each genre that was upvoted adds a deterministic bonus derived from signal count.
  // boost = 0.12 for first signal, +0.06 per additional, capped at 0.20.
  if (feedback && bt.primaryGenre) {
    const boost = feedback.genreBoosts[bt.primaryGenre] ?? 0;
    if (boost > 0) {
      score += boost;
      if (reasons.length < 2) {
        reasons.push(`Similar to books you asked for more of`);
      }
    }
  }

  const finalScore = Math.max(0, Math.min(1, score));

  let confidence: 'low' | 'medium' | 'high';
  if (profile.tier >= 3 && finalScore > 0.42)      confidence = 'high';
  else if (profile.tier >= 2 && finalScore > 0.22) confidence = 'medium';
  else                                              confidence = 'low';

  return {
    score:   +finalScore.toFixed(3),
    confidence,
    reasons: [...new Set(reasons)].slice(0, 2),
    risks:   [...new Set(risks)].slice(0, 1),
  };
}

// ── Ranked recs ───────────────────────────────────────────────────────────────
// Pure function — returns a RankedRecsResult with quality gate metadata.

export function getRankedRecs(
  candidates: CandidateBook[],
  profile:    TasteProfile,
  limit       = 5,
  feedback?:  FeedbackContext,
): RankedRecsResult {
  const poolSize = candidates.length;

  // ── Quality gate: pool size ───────────────────────────────────────────────
  if (poolSize < MIN_CANDIDATES) {
    return {
      recs: [],
      meta: buildMeta(candidates, poolSize, 'insufficient_pool'),
    };
  }

  const scored = candidates.map(book => ({
    ...book,
    ...scoreBookForUser(book, profile, feedback),
    _debug: { pool_size: poolSize, rank: 0 },
  }));

  scored.sort((a, b) => b.score - a.score);

  // ── Quality gate: score threshold ─────────────────────────────────────────
  const passing = scored.filter(b => b.score >= MIN_PASS_SCORE);
  if (passing.length < MIN_PASSING_BOOKS) {
    return {
      recs: [],
      meta: buildMeta(candidates, poolSize, 'insufficient_score'),
    };
  }

  // ── Diversity: max 2 books per primary genre ───────────────────────────────
  const genreCount: Record<string, number> = {};
  const diverse: ScoredBook[] = [];
  let globalRank = 0;

  for (const book of scored) {
    globalRank++;
    const genre = getBookTraits(book).primaryGenre ?? 'general';
    const count = genreCount[genre] ?? 0;
    if (count < 2) {
      diverse.push({ ...book, _debug: { pool_size: poolSize, rank: globalRank } });
      genreCount[genre] = count + 1;
    }
    if (diverse.length >= limit) break;
  }

  return {
    recs: diverse,
    meta: buildMeta(candidates, poolSize, 'passed'),
  };
}

function buildMeta(
  candidates: CandidateBook[],
  poolSize: number,
  quality_gate: QualityGate,
): RankedRecsResult['meta'] {
  const sourcesSet = new Set<CandidateSource>(candidates.map(c => c._source));
  return {
    pool_size:             poolSize,
    sources_used:          [...sourcesSet],
    catalog_count:         candidates.filter(c => c._source === 'catalog').length,
    cached_external_count: candidates.filter(c => c._source === 'cached_external').length,
    live_ol_count:         candidates.filter(c => c._source === 'open_library').length,
    quality_gate,
  };
}

// ── Convenience async wrapper ─────────────────────────────────────────────────

export async function getPersonalizedRecs(
  client:    SupabaseClient,
  userId:    string,
  profile:   TasteProfile,
  limit      = 5,
  feedback?: FeedbackContext,
): Promise<RankedRecsResult> {
  const candidates = await getCandidateBooks(client, userId, profile, feedback);
  return getRankedRecs(candidates, profile, limit, feedback);
}
