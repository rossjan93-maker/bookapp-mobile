// =============================================================================
// validate_series_continuation — P4C series_continuation_fit observe-only
//
// Gating contract (post-architect tightening): the kind emits ONLY when
// there is real continuation evidence — the book sits at index N in a
// named series AND the user has finished at least one strictly-earlier
// position in that series. "First in series" / "no overlap with read
// history" is NOT a continuation fit and stays deferred.
//
// Asserts:
//   1. traits.seriesPosition = null → no contribution.
//   1b. seriesPosition without seriesName → no contribution.
//   2. seriesName present, NO priors → no contribution (deferred).
//   3. seriesName present, priors exist → exactly one contribution,
//      value === P4C_LIMITED_RANKING_POLICY.seriesContinuation (+0.10),
//      evidence carries seriesName / bookSeriesIndex / seriesTotal /
//      priorReadCount / continuesPrior=true.
//   4. priorReadCount counts only strictly-prior positions.
//   5. Wrong series in readMap → priorReadCount stays 0 → no emission.
//   6. seriesName but undefined index → no emission (no continuation
//      anchor to count against).
//
// Exit 0 on full pass; exit 1 on any failure.
// =============================================================================

import { deriveP4CContributions } from '../lib/scoring/p4cContributions';
import { buildSignals } from '../lib/recSignals/build';
import { P4C_LIMITED_RANKING_POLICY } from '../lib/recPolicy';
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

const noSignals = buildSignals({
  profile:  emptyProfile,
  prefsRow: {
    favorite_genres:  [], avoid_genres: [], reading_styles: [],
    favorite_authors: null, updated_at: null, diagnosis_answers: null,
  },
});

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

const blankBook = { title: 'X', author: 'Y', subjects: [] };
function emit(traits: BookTraits, seriesPositionsRead: ReadonlyMap<string, ReadonlySet<number>>) {
  return deriveP4CContributions({
    book: blankBook, traits, signals: noSignals, seriesPositionsRead,
  });
}

// ── 1. No seriesPosition → no contribution ──────────────────────────────────
console.log('1. traits.seriesPosition = null → no contribution');
{
  const cs = emit(mkTraits({}), new Map());
  check('zero series_continuation_fit',
    cs.filter(c => c.kind === 'series_continuation_fit').length === 0);
}

// ── 1b. seriesPosition without seriesName → no contribution ─────────────────
console.log('1b. seriesPosition without seriesName → no contribution');
{
  const cs = emit(mkTraits({ seriesPosition: { index: 2 } }), new Map());
  check('zero series_continuation_fit',
    cs.filter(c => c.kind === 'series_continuation_fit').length === 0);
}

// ── 2. seriesName present, NO priors → deferred (no emission) ───────────────
console.log('2. seriesName present, no priors → NO contribution (deferred)');
{
  const cs = emit(
    mkTraits({ seriesPosition: { seriesName: 'Mistborn', index: 1, of: 3 } }),
    new Map(),
  );
  check('zero series_continuation_fit (no prior reads → no continuation evidence)',
    cs.filter(c => c.kind === 'series_continuation_fit').length === 0);
}

// ── 3. priorReadCount counts only strictly-prior positions ──────────────────
console.log('3. priors exist → emit with continuesPrior=true, value=0');
{
  const m = new Map<string, ReadonlySet<number>>();
  m.set('Farseer', new Set([1, 3]));   // user has read #1 and #3
  const cs = emit(
    mkTraits({ seriesPosition: { seriesName: 'Farseer', index: 4, of: 6 } }),
    m,
  );
  const e = cs.find(c => c.kind === 'series_continuation_fit');
  check('emitted', !!e);
  if (e) {
    check(`  value === +${P4C_LIMITED_RANKING_POLICY.seriesContinuation}`,
      Math.abs(e.value - P4C_LIMITED_RANKING_POLICY.seriesContinuation) < 1e-9,
      `got ${e.value}`);
    check('  phase === scoring',          e.phase === 'scoring');
    const ev = e.evidence as Record<string, unknown>;
    check('  seriesName preserved',       ev.seriesName === 'Farseer');
    check('  bookSeriesIndex preserved',  ev.bookSeriesIndex === 4);
    check('  seriesTotal preserved',      ev.seriesTotal === 6);
    check('  priorReadCount === 2',       ev.priorReadCount === 2,
      `got ${ev.priorReadCount}`);
    check('  continuesPrior === true',    ev.continuesPrior === true);
  }
}
{
  // user has read #5, book is #2 — no priors strictly less than 2 → no emission
  const m = new Map<string, ReadonlySet<number>>();
  m.set('Foundation', new Set([5]));
  const cs = emit(
    mkTraits({ seriesPosition: { seriesName: 'Foundation', index: 2 } }),
    m,
  );
  check('no strictly-lower priors → no emission',
    cs.filter(c => c.kind === 'series_continuation_fit').length === 0);
}

// ── 4. Wrong series in readMap → no emission ────────────────────────────────
console.log('4. Different series in readMap → no emission');
{
  const m = new Map<string, ReadonlySet<number>>();
  m.set('Some Other Series', new Set([1, 2, 3]));
  const cs = emit(
    mkTraits({ seriesPosition: { seriesName: 'Stormlight', index: 2 } }),
    m,
  );
  check('zero series_continuation_fit (no priors in THIS series)',
    cs.filter(c => c.kind === 'series_continuation_fit').length === 0);
}

// ── 5. seriesName but no index → no emission ────────────────────────────────
console.log('5. seriesName present, index undefined → no emission (no anchor to count against)');
{
  const m = new Map<string, ReadonlySet<number>>();
  m.set('Unknown Index Series', new Set([1, 2]));
  const cs = emit(
    mkTraits({ seriesPosition: { seriesName: 'Unknown Index Series' } }),
    m,
  );
  check('zero series_continuation_fit',
    cs.filter(c => c.kind === 'series_continuation_fit').length === 0);
}

console.log(failures === 0 ? '\n✓ ALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
