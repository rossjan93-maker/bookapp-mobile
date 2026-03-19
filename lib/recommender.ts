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
import { getBookTraits, assessMetadataQuality, detectBookLane, detectBookMysterySubtype, isPhilosophyOrSpiritual } from './bookTraits';
import type { DeterministicLane }    from './bookTraits';
import type { FeedbackContext }      from './recFeedback';
import type { BookEnrichmentProfile } from './bookEnrichment';
import { getEnrichmentForCandidates } from './bookEnrichment';
import type { RecEntitlement, ExpertAccessDecision }         from './recEntitlement';
import { canRunExpertRecs, consumeExpertRefresh }             from './recEntitlement';
import type { ReaderThesis, ExpertRecResult, CandidateJudgment } from './expertRec';
import { buildReaderThesis, judgeCandidateFit, composeRecommendationSet } from './expertRec';
import { buildEvidencePack }                                  from './evidencePack';
import { loadCachedRecs, persistRecCache, shouldRebuild, buildSignalSnapshot } from './recCache';

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
  trait_alignment:  number;   // step 1 — preferred trait match (capped)
  avoided_penalty:  number;   // step 2 — avoided trait penalties (negative)
  genre_bonus:      number;   // step 3 — genre affinity bonus/penalty
  feedback_boost:   number;   // step 4 — More-Like-This genre boost
  enrichment_bonus: number;   // step 5 — consensus trait + popularity signal
  metadata_penalty: number;   // step 6 — weak metadata down-weight
  raw_score:        number;   // sum before clamping
  final_score:      number;   // clamped 0–1 total
  book_form:        string | null;   // detected form (poetry/play/etc.)
  audit_flags:      string[];        // any audit flags applied
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
  // Dense-import mode debug (present when det_lanes.is_dense_import = true)
  dense_import_mode?:    boolean;
  detected_lanes?:       string[];  // dominant lanes detected from reading history
  repeated_authors_used?: string[]; // repeated-author anchors used in retrieval
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
    // Expert layer fields (undefined when mode is deterministic)
    mode?:                  'deterministic' | 'expert';
    reader_thesis?:         ReaderThesis | null;
    expert_result?:         ExpertRecResult | null;
    expert_decision?:       ExpertAccessDecision | null;
    is_from_cache?:         boolean;
    cache_built_at?:        string | null;
  };
};

// CandidateResult — returned by getCandidateBooks; replaces the old plain array.
export type CandidateResult = {
  candidates:      CandidateBook[];
  enrichmentMap:   Map<string, BookEnrichmentProfile>;
  retrieval_trace: RetrievalTrace;
};

// ── Fit label helpers (used by the UI) ────────────────────────────────────────

// Thresholds deliberately high — "Strong fit" must be genuinely earned.
// With calibrated scoring (step 1 capped at 0.38, max total ~0.85),
// a score above 0.60 requires strong genre + multiple trait signals.
export function fitLabel(score: number): string {
  if (score > 0.60) return 'Strong fit';
  if (score > 0.35) return 'Good match';
  return 'Worth exploring';
}

export function fitColor(score: number): string {
  if (score > 0.60) return '#16a34a';
  if (score > 0.35) return '#2563eb';
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

// ── Dense-import lane → OL subject mapping ─────────────────────────────────────
// Used exclusively in dense-import mode where dominant reading lanes are known.
// More specific than GENRE_OL_SUBJECTS — avoids literary / canon drift entirely
// unless 'literary' is actually a dominant lane for this user.

const DENSE_LANE_OL_SUBJECTS: Record<DeterministicLane, [string, string]> = {
  romantasy:            ['romantasy',                     'fantasy romance'],
  contemporary_fiction: ["women's fiction",               'book club fiction'],
  modern_suspense:      ['psychological thriller',         'domestic thriller'],
  memoir_nonfiction:    ['personal memoirs',               'narrative nonfiction'],
  literary:             ['literary fiction',               'contemporary literary fiction'],
  scifi_fantasy:        ['epic fantasy',                   'dystopian fiction'],
  romance:              ['contemporary romance',           'romance fiction'],
  horror:               ['horror fiction',                 'supernatural fiction'],
};

// Lane-aware reason templates — shown instead of generic trait-match lines
const LANE_REASON: Record<DeterministicLane, string> = {
  romantasy:            'Feels adjacent to the fantasy series you repeatedly complete',
  contemporary_fiction: 'Fits your pattern of emotionally driven contemporary fiction',
  modern_suspense:      'Matches the twisty, readable suspense you rate highly',
  memoir_nonfiction:    'Sits close to the narrative nonfiction you consistently enjoy',
  literary:             'Aligns with the literary fiction that appears in your reading history',
  scifi_fantasy:        'Fits the speculative fiction you return to most often',
  romance:              'Similar to the emotionally driven romance you rate highly',
  horror:               'Fits the horror fiction you have consistently enjoyed',
};

// Commercial lanes — used for the modern-commercial-prior boost in Step 7
const COMMERCIAL_LANES = new Set<DeterministicLane>([
  'romantasy', 'contemporary_fiction', 'modern_suspense', 'romance',
]);

// ── Subjects that are too noisy to use as retrieval anchors ───────────────────
const GENERIC_RETRIEVAL_SUBJECTS = new Set([
  'fiction', 'non-fiction', 'nonfiction', 'english', 'american', 'british',
  'literature', 'books', 'accessible book', 'protected daisy', 'large type books',
  'open library nl', 'internet archive wishlist', 'reading level',
  'adventure and adventurers', 'good and evil',
]);

// ── Known public-domain / classic-drift authors ────────────────────────────────
// These appear frequently in OL broad-subject searches and contaminate modern
// recommendations. Exception: author-anchor candidates from liked_authors are
// exempt (user explicitly loved that author's work).
//
// Coverage policy: any author whose primary works entered the US public domain
// (died before 1928) and who regularly appears in OL subject-search drift.
const PD_AUTHORS = new Set([
  // Classical / ancient
  'homer', 'virgil', 'ovid', 'dante alighieri', 'geoffrey chaucer',
  'giovanni boccaccio', 'francois rabelais',
  // Renaissance / Early Modern
  'william shakespeare', 'john milton', 'john donne', 'john bunyan',
  'ben jonson', 'christopher marlowe', 'thomas more', 'edmund spenser',
  'michel de montaigne', 'miguel de cervantes',
  // 18th Century
  'jonathan swift', 'daniel defoe', 'henry fielding', 'samuel richardson',
  'laurence sterne', 'tobias smollett', 'samuel johnson', 'alexander pope',
  'voltaire', 'jean-jacques rousseau', 'immanuel kant',
  // Romantic era
  'jane austen', 'william wordsworth', 'samuel taylor coleridge',
  'lord byron', 'george gordon byron', 'percy bysshe shelley', 'mary shelley',
  'john keats', 'walter scott', 'sir walter scott', 'washington irving',
  'james fenimore cooper', 'elizabeth barrett browning', 'alfred lord tennyson',
  'alfred, lord tennyson', 'robert browning', 'matthew arnold',
  // Victorian
  'charles dickens', 'george eliot', 'charlotte brontë', 'emily brontë',
  'anne brontë', 'william makepeace thackeray', 'thomas hardy',
  'anthony trollope', 'george meredith', 'wilkie collins', 'george gissing',
  // American 19th century
  'nathaniel hawthorne', 'herman melville', 'edgar allan poe', 'walt whitman',
  'emily dickinson', 'mark twain', 'henry david thoreau', 'ralph waldo emerson',
  'henry james', 'louisa may alcott', 'ambrose bierce', 'jack london',
  'stephen crane', 'frank norris', 'upton sinclair',
  // Adventure / genre classics
  'l. frank baum', 'brothers grimm', 'hans christian andersen', 'lewis carroll',
  'edgar rice burroughs', 'h.g. wells', 'jules verne', 'h.p. lovecraft',
  'arthur conan doyle', 'bram stoker', 'rudyard kipling', 'oscar wilde',
  'algernon blackwood', 'george macdonald', 'arthur machen',
  // European literary canon
  'leo tolstoy', 'fyodor dostoevsky', 'ivan turgenev', 'nikolai gogol',
  'anton chekhov', 'gustave flaubert', 'emile zola', 'victor hugo',
  'alexandre dumas', 'stendhal', 'balzac', 'honoré de balzac',
  'henrik ibsen', 'august strindberg', 'luigi pirandello',
  'theodore fontane', 'gottfried keller',
  // Philosophy / classical thought
  'friedrich nietzsche', 'arthur schopenhauer', 'immanuel kant',
  'georg wilhelm friedrich hegel', 'søren kierkegaard', 'john stuart mill',
  'david hume', 'john locke', 'thomas hobbes', 'francis bacon',
  'rene descartes', 'baruch spinoza', 'epicurus', 'marcus aurelius',
  'saint augustine', 'augustine of hippo', 'boethius', 'thomas aquinas',
  'plato', 'aristotle', 'socrates',
  // Early 20th century (died ≤ 1928, US PD threshold)
  'charlotte perkins gilman', 'kate chopin', 'edith wharton', 'o. henry',
  'o henry', 'ambrose gwinnett bierce', 'booth tarkington', 'ring lardner',
  'sax rohmer', 'arthur morrison', 'israel zangwill',
  // Early genre / pulp drift
  'robert w. chambers', 'robert w chambers', 'a. merritt', 'a merritt',
  // Missing early-20th-century classical/pre-modern (died ≤ 1940 or pre-modern)
  'g.k. chesterton', 'g. k. chesterton', 'gilbert keith chesterton',
  'murasaki shikibu', 'lady murasaki', 'sei shonagon',
  'rabindranath tagore', 'lafcadio hearn',
  'd.h. lawrence', 'd. h. lawrence', 'david herbert lawrence',
  'virginia woolf', 'joseph conrad', 'e.m. forster', 'e. m. forster',
  'thomas mann', 'rainer maria rilke', 'stefan zweig',
  'f. scott fitzgerald', 'f.s. fitzgerald',
  'gertrude stein', 'sherwood anderson', 'sinclair lewis',
  'theodore dreiser', 'willa cather', 'ellen glasgow',
  'ambrose bierce',
]);

// ── Canonical literary-drift authors (mid-20th century) ───────────────────────
// These are copyrighted but appear heavily in OL "literary fiction" subject
// searches. They cause drift for commercial/genre readers. Hard-excluded in
// hygiene unless the user's dominant lanes include 'literary'.
const CANON_LITERARY_AUTHORS = new Set([
  'ernest hemingway', 'william faulkner', 'john steinbeck',
  'james joyce', 'samuel beckett', 'ezra pound',
  't.s. eliot', 'henry miller', 'anaïs nin', 'anais nin',
  'jean-paul sartre', 'albert camus', 'simone de beauvoir',
  'franz kafka', 'robert musil', 'arthur schnitzler',
  'gabriel garcía márquez', 'gabriel garcia marquez',
  'jorge luis borges', 'julio cortázar', 'julio cortazar',
  'william s. burroughs', 'jack kerouac', 'allen ginsberg',
  'truman capote', 'carson mccullers',
  'john updike', 'philip roth', 'saul bellow', 'ralph ellison',
  'vladimir nabokov', 'milan kundera',
]);

// ── Classic / ancient subject signals (hard-exclude for non-literary lanes) ───
// Books with these subjects in their subject list are pre-modern classics that
// produce nonsensical trait explanations for contemporary commercial readers.
const ANCIENT_CLASSIC_SUBJECT_SIGNALS = [
  '11th century', '12th century', '13th century', '14th century',
  '15th century', '16th century', '17th century',
  'classical antiquity', 'ancient rome', 'ancient greece',
  'classical japanese literature', 'japanese classical literature',
  'heian period', 'ancient literature', 'classical literature',
  'medieval literature', 'middle ages literature',
];

// ── Children's / juvenile subject signals ─────────────────────────────────────
const JUVENILE_SUBJECT_SIGNALS = [
  'juvenile', "children's", 'picture book', 'juvenile fiction',
  'juvenile literature', "children's fiction", "children's literature",
  'board book', 'easy reader',
];

// ── Classic / historical-drift subject signals ─────────────────────────────────
// Books with these subjects are likely pre-20th-century classics that will
// confuse genre-based trait scoring. Applied as a hygiene down-weight, not
// hard exclusion (in case the user genuinely likes classics).
const CLASSIC_DRIFT_SUBJECTS = new Set([
  '19th century', '18th century', '17th century', '16th century',
  'early modern period', 'victorian', 'elizabethan', 'jacobean',
  'renaissance', 'medieval', 'ancient', 'classical antiquity',
  'restoration period', 'georgian period',
]);

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
      // Hard-reject pre-1930 books from broad subject searches: they are almost
      // always public-domain classics that contaminate modern recommendations.
      .filter(doc => !doc.first_publish_year || doc.first_publish_year >= 1930)
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

    // Invalidate stale entries written by old code: old retrieval_reason format
    // was `ol:genre:<name>` (with "ol:" prefix). New format is `genre:<name>`,
    // `lane:<name>`, `repeated_author:<name>`, etc. Rows with old-format reasons
    // contain bad literary/canon books from before the retrieval fix and must be
    // treated as if they never existed.
    const validRows = rows.filter(r =>
      !r.retrieval_reason || !r.retrieval_reason.startsWith('ol:')
    );

    const isFresh = validRows.length >= CACHE_MIN_ROWS;

    const candidates: CandidateBook[] = validRows
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
  const det        = profile.det_lanes;
  const isDense    = !!(det?.is_dense_import && (det.dominant_lanes.length > 0 || det.repeated_liked_authors.length > 0));

  // ── Build fetch plan ──────────────────────────────────────────────────────
  type FetchItem =
    | { kind: 'subject'; value: string; reason: string }
    | { kind: 'author';  value: string; reason: string };

  const plan: FetchItem[] = [];
  const ol_queries: string[] = [];

  if (isDense && det) {
    // ── Dense-import mode ─────────────────────────────────────────────────
    // Primary: up to 3 repeated-liked authors (strongest signal — user reads
    //   the same author repeatedly, which OL author search handles well).
    // Secondary: OL subjects derived ONLY from dominant lanes (no literary
    //   fallback unless 'literary' is genuinely a dominant lane for this user).
    // This prevents the "canon tolerance → canon retrieval" failure mode.

    for (const author of det.repeated_liked_authors.slice(0, 3)) {
      plan.push({ kind: 'author', value: author, reason: `repeated_author:${author}` });
    }

    for (const lane of det.dominant_lanes.slice(0, 3)) {
      const [s1, s2] = DENSE_LANE_OL_SUBJECTS[lane] ?? [];
      if (s1) plan.push({ kind: 'subject', value: s1, reason: `lane:${lane}` });
      if (s2 && plan.length < 10) plan.push({ kind: 'subject', value: s2, reason: `lane:${lane}` });
    }

    // Fallback if completely empty (should rarely happen)
    if (plan.length === 0) {
      const likedSubjectAnchors = (profile.liked_subjects ?? [])
        .filter(s => !GENERIC_RETRIEVAL_SUBJECTS.has(s.toLowerCase()))
        .slice(0, 3);
      for (const s of likedSubjectAnchors) {
        plan.push({ kind: 'subject', value: s, reason: `liked_subject:${s}` });
      }
    }

  } else {
    // ── Standard multi-anchor retrieval ───────────────────────────────────
    // ── 1. Top 3 genre affinities ─────────────────────────────────────────
    let topGenres = Object.entries(affinities)
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g);

    // Fallback: infer from trait preferences if no rated genres yet.
    // NOTE: fallback is 'general' (contemporary/popular fiction) — NOT 'literary',
    // which was causing Hemingway/Rand/Chandler drift for blank-affinity users.
    if (topGenres.length === 0) {
      const pref = profile.preferred_traits;
      if ((pref['Insight'] ?? 0) + (pref['Evidence'] ?? 0) > 0.4)
        topGenres = ['nonfiction', 'memoir_bio'];
      else if ((pref['Suspense'] ?? 0) + (pref['Pacing'] ?? 0) > 0.5)
        topGenres = ['thriller_mystery'];
      else if ((pref['Worldbuilding'] ?? 0) > 0.4)
        topGenres = ['fantasy_scifi'];
      else
        topGenres = ['general'];  // was 'literary' — now defaults to contemporary/popular fiction
    }

    // ── 2. Top 3 liked subjects (filter out noise) ────────────────────────
    const likedSubjectAnchors = (profile.liked_subjects ?? [])
      .filter(s => !GENERIC_RETRIEVAL_SUBJECTS.has(s.toLowerCase()))
      .slice(0, 3);

    // ── 3. Top 1 liked author ─────────────────────────────────────────────
    const likedAuthorAnchor = (profile.liked_authors ?? []).slice(0, 1);

    // Genre anchors — 2 specific subjects per genre
    for (const genre of topGenres) {
      const [s1, s2] = GENRE_OL_SUBJECTS[genre] ?? ['contemporary fiction', 'popular fiction'];
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

  // Extract trace metadata from the plan items
  const top_genres_used     = isDense
    ? []
    : plan.filter(i => i.reason.startsWith('genre:')).map(i => i.reason.slice(6)).filter((v, i, a) => a.indexOf(v) === i);
  const liked_subjects_used = plan.filter(i => i.reason.startsWith('liked_subject:')).map(i => i.value);
  const liked_authors_used  = isDense
    ? plan.filter(i => i.reason.startsWith('repeated_author:')).map(i => i.value)
    : plan.filter(i => i.reason.startsWith('author_anchor:')).map(i => i.value);

  return {
    candidates:          merged,
    ol_queries,
    top_genres_used,
    liked_subjects_used,
    liked_authors_used,
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
// Hard-excludes candidates that cannot produce truthful recommendations.
// Soft-flags (logged but not excluded) appear in debug output only.
//
// Profile-aware exceptions:
//   - PD author exclusion is skipped for author-anchor candidates (user
//     explicitly loved that author — their later-in-career books might still
//     be worth surfacing, and it avoids filtering a known-loved author).
//   - Poetry / play exclusion is skipped if the user has 2+ liked_subjects
//     that are poetry-related.

type HygieneResult = {
  passed:   CandidateBook[];
  excluded: number;
  reasons:  string[];
};

function applyHygiene(
  candidates:     CandidateBook[],
  enrichmentMap:  Map<string, BookEnrichmentProfile>,
  likedAuthors:   string[],
  dominantLanes?: string[],
): HygieneResult {
  const reasons: string[] = [];
  let excluded = 0;

  const hasLiteraryLane = (dominantLanes ?? []).includes('literary');

  // Author-anchor candidates get PD exemption
  const likedAuthorKeys = new Set(likedAuthors.map(a => a.toLowerCase()));

  const passed = candidates.filter(book => {
    const subjects  = book.subjects ?? [];
    const subjLower = subjects.map(s => s.toLowerCase());

    // ── 1. Children's / juvenile ──────────────────────────────────────────
    const isJuvenile = JUVENILE_SUBJECT_SIGNALS.some(sig =>
      subjLower.some(s => s.includes(sig))
    );
    if (isJuvenile) {
      excluded++;
      if (reasons.length < 8) reasons.push(`juvenile: ${book.title}`);
      return false;
    }

    // ── 2. Poetry / drama form exclusion ─────────────────────────────────
    // Poetry and plays generate nonsensical trait explanations (Characters,
    // Ending, Pacing don't apply). Exclude unless the retrieval_reason
    // explicitly came from a poetry/drama anchor.
    const { bookForm } = getBookTraits(book);
    const isPoetryOrPlay = bookForm === 'poetry' || bookForm === 'play';
    const isPoetryAnchor = book._retrieval_reason.includes('poetry')
      || book._retrieval_reason.includes('poem')
      || book._retrieval_reason.includes('drama')
      || book._retrieval_reason.includes('theater');
    if (isPoetryOrPlay && !isPoetryAnchor) {
      excluded++;
      if (reasons.length < 8) reasons.push(`form(${bookForm}): ${book.title}`);
      return false;
    }

    // ── 3. PD / classic-drift authors ────────────────────────────────────
    const authorLower = book.author.toLowerCase();
    const isLikedAuthor = likedAuthorKeys.has(authorLower);
    if (PD_AUTHORS.has(authorLower) && !isLikedAuthor) {
      excluded++;
      if (reasons.length < 8) reasons.push(`pd_author: ${book.author}`);
      return false;
    }

    // ── 3b. Canonical literary-drift authors (mid-20th century) ──────────
    // Excluded for non-literary-lane users. These authors reliably indicate
    // OL literary-subject drift and never suit commercial/genre readers.
    if (!hasLiteraryLane && !isLikedAuthor && CANON_LITERARY_AUTHORS.has(authorLower)) {
      excluded++;
      if (reasons.length < 8) reasons.push(`literary_drift_author: ${book.author}`);
      return false;
    }

    // ── 3c. Ancient / classical text by subject ───────────────────────────
    // Books tagged with ancient-era or pre-modern period subjects are
    // structurally incompatible with contemporary commercial trait scoring.
    // Hard-exclude unless the user has a proven literary lane.
    if (!hasLiteraryLane && !isLikedAuthor) {
      const hasAncientSubject = ANCIENT_CLASSIC_SUBJECT_SIGNALS.some(sig =>
        subjLower.some(s => s.includes(sig))
      );
      if (hasAncientSubject) {
        excluded++;
        if (reasons.length < 8) reasons.push(`ancient_classic: ${book.title}`);
        return false;
      }
    }

    // ── 4. Non-English via enrichment ─────────────────────────────────────
    const enrichment = book.external_id ? enrichmentMap.get(book.external_id) : undefined;
    if (enrichment?.language && enrichment.language !== 'en') {
      excluded++;
      if (reasons.length < 8) reasons.push(`non_english(${enrichment.language}): ${book.title}`);
      return false;
    }

    // ── 5. Zero-metadata catalog books ────────────────────────────────────
    if (book._source === 'catalog') {
      const hasAnyMeta =
        (book.subjects && book.subjects.length > 0) ||
        (book.description && book.description.trim().length > 30);
      if (!hasAnyMeta) {
        excluded++;
        if (reasons.length < 8) reasons.push(`no_meta: ${book.title}`);
        return false;
      }
    }

    // ── 6. OL books with no subjects at all (cannot be scored reliably) ───
    if (book._source === 'open_library' && (!book.subjects || book.subjects.length === 0)) {
      excluded++;
      if (reasons.length < 8) reasons.push(`ol_no_subjects: ${book.title}`);
      return false;
    }

    return true;
  });

  return { passed, excluded, reasons };
}

// ── Scoring constants ─────────────────────────────────────────────────────────
//
// These caps prevent any single step from saturating the 0–1 scale.
// Maximum theoretical score (no penalties):
//   0.38 (trait) + 0.22 (genre) + 0.10 (feedback) + 0.08 (enrichment) = 0.78
// Real "Strong fit" (>0.60) therefore requires genre + multiple trait signals.

const TRAIT_CONTRIB_CAP = 0.14;  // per-trait ceiling in step 1
const STEP1_CAP         = 0.38;  // total step 1 ceiling
const STEP3_BONUS_HIGH  = 0.22;  // genre affinity >0.5
const STEP3_BONUS_MED   = 0.10;  // genre affinity 0.2–0.5
const STEP3_PENALTY     = 0.18;  // genre affinity <-0.35
const TRAIT_THRESHOLD   = 0.28;  // min contribution to count for step 1

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
  const audit_flags: string[] = [];

  // Step-level accumulators
  let s1_trait    = 0;
  let s2_avoid    = 0;
  let s3_genre    = 0;
  let s4_feed     = 0;
  let s5_enr      = 0;
  let s6_meta_pen = 0;

  // ── Step 1: Preferred trait alignment (capped) ────────────────────────────
  // Rules:
  //   a) The book must have a meaningful signal for this trait (bookWeight ≥ 0.55).
  //      This prevents vague genre-level priors from inflating the score.
  //   b) Each matching trait adds at most TRAIT_CONTRIB_CAP to the total.
  //   c) Total step 1 is capped at STEP1_CAP regardless of how many traits match.
  //   d) Traits that are not valid for this book's form are already absent from
  //      bt.traits (zeroed by getBookTraits), so they contribute nothing.
  const prefMatches: string[] = [];
  for (const [trait, userWeight] of Object.entries(pref)) {
    if (userWeight < 0.12) continue;                // negligible user preference
    const bookWeight = bt.traits[trait] ?? 0;
    if (bookWeight < 0.55) continue;                // book doesn't genuinely have this trait
    const contribution = Math.min(TRAIT_CONTRIB_CAP, userWeight * bookWeight);
    prefMatches.push(trait.toLowerCase());
    s1_trait = Math.min(STEP1_CAP, s1_trait + contribution);
  }
  if (prefMatches.length >= 2) {
    reasons.push(`Aligns with your preference for ${prefMatches.slice(0, 2).join(' and ')}`);
  } else if (prefMatches.length === 1) {
    reasons.push(`Matches your appreciation for ${prefMatches[0]}`);
  }

  // ── Step 2: Avoided trait penalties ───────────────────────────────────────
  const avoidHits: string[] = [];
  for (const [trait, penalty] of Object.entries(avoid)) {
    const bookWeight = bt.traits[trait] ?? 0;
    if (bookWeight === 0) continue;
    const contribution = penalty * bookWeight;  // penalty is already negative
    if (contribution < -0.15 && bookWeight >= 0.50) {
      avoidHits.push(trait.toLowerCase());
      s2_avoid = Math.max(-0.30, s2_avoid + contribution);
    }
  }
  if (avoidHits.length > 0) {
    risks.push(`Leans toward ${avoidHits[0]} — which hasn't worked well for you`);
  }

  // ── Step 3: Genre affinity bonus / penalty ────────────────────────────────
  if (bt.primaryGenre && bt.primaryGenre !== 'general') {
    const affinity = affinities[bt.primaryGenre] ?? 0;
    if (affinity > 0.5) {
      s3_genre = STEP3_BONUS_HIGH;
      if (reasons.length < 2) reasons.push(`Fits a genre you consistently enjoy`);
    } else if (affinity > 0.2) {
      s3_genre = STEP3_BONUS_MED;
    } else if (affinity < -0.35) {
      s3_genre = -STEP3_PENALTY;
      if (risks.length < 1) {
        const label = bt.primaryGenre.replace(/_/g, '/');
        risks.push(`You've had mixed results with ${label} before`);
      }
    }
    // No genre affinity data at all — no bonus or penalty; avoid inflating
  } else {
    // Unknown genre: flag as audit signal, mild penalty
    audit_flags.push('unknown_genre');
    s3_genre = -0.05;
  }

  // ── Step 4: Feedback boosts from "More Like This" signals ────────────────
  if (feedback && bt.primaryGenre) {
    const boost = Math.min(0.10, feedback.genreBoosts[bt.primaryGenre] ?? 0);
    if (boost > 0) {
      s4_feed = boost;
      if (reasons.length < 2) reasons.push(`Similar to books you asked for more of`);
    }
  }

  // ── Step 5: Enrichment signals (secondary layer) ──────────────────────────
  // Small boosts only — enrichment cannot override steps 1–3.
  if (enrichment) {
    const ct = enrichment.consensus_traits;
    const ps = enrichment.popularity_signals;

    // Only check enrichment traits that are valid for this book's form
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
    const enrichedMatches: string[] = [];
    for (const [enrichKey, prefKey] of Object.entries(traitMap)) {
      // Skip if this trait was blacklisted for the book's form
      if (!(prefKey in bt.traits)) continue;
      const enrichVal = ct[enrichKey as keyof typeof ct] ?? 0;
      const userPref  = pref[prefKey] ?? 0;
      if (enrichVal > 0.6 && userPref > 0.35) {
        enrichedMatches.push(prefKey.toLowerCase());
        s5_enr = Math.min(0.08, s5_enr + 0.04);
      }
      if (enrichKey === 'romance_intensity' && enrichVal > 0.6) {
        const avoidRomance = Math.abs(avoid['Romance'] ?? 0);
        if (avoidRomance > 0.25 && risks.length < 1) {
          risks.push(`May lean more romance-forward than your usual favorites`);
          s5_enr -= 0.06;
        }
      }
    }
    if (enrichedMatches.length > 0 && reasons.length < 2) {
      reasons.push(`Readers note strong ${enrichedMatches[0]} — which fits your profile`);
    }

    // Small quality signal (well-reviewed books only)
    const ratingsCount = ps.ratings_count ?? 0;
    const avgRating    = ps.average_rating ?? 0;
    if (ratingsCount >= 1000 && avgRating >= 4.2) {
      s5_enr = Math.min(0.08, s5_enr + 0.03);
    }

    if ((ct.pacing ?? 0) < 0.2 && (pref['Pacing'] ?? 0) > 0.5 && risks.length < 1) {
      risks.push(`This appears slower-paced than the books you rate highest`);
    }
  }

  // Fallback reason from audience signals (last resort)
  if (enrichment && enrichment.audience_signals.length > 0 && reasons.length === 0) {
    reasons.push(enrichment.audience_signals[0]);
  }

  // ── Step 6: Metadata confidence penalty ───────────────────────────────────
  // Books with thin metadata cannot be accurately scored — down-weight them
  // so they don't crowd out well-described candidates.
  const metaQuality = assessMetadataQuality(book);
  if (metaQuality === 'weak') {
    s6_meta_pen = -0.12;
    audit_flags.push('weak_metadata');
  } else if (metaQuality === 'moderate') {
    s6_meta_pen = -0.04;
  }

  // ── Classic-drift audit flag ───────────────────────────────────────────────
  const subjLower = (book.subjects ?? []).join(' ').toLowerCase();
  const isClassicDrift = [...CLASSIC_DRIFT_SUBJECTS].some(sig => subjLower.includes(sig));
  if (isClassicDrift) {
    audit_flags.push('classic_signal');
    s6_meta_pen -= 0.06;
  }

  // ── Step 7: Dense-import lane calibration ─────────────────────────────────
  // For users with a well-established repeated reading pattern, penalise books
  // that sit outside their dominant lanes and replace generic trait-match
  // reasons with lane-aware language.
  //
  // Key rules:
  //   • Literary / canon drift   → hard penalty when literary is NOT a dominant lane
  //   • Hard-boiled noir drift   → hard penalty when user's mystery subtype is contemporary_thriller
  //   • Philosophy / spiritual   → penalty when user's dominant lanes are commercial
  //   • Modern commercial prior  → small boost when book matches commercial dominant lane
  const det = profile.det_lanes;
  if (det?.dominant_lanes && det.dominant_lanes.length > 0) {
    const bookLane = detectBookLane(book);

    // Lane-aware explanation (replaces generic trait-match text when available)
    if (bookLane && det.dominant_lanes.includes(bookLane)) {
      const laneReason = LANE_REASON[bookLane];
      if (laneReason) {
        reasons.unshift(laneReason);
      }
    }

    // ── Literary / classic drift penalty ────────────────────────────────────
    // If the book is literary and the user's dominant lanes are commercial, penalise.
    const bookIsLiterary = bookLane === 'literary'
      || bt.primaryGenre === 'literary'
      || subjLower.includes('literary fiction');
    const userHasLiteraryLane = det.dominant_lanes.includes('literary');
    if (bookIsLiterary && !userHasLiteraryLane && det.commercial_prior > 0.5) {
      s6_meta_pen -= 0.18;
      audit_flags.push('literary_drift');
      if (risks.length < 1) risks.push('Leans more literary than your strongest recurring reads');
    }

    // ── Hard-boiled noir penalty for contemporary-thriller users ────────────
    if (det.mystery_subtype === 'contemporary_thriller') {
      const bookSubtype = detectBookMysterySubtype(book);
      if (bookSubtype === 'hard_boiled_noir') {
        s6_meta_pen -= 0.20;
        audit_flags.push('noir_drift');
        if (risks.length < 1) risks.push('Hard-boiled noir — different feel from the modern suspense you rate highest');
      }
    }

    // ── Philosophy / spiritual drift penalty ────────────────────────────────
    // Spiritual memoir (e.g. Autobiography of a Yogi) contaminates memoir lanes;
    // philosophy contaminates literary lanes — penalise unless user explicitly has
    // those as dominant lanes.
    const isPhi = isPhilosophyOrSpiritual(book);
    if (isPhi && !det.dominant_lanes.includes('memoir_nonfiction') && !det.dominant_lanes.includes('literary')) {
      s6_meta_pen -= 0.15;
      audit_flags.push('philosophy_drift');
      if (risks.length < 1) risks.push('Philosophical or spiritual focus — different territory from your usual reads');
    }

    // ── Modern commercial prior — small boost ────────────────────────────────
    if (bookLane && COMMERCIAL_LANES.has(bookLane as DeterministicLane) && det.commercial_prior > 0.6) {
      s6_meta_pen = Math.min(0, s6_meta_pen) + 0.05;
    }
  }

  // ── Final score ───────────────────────────────────────────────────────────
  const rawScore   = s1_trait + s2_avoid + s3_genre + s4_feed + s5_enr + s6_meta_pen;
  const finalScore = Math.max(0, Math.min(1, rawScore));

  // Confidence follows profile tier + score magnitude (thresholds adjusted for
  // the recalibrated scale where max ~0.78)
  let confidence: 'low' | 'medium' | 'high';
  if (profile.tier >= 3 && finalScore > 0.55)      confidence = 'high';
  else if (profile.tier >= 2 && finalScore > 0.35) confidence = 'medium';
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
      metadata_penalty: fmt(s6_meta_pen),
      raw_score:        fmt(rawScore),
      final_score:      fmt(finalScore),
      book_form:        bt.bookForm,
      audit_flags,
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
  const hygiene = applyHygiene(
    all,
    enrichmentMap,
    profile.liked_authors ?? [],
    profile.det_lanes?.dominant_lanes,
  );

  // ── Apply dismissals from feedback ────────────────────────────────────────
  let filtered = hygiene.passed;
  if (feedback?.dismissedIds.size) {
    filtered = filtered.filter(b => {
      if (b.external_id && feedback.dismissedIds.has(b.external_id)) return false;
      if (b._source === 'catalog' && feedback.dismissedIds.has(b.id))  return false;
      return true;
    });
  }

  const det = profile.det_lanes;
  const isDense = !!(det?.is_dense_import && det.dominant_lanes.length > 0);

  const retrieval_trace: RetrievalTrace = {
    top_genres_used:      olResult.top_genres_used,
    top_traits_used,
    liked_subjects_used:  olResult.liked_subjects_used,
    liked_authors_used:   olResult.liked_authors_used,
    ol_queries:           olResult.ol_queries,
    hygiene_excluded:     hygiene.excluded,
    enriched_count:       enrichmentMap.size,
    // Dense-import mode debug
    ...(isDense && det ? {
      dense_import_mode:    true,
      detected_lanes:       det.dominant_lanes,
      repeated_authors_used: det.repeated_liked_authors.slice(0, 3),
    } : {}),
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

// ── Expert-layer orchestration ────────────────────────────────────────────────
//
// Runs the deterministic pipeline then optionally overlays the expert reasoning
// layer based on the user's entitlement and the canRunExpertRecs decision.
// Results from both layers are returned in a unified RankedRecsResult so callers
// can render either deterministic or expert UI without branching on the pipeline.
//
// Expert layer maximum candidates sent to judging: capped at EXPERT_JUDGE_CAP to
// keep the heuristic complexity linear and safe for a future LLM-backed version.

const EXPERT_JUDGE_CAP = 20;

export async function getPersonalizedRecsWithExpert(
  client:      SupabaseClient,
  userId:      string,
  profile:     TasteProfile,
  entitlement: RecEntitlement,
  limit        = 5,
  feedback?:   FeedbackContext,
): Promise<RankedRecsResult> {
  // ── Step 1: Deterministic pipeline (always runs) ──────────────────────────
  const { candidates, enrichmentMap, retrieval_trace } =
    await getCandidateBooks(client, userId, profile, feedback);
  const baseResult = getRankedRecs(candidates, profile, limit, feedback, enrichmentMap, retrieval_trace);

  // ── Step 2: Expert access decision ───────────────────────────────────────
  const decision = canRunExpertRecs(entitlement, profile);

  if (!decision.allowed) {
    // Return deterministic result with decision context for UI messaging
    return {
      ...baseResult,
      meta: {
        ...baseResult.meta,
        mode:            'deterministic',
        expert_decision: decision,
        is_from_cache:   false,
        cache_built_at:  null,
      },
    };
  }

  // ── Step 3: Cache check (skip rebuild if results are still fresh) ─────────
  const cacheCheck = await loadCachedRecs(client, userId);

  if (cacheCheck.hit && cacheCheck.entry?.mode === 'expert') {
    const { count: feedbackCount } = await client
      .from('rec_feedback')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const currentSignals = buildSignalSnapshot(
      profile.strongSignalCount ?? 0,
      feedbackCount ?? 0,
      (profile.evidence.imported_books_count ?? 0) > 0,
    );

    const rebuildDecision = shouldRebuild(cacheCheck.entry, currentSignals);

    if (!rebuildDecision.should_rebuild) {
      // Return cached expert result
      const cachedRecs = cacheCheck.entry.rec_set;
      return {
        recs:  cachedRecs,
        meta: {
          ...baseResult.meta,
          mode:            'expert',
          reader_thesis:   cacheCheck.entry.reader_thesis,
          expert_decision: decision,
          is_from_cache:   true,
          cache_built_at:  cacheCheck.entry.built_at,
        },
      };
    }

    if (__DEV__) {
      console.log('[EXPERT] Cache rebuild triggered:', rebuildDecision.reason);
    }
  }

  // ── Step 4: Build evidence pack ───────────────────────────────────────────
  // Build a score map from deterministic results for the evidence pack
  const detScores = new Map<string, number>();
  for (const r of baseResult.recs) {
    const key = r.external_id ?? r.id;
    detScores.set(key, r.score);
    detScores.set(r.id, r.score);
  }
  // Also score the broader candidate pool (not just top-5) for better coverage
  const allScored = getRankedRecs(candidates, profile, EXPERT_JUDGE_CAP, feedback, enrichmentMap, retrieval_trace);
  for (const r of allScored.recs) {
    const key = r.external_id ?? r.id;
    if (!detScores.has(key)) detScores.set(key, r.score);
    if (!detScores.has(r.id)) detScores.set(r.id, r.score);
  }

  const pack = await buildEvidencePack(
    client, userId, profile,
    candidates.slice(0, EXPERT_JUDGE_CAP),
    enrichmentMap,
    detScores,
  );

  // ── Step 5: Build reader thesis ───────────────────────────────────────────
  const thesis = buildReaderThesis(pack);

  // ── Step 6: Judge candidates ──────────────────────────────────────────────
  const judged = new Map<string, CandidateJudgment>();
  for (const candidate of pack.candidates.slice(0, EXPERT_JUDGE_CAP)) {
    judged.set(candidate.id, judgeCandidateFit(thesis, candidate, pack));
  }

  // ── Step 7: Compose expert recommendation set ─────────────────────────────
  const expertResult = composeRecommendationSet(thesis, judged, pack.candidates, allScored.recs, limit);

  // ── Step 8: Convert ExpertPick → ScoredBook for unified rendering ─────────
  const expertRecs: ScoredBook[] = expertResult.picks.map((pick, i) => {
    // Find the base rec or candidate for metadata
    const base = allScored.recs.find(r => r.id === pick.candidate_id || r.external_id === pack.candidates.find(c => c.id === pick.candidate_id)?.external_id);
    const cand = pack.candidates.find(c => c.id === pick.candidate_id);

    if (base) {
      return {
        ...base,
        score:    pick.expert_score > 0 ? pick.expert_score : base.score,
        reasons:  pick.why,
        risks:    pick.risks,
        confidence: pick.expert_score >= 0.5 ? 'high' : pick.expert_score >= 0.3 ? 'medium' : 'low',
        _debug:   { pool_size: allScored.meta.pool_size, rank: i + 1 },
        _score_breakdown: {
          ...base._score_breakdown,
          final_score: pick.expert_score > 0 ? pick.expert_score : base.score,
        },
      } as ScoredBook;
    }

    // Fallback: construct minimal ScoredBook from candidate data
    return {
      id:           pick.candidate_id,
      title:        pick.title,
      author:       pick.author,
      cover_url:    cand ? null : null,
      external_id:  cand?.external_id ?? null,
      subjects:     cand?.subjects ?? [],
      page_count:   cand?.page_count ?? null,
      description:  null,
      _source:      (cand?.source as import('./recommender').CandidateSource) ?? 'catalog',
      _retrieval_reason: cand?.retrieval_reason ?? '',
      score:        pick.expert_score,
      confidence:   'medium' as const,
      reasons:      pick.why,
      risks:        pick.risks,
      _score_breakdown: {
        trait_alignment:  0,
        avoided_penalty:  0,
        genre_bonus:      0,
        feedback_boost:   0,
        enrichment_bonus: 0,
        metadata_penalty: 0,
        raw_score:        pick.expert_score,
        final_score:      pick.expert_score,
        book_form:        null,
        audit_flags:      [],
      },
      _debug: { pool_size: allScored.meta.pool_size, rank: i + 1 },
    } as ScoredBook;
  });

  // ── Step 9: Consume entitlement & persist cache ───────────────────────────
  await consumeExpertRefresh(client, userId, decision, entitlement);

  const { count: feedbackCount } = await client
    .from('rec_feedback')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const signals = buildSignalSnapshot(
    profile.strongSignalCount ?? 0,
    feedbackCount ?? 0,
    (profile.evidence.imported_books_count ?? 0) > 0,
  );

  await persistRecCache(
    client, userId, expertRecs, 'expert', signals, thesis,
    { rebuild_reason: 'fresh_build', judged_count: judged.size, omitted_count: expertResult.omitted.length },
  );

  if (__DEV__) {
    console.log('[EXPERT] Thesis:', {
      dominant_lanes:   thesis.dominant_lanes.map(l => `${l.label} (${l.strength.toFixed(2)})`),
      center_of_gravity: thesis.center_of_gravity,
      guardrails:       thesis.recommendation_guardrails.length,
      confidence:       thesis.confidence,
    });
    console.log('[EXPERT] Result:', {
      picks:         expertResult.picks.map(p => ({ title: p.title, label: p.fit_label, score: p.expert_score.toFixed(2), lane: p.lane })),
      omitted_count: expertResult.omitted.length,
      decision:      decision.reason,
    });
  }

  return {
    recs:  expertRecs,
    meta: {
      ...baseResult.meta,
      mode:            'expert',
      reader_thesis:   thesis,
      expert_result:   expertResult,
      expert_decision: decision,
      is_from_cache:   false,
      cache_built_at:  null,
    },
  };
}
