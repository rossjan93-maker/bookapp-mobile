// =============================================================================
// validate_tone_pace_fit — P4C tone_fit / pace_fit / complexity_fit /
// avoidance_conflict / not_right_now_risk observe-only validator
//
// Proves that:
//   1. tone_fit / pace_fit emit only when BOTH book trait and user signal
//      are known; not when either side is unknown.
//   2. Reading-style intent chips (Fast-paced / Light read / Dark themes /
//      Slow-burn / Action-packed / Funny-Witty) map correctly to user
//      tone / pace.
//   3. Quick-taste q_tone / q_pacing answers override / extend the chip
//      signal cleanly.
//   4. complexity_fit emits only with durable craft style (Dense prose /
//      Reflective) + known book complexity.
//   5. avoidance_conflict emits only on a real intersection between
//      bookGenres and softAvoids.genres.
//   6. not_right_now_risk emits only on a real tone / pace mismatch (not
//      mixed / medium partial matches).
//   7. Every emitted contribution has value === 0 and a non-empty
//      evidence payload.
//
// Exit 0 on full pass; exit 1 on any failure.
// =============================================================================

import { deriveP4CContributions } from '../lib/scoring/p4cContributions';
import { buildSignals } from '../lib/recSignals/build';
import type { Signals } from '../lib/recSignals/types';
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
}): Signals {
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

const emptyMap = new Map<string, ReadonlySet<number>>();
const blankBook = { title: 'B', author: 'X', subjects: [] };

function mkTraits(overrides: Partial<BookTraits>): BookTraits {
  return {
    primaryGenre:         null,
    bookForm:             null,
    genres:               [],
    traits:               {},
    tone:                 'unknown',
    toneConfidence:       'unknown',
    pace:                 'unknown',
    paceConfidence:       'unknown',
    complexity:           'unknown',
    complexityConfidence: 'unknown',
    lengthClass:          'unknown',
    seriesPosition:       null,
    ...overrides,
  };
}

function emit(traits: BookTraits, signals: Signals, book = blankBook) {
  return deriveP4CContributions({ book, traits, signals, seriesPositionsRead: emptyMap });
}

// ── 1. Both sides unknown → no tone_fit / pace_fit / complexity_fit ─────────
console.log('1. Both sides unknown → no tone_fit / pace_fit / complexity_fit');
{
  const sig = mkSignals({});
  const cs = emit(mkTraits({}), sig);
  for (const k of ['tone_fit', 'pace_fit', 'complexity_fit'] as const) {
    check(`no ${k}`, cs.filter(c => c.kind === k).length === 0);
  }
}

// ── 2. Book tone known, user unknown → no tone_fit ──────────────────────────
console.log('2. Book tone known, user tone unknown → no tone_fit');
{
  const cs = emit(mkTraits({ tone: 'dark', toneConfidence: 'specific' }), mkSignals({}));
  check('no tone_fit', cs.filter(c => c.kind === 'tone_fit').length === 0);
}

// ── 3. User tone known, book unknown → no tone_fit ──────────────────────────
console.log('3. User tone known, book tone unknown → no tone_fit');
{
  const cs = emit(mkTraits({}), mkSignals({ styles: ['Dark themes'] }));
  check('no tone_fit', cs.filter(c => c.kind === 'tone_fit').length === 0);
}

// ── 4. Reading-style chip mappings ──────────────────────────────────────────
console.log('4. Reading-style intent chips map correctly to user tone / pace');
const styleMap: Array<{ chip: string; axis: 'tone' | 'pace'; value: string }> = [
  { chip: 'Dark themes',   axis: 'tone', value: 'dark'  },
  { chip: 'Light read',    axis: 'tone', value: 'light' },
  { chip: 'Funny / Witty', axis: 'tone', value: 'light' },
  { chip: 'Fast-paced',    axis: 'pace', value: 'fast'  },
  { chip: 'Action-packed', axis: 'pace', value: 'fast'  },
  { chip: 'Slow-burn',     axis: 'pace', value: 'slow'  },
];
for (const { chip, axis, value } of styleMap) {
  const traits = axis === 'tone'
    ? mkTraits({ tone: value === 'light' ? 'light' : 'dark', toneConfidence: 'specific' })
    : mkTraits({ pace: value === 'fast'  ? 'fast'  : 'slow', paceConfidence: 'specific' });
  const cs = emit(traits, mkSignals({ styles: [chip] }));
  const kind = axis === 'tone' ? 'tone_fit' : 'pace_fit';
  const e = cs.find(c => c.kind === kind);
  check(`${chip} → ${kind} emitted`, !!e);
  if (e) {
    check(`  value === 0`, e.value === 0);
    check(`  evidence is non-empty`, e.evidence && Object.keys(e.evidence).length > 0);
    const ev = e.evidence as Record<string, unknown>;
    const userKey = axis === 'tone' ? 'userTone' : 'userPace';
    check(`  ${userKey} === '${value}'`, ev[userKey] === value, `got ${JSON.stringify(ev[userKey])}`);
    check(`  match === 'match'`, ev.match === 'match', `got ${ev.match}`);
  }
}

// ── 5. q_tone overrides on light/dark + match label correctness ─────────────
console.log('5. q_tone / q_pacing answers honoured and match label correct');
{
  // book mixed vs user light → partial
  const cs = emit(mkTraits({ tone: 'mixed', toneConfidence: 'broad' }),
                  mkSignals({ diagnosis: { q_tone: 'mostly_light' } }));
  const e = cs.find(c => c.kind === 'tone_fit');
  check('mixed book + light user → partial', e !== undefined &&
        (e.evidence as { match?: string }).match === 'partial');
}
{
  // pace medium vs user fast → partial
  const cs = emit(mkTraits({ pace: 'medium', paceConfidence: 'broad' }),
                  mkSignals({ diagnosis: { q_pacing: 'fast' } }));
  const e = cs.find(c => c.kind === 'pace_fit');
  check('medium book + fast user → partial', e !== undefined &&
        (e.evidence as { match?: string }).match === 'partial');
}
{
  // tone dark vs user light → mismatch
  const cs = emit(mkTraits({ tone: 'dark', toneConfidence: 'specific' }),
                  mkSignals({ styles: ['Light read'] }));
  const e = cs.find(c => c.kind === 'tone_fit');
  check('dark book + light user → mismatch', e !== undefined &&
        (e.evidence as { match?: string }).match === 'mismatch');
}

// ── 6. complexity_fit only with durable craft style + known book complexity ─
console.log('6. complexity_fit gating');
{
  // No durable style → no complexity_fit even with dense book
  const cs = emit(mkTraits({ complexity: 'dense', complexityConfidence: 'specific' }),
                  mkSignals({ styles: ['Fast-paced'] }));
  check('no complexity_fit without Dense prose / Reflective',
    cs.filter(c => c.kind === 'complexity_fit').length === 0);
}
{
  // Durable + dense book → match
  const cs = emit(mkTraits({ complexity: 'dense', complexityConfidence: 'specific' }),
                  mkSignals({ styles: ['Dense prose'] }));
  const e = cs.find(c => c.kind === 'complexity_fit');
  check('Dense prose + dense book → complexity_fit emitted', !!e);
  if (e) {
    check('  value === 0', e.value === 0);
    check('  match === match', (e.evidence as { match?: string }).match === 'match');
  }
}
{
  // Durable + accessible book → mismatch (still emitted as evidence)
  const cs = emit(mkTraits({ complexity: 'accessible', complexityConfidence: 'broad' }),
                  mkSignals({ styles: ['Reflective'] }));
  const e = cs.find(c => c.kind === 'complexity_fit');
  check('Reflective + accessible book → mismatch', e !== undefined &&
        (e.evidence as { match?: string }).match === 'mismatch');
}

// ── 7. avoidance_conflict only on real intersection ─────────────────────────
console.log('7. avoidance_conflict emits only on bookGenres ∩ softAvoids.genres');
{
  const cs = emit(
    mkTraits({ primaryGenre: 'romance', genres: ['romance'] }),
    mkSignals({ avoid: ['Romance'] }),
  );
  const e = cs.find(c => c.kind === 'avoidance_conflict');
  check('romance book + avoid Romance → emit', !!e);
  if (e) {
    check('  value === 0', e.value === 0);
    const ev = e.evidence as { conflictKeys?: string[] };
    check('  conflictKeys non-empty', Array.isArray(ev.conflictKeys) && ev.conflictKeys.length > 0);
  }
}
{
  const cs = emit(
    mkTraits({ primaryGenre: 'fantasy_scifi' }),
    mkSignals({ avoid: ['Romance'] }),
  );
  check('non-overlap → no avoidance_conflict',
    cs.filter(c => c.kind === 'avoidance_conflict').length === 0);
}

// ── 8. not_right_now_risk only on real mismatch (not mixed/medium) ──────────
console.log('8. not_right_now_risk gating');
{
  // tone mismatch
  const cs = emit(mkTraits({ tone: 'dark', toneConfidence: 'specific' }),
                  mkSignals({ styles: ['Light read'] }));
  const e = cs.find(c => c.kind === 'not_right_now_risk');
  check('dark book + light user → not_right_now_risk', !!e);
  if (e) {
    const ev = e.evidence as { risks?: Array<{ axis?: string }> };
    check('  risks contains tone axis',
      Array.isArray(ev.risks) && ev.risks.some(r => r.axis === 'tone'));
  }
}
{
  // mixed book + light user → partial, not a hard mismatch
  const cs = emit(mkTraits({ tone: 'mixed', toneConfidence: 'broad' }),
                  mkSignals({ styles: ['Light read'] }));
  check('mixed book + light user → NO not_right_now_risk',
    cs.filter(c => c.kind === 'not_right_now_risk').length === 0);
}
{
  // medium pace book + fast user → partial, no risk
  const cs = emit(mkTraits({ pace: 'medium', paceConfidence: 'broad' }),
                  mkSignals({ styles: ['Fast-paced'] }));
  check('medium pace + fast user → NO not_right_now_risk',
    cs.filter(c => c.kind === 'not_right_now_risk').length === 0);
}

// ── 9. Every emission has value === 0 and non-empty evidence ────────────────
console.log('9. Universal invariants: value === 0 and evidence non-empty');
{
  const cs = emit(
    mkTraits({
      tone:                 'dark',  toneConfidence:       'specific',
      pace:                 'fast',  paceConfidence:       'specific',
      complexity:           'dense', complexityConfidence: 'specific',
      primaryGenre:         'romance',
      genres:               ['romance'],
    }),
    mkSignals({
      styles:    ['Light read', 'Slow-burn', 'Dense prose'],
      avoid:     ['Romance'],
      diagnosis: { q_outcome: 'escape' },
    }),
  );
  check(`emitted ≥ 5 contributions (got ${cs.length})`, cs.length >= 5);
  for (const c of cs) {
    check(`  ${c.kind}: value === 0`, c.value === 0, `value=${c.value}`);
    check(`  ${c.kind}: evidence non-empty`,
      c.evidence && Object.keys(c.evidence).length > 0,
      `evidence=${JSON.stringify(c.evidence)}`);
    check(`  ${c.kind}: phase === scoring`, c.phase === 'scoring');
  }
}

console.log(failures === 0 ? '\n✓ ALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
