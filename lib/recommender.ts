// =============================================================================
// Recommender — candidate retrieval + hygiene + scoring + ranking
//
// ── Architecture ─────────────────────────────────────────────────────────────
//
//  1. Candidate retrieval  (getCandidateBooks)
//     Source A — Catalog          local DB, eligibility-filtered
//     Source B — Cached external  rec_candidate_cache (< CACHE_TTL_MS)
//     Source C — Live OL          multi-anchor strategy (see §Retrieval)
//
//  2. Candidate hygiene    (applyHygiene)
//     — exclude children's / juvenile books
//     — exclude known public-domain classic authors
//     — exclude weak-metadata books (no subjects, no description, no isbn)
//     — language de-prioritisation via enrichment (if available)
//
//  3. Scoring              (scoreBookForUser)
//     Step 1  preferred-trait alignment
//     Step 2  avoided-trait penalties
//     Step 3  genre-affinity bonus / penalty
//     Step 4  feedback boosts (More-Like-This genre upvotes)
//     Step 5  enrichment signals (popularity quality + consensus-trait match)
//
//  4. Ranking              (getRankedRecs)
//     — quality gate (pool size + min passing score)
//     — genre-diversity cap (max 2 per primary genre)
//     — up to `limit` results with full provenance
//
// ── Retrieval strategy ────────────────────────────────────────────────────────
//
//  OL queries are built from THREE anchor types:
//   • Genre anchors   — top 3 genre affinities → specific OL subject terms
//   • Subject anchors — top 3 recurring subjects from the user's 4–5 star books
//   • Author anchor   — top liked author (OL author search, 1 query)
//
//  This replaces the previous single-genre bucket approach, which produced
//  generic / public-domain / classic drift (Oz, Narnia, Grimm, etc.).
//
// ── Retrieval trace ───────────────────────────────────────────────────────────
//
//  Every CandidateResult carries a RetrievalTrace showing:
//    top_genres_used      which genre affinities drove retrieval
//    top_traits_used      strongest preferred traits
//    liked_subjects_used  subject anchors from 4–5★ books
//    liked_authors_used   author anchor(s) used
//    ol_queries           exact OL subject/author query strings
//    hygiene_excluded     count of candidates removed by hygiene
//    enriched_count       candidates enriched from cache + live GB
//
// =============================================================================

import type { SupabaseClient }       from '@supabase/supabase-js';
import type { TasteProfile }         from './tasteProfile';
import { getBookTraits }             from './bookTraits';
import type { FeedbackContext }      from './recFeedback';
import type { BookEnrichmentProfile } from './bookEnrichment';
import { getEnrichmentForCandidates } from './bookEnrichment';

// ── Quality gate constants ─────────────────────────────────────────────────────

const MIN_CANDIDATES    = 5;
const MIN_PASS_SCORE    = 0.12;
const MIN_PASSING_BOOKS = 2;

// ── Cache constants ────────────────────────────────────────────────────────────

const CACHE_TTL_MS   = 24 * 60 * 60 * 1000;
const CACHE_MIN_ROWS = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateSource = 'catalog' | 'cached_external' | 'open_library';

export type CandidateBook = {
  id:                 string;
  title:              string;
  author:             string;
  cover_url:          string | null;
  external_id:        string | null;
  subjects:           string[] | null;
  page_count:         number | null;
  description:        string | null;
  _source:            CandidateSource;
  _retrieval_reason:  string;
};

export type ScoreBreakdown = {
  trait_alignment:  number;   // step 1 — preferred trait match contribution
  avoided_penalty:  number;   // step 2 — avoided trait penalties (negative)
  genre_bonus:      number;   // step 3 — genre affinity bonus/penalty
  feedback_boost:   number;   // step 4 — More-Like-This genre boost
  enrichment_bonus: number;   // step 5 — consensus trait + popularity signal
  final_score:      number;   // clamped 0–1 total
};

export type ScoredBook = CandidateBook & {
  score:      number;
  confidence: 'low' | 'medium' | 'high';
  reasons:    string[];
  risks:      string[];
  _score_breakdown: ScoreBreakdown;
  _debug: {
    pool_size: number;
    rank:      number;
  };
};

export type QualityGate =
  | 'passed'
  | 'insufficient_pool'
  | 'insufficient_score';

export type RetrievalTrace = {
  top_genres_used:      string[];
  top_traits_used:      string[];
  liked_subjects_used:  string[];
  liked_authors_used:   string[];
  ol_queries:           string[];
  hygiene_excluded:     number;
  enriched_count:       number;
};

export type RankedRecsResult = {
  recs: ScoredBook[];
  meta: {
    pool_size:              number;
    sources_used:           CandidateSource[];
    catalog_count:          number;
    cached_external_count:  number;
    live_ol_count:          number;
    quality_gate:           QualityGate;
    hygiene_excluded:       number;
    enriched_count:         number;
    retrieval_trace:        RetrievalTrace;
  };
};

// CandidateResult — returned by getCandidateBooks; replaces the old plain array.
export type CandidateResult = {
  candidates:      CandidateBook[];
  enrichmentMap:   Map<string, BookEnrichmentProfile>;
  retrieval_trace: RetrievalTrace;
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

// ── Genre → OL subject mapping (specific terms, not broad buckets) ─────────────
// Two specific terms per genre; preferred over generic terms to avoid classic/PD
// drift (e.g. "fantasy" alone returns Oz/Grimm; "epic fantasy" filters better).

const GENRE_OL_SUBJECTS: Record<string, [string, string]> = {
  fantasy_scifi:    ['epic fantasy',           'dystopian fiction'],
  thriller_mystery: ['psychological thriller',  'crime fiction'],
  romance:          ['contemporary romance',    'romance fiction'],
  horror:           ['horror fiction',          'psychological horror'],
  memoir_bio:       ['personal memoirs',        'biography'],
  nonfiction:       ['popular science',         'popular nonfiction'],
  literary:         ['literary fiction',        'contemporary literary fiction'],
  general:          ['contemporary fiction',    'popular fiction'],
};

// ── Subjects that are too noisy to use as retrieval anchors ───────────────────
const GENERIC_RETRIEVAL_SUBJECTS = new Set([
  'fiction', 'non-fiction', 'nonfiction', 'english', 'american', 'british',
  'literature', 'books', 'accessible book', 'protected daisy', 'large type books',
  'open library nl', 'internet archive wishlist', 'reading level',
  'adventure and adventurers', 'good and evil',
]);

// ── Known public-domain / classic-drift authors ────────────────────────────────
// These appear frequently in OL broad searches and contaminate modern recs.
const PD_AUTHORS = new Set([
  'l. frank baum', 'brothers grimm', 'hans christian andersen', 'lewis carroll',
  'edgar rice burroughs', 'h.g. wells', 'jules verne', 'edgar allan poe',
  'h.p. lovecraft', 'arthur conan doyle', 'bram stoker', 'jack london',
  'rudyard kipling', 'oscar wilde', 'ambrose bierce', 'algernon blackwood',
  'george macdonald', 'homer', 'virgil', 'dante alighieri', 'geoffrey chaucer',
]);

// ── Children's / juvenile subject signals ─────────────────────────────────────
const JUVENILE_SUBJECT_SIGNALS = [
  'juvenile', "children's", 'picture book', 'juvenile fiction',
  'juvenile literature', "children's fiction", "children's literature",
  'board book', 'easy reader',
];

// ── OL doc type ────────────────────────────────────────────────────────────────

type OLDoc = {
  key?:                     string;
  title?:                   string;
  author_name?:             string[];
  cover_i?:                 number;
  number_of_pages_median?:  number;
  subject?:                 string[];
  first_publish_year?:      number;
  language?:                string[];
};

// ── OL subject search ─────────────────────────────────────────────────────────

async function fetchOLSubject(
  subject:          string,
  limit:            number,
  retrieval_reason: string,
): Promise<CandidateBook[]> {
  try {
    const url =
      `https://openlibrary.org/search.json` +
      `?subject=${encodeURIComponent(subject)}` +
      `&fields=key,title,author_name,cover_i,number_of_pages_median,subject,first_publish_year,language` +
      `&sort=rating` +
      `&limit=${limit}`;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 3500);
    const res        = await fetch(url, { signal: controller.signal });
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

// ── OL author search ──────────────────────────────────────────────────────────

async function fetchOLByAuthor(
  author: string,
  limit:  number,
): Promise<CandidateBook[]> {
  try {
    const url =
      `https://openlibrary.org/search.json` +
      `?author=${encodeURIComponent(author)}` +
      `&fields=key,title,author_name,cover_i,number_of_pages_median,subject,first_publish_year,language` +
      `&sort=rating` +
      `&limit=${limit}`;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 3000);
    const res        = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const json = await res.json() as { docs?: OLDoc[] };

    return (json.docs ?? [])
      .filter(doc => doc.key && doc.title)
      .map((doc): CandidateBook => ({
        id:                `ol:${doc.key}`,
        title:             doc.title ?? '',
        author:            doc.author_name?.[0] ?? author,
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
        _retrieval_reason: `author_anchor:${author}`,
      }));
  } catch {
    return [];
  }
}

// ── Source A: Catalog ─────────────────────────────────────────────────────────

type LocalResult = {
  candidates:      CandidateBook[];
  readIds:         Set<string>;
  readExternalIds: Set<string>;
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

// ── Source B: Cached external ─────────────────────────────────────────────────

type CacheResult = {
  candidates: CandidateBook[];
  isFresh:    boolean;
} | null;

async function getCachedExternalCandidates(
  client:             SupabaseClient,
  userId:             string,
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

    if (error) return null;

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

    const rows    = (data ?? []) as CacheRow[];
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

// ── Source C: Live OL — multi-anchor retrieval ────────────────────────────────
// Builds a fetch plan from:
//   1. Top 3 genre affinities → specific OL subject terms (2 per genre)
//   2. Top 3 liked subjects from profile (direct subject anchors)
//   3. Top 1 liked author (OL author search)
// Returns candidates + retrieval trace metadata.

type OLResult = {
  candidates:          CandidateBook[];
  ol_queries:          string[];
  top_genres_used:     string[];
  liked_subjects_used: string[];
  liked_authors_used:  string[];
};

async function getOLCandidates(
  profile:            TasteProfile,
  readExternalIds:    Set<string>,
  excludeExternalIds: Set<string>,
): Promise<OLResult> {
  const affinities = profile.genre_affinities ?? {};

  // ── 1. Top 3 genre affinities ─────────────────────────────────────────────
  let topGenres = Object.entries(affinities)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g);

  // Fallback: infer from trait preferences if no rated genres yet
  if (topGenres.length === 0) {
    const pref = profile.preferred_traits;
    if ((pref['Insight'] ?? 0) + (pref['Evidence'] ?? 0) > 0.4)
      topGenres = ['nonfiction', 'memoir_bio'];
    else if ((pref['Suspense'] ?? 0) + (pref['Pacing'] ?? 0) > 0.5)
      topGenres = ['thriller_mystery'];
    else if ((pref['Worldbuilding'] ?? 0) > 0.4)
      topGenres = ['fantasy_scifi'];
    else
      topGenres = ['literary'];
  }

  // ── 2. Top 3 liked subjects (filter out noise) ────────────────────────────
  const likedSubjectAnchors = (profile.liked_subjects ?? [])
    .filter(s => !GENERIC_RETRIEVAL_SUBJECTS.has(s.toLowerCase()))
    .slice(0, 3);

  // ── 3. Top 1 liked author ─────────────────────────────────────────────────
  const likedAuthorAnchor = (profile.liked_authors ?? []).slice(0, 1);

  // ── Build fetch plan ──────────────────────────────────────────────────────
  type FetchItem =
    | { kind: 'subject'; value: string; reason: string }
    | { kind: 'author';  value: string; reason: string };

  const plan: FetchItem[] = [];
  const ol_queries: string[] = [];

  // Genre anchors — 2 specific subjects per genre
  for (const genre of topGenres) {
    const [s1, s2] = GENRE_OL_SUBJECTS[genre] ?? ['contemporary fiction', 'literary fiction'];
    plan.push({ kind: 'subject', value: s1, reason: `genre:${genre}` });
    if (plan.length < 8) plan.push({ kind: 'subject', value: s2, reason: `genre:${genre}` });
  }

  // Subject anchors from liked books
  for (const s of likedSubjectAnchors) {
    if (plan.length >= 10) break;
    plan.push({ kind: 'subject', value: s, reason: `liked_subject:${s}` });
  }

  // Author anchor
  for (const a of likedAuthorAnchor) {
    if (plan.length >= 11) break;
    plan.push({ kind: 'author', value: a, reason: `author_anchor:${a}` });
  }

  // ── Execute fetch plan (parallel) ─────────────────────────────────────────
  const resultSets = await Promise.all(
    plan.map(item => {
      ol_queries.push(item.value);
      if (item.kind === 'author') {
        return fetchOLByAuthor(item.value, 12);
      }
      return fetchOLSubject(item.value, 18, item.reason);
    })
  );

  // ── Merge and deduplicate ─────────────────────────────────────────────────
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

  return {
    candidates:          merged,
    ol_queries,
    top_genres_used:     topGenres,
    liked_subjects_used: likedSubjectAnchors,
    liked_authors_used:  likedAuthorAnchor,
  };
}

// ── Cache write ────────────────────────────────────────────────────────────────

async function persistOLCandidates(
  client: SupabaseClient,
  userId: string,
  books:  CandidateBook[],
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
    // Best-effort
  }
}

// ── Hygiene filter ────────────────────────────────────────────────────────────
// Removes or de-prioritises candidates that don't belong in modern adult recs.
// Returns { passed, excluded, reasons } for the retrieval trace.

type HygieneResult = {
  passed:   CandidateBook[];
  excluded: number;
  reasons:  string[];
};

function applyHygiene(
  candidates:    CandidateBook[],
  enrichmentMap: Map<string, BookEnrichmentProfile>,
): HygieneResult {
  const reasons: string[] = [];
  let excluded = 0;

  const passed = candidates.filter(book => {
    const subjects  = book.subjects ?? [];
    const subjLower = subjects.map(s => s.toLowerCase());

    // ── Exclude children's / juvenile books ──────────────────────────────
    const isJuvenile = JUVENILE_SUBJECT_SIGNALS.some(sig =>
      subjLower.some(s => s.includes(sig))
    );
    if (isJuvenile) {
      excluded++;
      if (reasons.length < 5) reasons.push(`juvenile: ${book.title}`);
      return false;
    }

    // ── Exclude known PD / classic-drift authors ─────────────────────────
    const authorLower = book.author.toLowerCase();
    if (PD_AUTHORS.has(authorLower)) {
      excluded++;
      if (reasons.length < 5) reasons.push(`pd_author: ${book.author}`);
      return false;
    }

    // ── Language check via enrichment ─────────────────────────────────────
    const enrichment = book.external_id ? enrichmentMap.get(book.external_id) : undefined;
    if (enrichment?.language && enrichment.language !== 'en') {
      excluded++;
      if (reasons.length < 5) reasons.push(`non_english(${enrichment.language}): ${book.title}`);
      return false;
    }

    // ── Exclude catalog books with truly no metadata (edge-case) ──────────
    if (book._source === 'catalog') {
      const hasAnyMeta =
        (book.subjects && book.subjects.length > 0) ||
        (book.description && book.description.trim().length > 30);
      if (!hasAnyMeta) {
        excluded++;
        if (reasons.length < 5) reasons.push(`no_meta: ${book.title}`);
        return false;
      }
    }

    return true;
  });

  return { passed, excluded, reasons };
}

// ── Scoring (pure) ────────────────────────────────────────────────────────────

export function scoreBookForUser(
  book:        CandidateBook,
  profile:     TasteProfile,
  feedback?:   FeedbackContext,
  enrichment?: BookEnrichmentProfile,
): Pick<ScoredBook, 'score' | 'confidence' | 'reasons' | 'risks' | '_score_breakdown'> {
  const bt         = getBookTraits(book);
  const pref       = profile.preferred_traits;
  const avoid      = profile.avoided_traits;
  const affinities = profile.genre_affinities ?? {};
  const reasons: string[] = [];
  const risks:   string[] = [];

  // Step-level accumulators for the debug breakdown
  let s1_trait = 0;
  let s2_avoid = 0;
  let s3_genre = 0;
  let s4_feed  = 0;
  let s5_enr   = 0;

  // ── Step 1: Preferred trait alignment ─────────────────────────────────────
  const prefMatches: string[] = [];
  for (const [trait, userWeight] of Object.entries(pref)) {
    const bookWeight   = bt.traits[trait] ?? 0;
    const contribution = userWeight * bookWeight;
    if (contribution > 0.22) {
      prefMatches.push(trait.toLowerCase());
      s1_trait += contribution;
    }
  }
  if (prefMatches.length >= 2) {
    reasons.push(`Aligns with your preference for ${prefMatches.slice(0, 2).join(' and ')}`);
  } else if (prefMatches.length === 1) {
    reasons.push(`Matches your appreciation for ${prefMatches[0]}`);
  }

  // ── Step 2: Avoided trait penalties ───────────────────────────────────────
  const avoidHits: string[] = [];
  for (const [trait, penalty] of Object.entries(avoid)) {
    const bookWeight   = bt.traits[trait] ?? 0;
    const contribution = penalty * bookWeight;
    if (contribution < -0.18) {
      avoidHits.push(trait.toLowerCase());
      s2_avoid += contribution;
    }
  }
  if (avoidHits.length > 0) {
    risks.push(`Leans toward ${avoidHits[0]} — which hasn't worked well for you`);
  }

  // ── Step 3: Genre affinity bonus / penalty ────────────────────────────────
  if (bt.primaryGenre) {
    const affinity = affinities[bt.primaryGenre] ?? 0;
    if (affinity > 0.5) {
      s3_genre += 0.28;
      if (reasons.length < 2) reasons.push(`Fits a genre you consistently enjoy`);
    } else if (affinity > 0.2) {
      s3_genre += 0.12;
    } else if (affinity < -0.35) {
      s3_genre -= 0.22;
      if (risks.length < 1) {
        const label = bt.primaryGenre.replace('_', '/');
        risks.push(`You've had mixed results with ${label} before`);
      }
    }
  }

  // ── Step 4: Feedback boosts from "More Like This" signals ────────────────
  if (feedback && bt.primaryGenre) {
    const boost = feedback.genreBoosts[bt.primaryGenre] ?? 0;
    if (boost > 0) {
      s4_feed += boost;
      if (reasons.length < 2) reasons.push(`Similar to books you asked for more of`);
    }
  }

  // ── Step 5: Enrichment signals (secondary layer) ──────────────────────────
  if (enrichment) {
    const ct = enrichment.consensus_traits;
    const ps = enrichment.popularity_signals;

    const enrichedPrefMatches: string[] = [];
    const traitMap: Record<string, string> = {
      pacing:            'Pacing',
      originality:       'Originality',
      insight:           'Insight',
      emotionality:      'Emotional',
      suspense:          'Suspense',
      worldbuilding:     'Worldbuilding',
      literary_prose:    'Prose',
      practicality:      'Practicality',
      romance_intensity: 'Romance',
    };
    for (const [enrichKey, prefKey] of Object.entries(traitMap)) {
      const enrichVal = ct[enrichKey as keyof typeof ct] ?? 0;
      const userPref  = pref[prefKey] ?? 0;
      if (enrichVal > 0.5 && userPref > 0.3) {
        enrichedPrefMatches.push(prefKey.toLowerCase());
        s5_enr += 0.06;
      }
      if (enrichKey === 'romance_intensity' && enrichVal > 0.6) {
        const avoidRomance = Math.abs(avoid['Romance'] ?? 0);
        if (avoidRomance > 0.25 && risks.length < 1) {
          risks.push(`May lean more romance-forward than your usual favorites`);
          s5_enr -= 0.08;
        }
      }
    }
    if (enrichedPrefMatches.length > 0 && reasons.length < 2) {
      const key = enrichedPrefMatches[0];
      reasons.push(`Readers consistently note strong ${key} — which fits your profile`);
    }

    const ratingsCount = ps.ratings_count ?? 0;
    const avgRating    = ps.average_rating ?? 0;
    if (ratingsCount >= 500 && avgRating >= 4.0) {
      s5_enr += 0.04;
    }

    if ((ct.pacing ?? 0) < 0.2 && (pref['Pacing'] ?? 0) > 0.5 && risks.length < 1) {
      risks.push(`This appears slower-paced than the books you rate highest`);
    }
  }

  if (enrichment && enrichment.audience_signals.length > 0 && reasons.length === 0) {
    reasons.push(enrichment.audience_signals[0]);
  }

  const rawScore   = s1_trait + s2_avoid + s3_genre + s4_feed + s5_enr;
  const finalScore = Math.max(0, Math.min(1, rawScore));

  let confidence: 'low' | 'medium' | 'high';
  if (profile.tier >= 3 && finalScore > 0.42)      confidence = 'high';
  else if (profile.tier >= 2 && finalScore > 0.22) confidence = 'medium';
  else                                              confidence = 'low';

  const fmt = (n: number) => +n.toFixed(3);

  return {
    score:   fmt(finalScore),
    confidence,
    reasons: [...new Set(reasons)].slice(0, 2),
    risks:   [...new Set(risks)].slice(0, 1),
    _score_breakdown: {
      trait_alignment:  fmt(s1_trait),
      avoided_penalty:  fmt(s2_avoid),
      genre_bonus:      fmt(s3_genre),
      feedback_boost:   fmt(s4_feed),
      enrichment_bonus: fmt(s5_enr),
      final_score:      fmt(finalScore),
    },
  };
}

// ── Ranked recs ───────────────────────────────────────────────────────────────

export function getRankedRecs(
  candidates:    CandidateBook[],
  profile:       TasteProfile,
  limit          = 5,
  feedback?:     FeedbackContext,
  enrichmentMap: Map<string, BookEnrichmentProfile> = new Map(),
  retrieval_trace: RetrievalTrace = {
    top_genres_used:     [],
    top_traits_used:     [],
    liked_subjects_used: [],
    liked_authors_used:  [],
    ol_queries:          [],
    hygiene_excluded:    0,
    enriched_count:      0,
  },
): RankedRecsResult {
  const poolSize = candidates.length;

  const buildMeta = (qg: QualityGate): RankedRecsResult['meta'] => {
    const sourcesSet = new Set<CandidateSource>(candidates.map(c => c._source));
    return {
      pool_size:             poolSize,
      sources_used:          [...sourcesSet],
      catalog_count:         candidates.filter(c => c._source === 'catalog').length,
      cached_external_count: candidates.filter(c => c._source === 'cached_external').length,
      live_ol_count:         candidates.filter(c => c._source === 'open_library').length,
      quality_gate:          qg,
      hygiene_excluded:      retrieval_trace.hygiene_excluded,
      enriched_count:        retrieval_trace.enriched_count,
      retrieval_trace,
    };
  };

  if (poolSize < MIN_CANDIDATES) {
    return { recs: [], meta: buildMeta('insufficient_pool') };
  }

  const scored = candidates.map(book => {
    const enrichment = book.external_id ? enrichmentMap.get(book.external_id) : undefined;
    return {
      ...book,
      ...scoreBookForUser(book, profile, feedback, enrichment),
      _debug: { pool_size: poolSize, rank: 0 },
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // Quality gate: score threshold
  const passing = scored.filter(b => b.score >= MIN_PASS_SCORE);
  if (passing.length < MIN_PASSING_BOOKS) {
    return { recs: [], meta: buildMeta('insufficient_score') };
  }

  // Diversity: max 2 books per primary genre
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

  return { recs: diverse, meta: buildMeta('passed') };
}

// ── Combined retrieval ────────────────────────────────────────────────────────
// Returns CandidateResult: candidates + enrichmentMap + retrieval_trace.
// replaces the old plain CandidateBook[] return type.

export async function getCandidateBooks(
  client:    SupabaseClient,
  userId:    string,
  profile:   TasteProfile,
  feedback?: FeedbackContext,
): Promise<CandidateResult> {
  // ── Source A: catalog ─────────────────────────────────────────────────────
  const local = await getLocalCandidates(client, userId);

  const catalogExternalIds = new Set(
    local.candidates.map(c => c.external_id).filter((x): x is string => !!x)
  );

  // ── Source B: check cache ─────────────────────────────────────────────────
  const cacheResult = await getCachedExternalCandidates(
    client,
    userId,
    new Set([...local.readExternalIds, ...catalogExternalIds]),
  );

  let externalCandidates: CandidateBook[];
  let olResult: OLResult = {
    candidates:          [],
    ol_queries:          [],
    top_genres_used:     [],
    liked_subjects_used: [],
    liked_authors_used:  [],
  };

  if (cacheResult?.isFresh) {
    externalCandidates = cacheResult.candidates;
    // Reconstruct trace from cache retrieval_reasons
    const cacheReasons = cacheResult.candidates
      .map(c => c._retrieval_reason)
      .filter(Boolean);
    olResult.ol_queries = [...new Set(cacheReasons)].slice(0, 10);
  } else {
    // ── Source C: live OL multi-anchor fetch ──────────────────────────────
    const excludeForOL = new Set([
      ...local.readExternalIds,
      ...catalogExternalIds,
      ...(cacheResult?.candidates.map(c => c.external_id).filter((x): x is string => !!x) ?? []),
    ]);

    olResult = await getOLCandidates(profile, local.readExternalIds, excludeForOL);

    // Merge fresh OL on top of any stale cache rows for breadth
    const stale       = cacheResult?.candidates ?? [];
    const olExtIds    = new Set(olResult.candidates.map(b => b.external_id).filter((x): x is string => !!x));
    const nonDupStale = stale.filter(b => !olExtIds.has(b.external_id ?? ''));

    externalCandidates = [...olResult.candidates, ...nonDupStale];

    // Persist OL results (best-effort, async)
    persistOLCandidates(client, userId, olResult.candidates).catch(() => {});
  }

  // ── Top trait anchors for trace ────────────────────────────────────────────
  const top_traits_used = Object.entries(profile.preferred_traits)
    .filter(([, v]) => v > 0.3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  // ── Merge all candidates ───────────────────────────────────────────────────
  const all = [...externalCandidates, ...local.candidates];

  // ── Enrichment (cache-first; fetch uncached for top candidates) ────────────
  const enrichmentMap = await getEnrichmentForCandidates(client, all);

  // ── Hygiene filter ─────────────────────────────────────────────────────────
  const hygiene = applyHygiene(all, enrichmentMap);

  // ── Apply dismissals from feedback ────────────────────────────────────────
  let filtered = hygiene.passed;
  if (feedback?.dismissedIds.size) {
    filtered = filtered.filter(b => {
      if (b.external_id && feedback.dismissedIds.has(b.external_id)) return false;
      if (b._source === 'catalog' && feedback.dismissedIds.has(b.id))  return false;
      return true;
    });
  }

  const retrieval_trace: RetrievalTrace = {
    top_genres_used:     olResult.top_genres_used,
    top_traits_used,
    liked_subjects_used: olResult.liked_subjects_used,
    liked_authors_used:  olResult.liked_authors_used,
    ol_queries:          olResult.ol_queries,
    hygiene_excluded:    hygiene.excluded,
    enriched_count:      enrichmentMap.size,
  };

  return { candidates: filtered, enrichmentMap, retrieval_trace };
}

// ── Convenience async wrapper ─────────────────────────────────────────────────

export async function getPersonalizedRecs(
  client:    SupabaseClient,
  userId:    string,
  profile:   TasteProfile,
  limit      = 5,
  feedback?: FeedbackContext,
): Promise<RankedRecsResult> {
  const { candidates, enrichmentMap, retrieval_trace } =
    await getCandidateBooks(client, userId, profile, feedback);
  return getRankedRecs(candidates, profile, limit, feedback, enrichmentMap, retrieval_trace);
}
