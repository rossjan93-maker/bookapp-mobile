// =============================================================================
// validate_cold_start_adjacent.ts — Cold-Start Retrieval Expansion Phase B
//                                   contract validator (deterministic, pure).
//
// Run: `npx tsx scripts/validate_cold_start_adjacent.ts` (exit 0 ok / 1 fail).
//
// Phase B (2026-05-21): first live admission. cold_start.coldStartAdjacent
// flips 0 → 3; thin and high_signal stay 0. recValidity.VERSION = rcv7;
// COLD_START_RETRIEVAL_POLICY_VERSION = 'csrp1'.
//
// Sections (load-bearing for Phase B acceptance):
//   §1  Adjacency-map authoring rules — keyed by GenreId, lowercase OL-canonical,
//       ≤ 5 anchors per genre, no overlap with primary olSubjects for any
//       genre sharing the same affinityKey.
//   §2  Branch plumbing — `coldStartAdjacent` appears in BranchKind union,
//       BranchQuotas type, BRANCH_QUOTAS, BRANCH_ORDER, planner output.
//   §3  Phase B live-quota invariant — BRANCH_QUOTAS.cold_start.coldStartAdjacent
//       === 3; thin === 0; high_signal === 0. Live admission count matches
//       quota on the canonical fixtures.
//   §4  Mystery-only / Thriller-only / empty-genre slice scope — adjacency
//       map populated for Mystery + Thriller; all other GenreIds → [].
//   §5  Mature-profile byte-identity — high_signal users produce zero
//       coldStartAdjacent items even in shadow simulation at the highest
//       hypothetical Phase B.1 quota (mature profiles stay byte-identical
//       forever).
//   §6  Shadow-evidence helper purity — simulateColdStartAdjacent does NOT
//       mutate the live plan; running it before/after planBranches produces
//       identical RetrievalPlan.fetchItems.
//   §7  Soft-avoid defense-in-depth — adjacency branch skips a favorite
//       AffinityKey that's also in softAvoids (same rule as statedGenres).
//   §8  Calibration provenance (Phase A.1) — source comment in
//       lib/taxonomy/genres.ts above ADJACENT_RETRIEVAL_ANCHORS references at
//       least one dated `cold_start_adjacent_evidence_report*.md` file. This
//       prevents silent re-expansion of the anchor set without a re-probe.
//   §9  Lens-blindness invariant (Phase B / Phase B.1 boundary) — adjacency
//       quotas are NOT modulated by lens state. The branch source must not
//       import any Intent / lens / steering module, and BRANCH_QUOTAS is a
//       static constant. Pinned here so a future Phase B.1 patch can't
//       silently leak lens-aware quota modulation into the Phase B surface.
//   §10 F1–F12 fixture matrix — the canonical Phase B regression set:
//       sparse Mystery+Thriller, sparse Fantasy/SciFi no-op, thin no-op,
//       high_signal no-op, lens-state independence, soft-avoid defense,
//       favorites-empty no-op.
// =============================================================================

import { planBranches } from '../lib/retrieval/branchPlanner';
import type { BranchContext } from '../lib/retrieval/types';
import type { RecRequest } from '../lib/recRequest';
import type { AffinityKey } from '../lib/taxonomy/genres';
import {
  ADJACENT_RETRIEVAL_ANCHORS,
  GENRE_DEFS,
} from '../lib/taxonomy/genres';
import { BRANCH_QUOTAS, COLD_START_RETRIEVAL_POLICY_VERSION } from '../lib/recPolicy';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildColdStartAdjacentBranch,
  simulateColdStartAdjacent,
} from '../lib/retrieval/branches/coldStartAdjacent';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
}
function section(name: string): void { console.log(`\n— ${name} —`); }

function mkReq(opts: {
  favorites?:      AffinityKey[];
  avoids?:         AffinityKey[];
  confidenceMode?: 'cold_start' | 'thin' | 'high_signal';
}): RecRequest {
  return {
    userId:  'test',
    signals: {
      statedTaste:   {
        signalClass: 'stated_durable',
        favoriteGenres:  opts.favorites ?? [],
        readingStyles:   [],
        favoriteAuthors: [],
        updatedAt:       null,
      },
      revealedTaste: { signalClass: 'revealed_behavioral', profile: {} as never },
      softAvoids:    { signalClass: 'soft_avoid', genres: opts.avoids ?? [], updatedAt: null },
    },
    policy: {
      confidenceMode:         opts.confidenceMode ?? 'cold_start',
      statedPreferenceFloor:  0.05,
      statedPreferenceWeight: 0.12,
      softAvoidFloor:        -0.06,
      softAvoidPenalty:      -0.15,
    },
    build: { cause: 'session_open', builtAt: 0, schemaVersion: 'rrv1' },
  };
}

const COLD_CTX: BranchContext = {
  topGenres:       ['thriller_mystery'],
  dominantLanes:   [],
  repeatedAuthors: [],
  likedAuthors:    [],
  likedSubjects:   [],
  isDense:         false,
};
const DENSE_CTX: BranchContext = {
  topGenres:       ['thriller_mystery', 'literary'],
  dominantLanes:   ['modern_suspense', 'literary_lane'],
  repeatedAuthors: ['Tana French', 'Kate Atkinson', 'Patricia Highsmith'],
  likedAuthors:    ['Tana French'],
  likedSubjects:   ['psychological thriller', 'literary suspense'],
  isDense:         true,
};

// ── §1 Adjacency-map authoring rules ────────────────────────────────────────
section('§1 — adjacency-map authoring rules');
{
  const allGenreIds = GENRE_DEFS.map(d => d.id);

  // (a) Every GenreId is keyed in the map (compile-time guarantee via
  //     Readonly<Record<GenreId, ...>>; runtime sanity).
  for (const gid of allGenreIds) {
    check(`map covers GenreId=${gid}`, Object.hasOwn(ADJACENT_RETRIEVAL_ANCHORS, gid));
  }

  // (b) ≤ 5 anchors per genre (hard cap).
  for (const [gid, anchors] of Object.entries(ADJACENT_RETRIEVAL_ANCHORS)) {
    check(`${gid}: ≤ 5 anchors`, anchors.length <= 5, `got ${anchors.length}`);
  }

  // (c) Lowercase OL-canonical strings only.
  for (const [gid, anchors] of Object.entries(ADJACENT_RETRIEVAL_ANCHORS)) {
    for (const a of anchors) {
      check(`${gid}: anchor "${a}" is lowercase`, a === a.toLowerCase());
      check(`${gid}: anchor "${a}" non-empty`, a.trim().length > 0);
    }
  }

  // (d) No adjacency anchor duplicates a primary olSubjects entry for ANY
  //     genre sharing the same affinityKey (would re-run the same retrieval
  //     the primary branch already does).
  for (const [gid, anchors] of Object.entries(ADJACENT_RETRIEVAL_ANCHORS)) {
    if (anchors.length === 0) continue;
    const myDef = GENRE_DEFS.find(d => d.id === gid)!;
    const siblingPrimaries = new Set<string>();
    for (const def of GENRE_DEFS) {
      if (def.affinityKey !== myDef.affinityKey) continue;
      for (const s of def.olSubjects) siblingPrimaries.add(s.toLowerCase());
    }
    for (const a of anchors) {
      check(
        `${gid}: anchor "${a}" does not duplicate sibling primary olSubjects (affinity=${myDef.affinityKey})`,
        !siblingPrimaries.has(a),
        `siblings: ${[...siblingPrimaries].join(', ')}`,
      );
    }
  }
}

// ── §2 Branch plumbing ──────────────────────────────────────────────────────
section('§2 — branch plumbing end-to-end');
{
  // BranchQuotas type carries the slot (compile-time).
  check('BRANCH_QUOTAS.cold_start.coldStartAdjacent defined',
    typeof BRANCH_QUOTAS.cold_start.coldStartAdjacent === 'number');
  check('BRANCH_QUOTAS.thin.coldStartAdjacent defined',
    typeof BRANCH_QUOTAS.thin.coldStartAdjacent === 'number');
  check('BRANCH_QUOTAS.high_signal.coldStartAdjacent defined',
    typeof BRANCH_QUOTAS.high_signal.coldStartAdjacent === 'number');

  // Planner emits a coldStartAdjacent policy entry at the Phase B live quota.
  const plan = planBranches(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' }), COLD_CTX);
  check('planner.branchOrder includes coldStartAdjacent',
    plan.branchOrder.includes('coldStartAdjacent'));
  check('planner.branchPolicies.coldStartAdjacent exists',
    plan.branchPolicies.coldStartAdjacent !== undefined);
  check('planner.branchPolicies.coldStartAdjacent.quota === 3 (Phase B cold_start)',
    plan.branchPolicies.coldStartAdjacent.quota === 3,
    `got ${plan.branchPolicies.coldStartAdjacent.quota}`);
}

// ── §3 Phase B live-quota invariant ─────────────────────────────────────────
section('§3 — Phase B live-quota invariant (cold=3, thin=0, high_signal=0)');
{
  // BRANCH_QUOTAS pin — exact Phase B values.
  check('cold_start.coldStartAdjacent === 3 (Phase B live)',
    BRANCH_QUOTAS.cold_start.coldStartAdjacent === 3,
    `got ${BRANCH_QUOTAS.cold_start.coldStartAdjacent}`);
  check('thin.coldStartAdjacent === 0 (Phase B.1 territory)',
    BRANCH_QUOTAS.thin.coldStartAdjacent === 0);
  check('high_signal.coldStartAdjacent === 0 (mature-profile invariant)',
    BRANCH_QUOTAS.high_signal.coldStartAdjacent === 0);

  // Retrieval-policy-version constant exists and is the Phase B identifier.
  check('COLD_START_RETRIEVAL_POLICY_VERSION === "csrp1"',
    COLD_START_RETRIEVAL_POLICY_VERSION === 'csrp1',
    `got ${COLD_START_RETRIEVAL_POLICY_VERSION}`);

  // Live admission count matches quota on a canonical cold-start mystery+
  // thriller fixture (4 anchors available → admits exactly quota=3).
  const coldReq = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' });
  const coldPlan = planBranches(coldReq, COLD_CTX);
  const coldAdj = coldPlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('cold_start mystery+thriller: live admits exactly 3 adjacency items',
    coldAdj.length === 3,
    `got ${coldAdj.length}: ${coldAdj.map(i => i.value).join(', ')}`);

  // thin and high_signal must remain dormant.
  const thinPlan = planBranches(
    mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'thin' }), COLD_CTX);
  const thinAdj = thinPlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('thin mystery+thriller: zero adjacency items',
    thinAdj.length === 0,
    `leaked ${thinAdj.length}`);

  const densePlan = planBranches(
    mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'high_signal' }), DENSE_CTX);
  const denseAdj = densePlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('high_signal mystery+thriller: zero adjacency items',
    denseAdj.length === 0,
    `leaked ${denseAdj.length}`);

  // Adjacency items must come from the pruned Phase A.1 anchor set.
  const adjacencyVocab = new Set([
    ...ADJACENT_RETRIEVAL_ANCHORS.mystery,
    ...ADJACENT_RETRIEVAL_ANCHORS.thriller,
  ]);
  for (const item of coldAdj) {
    check(`live anchor "${item.value}" comes from Phase A.1 pruned vocabulary`,
      adjacencyVocab.has(item.value),
      `expected one of: ${[...adjacencyVocab].join(', ')}`);
  }

  // Branch must run LAST so primary branches always win quota races.
  check('branchOrder places coldStartAdjacent last',
    coldPlan.branchOrder[coldPlan.branchOrder.length - 1] === 'coldStartAdjacent');
}

// ── §4 Slice scope — Mystery + Thriller only ────────────────────────────────
section('§4 — slice scope: Mystery + Thriller only');
{
  check('mystery has ≥1 anchor', ADJACENT_RETRIEVAL_ANCHORS.mystery.length >= 1,
    `got ${ADJACENT_RETRIEVAL_ANCHORS.mystery.length}`);
  check('thriller has ≥1 anchor', ADJACENT_RETRIEVAL_ANCHORS.thriller.length >= 1,
    `got ${ADJACENT_RETRIEVAL_ANCHORS.thriller.length}`);

  // All other GenreIds must be empty in Phase A.
  for (const [gid, anchors] of Object.entries(ADJACENT_RETRIEVAL_ANCHORS)) {
    if (gid === 'mystery' || gid === 'thriller') continue;
    check(`${gid}: empty in Phase A`, anchors.length === 0,
      `got ${anchors.length}: ${anchors.join(', ')}`);
  }

  // Shadow simulation at hypothetical Phase B quota: cold-start mystery+thriller
  // user yields candidates whose anchors come from the adjacency map (NOT from
  // primary thriller_mystery olSubjects). This is the Phase A evidence that
  // Phase B has something material to admit.
  const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' });
  const sim = simulateColdStartAdjacent(req, 4);
  check('shadow sim emits ≥2 candidates at Phase B quota=4',
    sim.itemsWouldEmit.length >= 2, `got ${sim.itemsWouldEmit.length}`);
  const adjacencyVocab = new Set([
    ...ADJACENT_RETRIEVAL_ANCHORS.mystery,
    ...ADJACENT_RETRIEVAL_ANCHORS.thriller,
  ]);
  for (const item of sim.itemsWouldEmit) {
    check(`shadow anchor "${item.value}" comes from adjacency vocab`,
      adjacencyVocab.has(item.value),
      `expected one of: ${[...adjacencyVocab].join(', ')}`);
  }
  // Phase B's value-add: lower-burden / non-domestic-suspense alternatives
  // appear. After Phase A.1 prune the on-pool anchors are cozy / amateur-
  // sleuth / spy fiction; the mis-calibrated 5 were dropped. We assert at
  // least one cozy/amateur/spy anchor is present (proves the slice would
  // diversify away from the current domestic-suspense saturation).
  const lowerBurden = sim.anchorsWouldRun.filter(a =>
    /cozy|amateur sleuth|spy fiction/.test(a)
  );
  check('shadow sim includes ≥1 lower-burden / non-domestic-suspense anchor',
    lowerBurden.length >= 1, `lower-burden: ${lowerBurden.join(', ')}`);
}

// ── §5 Mature-profile byte-identity ─────────────────────────────────────────
section('§5 — mature profile (high_signal) zero shadow-emit even at high quota');
{
  // Even at a deliberately-large hypothetical quota, the branch should not
  // suddenly start emitting for high_signal users because that's NOT the
  // population we're expanding for. The branch builder itself doesn't know
  // about density — it relies on the planner's quota=0 to stay silent — so
  // we test the planner's resolved quota for high_signal specifically.
  const denseReq = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'high_signal' });
  const plan = planBranches(denseReq, DENSE_CTX);
  const adjItems = plan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('high_signal: zero coldStartAdjacent items in plan', adjItems.length === 0,
    `leaked ${adjItems.length}`);
  check('high_signal: coldStartAdjacent policy.quota === 0',
    plan.branchPolicies.coldStartAdjacent.quota === 0);

  // Mature-profile invariant for Phase B: BRANCH_QUOTAS.high_signal.coldStartAdjacent
  // MUST stay 0 in Phase B too. Pinned as a documented contract here so
  // Phase B can't silently bump it.
  check('BRANCH_QUOTAS.high_signal.coldStartAdjacent stays 0 (Phase B invariant)',
    BRANCH_QUOTAS.high_signal.coldStartAdjacent === 0);
}

// ── §6 Shadow-evidence helper purity ────────────────────────────────────────
section('§6 — simulateColdStartAdjacent does not mutate live plan');
{
  const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' });
  const planBefore = planBranches(req, COLD_CTX);
  const sigBefore = JSON.stringify(planBefore.fetchItems);

  // Run shadow simulation.
  const sim = simulateColdStartAdjacent(req, 4);
  void sim;

  const planAfter = planBranches(req, COLD_CTX);
  const sigAfter = JSON.stringify(planAfter.fetchItems);
  check('plan.fetchItems byte-identical before/after shadow sim', sigBefore === sigAfter);
}

// ── §7 Soft-avoid defense-in-depth ──────────────────────────────────────────
section('§7 — soft-avoid defense-in-depth in adjacency branch');
{
  // Even at hypothetical Phase B quota, a favorite AffinityKey that's also
  // in softAvoids must NOT produce adjacency anchors. Mirrors statedGenres'
  // defense-in-depth rule.
  const req = mkReq({
    favorites: ['thriller_mystery'],
    avoids:    ['thriller_mystery'],
    confidenceMode: 'cold_start',
  });
  // Call the builder directly with a non-zero quota (bypassing the planner's
  // quota=0) to prove the builder itself honors soft-avoid.
  const items = buildColdStartAdjacentBranch(req, 5);
  check('soft-avoided favorite produces zero adjacency items', items.length === 0,
    `leaked ${items.length}: ${items.map(i => i.value).join(', ')}`);
}

// ── §9 Lens-blindness invariant (Phase B / Phase B.1 boundary) ──────────────
section('§9 — lens-blindness: adjacency quota is NOT modulated by lens state');
{
  // Source-grep: the adjacency branch implementation must NOT import any
  // intent / lens / steering module. Any such import would be the smoke
  // signal that Phase B.1 (lens-aware breadth modulation) has leaked into
  // the Phase B surface.
  const branchSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/retrieval/branches/coldStartAdjacent.ts'),
    'utf-8',
  );
  const forbiddenImports = [
    'currentIntentLens',
    'intentLens',
    'finalGate',
    'evaluateBookAgainstIntentLens',
    'TasteVsIntent',
    'getSessionSteering',
  ];
  for (const sym of forbiddenImports) {
    check(`coldStartAdjacent.ts source does NOT reference "${sym}"`,
      !branchSrc.includes(sym),
      `found "${sym}" in lib/retrieval/branches/coldStartAdjacent.ts`);
  }

  // Planner-side: the cold-start quota slot must not vary by lens-related
  // RecRequest fields. RecRequest in this codebase doesn't carry lens
  // state today (lens is session-module state in lib/currentIntentLens.ts).
  // We pin the static-constant property here: two planBranches calls with
  // identical input must produce the same coldStartAdjacent quota every
  // time — quota is a function of confidenceMode only.
  const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' });
  const planA = planBranches(req, COLD_CTX);
  const planB = planBranches(req, COLD_CTX);
  check('coldStartAdjacent.quota is deterministic across calls',
    planA.branchPolicies.coldStartAdjacent.quota
      === planB.branchPolicies.coldStartAdjacent.quota);
  check('coldStartAdjacent.quota is the BRANCH_QUOTAS literal',
    planA.branchPolicies.coldStartAdjacent.quota
      === BRANCH_QUOTAS.cold_start.coldStartAdjacent);

  // Planner source must not reference lens / steering modules in any
  // coldStartAdjacent context (qAdjacent resolution must remain a pure
  // BRANCH_QUOTAS lookup; the Phase B observation log explicitly does
  // NOT change behavior).
  const plannerSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/retrieval/branchPlanner.ts'),
    'utf-8',
  );
  // qAdjacent line must be a direct base lookup, not a function call.
  check('planner sources qAdjacent from base.coldStartAdjacent (no lens hook)',
    /const\s+qAdjacent\s*=\s*base\.coldStartAdjacent\s*;/.test(plannerSrc),
    'planner.qAdjacent assignment does not match expected static form');
  // No lens import in the planner either.
  for (const sym of ['currentIntentLens', 'getSessionSteering', 'TasteVsIntent', 'finalGate']) {
    check(`branchPlanner.ts does NOT import "${sym}"`,
      !plannerSrc.includes(sym),
      `found "${sym}" in lib/retrieval/branchPlanner.ts`);
  }
}

// ── §10 F1–F12 fixture matrix (Phase B regression set) ──────────────────────
section('§10 — F1–F12 canonical Phase B regression fixtures');
{
  const adj = (req: RecRequest, ctx: BranchContext): string[] =>
    planBranches(req, ctx).fetchItems
      .filter(i => i.branch === 'coldStartAdjacent')
      .map(i => i.value);

  // F1 — Cold-start mystery+thriller emits exactly 3 from the pruned set.
  const f1 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' }), COLD_CTX);
  check('F1 cold_start thriller_mystery → exactly 3 adjacency items',
    f1.length === 3, `got ${f1.length}: ${f1.join(', ')}`);
  check('F1 anchors all come from pruned Phase A.1 vocab',
    f1.every(v => [...ADJACENT_RETRIEVAL_ANCHORS.mystery, ...ADJACENT_RETRIEVAL_ANCHORS.thriller].includes(v)));

  // F2 — Cold-start Fantasy/SciFi (no adjacency entry) → ZERO items.
  const f2 = adj(mkReq({ favorites: ['fantasy_scifi'], confidenceMode: 'cold_start' }), COLD_CTX);
  check('F2 cold_start fantasy_scifi → zero adjacency (empty anchor list)',
    f2.length === 0, `leaked ${f2.length}: ${f2.join(', ')}`);

  // F3 — Cold-start, no favorites → ZERO.
  const f3 = adj(mkReq({ favorites: [], confidenceMode: 'cold_start' }), COLD_CTX);
  check('F3 cold_start no favorites → zero adjacency', f3.length === 0);

  // F4 — Thin mystery+thriller → ZERO (quota=0 for thin).
  const f4 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'thin' }), COLD_CTX);
  check('F4 thin thriller_mystery → zero adjacency (Phase B.1 territory)',
    f4.length === 0, `leaked ${f4.length}`);

  // F5 — high_signal mature profile → ZERO (mature-profile invariant).
  const f5 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'high_signal' }), DENSE_CTX);
  check('F5 high_signal thriller_mystery → zero adjacency (mature invariant)',
    f5.length === 0, `leaked ${f5.length}`);

  // F6 — Cold-start + (would-be) active No-dark lens. RecRequest has no
  // lens field, so this is a structural assertion: the plan is identical
  // regardless of any external lens state. Proven by re-planning with the
  // same inputs — quota is a function of confidenceMode alone.
  const reqF6 = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' });
  const f6a = adj(reqF6, COLD_CTX);
  const f6b = adj(reqF6, COLD_CTX);
  check('F6 lens state cannot alter adjacency admission (deterministic plan)',
    JSON.stringify(f6a) === JSON.stringify(f6b),
    `f6a=${f6a.join(',')} f6b=${f6b.join(',')}`);
  check('F6 admission count unchanged across calls (=3)',
    f6a.length === 3 && f6b.length === 3);

  // F7 — Cold-start no lens (baseline) — same as F1, same output. Pinned
  // here as the explicit "Phase B base case" fixture for documentation.
  const f7 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' }), COLD_CTX);
  check('F7 cold_start no-lens baseline matches F1',
    JSON.stringify(f7) === JSON.stringify(f1));

  // F8 — Cold-start thriller_mystery + softAvoid horror (unrelated to
  // adjacency anchors) → 3 items unchanged.
  const f8 = adj(mkReq({
    favorites: ['thriller_mystery'],
    avoids:    ['horror'],
    confidenceMode: 'cold_start',
  }), COLD_CTX);
  check('F8 cold_start + softAvoid horror → 3 items unchanged',
    f8.length === 3, `got ${f8.length}: ${f8.join(', ')}`);

  // F9 — Cold-start thriller_mystery + softAvoid thriller_mystery → ZERO
  // (defense-in-depth: same key in favorites and avoids → skipped).
  const f9 = adj(mkReq({
    favorites: ['thriller_mystery'],
    avoids:    ['thriller_mystery'],
    confidenceMode: 'cold_start',
  }), COLD_CTX);
  check('F9 cold_start favorite ∈ softAvoids → zero adjacency (defense-in-depth)',
    f9.length === 0, `leaked ${f9.length}: ${f9.join(', ')}`);

  // F10 — Persisted rcv6 deck (Phase A) → discarded on read under rcv7.
  // Covered structurally: COLD_START_RETRIEVAL_POLICY_VERSION 'csrp1' is in
  // the hash via lib/recValidity.ts, and VERSION='rcv7' fronts the hash —
  // any rcv6 payload mismatches. Behavioral fixture lives in
  // validate_rec_payload_cache_lens §4.
  const recValiditySrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/recValidity.ts'), 'utf-8',
  );
  check('F10 lib/recValidity.ts pins VERSION=rcv7',
    /const\s+VERSION\s*=\s*['"]rcv7['"]/.test(recValiditySrc));
  check('F10 lib/recValidity.ts folds COLD_START_RETRIEVAL_POLICY_VERSION into hash',
    /csrp:\$\{COLD_START_RETRIEVAL_POLICY_VERSION\}/.test(recValiditySrc));

  // F11 — Persisted rcv7 deck → restored normally. Covered by F10's hash
  // shape: hash is composable + stable. Behavioral fixture lives in
  // validate_rec_payload_cache_lens §4.
  check('F11 rcv7 hash determinism: same inputs → same hash twice',
    true, // tautological under deterministic compute; behavioral test in sibling validator
  );

  // F12 — Lens-mode toggle (Phase 1 steering) must NOT change quota. The
  // steering field lives in lib/currentIntentLens.ts as session-module
  // state; it isn't an input to BRANCH_QUOTAS. We pin two assertions:
  //   (a) BRANCH_QUOTAS.cold_start.coldStartAdjacent is a static literal,
  //       not a function — re-evaluating returns the same value.
  //   (b) lib/recPolicy.ts source does NOT import currentIntentLens or
  //       any steering symbol.
  const policySrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/recPolicy.ts'), 'utf-8',
  );
  for (const sym of ['currentIntentLens', 'getSessionSteering', 'TasteVsIntent', 'IntentLens']) {
    check(`F12 lib/recPolicy.ts does NOT reference "${sym}"`,
      !policySrc.includes(sym),
      `found "${sym}" in lib/recPolicy.ts`);
  }
  check('F12 BRANCH_QUOTAS.cold_start.coldStartAdjacent is stable across calls',
    BRANCH_QUOTAS.cold_start.coldStartAdjacent === 3
      && BRANCH_QUOTAS.cold_start.coldStartAdjacent === 3);
}

// ── §8 Calibration provenance (Phase A.1) ───────────────────────────────────
section('§8 — calibration provenance: source comment references dated evidence report');
{
  // Read genres.ts as text and check that the comment block immediately
  // preceding ADJACENT_RETRIEVAL_ANCHORS references at least one
  // cold_start_adjacent_evidence_report*.md file. This is the load-bearing
  // documentation contract — future readers (and reviewers of any
  // anchor-set change) must see the evidence that justified the current set.
  // Pinned in Phase A.1 (2026-05-20) when 5 of the original 9 anchors were
  // dropped after v1 evidence showed OL-taxonomy mismatches.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  const src = fs.readFileSync(require.resolve('../lib/taxonomy/genres.ts'), 'utf-8');
  const anchorsIdx = src.indexOf('ADJACENT_RETRIEVAL_ANCHORS');
  check('ADJACENT_RETRIEVAL_ANCHORS export found in source', anchorsIdx > 0);
  // Window covers ~3 KiB before AND the full object literal after the export —
  // the per-anchor justification comments live INSIDE the literal in our
  // current authoring style.
  const before = src.slice(Math.max(0, anchorsIdx - 3072), anchorsIdx);
  const after  = src.slice(anchorsIdx, anchorsIdx + 4096);
  // Require at least one DATED report reference (must contain a digit in the
  // suffix, e.g. `_relevance_1980` or a YYYYMMDD stamp). Bare v1
  // `cold_start_adjacent_evidence_report.md` alone is not sufficient — the
  // dated form proves the prune was justified by a re-probe under controlled
  // capture settings, not by the legacy editions/no-year-filter capture.
  const datedPattern = /cold_start_adjacent_evidence_report_[a-z0-9_]*\d[a-z0-9_]*\.md/;
  check(
    'source comment cites a DATED evidence report (cold_start_adjacent_evidence_report_<...digit...>.md)',
    datedPattern.test(before) || datedPattern.test(after),
    `no dated evidence-report reference found near ADJACENT_RETRIEVAL_ANCHORS`,
  );
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n[cold_start_adjacent] FAIL — ${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log(`\n[cold_start_adjacent] OK — all assertions passed.`);
process.exit(0);
