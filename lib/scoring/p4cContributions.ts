// =============================================================================
// scoring/p4cContributions.ts — P4C.1 limited-influence contribution emission
//
// Pure / synchronous / read-only helper that derives typed evidence-bearing
// `ScoringContribution`s for the P4 contribution kinds:
//
//   current_intent_fit       — typed quick-taste intent signal is present
//   tone_fit                 — book tone known + user tone signal known
//   pace_fit                 — book pace known + user pace signal known
//   complexity_fit           — book complexity known + durable craft style known
//   series_continuation_fit  — book continues a series the user is mid-stream on
//   avoidance_conflict       — book genre intersects soft-avoid stated genres
//   not_right_now_risk       — current-intent mood/tone conflicts with book trait
//
// P4C.1 (this batch): contributions may carry signed score values bounded by
// `P4C_LIMITED_RANKING_POLICY` (lib/recPolicy.ts). Per-kind absolute cap is
// 0.20; the recommender additionally applies stack caps + stated-taste floor
// protection via `clampP4IntentStack`. The composer
// (lib/explanations/compose.ts) continues to treat every P4C kind as
// `not_yet_emitted`, so user-visible RecCard / reasons[] copy is unchanged.
//
// Evidence gates (validator-enforced in
// scripts/validate_p4c_limited_ranking.ts):
//   1. tone_fit / pace_fit / complexity_fit signed only when BOTH sides are
//      known AND the book confidence is `specific`. `partial` matches
//      (book tone=mixed or pace=medium) always carry value=0 — observe-only.
//   2. tone_fit / pace_fit / not_right_now_risk require a "live or
//      session-eligible" user signal. Reading-style chips always qualify
//      (live durable intent). Diagnosis q_* answers qualify only when
//      diagnosisAnswers.legacy === false (intentScope='session'); on legacy
//      rows the kind stays observe-only (value=0).
//   3. complexity_fit's user side comes only from durable reading_styles
//      chips today, so it is always live when emitted.
//   4. series_continuation_fit signs only when priorReadCount > 0 (already
//      enforced in P4C). Real continuation evidence — no first-in-series.
//   5. avoidance_conflict and not_right_now_risk are NEGATIVE-ONLY by
//      contract: they never emit a positive value, regardless of inputs.
//   6. current_intent_fit signs only when a paired contribution fired AND
//      diagnosisAnswers.legacy === false. Legacy rows keep value=0.
//   7. No I/O, no randomness, no dependency on the recommender module.
// =============================================================================

import type { ScoringContribution } from './contributions';
import type { BookTraits } from '../bookTraits';
import type { Signals } from '../recSignals/types';
import { P4C_LIMITED_RANKING_POLICY } from '../recPolicy';

// ── User-side signal mapping ─────────────────────────────────────────────────
//
// Quick-taste intent answers ("session" diagnosis) and the intent-bucket
// chips in reading_styles share the user-facing concept of "right now".
// Both feed the same per-trait readouts below. Durable reading_styles
// (Dense prose / Reflective) feed complexity_fit only.

const STYLE_TONE_LIGHT = new Set<string>(['Light read', 'Funny / Witty']);
const STYLE_TONE_DARK  = new Set<string>(['Dark themes']);
const STYLE_PACE_FAST  = new Set<string>(['Fast-paced', 'Action-packed']);
const STYLE_PACE_SLOW  = new Set<string>(['Slow-burn']);
const STYLE_COMPLEX_DENSE = new Set<string>(['Dense prose', 'Reflective']);

type UserTone = 'light' | 'dark' | 'unknown';
type UserPace = 'fast'  | 'slow' | 'unknown';
type UserComplexity = 'dense' | 'unknown';

/** Derive the user's current tone preference from intent chips first, then
 *  intent-shaped diagnosis answers (q_tone). Returns 'unknown' when the user
 *  has not expressed a tone preference either way. */
function deriveUserTone(signals: Signals): { value: UserTone; sources: string[] } {
  const sources: string[] = [];
  const intentChips = signals.statedTaste.readingStylesIntent ?? [];
  let value: UserTone = 'unknown';
  for (const c of intentChips) {
    if (STYLE_TONE_LIGHT.has(c)) { value = 'light'; sources.push(`reading_style:${c}`); }
    else if (STYLE_TONE_DARK.has(c)) { value = 'dark'; sources.push(`reading_style:${c}`); }
  }
  const qTone = signals.diagnosisAnswers?.intentShaped?.q_tone;
  if (typeof qTone === 'string' && qTone.length > 0) {
    const v = qTone.toLowerCase();
    if (v.includes('light')) { value = 'light'; sources.push('q_tone:light'); }
    else if (v.includes('dark')) { value = 'dark'; sources.push('q_tone:dark'); }
  }
  return { value, sources };
}

/** Same shape as deriveUserTone but for pace. */
function deriveUserPace(signals: Signals): { value: UserPace; sources: string[] } {
  const sources: string[] = [];
  const intentChips = signals.statedTaste.readingStylesIntent ?? [];
  let value: UserPace = 'unknown';
  for (const c of intentChips) {
    if (STYLE_PACE_FAST.has(c)) { value = 'fast'; sources.push(`reading_style:${c}`); }
    else if (STYLE_PACE_SLOW.has(c)) { value = 'slow'; sources.push(`reading_style:${c}`); }
  }
  const qPace = signals.diagnosisAnswers?.intentShaped?.q_pacing;
  if (typeof qPace === 'string' && qPace.length > 0) {
    const v = qPace.toLowerCase();
    if (v.includes('fast') || v.includes('quick')) { value = 'fast'; sources.push('q_pacing:fast'); }
    else if (v.includes('slow')) { value = 'slow'; sources.push('q_pacing:slow'); }
  }
  return { value, sources };
}

/** Durable craft preference for dense / literary prose. There is no user
 *  side complexity intent signal in the quick-taste schema today (no
 *  `q_complexity` answer key in DIAGNOSIS_INTENT_KEYS); the only available
 *  user-side signal is the durable reading_styles chips. */
function deriveUserComplexity(signals: Signals): { value: UserComplexity; sources: string[] } {
  const sources: string[] = [];
  let value: UserComplexity = 'unknown';
  const durableChips = signals.statedTaste.readingStylesDurable ?? [];
  for (const c of durableChips) {
    if (STYLE_COMPLEX_DENSE.has(c)) { value = 'dense'; sources.push(`reading_style:${c}`); }
  }
  return { value, sources };
}

/** A user-side signal is "ranking eligible" when at least one source comes
 *  from a live durable reading-style chip, OR all q_* sources come from a
 *  non-legacy (intentScope='session') row. Pure / data-only — no recommender
 *  dependency. Legacy rows with only q_* sources stay observe-only.
 *
 *  Reading-style chips are always live (they reflect the user's currently
 *  saved reading_styles preference; not a stale historical artifact).
 *  Diagnosis q_* answers can be legacy (intentScope absent in the row)
 *  or session (intentScope='session', stamped by P4C-0.5 writer). Legacy
 *  q_* alone is not enough to drive ranking — only observation. */
function isRankingEligible(sources: readonly string[], legacy: boolean): boolean {
  if (sources.some(s => s.startsWith('reading_style:'))) return true;
  if (sources.some(s => s.startsWith('q_')) && !legacy)  return true;
  return false;
}

// ── Per-kind cap clamp ───────────────────────────────────────────────────────
const PER_KIND_CAP = P4C_LIMITED_RANKING_POLICY.perKindAbsCap;
function capPerKind(v: number): number {
  if (v >  PER_KIND_CAP) return  PER_KIND_CAP;
  if (v < -PER_KIND_CAP) return -PER_KIND_CAP;
  return v;
}

// ── Emit helper ──────────────────────────────────────────────────────────────
function emit(
  kind: ScoringContribution['kind'],
  source: string,
  value: number,
  evidence: Record<string, unknown>,
): ScoringContribution {
  return { phase: 'scoring', kind, value: capPerKind(value), source, evidence };
}

// ── Inputs ───────────────────────────────────────────────────────────────────
export type P4CBookLike = {
  title?:       string | null;
  primary_genre?: string | null;
  genres?:      string[] | null;
};

export type DeriveP4COpts = {
  book:                P4CBookLike;
  traits:              BookTraits;
  signals:             Signals;
  /** profile.seriesPositionsRead — series name → set of positions completed. */
  seriesPositionsRead: ReadonlyMap<string, ReadonlySet<number>>;
};

// ── Main ─────────────────────────────────────────────────────────────────────
export function deriveP4CContributions(opts: DeriveP4COpts): ScoringContribution[] {
  const { book, traits, signals, seriesPositionsRead } = opts;
  const out: ScoringContribution[] = [];
  const W = P4C_LIMITED_RANKING_POLICY;

  const intentShaped = signals.diagnosisAnswers?.intentShaped ?? {};
  const intentKeys   = Object.keys(intentShaped);
  const intentLegacy = signals.diagnosisAnswers?.legacy ?? true;

  // 2. tone_fit ──────────────────────────────────────────────────────────────
  const userTone = deriveUserTone(signals);
  if (traits.tone !== 'unknown' && userTone.value !== 'unknown') {
    const match: 'match' | 'partial' | 'mismatch' =
      traits.tone === userTone.value ? 'match'
      : traits.tone === 'mixed'      ? 'partial'
      :                                 'mismatch';
    // P4C.1 sign gates: confidence must be 'specific' AND the user signal
    // must be ranking-eligible (live chip OR session q_*). 'partial' (book
    // tone=mixed) stays observe-only regardless.
    const signedEligible =
      traits.toneConfidence === 'specific'
      && isRankingEligible(userTone.sources, intentLegacy)
      && match !== 'partial';
    const value =
        !signedEligible        ? 0
      : match === 'match'      ? W.toneFitMatch
      :                          W.toneFitMismatch;
    out.push(emit('tone_fit', 'tone', value, {
      bookTone:           traits.tone,
      bookToneConfidence: traits.toneConfidence,
      userTone:           userTone.value,
      userToneSources:    userTone.sources,
      match,
      signedEligible,
    }));
  }

  // 3. pace_fit ──────────────────────────────────────────────────────────────
  const userPace = deriveUserPace(signals);
  if (traits.pace !== 'unknown' && userPace.value !== 'unknown') {
    const match: 'match' | 'partial' | 'mismatch' =
      traits.pace === 'medium' ? 'partial'
      : traits.pace === userPace.value ? 'match'
      :                                  'mismatch';
    const signedEligible =
      traits.paceConfidence === 'specific'
      && isRankingEligible(userPace.sources, intentLegacy)
      && match !== 'partial';
    const value =
        !signedEligible        ? 0
      : match === 'match'      ? W.paceFitMatch
      :                          W.paceFitMismatch;
    out.push(emit('pace_fit', 'pace', value, {
      bookPace:           traits.pace,
      bookPaceConfidence: traits.paceConfidence,
      userPace:           userPace.value,
      userPaceSources:    userPace.sources,
      match,
      signedEligible,
    }));
  }

  // 4. complexity_fit ────────────────────────────────────────────────────────
  const userComplexity = deriveUserComplexity(signals);
  if (traits.complexity !== 'unknown' && userComplexity.value !== 'unknown') {
    const bookIsDense = traits.complexity === 'dense' || traits.complexity === 'literary';
    const match: 'match' | 'mismatch' = bookIsDense ? 'match' : 'mismatch';
    // Complexity user side is always a live durable chip — always ranking-
    // eligible when emitted. Confidence gate still applies.
    const signedEligible = traits.complexityConfidence === 'specific';
    const value =
        !signedEligible        ? 0
      : match === 'match'      ? W.complexityFitMatch
      :                          W.complexityFitMismatch;
    out.push(emit('complexity_fit', 'complexity', value, {
      bookComplexity:           traits.complexity,
      bookComplexityConfidence: traits.complexityConfidence,
      userComplexity:           userComplexity.value,
      userComplexitySources:    userComplexity.sources,
      match,
      signedEligible,
    }));
  }

  // 5. series_continuation_fit ───────────────────────────────────────────────
  //    Real continuation evidence only — book at index N in a named series
  //    AND user has finished at least one strictly-earlier position.
  if (traits.seriesPosition && traits.seriesPosition.seriesName) {
    const sName = traits.seriesPosition.seriesName;
    const sIdx  = traits.seriesPosition.index;
    const read  = seriesPositionsRead.get(sName);
    const priorReadCount = (read && typeof sIdx === 'number')
      ? [...read].filter(n => n < sIdx).length
      : 0;
    if (priorReadCount > 0) {
      out.push(emit('series_continuation_fit', 'series_position',
        W.seriesContinuation,
        {
          seriesName:       sName,
          bookSeriesIndex:  sIdx as number,
          seriesTotal:      traits.seriesPosition.of ?? null,
          priorReadCount,
          continuesPrior:   true,
        },
      ));
    }
  }

  // 6. avoidance_conflict (NEGATIVE-ONLY) ────────────────────────────────────
  const avoidKeys = signals.softAvoids?.genres ?? [];
  if (avoidKeys.length > 0) {
    const bookGenres = new Set<string>();
    if (traits.primaryGenre) bookGenres.add(traits.primaryGenre);
    for (const g of traits.genres ?? []) bookGenres.add(g);
    if (book.primary_genre) bookGenres.add(book.primary_genre);
    for (const g of book.genres ?? []) bookGenres.add(g);
    const conflicts = avoidKeys.filter(k => bookGenres.has(k));
    if (conflicts.length > 0) {
      // Stack per conflict, then cap at per-kind floor (negative).
      const raw = W.avoidanceConflictPerHit * conflicts.length;
      const value = Math.max(raw, -PER_KIND_CAP);
      out.push(emit('avoidance_conflict', 'soft_avoid_intersection', value, {
        conflictKeys: conflicts,
        bookGenres:   [...bookGenres],
      }));
    }
  }

  // 7. not_right_now_risk (NEGATIVE-ONLY) ────────────────────────────────────
  //    P4C.1 confidence gate: a mismatch only carries signed ranking influence
  //    when the book trait is `specific` confidence AND the user signal is
  //    ranking-eligible. Broad-confidence book traits stay observe-only — the
  //    metadata isn't strong enough to risk a negative ranking nudge.
  const risks: Array<Record<string, unknown>> = [];
  const obsRisks: Array<Record<string, unknown>> = [];
  if (userTone.value !== 'unknown' && traits.tone !== 'unknown' && traits.tone !== 'mixed'
      && traits.tone !== userTone.value) {
    const eligible = isRankingEligible(userTone.sources, intentLegacy)
                      && traits.toneConfidence === 'specific';
    const entry = { axis: 'tone', userWant: userTone.value, bookHas: traits.tone, sources: userTone.sources };
    if (eligible) risks.push(entry);
    else obsRisks.push({ ...entry, observeOnly: true, bookConfidence: traits.toneConfidence });
  }
  if (userPace.value !== 'unknown' && traits.pace !== 'unknown' && traits.pace !== 'medium'
      && traits.pace !== userPace.value) {
    const eligible = isRankingEligible(userPace.sources, intentLegacy)
                      && traits.paceConfidence === 'specific';
    const entry = { axis: 'pace', userWant: userPace.value, bookHas: traits.pace, sources: userPace.sources };
    if (eligible) risks.push(entry);
    else obsRisks.push({ ...entry, observeOnly: true, bookConfidence: traits.paceConfidence });
  }
  if (risks.length > 0) {
    const raw = W.notRightNowRiskPerAxis * risks.length;
    const value = Math.max(raw, -PER_KIND_CAP);
    out.push(emit('not_right_now_risk', 'intent_trait_mismatch', value, { risks }));
  }
  // ── Observe-only fallback for not_right_now_risk on non-eligible signals.
  //    Keep evidence flowing for P4D telemetry even when ranking influence
  //    is gated off (e.g. legacy q_* alone, broad-confidence book trait).
  if (risks.length === 0) {
    if (obsRisks.length > 0) {
      out.push(emit('not_right_now_risk', 'intent_trait_mismatch', 0, { risks: obsRisks }));
    }
  }

  // 1. current_intent_fit ────────────────────────────────────────────────────
  //    Emitted only when the user has intent-shaped answers AND a real
  //    intent-to-book pairing fired. P4C.1 signed-value gates:
  //      (a) legacy=false (intentScope='session') — legacy rows stay observe-only.
  //      (b) at least one paired kind carried a NON-ZERO signed value. A
  //          paired kind that itself observed only (partial/broad gate)
  //          must not unlock current_intent_fit ranking influence.
  if (intentKeys.length > 0) {
    const pairingKinds = new Set(['tone_fit', 'pace_fit', 'complexity_fit', 'not_right_now_risk']);
    const paired       = out.filter(c => pairingKinds.has(c.kind));
    if (paired.length > 0) {
      const pairedKinds       = paired.map(c => c.kind);
      const pairedSigned      = paired.filter(c => c.value !== 0).map(c => c.kind);
      const intentScope       = signals.diagnosisAnswers?.intentScope ?? 'durable';
      const eligibleForSigned = !intentLegacy && pairedSigned.length > 0;
      const value             = eligibleForSigned ? W.currentIntentFit : 0;
      out.push(emit('current_intent_fit', 'diagnosis_answers', value, {
        intentKeys,
        intentScope,
        legacy:        intentLegacy,
        pairedKinds,
        pairedSigned,
      }));
    }
  }

  return out;
}
