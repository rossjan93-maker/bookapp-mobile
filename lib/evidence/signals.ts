// lib/evidence/signals.ts
// ─────────────────────────────────────────────────────────────────────────────
// BookEvidence consolidation — Batch A (P4 hygiene).
//
// Single source of truth for Intent Eligibility evidence signal lists used by
// `evaluateBookAgainstIntentLens` in `lib/nextReadIntent.ts`. Lifted out of
// the evaluator file so the planned `deriveBookEvidence(book)` work in
// Batch B has a stable signal API to consume, and so future signal-list
// drift (e.g. a parallel list growing inside the trait classifier) can be
// caught by importing from one place.
//
// Scope of this batch is intentionally narrow:
//   • Move DARK_SIGNALS                       (was in lib/nextReadIntent.ts)
//   • Move DOMESTIC_SUSPENSE_SUPPORT_SIGNALS  (was in lib/nextReadIntent.ts)
// We do NOT touch `lib/bookTraits.ts` TONE_DARK_SPECIFIC / TONE_DARK_BROAD
// in this batch — that consolidation lands in Batch B together with the
// typed `BookEvidence` shape. See replit.md "BookEvidence consolidation"
// row for the full plan.
//
// Matching contract:
//   • Word-boundary (`\b<phrase>\b`, case-insensitive) — consistent with the
//     trait classifier's `compileMatchers` rule. The previous evaluator
//     called `corpus.includes(s)` (substring), which silently matched
//     suffixes / inflections; this is tightened here.
//   • To preserve P4C.1 behavior under the stricter matching, plural
//     variants are explicitly listed for the two phrases that previously
//     relied on substring coverage of plurals:
//       'serial killer'         + 'serial killers'
//       'psychotherapy patient' + 'psychotherapy patients'   (Silent Patient)
//   • Single-token entries from the prior flat DARK_SIGNALS list are moved
//     into `broad`. They still fire on their own (the evaluator does not
//     yet require corroboration for broad evidence on the dark side — that
//     rule is a Batch C concern when `intensity` / `emotionalWeight` arrive).
//     The partition exists today purely for documentation and for Batch B's
//     forthcoming `BookEvidence` consumers.

export type SignalSet = {
  /** Multi-word or hyphenated entries — unambiguous tonal/genre evidence. */
  readonly specific: readonly string[];
  /** Single-token entries — ambiguous in isolation; kept word-boundary-strict. */
  readonly broad: readonly string[];
};

// ── DARK_SIGNALS ─────────────────────────────────────────────────────────────
// No-dark hard-exclusion source #2 (phrasal / curated list) in
// `evaluateBookAgainstIntentLens`. Source #1 is `classifyTone === 'dark'`
// with specific confidence; source #3 is the market-position rule below.
export const DARK_SIGNALS: SignalSet = {
  specific: [
    // Legacy mood / content descriptors.
    'dark themes', 'dark fiction', 'disturbing content', 'graphic violence',
    'horror fiction',
    // P4C.1 follow-up #2 — canonical genre markers (mirror TONE_DARK_SPECIFIC
    // in lib/bookTraits.ts so hard-exclusion has the same dark coverage as
    // the trait classifier).
    'dark fantasy', 'grimdark',
    'psychological thriller', 'psychological suspense',
    'psychological horror',   'gothic horror',
    'domestic thriller',      'domestic suspense',
    'serial killer',          'serial killers',
    'true crime',
    // P4C.1 follow-up #5 (2026-05-17, live-corpus driven) — phrasal markers
    // observed for Gone Girl / The Silent Patient that the prior set missed.
    // 'psychological fiction' is DELIBERATELY omitted — it also fires on
    // Everything I Never Told You (literary grief novel, fixture-confirmed
    // eligible under No-dark).
    //
    // P4C.1 follow-up #7 (2026-05-18, live-corpus driven) — 'crime fiction'
    // REMOVED from this set. It is a broad OL genre tag that fires on
    // cozies (Thursday Murder Club has subjects: 'mystery', 'cozy mystery',
    // 'detective', 'crime fiction', 'mystery fiction'). Hard-excluding on
    // it alone violates the "No dark = specific evidence only" rule. Gone
    // Girl coverage is preserved via the market-position coupled rule
    // (domestic_suspense + 'psychological'/'suspense'). Silent Patient
    // coverage is preserved via 'family violence' + 'psychotherapy patient'.
    'family violence',
    'psychotherapy patient', 'psychotherapy patients',
  ],
  broad: [
    // Single tokens, retained from the prior flat DARK_SIGNALS for behavior
    // parity. Word-boundary now applies — `\btrauma\b` will not match
    // 'traumatic'; `\bnoir\b` will not match 'memoir' (it never did under
    // substring either; documented for completeness).
    'trauma',  'traumas',
    'abuse',   'abuses',
    'assault', 'assaults',
    'gritty', 'bleak', 'depressing', 'disturbing', 'sinister', 'unsettling',
    'nihilistic', 'noir',
    // Plural / inflected variants explicitly enumerated to preserve the
    // P4C.1 substring-era coverage. Adjective forms ('traumatic', 'abusive')
    // are NOT included — they were caught by substring before but at low
    // frequency in OL subject corpora, and re-adding them would risk
    // over-firing on memoir / literary work. Accepted tightening per the
    // BookEvidence Batch A acceptance note.
  ],
};

// ── DOMESTIC_SUSPENSE_SUPPORT_SIGNALS ────────────────────────────────────────
// Coupled rule: when the trait pipeline has classified a book as
// `marketPosition === 'domestic_suspense'`, the No-dark promise should fire
// even if the OL subject corpus is minimally tagged — provided at least one
// reinforcing dark/psychological/crime/violence/suspense signal is present
// (preserves the spec's "no false positives on cozies" rule).
export const DOMESTIC_SUSPENSE_SUPPORT_SIGNALS: SignalSet = {
  specific: [
    'mental illness',
  ],
  broad: [
    // Tightened by P4C.1 follow-up #7 (2026-05-18). Previously this set
    // also contained 'crime'/'crimes', 'murder'/'murders', 'thriller'/
    // 'thrillers', 'mystery'/'mysteries'. Those generic genre tokens
    // were causing No-dark to hard-exclude cozies that happened to be
    // misclassified upstream as domestic_suspense (Thursday Murder
    // Club had 'mystery' and 'crime' tags). Per the locked product
    // rule, "domestic_suspense + support" requires stronger support
    // than generic crime/mystery — psychological / suspense /
    // violence / psychotherapy are the genuinely dark-leaning
    // reinforcers. Gone Girl, Silent Patient, Verity (all live
    // fixtures) still hit via these reinforcers; Thursday Murder
    // Club no longer false-positives even if marketPos slips.
    'psychological', 'suspense',
    'violence',
    'psychotherapy',
  ],
};

// ── Matching primitives ──────────────────────────────────────────────────────
// Word-boundary, case-insensitive. Specific entries are tested before broad
// so the first-match phrase returned by `firstSignalMatch` is the most
// informative one available.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(signals: readonly string[]): { phrase: string; re: RegExp }[] {
  return signals.map(s => ({
    phrase: s,
    re: new RegExp(`\\b${escapeRegex(s)}\\b`, 'i'),
  }));
}

// Cache compiled matchers per SignalSet (module-load identity).
const _cache = new WeakMap<SignalSet, { phrase: string; re: RegExp }[]>();
function matchersFor(set: SignalSet): { phrase: string; re: RegExp }[] {
  let m = _cache.get(set);
  if (!m) {
    m = [...compile(set.specific), ...compile(set.broad)];
    _cache.set(set, m);
  }
  return m;
}

/**
 * Test `corpus` (already lower-cased recommended) against every phrase in
 * `set`. Returns the first matching phrase (specific entries iterated first),
 * or `null` if nothing matched.
 *
 * Used by `evaluateBookAgainstIntentLens` to attach a human-readable evidence
 * kind to the resulting hard-exclusion record.
 */
export function firstSignalMatch(corpus: string, set: SignalSet): string | null {
  if (!corpus) return null;
  for (const { phrase, re } of matchersFor(set)) {
    if (re.test(corpus)) return phrase;
  }
  return null;
}

/**
 * Predicate form — true iff any phrase in `set` is present in `corpus`.
 * Equivalent to `firstSignalMatch(corpus, set) !== null` but skips the
 * phrase allocation when the caller does not need to report which one fired.
 */
export function hasAnySignal(corpus: string, set: SignalSet): boolean {
  return firstSignalMatch(corpus, set) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BookEvidence Batch B (P4 hygiene) — typed trait-classifier signal sets.
//
// These sets are the migration of the previously-private constants in
// `lib/bookTraits.ts` (TONE_DARK_SPECIFIC / TONE_DARK_BROAD / TONE_LIGHT_*,
// PACE_FAST_*, PACE_SLOW_*, COMPLEXITY_ACCESSIBLE_*, COMPLEXITY_LITERARY_*,
// COMPLEXITY_DENSE_*) into a shape consumable by `deriveBookEvidence`.
//
// Partition rule (locked, identical to the bookTraits classifier):
//   • A phrase is `specific` iff it contains a space or a hyphen after trim.
//   • Single-token entries that were authored in the original "_SPECIFIC"
//     list are folded into `broad` here (matching the prior runtime
//     `partitionBySpecificity` behavior). This pre-application means the
//     runtime no longer needs to re-partition.
//
// Acceptance gate: `scripts/validate_book_evidence.ts §1` asserts that
// element-by-element these sets equal the partition of the original
// bookTraits constants (inline-snapshotted in the validator).
//
// Matching is word-boundary + case-insensitive (same as DARK_SIGNALS).
// Counts are computed via `countMatches`; thresholds (≥1 specific OR ≥2
// broad → "strong") live in the classifiers, not here.

// Tone — dark.
export const TONE_DARK: SignalSet = {
  specific: [
    'dark fantasy', 'dark fiction', 'dark themes',
    'psychological thriller', 'psychological horror', 'gothic horror',
    'true crime',
  ],
  broad: [
    // Original TONE_DARK_BROAD (in order).
    'horror', 'thriller', 'murder', 'death', 'war', 'violence',
    // Folded-in single-token entries from the original TONE_DARK_SPECIFIC.
    'grimdark', 'noir', 'trauma', 'grief', 'bleak', 'grim',
    'tragedy', 'tragic',
  ],
};

// Tone — light.
export const TONE_LIGHT: SignalSet = {
  specific: [
    'cozy mystery', 'cozy fantasy', 'cozy fiction', 'romantic comedy',
    'feel-good', 'feel good',
    'humorous fiction', 'comic fiction',
    'beach read',
  ],
  broad: [
    // Original TONE_LIGHT_BROAD (in order).
    'humor', 'humour', 'comedy', 'funny', 'witty', 'cozy',
    'lighthearted', 'light-hearted',
    // Folded-in single-token entries from TONE_LIGHT_SPECIFIC.
    'heartwarming', 'uplifting', 'comedic',
  ],
};

// Pace — fast.
export const PACE_FAST: SignalSet = {
  specific: [
    'page-turner', 'page turner', 'fast-paced', 'fast paced',
    'psychological thriller', 'action-packed', 'action packed',
    'spy thriller', 'spy novel', 'crime thriller', 'legal thriller',
    'medical thriller',
  ],
  broad: [
    'thriller', 'suspense', 'action', 'fast',
    // No single-token entries to fold in (all PACE_FAST_SPECIFIC are phrasal).
  ],
};

// Pace — slow.
export const PACE_SLOW: SignalSet = {
  specific: [
    'slow-burn', 'slow burn', 'literary fiction', 'literary novel',
    'philosophical fiction', 'character study',
  ],
  broad: [
    'literary', 'philosophical', 'contemplation', 'introspective',
    // Folded-in single-token entries from PACE_SLOW_SPECIFIC.
    'meditative', 'contemplative', 'reflective',
  ],
};

// Complexity — accessible.
export const COMPLEXITY_ACCESSIBLE: SignalSet = {
  specific: [
    'self-help', 'self help', 'how-to', 'beach read', 'cozy mystery',
    'cozy fantasy', 'popular nonfiction', 'popular science', 'pop science',
    'commercial fiction',
  ],
  broad: [
    'accessible', 'commercial', 'popular', 'beginner',
    // No single-token entries to fold in.
  ],
};

// Complexity — literary.
export const COMPLEXITY_LITERARY: SignalSet = {
  specific: [
    'literary fiction', 'literary novel', 'lyrical prose',
    'man booker', 'booker prize', 'national book award', 'pulitzer prize',
  ],
  broad: [
    'literary', 'lyrical',
    // No single-token entries to fold in.
  ],
};

// ── Batch C (shadow-mode) ─────────────────────────────────────────────────────
// Intensity = experiential charge during reading. Distinct from `pace` (which
// is structural reading speed) and from `tone` (dark vs light surface content).
// A book can be high-pace + low-intensity (a brisk cozy mystery) or
// low-pace + high-intensity (a slow-burn psychological thriller whose every
// scene is taut). Phrasal rule from `partitionBySpecificity` is pre-applied
// at authoring time: anything single-token lives in `broad`.
//
// SAFETY: these SignalSets are observational only in slice C0. They are NOT
// consumed by any No-dark hard exclusion, ranking input, or composer reason.
// Acceptance is gated by validate_no_dark_isolation.

export const INTENSITY_HIGH: SignalSet = {
  specific: [
    'propulsive thriller', 'relentlessly paced', 'breathless pace',
    'non-stop action', 'action-packed', 'page-turner',
    'edge of your seat', 'pulse-pounding',
  ],
  broad: [
    'propulsive', 'relentless', 'breathless', 'frenetic', 'taut',
  ],
};

export const INTENSITY_LOW: SignalSet = {
  specific: [
    'gentle read', 'quiet novel', 'understated prose',
    'cozy mystery', 'cozy fantasy',
    'feel-good', 'feel good',
    'quiet meditation',
  ],
  broad: [
    'gentle', 'quiet', 'cozy', 'understated', 'pastoral',
  ],
};

// EmotionalWeight = residue the book leaves after finishing. Distinct from
// `tone` (Gone Girl is dark / low-weight) and from `intensity` (a quiet grief
// novel is low-intensity / high-weight). The HIGH list is the most dangerous
// in the file — `grief` is broad on purpose; `processing grief` is specific.
// Bare `memoir` is deliberately not in either tier.

export const EMOTIONAL_WEIGHT_HIGH: SignalSet = {
  specific: [
    'family secrets', 'intergenerational trauma',
    'grief and loss', 'processing grief',
    'coming of age', 'memoir of loss',
    'meditation on mortality', 'marriage in crisis',
  ],
  broad: [
    'grief', 'loss', 'mourning', 'bereavement', 'regret',
  ],
};

export const EMOTIONAL_WEIGHT_LOW: SignalSet = {
  specific: [
    'light entertainment', 'beach read', 'comic novel', 'romantic comedy',
    'cozy mystery', 'escapist fiction',
  ],
  broad: [
    'light', 'fun', 'escapist', 'entertaining',
  ],
};

// Complexity — dense.
export const COMPLEXITY_DENSE: SignalSet = {
  specific: [
    'experimental fiction', 'philosophical treatise', 'critical theory',
  ],
  broad: [
    'dense', 'epic', 'philosophy', 'theology', 'theory',
    // Folded-in single-token entries from COMPLEXITY_DENSE_SPECIFIC.
    'academic', 'scholarly', 'theoretical', 'postmodern',
    'monograph', 'dissertation',
  ],
};

/**
 * Count of distinct matched phrases (not total hits across the corpus).
 * One phrase matching twice still counts as one — mirrors the prior
 * `countMatches` in `lib/bookTraits.ts`.
 */
export function countMatches(corpus: string, set: SignalSet): { specific: number; broad: number } {
  if (!corpus) return { specific: 0, broad: 0 };
  let s = 0;
  let b = 0;
  for (const { re } of compile(set.specific)) if (re.test(corpus)) s++;
  for (const { re } of compile(set.broad))    if (re.test(corpus)) b++;
  return { specific: s, broad: b };
}

/**
 * Same as `countMatches` but also returns the first matched phrase in each
 * tier — used by `deriveBookEvidence` to populate AxisMatch. `compile()`
 * memoizes per signal array, so repeated calls across axes are cheap and a
 * separate tiered cache is unnecessary.
 */
export function countMatchesDetailed(
  corpus: string,
  set: SignalSet,
): { specificCount: number; broadCount: number; firstSpecific: string | null; firstBroad: string | null } {
  if (!corpus) return { specificCount: 0, broadCount: 0, firstSpecific: null, firstBroad: null };
  let s = 0, b = 0;
  let firstSpec: string | null = null;
  let firstBroad: string | null = null;
  for (const { phrase, re } of compile(set.specific)) {
    if (re.test(corpus)) {
      s++;
      if (firstSpec === null) firstSpec = phrase;
    }
  }
  for (const { phrase, re } of compile(set.broad)) {
    if (re.test(corpus)) {
      b++;
      if (firstBroad === null) firstBroad = phrase;
    }
  }
  return { specificCount: s, broadCount: b, firstSpecific: firstSpec, firstBroad: firstBroad };
}
