// =============================================================================
// validate_rec_request.ts — P1 integrity check
//
// Pure / synchronous truth-table probes for the P1 control-plane signal
// contract. Run with:
//   npx tsx scripts/validate_rec_request.ts
//
// Exits 0 on pass, 1 on any failure. No jest/vitest setup exists in this
// project (see P0A taxonomy validator for precedent).
// =============================================================================

import {
  STATED_TASTE_POLICY,
  computeStatedTasteContribution,
  confidenceModeForTier,
} from '../lib/recPolicy';
import {
  SCHEMA_VERSION,
  setPendingBuildCause,
  consumePendingBuildCause,
  peekPendingBuildCause,
  _resetPendingBuildCauseForTest,
} from '../lib/recRequest';
import { buildSignals } from '../lib/recSignals/build';
import type { TasteProfile } from '../lib/tasteProfile';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approxEq(a: number, b: number, eps = 1e-9) { return Math.abs(a - b) <= eps; }

function makeProfile(tier: number): TasteProfile {
  return { tier } as unknown as TasteProfile;
}

function makeProfileWithIntake(tier: number, intakeBoosted: boolean): TasteProfile {
  return { tier, intakeBoosted } as unknown as TasteProfile;
}

// React Native's __DEV__ global is undefined in Node — stub it so recRequest
// module's DEV-gated console logs do not throw under the validator harness.
(globalThis as any).__DEV__ = (globalThis as any).__DEV__ ?? false;

// ── 1. Schema version ────────────────────────────────────────────────────────
console.log('1. Schema version');
check('SCHEMA_VERSION === "rrv1"', SCHEMA_VERSION === 'rrv1', `got ${SCHEMA_VERSION}`);

// ── 2. Confidence mode mapping (Phase B.0 — Tier-Definition Cleanup) ────────
// `confidenceModeForTier(rawTier, intakeBoosted)` returns one of 4 modes.
// tier 0 + intakeBoosted=false → 'zero_signal'   (genuinely zero signal)
// tier 0 + intakeBoosted=true  → 'sparse_onboarding' (intake completed,
//                                  boost still active — primary cold-start
//                                  adjacency target population)
// tier 1                       → 'thin'          (intake boost has lapsed)
// tier ≥2                      → 'high_signal'
console.log('2. confidenceModeForTier mapping (Phase B.0 4-mode split)');
check('tier 0 + !intakeBoosted → zero_signal',
  confidenceModeForTier(0, false) === 'zero_signal');
check('tier 0 + intakeBoosted  → sparse_onboarding',
  confidenceModeForTier(0, true) === 'sparse_onboarding');
check('tier 1 + !intakeBoosted → thin',
  confidenceModeForTier(1, false) === 'thin');
check('tier 1 + intakeBoosted  → thin (boost only affects tier 0)',
  confidenceModeForTier(1, true) === 'thin');
check('tier 2 → high_signal',
  confidenceModeForTier(2, false) === 'high_signal');
check('tier 3 → high_signal',
  confidenceModeForTier(3, false) === 'high_signal');

// ── 3. Pending BuildCause module state ───────────────────────────────────────
console.log('3. Pending BuildCause consume/clear semantics');
_resetPendingBuildCauseForTest();
check('initial peek is null',         peekPendingBuildCause() === null);
check('initial consume is null',      consumePendingBuildCause() === null);
setPendingBuildCause('explicit_preference_edit');
check('peek after set returns value', peekPendingBuildCause() === 'explicit_preference_edit');
check('peek does not consume',        peekPendingBuildCause() === 'explicit_preference_edit');
check('consume returns value',        consumePendingBuildCause() === 'explicit_preference_edit');
check('consume self-clears',          consumePendingBuildCause() === null);
check('peek after consume is null',   peekPendingBuildCause() === null);

// ── 4. Stated-taste contribution: nonzero floor at every tier ────────────────
//
// This is the core P1 trust property. Tier 2/3 users with an explicit
// favorite genre that matches book.primaryGenre MUST receive a strictly
// positive scoring contribution; tier 2/3 users with an explicit avoid that
// matches MUST receive a strictly negative contribution.
console.log('4. Stated-taste contribution: nonzero floor at all tiers');
for (const tier of [0, 1, 2, 3]) {
  const fav = computeStatedTasteContribution('fantasy_scifi', ['fantasy_scifi'], [], tier);
  check(
    `tier ${tier}: favorite match → bonus > 0`,
    fav.bonus > 0 && fav.penalty === 0 && fav.matched?.kind === 'favorite',
    `bonus=${fav.bonus} penalty=${fav.penalty}`,
  );
  check(
    `tier ${tier}: favorite bonus respects floor (>= ${STATED_TASTE_POLICY.prefFloor})`,
    fav.bonus >= STATED_TASTE_POLICY.prefFloor,
    `bonus=${fav.bonus}`,
  );

  const avoid = computeStatedTasteContribution('horror', [], ['horror'], tier);
  check(
    `tier ${tier}: avoid match → penalty < 0`,
    avoid.penalty < 0 && avoid.bonus === 0 && avoid.matched?.kind === 'avoid',
    `bonus=${avoid.bonus} penalty=${avoid.penalty}`,
  );
  check(
    `tier ${tier}: avoid penalty respects floor (<= ${STATED_TASTE_POLICY.avoidFloor})`,
    avoid.penalty <= STATED_TASTE_POLICY.avoidFloor,
    `penalty=${avoid.penalty}`,
  );
}

// ── 5. Avoid takes precedence over favorite when both match ──────────────────
console.log('5. Avoid precedence over favorite');
const both = computeStatedTasteContribution('horror', ['horror'], ['horror'], 2);
check('both → penalty branch wins', both.penalty < 0 && both.bonus === 0 && both.matched?.kind === 'avoid');

// ── 6. No-match / no-primary-genre → zero contribution ───────────────────────
console.log('6. Zero contribution edges');
const none = computeStatedTasteContribution('literary', ['fantasy_scifi'], ['horror'], 2);
check('non-matching primary → bonus=0 penalty=0',
  none.bonus === 0 && none.penalty === 0 && none.matched === null);
const noPrimary = computeStatedTasteContribution(null, ['fantasy_scifi'], [], 2);
check('null primaryGenre → zero',  noPrimary.bonus === 0 && noPrimary.penalty === 0);
const general = computeStatedTasteContribution('general', ['fantasy_scifi'], [], 2);
check('"general" primaryGenre → zero (excluded by design)',
  general.bonus === 0 && general.penalty === 0);

// ── 7. Tier multipliers monotonic on stated bonus magnitude ──────────────────
console.log('7. Tier multipliers');
const t0 = computeStatedTasteContribution('fantasy_scifi', ['fantasy_scifi'], [], 0).bonus;
const t1 = computeStatedTasteContribution('fantasy_scifi', ['fantasy_scifi'], [], 1).bonus;
const t2 = computeStatedTasteContribution('fantasy_scifi', ['fantasy_scifi'], [], 2).bonus;
const t3 = computeStatedTasteContribution('fantasy_scifi', ['fantasy_scifi'], [], 3).bonus;
check('tier 0 ≤ tier 1 ≤ tier 2', t0 <= t1 && t1 <= t2, `t0=${t0} t1=${t1} t2=${t2}`);
check('tier 2 == tier 3 (multiplier 1.0 plateau)', approxEq(t2, t3), `t2=${t2} t3=${t3}`);

// ── 8. buildSignals: free-form genre labels resolve to AffinityKey set ───────
console.log('8. buildSignals genre resolution + dedup');
const sig = buildSignals({
  profile: makeProfile(2),
  prefsRow: {
    favorite_genres:  ['Fantasy', 'fantasy', 'Sci-Fi', 'Mystery'],
    avoid_genres:     ['Horror'],
    reading_styles:   ['fast_paced'],
    favorite_authors: 'Brandon Sanderson, Tana French, unknown',
    updated_at:       '2026-01-01T00:00:00Z',
  },
});
check('statedTaste class tag',
  sig.statedTaste.signalClass === 'stated_durable');
check('softAvoids class tag',
  sig.softAvoids.signalClass === 'soft_avoid');
check('revealedTaste class tag',
  sig.revealedTaste.signalClass === 'revealed_behavioral');
check('Fantasy + fantasy + Sci-Fi dedup → single fantasy_scifi key',
  sig.statedTaste.favoriteGenres.filter(k => k === 'fantasy_scifi').length === 1,
  `keys=${JSON.stringify(sig.statedTaste.favoriteGenres)}`);
check('Mystery resolves to thriller_mystery',
  sig.statedTaste.favoriteGenres.includes('thriller_mystery'),
  `keys=${JSON.stringify(sig.statedTaste.favoriteGenres)}`);
check('avoid Horror resolves to horror',
  sig.softAvoids.genres.includes('horror'));
check('authors parsed and "unknown" filtered out',
  sig.statedTaste.favoriteAuthors.length === 2
    && sig.statedTaste.favoriteAuthors.includes('Brandon Sanderson')
    && sig.statedTaste.favoriteAuthors.includes('Tana French'),
  `authors=${JSON.stringify(sig.statedTaste.favoriteAuthors)}`);
check('updated_at parsed to epoch ms',
  typeof sig.statedTaste.updatedAt === 'number' && sig.statedTaste.updatedAt! > 0);

// ── 9. RecRequest signal delta on adding a stated favorite ───────────────────
//
// Property: adding a favorite genre to the prefs row produces a strictly
// larger statedTaste.favoriteGenres set than the same row without it.
// This is the explicit_preference_edit responsiveness contract.
console.log('9. RecRequest signal delta on favorite add');
const before = buildSignals({
  profile: makeProfile(2),
  prefsRow: { favorite_genres: ['Fantasy'], avoid_genres: [], reading_styles: [], favorite_authors: null, updated_at: null },
});
const after = buildSignals({
  profile: makeProfile(2),
  prefsRow: { favorite_genres: ['Fantasy', 'History'], avoid_genres: [], reading_styles: [], favorite_authors: null, updated_at: null },
});
check('after > before in favoriteGenres count',
  after.statedTaste.favoriteGenres.length > before.statedTaste.favoriteGenres.length,
  `before=${before.statedTaste.favoriteGenres.length} after=${after.statedTaste.favoriteGenres.length}`);
check('History resolves to nonfiction affinity key',
  after.statedTaste.favoriteGenres.includes('nonfiction'),
  `after=${JSON.stringify(after.statedTaste.favoriteGenres)}`);

// ── 10. Empty prefs → empty signals (no crash) ───────────────────────────────
console.log('10. Empty / null prefs row');
const empty = buildSignals({ profile: makeProfile(0), prefsRow: null });
check('null prefsRow yields empty stated/avoid arrays',
  empty.statedTaste.favoriteGenres.length === 0 && empty.softAvoids.genres.length === 0);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('✓ All RecRequest / signal / policy checks passed.');
  process.exit(0);
} else {
  console.error(`✗ ${failures} check(s) failed.`);
  process.exit(1);
}
