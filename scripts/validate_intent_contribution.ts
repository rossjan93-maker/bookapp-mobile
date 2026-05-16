// =============================================================================
// validate_intent_contribution — P4C current_intent_fit observe-only validator
//
// Gating contract (post-architect tightening): current_intent_fit emits
// ONLY when both conditions hold:
//   (a) the user has ≥1 intent-shaped diagnosis answer
//       (q_outcome / q_pacing / q_tone / q_what_grips), AND
//   (b) at least one real intent-to-book pairing fired in this run
//       (tone_fit / pace_fit / complexity_fit / not_right_now_risk).
// The "fit" name must never appear without a book-side pairing.
//
// Asserts:
//   1. No diagnosis answers → no current_intent_fit.
//   2. Intent-shaped answer present but NO book-side pairing → no
//      current_intent_fit (deferred — no pairing evidence).
//   3. Intent-shaped answer present AND a pairing emitted (e.g. matching
//      tone fixture) → exactly one current_intent_fit with value === 0,
//      evidence.intentKeys + intentScope + legacy + pairedKinds set.
//   4. Durable-shaped answers (b_*) alone never trigger emission.
//   5. Explicit intentScope='session' honored (legacy=false).
//
// Exit 0 on full pass; exit 1 on any failure.
// =============================================================================

import { deriveP4CContributions } from '../lib/scoring/p4cContributions';
import { buildSignals } from '../lib/recSignals/build';
import type { Signals } from '../lib/recSignals/types';
import type { BookTraits } from '../lib/bookTraits';
import type { TasteProfile } from '../lib/tasteProfile';
import { getBookTraits } from '../lib/bookTraits';

let failures = 0;
function check(label: string, cond: unknown, detail = ''): void {
  if (cond) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

const emptyProfile = {
  topGenres: [], topTraits: [], avoidedTraits: [],
  ratedGenres: {}, likedSubjects: [], likedAuthors: [],
} as unknown as TasteProfile;

function mkSignals(diagnosis: Record<string, unknown> | null) {
  return buildSignals({
    profile:  emptyProfile,
    prefsRow: {
      favorite_genres:  [],
      avoid_genres:     [],
      reading_styles:   [],
      favorite_authors: null,
      updated_at:       null,
      diagnosis_answers: diagnosis,
    },
  });
}

const emptyMap = new Map<string, ReadonlySet<number>>();
const blankBook = { title: 'Blank', author: 'X', subjects: [] };
const blankTraits = getBookTraits(blankBook);

// A book with a confirmed tone trait, used as the "pairing fixture" — when
// combined with a user tone intent, tone_fit emits and unlocks the
// current_intent_fit pairing precondition.
function pairingTraits(): BookTraits {
  return {
    primaryGenre:         null,
    bookForm:             null,
    genres:               [],
    traits:               {},
    tone:                 'light', toneConfidence:       'specific',
    pace:                 'unknown', paceConfidence:       'unknown',
    complexity:           'unknown', complexityConfidence: 'unknown',
    lengthClass:          'unknown',
    seriesPosition:       null,
  };
}

function emit(traits: BookTraits, sig: Signals) {
  return deriveP4CContributions({
    book: blankBook, traits, signals: sig, seriesPositionsRead: emptyMap,
  });
}

// ── 1. No diagnosis → zero current_intent_fit ────────────────────────────────
console.log('1. No diagnosis answers → no current_intent_fit contribution');
{
  const cs = emit(blankTraits, mkSignals(null));
  const cif = cs.filter(c => c.kind === 'current_intent_fit');
  check('zero current_intent_fit emitted', cif.length === 0, `got ${cif.length}`);
}

// ── 2. Only durable answers → zero current_intent_fit ────────────────────────
console.log('2. Only durable-shaped diagnosis (b_*) → no current_intent_fit');
{
  const cs = emit(blankTraits, mkSignals({ b_fiction_split: 'mostly_fiction' }));
  const cif = cs.filter(c => c.kind === 'current_intent_fit');
  check('zero current_intent_fit on durable-only answers', cif.length === 0, `got ${cif.length}`);
}

// ── 3. Intent-shaped answer present but NO book-side pairing → deferred ─────
console.log('3. Intent-shaped answer present but no pairing (blank book traits) → no emission');
for (const intentKey of ['q_outcome', 'q_pacing', 'q_tone', 'q_what_grips'] as const) {
  const sig = mkSignals({ [intentKey]: 'something' });
  const cs = emit(blankTraits, sig);
  const cif = cs.filter(c => c.kind === 'current_intent_fit');
  check(`no current_intent_fit for ${intentKey} alone (no book-side pairing)`,
    cif.length === 0, `got ${cif.length}`);
}

// ── 4. Intent-shaped answer + book-side pairing → exactly one emission ──────
console.log('4. Intent-shaped answer AND tone pairing fires → exactly 1 current_intent_fit');
{
  // q_tone=light + book tone=light → tone_fit pairs, unlocking current_intent_fit
  const sig = mkSignals({ q_tone: 'mostly_light' });
  const cs  = emit(pairingTraits(), sig);
  const cif = cs.filter(c => c.kind === 'current_intent_fit');
  const tone = cs.filter(c => c.kind === 'tone_fit');
  check('tone_fit pairing emitted (precondition)', tone.length === 1, `got ${tone.length}`);
  check('exactly 1 current_intent_fit emitted', cif.length === 1, `got ${cif.length}`);
  if (cif.length === 1) {
    const ev = cif[0].evidence as {
      intentKeys?: string[]; intentScope?: string; legacy?: boolean; pairedKinds?: string[];
    };
    check('  value === 0',                          cif[0].value === 0);
    check('  phase === scoring',                    cif[0].phase === 'scoring');
    check('  evidence.intentKeys = [q_tone]',
      Array.isArray(ev.intentKeys) && ev.intentKeys.length === 1 && ev.intentKeys[0] === 'q_tone');
    check('  evidence.legacy === true (legacy default writer)',
      ev.legacy === true);
    check('  evidence.intentScope === durable (legacy default)',
      ev.intentScope === 'durable', `got ${ev.intentScope}`);
    check('  evidence.pairedKinds contains tone_fit',
      Array.isArray(ev.pairedKinds) && ev.pairedKinds.includes('tone_fit'),
      `got ${JSON.stringify(ev.pairedKinds)}`);
  }
}

// ── 5. Mixed durable + intent + pairing → intent keys only on evidence ──────
console.log('5. Mixed durable + intent answers + pairing → intent keys only on evidence');
{
  const sig = mkSignals({
    b_fiction_split: 'mostly_fiction',
    q_tone:          'mostly_light',
    q_what_grips:    'world',
  });
  const cs  = emit(pairingTraits(), sig);
  const cif = cs.filter(c => c.kind === 'current_intent_fit');
  check('exactly 1 current_intent_fit (pairing present)', cif.length === 1, `got ${cif.length}`);
  if (cif.length === 1) {
    const ev = cif[0].evidence as { intentKeys?: string[] };
    const set = new Set(ev.intentKeys ?? []);
    check('  intentKeys = {q_tone, q_what_grips}',
      set.size === 2 && set.has('q_tone') && set.has('q_what_grips'),
      `got ${JSON.stringify([...set])}`);
    check('  intentKeys does NOT include b_fiction_split', !set.has('b_fiction_split'));
  }
}

// ── 6. Explicit intentScope='session' on row → mirrored, legacy=false ───────
console.log('6. Explicit intentScope key honored (forward-compat)');
{
  const sig = mkSignals({ intentScope: 'session', q_tone: 'mostly_light' });
  const cs  = emit(pairingTraits(), sig);
  const cif = cs.filter(c => c.kind === 'current_intent_fit');
  check('1 current_intent_fit', cif.length === 1);
  if (cif.length === 1) {
    const ev = cif[0].evidence as { intentScope?: string; legacy?: boolean };
    check('  intentScope = session', ev.intentScope === 'session');
    check('  legacy = false',        ev.legacy === false);
  }
}

// ── 7. Integration assertion: P4C contributions do NOT affect score-sum
//      invariant. deriveScoringContributions is unchanged; P4C is appended.
//      Re-derive scoring contributions in isolation and confirm sum-back.
console.log('7. Score-sum invariant unaffected by P4C presence');
{
  const { deriveScoringContributions } = require('../lib/scoring/contributions');
  const bd = {
    trait_alignment:  0.18,
    avoided_penalty:  0,
    genre_bonus:      0.10,
    feedback_boost:   0,
    enrichment_bonus: 0.04,
    metadata_penalty: 0,
    stated_taste:     0.06,
    raw_score:        0.38,
  };
  const scoringCs = deriveScoringContributions(bd, ['stated_favorite:thriller_mystery']);
  const sig = mkSignals({ q_tone: 'mostly_light' });
  const p4cCs = emit(pairingTraits(), sig);
  const combined = [...scoringCs, ...p4cCs];
  const sum = combined.reduce((a: number, c: { value: number }) => a + c.value, 0);
  check(`Σ combined contributions === raw_score (${sum.toFixed(4)} === ${bd.raw_score})`,
    Math.abs(sum - bd.raw_score) < 1e-9, `Δ=${(sum - bd.raw_score).toFixed(6)}`);
  check('P4C contributions all have value === 0',
    p4cCs.every((c: { value: number }) => c.value === 0));
}

console.log(failures === 0 ? '\n✓ ALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
