// =============================================================================
// Book Traits — deterministic extraction of measurable attributes
//
// Given available book metadata, returns:
//   - primaryGenre : best-guess genre key, or null
//   - bookForm     : detected prose form (poetry / short_stories / play / etc.)
//   - genres       : list of genre keys
//   - traits       : Record<TraitName, 0.0–1.0 signal strength>
//
// Design rules:
//   1. Book FORM is detected first and restricts which traits are valid.
//      Poetry cannot receive Characters/Ending/Pacing — those traits are
//      prose-specific and produce nonsensical explanations.
//   2. Genre base traits are only applied for prose books (bookForm == null).
//      If a form is detected, form-specific trait bases take precedence.
//   3. Each base trait is a "ceiling", not a guarantee — page-count and
//      metadata adjustments can push values up or down within [0, 1].
// =============================================================================

// ── Book form ─────────────────────────────────────────────────────────────────

export type BookForm =
  | 'poetry'
  | 'short_stories'
  | 'play'
  | 'graphic'
  | 'anthology';

// ── P4B BookIntelligence trait foundation (additive) ─────────────────────────
//
// Semantic traits are EVIDENCE FIELDS, not opinions. Their job is to expose
// what we know about a book in a typed, conservative shape that later phases
// (P4C ScoreContributions, semantic intelligence plane) can attach to without
// having to re-do deterministic inference. P4B is observe-only — none of
// these fields are wired into scoring, ranking, composition, retrieval, or
// explanation copy.
//
// Hard rules:
//   1. Unknown-first. Weak / ambiguous / absent evidence → 'unknown'.
//   2. No LLM, no embedding, no new network calls.
//   3. Subject-driven signals are word-boundary matched (not substring), per
//      the documented Gotcha in replit.md — the same root cause that broke
//      detectGenre in P3A live smoke.
//   4. Genre alone is not enough evidence for tone/pace/complexity except
//      under an extremely conservative allowlist, individually documented.
//   5. Confidence tracks the *quality* of the matched evidence:
//        'specific' — at least one multi-word / unambiguous subject phrase
//                     matched (e.g. "psychological thriller" for pace=fast)
//        'broad'    — only a single-token bare signal matched
//                     (e.g. just "thriller" for pace=fast)
//        'unknown'  — no evidence
export type ToneCategory       = 'light' | 'dark' | 'mixed' | 'unknown';
export type PaceCategory       = 'fast' | 'medium' | 'slow' | 'unknown';
export type ComplexityCategory = 'accessible' | 'literary' | 'dense' | 'unknown';
export type LengthClass        = 'short' | 'standard' | 'long' | 'tome' | 'unknown';
export type TraitConfidence    = 'specific' | 'broad' | 'unknown';

export type SeriesPosition = {
  seriesName?: string;
  index?:      number;
  /** Total volumes in the series, when known from the curated catalog. */
  of?:         number;
};

export type BookTraits = {
  primaryGenre: string | null;
  bookForm:     BookForm | null;
  genres:       string[];
  traits:       Record<string, number>;

  // ── P4B additive fields (default 'unknown' / null) ─────────────────────
  tone:                 ToneCategory;
  toneConfidence:       TraitConfidence;
  pace:                 PaceCategory;
  paceConfidence:       TraitConfidence;
  complexity:           ComplexityCategory;
  complexityConfidence: TraitConfidence;
  lengthClass:          LengthClass;
  seriesPosition:       SeriesPosition | null;
};

// ── Form detection signals ────────────────────────────────────────────────────

const POETRY_SIGNALS = [
  'poetry', 'poems', 'poem', 'poet', 'verse', 'verses', 'sonnet', 'sonnets',
  'haiku', 'ode', 'odes', 'ballad', 'ballads', 'lyric poetry', 'epic poem',
  'collected poems', 'selected poems', 'complete poems',
];

const SHORT_STORY_SIGNALS = [
  'short stories', 'short story', 'short fiction', 'novellas', 'novella',
  'tale collection', 'tales collection',
  // NOTE: bare 'stories' intentionally omitted — it matches too many OL subject
  // tags (e.g. "Legal stories, American", "Fiction—stories") and causes
  // novels like To Kill a Mockingbird to be misclassified.
];

const PLAY_SIGNALS = [
  'drama', 'plays', 'theater', 'theatre', 'screenplay', 'script', 'stage play',
  'dramatic works',
];

const GRAPHIC_SIGNALS = [
  // NOTE: bare 'comic' intentionally omitted — it matches the very common OL
  // tag "Comic books, strips, etc." as a substring and fires on prose books
  // (e.g. Parable of the Sower) that happen to receive that OL classification.
  // Use the more specific 'comics', 'comic book', 'comic strip' instead.
  'comics', 'graphic novel', 'manga', 'illustrated novel',
  'sequential art', 'comic book', 'comic strip',
];

const ANTHOLOGY_SIGNALS = [
  'anthology', 'collected works', 'selected works', 'complete works',
  'complete collection',
];

export function detectBookForm(book: {
  subjects?:    string[] | null;
  title?:       string | null;
  description?: string | null;
}): BookForm | null {
  const corpus = [
    ...(book.subjects ?? []),
    book.title ?? '',
  ].join(' ').toLowerCase();

  if (POETRY_SIGNALS.some(s => corpus.includes(s)))      return 'poetry';
  if (PLAY_SIGNALS.some(s => corpus.includes(s)))         return 'play';
  if (GRAPHIC_SIGNALS.some(s => corpus.includes(s)))      return 'graphic';
  if (ANTHOLOGY_SIGNALS.some(s => corpus.includes(s)))    return 'anthology';
  if (SHORT_STORY_SIGNALS.some(s => corpus.includes(s)))  return 'short_stories';
  return null;
}

// ── Traits that are NOT applicable for a given form ───────────────────────────
// Any trait in this set is zeroed-out / removed from inference for that form,
// preventing nonsensical explanations like "characters" for a poetry collection.

const FORM_TRAIT_BLACKLIST: Record<BookForm, Set<string>> = {
  poetry: new Set([
    'Characters', 'Ending', 'Twists', 'Plot', 'Pacing', 'Tension',
    'Suspense', 'Worldbuilding', 'Scope', 'Chemistry', 'Emotional payoff',
    'Evidence', 'Clarity', 'Practicality', 'Structure',
  ]),
  play: new Set([
    'Pacing', 'Worldbuilding', 'Scope', 'Twists', 'Evidence',
    'Clarity', 'Practicality', 'Chemistry', 'Emotional payoff',
  ]),
  short_stories: new Set(['Scope', 'Worldbuilding']),
  graphic: new Set([
    'Prose', 'Insight', 'Evidence', 'Clarity', 'Practicality',
    'Structure', 'Depth', 'Scope',
  ]),
  anthology: new Set(['Pacing', 'Twists', 'Tension', 'Suspense', 'Chemistry', 'Emotional payoff']),
};

// ── Form-specific trait base (replaces genre base entirely for that form) ─────
const FORM_TRAIT_BASE: Partial<Record<BookForm, Record<string, number>>> = {
  poetry: {
    Prose:        0.90,
    Originality:  0.82,
    Writing:      0.88,
    Depth:        0.72,
    Atmosphere:   0.68,
    Emotional:    0.72,
  },
  play: {
    Characters:   0.85,
    Atmosphere:   0.80,
    Tension:      0.72,
    Depth:        0.68,
    Writing:      0.72,
    Originality:  0.65,
    Ending:       0.62,
  },
  graphic: {
    Atmosphere:   0.82,
    Pacing:       0.72,
    Characters:   0.75,
    Originality:  0.68,
    Tension:      0.65,
    Ending:       0.58,
  },
  anthology: {
    Writing:      0.80,
    Originality:  0.72,
    Depth:        0.65,
    Prose:        0.70,
    Atmosphere:   0.60,
    Characters:   0.60,
  },
};

// ── Genre detection signals (ordered by specificity — first match wins) ────────

// Order is load-bearing: first-match wins inside detectGenre().
//
// History of this list:
//   1. Original: memoir_bio → nonfiction → horror → romance → thriller →
//      fantasy_scifi → literary. With `corpus.includes()` substring
//      matching this leaked fiction books into nonfiction because the
//      nonfiction signal list contained broad single tokens (`science`,
//      `history`, `psychology`, `philosophy`, `technology`, `sociology`)
//      that appear inside fiction subjects (`science fiction`,
//      `historical fiction`, `psychological thriller`, `Greek mythology
//      / ancient history`, `psychology of grief`). This was the Scenario
//      B P3A live-smoke blocker.
//
//   2. Two complementary changes close the leak:
//      (a) detectGenre() switched from `includes()` to pre-compiled
//          word-boundary regex (`\b<token>\b`, case-insensitive) — see
//          GENRE_SIGNAL_MATCHERS below. This is the documented Gotcha in
//          replit.md ("word-boundary regex, never includes()").
//      (b) The broad single tokens were pruned from the nonfiction list.
//          Coverage of those domains is preserved via unambiguous
//          compound forms (`popular science`, `science nonfiction`,
//          `pop history`, etc.) plus the umbrella `nonfiction` /
//          `non-fiction` tokens that genuine nonfiction subjects nearly
//          always carry.
//
//   3. Bucket order: memoir_bio → nonfiction → fiction buckets →
//      literary. The user-supplied spec recommended putting `nonfiction`
//      LAST, but the architect surfaced a regression on mixed-tag true
//      nonfiction — e.g. `['true crime','mystery','nonfiction']` or
//      `['political thriller','nonfiction']` — where the fiction bucket
//      fires first and traps a book that is clearly nonfiction by its
//      `nonfiction` anchor tag. The spec explicitly permitted deviation
//      ("If you choose a different order, justify it.") and the prune
//      in (2b) makes nonfiction-second safe: every remaining signal in
//      the nonfiction list now requires either the literal `nonfiction`
//      / `non-fiction` token or an unambiguous compound nonfiction
//      string (`popular science`, `true crime`, etc.), none of which
//      appear inside fiction subjects under word-boundary matching.
export const GENRE_SIGNALS: Array<[string, string[]]> = [
  ['memoir_bio',       ['memoir', 'autobiography', 'biography', 'biographical']],
  ['nonfiction',       ['nonfiction', 'non-fiction', 'self-help', 'business', 'economics',
                        'politics', 'true crime', 'popular science', 'pop science',
                        'science nonfiction', 'popular nonfiction', 'public policy',
                        'history nonfiction', 'pop history', 'narrative nonfiction',
                        'creative nonfiction', 'investigative journalism']],
  ['fantasy_scifi',    ['fantasy', 'science fiction', 'sci-fi', 'speculative fiction',
                        'dystopian', 'magical realism', 'space opera', 'epic fantasy',
                        'urban fantasy', 'alternate history']],
  ['thriller_mystery', ['thriller', 'mystery', 'crime fiction', 'detective', 'suspense',
                        'noir', 'whodunit', 'spy fiction']],
  ['romance',          ['romance', 'romantic fiction', 'love story', "women's fiction", 'chick lit']],
  ['horror',           ['horror', 'gothic', 'ghost story', 'supernatural', 'occult',
                        'vampire', 'zombie']],
  ['literary',         ['literary fiction', 'literary', 'contemporary fiction']],
];

// Pre-compiled word-boundary matchers for each signal. Compiled once at
// module load (not per-detectGenre call) so the hot scoring path stays
// allocation-free. `\b` works at the boundary between a word character
// (`[A-Za-z0-9_]`) and a non-word character, so multi-word signals like
// `"science fiction"` and hyphenated signals like `"non-fiction"` still
// match cleanly (the hyphen is a non-word char, the boundary lands on
// each word's edges).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const GENRE_SIGNAL_MATCHERS: Array<[string, RegExp[]]> = GENRE_SIGNALS.map(
  ([genre, signals]) => [
    genre,
    signals.map(s => new RegExp(`\\b${escapeRegex(s)}\\b`, 'i')),
  ],
);

// ── Base trait scores per genre ───────────────────────────────────────────────
//
// These are genre-level priors — how strongly a given trait typically features
// in that genre. Individual books will vary; these are starting estimates only.
//
// 0.9 = defining feature,  0.5 = moderate presence,  0 = absent / inapplicable.

const GENRE_TRAIT_BASE: Record<string, Record<string, number>> = {
  fantasy_scifi: {
    Worldbuilding: 0.90, Atmosphere: 0.82, Scope: 0.88, Originality: 0.76,
    Characters:    0.72, Pacing:      0.58, Tension: 0.65, Ending: 0.65,
  },
  thriller_mystery: {
    Suspense: 0.92, Pacing: 0.86, Twists: 0.88, Tension: 0.88,
    Plot:     0.85, Characters: 0.60, Atmosphere: 0.72, Ending: 0.78,
  },
  romance: {
    Chemistry: 0.92, 'Emotional payoff': 0.88, Characters: 0.82, Tension: 0.72,
    Ending:    0.82, Pacing: 0.62, Writing: 0.65, Depth: 0.52,
  },
  horror: {
    Atmosphere: 0.92, Tension: 0.88, Suspense: 0.82, Pacing: 0.70,
    Characters: 0.60, Originality: 0.65, Ending: 0.65, Worldbuilding: 0.58,
  },
  memoir_bio: {
    Honesty: 0.92, Perspective: 0.92, Insight: 0.88, Writing: 0.72,
    Depth:   0.82, Structure: 0.65, Pacing: 0.52,
  },
  nonfiction: {
    Insight: 0.92, Evidence: 0.88, Clarity: 0.85, Structure: 0.78,
    Depth:   0.78, Practicality: 0.72, Originality: 0.65, Writing: 0.62,
  },
  literary: {
    Prose: 0.92, Characters: 0.88, Emotional: 0.82, Depth: 0.88,
    Atmosphere: 0.78, Originality: 0.78, Pacing: 0.48, Ending: 0.68,
  },
  general: {
    Pacing: 0.60, Characters: 0.60, Writing: 0.55,
    Atmosphere: 0.52, Ending: 0.52, Originality: 0.50,
  },
};

// ── Genre detection ────────────────────────────────────────────────────────────

export function detectGenre(book: {
  subjects?: string[] | null;
  title?: string | null;
  author?: string | null;
}): string | null {
  // Word-boundary matching, not substring. Substring matching is the
  // documented Gotcha in replit.md and was the root cause of the
  // Scenario B P3A live-smoke blocker — `'history'` matching inside
  // `'historical fiction'`, `'science'` matching inside
  // `'science fiction'`, etc. See GENRE_SIGNAL_MATCHERS above.
  const corpus = [
    ...(book.subjects ?? []),
    book.title  ?? '',
    book.author ?? '',
  ].join(' ');

  for (const [genre, matchers] of GENRE_SIGNAL_MATCHERS) {
    if (matchers.some(re => re.test(corpus))) return genre;
  }
  return null;
}

// ── Page-count adjustments ─────────────────────────────────────────────────────

function applyPageCount(
  traits:    Record<string, number>,
  pageCount: number | null | undefined,
): Record<string, number> {
  if (!pageCount || pageCount <= 0) return traits;
  const t = { ...traits };

  if (pageCount > 600) {
    if (t.Scope         !== undefined) t.Scope         = Math.min(1, t.Scope         + 0.10);
    if (t.Worldbuilding !== undefined) t.Worldbuilding = Math.min(1, t.Worldbuilding + 0.08);
    if (t.Pacing        !== undefined) t.Pacing        = Math.max(0, t.Pacing        - 0.12);
    if (t.Depth         !== undefined) t.Depth         = Math.min(1, t.Depth         + 0.08);
  } else if (pageCount < 250) {
    if (t.Pacing !== undefined) t.Pacing = Math.min(1, t.Pacing + 0.12);
    if (t.Scope  !== undefined) t.Scope  = Math.max(0, t.Scope  - 0.10);
  }

  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +v.toFixed(2)]));
}

// ── Metadata quality assessment ────────────────────────────────────────────────

export function assessMetadataQuality(book: {
  subjects?:    string[] | null;
  description?: string | null;
  page_count?:  number | null;
}): 'strong' | 'moderate' | 'weak' {
  const subjectCount  = (book.subjects ?? []).length;
  const hasDescription = (book.description ?? '').trim().length > 80;
  const hasPageCount   = (book.page_count ?? 0) > 0;

  const signals = (subjectCount >= 5 ? 2 : subjectCount >= 2 ? 1 : 0)
    + (hasDescription ? 2 : 0)
    + (hasPageCount   ? 1 : 0);

  if (signals >= 4) return 'strong';
  if (signals >= 2) return 'moderate';
  return 'weak';
}

// ── Deterministic reading lane types ──────────────────────────────────────────
// Used by the dense-import engine to build and compare user reading patterns.
// A "lane" is a meaningful cluster of repeated reading behaviour, coarser than
// genre (romantasy bundles fantasy + romance elements; modern_suspense bundles
// domestic thrillers, psychological thrillers, and contemporary mysteries).

export type DeterministicLane =
  | 'romantasy'            // fantasy × romance / emotional fantasy series
  | 'contemporary_fiction' // book-club women's fiction / contemporary emotional
  | 'modern_suspense'      // psychological thriller / domestic thriller / puzzle mystery
  | 'memoir_nonfiction'    // memoir / autobiography / narrative nonfiction
  | 'literary'             // literary fiction with craft/prose focus
  | 'scifi_fantasy'        // epic/spec fantasy, science fiction (no romance element)
  | 'romance'              // contemporary or historical romance (no fantasy element)
  | 'horror';              // horror / dark supernatural

export type MysterySubtype =
  | 'contemporary_thriller' // psychological thriller, domestic thriller, modern suspense
  | 'puzzle_detective'      // cozy, whodunit, amateur detective, classic puzzle
  | 'hard_boiled_noir'      // noir, hard-boiled, private detective (Chandler style)
  | 'spy_adventure';        // espionage / spy / secret-agent thriller (Fleming, le Carré)

// ── Lane detection for a single book ─────────────────────────────────────────
// Priority order: romantasy → scifi_fantasy → modern_suspense → romance →
//   memoir_nonfiction → literary → contemporary_fiction → horror
// Returns null when there is insufficient subject signal to classify.

export function detectBookLane(book: {
  subjects?: string[] | null;
  title?:    string | null;
  author?:   string | null;
}): DeterministicLane | null {
  const corpus = [
    ...(book.subjects ?? []),
    book.title  ?? '',
    book.author ?? '',
  ].join(' ').toLowerCase();

  const has = (...terms: string[]) => terms.some(t => corpus.includes(t));

  const hasFantasy  = has('fantasy', 'magic', 'fae', 'fey', 'romantasy', 'dragons', 'witch', 'sorcerer', 'spellbinding');
  const hasRomance  = has('romance', 'romantic', 'love story', 'chick lit', "women's fiction", 'contemporary romance', 'historical romance', 'love interest');
  const hasSeries   = has('series', 'trilogy', 'book 1', 'book 2');

  // Romantasy: fantasy + romance elements co-present
  if (hasFantasy && hasRomance) return 'romantasy';
  // Strong series fantasy (like Maas, Hobb) without romance subjects
  if (hasFantasy && has('epic fantasy', 'high fantasy', 'sword', 'realm', 'kingdom', 'elves', 'orcs')) return 'scifi_fantasy';
  if (hasFantasy) return 'scifi_fantasy';

  // Science fiction / speculative
  if (has('science fiction', 'sci-fi', 'sci fi', 'dystopian', 'speculative fiction', 'space opera', 'cyberpunk', 'alternate history')) return 'scifi_fantasy';

  // Hard-boiled noir — check before generic modern_suspense
  if (has('hard-boiled', 'hard boiled', 'noir', 'private detective', 'private investigator', 'pulp fiction')) return 'modern_suspense';

  // Thriller / suspense family
  if (has('psychological thriller', 'domestic thriller', 'psychological suspense', 'suspense fiction', 'legal thriller', 'medical thriller')) return 'modern_suspense';
  if (has('mystery fiction', 'mystery thriller', 'crime thriller', 'whodunit', 'cozy mystery', 'amateur detective')) return 'modern_suspense';
  if (has('thriller') && !has('historical thriller', 'literary thriller')) return 'modern_suspense';

  // Romance (no fantasy)
  if (hasRomance) return 'romance';

  // Memoir / narrative nonfiction
  if (has('memoir', 'autobiography', 'personal memoir', 'narrative nonfiction', 'creative nonfiction', 'personal narrative', 'autobiographical')) return 'memoir_nonfiction';
  if (has('biography') && !has('political biography', 'scientific biography')) return 'memoir_nonfiction';

  // Literary (strong signal required — not just "fiction" or "contemporary fiction")
  if (has('literary fiction', 'literary novel', 'literary thriller', 'man booker', 'booker prize', 'national book award')) return 'literary';

  // Contemporary fiction / book club
  if (has('book club', 'book-club', 'contemporary fiction', 'domestic fiction', 'general fiction', 'popular fiction')) return 'contemporary_fiction';
  if (hasSeries && has('fiction')) return 'contemporary_fiction';

  // Horror
  if (has('horror', 'supernatural horror', 'gothic horror', 'occult', 'paranormal')) return 'horror';

  return null;
}

// ── Mystery subtype detection for a book ─────────────────────────────────────
// Used in scoring to penalise hard-boiled/noir books for contemporary-thriller
// oriented users (Horowitz/Foley reader ≠ Chandler reader).

export function detectBookMysterySubtype(book: {
  subjects?: string[] | null;
  title?:    string | null;
}): MysterySubtype | null {
  const corpus = [
    ...(book.subjects ?? []),
    book.title ?? '',
  ].join(' ').toLowerCase();

  const has = (...terms: string[]) => terms.some(t => corpus.includes(t));

  // Spy / espionage detected first — these are distinct from domestic thriller
  if (has('espionage', 'spy fiction', 'secret service', 'intelligence service', 'cold war spy',
          'james bond', 'spy thriller', 'spy novel', 'spies')) return 'spy_adventure';
  if (has('hard-boiled', 'hard boiled', 'noir', 'private detective', 'private investigator', 'pulp fiction')) return 'hard_boiled_noir';
  if (has('cozy mystery', 'cozy', 'amateur detective', 'whodunit', 'puzzle mystery', 'classic detective', 'village mystery')) return 'puzzle_detective';
  if (has('psychological thriller', 'domestic thriller', 'psychological suspense')) return 'contemporary_thriller';
  if (has('thriller') && !has('historical', 'literary', 'espionage', 'spy')) return 'contemporary_thriller';
  if (has('mystery') && has('contemporary', 'modern', 'current')) return 'contemporary_thriller';
  return null;
}

// ── Philosophy / spiritual detection ──────────────────────────────────────────
// Used to penalise philosophy / spiritual drift for readers whose primary lane
// is memoir or commercial fiction (biography ≠ philosophy; autobiography ≠ yoga).

export function isPhilosophyOrSpiritual(book: {
  subjects?: string[] | null;
  title?:    string | null;
}): boolean {
  const corpus = [
    ...(book.subjects ?? []),
    book.title ?? '',
  ].join(' ').toLowerCase();

  const has = (...terms: string[]) => terms.some(t => corpus.includes(t));

  return has(
    'philosophy', 'philosophical', 'phenomenology', 'metaphysics',
    'existentialism', 'ethics', 'epistemology',
    'spiritual', 'spirituality', 'meditation', 'yoga', 'mindfulness',
    'hinduism', 'buddhism', 'zen', 'taoism', 'sufism', 'theosophy',
    'eastern philosophy', 'western philosophy', 'self-realization',
    'autobiography of a yogi',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// P4B · BookIntelligence trait foundation (observe-only)
// ─────────────────────────────────────────────────────────────────────────────
// All helpers below are deterministic, conservative, and unknown-first. They
// are wired into getBookTraits() so consumers see the new fields, but they
// are NOT consumed by scoring/ranking/composition/explanation today. P4C will
// emit ScoreContributions from them under a feature flag.

// ── Length class buckets (deterministic page-count thresholds) ───────────────
// Buckets agreed in the P4B spec:
//   short:    <= 240
//   standard: 241–420
//   long:     421–700
//   tome:     > 700
// Missing/non-positive page_count → 'unknown'. These thresholds are chosen
// conservatively: a 700-page book is plausibly "long" (Sanderson, Hobb), and
// "tome" is reserved for genuine doorstoppers (The Way of Kings, Infinite
// Jest, A Suitable Boy, large reference works).
export function classifyLength(pageCount: number | null | undefined): LengthClass {
  if (!pageCount || pageCount <= 0 || !Number.isFinite(pageCount)) return 'unknown';
  if (pageCount <= 240)  return 'short';
  if (pageCount <= 420)  return 'standard';
  if (pageCount <= 700)  return 'long';
  return 'tome';
}

// ── Subject signal corpus helper ─────────────────────────────────────────────
// Combines subjects + description into a single corpus that the word-boundary
// matchers test against. Title and author are intentionally excluded:
// title-only signals are noisy ("Dark Matter" the SF novel is not tonally
// dark; "Light from Uncommon Stars" is not a light read). The corpus is now
// produced by `deriveBookEvidence(book).corpus.semantic` in lib/evidence/.

// ── Tone / pace / complexity classifiers ─────────────────────────────────────
//
// As of BookEvidence Batch B (P4 hygiene), the previously-private signal
// constants TONE_DARK_SPECIFIC / TONE_DARK_BROAD / TONE_LIGHT_* / PACE_FAST_*
// / PACE_SLOW_* / COMPLEXITY_ACCESSIBLE_* / COMPLEXITY_LITERARY_* /
// COMPLEXITY_DENSE_* live in `lib/evidence/signals.ts` as exported `SignalSet`s
// (TONE_DARK, TONE_LIGHT, PACE_FAST, PACE_SLOW, COMPLEXITY_ACCESSIBLE,
// COMPLEXITY_LITERARY, COMPLEXITY_DENSE), with the `partitionBySpecificity`
// rule applied at authoring time so the runtime no longer re-partitions.
//
// The pure projections `classifyToneFromEvidence`, `classifyPaceFromEvidence`,
// `classifyComplexityFromEvidence` consume a pre-derived `BookEvidence` from
// `deriveBookEvidence(book)` and reproduce the legacy threshold logic
// (`strong = spec >= 1 || broad >= 2`) byte-identically. The public exports
// `classifyTone(book)` / `classifyPace(book)` / `classifyComplexity(book)`
// remain available as thin shims for external callers; both forms are pinned
// by `scripts/validate_book_evidence.ts §4`.

import { deriveBookEvidence, type BookEvidence } from './evidence/bookEvidence';

export function classifyToneFromEvidence(
  evidence: BookEvidence,
): { tone: ToneCategory; confidence: TraitConfidence } {
  if (!evidence.corpus.semantic.trim()) return { tone: 'unknown', confidence: 'unknown' };

  const darkSpec   = evidence.toneDark.specificCount;
  const darkBroad  = evidence.toneDark.broadCount;
  const lightSpec  = evidence.toneLight.specificCount;
  const lightBroad = evidence.toneLight.broadCount;

  const darkStrong  = darkSpec  >= 1 || darkBroad  >= 2;
  const lightStrong = lightSpec >= 1 || lightBroad >= 2;

  // Mixed: BOTH sides reach 'strong'. Requires explicit evidence both ways,
  // otherwise the stronger side wins and the weaker side is ignored.
  if (darkStrong && lightStrong) {
    const conf: TraitConfidence = (darkSpec >= 1 && lightSpec >= 1) ? 'specific' : 'broad';
    return { tone: 'mixed', confidence: conf };
  }
  if (darkStrong) {
    return { tone: 'dark', confidence: darkSpec >= 1 ? 'specific' : 'broad' };
  }
  if (lightStrong) {
    return { tone: 'light', confidence: lightSpec >= 1 ? 'specific' : 'broad' };
  }
  // A single broad hit on either side is NOT enough — 'thriller' or 'humor'
  // alone leaves tone unknown until a second corroborating signal appears.
  return { tone: 'unknown', confidence: 'unknown' };
}

export function classifyPaceFromEvidence(
  evidence: BookEvidence,
): { pace: PaceCategory; confidence: TraitConfidence } {
  if (!evidence.corpus.semantic.trim()) return { pace: 'unknown', confidence: 'unknown' };

  const fastSpec  = evidence.paceFast.specificCount;
  const fastBroad = evidence.paceFast.broadCount;
  const slowSpec  = evidence.paceSlow.specificCount;
  const slowBroad = evidence.paceSlow.broadCount;

  const fastStrong = fastSpec >= 1 || fastBroad >= 2;
  const slowStrong = slowSpec >= 1 || slowBroad >= 2;

  // Conflicting strong signals → 'medium' with confidence dropped to broad.
  // This is the analogue of tone='mixed' for pace, but pace is a 1-D
  // spectrum so the conflict resolves to the middle bucket.
  if (fastStrong && slowStrong) {
    return { pace: 'medium', confidence: 'broad' };
  }
  if (fastStrong) {
    return { pace: 'fast', confidence: fastSpec >= 1 ? 'specific' : 'broad' };
  }
  if (slowStrong) {
    return { pace: 'slow', confidence: slowSpec >= 1 ? 'specific' : 'broad' };
  }
  return { pace: 'unknown', confidence: 'unknown' };
}

export function classifyComplexityFromEvidence(
  evidence: BookEvidence,
): { complexity: ComplexityCategory; confidence: TraitConfidence } {
  if (!evidence.corpus.semantic.trim()) return { complexity: 'unknown', confidence: 'unknown' };

  const accSpec  = evidence.complexityAccessible.specificCount;
  const accBroad = evidence.complexityAccessible.broadCount;
  const litSpec  = evidence.complexityLiterary.specificCount;
  const litBroad = evidence.complexityLiterary.broadCount;
  const denSpec  = evidence.complexityDense.specificCount;
  const denBroad = evidence.complexityDense.broadCount;

  // Dense gate: at least one SPECIFIC academic/experimental signal required.
  // Pure broad hits like 'epic' or 'philosophy' alone do NOT classify as
  // dense — that was the over-classification trap the spec calls out.
  if (denSpec >= 1) {
    return { complexity: 'dense', confidence: 'specific' };
  }
  if (litSpec >= 1) {
    return { complexity: 'literary', confidence: 'specific' };
  }
  if (accSpec >= 1) {
    return { complexity: 'accessible', confidence: 'specific' };
  }
  // Broad-only fallback requires TWO matches in the same bucket.
  if (accBroad >= 2)  return { complexity: 'accessible', confidence: 'broad' };
  if (litBroad >= 2)  return { complexity: 'literary',   confidence: 'broad' };
  if (denBroad >= 2)  return { complexity: 'dense',      confidence: 'broad' };
  return { complexity: 'unknown', confidence: 'unknown' };
}

// ── Public shim entry points (book-level convenience) ────────────────────────
// Preserved so external call sites (composer evidence builders, ad-hoc tests,
// any future caller) keep working without change. Both forms produce the same
// values; pinning is via validate_book_evidence §4.

export function classifyTone(book: {
  subjects?:    string[] | null;
  description?: string | null;
}): { tone: ToneCategory; confidence: TraitConfidence } {
  return classifyToneFromEvidence(deriveBookEvidence(book));
}

export function classifyPace(book: {
  subjects?:    string[] | null;
  description?: string | null;
}): { pace: PaceCategory; confidence: TraitConfidence } {
  return classifyPaceFromEvidence(deriveBookEvidence(book));
}

export function classifyComplexity(book: {
  subjects?:    string[] | null;
  description?: string | null;
  page_count?:  number | null;
}): { complexity: ComplexityCategory; confidence: TraitConfidence } {
  return classifyComplexityFromEvidence(deriveBookEvidence(book));
}

// ── Series position parser ───────────────────────────────────────────────────
// Mirrors the conservative shape already used in lib/boxSetDetection.ts for
// cover-substitution. Recognised patterns at the END of a title:
//   "(Series Name, #2)"
//   "(Series Name #2)"
//   "(Series Name, Book 2)"
//   "(Series Name Book 2)"
// The series sub-string must contain at least one letter (guards against
// pure-number parens like "(2007)" or "(Hardcover edition)"). When the
// extracted series name matches a curated SERIES_CATALOG entry we also
// populate `of` from the catalog total.
const SERIES_SUFFIX_RE =
  /\(([^()]+?)[,\s]+(?:#\s*(\d+)|book\s+(\d+))\)\s*$/i;

export function parseSeriesPosition(
  title: string | null | undefined,
): SeriesPosition | null {
  if (!title) return null;
  const m = title.match(SERIES_SUFFIX_RE);
  if (!m) return null;
  const seriesRaw = m[1].trim();
  if (!/[a-z]/i.test(seriesRaw)) return null;
  const volStr = m[2] ?? m[3];
  if (!volStr) return null;
  const idx = parseInt(volStr, 10);
  if (!Number.isFinite(idx) || idx <= 0) return null;
  return { seriesName: seriesRaw, index: idx };
}

// Looks up `of` from the curated catalog when the parsed seriesName matches
// a SERIES_CATALOG displayName or key (with leading "the" stripped on both
// sides to mirror the matcher in boxSetDetection.ts). Kept as a separate
// function to keep parseSeriesPosition pure (no module-graph side effects)
// and so consumers that don't need catalog enrichment can skip the import.
export function enrichSeriesPositionFromCatalog(
  pos: SeriesPosition,
  catalogLookup: (normalizedName: string) => { total: number } | null,
): SeriesPosition {
  if (!pos.seriesName) return pos;
  const stripThe = (s: string) => s.replace(/^the\s+/i, '').trim();
  const norm = stripThe(pos.seriesName).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!norm) return pos;
  const hit = catalogLookup(norm);
  if (!hit) return pos;
  return { ...pos, of: hit.total };
}

// ── Main extractor ─────────────────────────────────────────────────────────────

export function getBookTraits(book: {
  subjects?:    string[] | null;
  title?:       string | null;
  author?:      string | null;
  page_count?:  number | null;
  description?: string | null;
}): BookTraits {
  const primaryGenre = detectGenre(book);
  const bookForm     = detectBookForm(book);

  let traits: Record<string, number>;

  if (bookForm && FORM_TRAIT_BASE[bookForm]) {
    // Form-specific base takes full precedence — do not mix in genre base
    traits = { ...FORM_TRAIT_BASE[bookForm]! };
  } else {
    // Genre-driven base for standard prose books
    const base = GENRE_TRAIT_BASE[primaryGenre ?? 'general'] ?? GENRE_TRAIT_BASE.general;
    traits = { ...base };

    // Remove any traits that are blacklisted for this form
    if (bookForm && FORM_TRAIT_BLACKLIST[bookForm]) {
      for (const banned of FORM_TRAIT_BLACKLIST[bookForm]) {
        delete traits[banned];
      }
    }

    traits = applyPageCount(traits, book.page_count);
  }

  // ── P4B additive evidence fields (observe-only) ─────────────────────────
  // BookEvidence Batch B: derive once, project three times. Prevents the
  // three legacy shims (classifyTone/Pace/Complexity) from each re-running
  // `deriveBookEvidence` independently.
  const evidence   = deriveBookEvidence(book);
  const tone       = classifyToneFromEvidence(evidence);
  const pace       = classifyPaceFromEvidence(evidence);
  const complexity = classifyComplexityFromEvidence(evidence);
  const lengthCls  = classifyLength(book.page_count);
  const seriesPos  = parseSeriesPosition(book.title);

  return {
    primaryGenre,
    bookForm,
    genres: primaryGenre ? [primaryGenre] : ['general'],
    traits,

    tone:                 tone.tone,
    toneConfidence:       tone.confidence,
    pace:                 pace.pace,
    paceConfidence:       pace.confidence,
    complexity:           complexity.complexity,
    complexityConfidence: complexity.confidence,
    lengthClass:          lengthCls,
    seriesPosition:       seriesPos,
  };
}
