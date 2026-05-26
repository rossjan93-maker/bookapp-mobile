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

// ── 8: Phase B — VERSION = rcv7 + retrieval-policy-version folded in ───────
// Cold-Start Retrieval Expansion · Phase B (2026-05-21) bumps the recValidity
// VERSION from rcv6 to rcv7 (cold_start.coldStartAdjacent flips 0 → 3, first
// live admission of adjacency candidates). It also folds an explicit
// COLD_START_RETRIEVAL_POLICY_VERSION constant ('csrp1') into the hash via a
// `csrp:` segment, so any future cold-start policy change can invalidate
// caches without a VERSION bump.
//
// We assert via source-grep (the VERSION constant is module-private) plus a
// behavioral check: the live hash MUST contain both `rcv7|` as a prefix and
// `csrp:csrp1|` as the next segment. Any pre-rcv7 stored hash (e.g.
// `rcv6|csrp:csrp1|fg:…`, `rcv6|fg:…`, `rcv5|fg:…`) MUST reject under
// assertCurrent against a live hash, so persisted cold-start decks built
// pre-Phase-B are discarded on first foreground after deploy.
import * as fsRcv from 'fs';
import * as pathRcv from 'path';
{
  const recValiditySrc = fsRcv.readFileSync(
    pathRcv.resolve(__dirname, '../lib/recValidity.ts'), 'utf-8');
  expect('§8 VERSION constant pins rcv7',
    /const\s+VERSION\s*=\s*['"]rcv7['"]/.test(recValiditySrc),
    'expected `const VERSION = "rcv7"` in lib/recValidity.ts');
  expect('§8 hash includes csrp:${COLD_START_RETRIEVAL_POLICY_VERSION} segment',
    /csrp:\$\{COLD_START_RETRIEVAL_POLICY_VERSION\}/.test(recValiditySrc),
    'computeRecConfigHash must fold retrieval-policy-version into hash');
  expect('§8 lib/recValidity.ts imports COLD_START_RETRIEVAL_POLICY_VERSION from recPolicy',
    /import\s*\{[^}]*COLD_START_RETRIEVAL_POLICY_VERSION[^}]*\}\s*from\s*['"]\.\/recPolicy['"]/.test(recValiditySrc),
    'expected named import of COLD_START_RETRIEVAL_POLICY_VERSION');

  // Behavioral: live hash shape.
  const live = computeRecConfigHash(a);
  expect('§8 live hash begins with "rcv7|"',
    live.startsWith('rcv7|'),
    `got prefix=${live.split('|').slice(0,1).join('|')}`);
  expect('§8 live hash second segment is "csrp:csrp1"',
    live.split('|')[1] === 'csrp:csrp1',
    `got second segment=${live.split('|')[1]}`);

  // rcv6 -> rcv7 transition: simulated rcv6 payload hash MUST reject.
  // Build a "stored" hash that mimics what rcv6 would have produced for
  // the same logical inputs (rcv6 had no csrp segment).
  const fakeRcv6Stored = 'rcv6|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const rcv6Reject = assertCurrent(fakeRcv6Stored, live);
  expect('§8 simulated rcv6 stored hash rejects under rcv7 live (config_mismatch)',
    rcv6Reject.valid === false && rcv6Reject.reason === 'config_mismatch',
    `got ${JSON.stringify(rcv6Reject)}`);

  // A pre-existing rcv6+csrp shape (defense: even if a parallel branch had
  // shipped csrp without bumping VERSION, the rcv7 bump still invalidates).
  const fakeRcv6WithCsrp = 'rcv6|csrp:csrp1|fg:fantasy,sci-fi|ag:romance|rs:dark themes,fast-paced|fa:n.k. jemisin,ursula k. le guin';
  const rcv6CsrpReject = assertCurrent(fakeRcv6WithCsrp, live);
  expect('§8 rcv6+csrp shape rejects under rcv7 live (config_mismatch)',
    rcv6CsrpReject.valid === false && rcv6CsrpReject.reason === 'config_mismatch',
    `got ${JSON.stringify(rcv6CsrpReject)}`);

  // Future Phase B.1 simulation: bumping csrp also invalidates without a
  // VERSION bump (pin the belt-and-suspenders contract).
  const fakeRcv7CsrpNext = live.replace('csrp:csrp1', 'csrp:csrp2');
  const csrpReject = assertCurrent(fakeRcv7CsrpNext, live);
  expect('§8 rcv7+csrp:csrp2 simulated stored rejects under rcv7+csrp:csrp1 live',
    csrpReject.valid === false && csrpReject.reason === 'config_mismatch',
    `got ${JSON.stringify(csrpReject)}`);
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
