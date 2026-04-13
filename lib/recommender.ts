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
import { computeCenterOfGravity, classifyMarketPosition, computeFitClass } from './fitClassifier';
import type { MarketPosition }       from './fitClassifier';
import {
  isIntentActive,
  passesIntentHardFilters,
  getIntentExclusionReason,
  computeIntentBoost,
  buildIntentSuffix,
  evaluateHardFilters,
  computeIntentBoostWithReasons,
} from './nextReadIntent';
import type { NextReadIntent, IntentBookTrace, IntentSetSummary } from './nextReadIntent';
import type { FeedbackContext }      from './recFeedback';
import type { BookEnrichmentProfile } from './bookEnrichment';
import { getEnrichmentForCandidates } from './bookEnrichment';
import type { RecEntitlement, ExpertAccessDecision }         from './recEntitlement';
import { canRunExpertRecs, consumeExpertRefresh }             from './recEntitlement';
import type { ReaderThesis, ExpertRecResult, CandidateJudgment } from './expertRec';
import { buildReaderThesis, judgeCandidateFit, composeRecommendationSet } from './expertRec';
import { buildEvidencePack }                                  from './evidencePack';
import { loadCachedRecs, persistRecCache, shouldRebuild, buildSignalSnapshot } from './recCache';
import { applyIntegrityLayer, buildSeriesReadSet, buildSeriesProgress, buildSeriesPositionsRead, stripTitleSubtitle, getEligibleSeriesSeeds } from './recommendationIntegrity';

// ── Quality gate constants ─────────────────────────────────────────────────────

const MIN_CANDIDATES    = 5;
const MIN_PASS_SCORE    = 0.12;
const MIN_PASSING_BOOKS = 2;

// ── Composition constants ───────────────────────────────────────────────────
// Applied in the set-composition engine after scoring and CoG classification.

// Score reduction per additional book from the same author (effective score only).
// The 1st book from an author: no discount.  2nd book: −0.04.  3rd: −0.08.  Etc.
// This orders same-author books by quality and suppresses sequel/series floods
// without permanently blocking them from the candidate pool.
const CONTINUATION_DISCOUNT_PER_RANK = 0.04;

// ADJACENT books are only surfaced to the user when the CORE pool is small.
// When CORE books ≥ this fraction of the requested limit, ADJACENT books are
// kept in the audit list but not shown in the visible recommendation set.
const ADJACENT_VISIBLE_THRESHOLD_FRAC = 0.5;

// Maximum number of books in the "Continue Reading" editorial bucket.
// One per series (lowest unread position), sorted by score.
const CONT_CAP = 3;

// ── Cache constants ────────────────────────────────────────────────────────────

const CACHE_TTL_MS   = 24 * 60 * 60 * 1000;
const CACHE_MIN_ROWS = 5;
// Version tag embedded in retrieval_reason for every row written to
// rec_candidate_cache.  Increment (v3, v4, …) whenever retrieval logic
// changes in a way that makes old cached candidates unreliable.  The read
// path rejects any row whose retrieval_reason does NOT start with this tag,
// which forces a live OL re-fetch and a fresh cache write.
const CACHE_VERSION  = 'v5:';
// User ID to force full live forensic audit (bypasses both caches, emits
// structured trace logs). Only active in __DEV__ builds.
// Set to an empty string in production to ensure the forensic path never fires
// for any real user. Restore a specific UUID locally during deep debugging only.
const FORENSIC_USER_ID = '';

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
  final_score:      number;   // clamped 0–1 total (after CoG delta)
  book_form:        string | null;   // detected form (poetry/play/etc.)
  audit_flags:      string[];        // any audit flags applied
  // ── Center-of-gravity fit classifier fields (populated in getRankedRecs) ──
  fit_class?:             string;   // core_fit | adjacent_fit | stretch_fit | reject
  market_position?:       string;   // e.g. romantasy, domestic_suspense, classic_canon
  lane_match_strength?:   string;   // strong | weak | none
  repeated_author_match?: boolean;  // author is in user's repeated-liked list
  exception_dependency?:  boolean;  // fit relies on tolerance, not repeated pattern
  cog_score_delta?:       number;   // score adjustment applied: +0.25 / 0 / -0.20 / -9999
  book_lane?:             string | null; // detected DeterministicLane (stored for composition)
  // ── Composition engine fields (populated in set-composition pass) ────────
  continuation_rank?:     number;   // rank among same-author books in pool (1 = best)
  continuation_discount?: number;   // effective-score reduction for sequel suppression
  // ── Recommendation Integrity Layer fields (populated in RIL pass) ─────────
  series_name?:       string | null;  // detected series (e.g. "The Stormlight Archive")
  series_position?:   number | null;  // position in series (1 = starter, 2+ = continuation)
  series_total?:      number | null;  // total books in series — from seriesCatalog only, never inferred
  series_label?:      string | null;  // 'series_starter' | 'series_continuation' | 'series_later_volume'
  series_confidence?: string | null;  // 'high' | 'medium' — how reliable the detection is
  series_method?:     string | null;  // 'curated' | 'title_pattern' | 'description_pattern'
  ril_suppressed?:    boolean;        // true = removed from visible set by RIL
  ril_reason?:        string;         // audit reason for RIL suppression
  // ── Presentation-only annotations (no scoring impact) ────────────────────
  series_max_read?:     number | null;  // actual highest series position the user has completed (from seriesProgress)
  series_is_contiguous?: boolean | null; // true = user read 1..maxRead with no gaps; false = gaps detected
  // ── Saga-level annotations (no scoring impact) ────────────────────────────
  saga_name?:         string | null;   // the saga this series belongs to (null = not part of a saga)
  saga_series_index?: number | null;   // 0-based index of this series in the saga's ordered list
  saga_label?:        'saga_entry' | 'saga_continuation' | 'saga_next_series' | 'saga_skip_ahead' | null;
  author_books_read?: number;          // finished books by this author — for explanation strings only
  // ── Explanation quality (populated in getRankedRecs, after CoG rewrite) ───
  // Based on the evidence actually present in the final reasons[] array —
  // not on score. Used to tier the final discovery feed sort.
  //
  //   strong              — book-specific trait, subject, enrichment, or confirmed-author signal
  //   acceptable_specific — user-history-specific evidence: author repeat (non-core) or
  //                         explicit feedback signal
  //   acceptable_generic  — broad signal only: genre affinity or adjacent market-position context
  //   weak                — only a generic lane/CoG summary; no measured user alignment at all
  explanation_quality?: 'strong' | 'acceptable_specific' | 'acceptable_generic' | 'weak';
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
  // Populated when "Your Next Read" intent is active.
  // Shows exactly how this book was evaluated by the intent layer.
  _intent_trace?: IntentBookTrace;
};

export type QualityGate =
  | 'passed'
  | 'insufficient_pool'
  | 'insufficient_score'
  | 'intent_filtered_empty';  // pool passed but intent filters narrowed it to 0

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
  recs:          ScoredBook[];
  continuations: ScoredBook[];   // "Continue Reading" bucket — next in series already started
  discoveries:   ScoredBook[];   // "Discover Next" bucket — starters, standalones, new picks
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
    // Full candidate audit — all scored candidates before diversity cap.
    // Always populated; use for forensic debugging via the debug panel.
    candidate_audit?:       ScoredBook[];
    // Count of books removed by intent hard filters / exclusions.
    // Present and > 0 when "Your Next Read" intent is active and filtering occurred.
    intent_filtered_count?: number;
    // Set-level intent summary — pool stats before/after intent filtering.
    // Populated whenever intent is active; used by the debug panel.
    intent_summary?:        IntentSetSummary;
  };
};

// CandidateResult — returned by getCandidateBooks; replaces the old plain array.
export type CandidateResult = {
  candidates:       CandidateBook[];
  enrichmentMap:    Map<string, BookEnrichmentProfile>;
  retrieval_trace:  RetrievalTrace;
  seriesReadSet:       Set<string>;              // series names the user has already started
  seriesProgress:      Map<string, number>;      // series name → highest position the user has read
  seriesPositionsRead: Map<string, Set<number>>; // series name → all individual positions completed (for contiguity)
  authorReadCounts:    Map<string, number>;      // author key → truly-read book count (presentation only)
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

// Set of LANE_REASON values for O(1) lookup — used by the CoG reason rewrite
// to filter out generic lane-level reasons that would crowd out specific trait reasons.
const LANE_REASON_VALUES = new Set(Object.values(LANE_REASON));

// ── Explanation quality classifier ────────────────────────────────────────────
//
// Classifies each recommendation by the strength of the evidence behind its
// explanation — not by score alone. Classification happens immediately after the
// CoG rewrite (when reasons[] is finalised) and is stored in _score_breakdown.
// The composition engine uses it to sort WEAK cards to the back of the visible
// feed while still keeping them in the pool (so the feed never starves).
//
//   strong     — book-specific trait, subject, enrichment, or confirmed-author
//                signal exists; buildExplanation() in RecCard produces specific copy
//   acceptable — some non-trivial signal: feedback, genre affinity, or a
//                market-position-specific (non-generic) adjacent explanation
//   weak       — only a generic lane/CoG summary; no book-specific signal at all;
//                buildExplanation() would fall back to lane-level copy such as
//                "A strong fit for your taste in romantic fantasy."

// Lane-level fit_explanation strings from buildCoreExplanation() in fitClassifier.ts.
// These describe the user's reading lane rather than anything specific to this book.
// Must be kept in sync with GENERIC_COG_EXPLANATIONS in components/RecCard.tsx.
const GENERIC_FIT_EXPLANATION_SET = new Set([
  'Feels closest to the romantic fantasy series you return to most',
  'Fits the fantasy and speculative fiction you return to most',
  'Matches the twisty, readable suspense you return to most often',
  'Aligns with the emotionally driven romance you consistently enjoy',
  'Feels close to the contemporary, character-driven fiction you consistently enjoy',
  'Sits at the heart of the narrative nonfiction you read most',
  'Aligns with the literary fiction you consistently pick up',
  'Fits the dark, atmospheric fiction you return to consistently',
  'Strongly aligned with your most repeated reading patterns',
  'A reasonable next read that sits near your reading center',
  'A reasonable match based on your reading patterns',
]);


export type ExplanationQuality = 'strong' | 'acceptable_specific' | 'acceptable_generic' | 'weak';

// Minimum trait_alignment score required for a single-trait reason ("Matches your
// appreciation for …") to qualify as STRONG rather than acceptable_specific.
// A single trait match at low confidence is a coincidence, not a pattern.
// Multi-trait reasons ("Aligns with your preference for …") are unconditionally STRONG
// because they require ≥2 independent trait matches.
const SINGLE_TRAIT_STRONG_FLOOR = 0.25;

function classifyExplanationQuality(
  reasons:             string[],
  fitClass:            string,
  repeatedAuthorMatch: boolean,
  traitAlignment:      number,   // raw trait_alignment from ScoreBreakdown
): ExplanationQuality {
  const r0 = reasons[0] ?? null;
  const r1 = reasons[1] ?? null;

  // ── STRONG ─────────────────────────────────────────────────────────────────
  // Repeated author confirmed as core fit: author evidence AND lane alignment
  // both fire — the strongest possible signal; user has returned to this author
  // and the book sits squarely in their dominant lane.
  if (repeatedAuthorMatch && fitClass === 'core_fit') return 'strong';

  // Book-specific signal in reasons[1] — split by prefix to allow score-gating
  // on the weaker single-trait prefix:
  //
  // (a) "Aligns with your preference for …" — Step 1a ≥2 trait matches.
  //     Multiple independent evidence signals → unconditionally STRONG.
  //
  // (b) "Readers note strong …" — Step 5 enrichment consensus trait.
  //     Market-sourced agreement on a trait → unconditionally STRONG.
  //
  // (c) "Covers themes of …" — Step 1b subject overlap ≥2 subjects.
  //     Two subject matches is a real measured alignment → unconditionally STRONG.
  //
  // (d) "Matches your appreciation for …" — Step 1a exactly 1 trait match.
  //     A single trait at low score is a coincidence, not a pattern.
  //     Only STRONG when trait_alignment >= SINGLE_TRAIT_STRONG_FLOOR (0.25).
  //     Below the floor → acceptable_specific (real signal, insufficient depth).
  if (r1 !== null) {
    if (
      r1.startsWith('Aligns with your preference for') ||
      r1.startsWith('Readers note strong')            ||
      r1.startsWith('Covers themes of')
    ) {
      return 'strong';
    }
    if (r1.startsWith('Matches your appreciation for')) {
      return traitAlignment >= SINGLE_TRAIT_STRONG_FLOOR ? 'strong' : 'acceptable_specific';
    }
  }

  // Named-author fit_explanation in r0: "By {Author}, a consistent favorite…"
  // These come from buildAuthorCoreExplanation() and carry real author-repeat evidence.
  if (r0 !== null && r0.startsWith('By ')) return 'strong';

  // ── ACCEPTABLE_SPECIFIC ────────────────────────────────────────────────────
  // Concrete user-history evidence, but not strong enough for STRONG:
  //
  // (a) Author repeat outside core fit — user has returned to this author, but
  //     the book is in an adjacent lane so lane evidence doesn't confirm dominant
  //     alignment. The author repeat is still a genuine measured signal.
  if (repeatedAuthorMatch) return 'acceptable_specific';

  // (b) Explicit feedback: user asked for more books like another title.
  //     This is a direct behavioural signal — the user manually expressed intent.
  if (r1 === 'Similar to books you asked for more of') return 'acceptable_specific';

  // ── ACCEPTABLE_GENERIC ─────────────────────────────────────────────────────
  // Broad signal only — no book-specific or user-history-specific evidence:
  //
  // (a) Genre affinity: a measured (weak) genre preference from Step 3.
  //     The user reads this genre, but nothing specific to this book or this
  //     user's demonstrated choices says it's a strong fit.
  if (r1 === 'Fits a genre you consistently enjoy') return 'acceptable_generic';

  // (b) Non-generic adjacent fit_explanation in r0.
  //     Strings from buildAdjacentExplanation() give market-position context
  //     (e.g. "Closer to the thriller and suspense you read most") but carry
  //     no book-specific or user-history measurement. They're honest adjacency
  //     framing, not evidence. Exclude "By …" (already handled above) and
  //     GENERIC_FIT_EXPLANATION_SET strings (already handled in WEAK).
  if (r0 !== null && !GENERIC_FIT_EXPLANATION_SET.has(r0) && !r0.startsWith('By ')) {
    return 'acceptable_generic';
  }

  // ── WEAK ───────────────────────────────────────────────────────────────────
  // r0 is a generic lane/CoG summary and r1 adds no specific signal.
  // The only justification is the book's genre or lane — not any measured
  // alignment with the user's actual reading choices or preferences.
  return 'weak';
}

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
  // Marketing/awards tags that carry no meaningful genre or quality signal
  'bestseller', 'new york times bestseller', 'bestsellers', 'award winner',
  'pulitzer prize', 'oprah book club', 'book club', 'book of the month',
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
  // Ideological / political fiction that drifts into literary and dystopian searches
  'ayn rand', 'george orwell',
  // Spiritual / yoga autobiographies that drift into memoir searches
  'paramahansa yogananda', 'swami vivekananda', 'sri aurobindo',
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
      // Hard-reject pre-1950 books from broad subject searches: they are almost
      // always public-domain or canonical-literary classics that contaminate
      // modern commercial recommendations (Anthem 1938, For Whom the Bell Tolls
      // 1940, Brave New World 1932, The Sun Also Rises 1926 all blocked here).
      .filter(doc => !doc.first_publish_year || doc.first_publish_year >= 1950)
      .map((doc): CandidateBook => ({
        id:                `ol:${doc.key}`,
        title:             stripTitleSubtitle(doc.title ?? ''),
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
      // Same pre-1950 block applied to author searches — prevents old spy/noir
      // works (Casino Royale 1953 exempt, Fleming's later works in) while still
      // rejecting pulp-era authors whose earliest works predate 1950.
      .filter(doc => !doc.first_publish_year || doc.first_publish_year >= 1950)
      .map((doc): CandidateBook => ({
        id:                `ol:${doc.key}`,
        title:             stripTitleSubtitle(doc.title ?? ''),
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

// ── OL exact title+author lookup ──────────────────────────────────────────────
//
// Used by getExactSeriesCandidates to fetch the precise canonical book for
// series seeding.  Unlike the broad author/subject searches, this targets a
// specific title so it reliably surfaces low-popularity mid-sequence books
// (e.g. "Fool's Errand" by Robin Hobb — Tawny Man #1) that author-search
// `sort=rating` would bury past the top-12 limit.
//
// Returns the single best OL match (first result).  Silently returns [] on any
// network / parse error so the rest of retrieval is never blocked.
async function fetchOLByTitle(
  title:    string,
  author:   string,
  series:   string,
  position: number,
): Promise<CandidateBook[]> {
  try {
    const url =
      `https://openlibrary.org/search.json` +
      `?title=${encodeURIComponent(title)}` +
      `&author=${encodeURIComponent(author)}` +
      `&fields=key,title,author_name,cover_i,number_of_pages_median,subject,first_publish_year,language` +
      `&limit=3`;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 4000);
    const res        = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const json = await res.json() as { docs?: OLDoc[] };

    return (json.docs ?? [])
      .filter(doc => doc.key && doc.title)
      .slice(0, 1)  // take only the top OL hit — exact query should rank it first
      .map((doc): CandidateBook => ({
        id:                `ol:${doc.key}`,
        title:             stripTitleSubtitle(doc.title ?? ''),
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
        _retrieval_reason: `exact_series_seed:${series}#${position}`,
      }));
  } catch {
    return [];
  }
}

// ── Source A: Catalog ─────────────────────────────────────────────────────────

// Stable normalized key used for the finished/DNF safety-net exclusion.
// Applied identically to both the user's library and every recommendation candidate
// so that Goodreads-imported books (which often carry Google Books external_ids
// instead of OL keys) are caught even when external_id matching fails.
//
// Normalization steps (in priority order):
//   1. Strip subtitle ("Fool's Fate: A Tawny Man Novel" → "Fool's Fate")
//   2. Strip parentheticals ("Ship of Magic (Liveship Traders, #1)" → "Ship of Magic")
//   3. Lowercase + collapse punctuation + collapse whitespace
//   4. Invert "Last, First" author format (Goodreads export convention)
//
// Key format: "<normalized author>::<normalized title>"
function normBookKey(title: string, author: string): string {
  const strippedTitle = stripTitleSubtitle(title);
  const tRaw = strippedTitle
    .toLowerCase()
    .replace(/['''\u2018\u2019]/g, '')   // strip apostrophes
    .replace(/\s*\([^)]*\)/g, '')        // strip remaining parentheticals
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Strip leading articles so "The Mad Ship" (library) == "Mad Ship" (OL).
  // This is the primary normalization that allows Goodreads-imported titles
  // stored with "The/A/An" prefix to match their OL counterparts.
  const t = tRaw.replace(/^(the|an?) /, '');

  // Handle Goodreads "Last, First" export format by inverting before stripping
  const rawA = /^[^,]+,\s*.+$/.test(author)
    ? author.replace(/^([^,]+),\s*(.+)$/, '$2 $1')
    : author;
  const a = rawA
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return `${a}::${t}`;
}

type LocalResult = {
  candidates:             CandidateBook[];
  readIds:                Set<string>;
  readExternalIds:        Set<string>;
  readBooks:              Array<{ title: string; author: string }>; // truly-read books only — for series-started detection
  finishedReadBooks:      Array<{ title: string; author: string }>; // finished-only — for author affinity count
  trueReadExternalIds:    Set<string>;  // external IDs of truly-read books — for OL supplement
  finishedDnfNormalized:  Set<string>;  // normBookKey() for ALL finished + DNF books — safety-net exclusion layer
  finishedDnfCount:       number;       // raw count for forensic logging
};

async function getLocalCandidates(
  client: SupabaseClient,
  userId: string,
): Promise<LocalResult> {
  // ── Two independent DB queries run in parallel ────────────────────────────
  // user_books has no query-time dependency on books and vice versa.
  // Client-side filtering (readIds.has) is applied after both resolve.
  const [{ data: userBooks }, { data: dbBooks }] = await Promise.all([
    client
      .from('user_books')
      .select('book_id, status, finished_at, book:books(external_id, title, author)')
      .eq('user_id', userId)
      .is('deleted_at', null),
    client
      .from('books')
      .select('id, title, author, cover_url, external_id, subjects, page_count, description, isbn')
      .or('subjects.not.is.null,description.not.is.null,isbn.not.is.null')
      .limit(120),
  ]);

  type UBRow = {
    book_id:     string;
    status:      string | null;
    finished_at: string | null;
    book: { external_id: string | null; title: string | null; author: string | null } | null;
  };
  const ubRows = ((userBooks ?? []) as unknown) as UBRow[];

  // "Truly read" = the user has actually read (or is currently reading) the book.
  // want_to_read / saved-only entries must NOT be treated as evidence of series progress.
  //   finished   → clearly read
  //   reading    → in-progress counts — user has started the series
  //   dnf        → excluded — user abandoned; do not count as "series started"
  //   want_to_read / null → excluded — library presence ≠ series started
  function isTrulyRead(status: string | null): boolean {
    return status === 'finished' || status === 'reading';
  }

  // All library book IDs — used to EXCLUDE books the user has from the candidate pool.
  // This stays broad (all statuses) so we never re-recommend saved/want-to-read books.
  const readIds         = new Set(ubRows.map(r => r.book_id));
  const readExternalIds = new Set(
    ubRows.map(r => r.book?.external_id).filter((x): x is string => !!x)
  );

  // Truly-read books only — the ONLY set that feeds seriesReadSet.
  // Filtered to finished / reading status so want_to_read entries cannot
  // fraudulently mark a series as "started".
  const readBooks = ubRows
    .filter(r => isTrulyRead(r.status))
    .map(r => ({ title: r.book?.title ?? '', author: r.book?.author ?? '' }))
    .filter(b => b.title.length > 0 && b.author.length > 0);

  // Finished-only books — used for author affinity counts in explanation strings.
  // Deliberately excludes "reading" so "You've read N books by X" only counts
  // completed books, not the one the user is currently in the middle of.
  const finishedReadBooks = ubRows
    .filter(r => r.status === 'finished')
    .map(r => ({ title: r.book?.title ?? '', author: r.book?.author ?? '' }))
    .filter(b => b.title.length > 0 && b.author.length > 0);

  // External IDs of truly-read books — used in the OL supplement so we only
  // credit series from books the user has actually read (not just saved).
  const trueReadExternalIds = new Set(
    ubRows
      .filter(r => isTrulyRead(r.status))
      .map(r => r.book?.external_id)
      .filter((x): x is string => !!x)
  );

  // Safety-net exclusion set — normalized title+author keys for every book the
  // user has finished OR DNF'd.  This catches Goodreads-imported books whose
  // books.external_id is a Google Books ID (or NULL) rather than an OL key,
  // which means external_id matching alone would silently miss them when the
  // same work returns from an OL query under a different identifier.
  const finishedDnfRows = ubRows.filter(
    r => r.status === 'finished' || r.status === 'dnf'
  );
  const finishedDnfNormalized = new Set(
    finishedDnfRows
      .filter(r => r.book?.title && r.book?.author)
      .map(r => normBookKey(r.book!.title!, r.book!.author!))
  );
  const finishedDnfCount = finishedDnfRows.length;

  // dbBooks arrived from the parallel Promise.all above — no additional await needed.
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

  return { candidates, readIds, readExternalIds, readBooks, finishedReadBooks, trueReadExternalIds, finishedDnfNormalized, finishedDnfCount };
}

// ── Source B: Cached external ─────────────────────────────────────────────────

type CacheResult = {
  candidates: CandidateBook[];
  isFresh:    boolean;
} | null;

async function getCachedExternalCandidates(
  client:                  SupabaseClient,
  userId:                  string,
  excludeExternalIds:      Set<string>,
  additionalExcludeIds?:   Set<string>,
): Promise<CacheResult> {
  // Forensic mode: bypass candidate cache entirely, force live OL fetch
  if (__DEV__ && userId === FORENSIC_USER_ID) {
    console.log('[FORENSIC] rec_candidate_cache BYPASSED for', userId);
    return null;
  }
  try {
    const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    const { data, error } = await client
      .from('rec_candidate_cache')
      .select('external_id, source, retrieval_reason, title, author, cover_url, subjects, page_count, cached_at')
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
      cached_at:        string;
    };

    const rows = (data ?? []) as CacheRow[];

    // Version-gate: only accept rows written by the current retrieval logic.
    // Every row written by persistOLCandidates is tagged with CACHE_VERSION
    // (e.g. "v2:") as a prefix on retrieval_reason.  Any row without that
    // prefix was written by old code and must be treated as a cache miss so
    // the engine performs a fresh live OL fetch under the updated query set.
    const validRows = rows.filter(r =>
      r.retrieval_reason?.startsWith(CACHE_VERSION)
    );

    if (__DEV__) {
      const newest = rows[0]?.cached_at ?? '(none)';
      console.log(
        '[CACHE DIAG] cutoff:', cutoff,
        '| CACHE_VERSION:', CACHE_VERSION,
        '| rows_from_db:', rows.length,
        '| valid_rows (v' + CACHE_VERSION + '):', validRows.length,
        '| newest_cached_at:', newest,
        '| reasons_seen:', [...new Set(rows.map(r => r.retrieval_reason?.split(':')[0] ?? 'null'))].join(','),
      );
    }

    const isFresh = validRows.length >= CACHE_MIN_ROWS;

    const candidates: CandidateBook[] = validRows
      .filter(r =>
        !excludeExternalIds.has(r.external_id) &&
        !(additionalExcludeIds?.has(r.external_id))
      )
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
  candidates:           CandidateBook[];
  ol_queries:           string[];
  top_genres_used:      string[];
  liked_subjects_used:  string[];
  liked_authors_used:   string[];
  excluded_read_books:  Array<{ title: string; author: string }>;
};

// ── Session-level OL candidate cache ─────────────────────────────────────────
// Memoises live OL fetch results for the lifetime of an app session (10 min).
// Serves two populations:
//   1. Non-forensic users: rec_candidate_cache (DB, 24h) already handles warm
//      revisits; this adds a faster fallback when the DB cache is race-missed.
//   2. Forensic user: DB cache is always bypassed; this module-level cache is
//      the ONLY fast-path for warm background refreshes in that mode.
// Invalidated when strongSignalCount changes (user rated/tagged new books).
type OLSessionCache = {
  userId:      string;
  result:      OLResult;
  signalCount: number;
  loadedAt:    number;
};
let _olCandidateSession: OLSessionCache | null = null;
const OL_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Exported so exhaustion-bypass reload can force a fresh OL fetch instead of
// re-using the same session cache that produced only acted-on candidates.
export function clearOLSessionCache(): void {
  _olCandidateSession = null;
}

async function getOLCandidates(
  profile:              TasteProfile,
  readExternalIds:      Set<string>,
  excludeExternalIds:   Set<string>,
  trueReadExternalIds?: Set<string>,  // truly-read subset — for OL supplement (series-started detection only)
): Promise<OLResult> {
  const affinities = profile.genre_affinities ?? {};
  const det        = profile.det_lanes;
  // Dense mode: use actual pattern evidence, NOT the import flag (is_dense_import can
  // be false when the source column is mismatched, even for a 265-book Goodreads user).
  // A user is "dense" for retrieval if they have ≥2 dominant lanes OR ≥3 repeated authors.
  const isDense    = !!(det && (det.dominant_lanes.length >= 2 || det.repeated_liked_authors.length >= 3));

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
    // ── 1. Genre affinities: always top-3, plus any with affinity > 0.4 ──
    // Rationale: a user whose #4 genre (e.g. thriller_mystery) has 0.5+
    // affinity should still get OL candidates in that genre, otherwise the
    // local catalog's old spy/noir books go uncontested at scoring time.
    const sortedAffinities = Object.entries(affinities)
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1]);
    let topGenres = sortedAffinities
      .filter((entry, i) => i < 3 || entry[1] > 0.4)
      .slice(0, 5)
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
  // Books returned by OL that the user has already read — carry title+author
  // so callers can supplement buildSeriesReadSet when the DB join is incomplete.
  const excludedReadBooksMap = new Map<string, { title: string; author: string }>();

  for (const set of resultSets) {
    for (const book of set) {
      const key = book.external_id ?? book.id;
      if (seen.has(key)) continue;
      if (exclude.has(key)) {
        // Only collect if the user has TRULY READ this OL book (not just saved it).
        // Use trueReadExternalIds when available; fall back to readExternalIds for
        // callers that don't distinguish (e.g. cached retrieval path).
        const trulyReadSet = trueReadExternalIds ?? readExternalIds;
        if (book.external_id && trulyReadSet.has(book.external_id) && book.title && book.author) {
          excludedReadBooksMap.set(key, { title: book.title, author: book.author });
        }
        continue;
      }
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
    candidates:           merged,
    ol_queries,
    top_genres_used,
    liked_subjects_used,
    liked_authors_used,
    excluded_read_books:  [...excludedReadBooksMap.values()],
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
    const now = new Date().toISOString();
    const rows = books
      .filter(b => b.external_id)
      .map(b => {
        // Prefix every retrieval_reason with CACHE_VERSION so the read path
        // can distinguish rows written by this version of the logic from rows
        // written by older code.  The prefix is stripped before the reason is
        // used for display or trace logging.
        const reason = b._retrieval_reason.startsWith(CACHE_VERSION)
          ? b._retrieval_reason
          : `${CACHE_VERSION}${b._retrieval_reason}`;
        return {
          user_id:          userId,
          external_id:      b.external_id!,
          source:           b._source,
          retrieval_reason: reason,
          title:            b.title,
          author:           b.author,
          cover_url:        b.cover_url,
          subjects:         b.subjects,
          page_count:       b.page_count,
          cached_at:        now,
        };
      });

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

  // Parenthetical markers in OL titles that indicate bad/duplicate data entries
  const BAD_TITLE_PARENS = /\(\s*(duplictate|duplicate|dupe|bad\s*data|incorrect|wrong\s*edition|test)\s*\)/i;

  const passed = candidates.filter(book => {
    const subjects  = book.subjects ?? [];
    const subjLower = subjects.map(s => s.toLowerCase());

    // ── 0. OL bad-data title markers ─────────────────────────────────────
    // Open Library occasionally has entries like "Fool's Assassin (duplictate)"
    // which are flagged typo/duplicate entries. Reject them so the cleaner
    // OL work entry (if present in the pool) wins via title-normalized dedup.
    if (BAD_TITLE_PARENS.test(book.title)) {
      excluded++;
      if (reasons.length < 8) reasons.push(`bad_title_marker: ${book.title}`);
      return false;
    }

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
//   0.42 (trait+subj) + 0.22 (genre) + 0.10 (feedback) + 0.08 (enrichment) = 0.82
// Real "Strong fit" (>0.60) therefore requires genre + multiple trait/subject signals.
//
// Step 1 split — trait matching + subject overlap density:
//   STEP1_CAP       = 0.42  total ceiling (raised from 0.38 to accommodate deeper subject overlap)
//   STEP1_BASE_CAP  = 0.32  trait-only ceiling when liked_subjects are available
//                           (reserves 0.10 for subject overlap discrimination)
//   STEP1_OVERLAP_MAX = 0.10 max bonus from subject overlap (1 hit = 0.02, cap at 5)
//
// Rationale for the split:
//   getBookTraits() returns the same prior scores for every book of the same genre
//   type, so the trait loop maxes out at 0.38 for ALL candidates in a genre cohort.
//   Subject overlap (book.subjects ∩ profile.liked_subjects) varies per book —
//   a fantasy novel set in the same niche as the user's loved reads outscores a
//   generic fantasy novel. This creates the within-cohort discrimination that was
//   missing and causing all books to land at identical raw_score = 0.56.
//
// Step 6 aggregate floor:
//   S6_PENALTY_FLOOR = -0.25  prevents stacked subtype/drift/metadata penalties from
//   completely neutralising books with strong Steps 1–3 scores. A book needs two
//   significant concurrent penalties before the floor activates. Single large penalties
//   (e.g. noir -0.22, spiritual -0.22) still fire at full strength unaffected.

const TRAIT_CONTRIB_CAP  = 0.14;  // per-trait ceiling in step 1
const STEP1_CAP          = 0.42;  // total step 1 ceiling (trait + subject overlap)
const STEP1_BASE_CAP     = 0.32;  // trait-only ceiling when subject overlap can apply
const STEP1_OVERLAP_MAX  = 0.10;  // max subject overlap contribution (capped at 5 hits × 0.02)
const STEP3_BONUS_HIGH   = 0.22;  // genre affinity >0.5
const STEP3_BONUS_MED    = 0.10;  // genre affinity 0.2–0.5
const STEP3_PENALTY      = 0.18;  // genre affinity <-0.35
const TRAIT_THRESHOLD    = 0.28;  // min contribution to count for step 1
const S6_PENALTY_FLOOR   = -0.25; // aggregate floor on Step 6 — prevents penalty stacking from crushing strong matches

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

  // ── Step 1: Preferred trait alignment ────────────────────────────────────
  // Rules:
  //   a) The book must have a meaningful signal for this trait (bookWeight ≥ 0.55).
  //      This prevents vague genre-level priors from inflating the score.
  //   b) Each matching trait adds at most TRAIT_CONTRIB_CAP to the total.
  //   c) Trait-only total is capped at STEP1_BASE_CAP (0.32) when liked_subjects
  //      are available, reserving headroom for the subject overlap signal below.
  //      When no liked_subjects exist the cap falls back to STEP1_CAP (0.38),
  //      so new/low-signal users are unaffected.
  //   d) Traits that are not valid for this book's form are already absent from
  //      bt.traits (zeroed by getBookTraits), so they contribute nothing.
  const hasLikedSubjects = (profile.liked_subjects?.length ?? 0) > 0;
  const traitOnlyCap     = hasLikedSubjects ? STEP1_BASE_CAP : STEP1_CAP;

  const prefMatches: string[] = [];
  for (const [trait, userWeight] of Object.entries(pref)) {
    if (userWeight < 0.12) continue;                // negligible user preference
    const bookWeight = bt.traits[trait] ?? 0;
    if (bookWeight < 0.55) continue;                // book doesn't genuinely have this trait
    const contribution = Math.min(TRAIT_CONTRIB_CAP, userWeight * bookWeight);
    prefMatches.push(trait.toLowerCase());
    s1_trait = Math.min(traitOnlyCap, s1_trait + contribution);
  }
  if (prefMatches.length >= 2) {
    reasons.push(`Aligns with your preference for ${prefMatches.slice(0, 2).join(' and ')}`);
  } else if (prefMatches.length === 1) {
    reasons.push(`Matches your appreciation for ${prefMatches[0]}`);
  }

  // ── Step 1b: Subject overlap density ─────────────────────────────────────
  // Counts how many of the book's subjects appear in the user's liked_subjects
  // (subjects extracted from 4+★ finished reads). This is the primary within-
  // cohort discriminator: two books of the same genre may have very different
  // topic specificity relative to what the user actually loved.
  //
  // Overlap contribution: 1 match → +0.02, 2 matches → +0.04, 5+ → +0.10 (STEP1_OVERLAP_MAX)
  // Combined with trait matching, the step 1 total is capped at STEP1_CAP (0.42).
  // Safety: when liked_subjects is empty (new/low-signal users), traitOnlyCap
  // already equals STEP1_CAP so no room is reserved and no overlap is computed.
  if (hasLikedSubjects) {
    const bookSubjNorm  = new Set((book.subjects ?? []).map(s => s.toLowerCase().trim()).filter(Boolean));
    const likedSubjNorm = new Set(profile.liked_subjects.map(s => s.toLowerCase().trim()));
    const overlapCount  = [...bookSubjNorm].filter(s => likedSubjNorm.has(s)).length;
    const overlapBonus  = Math.min(STEP1_OVERLAP_MAX, overlapCount * 0.02);
    if (overlapBonus > 0) {
      s1_trait = Math.min(STEP1_CAP, s1_trait + overlapBonus);
      // Generate a subject-level reason when the overlap is meaningful (≥2 subjects).
      // These are more book-specific than lane-level strings and surface topic alignment
      // the user won't otherwise see in the explanation.
      if (overlapCount >= 2 && reasons.length < 2) {
        // Filter to subjects that are reader-friendly: long enough, not purely
        // bibliographic noise (language markers, format tags, etc.).
        const SKIP_SUBJECTS = new Set([
          'fiction', 'english', 'american', 'british', 'literature',
          'books', 'novels', 'short stories', 'open library', 'nonfiction',
        ]);
        const goodOverlap = [...bookSubjNorm]
          .filter(s => likedSubjNorm.has(s) && s.length >= 8 && !SKIP_SUBJECTS.has(s))
          .slice(0, 2);
        if (goodOverlap.length >= 1) {
          const themeList = goodOverlap.length === 2
            ? `${goodOverlap[0]} and ${goodOverlap[1]}`
            : goodOverlap[0];
          reasons.push(`Covers themes of ${themeList} that appear in books you've loved`);
        }
      }
    }
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

  // ── Step 7: Subtype calibration and lane penalties ────────────────────────
  //
  // Structure:
  //   7a — Classify the book (runs always, results shared by 7b and 7c)
  //   7b — Unconditional penalties: fire for EVERY user, based on
  //          genre_affinities + book subtype, no dominant_lanes required.
  //          These are the critical fixes for noir/spy/spiritual/literary drift
  //          affecting users who haven't yet established a dominant lane pattern.
  //   7c — Lane-calibration extras: only when dominant_lanes is established.
  //          Adds stronger incremental penalties + lane-aware reason language.

  // ── 7a: Book classifiers ──────────────────────────────────────────────────
  const bookLane      = detectBookLane(book);
  const bookSubtype   = detectBookMysterySubtype(book);
  const isPhi         = isPhilosophyOrSpiritual(book);
  const bookIsLiterary = bookLane === 'literary'
    || bt.primaryGenre === 'literary'
    || subjLower.includes('literary fiction');

  // Pull key affinities for 7b decisions
  const thrillAffinity   = affinities['thriller_mystery'] ?? 0;
  const literaryAffinity = affinities['literary'] ?? 0;
  const memoirAffinity   = affinities['memoir_bio'] ?? 0;
  const nonfictAffinity  = affinities['nonfiction'] ?? 0;

  // ── 7b: Unconditional subtype penalties ───────────────────────────────────

  // Hard-boiled noir: penalise when user has any thriller affinity but book
  // is Chandler-style noir — structurally different from modern suspense.
  if (thrillAffinity > 0.15 && bookSubtype === 'hard_boiled_noir') {
    s6_meta_pen -= 0.22;
    audit_flags.push('noir_drift');
    if (risks.length < 1) risks.push('Hard-boiled noir — different feel from the modern suspense you rate highest');
  }

  // Spy / adventure: penalise for thriller readers whose signals skew domestic.
  if (thrillAffinity > 0.15 && bookSubtype === 'spy_adventure') {
    s6_meta_pen -= 0.16;
    audit_flags.push('spy_drift');
    if (risks.length < 1) risks.push('Classic spy / adventure — more old-school than the modern suspense you prefer');
  }

  // Philosophy / spiritual: applies to all users unless they have strong memoir
  // or nonfiction signal that specifically includes this territory.
  // Threshold: memoirAffinity must be very high (>= 0.7) to suppress — a
  // moderate memoir affinity doesn't mean the user wants yoga autobiographies.
  if (isPhi && memoirAffinity < 0.7 && nonfictAffinity < 0.5) {
    s6_meta_pen -= 0.22;
    audit_flags.push('philosophy_drift');
    if (risks.length < 1) risks.push('Philosophical or spiritual focus — different territory from your main reads');
  }

  // Literary drift: fires for users with confirmed evidence of low literary
  // affinity.  Gated at tier >= 2 so that evidence-poor users (tier 0–1) are
  // not penalised simply for lacking literary history.  A tier 0 user with
  // literaryAffinity = 0.00 has no aversion signal — they just haven't read
  // enough to establish one.  The 7c dense-lane literary extra (below) already
  // requires dominant_lanes, so it is unaffected by this gate.
  if (bookIsLiterary && literaryAffinity < 0.2 && profile.tier >= 2) {
    s6_meta_pen -= 0.16;
    audit_flags.push('literary_drift');
    if (risks.length < 1) risks.push('Leans more literary than your strongest recurring reads');
  }

  // Graphic novel format mismatch: comic/graphic-novel format is a distinct
  // reading medium that most readers don't seek out proactively. Apply a format
  // penalty unconditionally — users who have explicitly liked graphic novels
  // already receive a feedback_boost (+0.14) on similar books, which fully
  // offsets this penalty for known fans while protecting everyone else from
  // unexpected format surprises.
  if (bt.bookForm === 'graphic') {
    s6_meta_pen -= 0.10;
    audit_flags.push('graphic_format');
    if (__DEV__) console.log('[GRAPHIC PENALTY] fired for', book.title, '| memoirAffinity:', memoirAffinity.toFixed(3));
    if (risks.length < 1) risks.push('Graphic novel format — a different reading experience from most of your rated books');
  }

  // ── 7c: Dense lane calibration (dominant lanes established) ───────────────
  const det = profile.det_lanes;
  if (det?.dominant_lanes && det.dominant_lanes.length > 0) {
    // Lane-aware explanation (replaces generic trait-match text when available)
    if (bookLane && det.dominant_lanes.includes(bookLane)) {
      const laneReason = LANE_REASON[bookLane];
      if (laneReason) {
        reasons.unshift(laneReason);
      }
    }

    // Extra literary penalty when commercial_prior is strong AND 7b didn't
    // already fire (user has >= 0.2 literary affinity but proven commercial lanes)
    const userHasLiteraryLane = det.dominant_lanes.includes('literary');
    if (bookIsLiterary && !userHasLiteraryLane && det.commercial_prior > 0.5 && literaryAffinity >= 0.2) {
      s6_meta_pen -= 0.12;
      if (!audit_flags.includes('literary_drift')) audit_flags.push('literary_drift');
      if (risks.length < 1) risks.push('Leans more literary than your strongest recurring reads');
    }

    // Extra noir penalty when the user's mystery_subtype is confirmed contemporary
    if (det.mystery_subtype === 'contemporary_thriller' && bookSubtype === 'hard_boiled_noir'
        && !audit_flags.includes('noir_drift')) {
      s6_meta_pen -= 0.10;
      audit_flags.push('noir_drift_confirmed');
    }

    // Extra spiritual penalty when dominant lanes are commercial but memoir
    // affinity was high enough to suppress 7b
    if (isPhi && memoirAffinity >= 0.7
        && !det.dominant_lanes.includes('memoir_nonfiction')
        && !det.dominant_lanes.includes('literary')) {
      s6_meta_pen -= 0.15;
      if (!audit_flags.includes('philosophy_drift')) audit_flags.push('philosophy_drift');
      if (risks.length < 1) risks.push('Philosophical or spiritual focus — different territory from your usual reads');
    }

    // Modern commercial prior — small boost when lane matches
    if (bookLane && COMMERCIAL_LANES.has(bookLane as DeterministicLane) && det.commercial_prior > 0.6) {
      s6_meta_pen = Math.min(0, s6_meta_pen) + 0.05;
    }
  }

  // ── Step 6 aggregate floor ─────────────────────────────────────────────────
  // Applied after all penalty accumulations including the 7c commercial-prior
  // boost.  Prevents stacked metadata + subtype + drift penalties from
  // crushing books that have strong Steps 1–3 scores.  A book with only one
  // large penalty (e.g. noir −0.22, spiritual −0.22) is unaffected.
  s6_meta_pen = Math.max(S6_PENALTY_FLOOR, s6_meta_pen);

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
  intent?:         NextReadIntent,
  seriesReadSet:        Set<string>             = new Set(),
  seriesProgress:       Map<string, number>     = new Map(),
  authorReadCounts:     Map<string, number>     = new Map(),
  seriesPositionsRead:  Map<string, Set<number>> = new Map(),
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

  if (__DEV__) {
    const seedCount    = candidates.filter(b =>
      typeof b._retrieval_reason === 'string' &&
      b._retrieval_reason.startsWith('exact_series_seed:')
    ).length;
    const preSeedPool  = poolSize - seedCount;
    console.log('[POOL_CHECK]',
      `pre_seed_pool=${preSeedPool}`,
      `| post_seed_pool=${poolSize}`,
      `| threshold=${MIN_CANDIDATES}`,
      `| decision=${poolSize >= MIN_CANDIDATES ? 'pass' : 'gate_fires'}`,
    );
  }

  if (poolSize < MIN_CANDIDATES) {
    return { recs: [], continuations: [], discoveries: [], meta: buildMeta('insufficient_pool') };
  }

  const scored: ScoredBook[] = candidates.map(book => {
    const enrichment = book.external_id ? enrichmentMap.get(book.external_id) : undefined;
    return {
      ...book,
      ...scoreBookForUser(book, profile, feedback, enrichment),
      _debug: { pool_size: poolSize, rank: 0 },
    } as ScoredBook;
  });

  // ── Center-of-gravity fit classification ─────────────────────────────────
  // For every candidate, compute:
  //   1. Market position — what type of reading the book represents
  //   2. Fit class       — core_fit / adjacent_fit / stretch_fit / reject
  //   3. Score delta     — core +0.25, adjacent 0, stretch −0.20, reject −9999
  //
  // Re-sort AFTER applying deltas so the final order reflects fit quality,
  // not just trait/genre score. Reject-class books are removed entirely.
  // Rationale: a book that is "defensible" (high trait overlap) but not
  // "central" (wrong market position) must not dominate the top of the list.
  const cog = computeCenterOfGravity(profile);

  for (const book of scored) {
    // Principle: format detection must resolve at the classification boundary.
    // CandidateBook has no book_form field — compute it from subjects so
    // graphic novels are correctly rejected by classifyMarketPosition.
    const bookTraits = getBookTraits(book);
    const bookLane   = detectBookLane(book);
    const marketPos  = classifyMarketPosition({ ...book, book_form: bookTraits.bookForm });
    const fitResult  = computeFitClass(book, bookLane, marketPos, cog);

    // Apply score delta (clamp at 0 — score is always non-negative)
    const adjustedScore = Math.max(0, book.score + fitResult.cog_score_delta);
    book.score = +adjustedScore.toFixed(3);

    // Explanation principle: the CoG fit_explanation provides market-position context,
    // while the scoring reasons carry book-specific trait / subject signals.
    // Preserve one trait-level reason alongside the fit_explanation so that
    // buildExplanation() can choose the most specific and honest copy to show.
    //
    // LANE_REASON strings are discarded here — they are lane-wide generics that
    // duplicate what the CoG explanation already captures. Trait and subject
    // overlap reasons are kept as reasons[1] for the display layer to prefer.
    if (fitResult.fit_class !== 'reject' && fitResult.fit_explanation) {
      const existingReasons = book.reasons ?? [];
      const traitReasons = existingReasons.filter(r => !LANE_REASON_VALUES.has(r));
      book.reasons = [
        fitResult.fit_explanation,
        ...traitReasons.slice(0, 1),
      ].filter((r, i, arr) => arr.indexOf(r) === i);
    }

    // Classify explanation quality based on the evidence in the finalised reasons[].
    // Happens here — after reasons are set — so the classification reflects exactly
    // what buildExplanation() in RecCard.tsx will surface to the user.
    const explanationQuality = classifyExplanationQuality(
      book.reasons,
      fitResult.fit_class,
      fitResult.repeated_author_match,
      book._score_breakdown.trait_alignment,
    );

    // Extend _score_breakdown with CoG fields + presentation annotation
    book._score_breakdown = {
      ...book._score_breakdown,
      book_lane:             bookLane ?? null,
      fit_class:             fitResult.fit_class,
      market_position:       fitResult.market_position,
      lane_match_strength:   fitResult.lane_match_strength,
      repeated_author_match: fitResult.repeated_author_match,
      exception_dependency:  fitResult.exception_dependency,
      cog_score_delta:       fitResult.cog_score_delta,
      final_score:           book.score,
      explanation_quality:   explanationQuality,
      // Presentation-only: how many of this author's books the user has read.
      // Used by the explanation string generator — zero scoring impact.
      author_books_read:     authorReadCounts.get(book.author.toLowerCase().trim()) ?? 0,
    };
  }

  // Remove rejects, then re-sort by adjusted score
  const nonRejected = scored.filter(b => b._score_breakdown.fit_class !== 'reject');
  nonRejected.sort((a, b) => b.score - a.score);

  // ── Title-normalized dedup ─────────────────────────────────────────────────
  // Strips parenthetical edition qualifiers before keying, so variants like
  // "Fool's Assassin (duplictate)" and "Fool's Assassin" share the same key.
  // Within each work-key, keep only the highest-scoring candidate.
  function normWorkKey(title: string, author: string): string {
    const normT = title
      .toLowerCase()
      .replace(/['''\u2018\u2019]/g, '')   // strip apostrophes
      .replace(/\s*\([^)]*\)/g, '')        // strip parenthetical qualifiers
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normA = author
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return `${normA}::${normT}`;
  }
  const workBest = new Map<string, ScoredBook>();
  for (const book of nonRejected) {
    const wk = normWorkKey(book.title, book.author);
    const prev = workBest.get(wk);
    if (!prev || book.score > prev.score) workBest.set(wk, book);
  }
  const dedupedNonRejected = [...workBest.values()].sort((a, b) => b.score - a.score);
  if (__DEV__ && dedupedNonRejected.length < nonRejected.length) {
    console.log(`[TITLE_DEDUP] Collapsed ${nonRejected.length - dedupedNonRejected.length} duplicate work(s)`);
  }

  // ── Recommendation Integrity Layer ────────────────────────────────────────
  // Runs after CoG so repeated_author_match is populated.
  // Annotates every book with series_name / series_position / series_label.
  // Removes series_later_volume books from the visible pool (placed in audit).
  const rilResult = applyIntegrityLayer(dedupedNonRejected, seriesReadSet, seriesProgress, seriesPositionsRead);
  const rilPool   = rilResult.visible;          // feeds the intent / composition stages
  const rilSuppressed = rilResult.integritySuppressed;

  if (__DEV__ && rilSuppressed.length > 0) {
    console.log(`[RIL] suppressed ${rilSuppressed.length} book(s):`);
    for (const b of rilSuppressed) {
      console.log(`  [RIL_SUPPRESS] "${b.title}" by ${b.author} — ${b._score_breakdown.ril_reason ?? '?'}`);
    }
  }
  if (__DEV__) {
    const annotatedWithSeries = rilPool.filter(b => b._score_breakdown.series_label);
    for (const b of annotatedWithSeries) {
      const sb = b._score_breakdown;
      console.log(
        `[RIL_LABEL] "${b.title}" → ${sb.series_label} (${sb.series_name} #${sb.series_position})`
      );
    }
  }

  // ── Bucket partition: Continue Reading vs Discover Next ───────────────────
  // Series continuations (high-confidence, user has started the series) are
  // extracted from the RIL-visible pool before the composition engine runs.
  // This gives them their own editorial slot without competing for discovery
  // positions. Discovery books (starters, standalones, new authors) feed
  // the composition engine unchanged so author caps / lane diversity apply.
  //
  // Principle: continuation eligibility is determined by RIL series familiarity.
  // A book is in "Continue Reading" only if series_label === 'series_continuation'
  // (meaning the user has read an earlier book in that exact series).
  //
  // Cohort safety: users with no started series get no continuation bucket —
  // all books fall through to Discover Next. Dense commercial readers with
  // many started series may see up to CONT_CAP continuations. Literary and
  // nonfiction readers almost never trigger the continuation path.
  // ── Series-progress guard ─────────────────────────────────────────────────
  // A book with series_label='series_continuation' is only eligible for the
  // Continue Reading bucket if the user has NOT already read it (or a later
  // installment). Without this check, a user who has read Liveship Traders #1,
  // #2, #3 would still see #2 ("Mad Ship") as a "Continue Reading" pick because
  // the series-started boolean alone doesn't encode how far they have read.
  //
  // seriesProgress maps normKey(series_name) → highest position the user has
  // finished. If candidate.position ≤ maxRead → user has already read it → drop.
  function normSKey(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const continuationPool = rilPool.filter(b => {
    if (b._score_breakdown.series_label !== 'series_continuation') return false;
    const sName = typeof b._score_breakdown.series_name === 'string'
      ? b._score_breakdown.series_name : null;
    const sPos  = typeof b._score_breakdown.series_position === 'number'
      ? b._score_breakdown.series_position : null;
    if (sName !== null && sPos !== null) {
      const maxRead = seriesProgress.get(normSKey(sName)) ?? 0;
      if (sPos <= maxRead) {
        if (__DEV__) console.log(
          `[SERIES_PROG] Dropped "${b.title}" #${sPos} from Continue Reading — user read up to #${maxRead} in "${sName}"`
        );
        return false;
      }
    }
    return true;
  });
  const discoveryPool = rilPool.filter(
    b => b._score_breakdown.series_label !== 'series_continuation'
  );

  // One per series (lowest series_position = the actual next installment),
  // sorted by score, capped at CONT_CAP.
  const contBySeries = new Map<string, ScoredBook>();
  for (const book of continuationPool) {
    const sKey = (book._score_breakdown.series_name ?? `${book.author}::${book.title}`).toLowerCase();
    const pos  = book._score_breakdown.series_position ?? 999;
    const prev = contBySeries.get(sKey);
    if (!prev || pos < (prev._score_breakdown.series_position ?? 999)) {
      contBySeries.set(sKey, book);
    }
  }
  const continuationRecs = [...contBySeries.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, CONT_CAP);

  if (__DEV__) {
    if (continuationRecs.length > 0) {
      console.log(
        `[BUCKET] Continue Reading (${continuationRecs.length}):`,
        continuationRecs.map(b =>
          `"${b.title}" — ${b._score_breakdown.series_name} #${b._score_breakdown.series_position}`
        ).join(', ')
      );
    }
    console.log(`[BUCKET] Discover Next pool: ${discoveryPool.length} book(s)`);
  }

  // ── Intent layer ──────────────────────────────────────────────────────────
  // Applied AFTER CoG classification so the taste profile still governs
  // base quality. Intent narrows the ranked pool; it never replaces CoG fit.
  // Runs on discoveryPool only — continuations are trusted editorial picks
  // not subject to intent hard-filters.
  //
  // Order of operations per book:
  //   1. Check exclusions      → hard-remove if matched
  //   2. Check hard filters    → hard-remove if not matching
  //   3. Apply soft boost      → small score nudge for preference match
  //   4. Re-sort intentFiltered by adjusted score
  //
  // If intent filtering leaves fewer than MIN_PASSING_BOOKS that clear the
  // score threshold, the quality gate catches it and the UI should guide the
  // user to relax their filters (no silent fallback to unfiltered results).
  let intentFiltered      = discoveryPool as typeof discoveryPool;
  let intentRejectedCount = 0;
  let intentSummary: IntentSetSummary | undefined;

  if (intent && isIntentActive(intent)) {
    const kept: typeof discoveryPool = [];
    const exclusionCounts: Record<string, number> = {};
    let removedByExclusion  = 0;
    let removedByHardFilter = 0;
    let softBoostedCount    = 0;

    for (const book of discoveryPool) {
      const bookLane  = detectBookLane(book);
      const marketPos = (book._score_breakdown.market_position as MarketPosition) ?? 'general_fiction';

      // 1. Exclusions take priority over hard filters
      const exclusionReason = getIntentExclusionReason(book, intent, marketPos);
      if (exclusionReason) {
        intentRejectedCount++;
        removedByExclusion++;
        exclusionCounts[exclusionReason] = (exclusionCounts[exclusionReason] ?? 0) + 1;
        book._intent_trace = {
          excluded_by:        exclusionReason,
          hard_filter_passes: [],
          hard_filter_fails:  [],
          soft_boosts:        [],
          score_delta:        0,
        };
        continue;
      }

      // 2. Hard filters (trace-aware)
      const hardEval = evaluateHardFilters(book, intent, bookLane, marketPos);
      if (!hardEval.passes) {
        intentRejectedCount++;
        removedByHardFilter++;
        book._intent_trace = {
          excluded_by:        null,
          hard_filter_passes: hardEval.passReasons,
          hard_filter_fails:  hardEval.failReasons,
          soft_boosts:        [],
          score_delta:        0,
        };
        continue;
      }

      // 3. Soft preference boost (trace-aware)
      const { delta: boost, reasons: boostReasons } = computeIntentBoostWithReasons(book, intent);
      if (boost !== 0) {
        book.score = +Math.max(0, book.score + boost).toFixed(3);
        if (boost > 0) softBoostedCount++;
      }

      book._intent_trace = {
        excluded_by:        null,
        hard_filter_passes: hardEval.passReasons,
        hard_filter_fails:  [],
        soft_boosts:        boostReasons,
        score_delta:        boost,
      };

      kept.push(book);
    }

    kept.sort((a, b) => b.score - a.score);
    intentFiltered = kept;

    intentSummary = {
      before_intent:          discoveryPool.length,
      removed_by_exclusion:   removedByExclusion,
      removed_by_hard_filter: removedByHardFilter,
      soft_boosted:           softBoostedCount,
      after_intent:           kept.length,
      exclusion_breakdown:    exclusionCounts,
    };

    if (__DEV__ && intentRejectedCount > 0) {
      console.log(`[INTENT] ${intentRejectedCount} removed (${removedByExclusion} excl, ${removedByHardFilter} hard); ${intentFiltered.length} remain`);
    }
  }

  if (__DEV__) {
    const rejectCount = scored.length - nonRejected.length;
    if (rejectCount > 0) {
      console.log(`[COG] Removed ${rejectCount} reject-class books from pool of ${scored.length}`);
    }
    if (rilSuppressed.length > 0) {
      console.log(`[RIL] Suppressed ${rilSuppressed.length} book(s) (series integrity); ${rilPool.length} remain`);
    }
    const top5 = rilPool.slice(0, 5).map(b => ({
      title: b.title,
      score: b.score,
      fit_class: b._score_breakdown.fit_class,
      market_position: b._score_breakdown.market_position,
      cog_delta: b._score_breakdown.cog_score_delta,
      series_label: b._score_breakdown.series_label,
    }));
    console.log('[COG+RIL] Top-5 after fit classification + integrity:', JSON.stringify(top5));
  }

  // Quality gate: score threshold (applied to CoG-adjusted + intent-boosted scores)
  // Uses intentFiltered so user-excluded books don't pad the passing count.
  const passing = intentFiltered.filter(b => b.score >= MIN_PASS_SCORE);
  if (passing.length < MIN_PASSING_BOOKS) {
    return {
      recs: [], continuations: [], discoveries: [],
      meta: {
        ...buildMeta(intentRejectedCount > 0 ? 'intent_filtered_empty' : 'insufficient_score'),
        intent_filtered_count: intentRejectedCount || undefined,
        intent_summary: intentSummary,
      },
    };
  }

  // ── Set Composition Engine ─────────────────────────────────────────────────
  //
  // Three-phase curated composition that replaces the old greedy diversity loop.
  //
  // Phase 1 — Lane seeding (dense multi-lane users only):
  //   For each dominant lane, reserve the best available CORE book so the
  //   output always spans multiple dominant lanes. A user with 5 dominant
  //   lanes will always see at least one representative from each lane in
  //   the final set (when the pool supports it).
  //
  // Phase 2 — CORE fill:
  //   Remaining slots filled by best available CORE books (by effective score).
  //   The per-lane cap prevents any single lane from monopolising the set.
  //
  // Phase 3 — ADJACENT fill (suppressed when CORE pool is healthy):
  //   ADJACENT books only enter the visible output when CORE books are fewer
  //   than ADJACENT_VISIBLE_THRESHOLD_FRAC × limit. When the CORE pool is
  //   rich enough, ADJACENT books remain in the audit list but are not shown.
  //
  // Cross-cutting constraints:
  //   Continuation discount — later books from the same author earn a
  //     progressively lower effective score (−CONTINUATION_DISCOUNT_PER_RANK
  //     per rank). This suppresses sequel/series floods while preserving the
  //     best book from each author. book.score is NOT mutated — the discount
  //     only affects composition ordering. Display scores remain intact.
  //   Author cap — max 1 per author in slots 1–5; max 2 in full set.
  //   Lane cap — max ⌈limit / dominant_lanes⌉ books per lane.
  //   Tiebreak — equal-score ties broken by external_id sort for Pass A/B
  //     stability (same candidates always produce same final set).

  // Step A: Continuation discount — compute effective scores for ordering.
  // intentFiltered is already sorted descending by CoG-adjusted score, so the
  // first time we see an author their highest-scoring book gets rank 0 (no
  // discount); subsequent books get increasing discounts.
  const authorRankInPool: Record<string, number> = {};
  const effScoreMap = new Map<string, number>();

  function compId(b: ScoredBook): string {
    return b.external_id ?? `${b.author}::${b.title}`;
  }

  for (const book of intentFiltered) {
    const aKey    = book.author.toLowerCase();
    const rank    = authorRankInPool[aKey] ?? 0;
    authorRankInPool[aKey] = rank + 1;
    const discount = rank * CONTINUATION_DISCOUNT_PER_RANK;
    effScoreMap.set(compId(book), Math.max(0, book.score - discount));
    if (rank > 0) {
      book._score_breakdown = {
        ...book._score_breakdown,
        continuation_rank:     rank + 1,
        continuation_discount: +discount.toFixed(3),
      };
    }
  }

  // Step B: Re-sort by effective score with deterministic tiebreak.
  const compPool = [...intentFiltered].sort((a, b) => {
    const ea = effScoreMap.get(compId(a)) ?? a.score;
    const eb = effScoreMap.get(compId(b)) ?? b.score;
    if (Math.abs(ea - eb) > 0.0005) return eb - ea;
    // Deterministic tiebreak: lexicographic on external_id (stable across runs)
    return (a.external_id ?? a.title ?? '').localeCompare(b.external_id ?? b.title ?? '');
  });

  // Step C: ADJACENT visibility gate.
  // Books flagged weak_metadata are demoted to ADJACENT regardless of their fit_class
  // so they only surface when CORE picks are thin.
  function isCompCore(b: ScoredBook): boolean {
    if (b._score_breakdown.fit_class !== 'core_fit') return false;
    if (b._score_breakdown.audit_flags?.includes('weak_metadata')) return false;
    return true;
  }
  const adjacentThreshold = Math.max(3, Math.ceil(limit * ADJACENT_VISIBLE_THRESHOLD_FRAC));
  const coreInPool    = compPool.filter(isCompCore).length;
  const showAdjacent  = coreInPool < adjacentThreshold;

  // Per-lane cap: prevent any single lane from monopolising the set.
  // For a user with N dominant lanes and a limit of L, each lane can hold
  // at most ⌈L / N⌉ books. Minimum of 2 so low-N users still get variety.
  const dominantLaneCount = Math.max(1, cog.dominant_lanes.length);
  const laneCap = Math.max(2, Math.ceil(limit / dominantLaneCount));

  // Composition state
  const composedSet  = new Set<string>();
  const composed:    ScoredBook[] = [];
  const authUsed:    Record<string, number> = {};
  const laneUsed:    Record<string, number> = {};

  function compositionAllows(b: ScoredBook): boolean {
    const aKey  = b.author.toLowerCase();
    const bLane = b._score_breakdown.book_lane as (string | null | undefined);
    const ac    = authUsed[aKey] ?? 0;
    // Tight author cap in first 5 output slots, relaxed after
    const authorCap = composed.length < 5 ? 1 : 2;
    if (ac >= authorCap) return false;
    if (bLane && (laneUsed[bLane] ?? 0) >= laneCap) return false;
    return true;
  }

  function addComposed(b: ScoredBook): void {
    const aKey  = b.author.toLowerCase();
    const bLane = b._score_breakdown.book_lane as (string | null | undefined);
    composed.push(b);
    composedSet.add(compId(b));
    authUsed[aKey] = (authUsed[aKey] ?? 0) + 1;
    if (bLane) laneUsed[bLane] = (laneUsed[bLane] ?? 0) + 1;
  }

  // Phase 1: Lane seeding — guarantee one CORE book per dominant lane.
  // Applied only for dense users who have ≥2 distinct dominant lanes.
  // Seed up to floor(limit/2) lanes so Phase 1 fills at most half the set,
  // leaving room for Phase 2 quality-sorted additions.
  if (cog.is_dense && cog.dominant_lanes.length >= 2) {
    const seedTarget = Math.min(cog.dominant_lanes.length, Math.floor(limit / 2));
    for (const lane of cog.dominant_lanes) {
      if (composed.length >= seedTarget) break;
      const seed = compPool.find(b =>
        !composedSet.has(compId(b)) &&
        isCompCore(b) &&
        b._score_breakdown.book_lane === lane &&
        compositionAllows(b)
      );
      if (seed) addComposed(seed);
    }
  }

  // Phase 2: CORE fill — greedy by effective score, respecting lane/author caps.
  for (const book of compPool) {
    if (composed.length >= limit) break;
    if (composedSet.has(compId(book))) continue;
    if (!isCompCore(book)) continue;
    if (!compositionAllows(book)) continue;
    addComposed(book);
  }

  // Phase 3: ADJACENT fill — only when the CORE pool is thin.
  if (showAdjacent) {
    for (const book of compPool) {
      if (composed.length >= limit) break;
      if (composedSet.has(compId(book))) continue;
      if (book._score_breakdown.fit_class === 'core_fit') continue;
      if (book._score_breakdown.fit_class === 'reject') continue;
      if (!compositionAllows(book)) continue;
      addComposed(book);
    }
  }

  // Sort final set: explanation quality tier first (strong → acceptable → weak),
  // then by display score descending within each tier.
  //
  // This is the demotion gate for weak-evidence cards. WEAK books remain in
  // the composed set (starvation-safe — they were composed normally through
  // Phase 2 / Phase 3), but they appear at the back of the visible feed
  // regardless of their raw score. A card with only a generic lane justification
  // never occupies a prime slot ahead of one with real book-specific evidence.
  //
  // Phase 1 seeds that scored lower than Phase 2 additions will appear further
  // down within their tier — that is correct behaviour.
  // 4-tier sort: STRONG (0) > acceptable_specific (1) > acceptable_generic (2) > WEAK (3)
  // Within each tier, higher raw score ranks first.
  // Composition is unchanged — this only reorders the already-composed set.
  const explanationTier = (q: string | undefined): number => {
    if (q === 'strong')              return 0;
    if (q === 'acceptable_specific') return 1;
    if (q === 'acceptable_generic')  return 2;
    return 3; // 'weak' or unset
  };

  composed.sort((a, b) => {
    const ta = explanationTier(a._score_breakdown.explanation_quality);
    const tb = explanationTier(b._score_breakdown.explanation_quality);
    if (ta !== tb) return ta - tb;
    return b.score - a.score;
  });

  if (__DEV__) {
    const byTier = { strong: 0, acceptable_specific: 0, acceptable_generic: 0, weak: 0 };
    for (const b of composed) {
      const q = (b._score_breakdown.explanation_quality ?? 'weak') as keyof typeof byTier;
      if (q in byTier) byTier[q]++;
    }
    console.log(
      `[EXP_QUALITY] strong: ${byTier.strong}` +
      `  acc_specific: ${byTier.acceptable_specific}` +
      `  acc_generic: ${byTier.acceptable_generic}` +
      `  weak: ${byTier.weak}`
    );
    const genericCards = composed.filter(b => b._score_breakdown.explanation_quality === 'acceptable_generic');
    const weakCards    = composed.filter(b => b._score_breakdown.explanation_quality === 'weak');
    if (genericCards.length > 0) {
      console.log(
        `[EXP_QUALITY] acc_generic: ${genericCards.map(b => `"${b.title}"`).join(', ')}`
      );
    }
    if (weakCards.length > 0) {
      console.log(
        `[EXP_QUALITY] Demoted to back: ${weakCards.map(b => `"${b.title}"`).join(', ')}`
      );
    }
  }

  const diverse = composed.map(
    (b, i) => ({ ...b, _debug: { pool_size: poolSize, rank: i + 1 } })
  );

  // Audit order: CoG-sorted non-rejects first, then reject-class books at end.
  // Audit always reflects the CoG-filtered pool (before intent), so the debug
  // panel shows why a book was included or excluded by the engine itself.
  const rejectBooks = scored.filter(b => b._score_breakdown.fit_class === 'reject');
  // Include integrity-suppressed books in the audit so the debug panel can surface them.
  // They carry ril_suppressed=true + ril_reason for full transparency.
  const auditList   = [...dedupedNonRejected, ...rilSuppressed, ...rejectBooks];

  return {
    recs:          [...continuationRecs, ...diverse],
    continuations: continuationRecs,
    discoveries:   diverse,
    meta: {
      ...buildMeta('passed'),
      candidate_audit: auditList.map(
        (b, i) => ({ ...b, _debug: { pool_size: poolSize, rank: i + 1 } })
      ),
      intent_filtered_count: intentRejectedCount > 0 ? intentRejectedCount : undefined,
      intent_summary: intentSummary,
    },
  };
}

// ── Dev-only timing store (populated by getCandidateBooks, read by UI overlay) ─
// Only written when __DEV__ is true; production builds never touch this object.
export type DevTimings = {
  retrieval_local_ms:  number;
  cache_check_ms:      number;
  ol_ms:               number;
  ol_source:           'cache_hit' | 'live_ol';
  seeds_ms:            number;
  enrichment_ms:       number;
  filter_hygiene_ms:   number;
  total_candidate_ms:  number;
  total_pipeline_ms:   number;
  timestamp:           number;
};
// Stable object reference — `.current` is mutated in-place so the same import
// always reflects the latest values regardless of module system (CJS/ESM).
export const __devTimingsRef: { current: DevTimings | null } = { current: null };

// ── Combined retrieval ────────────────────────────────────────────────────────
// Returns CandidateResult: candidates + enrichmentMap + retrieval_trace.
// replaces the old plain CandidateBook[] return type.

export async function getCandidateBooks(
  client:                SupabaseClient,
  userId:                string,
  profile:               TasteProfile,
  feedback?:             FeedbackContext,
  additionalExcludeIds?: Set<string>,
  forceNewOL?:           boolean,
): Promise<CandidateResult> {
  // ── Stage timing — [REC_TIMING] log emitted at the end of this function ───
  const _t0 = Date.now();
  if (__DEV__) console.log('[PERF] phase2_candidate_generation_start');

  // ── Source A: catalog ─────────────────────────────────────────────────────
  const local = await getLocalCandidates(client, userId);
  const _t1 = Date.now();

  // ── seriesReadSet — built deterministically from user library ─────────────
  // Must happen BEFORE any OL fetch so Continue Reading routing is stable
  // regardless of OL response variance. With subtitle-stripping in lookupCurated,
  // import variants like "Fool's Fate: A Tawny Man Novel" now resolve correctly.
  // This is the primary, stable source. OL-excluded books are added later as
  // a supplemental fallback (additive only — can never remove series).
  const seriesReadSet       = buildSeriesReadSet(local.readBooks);
  const seriesProgress      = buildSeriesProgress(local.readBooks);
  const seriesPositionsRead = buildSeriesPositionsRead(local.readBooks);

  // Author read counts — purely for explanation strings (no scoring impact).
  // Uses finishedReadBooks (status === 'finished' only) so "You've read N books
  // by X" never counts a book the user is currently in the middle of.
  const authorReadCounts = new Map<string, number>();
  for (const b of local.finishedReadBooks) {
    if (!b.author) continue;
    const key = b.author.toLowerCase().trim();
    authorReadCounts.set(key, (authorReadCounts.get(key) ?? 0) + 1);
  }
  if (__DEV__) {
    console.log(`[SERIES_RS] trulyRead=${local.readBooks.length} (of ${local.readIds.size} in library) primarySize=${seriesReadSet.size} series=[${[...seriesReadSet].join(', ')}]`);
    if (seriesProgress.size > 0) {
      const progressStr = [...seriesProgress.entries()].map(([s, p]) => `${s}:#${p}`).join(', ');
      console.log(`[SERIES_PROG] maxRead=[${progressStr}]`);
    }
    if (seriesReadSet.size === 0 && local.readBooks.length > 0) {
      // Emit a sample so we can see the exact author/title format stored in the DB
      console.log(`[SERIES_RS_SAMPLE]`, local.readBooks.slice(0, 8).map(b => `"${b.title}" / "${b.author}"`));
    }
  }

  // ── Source D: exact-series seeds (launched immediately, runs in parallel) ───
  // For each series in the canonical catalog that the user should read next
  // (unstarted + prereq-clear, or in-progress + incomplete), fire an exact
  // title+author OL lookup.  These are launched here — BEFORE the cache check
  // and OL fetch below — so the latency is fully absorbed in parallel.
  // Results are merged into externalCandidates after the OL fetch resolves.
  if (__DEV__) console.log('[PERF] seed_resolution_start');
  const exactSeriesSeeds = getEligibleSeriesSeeds(seriesProgress, seriesReadSet);
  if (__DEV__) console.log('[PERF] seed_resolution_end', `| seeds_to_fetch=${exactSeriesSeeds.length}`);
  if (__DEV__) {
    console.log(
      `[EXACT_SEEDS] seeding ${exactSeriesSeeds.length} series book(s): [` +
      exactSeriesSeeds.map(s => `"${s.title}" (${s.series} #${s.position})`).join(', ') +
      `]`,
    );
  }
  if (__DEV__) console.log('[PERF] seed_fetch_start', `| count=${exactSeriesSeeds.length} (parallel with OL/cache fetch)`);
  const _seedFetchStartMs = Date.now();
  const exactSeedsFetchP: Promise<CandidateBook[]> =
    exactSeriesSeeds.length === 0
      ? Promise.resolve([])
      : Promise.all(
          exactSeriesSeeds.map(s => fetchOLByTitle(s.title, s.author, s.series, s.position))
        ).then(r => r.flat());

  const catalogExternalIds = new Set(
    local.candidates.map(c => c.external_id).filter((x): x is string => !!x)
  );

  // ── Source B: check cache ─────────────────────────────────────────────────
  const cacheResult = await getCachedExternalCandidates(
    client,
    userId,
    new Set([...local.readExternalIds, ...catalogExternalIds]),
    additionalExcludeIds,
  );
  const _t2 = Date.now();

  let _t3 = _t2; // set inside each branch below
  let externalCandidates: CandidateBook[];
  let olResult: OLResult = {
    candidates:           [],
    ol_queries:           [],
    top_genres_used:      [],
    liked_subjects_used:  [],
    liked_authors_used:   [],
    excluded_read_books:  [],
  };

  if (cacheResult?.isFresh) {
    externalCandidates = cacheResult.candidates;
    // Reconstruct trace from cache retrieval_reasons.
    // Strip CACHE_VERSION prefix (e.g. "v3:") so trace shows clean reason strings.
    const cacheReasons = cacheResult.candidates
      .map(c => c._retrieval_reason.startsWith(CACHE_VERSION)
        ? c._retrieval_reason.slice(CACHE_VERSION.length)
        : c._retrieval_reason)
      .filter(Boolean);
    olResult.ol_queries = [...new Set(cacheReasons)].slice(0, 10);

    // Reconstruct the trace attribution fields from the cached retrieval reason
    // strings. Without this, genres_used / liked_subjects_used / liked_authors_used
    // all show as [] on cache hits, making the debug panel lie about how retrieval
    // actually worked. Each reason was written with a structured prefix:
    //   genre:<genre>            from standard mode genre anchors
    //   lane:<lane>              from dense-import mode lane anchors
    //   liked_subject:<subject>  from liked-subject anchors
    //   author_anchor:<author>   from standard mode author anchor
    //   repeated_author:<author> from dense-import mode author anchors
    const genresSet   = new Set<string>();
    const subjSet     = new Set<string>();
    const authorsSet  = new Set<string>();
    for (const reason of cacheReasons) {
      if      (reason.startsWith('genre:'))           genresSet.add(reason.slice(6));
      else if (reason.startsWith('lane:'))            genresSet.add(reason.slice(5));
      else if (reason.startsWith('liked_subject:'))   subjSet.add(reason.slice(14));
      else if (reason.startsWith('author_anchor:'))   authorsSet.add(reason.slice(14));
      else if (reason.startsWith('repeated_author:')) authorsSet.add(reason.slice(16));
    }
    olResult.top_genres_used      = [...genresSet];
    olResult.liked_subjects_used  = [...subjSet];
    olResult.liked_authors_used   = [...authorsSet];
    _t3 = Date.now(); // cache_hit path — no OL latency
  } else {
    // ── Source C: live OL or session cache ───────────────────────────────
    const excludeForOL = new Set([
      ...local.readExternalIds,
      ...catalogExternalIds,
      ...(cacheResult?.candidates.map(c => c.external_id).filter((x): x is string => !!x) ?? []),
      ...(additionalExcludeIds ?? []),
    ]);

    // ── Session-level OL candidate cache (module-level, survives tab switches) ─
    // Checked BEFORE the forensic bypass so it serves the dev user too.
    // Reuse when: same user, same signal count, cache younger than OL_SESSION_TTL_MS.
    // Re-apply current exclusion set so newly-finished books are always excluded.
    const currentSignal = profile.strongSignalCount ?? 0;
    const olSessionValid =
      !forceNewOL &&                                                    // bypass: always go live
      _olCandidateSession !== null &&
      _olCandidateSession.userId      === userId &&
      _olCandidateSession.signalCount === currentSignal &&
      (Date.now() - _olCandidateSession.loadedAt) < OL_SESSION_TTL_MS;

    if (olSessionValid) {
      if (__DEV__) console.log(
        '[PERF] phase2_external_fetch_start — ol_session_cache_hit',
        `| age_ms=${Date.now() - _olCandidateSession!.loadedAt}`,
        `| signal=${currentSignal}`,
      );
      olResult = _olCandidateSession!.result;
      // Re-apply current exclusion in case user's read set changed since cache was built
      const reincluded = olResult.candidates.filter(
        b => !b.external_id || !excludeForOL.has(b.external_id)
      );
      externalCandidates = reincluded;
      if (__DEV__) console.log('[PERF] phase2_external_fetch_end — ol_session_cache_hit', `| candidates=${reincluded.length}`);
      _t3 = Date.now();
    } else {
      // ── Live OL multi-anchor fetch ─────────────────────────────────────
      if (__DEV__) console.log('[PERF] phase2_external_fetch_start — live_ol');
      olResult = await getOLCandidates(profile, local.readExternalIds, excludeForOL, local.trueReadExternalIds);
      if (__DEV__) console.log('[PERF] phase2_external_fetch_end — live_ol', `| ms=${Date.now() - _t2}`, `| candidates=${olResult.candidates.length}`);

      // Save to session cache for background refreshes within this session
      _olCandidateSession = { userId, result: { ...olResult }, signalCount: currentSignal, loadedAt: Date.now() };

      // Merge fresh OL on top of any stale cache rows for breadth
      const stale       = cacheResult?.candidates ?? [];
      const olExtIds    = new Set(olResult.candidates.map(b => b.external_id).filter((x): x is string => !!x));
      const nonDupStale = stale.filter(b => !olExtIds.has(b.external_id ?? ''));

      externalCandidates = [...olResult.candidates, ...nonDupStale];

      // Persist OL results (best-effort, async)
      persistOLCandidates(client, userId, olResult.candidates).catch(() => {});
      _t3 = Date.now(); // live_ol path — includes full OL fetch latency
    }
  }

  // ── Merge exact-series seeds (await the parallel fetch started above) ────────
  // Seeds are deduplicated against OL/cache results here, then held in
  // exactSeedsNew.  They are NOT merged into externalCandidates at this point
  // so they bypass the main hygiene pass.  Hygiene filters OL metadata quality
  // (missing subjects, PD authors, etc.) — curated series seeds are validated
  // by getEligibleSeriesSeeds and must survive the quality gate even when
  // fetchOLByTitle returns a low-metadata edition (ol_no_subjects check would
  // otherwise evict them on cold start).  Safety-net (already-read exclusion)
  // is still applied to seeds below, after the main hygiene pass.
  if (__DEV__) console.log('[PERF] seed_lookup_start', `| elapsed_since_fetch_start_ms=${Date.now() - _seedFetchStartMs}`);
  const exactSeedsRaw = await exactSeedsFetchP;
  const _t4 = Date.now(); // seeds latency (parallel with OL/cache — may be ≈0 on cache hit)
  if (__DEV__) console.log('[PERF] seed_lookup_end', `| wait_ms=${Date.now() - _seedFetchStartMs}`, `| raw_count=${exactSeedsRaw.length}`);
  let exactSeedsNew: CandidateBook[] = [];
  if (exactSeedsRaw.length > 0) {
    const existingExtIds = new Set(
      externalCandidates.map(b => b.external_id).filter((x): x is string => !!x)
    );
    exactSeedsNew = exactSeedsRaw.filter(
      b => b.external_id == null || !existingExtIds.has(b.external_id)
    );
    if (exactSeedsNew.length > 0 && __DEV__) {
      console.log(
        `[EXACT_SEEDS] added ${exactSeedsNew.length} exact-series book(s) to pool: [` +
        exactSeedsNew.map(b => `"${b.title}" [${b._retrieval_reason}]`).join(', ') +
        `]`,
      );
    }
  }

  // ── Top trait anchors for trace ────────────────────────────────────────────
  const top_traits_used = Object.entries(profile.preferred_traits)
    .filter(([, v]) => v > 0.3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  // ── Merge all candidates ───────────────────────────────────────────────────
  // When exhaustion-bypass reload passes additionalExcludeIds (acted-on IDs),
  // filter the local catalog pool too so dismissed books are excluded from all
  // three candidate sources (external cache, OL live, and catalog).
  const localCandidates = additionalExcludeIds
    ? local.candidates.filter(c =>
        !additionalExcludeIds.has(c.id) &&
        !(c.external_id && additionalExcludeIds.has(c.external_id))
      )
    : local.candidates;
  const all = [...externalCandidates, ...localCandidates];

  // ── Hard finished/DNF exclusion (safety-net layer) ────────────────────────
  // Layer 1: book UUID match (readIds) — already applied in getLocalCandidates
  //          for local catalog books.
  // Layer 2: external_id match (readExternalIds) — applied per source above.
  // Layer 3: normalized title+author — catches Goodreads-imported books whose
  //          books.external_id is a Google Books ID (or NULL), so the same work
  //          returning from OL under a different key would otherwise slip through.
  //
  // This runs BEFORE scoring so no finished/DNF book ever reaches ranking.
  const preFilterCount = all.length;
  const safeAll = all.filter(b => {
    if (!b.title || !b.author) return true; // can't match without metadata, keep
    return !local.finishedDnfNormalized.has(normBookKey(b.title, b.author));
  });
  const safeNetExcluded = preFilterCount - safeAll.length;

  if (__DEV__) {
    console.log(
      '[EXCLUSION_AUDIT]',
      `library_finished_dnf=${local.finishedDnfCount}`,
      `| candidates_before_safety_net=${preFilterCount}`,
      `| safety_net_excluded=${safeNetExcluded}`,
      `| candidates_after=${safeAll.length}`,
    );
    if (safeNetExcluded > 0) {
      // Log the titles that were caught by the safety net (not by external_id)
      const safeAllIds = new Set(safeAll.map(b => b.id));
      const caught = all
        .filter(b => !safeAllIds.has(b.id))
        .map(b => `"${b.title}" / "${b.author}" [ext:${b.external_id ?? 'none'}]`);
      console.log('[EXCLUSION_AUDIT] safety_net_caught:', caught);
    }
  }

  // ── Enrichment (cache-first; GB calls are non-blocking background) ───────────
  if (__DEV__) console.log('[PERF] phase2_metadata_hydration_start', `| candidates=${safeAll.length}`);
  const enrichmentMap = await getEnrichmentForCandidates(client, safeAll);
  const _t5 = Date.now(); // enrichment_ms (DB batch read only; GB calls are background)
  if (__DEV__) console.log('[PERF] phase2_metadata_hydration_end', `| ms=${_t5 - _t4}`, `| enriched=${enrichmentMap.size}`);

  // ── Hygiene filter ─────────────────────────────────────────────────────────
  const hygiene = applyHygiene(
    safeAll,
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

  // ── Append exact-series seeds post-hygiene ────────────────────────────────
  // Seeds held in exactSeedsNew bypassed the main hygiene pass (see comment
  // above) so they are always counted in the pool before the quality gate
  // fires.  Safety-net (already-read by normalized title+author) is still
  // applied here.  Dedup against filtered prevents double-counting seeds
  // that already survived hygiene (e.g. an OL edition with full subjects).
  const preSeedPool = filtered.length;
  if (__DEV__) console.log('[PERF] seed_merge_start', `| pool_before=${preSeedPool}`, `| seeds_available=${exactSeedsNew.length}`);
  if (exactSeedsNew.length > 0) {
    const safeSeeds = exactSeedsNew.filter(b => {
      if (!b.title || !b.author) return true;
      return !local.finishedDnfNormalized.has(normBookKey(b.title, b.author));
    });
    if (safeSeeds.length > 0) {
      const filteredExtIds = new Set(filtered.map(b => b.external_id).filter((x): x is string => !!x));
      const filteredIds    = new Set(filtered.map(b => b.id));
      const seedsToAdd     = safeSeeds.filter(b =>
        !filteredIds.has(b.id) &&
        (b.external_id == null || !filteredExtIds.has(b.external_id))
      );
      if (seedsToAdd.length > 0) {
        filtered = [...filtered, ...seedsToAdd];
        if (__DEV__) {
          console.log(
            `[SEEDS_POSTGATING] appended ${seedsToAdd.length} seed(s) post-hygiene` +
            ` (pre_seed_pool=${preSeedPool} → post_seed_pool=${filtered.length})`,
          );
        }
      }
    }
  }
  if (__DEV__) console.log('[PERF] seed_merge_end', `| pool_after=${filtered.length}`, `| seeds_added=${filtered.length - preSeedPool}`);

  const det = profile.det_lanes;
  // Consistent with getOLCandidates: pattern evidence, not import flag
  const isDense = !!(det && (det.dominant_lanes.length >= 2 || det.repeated_liked_authors.length >= 3));

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

  // OL-excluded supplement (additive fallback only — seriesReadSet was already
  // built from local.readBooks before the OL fetch; this can only ADD series,
  // never remove them, so it does not affect stability).
  if (olResult.excluded_read_books.length > 0) {
    const olSupp = buildSeriesReadSet(olResult.excluded_read_books);
    for (const s of olSupp) seriesReadSet.add(s);
    if (__DEV__ && olSupp.size > 0) {
      console.log(`[SERIES_RS_OL] fallback added ${olSupp.size} series from OL-excluded: [${[...olSupp].join(', ')}] → total=${seriesReadSet.size}`);
    }
  }

  const _t6 = Date.now();
  if (__DEV__) {
    const cacheHit = cacheResult?.isFresh ?? false;
    console.log(
      '[REC_TIMING]',
      `retrieval_local_ms=${_t1 - _t0}`,
      `| cache_check_ms=${_t2 - _t1}`,
      `| ol_ms=${_t3 - _t2} (${cacheHit ? 'cache_hit' : 'live_ol'})`,
      `| seeds_ms=${_t4 - _t3}`,
      `| enrichment_ms=${_t5 - _t4}`,
      `| filter_hygiene_ms=${_t6 - _t5}`,
      `| total_candidate_ms=${_t6 - _t0}`,
      `| candidates_out=${filtered.length}`,
    );
    // Write to module-level store so UI overlay can display without DevTools.
    // total_pipeline_ms is filled in by the search.tsx caller after ranking.
    __devTimingsRef.current = {
      retrieval_local_ms:  _t1 - _t0,
      cache_check_ms:      _t2 - _t1,
      ol_ms:               _t3 - _t2,
      ol_source:           cacheHit ? 'cache_hit' : 'live_ol',
      seeds_ms:            _t4 - _t3,
      enrichment_ms:       _t5 - _t4,
      filter_hygiene_ms:   _t6 - _t5,
      total_candidate_ms:  _t6 - _t0,
      total_pipeline_ms:   0,   // filled by caller
      timestamp:           _t6,
    };
  }

  if (__DEV__) console.log('[PERF] phase2_candidate_generation_end', `| ms=${Date.now() - _t0}`, `| pool=${filtered.length}`);
  return { candidates: filtered, enrichmentMap, retrieval_trace, seriesReadSet, seriesProgress, seriesPositionsRead, authorReadCounts };
}

// ── Convenience async wrapper ─────────────────────────────────────────────────

export async function getPersonalizedRecs(
  client:                SupabaseClient,
  userId:                string,
  profile:               TasteProfile,
  limit                  = 5,
  feedback?:             FeedbackContext,
  intent?:               NextReadIntent,
  additionalExcludeIds?: Set<string>,
  forceNewOL?:           boolean,
): Promise<RankedRecsResult> {
  const { candidates, enrichmentMap, retrieval_trace, seriesReadSet, seriesProgress, seriesPositionsRead, authorReadCounts } =
    await getCandidateBooks(client, userId, profile, feedback, additionalExcludeIds, forceNewOL);
  return getRankedRecs(candidates, profile, limit, feedback, enrichmentMap, retrieval_trace, intent, seriesReadSet, seriesProgress, authorReadCounts, seriesPositionsRead);
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
  intent?:     NextReadIntent,
  opts?:       { skipCache?: boolean; additionalExcludeIds?: Set<string>; forceNewOL?: boolean },
): Promise<RankedRecsResult> {
  // ── Step 1: Deterministic pipeline (always runs) ──────────────────────────
  const { candidates, enrichmentMap, retrieval_trace, seriesReadSet, seriesProgress, seriesPositionsRead, authorReadCounts } =
    await getCandidateBooks(client, userId, profile, feedback, opts?.additionalExcludeIds, opts?.forceNewOL);
  if (__DEV__) console.log('[PERF] phase2_scoring_start', `| candidates=${candidates.length}`);
  const _scoreStart = Date.now();
  const baseResult = getRankedRecs(candidates, profile, limit, feedback, enrichmentMap, retrieval_trace, intent, seriesReadSet, seriesProgress, authorReadCounts, seriesPositionsRead);
  if (__DEV__) console.log('[PERF] phase2_scoring_end', `| ms=${Date.now() - _scoreStart}`);

  // ── Forensic audit log (forensic user only, dev mode) ────────────────────
  if (__DEV__ && userId === FORENSIC_USER_ID) {
    const fmt2 = (n: number) => +n.toFixed(2);
    const det   = profile.det_lanes;
    // Use pattern evidence, consistent with getOLCandidates + getCandidateBooks
    const isDense = !!(det && (det.dominant_lanes.length >= 2 || det.repeated_liked_authors.length >= 3));
    const cog     = computeCenterOfGravity(profile);

    // ── BLOCK A: Profile (chunked — each log ≤ 400 chars of payload) ─────
    console.log('[FA1]', JSON.stringify({
      uid:  userId.slice(0, 8),
      tier: profile.tier,
      sc:   profile.strongSignalCount,
      ibc:  profile.evidence.imported_books_count,
      dense: isDense,
    }));
    console.log('[FA2_AFFIN]', JSON.stringify(
      Object.fromEntries(
        Object.entries(profile.genre_affinities)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, fmt2(v)])
      )
    ));
    console.log('[FA3_TRAITS]', JSON.stringify(
      Object.fromEntries(
        Object.entries(profile.preferred_traits)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([k, v]) => [k, fmt2(v)])
      )
    ));
    console.log('[FA4_SUBJ]', JSON.stringify((profile.liked_subjects ?? []).slice(0, 15)));
    console.log('[FA5_AUTHORS]', JSON.stringify({
      liked:    (profile.liked_authors ?? []).slice(0, 10),
      repeated: (det?.repeated_liked_authors ?? []).slice(0, 10),
    }));
    console.log('[FA6_LANES]', JSON.stringify({
      det_lanes:       det?.dominant_lanes ?? [],
      commercial_prior: det ? fmt2(det.commercial_prior) : null,
    }));
    console.log('[FA7_COG]', JSON.stringify({
      is_dense:           cog.is_dense,
      commercial_bias:    fmt2(cog.commercial_bias),
      literary_tolerance: fmt2(cog.literary_tolerance),
      memoir_tolerance:   fmt2(cog.memoir_tolerance),
      has_fantasy_core:   cog.has_fantasy_core,
      has_suspense_core:  cog.has_suspense_core,
      has_romance_core:   cog.has_romance_core,
      has_memoir_core:    cog.has_memoir_core,
    }));

    // ── BLOCK B: Retrieval (chunked) ──────────────────────────────────────
    console.log('[FB1_RETR]', JSON.stringify({
      dense_mode:      retrieval_trace.dense_import_mode,
      detected_lanes:  retrieval_trace.detected_lanes,
      catalog:         baseResult.meta.catalog_count,
      live_ol:         baseResult.meta.live_ol_count,
      cached_ext:      baseResult.meta.cached_external_count,
      excl:            baseResult.meta.hygiene_excluded,
      pool:            baseResult.meta.pool_size,
    }));
    console.log('[FB2_TRACE]', JSON.stringify({
      genres_used:   retrieval_trace.top_genres_used,
      subjects_used: retrieval_trace.liked_subjects_used,
      authors_used:  retrieval_trace.liked_authors_used,
      ol_queries:    retrieval_trace.ol_queries,
    }));

    // ── BLOCK C: Top 20 candidates — split into two rows of 10 ───────────
    // Also compute subject overlap for each book vs profile.liked_subjects
    const likedSubjSet = new Set((profile.liked_subjects ?? []).map(s => s.toLowerCase().trim()));
    const top20 = (baseResult.meta.candidate_audit ?? []).slice(0, 20).map((b, i) => {
      const lane    = detectBookLane(b);
      const subtype = detectBookMysterySubtype(b);
      const bd      = b._score_breakdown;
      // Count subject matches
      const bookSubjs  = (b.subjects ?? []).map(s => s.toLowerCase().trim());
      const subjHits   = bookSubjs.filter(s => likedSubjSet.has(s));
      const subjOverlap = Math.min(0.06, subjHits.length * 0.02);
      return {
        r:  i + 1,
        t:  b.title.slice(0, 28),
        tr: bd.trait_alignment,
        gb: bd.genre_bonus,
        so: +subjOverlap.toFixed(2),   // subject overlap bonus
        sh: subjHits.slice(0, 2),      // matching subject strings
        sc: +bd.final_score.toFixed(2),
        fc: bd.fit_class ?? null,
        ln: lane,
        fl: bd.audit_flags.slice(0, 2),
      };
    });
    console.log('[FC1_TOP10]', JSON.stringify(top20.slice(0, 10)));
    console.log('[FC2_TOP20]', JSON.stringify(top20.slice(10, 20)));

    // ── BLOCK D: Final ranked feed — top 15 (one per log call) ───────────
    baseResult.recs.slice(0, 15).forEach((r, i) => {
      const bd = r._score_breakdown;
      console.log(`[FD${i+1}]`, JSON.stringify({
        rank:    i + 1,
        title:   r.title.slice(0, 30),
        author:  r.author,
        score:   r.score,
        lane:    detectBookLane(r),
        fit:     bd.fit_class ?? null,
        cog_d:   bd.cog_score_delta ?? null,
        eq:      bd.explanation_quality ?? 'unset',
        r0:      (r.reasons[0] ?? '').slice(0, 55),
        r1:      (r.reasons[1] ?? '').slice(0, 45),
        trait:   bd.trait_alignment,
        genre_b: bd.genre_bonus,
        rep_auth: bd.repeated_author_match ?? false,
        flags:   bd.audit_flags,
      }));
    });

    // ── BLOCK E: Explanation quality summary across full feed ─────────────
    const eqCounts = { strong: 0, acceptable_specific: 0, acceptable_generic: 0, weak: 0, unset: 0 };
    for (const r of baseResult.recs) {
      const q = r._score_breakdown.explanation_quality ?? 'unset';
      (eqCounts as any)[q] = ((eqCounts as any)[q] ?? 0) + 1;
    }
    const weakTitles = baseResult.recs
      .filter(r => r._score_breakdown.explanation_quality === 'weak')
      .map(r => r.title.slice(0, 25));
    const unsetTitles = baseResult.recs
      .filter(r => !r._score_breakdown.explanation_quality)
      .map(r => r.title.slice(0, 25));
    console.log('[FE_EQ_SUMMARY]', JSON.stringify({
      total:               baseResult.recs.length,
      strong:              eqCounts.strong,
      acc_specific:        eqCounts.acceptable_specific,
      acc_generic:         eqCounts.acceptable_generic,
      weak:                eqCounts.weak,
      unset:               eqCounts.unset,
      weak_titles:  weakTitles,
      unset_titles: unsetTitles,
    }));
  }

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
  // Forensic mode: skip rec_cache entirely so we always see live expert run
  if (__DEV__ && userId === FORENSIC_USER_ID) {
    console.log('[FORENSIC] rec_cache BYPASSED for expert path');
  }
  const cacheCheck = (__DEV__ && userId === FORENSIC_USER_ID) || opts?.skipCache
    ? { hit: false, entry: null, reason: 'forensic_bypass' as const }
    : await loadCachedRecs(client, userId);

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
      // Return cached expert result — forward continuation bucket from deterministic pass
      const cachedRecs = cacheCheck.entry.rec_set;
      const cachedCont = baseResult.continuations ?? [];
      return {
        recs:          [...cachedCont, ...cachedRecs],
        continuations: cachedCont,
        discoveries:   cachedRecs,
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
  const allScored = getRankedRecs(candidates, profile, EXPERT_JUDGE_CAP, feedback, enrichmentMap, retrieval_trace, intent, seriesReadSet, seriesProgress, undefined, seriesPositionsRead);
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

  const expertCont = baseResult.continuations ?? [];
  return {
    recs:          [...expertCont, ...expertRecs],
    continuations: expertCont,
    discoveries:   expertRecs,
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
