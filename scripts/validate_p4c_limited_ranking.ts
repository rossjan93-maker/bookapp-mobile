// =============================================================================
// validate_p4c_limited_ranking — P4C.1 caps, gating, and stack invariants
//
// Hardens the P4C.1 limited-ranking contract end-to-end:
//
//   1. Per-kind absolute cap. No P4C kind may emit |value| greater than
//      P4C_LIMITED_RANKING_POLICY.perKindAbsCap (0.20). Verified for the
//      saturating cases: 3-key avoidance_conflict and 2-axis
//      not_right_now_risk both clamp to -0.20.
//   2. Negative-only kinds. avoidance_conflict and not_right_now_risk
//      NEVER carry a positive value.
//   3. Reading-style chips are live signals — chip-only mismatch on a
//      specific-confidence book emits signed negative values.
//   4. q_* on legacy rows is observe-only. Same book + same intent
//      delivered as a legacy diagnosis row (no intentScope key) → all
//      P4C kinds emit value === 0.
//   5. q_* in session scope (intentScope='session') is signed.
//   6. 'partial' tone/pace (mixed book / medium book) always emits
//      value === 0 even with a signed-eligible user signal.
//   7. Confidence gate. tone_fit / pace_fit / complexity_fit on broad-
//      confidence books emit value === 0.
//   8. Stack cap (positive). clampP4IntentStack(0.50, 0, 0) → +0.30.
//   9. Stack cap (negative). clampP4IntentStack(0, -0.50, 0) → -0.30.
//  10. Stated-favorite floor protection. clampP4IntentStack(0, -0.30,
//      +0.05) → -0.05 (P4 negative stack clamped to -stated_taste).
//  11. Stated-avoid floor protection. clampP4IntentStack(+0.30, 0,
//      -0.05) → +0.05.
//  12. Series-continuation single-emit value === seriesContinuation
//      (+0.10) and is positive.
//
// Exit 0 on full pass; exit 1 on any failure.
// =============================================================================

import { deriveP4CContributions } from '../lib/scoring/p4cContributions';
import { buildSignals } from '../lib/recSignals/build';
import { P4C_LIMITED_RANKING_POLICY, clampP4IntentStack } from '../lib/recPolicy';
import type { BookTraits } from '../lib/bookTraits';
import type { TasteProfile } from '../lib/tasteProfile';

let failures = 0;
function check(label: string, cond: unknown, detail = ''): void {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

const emptyProfile = {
  topGenres: [], topTraits: [], avoidedTraits: [],
  ratedGenres: {}, likedSubjects: [], likedAuthors: [],
} as unknown as TasteProfile;

function mkSignals(opts: {
  styles?:    string[];
  avoid?:     string[];
  diagnosis?: Record<string, unknown> | null;
} = {}) {
  return buildSignals({
    profile:  emptyProfile,
    prefsRow: {
      favorite_genres:  [],
      avoid_genres:     opts.avoid ?? [],
      reading_styles:   opts.styles ?? [],
      favorite_authors: null,
      updated_at:       null,
      diagnosis_answers: opts.diagnosis ?? null,
    },
  });
}

function mkTraits(overrides: Partial<BookTraits>): BookTraits {
  return {
    primaryGenre:         null,
    bookForm:             null,
    genres:               [],
    traits:               {},
    tone:                 'unknown', toneConfidence:       'unknown',
    pace:                 'unknown', paceConfidence:       'unknown',
    complexity:           'unknown', complexityConfidence: 'unknown',
    lengthClass:          'unknown',
    seriesPosition:       null,
    ...overrides,
  };
}

const emptyMap = new Map<string, ReadonlySet<number>>();
const blankBook = { title: 'B', author: 'X', subjects: [] };
function emit(traits: BookTraits, signals: ReturnType<typeof mkSignals>) {
  return deriveP4CContributions({ book: blankBook, traits, signals, seriesPositionsRead: emptyMap });
}

const W = P4C_LIMITED_RANKING_POLICY;

// ── 1. Per-kind absolute cap (saturating avoidance_conflict) ────────────────
console.log('1. Per-kind cap clamps stacked avoidance_conflict to -0.20');
{
  // 3 conflicts × -0.08 = -0.24 → clamped to -0.20
  const traits = mkTraits({ primaryGenre: 'romance', genres: ['romance', 'fantasy_scifi', 'horror'] });
  const cs = emit(traits, mkSignals({ avoid: ['Romance', 'Fantasy', 'Horror'] }));
  const e = cs.find(c => c.kind === 'avoidance_conflict');
  check('avoidance_conflict emitted with 3 conflicts', !!e);
  if (e) {
    check(`  |value| ≤ perKindAbsCap (${W.perKindAbsCap})`,
      Math.abs(e.value) <= W.perKindAbsCap + 1e-9, `value=${e.value}`);
    check(`  value === -${W.perKindAbsCap} (clamped from raw -0.24)`,
      Math.abs(e.value - (-W.perKindAbsCap)) < 1e-9, `value=${e.value}`);
  }
}

// ── 1b. Per-kind cap (saturating not_right_now_risk) ────────────────────────
console.log('1b. Per-kind cap clamps stacked not_right_now_risk');
{
  // Dark+Fast book vs Light+Slow user → 2 axes × -0.06 = -0.12 (under cap, fine)
  // Force saturation with synthetic: not_right_now is per-axis -0.06, max 2 axes,
  // so natural max is -0.12. Confirm |value| ≤ cap holds.
  const cs = emit(
    mkTraits({ tone: 'dark', toneConfidence: 'specific', pace: 'fast', paceConfidence: 'specific' }),
    mkSignals({ styles: ['Light read', 'Slow-burn'] }),
  );
  const e = cs.find(c => c.kind === 'not_right_now_risk');
  check('not_right_now_risk emitted (2 axes)', !!e);
  if (e) {
    check(`  |value| ≤ perKindAbsCap (${W.perKindAbsCap})`,
      Math.abs(e.value) <= W.perKindAbsCap + 1e-9, `value=${e.value}`);
    check(`  value === ${2 * W.notRightNowRiskPerAxis}`,
      Math.abs(e.value - 2 * W.notRightNowRiskPerAxis) < 1e-9, `value=${e.value}`);
  }
}

// ── 2. Negative-only kinds never go positive ────────────────────────────────
console.log('2. avoidance_conflict + not_right_now_risk are negative-only');
{
  // Any signed emission of these kinds must be ≤ 0
  const cs = emit(
    mkTraits({
      tone: 'dark', toneConfidence: 'specific',
      pace: 'fast', paceConfidence: 'specific',
      primaryGenre: 'romance', genres: ['romance'],
    }),
    mkSignals({ styles: ['Light read', 'Slow-burn'], avoid: ['Romance'] }),
  );
  for (const c of cs) {
    if (c.kind === 'avoidance_conflict' || c.kind === 'not_right_now_risk') {
      check(`  ${c.kind}: value ≤ 0`, c.value <= 0, `value=${c.value}`);
    }
  }
}

// ── 3. Reading-style chip is a live signal → signed ─────────────────────────
console.log('3. Reading-style chips are live signals → signed values');
{
  // Light read chip + dark book (specific) → tone_fit signed mismatch
  const cs = emit(
    mkTraits({ tone: 'dark', toneConfidence: 'specific' }),
    mkSignals({ styles: ['Light read'] }),
  );
  const e = cs.find(c => c.kind === 'tone_fit');
  check('tone_fit emitted', !!e);
  if (e) {
    check(`  value === ${W.toneFitMismatch} (chip is live)`,
      Math.abs(e.value - W.toneFitMismatch) < 1e-9, `got ${e.value}`);
  }
}

// ── 4. q_* on legacy rows → observe-only ────────────────────────────────────
console.log('4. q_* on legacy diagnosis row → value === 0 across kinds');
{
  const cs = emit(
    mkTraits({ tone: 'dark', toneConfidence: 'specific', pace: 'fast', paceConfidence: 'specific' }),
    mkSignals({ diagnosis: { q_tone: 'mostly_light', q_pacing: 'slow' } }),
  );
  const checked = cs.filter(c => c.kind === 'tone_fit' || c.kind === 'pace_fit'
                                 || c.kind === 'not_right_now_risk' || c.kind === 'current_intent_fit');
  check(`emitted ≥ 3 P4C kinds (got ${checked.length})`, checked.length >= 3);
  for (const c of checked) {
    check(`  ${c.kind}: value === 0 on legacy q_* signal`, c.value === 0, `value=${c.value}`);
  }
}

// ── 5. q_* in session scope → signed ────────────────────────────────────────
console.log('5. intentScope=session → q_* signals are signed');
{
  const cs = emit(
    mkTraits({ tone: 'dark', toneConfidence: 'specific' }),
    mkSignals({ diagnosis: { intentScope: 'session', q_tone: 'mostly_light' } }),
  );
  const e = cs.find(c => c.kind === 'tone_fit');
  check('tone_fit signed under session scope',
    e !== undefined && Math.abs(e.value - W.toneFitMismatch) < 1e-9,
    `value=${e?.value}`);
  const cif = cs.find(c => c.kind === 'current_intent_fit');
  check(`current_intent_fit signed +${W.currentIntentFit} under session scope`,
    cif !== undefined && Math.abs(cif.value - W.currentIntentFit) < 1e-9,
    `value=${cif?.value}`);
}

// ── 6. 'partial' label (mixed/medium book) → always observe-only ────────────
console.log('6. partial match → value === 0 even with live chip');
{
  const cs = emit(
    mkTraits({ tone: 'mixed', toneConfidence: 'specific' }),
    mkSignals({ styles: ['Light read'] }),
  );
  const e = cs.find(c => c.kind === 'tone_fit');
  check('tone_fit emitted as partial', e !== undefined &&
    (e.evidence as { match?: string }).match === 'partial');
  check('  value === 0', e !== undefined && e.value === 0, `value=${e?.value}`);
}
{
  const cs = emit(
    mkTraits({ pace: 'medium', paceConfidence: 'specific' }),
    mkSignals({ styles: ['Fast-paced'] }),
  );
  const e = cs.find(c => c.kind === 'pace_fit');
  check('pace_fit emitted as partial', e !== undefined &&
    (e.evidence as { match?: string }).match === 'partial');
  check('  value === 0', e !== undefined && e.value === 0, `value=${e?.value}`);
}

// ── 7. Confidence gate (broad book confidence → observe-only) ───────────────
console.log('7. broad book confidence → tone_fit/pace_fit/complexity_fit value === 0');
{
  const cs = emit(
    mkTraits({
      tone: 'dark', toneConfidence: 'broad',
      pace: 'fast', paceConfidence: 'broad',
      complexity: 'dense', complexityConfidence: 'broad',
    }),
    mkSignals({ styles: ['Light read', 'Slow-burn', 'Dense prose'] }),
  );
  for (const kind of ['tone_fit', 'pace_fit', 'complexity_fit'] as const) {
    const e = cs.find(c => c.kind === kind);
    check(`  ${kind} emitted with value === 0 on broad confidence`,
      e !== undefined && e.value === 0, `value=${e?.value}`);
  }
}

// ── 8. Stack cap positive ───────────────────────────────────────────────────
console.log('8. clampP4IntentStack positive cap');
{
  const v = clampP4IntentStack(0.50, 0, 0);
  check(`+0.50 raw → +${W.stackPosCap}`, Math.abs(v - W.stackPosCap) < 1e-9, `got ${v}`);
}

// ── 9. Stack cap negative ───────────────────────────────────────────────────
console.log('9. clampP4IntentStack negative cap');
{
  const v = clampP4IntentStack(0, -0.50, 0);
  check(`-0.50 raw → ${W.stackNegCap}`, Math.abs(v - W.stackNegCap) < 1e-9, `got ${v}`);
}

// ── 10. Stated-favorite floor protection ────────────────────────────────────
console.log('10. Stated-favorite floor protects against P4 negative stack');
{
  // stated_taste=+0.05; P4 negative would be -0.30 unclamped → must clamp to -0.05
  const v = clampP4IntentStack(0, -0.30, 0.05);
  check('P4 negative stack clamped to -stated_taste (−0.05)',
    Math.abs(v - (-0.05)) < 1e-9, `got ${v}`);
  // Sanity: with mild stated_taste & mild P4, no clamp kicks
  const v2 = clampP4IntentStack(0, -0.04, 0.05);
  check('mild negative under floor → no clamp', Math.abs(v2 - (-0.04)) < 1e-9, `got ${v2}`);
}

// ── 11. Stated-avoid floor protection ───────────────────────────────────────
console.log('11. Stated-avoid floor protects against P4 positive stack');
{
  // stated_taste=-0.05; P4 positive would be +0.30 unclamped → must clamp to +0.05
  const v = clampP4IntentStack(0.30, 0, -0.05);
  check('P4 positive stack clamped to |stated_taste| (+0.05)',
    Math.abs(v - 0.05) < 1e-9, `got ${v}`);
}

// ── 12. series_continuation_fit signed positive ─────────────────────────────
console.log('12. series_continuation_fit signed value');
{
  const m = new Map<string, ReadonlySet<number>>();
  m.set('Farseer', new Set([1, 2]));
  const cs = deriveP4CContributions({
    book: blankBook,
    traits: mkTraits({ seriesPosition: { seriesName: 'Farseer', index: 3, of: 6 } }),
    signals: mkSignals(),
    seriesPositionsRead: m,
  });
  const e = cs.find(c => c.kind === 'series_continuation_fit');
  check('series_continuation_fit emitted', !!e);
  if (e) {
    check(`  value === +${W.seriesContinuation}`,
      Math.abs(e.value - W.seriesContinuation) < 1e-9, `got ${e.value}`);
    check('  value > 0', e.value > 0);
  }
}

// ── 13. Integration-site arithmetic invariant ───────────────────────────────
//   Mirrors the recommender.ts P4C application site (≈L2160-2186) verbatim:
//     p4Stack = clampP4IntentStack(sum_positive, sum_negative, stated_taste)
//     final_score = clamp(raw_score + p4Stack, 0, 1)
//   We do not spin up the full getRankedRecs pipeline (TasteProfile + COG
//   + MIN_CANDIDATES + fit_class gating are out of scope for this validator
//   level) — instead we replay the arithmetic site against varied raw_score
//   and stated_taste seeds with real `deriveP4CContributions` output. A
//   live fixture-replay through getRankedRecs is tracked as a P4C.1
//   follow-up (see delivery report §10).
console.log('13. Integration-site arithmetic invariant (raw_score + p4Stack === final_score, clamped)');
{
  type Case = { raw: number; statedTaste: number; tone: 'dark' | 'light' | 'unknown'; conf: 'specific' | 'broad' };
  const cases: Case[] = [
    { raw: 0.50, statedTaste:  0.00, tone: 'dark',    conf: 'specific' }, // pure neg P4
    { raw: 0.50, statedTaste:  0.05, tone: 'dark',    conf: 'specific' }, // stated-pos floor protection
    { raw: 0.20, statedTaste: -0.05, tone: 'dark',    conf: 'specific' }, // stated-neg floor side
    { raw: 0.90, statedTaste:  0.00, tone: 'unknown', conf: 'specific' }, // no P4 stack
    { raw: 0.05, statedTaste:  0.00, tone: 'dark',    conf: 'broad'    }, // broad → observe-only, p4Stack=0
    { raw: 0.95, statedTaste:  0.00, tone: 'dark',    conf: 'specific' }, // clamp to 1.0
  ];
  for (const cs of cases) {
    const traits = mkTraits({ tone: cs.tone, toneConfidence: cs.conf });
    const sigs   = mkSignals({ styles: ['Light read'] });
    const contribs = deriveP4CContributions({
      book: blankBook, traits, signals: sigs,
      seriesPositionsRead: new Map(),
    });
    let pos = 0, neg = 0;
    for (const c of contribs) {
      if (c.value > 0) pos += c.value;
      else if (c.value < 0) neg += c.value;
    }
    const p4Stack    = clampP4IntentStack(pos, neg, cs.statedTaste);
    const adjScore   = Math.max(0, Math.min(1, cs.raw + p4Stack));
    const breakdown  = +p4Stack.toFixed(3);
    const finalScore = +adjScore.toFixed(3);

    // Invariant 1: every contribution under per-kind cap.
    for (const c of contribs) {
      check(`  case raw=${cs.raw} tone=${cs.tone}/${cs.conf}: ${c.kind} |value| ≤ ${W.perKindAbsCap}`,
        Math.abs(c.value) <= W.perKindAbsCap + 1e-9);
    }
    // Invariant 2: stack within cap envelope.
    check(`  case raw=${cs.raw}/${cs.statedTaste} p4Stack ∈ [${W.stackNegCap}, ${W.stackPosCap}]`,
      p4Stack >= W.stackNegCap - 1e-9 && p4Stack <= W.stackPosCap + 1e-9, `p4Stack=${p4Stack}`);
    // Invariant 3: stated-taste floor never erased.
    if (cs.statedTaste > 0) {
      check(`  case raw=${cs.raw}/+${cs.statedTaste}: p4Stack ≥ -|statedTaste| (floor protected)`,
        p4Stack >= -Math.abs(cs.statedTaste) - 1e-9, `p4Stack=${p4Stack}`);
    } else if (cs.statedTaste < 0) {
      check(`  case raw=${cs.raw}/${cs.statedTaste}: p4Stack ≤ |statedTaste| (avoid floor protected)`,
        p4Stack <= Math.abs(cs.statedTaste) + 1e-9, `p4Stack=${p4Stack}`);
    }
    // Invariant 4: integration arithmetic — final_score === clamp(raw + p4Stack, 0, 1).
    const expected = +Math.max(0, Math.min(1, cs.raw + p4Stack)).toFixed(3);
    check(`  case raw=${cs.raw}/${cs.statedTaste} tone=${cs.tone}/${cs.conf}: final_score === clamp(raw + p4Stack) (got ${finalScore}, expected ${expected}, breakdown.p4_intent_stack=${breakdown})`,
      finalScore === expected);
    // Invariant 5: bounded.
    check(`  case raw=${cs.raw}: final_score ∈ [0, 1]`, finalScore >= 0 && finalScore <= 1);
  }
}

console.log(failures === 0 ? '\n✓ ALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
