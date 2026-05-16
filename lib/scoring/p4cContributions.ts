// =============================================================================
// scoring/p4cContributions.ts — P4C observe-only contribution emission
//
// Pure / synchronous / read-only helper that derives typed evidence-bearing
// `ScoringContribution`s for the P4 contribution kinds wired in this batch:
//
//   current_intent_fit       — typed quick-taste intent signal is present
//   tone_fit                 — book tone known + user tone signal known
//   pace_fit                 — book pace known + user pace signal known
//   complexity_fit           — book complexity known + durable craft style known
//   series_continuation_fit  — book has a series position (catalog or title)
//   avoidance_conflict       — book genre intersects soft-avoid stated genres
//   not_right_now_risk       — current-intent mood/tone conflicts with book trait
//
// Every contribution is emitted with `value === 0`. P4C is observe-only by
// charter: no contribution participates in score arithmetic, no kind enters
// the composer's emit set, and the user-visible RecCard / reasons[] surface
// is byte-identical. The composer (lib/explanations/compose.ts) treats every
// P4C kind as `not_yet_emitted`. The validators in
//   scripts/validate_intent_contribution.ts
//   scripts/validate_tone_pace_fit.ts
//   scripts/validate_series_continuation.ts
// prove the typed evidence is well-formed without asserting any ranking or
// copy delta.
//
// Hard rules (validator-enforced):
//   1. Every emitted contribution has `value === 0`.
//   2. Every emitted contribution has a non-empty `evidence` payload (the
//      whole point of P4C is to carry that evidence forward).
//   3. No emission when the corresponding evidence is `unknown` / absent —
//      observe-only does not mean noise-only.
//   4. No I/O, no randomness, no dependency on the recommender module.
// =============================================================================

import type { ScoringContribution } from './contributions';
import type { BookTraits } from '../bookTraits';
import type { Signals } from '../recSignals/types';

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
 *  user-side signal is the durable reading_styles chips. P4D will revisit
 *  if quick-taste adds an explicit complexity intent. */
function deriveUserComplexity(signals: Signals): { value: UserComplexity; sources: string[] } {
  const sources: string[] = [];
  let value: UserComplexity = 'unknown';
  const durableChips = signals.statedTaste.readingStylesDurable ?? [];
  for (const c of durableChips) {
    if (STYLE_COMPLEX_DENSE.has(c)) { value = 'dense'; sources.push(`reading_style:${c}`); }
  }
  return { value, sources };
}

// ── Helper to build value=0 contributions ────────────────────────────────────
function obs(
  kind: ScoringContribution['kind'],
  source: string,
  evidence: Record<string, unknown>,
): ScoringContribution {
  return { phase: 'scoring', kind, value: 0, source, evidence };
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

  // current_intent_fit emission is gated on a real intent-to-book pairing:
  // it is only emitted when at least one of {tone_fit, pace_fit,
  // complexity_fit, not_right_now_risk} also emits, so the "fit" name
  // never appears without a book-side trait actually matched against a
  // user-side intent signal. Prepared here, pushed at the end.
  const intentShaped = signals.diagnosisAnswers?.intentShaped ?? {};
  const intentKeys   = Object.keys(intentShaped);

  // 2-4. tone_fit / pace_fit / complexity_fit — emit when BOTH sides are known.
  const userTone = deriveUserTone(signals);
  if (traits.tone !== 'unknown' && userTone.value !== 'unknown') {
    out.push(obs('tone_fit', 'tone', {
      bookTone:           traits.tone,
      bookToneConfidence: traits.toneConfidence,
      userTone:           userTone.value,
      userToneSources:    userTone.sources,
      // Match / mismatch is a derived label for downstream convenience.
      match: traits.tone === userTone.value ? 'match'
           : traits.tone === 'mixed'        ? 'partial'
           :                                  'mismatch',
    }));
  }

  const userPace = deriveUserPace(signals);
  if (traits.pace !== 'unknown' && userPace.value !== 'unknown') {
    out.push(obs('pace_fit', 'pace', {
      bookPace:           traits.pace,
      bookPaceConfidence: traits.paceConfidence,
      userPace:           userPace.value,
      userPaceSources:    userPace.sources,
      // Map medium book pace to 'partial' against either fast/slow user pref.
      match: traits.pace === 'medium'
        ? 'partial'
        : (traits.pace === userPace.value ? 'match' : 'mismatch'),
    }));
  }

  const userComplexity = deriveUserComplexity(signals);
  if (traits.complexity !== 'unknown' && userComplexity.value !== 'unknown') {
    const bookIsDense = traits.complexity === 'dense' || traits.complexity === 'literary';
    out.push(obs('complexity_fit', 'complexity', {
      bookComplexity:           traits.complexity,
      bookComplexityConfidence: traits.complexityConfidence,
      userComplexity:           userComplexity.value,
      userComplexitySources:    userComplexity.sources,
      match: bookIsDense ? 'match' : 'mismatch',
    }));
  }

  // 5. series_continuation_fit — emit ONLY when there is real continuation
  //    evidence: the book sits at index N in a named series AND the user
  //    has finished at least one strictly-earlier position in that series.
  //    A book that merely has a seriesPosition but no prior reads ("first
  //    in series" / "no overlap with read history") is NOT a continuation
  //    fit; deferred — P4D will introduce a separate `series_starter` kind
  //    if/when that signal becomes useful.
  if (traits.seriesPosition && traits.seriesPosition.seriesName) {
    const sName = traits.seriesPosition.seriesName;
    const sIdx  = traits.seriesPosition.index;
    const read  = seriesPositionsRead.get(sName);
    const priorReadCount = (read && typeof sIdx === 'number')
      ? [...read].filter(n => n < sIdx).length
      : 0;
    if (priorReadCount > 0) {
      out.push(obs('series_continuation_fit', 'series_position', {
        seriesName:       sName,
        bookSeriesIndex:  sIdx as number,
        seriesTotal:      traits.seriesPosition.of ?? null,
        priorReadCount,
        continuesPrior:   true,
      }));
    }
  }

  // 6. avoidance_conflict — book primaryGenre/genres intersects user
  //    soft-avoid stated genres (AffinityKey). Soft avoid penalty arithmetic
  //    stays untouched; this only flags the conflict for typed observation.
  const avoidKeys = signals.softAvoids?.genres ?? [];
  if (avoidKeys.length > 0) {
    const bookGenres = new Set<string>();
    if (traits.primaryGenre) bookGenres.add(traits.primaryGenre);
    for (const g of traits.genres ?? []) bookGenres.add(g);
    if (book.primary_genre) bookGenres.add(book.primary_genre);
    for (const g of book.genres ?? []) bookGenres.add(g);
    const conflicts = avoidKeys.filter(k => bookGenres.has(k));
    if (conflicts.length > 0) {
      out.push(obs('avoidance_conflict', 'soft_avoid_intersection', {
        conflictKeys: conflicts,
        bookGenres:   [...bookGenres],
      }));
    }
  }

  // 7. not_right_now_risk — current intent (tone / pace) conflicts with a
  //    confirmed book trait. Emits only when user has expressed an intent
  //    AND the book trait is known AND the pairing is a true mismatch (not
  //    a 'mixed' / 'medium' partial).
  const risks: Array<Record<string, unknown>> = [];
  if (userTone.value !== 'unknown' && traits.tone !== 'unknown' && traits.tone !== 'mixed'
      && traits.tone !== userTone.value) {
    risks.push({
      axis:     'tone',
      userWant: userTone.value,
      bookHas:  traits.tone,
      sources:  userTone.sources,
    });
  }
  if (userPace.value !== 'unknown' && traits.pace !== 'unknown' && traits.pace !== 'medium'
      && traits.pace !== userPace.value) {
    risks.push({
      axis:     'pace',
      userWant: userPace.value,
      bookHas:  traits.pace,
      sources:  userPace.sources,
    });
  }
  if (risks.length > 0) {
    out.push(obs('not_right_now_risk', 'intent_trait_mismatch', { risks }));
  }

  // 1 (deferred). current_intent_fit — emitted ONLY when the user has at
  // least one intent-shaped diagnosis answer AND a real intent-to-book
  // pairing was observed by tone_fit / pace_fit / complexity_fit /
  // not_right_now_risk above. The name implies a fit; without a pairing
  // there is nothing to call a fit.
  if (intentKeys.length > 0) {
    const pairingKinds = new Set(['tone_fit', 'pace_fit', 'complexity_fit', 'not_right_now_risk']);
    const pairedKinds  = out.filter(c => pairingKinds.has(c.kind)).map(c => c.kind);
    if (pairedKinds.length > 0) {
      out.push(obs('current_intent_fit', 'diagnosis_answers', {
        intentKeys,
        intentScope:  signals.diagnosisAnswers?.intentScope ?? 'durable',
        legacy:       signals.diagnosisAnswers?.legacy ?? true,
        pairedKinds,
      }));
    }
  }

  return out;
}
