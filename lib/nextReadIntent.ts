// =============================================================================
// Your Next Read — structured reading intent
//
// A lightweight overlay that sits on top of the taste profile. It narrows and
// guides recommendation ranking without replacing the recommendation engine.
//
//   reader taste profile × current intent = recommendation set
//
// Three tiers of intent signals:
//
//   hard    — hard filters: disqualify books that don't match
//             (lane scope, page length, fiction/nonfiction, standalone/series)
//
//   soft    — soft preferences: small score boosts toward matching books
//             (pace, tone, emotional intensity)
//             Boosts are intentionally small (±0.05) so they influence
//             rank within a tier without overriding CoG classification.
//
//   exclude — exclusions: disqualify books matching avoid conditions
//             (no classics, no dark, no literary, no romance, no nonfiction)
//
// Design rules:
//   - The taste profile still dominates final quality.
//   - Intent narrows and guides; it never replaces profile fit.
//   - All logic must generalise across all reader types, not just one profile.
//   - Hard filters are only applied when the pool is large enough to handle them.
// =============================================================================

import type { DeterministicLane } from './bookTraits';
import type { MarketPosition }              from './fitClassifier';

// ── Intent shape ──────────────────────────────────────────────────────────────

export type NextReadPace      = 'fast' | 'medium' | 'slow';
export type NextReadTone      = 'light' | 'balanced' | 'dark';
export type NextReadIntensity = 'low'  | 'medium'  | 'high';

export type NextReadIntent = {
  // Hard filters — narrow the candidate pool before diversity pass.
  // Books that fail any active hard filter are removed from recommendations.
  hard: {
    lanes?:           DeterministicLane[];  // only return books from these lanes
    fiction_only?:    boolean;              // exclude nonfiction / memoir
    nonfiction_only?: boolean;              // exclude fiction
    standalone_only?: boolean;             // exclude apparent series books
    max_page_count?:  number | null;        // exclude books longer than this
  };

  // Soft preferences — small score boosts toward matching books.
  // These influence rank within a tier, not between tiers.
  soft: {
    pace?:      NextReadPace      | null;
    tone?:      NextReadTone      | null;
    intensity?: NextReadIntensity | null;
  };

  // Exclusions — hard removes matching books from the final list.
  // Treated as intent-driven rejects (separate from CoG rejects).
  exclude: {
    avoid_classics?:   boolean;   // remove classic_canon market position
    avoid_dark?:       boolean;   // remove books with dark/disturbing subjects
    avoid_literary?:   boolean;   // remove literary_prestige market position
    avoid_romance?:    boolean;   // remove romance / romantasy market position
    avoid_nonfiction?: boolean;   // remove memoir_nonfiction market position
    avoid_series?:     boolean;   // remove apparent series books
  };
};

// ── Empty / active helpers ─────────────────────────────────────────────────────

export function emptyIntent(): NextReadIntent {
  return { hard: {}, soft: {}, exclude: {} };
}

export function isIntentActive(intent: NextReadIntent): boolean {
  const { hard: h, soft: s, exclude: e } = intent;
  return (
    (h.lanes?.length ?? 0) > 0
    || !!h.fiction_only
    || !!h.nonfiction_only
    || !!h.standalone_only
    || (h.max_page_count != null && h.max_page_count > 0)
    || !!s.pace
    || !!s.tone
    || !!s.intensity
    || !!e.avoid_classics
    || !!e.avoid_dark
    || !!e.avoid_literary
    || !!e.avoid_romance
    || !!e.avoid_nonfiction
    || !!e.avoid_series
  );
}

// ── Subject signal sets ───────────────────────────────────────────────────────
// All lowercase; matched against the lowercased subject+title corpus.

const NONFICTION_SIGNALS = [
  'memoir', 'autobiography', 'biography', 'narrative nonfiction', 'nonfiction',
  'non-fiction', 'true story', 'self-help', 'history', 'nature writing',
  'creative nonfiction', 'personal narrative', 'personal memoir',
];

const SERIES_SIGNALS = [
  'series', 'trilogy', 'duology', 'book 1', 'book one', 'first in series',
  'part 1', 'part one', 'saga', 'volume 1', 'vol. 1', 'book two', 'book three',
];

const DARK_SIGNALS = [
  'dark themes', 'dark fiction', 'disturbing content', 'graphic violence',
  'trauma', 'abuse', 'assault', 'gritty', 'bleak', 'depressing',
  'disturbing', 'sinister', 'unsettling', 'nihilistic', 'horror fiction',
];

const PACE_FAST_SIGNALS = [
  'fast-paced', 'fast paced', 'page-turner', 'page turner', 'action-packed',
  'unputdownable', 'high stakes', 'plot-driven', 'gripping', 'addictive',
  'compulsive', 'propulsive',
];

const PACE_SLOW_SIGNALS = [
  'slow burn', 'slow-burn', 'atmospheric', 'meditative', 'character study',
  'immersive', 'quiet', 'introspective', 'lyrical', 'contemplative',
];

const TONE_LIGHT_SIGNALS = [
  'cozy', 'light-hearted', 'lighthearted', 'funny', 'humorous', 'heartwarming',
  'uplifting', 'feel-good', 'beach read', 'summer read', 'witty', 'charming',
  'whimsical', 'fun', 'warm', 'breezy', 'escapism',
];

const TONE_DARK_SIGNALS = [
  'dark', 'gritty', 'disturbing', 'psychological', 'sinister', 'unsettling',
  'bleak', 'brutal', 'intense', 'violent', 'chilling', 'haunting',
];

const INTENSITY_HIGH_SIGNALS = [
  'emotional', 'heartbreaking', 'tearjerker', 'moving', 'devastating',
  'powerful', 'raw', 'gut-wrenching', 'deeply moving', 'profound',
];

const INTENSITY_LOW_SIGNALS = [
  'easy read', 'breezy', 'light', 'gentle', 'pleasant', 'relaxing',
  'undemanding', 'quick read',
];

// ── Internal helpers ───────────────────────────────────────────────────────────

function buildCorpus(book: { subjects?: string[] | null; title?: string | null }): string {
  return [
    ...(book.subjects ?? []),
    book.title ?? '',
  ].join(' ').toLowerCase();
}

function anySignal(corpus: string, signals: string[]): boolean {
  return signals.some(s => corpus.includes(s));
}

function isNonfiction(corpus: string): boolean {
  return anySignal(corpus, NONFICTION_SIGNALS);
}

function isSeries(corpus: string): boolean {
  return anySignal(corpus, SERIES_SIGNALS);
}

// ── Public: hard filter check ─────────────────────────────────────────────────
// Returns true if the book passes all active hard filters.
// Called after CoG classification, before the diversity pass.

export function passesIntentHardFilters(
  book: {
    subjects?:   string[] | null;
    title?:      string   | null;
    page_count?: number   | null;
  },
  intent:    NextReadIntent,
  bookLane:  DeterministicLane | null,
  marketPos: MarketPosition,
): boolean {
  const { hard: h } = intent;

  // Lane scope: only return books from specified lanes
  if (h.lanes && h.lanes.length > 0) {
    if (!bookLane || !h.lanes.includes(bookLane)) return false;
  }

  // Page count ceiling
  if (h.max_page_count != null && h.max_page_count > 0) {
    if (book.page_count != null && book.page_count > h.max_page_count) return false;
  }

  const corpus = buildCorpus(book);

  // Fiction / nonfiction gate
  if (h.fiction_only && isNonfiction(corpus)) return false;
  if (h.nonfiction_only && !isNonfiction(corpus)) return false;

  // Standalone gate
  if (h.standalone_only && isSeries(corpus)) return false;

  return true;
}

// ── Public: exclusion check ────────────────────────────────────────────────────
// Returns a non-null reason string if the book should be excluded.
// Books with a reason are removed from recommendations (treated as intent-rejects).

export function getIntentExclusionReason(
  book: {
    subjects?: string[] | null;
    title?:    string   | null;
  },
  intent:    NextReadIntent,
  marketPos: MarketPosition,
): string | null {
  const { exclude: e } = intent;
  const corpus = buildCorpus(book);

  if (e.avoid_classics   && marketPos === 'classic_canon')      return 'avoid_classics';
  if (e.avoid_literary   && marketPos === 'literary_prestige')  return 'avoid_literary';
  if (e.avoid_romance    && (marketPos === 'romance' || marketPos === 'romantasy')) return 'avoid_romance';
  if (e.avoid_nonfiction && marketPos === 'memoir_nonfiction')  return 'avoid_nonfiction';
  if (e.avoid_dark       && anySignal(corpus, DARK_SIGNALS))    return 'avoid_dark';
  if (e.avoid_series     && isSeries(corpus))                   return 'avoid_series';

  return null;
}

// ── Public: soft intent boost ─────────────────────────────────────────────────
// Returns a small score delta (positive or negative) based on how well the
// book's subjects align with soft preferences.
//
// Principle: soft boosts influence rank within a tier but cannot override the
// CoG classification. Maximum total boost is capped at ±0.05 per book.

const SOFT_BOOST = 0.04;  // per matching soft signal

export function computeIntentBoost(
  book: {
    subjects?: string[] | null;
    title?:    string   | null;
  },
  intent: NextReadIntent,
): number {
  const { soft: s } = intent;
  if (!s.pace && !s.tone && !s.intensity) return 0;

  const corpus = buildCorpus(book);
  let delta    = 0;

  if (s.pace === 'fast'   && anySignal(corpus, PACE_FAST_SIGNALS)) delta += SOFT_BOOST;
  if (s.pace === 'slow'   && anySignal(corpus, PACE_SLOW_SIGNALS)) delta += SOFT_BOOST;

  if (s.tone === 'light'  && anySignal(corpus, TONE_LIGHT_SIGNALS)) delta += SOFT_BOOST;
  if (s.tone === 'dark'   && anySignal(corpus, TONE_DARK_SIGNALS))  delta += SOFT_BOOST;

  if (s.intensity === 'high' && anySignal(corpus, INTENSITY_HIGH_SIGNALS)) delta += SOFT_BOOST;
  if (s.intensity === 'low'  && anySignal(corpus, INTENSITY_LOW_SIGNALS))  delta += SOFT_BOOST;

  // Cap: intentional soft signals can nudge scores by at most 0.05
  return Math.max(-0.05, Math.min(0.05, delta));
}

// ── Public: UI label helpers ───────────────────────────────────────────────────
// Human-readable summary of the active intent, used as a sub-label in the UI.

export function intentSummaryLabel(intent: NextReadIntent): string {
  const parts: string[] = [];
  const { hard: h, soft: s, exclude: e } = intent;

  // Lane names (display label)
  if (h.lanes && h.lanes.length > 0) {
    const LANE_LABELS: Partial<Record<DeterministicLane, string>> = {
      romantasy:            'Romantasy',
      scifi_fantasy:        'Fantasy/Sci-fi',
      modern_suspense:      'Thriller',
      romance:              'Romance',
      contemporary_fiction: 'Contemporary',
      memoir_nonfiction:    'Memoir',
      literary:             'Literary',
      horror:               'Horror',
    };
    parts.push(h.lanes.map(l => LANE_LABELS[l] ?? l).join(', '));
  }

  if (h.fiction_only)    parts.push('Fiction only');
  if (h.nonfiction_only) parts.push('Nonfiction only');
  if (h.standalone_only) parts.push('Standalone');
  if (h.max_page_count)  parts.push(`<${h.max_page_count}p`);

  if (s.pace)      parts.push(s.pace === 'fast' ? 'Fast-paced' : s.pace === 'slow' ? 'Slow burn' : '');
  if (s.tone)      parts.push(s.tone === 'light' ? 'Light' : s.tone === 'dark' ? 'Dark' : '');
  if (s.intensity) parts.push(s.intensity === 'high' ? 'Emotionally intense' : s.intensity === 'low' ? 'Low intensity' : '');

  if (e.avoid_classics)   parts.push('No classics');
  if (e.avoid_dark)       parts.push('No dark');
  if (e.avoid_literary)   parts.push('No literary');
  if (e.avoid_romance)    parts.push('No romance');
  if (e.avoid_nonfiction) parts.push('No nonfiction');
  if (e.avoid_series)     parts.push('No series');

  return parts.filter(Boolean).join(' · ');
}

// ── Per-book trace types ──────────────────────────────────────────────────────
// Produced during the intent loop in recommender.ts.
// Attached to each ScoredBook for inspection in the debug panel.

export type IntentBookTrace = {
  excluded_by:        string | null;   // exclusion key, or null if not excluded
  hard_filter_passes: string[];        // e.g. ['lane: modern_suspense', 'standalone ok']
  hard_filter_fails:  string[];        // e.g. ['lane (got scifi_fantasy, wanted modern_suspense)']
  soft_boosts:        string[];        // e.g. ['fast-paced', 'lighter tone']
  score_delta:        number;          // net score change applied (+/- or 0)
};

// ── Set-level summary ──────────────────────────────────────────────────────────
// Aggregated stats for the whole intent-filtered pool.
// Exposed in meta.intent_summary for the debug panel.

export type IntentSetSummary = {
  before_intent:          number;               // non-rejected books before intent
  removed_by_exclusion:   number;               // books removed by avoid_* rules
  removed_by_hard_filter: number;               // books removed by lane/format gates
  soft_boosted:           number;               // books that received a positive soft boost
  after_intent:           number;               // books remaining after intent
  exclusion_breakdown:    Record<string, number>; // e.g. { avoid_classics: 5, avoid_dark: 2 }
};

// ── NL parser types ───────────────────────────────────────────────────────────

export type NLParseResult = {
  intent:      NextReadIntent;
  labels:      string[];      // human-readable labels for display ("fast-paced", "thriller")
  interpreted: boolean;       // true if at least one field was parsed
};

// ── evaluateHardFilters ───────────────────────────────────────────────────────
// Trace-aware replacement for passesIntentHardFilters.
// Returns the same boolean decision PLUS per-filter pass/fail reasons.

export function evaluateHardFilters(
  book: {
    subjects?:   string[] | null;
    title?:      string   | null;
    page_count?: number   | null;
  },
  intent:    NextReadIntent,
  bookLane:  DeterministicLane | null,
  marketPos: MarketPosition,
): { passes: boolean; passReasons: string[]; failReasons: string[] } {
  const { hard: h } = intent;
  const passReasons: string[] = [];
  const failReasons: string[] = [];

  if (h.lanes && h.lanes.length > 0) {
    if (!bookLane || !h.lanes.includes(bookLane)) {
      failReasons.push(`lane (got ${bookLane ?? 'none'}, wanted ${h.lanes.join('/')})`);
    } else {
      passReasons.push(`lane: ${bookLane}`);
    }
  }

  if (h.max_page_count != null && h.max_page_count > 0) {
    const pc = book.page_count;
    if (pc != null && pc > h.max_page_count) {
      failReasons.push(`too long (${pc}p > ${h.max_page_count}p)`);
    } else {
      passReasons.push('length ok');
    }
  }

  const corpus = buildCorpus(book);

  if (h.fiction_only) {
    if (isNonfiction(corpus)) {
      failReasons.push('fiction only — detected nonfiction');
    } else {
      passReasons.push('fiction ok');
    }
  }

  if (h.nonfiction_only) {
    if (!isNonfiction(corpus)) {
      failReasons.push('nonfiction only — detected fiction');
    } else {
      passReasons.push('nonfiction ok');
    }
  }

  if (h.standalone_only) {
    if (isSeries(corpus)) {
      failReasons.push('standalone only — detected series');
    } else {
      passReasons.push('standalone ok');
    }
  }

  return { passes: failReasons.length === 0, passReasons, failReasons };
}

// ── computeIntentBoostWithReasons ─────────────────────────────────────────────
// Trace-aware version of computeIntentBoost.
// Returns the same delta PLUS which signals matched.

export function computeIntentBoostWithReasons(
  book: {
    subjects?: string[] | null;
    title?:    string   | null;
  },
  intent: NextReadIntent,
): { delta: number; reasons: string[] } {
  const { soft: s } = intent;
  if (!s.pace && !s.tone && !s.intensity) return { delta: 0, reasons: [] };

  const corpus  = buildCorpus(book);
  let   delta   = 0;
  const reasons: string[] = [];

  if (s.pace === 'fast'      && anySignal(corpus, PACE_FAST_SIGNALS))      { delta += SOFT_BOOST; reasons.push('fast-paced');          }
  if (s.pace === 'slow'      && anySignal(corpus, PACE_SLOW_SIGNALS))      { delta += SOFT_BOOST; reasons.push('slow burn');            }
  if (s.tone === 'light'     && anySignal(corpus, TONE_LIGHT_SIGNALS))     { delta += SOFT_BOOST; reasons.push('lighter tone');         }
  if (s.tone === 'dark'      && anySignal(corpus, TONE_DARK_SIGNALS))      { delta += SOFT_BOOST; reasons.push('darker tone');          }
  if (s.intensity === 'high' && anySignal(corpus, INTENSITY_HIGH_SIGNALS)) { delta += SOFT_BOOST; reasons.push('emotionally intense'); }
  if (s.intensity === 'low'  && anySignal(corpus, INTENSITY_LOW_SIGNALS))  { delta += SOFT_BOOST; reasons.push('low intensity');        }

  return { delta: Math.max(-0.05, Math.min(0.05, delta)), reasons };
}

// ── mergeIntents ──────────────────────────────────────────────────────────────
// Merges chip-selected intent with NL-parsed intent at Apply time.
// - Chip selections take priority for soft prefs (explicit chip > NL inference)
// - Lanes are unioned (both chip and NL lanes are requested)
// - Exclusions are OR'd (any source can add an exclusion)
// - Hard format flags are OR'd (standalone, fiction/nonfiction)
// - max_page_count: chip value wins; NL fills in if chip is absent

export function mergeIntents(
  chips: NextReadIntent,
  nl:    NextReadIntent,
): NextReadIntent {
  const allLanes = [...(chips.hard.lanes ?? []), ...(nl.hard.lanes ?? [])];
  const lanes    = [...new Set(allLanes)];
  return {
    hard: {
      lanes:           lanes.length ? lanes : undefined,
      fiction_only:    (chips.hard.fiction_only    || nl.hard.fiction_only)    || undefined,
      nonfiction_only: (chips.hard.nonfiction_only || nl.hard.nonfiction_only) || undefined,
      standalone_only: (chips.hard.standalone_only || nl.hard.standalone_only) || undefined,
      max_page_count:  chips.hard.max_page_count  ?? nl.hard.max_page_count,
    },
    soft: {
      pace:      chips.soft.pace      ?? nl.soft.pace,
      tone:      chips.soft.tone      ?? nl.soft.tone,
      intensity: chips.soft.intensity ?? nl.soft.intensity,
    },
    exclude: {
      avoid_classics:   (chips.exclude.avoid_classics   || nl.exclude.avoid_classics)   || undefined,
      avoid_dark:       (chips.exclude.avoid_dark       || nl.exclude.avoid_dark)       || undefined,
      avoid_literary:   (chips.exclude.avoid_literary   || nl.exclude.avoid_literary)   || undefined,
      avoid_romance:    (chips.exclude.avoid_romance    || nl.exclude.avoid_romance)     || undefined,
      avoid_nonfiction: (chips.exclude.avoid_nonfiction || nl.exclude.avoid_nonfiction) || undefined,
      avoid_series:     (chips.exclude.avoid_series     || nl.exclude.avoid_series)     || undefined,
    },
  };
}

// ── parseNaturalLanguageIntent ─────────────────────────────────────────────────
// Rule-based NL parser. Maps common reading phrases to structured intent fields.
// Pattern matching only — no LLM dependency.
//
// Cohort safety:
//   - Rules cover all reader types (genre, pace, tone, intensity, format).
//   - No rule assumes a particular dominant genre.
//   - Exclusion rules require explicit negation ("not", "no", "avoid", "without").
//   - Soft preferences respect the chip-priority merge at Apply time.
//   - Patterns use space-padding (` word `) to avoid substring false positives.

type NLRule = {
  patterns: string[];
  apply:    (intent: NextReadIntent) => void;
  label:    string;
};

function addLane(intent: NextReadIntent, lane: DeterministicLane) {
  const cur = intent.hard.lanes ?? [];
  if (!cur.includes(lane)) intent.hard.lanes = [...cur, lane];
}

const NL_RULES: NLRule[] = [
  // ── Lanes ────────────────────────────────────────────────────────────────
  { patterns: [' fantasy', ' fae ', ' fey ', ' magic ', ' dragons ', ' wizards', 'epic fantasy', 'speculative fiction', ' sorcery', ' enchanted'],
    apply: i => addLane(i, 'scifi_fantasy'), label: 'fantasy' },
  { patterns: ['sci-fi', 'science fiction', 'space opera', ' dystopian', ' futuristic', ' aliens', 'spaceship'],
    apply: i => addLane(i, 'scifi_fantasy'), label: 'sci-fi' },
  { patterns: ['romantasy', 'fantasy romance', 'romantic fantasy'],
    apply: i => addLane(i, 'romantasy'), label: 'romantasy' },
  { patterns: [' thriller', ' suspense', 'crime fiction', ' detective ', ' whodunit', 'psychological thriller'],
    apply: i => addLane(i, 'modern_suspense'), label: 'thriller' },
  { patterns: [' mystery ', 'cozy mystery', 'cozy crime'],
    apply: i => addLane(i, 'modern_suspense'), label: 'mystery' },
  { patterns: [' horror', 'ghost story', 'supernatural horror', ' scary ', ' creepy '],
    apply: i => addLane(i, 'horror'), label: 'horror' },
  { patterns: [' memoir', ' autobiography', ' life story', ' true story'],
    apply: i => addLane(i, 'memoir_nonfiction'), label: 'memoir' },
  { patterns: ['literary fiction', 'literary novel', 'booker prize', 'prize-winning'],
    apply: i => addLane(i, 'literary'), label: 'literary fiction' },
  { patterns: ['book club', 'contemporary fiction', 'contemporary novel'],
    apply: i => addLane(i, 'contemporary_fiction'), label: 'contemporary fiction' },
  // Romance after romantasy to avoid partial match
  { patterns: ['heavy romance', 'spicy romance', 'steamy romance', 'love story', ' romance ', ' swoony'],
    apply: i => { addLane(i, 'romance'); i.soft.intensity = 'high'; }, label: 'romance' },
  { patterns: [' nonfiction ', ' non-fiction '],
    apply: i => addLane(i, 'memoir_nonfiction'), label: 'nonfiction' },

  // ── Pace ─────────────────────────────────────────────────────────────────
  { patterns: ['fast-paced', 'fast paced', 'page-turner', 'page turner', ' gripping ', 'compulsive read', 'addictive read', "can't put down", 'easy to get into', 'unputdownable', 'flows quickly'],
    apply: i => { i.soft.pace = 'fast'; }, label: 'fast-paced' },
  { patterns: ['read passively', ' passively ', 'passive read'],
    apply: i => { i.soft.pace = 'fast'; i.soft.intensity = 'low'; }, label: 'easy to read' },
  { patterns: ['slow burn', 'slow-burn', 'atmospheric read', 'slow paced', ' meditative', 'patient read'],
    apply: i => { i.soft.pace = 'slow'; }, label: 'slow burn' },

  // ── Tone (light) ──────────────────────────────────────────────────────────
  { patterns: [' comforting', 'feel-good', ' cozy ', ' cosy ', ' heartwarming', ' uplifting', ' cheerful', 'beach read', 'summer read', ' breezy'],
    apply: i => { i.soft.tone = 'light'; }, label: 'comforting' },
  { patterns: ['light read', 'light fiction', 'something light', 'light and fun', 'fun and easy', ' escapism', 'not too heavy', 'not heavy'],
    apply: i => { i.soft.tone = 'light'; }, label: 'light' },

  // ── Tone (dark) ── no plain "dark" to avoid "not too dark" false matches ───
  { patterns: [' gritty ', 'dark themes', 'darker novel', 'psychological horror', ' brutal ', ' bleak '],
    apply: i => { i.soft.tone = 'dark'; }, label: 'darker' },

  // ── Emotional intensity ───────────────────────────────────────────────────
  { patterns: ['emotional read', 'emotionally immersive', 'gut-wrenching', ' tearjerker', ' heartbreaking', 'devastating read', 'deeply moving', 'powerful read'],
    apply: i => { i.soft.intensity = 'high'; }, label: 'emotionally intense' },
  { patterns: ['low stakes', 'low-stakes', ' undemanding', 'easy on the brain', 'easy read', 'nothing too intense'],
    apply: i => { i.soft.intensity = 'low'; }, label: 'low-key' },

  // ── Format ───────────────────────────────────────────────────────────────
  { patterns: [' standalone ', 'single book', 'one book', 'not a series', 'no series required', 'no commitment'],
    apply: i => { i.hard.standalone_only = true; }, label: 'standalone' },
  { patterns: ['short book', 'shorter book', 'quick read', 'under 400 pages', 'under 350 pages', 'short novel'],
    apply: i => { i.hard.max_page_count = 350; }, label: 'shorter read' },

  // ── Exclusions (explicit negation required) ───────────────────────────────
  { patterns: ['not too dark', 'nothing dark', 'no dark', 'avoid dark', 'keep it light', 'not dark', 'without dark'],
    apply: i => { i.exclude.avoid_dark = true; }, label: 'no dark content' },
  { patterns: ['no classics', 'not classic', 'avoid classics', 'nothing too old', 'modern only', 'not too old'],
    apply: i => { i.exclude.avoid_classics = true; }, label: 'no classics' },
  { patterns: ['more accessible', 'not too literary', 'less literary', 'not literary', 'easier prose', 'accessible writing', 'accessible fiction'],
    apply: i => { i.exclude.avoid_literary = true; }, label: 'more accessible' },
  { patterns: ['no romance', 'without romance', 'avoid romance', 'romance-free', 'not a romance'],
    apply: i => { i.exclude.avoid_romance = true; }, label: 'no romance' },
  { patterns: ['no nonfiction', 'fiction only', 'just fiction', 'fiction not nonfiction'],
    apply: i => { i.exclude.avoid_nonfiction = true; }, label: 'fiction only' },
  { patterns: ['no series ', 'series-free', 'no ongoing series', 'without a series'],
    apply: i => { i.exclude.avoid_series = true; }, label: 'no series' },
];

export function parseNaturalLanguageIntent(text: string): NLParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { intent: emptyIntent(), labels: [], interpreted: false };

  // Pad with spaces so patterns with leading/trailing spaces match word boundaries
  const lower  = ` ${trimmed.toLowerCase()} `;
  const result: NextReadIntent = { hard: {}, soft: {}, exclude: {} };
  const labels: string[] = [];

  for (const rule of NL_RULES) {
    if (rule.patterns.some(p => lower.includes(p))) {
      rule.apply(result);
      if (!labels.includes(rule.label)) labels.push(rule.label);
    }
  }

  if (result.hard.lanes) {
    result.hard.lanes = [...new Set(result.hard.lanes)];
  }

  return { intent: result, labels, interpreted: labels.length > 0 };
}

// ── Public: intent-aware explanation suffix ────────────────────────────────────
// Returns a short phrase appended to the book's explanation when intent is active.
// Kept terse so explanations don't become verbose.

export function buildIntentSuffix(intent: NextReadIntent): string | null {
  if (!isIntentActive(intent)) return null;

  const parts: string[] = [];
  const { hard: h, soft: s } = intent;

  if (h.lanes && h.lanes.length > 0) {
    const LANE_LABELS: Partial<Record<DeterministicLane, string>> = {
      romantasy:       'romantasy',
      scifi_fantasy:   'fantasy',
      modern_suspense: 'thriller',
      romance:         'romance',
      memoir_nonfiction: 'memoir',
    };
    parts.push(`your ${h.lanes.map(l => LANE_LABELS[l] ?? l).join('/')} filter`);
  }

  if (s.pace === 'fast')   parts.push('fast-paced request');
  if (s.pace === 'slow')   parts.push('slow burn preference');
  if (s.tone === 'light')  parts.push('lighter mood');
  if (s.tone === 'dark')   parts.push('darker tone request');
  if (s.intensity === 'high') parts.push('emotionally intense preference');

  if (h.standalone_only) parts.push('standalone preference');
  if (h.max_page_count)  parts.push('shorter book preference');

  if (parts.length === 0) return null;
  return `Matches ${parts.slice(0, 2).join(' and ')}.`;
}
