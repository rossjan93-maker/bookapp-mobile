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

import type { DeterministicLane, TraitConfidence } from './bookTraits';
import { classifyTone }                            from './bookTraits';
import type { MarketPosition }                     from './fitClassifier';
import {
  DARK_SIGNALS,
  DOMESTIC_SUSPENSE_SUPPORT_SIGNALS,
  firstSignalMatch,
} from './evidence/signals';

// ── Intent shape ──────────────────────────────────────────────────────────────

export type NextReadPace      = 'fast' | 'medium' | 'slow';
export type NextReadTone      = 'light' | 'balanced' | 'dark';
export type NextReadIntensity = 'low'  | 'medium'  | 'high';

export type ReadingEnergyMode =
  | 'light_fun'
  | 'immersive'
  | 'deep_demanding'
  | 'emotionally_heavy'
  | 'palate_cleanser';

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
    pace?:          NextReadPace      | null;
    tone?:          NextReadTone      | null;
    intensity?:     NextReadIntensity | null;
    readingEnergy?: ReadingEnergyMode | null;
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
    || !!s.readingEnergy
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

// Dark exclusion signals — corpus = book.subjects + book.title (lowercased).
// These are the markers that fire `exclude.avoid_dark = true` and HARD-remove
// the book from the deck. The bar is intentionally specific: every term here
// must reliably mark a book as dark/intense WITHOUT also catching cozy
// mysteries (Thursday Murder Club has 'murder' / 'crime fiction'), literary
// family fiction (Everything I Never Told You has 'grief' / 'family secrets'),
// or general thrillers (Reacher books carry 'thriller' / 'violence').
//
// Coverage gap fix (P4C.1 live-smoke blocker, 2026-05-17):
// The original list contained only mood descriptors ('gritty', 'bleak',
// 'disturbing') and missed the canonical genre markers ('psychological
// thriller', 'noir', 'serial killer') that OL/GBooks actually stamp on
// Gone Girl / The Silent Patient. The trait classifier's TONE_DARK_SPECIFIC
// already had them — these lists now align with that *phrasal* (specific)
// set, deliberately omitting the broad single-token terms ('thriller',
// 'murder', 'horror', 'death') that would over-exclude cozies and
// literary work.
//
// As of the BookEvidence consolidation Batch A (P4 hygiene), DARK_SIGNALS
// and DOMESTIC_SUSPENSE_SUPPORT_SIGNALS live in `lib/evidence/signals.ts`
// — see that module for the partitioning rationale (specific / phrasal vs
// broad single-token) and the word-boundary matching contract.
//
// Bare 'trauma' / 'abuse' / 'assault' are still listed (under `broad`)
// even though they could touch some memoir/literary fiction — they are
// narrow enough relative to the user's promise ("no dark") that demoting
// them on an active No-dark lens is more user-aligned than over-including.
// Note: the runtime implementation of the market-position rule lives inline
// in `evaluateBookAgainstIntentLens` (the prior `domesticSuspenseDark`
// helper was removed after the #6 consolidation — sole caller deleted).

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
    subjects?:    string[] | null;
    title?:       string   | null;
    description?: string   | null;
  },
  intent:    NextReadIntent,
  marketPos: MarketPosition,
): string | null {
  // P4C.1 follow-up #6 (2026-05-18) — single seam: delegate to the shared
  // Intent Eligibility Evaluator. Callers (deterministic ranked pool, cache
  // hit, expert fresh build) keep their existing call shape; the
  // evaluator now produces the verdict using BookTraits' tone classifier
  // PLUS the curated phrasal list PLUS the market-position rule, so dark
  // evidence comes from one place rather than two diverging lists.
  const verdict = evaluateBookAgainstIntentLens(book, intent, marketPos);
  return verdict.hardExclusions[0]?.reason ?? null;
}

// ── Public: shared Intent Eligibility Evaluator ──────────────────────────────
// P4C.1 follow-up #6 — replaces title-by-title DARK_SIGNALS patching.
//
// One book-side evidence model, used by every "Your Next Read" lens
// decision (cache hit, expert fresh build, deterministic ranked pool,
// visible-deck safety pass — all flow through `getIntentExclusionReason`,
// which is now a thin wrapper around this evaluator).
//
// Hard product rules this evaluator enforces:
//   • Reading Taste is the durable baseline (not touched here).
//   • Your Next Read is a temporary session lens.
//   • No dark            → hard temporary exclusion, ONLY with specific evidence.
//   • Less dark          → bounded demotion / not-right-now risk, never hard.
//   • Unknown evidence   → do not hard-exclude.
//   • Generic single tokens (murder / thriller / death alone) never hard-exclude.
//   • Cozy mysteries     → eligible (corroborated light evidence beats single broad).
//   • Domestic/psych suspense → excluded under No dark when evidence is specific.
//   • Pure romance       → not excluded; romantic suspense depends on suspense evidence.
//
// Evidence sources combined for the No-dark verdict (each is "specific"
// in its own right — none is a generic single token in isolation):
//   1. BookTraits.classifyTone(book) === 'dark' && confidence === 'specific'
//      (uses subjects + description; broad signals require corroboration).
//   2. Hit in the curated DARK_SIGNALS list. List is overwhelmingly
//      phrasal/hyphenated; a small set of single-token entries
//      ('trauma', 'abuse', 'assault') is intentionally retained as
//      already-shipped behavior (documented exception). New entries
//      should be phrasal unless explicitly approved.
//   3. market_position === 'domestic_suspense' AND at least one supporting
//      subject-corpus signal (psychological/suspense/crime/violence/murder/
//      thriller/mystery/mental illness/psychotherapy).
//
// Less-dark + Light & accessible + Short & light remain bounded preferences
// — they appear in `softDemotions` / `notRightNowRisks` for downstream
// scoring/composer use, but never produce a `hardExclusion`.

export type IntentEligibilityEvidence = {
  source: 'classify_tone' | 'phrasal_subject' | 'market_position'
        | 'market_position_only' | 'series_marker' | 'fiction_gate'
        | 'page_count' | 'lane_scope';
  kind:   string;             // e.g. 'tone=dark/specific', 'crime fiction', 'domestic_suspense+thriller'
  detail: string;             // human-readable evidence summary
};

export type IntentEligibilityVerdict = {
  hardExclusions:    Array<{ reason: string; evidence: IntentEligibilityEvidence[] }>;
  softDemotions:     Array<{ reason: string; evidence: IntentEligibilityEvidence[] }>;
  notRightNowRisks:  Array<{ reason: string; evidence: IntentEligibilityEvidence[] }>;
  evidence:          IntentEligibilityEvidence[];   // all collected, flat
  confidence:        TraitConfidence;               // overall confidence of the dark verdict
  status:            'eligible' | 'excluded' | 'demoted' | 'ambiguous' | 'unknown';
};

export function evaluateBookAgainstIntentLens(
  book: {
    subjects?:    string[] | null;
    title?:       string   | null;
    description?: string   | null;
  },
  intent:    NextReadIntent,
  marketPos: MarketPosition,
): IntentEligibilityVerdict {
  const { exclude: e, soft: s } = intent;
  const corpus = buildCorpus(book);

  const evidence:         IntentEligibilityEvidence[] = [];
  const hardExclusions:   IntentEligibilityVerdict['hardExclusions']   = [];
  const softDemotions:    IntentEligibilityVerdict['softDemotions']    = [];
  const notRightNowRisks: IntentEligibilityVerdict['notRightNowRisks'] = [];

  // ── Market-position-only exclusions (classics/literary/romance/nonfiction) ──
  if (e.avoid_classics && marketPos === 'classic_canon') {
    const ev: IntentEligibilityEvidence = { source: 'market_position_only', kind: 'classic_canon', detail: 'market_position=classic_canon' };
    evidence.push(ev); hardExclusions.push({ reason: 'avoid_classics', evidence: [ev] });
  }
  if (e.avoid_literary && marketPos === 'literary_prestige') {
    const ev: IntentEligibilityEvidence = { source: 'market_position_only', kind: 'literary_prestige', detail: 'market_position=literary_prestige' };
    evidence.push(ev); hardExclusions.push({ reason: 'avoid_literary', evidence: [ev] });
  }
  if (e.avoid_romance && (marketPos === 'romance' || marketPos === 'romantasy')) {
    const ev: IntentEligibilityEvidence = { source: 'market_position_only', kind: marketPos, detail: `market_position=${marketPos}` };
    evidence.push(ev); hardExclusions.push({ reason: 'avoid_romance', evidence: [ev] });
  }
  if (e.avoid_nonfiction && marketPos === 'memoir_nonfiction') {
    const ev: IntentEligibilityEvidence = { source: 'market_position_only', kind: 'memoir_nonfiction', detail: 'market_position=memoir_nonfiction' };
    evidence.push(ev); hardExclusions.push({ reason: 'avoid_nonfiction', evidence: [ev] });
  }

  // ── No-dark: union of three specific-evidence sources ─────────────────────
  let darkConfidence: TraitConfidence = 'unknown';
  if (e.avoid_dark) {
    const darkEv: IntentEligibilityEvidence[] = [];

    // (1) BookTraits.classifyTone — shared evidence model (subjects + description).
    const tone = classifyTone({ subjects: book.subjects, description: book.description });
    if (tone.tone === 'dark' && tone.confidence === 'specific') {
      darkEv.push({ source: 'classify_tone', kind: 'tone=dark/specific', detail: 'classifyTone returned dark with specific confidence' });
      darkConfidence = 'specific';
    }

    // (2) Phrasal hit in curated DARK_SIGNALS (word-boundary, case-insensitive).
    //     See lib/evidence/signals.ts for the specific/broad partition.
    const phrasalHit = firstSignalMatch(corpus, DARK_SIGNALS);
    if (phrasalHit) {
      darkEv.push({ source: 'phrasal_subject', kind: phrasalHit, detail: `corpus contains phrasal '${phrasalHit}'` });
      darkConfidence = 'specific';
    }

    // (3) Market-position coupled rule (domestic_suspense + ≥1 supporting signal).
    if (marketPos === 'domestic_suspense') {
      const supporting = firstSignalMatch(corpus, DOMESTIC_SUSPENSE_SUPPORT_SIGNALS);
      if (supporting) {
        darkEv.push({ source: 'market_position', kind: `domestic_suspense+${supporting}`, detail: `market_position=domestic_suspense AND corpus contains '${supporting}'` });
        darkConfidence = 'specific';
      }
    }

    if (darkEv.length > 0) {
      evidence.push(...darkEv);
      hardExclusions.push({ reason: 'avoid_dark', evidence: darkEv });
    } else if (tone.tone === 'dark' && tone.confidence === 'broad') {
      // Broad-only dark evidence: ambiguous. Do NOT hard-exclude (rule 5),
      // but flag as not-right-now risk for downstream demotion.
      const ev: IntentEligibilityEvidence = { source: 'classify_tone', kind: 'tone=dark/broad', detail: 'broad dark signal only; insufficient for hard exclusion' };
      evidence.push(ev);
      notRightNowRisks.push({ reason: 'avoid_dark', evidence: [ev] });
      darkConfidence = 'broad';
    }
  }

  // ── No-series ─────────────────────────────────────────────────────────────
  if (e.avoid_series && isSeries(corpus)) {
    const ev: IntentEligibilityEvidence = { source: 'series_marker', kind: 'series', detail: 'corpus contains series marker' };
    evidence.push(ev); hardExclusions.push({ reason: 'avoid_series', evidence: [ev] });
  }

  // ── Soft demotions (Less-dark / Light intensity) — never hard-exclude ─────
  if (s.intensity === 'low' || s.tone === 'light') {
    // Mirror classifyTone-derived risk for downstream P4C.1 bounded demotion.
    // Important: this does NOT hard-exclude (preserves the "Less dark = bounded
    // demotion, not hard exclusion" rule). It surfaces evidence for ranking.
    const tone = classifyTone({ subjects: book.subjects, description: book.description });
    if (tone.tone === 'dark') {
      const ev: IntentEligibilityEvidence = { source: 'classify_tone', kind: `tone=dark/${tone.confidence}`, detail: 'dark tone under less-dark/light soft pref → bounded demotion candidate' };
      evidence.push(ev); softDemotions.push({ reason: 'less_dark_demotion', evidence: [ev] });
    }
  }

  // Status synthesis
  let status: IntentEligibilityVerdict['status'] = 'eligible';
  if (hardExclusions.length > 0)        status = 'excluded';
  else if (softDemotions.length > 0)    status = 'demoted';
  else if (notRightNowRisks.length > 0) status = 'ambiguous';
  else if (evidence.length === 0)       status = 'unknown';

  return { hardExclusions, softDemotions, notRightNowRisks, evidence, confidence: darkConfidence, status };
}

// ── Public: soft intent boost ─────────────────────────────────────────────────
// Returns a small score delta (positive or negative) based on how well the
// book's subjects align with soft preferences.
//
// Principle: soft boosts influence rank within a tier but cannot override the
// CoG classification. Maximum total boost is capped at ±0.30 per book so that
// matching books can actually overtake non-matching ones at typical 0.5–1.0
// score ranges (the older ±0.05 cap was invisible to users — books matching
// the chip stayed buried under higher-base-score non-matches).

const SOFT_BOOST       = 0.12;  // per matching soft signal
const SOFT_BOOST_CAP   = 0.30;  // total cap across all soft signals

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

  // Cap: intentional soft signals can nudge scores by at most SOFT_BOOST_CAP
  return Math.max(-SOFT_BOOST_CAP, Math.min(SOFT_BOOST_CAP, delta));
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
  // P4C.1 follow-up — 'low' intensity maps to hard exclude.avoid_dark,
  // so the active-lens summary pill says "Less dark" to match the chip label.
  if (s.intensity) parts.push(s.intensity === 'high' ? 'Emotionally intense' : s.intensity === 'low' ? 'Less dark' : '');

  if (s.readingEnergy) {
    const ENERGY_LABELS: Record<ReadingEnergyMode, string> = {
      light_fun:         'Light & accessible',
      immersive:         'Immersive',
      deep_demanding:    'Deep & demanding',
      emotionally_heavy: 'Emotionally heavy',
      palate_cleanser:   'Short & light',
    };
    parts.push(ENERGY_LABELS[s.readingEnergy]);
  }

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
  excluded_by:        string | null;         // exclusion key, or null if not excluded
  hard_filter_passes: string[];              // e.g. ['lane: modern_suspense', 'standalone ok']
  hard_filter_fails:  string[];              // e.g. ['lane (got scifi_fantasy, wanted modern_suspense)']
  soft_boosts:        string[];              // e.g. ['fast-paced', 'lighter tone']
  score_delta:        number;                // net score change applied (+/- or 0)
  mood_preset:        ReadingEnergyMode | null;  // active mood chip, null when none set
  mood_delta:         number;                // contribution from mood boost (0 when no trait match)
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

  return { delta: Math.max(-SOFT_BOOST_CAP, Math.min(SOFT_BOOST_CAP, delta)), reasons };
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
      pace:          chips.soft.pace          ?? nl.soft.pace,
      tone:          chips.soft.tone          ?? nl.soft.tone,
      intensity:     chips.soft.intensity     ?? nl.soft.intensity,
      readingEnergy: chips.soft.readingEnergy ?? nl.soft.readingEnergy,
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

  // ── Reading energy / mood preset ──────────────────────────────────────────
  // Matches both explicit mood phrases ("light & fun") and common user phrasings
  // like "something light" and "something fun", "i want something breezy".
  // Note: "something light" also triggers soft.tone='light' via the tone rules below —
  // both signals fire independently and are additive (chip priority at merge time).
  { patterns: ['light and fun', 'light & fun', 'fun and breezy', 'something light and fun',
               'fun easy read', 'light-hearted fun', 'something fun', 'something light',
               'something easy and fun', 'something breezy', 'fun and easy'],
    apply: i => { i.soft.readingEnergy = 'light_fun'; }, label: 'light & fun' },
  { patterns: ['get lost in', 'lose myself in', 'immersive world', 'rich world',
               'world-building experience', 'deeply immersive', 'fully immersive',
               'something immersive', 'i want immersive', 'want to get lost',
               'something with great world'],
    apply: i => { i.soft.readingEnergy = 'immersive'; }, label: 'immersive' },
  { patterns: ['deep and demanding', 'deep & demanding', 'challenging read',
               'dense and literary', 'intellectually demanding', 'mentally demanding',
               'requires focus', 'something challenging', 'something dense',
               'something literary and demanding', 'literary and complex'],
    apply: i => { i.soft.readingEnergy = 'deep_demanding'; }, label: 'deep & demanding' },
  { patterns: ['emotionally heavy', 'emotionally draining', 'heavy emotional',
               'need a cry', 'emotional gut-punch', 'devastating read',
               'need something devastating', 'something devastating', 'something heavy',
               'really emotional', 'deeply moving read'],
    apply: i => { i.soft.readingEnergy = 'emotionally_heavy'; }, label: 'emotionally heavy' },
  { patterns: ['palate cleanser', 'palette cleanser', 'palate-cleanser',
               'change of pace', 'break from heavy', 'refresh my reading',
               'cleanse my palate', 'something refreshing', 'something different and light',
               'reset my reading'],
    apply: i => { i.soft.readingEnergy = 'palate_cleanser'; }, label: 'palate cleanser' },

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

  if (s.readingEnergy) {
    const ENERGY_SUFFIX: Record<ReadingEnergyMode, string> = {
      light_fun:         'light & fun mood',
      immersive:         'immersive mood',
      deep_demanding:    'deep & demanding mood',
      emotionally_heavy: 'emotionally heavy mood',
      palate_cleanser:   'palate cleanser mood',
    };
    parts.push(ENERGY_SUFFIX[s.readingEnergy]);
  }

  if (h.standalone_only) parts.push('standalone preference');
  if (h.max_page_count)  parts.push('shorter book preference');

  if (parts.length === 0) return null;
  return `Matches ${parts.slice(0, 2).join(' and ')}.`;
}
