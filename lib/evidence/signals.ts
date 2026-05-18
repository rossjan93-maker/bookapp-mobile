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
