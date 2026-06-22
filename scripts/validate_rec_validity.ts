/**
 * P0B deck-validity validator.
 *
 * Pure-function, deterministic checks against lib/recValidity.ts:
 *   1. computeRecConfigHash is order-insensitive, case-insensitive, and
 *      whitespace-tolerant for list inputs.
 *   2. Different pref combinations produce different hashes (no silent
 *      collisions across the four scoped fields).
 *   3. assertCurrent rejects null/undefined/empty stored hashes.
 *   4. assertCurrent rejects mismatched hashes.
 *   5. assertCurrent accepts byte-equal hashes.
 *
 * The store-side integration (recPayloadCache, recSession, recQueue) cannot
 * be exercised under `npx tsx` because both touch React Native AsyncStorage
 * via `@react-native-async-storage/async-storage`. The store-level checks
 * are therefore covered by reading lib/recValidity.ts's `assertCurrent`
 * helper directly here — every store delegates to that helper, so a green
 * helper test plus inspection of the (small) per-store call sites in
 * components/RecommendationsFeed.tsx is the smallest sound validation
 * available in this repo (matches the scripts/validate_taxonomy.ts pattern
 * already used for P0A / P0A.1).
 *
 * Run:  npx tsx scripts/validate_rec_validity.ts
 * Exit: 0 on success, 1 on any failure.
 */

import {
  computeRecConfigHash,
  assertCurrent,
  type RecConfigInputs,
} from '../lib/recValidity';

type Failure = { check: string; detail: string };
const failures: Failure[] = [];

function expect(name: string, cond: boolean, detail: string): void {
  if (!cond) failures.push({ check: name, detail });
}

// ── 1: hash determinism + order-insensitivity ──────────────────────────────
const a: RecConfigInputs = {
  favorite_genres:  ['Fantasy', 'Sci-Fi'],
  avoid_genres:     ['Romance'],
  reading_styles:   ['Fast-paced', 'Dark themes'],
  favorite_authors: 'Ursula K. Le Guin, N.K. Jemisin',
};
const aReordered: RecConfigInputs = {
  favorite_genres:  ['Sci-Fi', 'Fantasy'],
  avoid_genres:     ['Romance'],
  reading_styles:   ['Dark themes', 'Fast-paced'],
  favorite_authors: 'N.K. Jemisin, Ursula K. Le Guin',
};
expect(
  'hash order-insensitive',
  computeRecConfigHash(a) === computeRecConfigHash(aReordered),
  `a=${computeRecConfigHash(a)} reordered=${computeRecConfigHash(aReordered)}`,
);

// ── 2: case + whitespace tolerance ──────────────────────────────────────────
const aMessy: RecConfigInputs = {
  favorite_genres:  ['  fantasy ', 'SCI-FI'],
  avoid_genres:     ['romance'],
  reading_styles:   ['fast-paced', '  Dark Themes'],
  favorite_authors: '  ursula k. le guin ,N.K. JEMISIN  ',
};
expect(
  'hash case+whitespace tolerant',
  computeRecConfigHash(a) === computeRecConfigHash(aMessy),
  `clean=${computeRecConfigHash(a)} messy=${computeRecConfigHash(aMessy)}`,
);

// ── 3: each scoped field independently affects the hash ─────────────────────
const base: RecConfigInputs = {
  favorite_genres:  [],
  avoid_genres:     [],
  reading_styles:   [],
  favorite_authors: null,
};
const baseHash = computeRecConfigHash(base);

const variants: Array<[string, RecConfigInputs]> = [
  ['favorite_genres',  { ...base, favorite_genres:  ['Mystery'] }],
  ['avoid_genres',     { ...base, avoid_genres:     ['Mystery'] }],
  ['reading_styles',   { ...base, reading_styles:   ['Slow-burn'] }],
  ['favorite_authors', { ...base, favorite_authors: 'Patricia Highsmith' }],
];
const seen = new Set<string>([baseHash]);
for (const [field, inputs] of variants) {
  const h = computeRecConfigHash(inputs);
  expect(
    `field "${field}" changes hash from baseline`,
    h !== baseHash,
    `base=${baseHash} variant=${h}`,
  );
  expect(
    `field "${field}" hash is unique across variants`,
    !seen.has(h),
    `collision: variant=${h}`,
  );
  seen.add(h);
}

// ── 4: empty inputs are stable + idempotent ─────────────────────────────────
const emptyAlt: RecConfigInputs = {
  favorite_genres:  ['', '   '],
  avoid_genres:     [],
  reading_styles:   [''],
  favorite_authors: '   ,, ',
};
expect(
  'empty/whitespace-only inputs collapse to baseline hash',
  computeRecConfigHash(emptyAlt) === baseHash,
  `empty_alt=${computeRecConfigHash(emptyAlt)} base=${baseHash}`,
);

// ── 5: assertCurrent semantics ──────────────────────────────────────────────
const h1 = computeRecConfigHash(a);
const h2 = computeRecConfigHash({ ...a, favorite_genres: [...a.favorite_genres, 'Horror'] });

expect(
  'assertCurrent: match → valid',
  assertCurrent(h1, h1).valid === true,
  `got ${JSON.stringify(assertCurrent(h1, h1))}`,
);
expect(
  'assertCurrent: mismatch → invalid (config_mismatch)',
  (() => {
    const r = assertCurrent(h1, h2);
    return r.valid === false && r.reason === 'config_mismatch';
  })(),
  `got ${JSON.stringify(assertCurrent(h1, h2))}`,
);
expect(
  'assertCurrent: null stored → invalid (no_stored_hash)',
  (() => {
    const r = assertCurrent(null, h1);
    return r.valid === false && r.reason === 'no_stored_hash';
  })(),
  `got ${JSON.stringify(assertCurrent(null, h1))}`,
);
expect(
  'assertCurrent: undefined stored → invalid (no_stored_hash)',
  (() => {
    const r = assertCurrent(undefined, h1);
    return r.valid === false && r.reason === 'no_stored_hash';
  })(),
  `got ${JSON.stringify(assertCurrent(undefined, h1))}`,
);
expect(
  'assertCurrent: empty-string stored → invalid (no_stored_hash)',
  (() => {
    const r = assertCurrent('', h1);
    return r.valid === false && r.reason === 'no_stored_hash';
  })(),
  `got ${JSON.stringify(assertCurrent('', h1))}`,
);

// ── 6: prior bug class — "after pref edit, stored hash differs" ─────────────
// Models the prior failure mode at the helper level: a deck stamped under
// preference snapshot A is invalidated when the user's current snapshot is B.
const prefsBeforeSave: RecConfigInputs = {
  favorite_genres:  ['Fantasy'],
  avoid_genres:     [],
  reading_styles:   [],
  favorite_authors: null,
};
const prefsAfterSave: RecConfigInputs = {
  ...prefsBeforeSave,
  avoid_genres: ['Romance'],
};
const stamped = computeRecConfigHash(prefsBeforeSave);
const current = computeRecConfigHash(prefsAfterSave);
const checkAfterSave = assertCurrent(stamped, current);
expect(
  'prior bug class: avoid-genre add invalidates stamped deck',
  checkAfterSave.valid === false && checkAfterSave.reason === 'config_mismatch',
  `got ${JSON.stringify(checkAfterSave)}`,
);

// ── 7: P0B.1 persisted-payload restore gate ────────────────────────────────
// Models the loadRecPayload() opt-in gate at the helper level. The cache
// delegates to assertCurrent(stored, current); we exercise the same three
// outcomes the restore caller in app/(tabs)/_layout.tsx now relies on:
//   (a) stored hash matches current → payload accepted
//   (b) stored hash differs from current → payload rejected
//   (c) no stored hash (legacy/pre-P0B.1 prewarm write) → payload rejected
const restoreA: RecConfigInputs = {
  favorite_genres:  ['Fantasy'],
  avoid_genres:     [],
  reading_styles:   [],
  favorite_authors: null,
};
const restoreB: RecConfigInputs = {
  ...restoreA,
  avoid_genres: ['Romance'],
};
const restoreHashA = computeRecConfigHash(restoreA);
const restoreHashB = computeRecConfigHash(restoreB);

expect(
  'persisted restore: hash A stored, hash A current → accept',
  assertCurrent(restoreHashA, restoreHashA).valid === true,
  `got ${JSON.stringify(assertCurrent(restoreHashA, restoreHashA))}`,
);
expect(
  'persisted restore: hash A stored, hash B current → reject (config_mismatch)',
  (() => {
    const r = assertCurrent(restoreHashA, restoreHashB);
    return r.valid === false && r.reason === 'config_mismatch';
  })(),
  `got ${JSON.stringify(assertCurrent(restoreHashA, restoreHashB))}`,
);
expect(
  'persisted restore: legacy hashless payload, any current → reject (no_stored_hash)',
  (() => {
    const r = assertCurrent(undefined, restoreHashA);
    return r.valid === false && r.reason === 'no_stored_hash';
  })(),
  `got ${JSON.stringify(assertCurrent(undefined, restoreHashA))}`,
);

// ── 8: rawTier fix — VERSION = rcv9 + retrieval-policy-version csrp3 ───────
// rcv9 / csrp3 (2026-06-22): recRequest.ts now passes profile.rawTier
// (unboosted) instead of profile.tier (boosted) to confidenceModeForTier.
// Fresh intake-only users (rawTier=0, intakeBoosted=true) now correctly
// classify as sparse_onboarding (quota=3) instead of thin (quota=0).
// No quota values changed; only the input to the mode projection is fixed.
// Any deck persisted under rcv8|csrp:csrp2 used the wrong mode for intake
// users and must be discarded and rebuilt.
//
// We assert via source-grep (the VERSION constant is module-private) plus a
// behavioral check: the live hash MUST begin with `rcv9|` and have `csrp:csrp3`
// as the second segment. All prior hash shapes must reject under assertCurrent.
import * as fsRcv from 'fs';
import * as pathRcv from 'path';
{
  const recValiditySrc = fsRcv.readFileSync(
    pathRcv.resolve(__dirname, '../lib/recValidity.ts'), 'utf-8');
  expect('§8 VERSION constant pins rcv9',
    /const\s+VERSION\s*=\s*['"]rcv9['"]/.test(recValiditySrc),
    'expected `const VERSION = "rcv9"` in lib/recValidity.ts');
  expect('§8 hash includes csrp:${COLD_START_RETRIEVAL_POLICY_VERSION} segment',
    /csrp:\$\{COLD_START_RETRIEVAL_POLICY_VERSION\}/.test(recValiditySrc),
    'computeRecConfigHash must fold retrieval-policy-version into hash');
  expect('§8 lib/recValidity.ts imports COLD_START_RETRIEVAL_POLICY_VERSION from recPolicy',
    /import\s*\{[^}]*COLD_START_RETRIEVAL_POLICY_VERSION[^}]*\}\s*from\s*['"]\.\/recPolicy['"]/.test(recValiditySrc),
    'expected named import of COLD_START_RETRIEVAL_POLICY_VERSION');

  // Behavioral: live hash shape.
  const live = computeRecConfigHash(a);
  expect('§8 live hash begins with "rcv9|"',
    live.startsWith('rcv9|'),
    `got prefix=${live.split('|').slice(0, 1).join('|')}`);
  expect('§8 live hash second segment is "csrp:csrp3"',
    live.split('|')[1] === 'csrp:csrp3',
    `got second segment=${live.split('|')[1]}`);

  // Cache-invalidation contract: every prior shape must reject.
  //   - rcv8|csrp:csrp2|… (Phase B.0 decks — wrong mode for intake users)
  //   - rcv8|csrp:csrp1|… (theoretical mid-flight shape)
  //   - rcv7|csrp:csrp1|… (Phase B decks)
  //   - rcv7|csrp:csrp2|… (theoretical mid-flight shape)
  //   - rcv6|fg:…         (Phase A, no csrp segment)
  //   - rcv6|csrp:csrp1|… (defense)
  const fakeRcv8Csrp2 = 'rcv8|csrp:csrp2|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const r0 = assertCurrent(fakeRcv8Csrp2, live);
  expect('§8 rcv8|csrp:csrp2 stored hash rejects under rcv9|csrp:csrp3 live',
    r0.valid === false && r0.reason === 'config_mismatch',
    `got ${JSON.stringify(r0)}`);

  const fakeRcv8Csrp1 = 'rcv8|csrp:csrp1|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const r1 = assertCurrent(fakeRcv8Csrp1, live);
  expect('§8 rcv8|csrp:csrp1 stored hash rejects under rcv9|csrp:csrp3 live',
    r1.valid === false && r1.reason === 'config_mismatch',
    `got ${JSON.stringify(r1)}`);

  const fakeRcv7Csrp1 = 'rcv7|csrp:csrp1|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const r2 = assertCurrent(fakeRcv7Csrp1, live);
  expect('§8 rcv7|csrp:csrp1 stored hash rejects under rcv9|csrp:csrp3 live',
    r2.valid === false && r2.reason === 'config_mismatch',
    `got ${JSON.stringify(r2)}`);

  const fakeRcv7Csrp2 = 'rcv7|csrp:csrp2|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const r3 = assertCurrent(fakeRcv7Csrp2, live);
  expect('§8 rcv7|csrp:csrp2 stored hash rejects under rcv9|csrp:csrp3 live',
    r3.valid === false && r3.reason === 'config_mismatch',
    `got ${JSON.stringify(r3)}`);

  const fakeRcv6Stored = 'rcv6|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const r4 = assertCurrent(fakeRcv6Stored, live);
  expect('§8 rcv6 stored hash rejects under rcv9 live (config_mismatch)',
    r4.valid === false && r4.reason === 'config_mismatch',
    `got ${JSON.stringify(r4)}`);

  const fakeRcv6WithCsrp = 'rcv6|csrp:csrp1|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const r5 = assertCurrent(fakeRcv6WithCsrp, live);
  expect('§8 rcv6+csrp shape rejects under rcv9 live (config_mismatch)',
    r5.valid === false && r5.reason === 'config_mismatch',
    `got ${JSON.stringify(r5)}`);
}

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`[recValidity] FAIL — ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f.check}\n      ${f.detail}`);
  process.exit(1);
}

console.log(
  `[recValidity] OK — hash determinism, case/whitespace/order tolerance, ` +
  `field-uniqueness, assertCurrent semantics, prior-bug-class invalidation, ` +
  `and P0B.1 persisted-payload restore gate all green.`,
);
