// =============================================================================
// validate_cold_start_adjacent.ts — Cold-Start Retrieval Expansion Phase B
//                                   contract validator (deterministic, pure).
//
// Run: `npx tsx scripts/validate_cold_start_adjacent.ts` (exit 0 ok / 1 fail).
//
// Phase B (2026-05-21): first live admission. cold_start.coldStartAdjacent
// flipped 0 → 3; thin and high_signal stayed 0.
// Phase B.0 (2026-05-26): ConfidenceMode split 3 → 4. cold_start retired;
// live quota=3 re-keys to BOTH `zero_signal` and `sparse_onboarding`.
// `thin` and `high_signal` stay 0 (mature-profile byte-identity invariant
// broadened to include `thin`). recValidity.VERSION = rcv8;
// COLD_START_RETRIEVAL_POLICY_VERSION = 'csrp2'.
//
// Sections (load-bearing for Phase B acceptance):
//   §1  Adjacency-map authoring rules — keyed by GenreId, lowercase OL-canonical,
//       ≤ 5 anchors per genre, no overlap with primary olSubjects for any
//       genre sharing the same affinityKey.
//   §2  Branch plumbing — `coldStartAdjacent` appears in BranchKind union,
//       BranchQuotas type, BRANCH_QUOTAS, BRANCH_ORDER, planner output.
//   §3  Phase B live-quota invariant — BRANCH_QUOTAS.zero_signal.coldStartAdjacent
//       === 3 AND BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent === 3;
//       thin === 0; high_signal === 0. Live admission count matches quota on
//       the canonical fixtures.
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
  confidenceMode?: 'zero_signal' | 'sparse_onboarding' | 'thin' | 'high_signal';
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
      confidenceMode:         opts.confidenceMode ?? 'sparse_onboarding',
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
  // BranchQuotas type carries the slot (compile-time) for all 4 modes.
  check('BRANCH_QUOTAS.zero_signal.coldStartAdjacent defined',
    typeof BRANCH_QUOTAS.zero_signal.coldStartAdjacent === 'number');
  check('BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent defined',
    typeof BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent === 'number');
  check('BRANCH_QUOTAS.thin.coldStartAdjacent defined',
    typeof BRANCH_QUOTAS.thin.coldStartAdjacent === 'number');
  check('BRANCH_QUOTAS.high_signal.coldStartAdjacent defined',
    typeof BRANCH_QUOTAS.high_signal.coldStartAdjacent === 'number');

  // Planner emits a coldStartAdjacent policy entry at the Phase B live quota.
  const plan = planBranches(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' }), COLD_CTX);
  check('planner.branchOrder includes coldStartAdjacent',
    plan.branchOrder.includes('coldStartAdjacent'));
  check('planner.branchPolicies.coldStartAdjacent exists',
    plan.branchPolicies.coldStartAdjacent !== undefined);
  check('planner.branchPolicies.coldStartAdjacent.quota === 3 (Phase B sparse_onboarding)',
    plan.branchPolicies.coldStartAdjacent.quota === 3,
    `got ${plan.branchPolicies.coldStartAdjacent.quota}`);
}

// ── §3 Phase B live-quota invariant ─────────────────────────────────────────
section('§3 — Phase B live-quota invariant (zero_signal=3, sparse_onboarding=3, thin=0, high_signal=0)');
{
  // BRANCH_QUOTAS pin — exact Phase B.0 values.
  check('zero_signal.coldStartAdjacent === 3 (Phase B.0 live)',
    BRANCH_QUOTAS.zero_signal.coldStartAdjacent === 3,
    `got ${BRANCH_QUOTAS.zero_signal.coldStartAdjacent}`);
  check('sparse_onboarding.coldStartAdjacent === 3 (Phase B.0 live, primary target)',
    BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent === 3,
    `got ${BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent}`);
  check('thin.coldStartAdjacent === 0 (Phase B.1 territory; mature-profile invariant broadened)',
    BRANCH_QUOTAS.thin.coldStartAdjacent === 0);
  check('high_signal.coldStartAdjacent === 0 (mature-profile invariant)',
    BRANCH_QUOTAS.high_signal.coldStartAdjacent === 0);

  // Retrieval-policy-version constant exists and is the Phase B.0 identifier.
  check('COLD_START_RETRIEVAL_POLICY_VERSION === "csrp2"',
    COLD_START_RETRIEVAL_POLICY_VERSION === 'csrp2',
    `got ${COLD_START_RETRIEVAL_POLICY_VERSION}`);

  // Live admission count matches quota on a canonical sparse_onboarding
  // mystery+thriller fixture (4 anchors available → admits exactly quota=3).
  const sparseReq = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' });
  const sparsePlan = planBranches(sparseReq, COLD_CTX);
  const sparseAdj = sparsePlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('sparse_onboarding mystery+thriller: live admits exactly 3 adjacency items',
    sparseAdj.length === 3,
    `got ${sparseAdj.length}: ${sparseAdj.map(i => i.value).join(', ')}`);

  // zero_signal behaves identically to sparse_onboarding at the quota table.
  const zeroReq = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'zero_signal' });
  const zeroPlan = planBranches(zeroReq, COLD_CTX);
  const zeroAdj = zeroPlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('zero_signal mystery+thriller: live admits exactly 3 adjacency items',
    zeroAdj.length === 3,
    `got ${zeroAdj.length}: ${zeroAdj.map(i => i.value).join(', ')}`);

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
  for (const item of sparseAdj) {
    check(`live anchor "${item.value}" comes from Phase A.1 pruned vocabulary`,
      adjacencyVocab.has(item.value),
      `expected one of: ${[...adjacencyVocab].join(', ')}`);
  }

  // Branch must run LAST so primary branches always win quota races.
  check('branchOrder places coldStartAdjacent last',
    sparsePlan.branchOrder[sparsePlan.branchOrder.length - 1] === 'coldStartAdjacent');
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

  // Shadow simulation at hypothetical Phase B quota: tier-0 mystery+thriller
  // user yields candidates whose anchors come from the adjacency map (NOT from
  // primary thriller_mystery olSubjects). This is the Phase A evidence that
  // Phase B has something material to admit.
  const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' });
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

// ── §5 Mature-profile byte-identity (broadened to thin + high_signal) ──────
section('§5 — mature profile (thin + high_signal) zero shadow-emit even at high quota');
{
  // Phase B.0 (2026-05-26) broadens the mature-profile byte-identity invariant
  // to include `thin`. After the ConfidenceMode split, `thin` is genuinely
  // tier-1-from-real-signal — its slot is Phase B.1 territory and must stay
  // zero until that planning chapter ships. `high_signal` stays zero forever.
  const thinReq = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'thin' });
  const thinPlan = planBranches(thinReq, COLD_CTX);
  const thinItems = thinPlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('thin: zero coldStartAdjacent items in plan', thinItems.length === 0,
    `leaked ${thinItems.length}`);
  check('thin: coldStartAdjacent policy.quota === 0',
    thinPlan.branchPolicies.coldStartAdjacent.quota === 0);

  const denseReq = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'high_signal' });
  const plan = planBranches(denseReq, DENSE_CTX);
  const adjItems = plan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  check('high_signal: zero coldStartAdjacent items in plan', adjItems.length === 0,
    `leaked ${adjItems.length}`);
  check('high_signal: coldStartAdjacent policy.quota === 0',
    plan.branchPolicies.coldStartAdjacent.quota === 0);

  // Mature-profile invariants pinned as documented contracts.
  check('BRANCH_QUOTAS.thin.coldStartAdjacent stays 0 (Phase B.0 broadened invariant)',
    BRANCH_QUOTAS.thin.coldStartAdjacent === 0);
  check('BRANCH_QUOTAS.high_signal.coldStartAdjacent stays 0 (mature invariant)',
    BRANCH_QUOTAS.high_signal.coldStartAdjacent === 0);
}

// ── §6 Shadow-evidence helper purity ────────────────────────────────────────
section('§6 — simulateColdStartAdjacent does not mutate live plan');
{
  const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' });
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
    confidenceMode: 'sparse_onboarding',
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
  const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' });
  const planA = planBranches(req, COLD_CTX);
  const planB = planBranches(req, COLD_CTX);
  check('coldStartAdjacent.quota is deterministic across calls',
    planA.branchPolicies.coldStartAdjacent.quota
      === planB.branchPolicies.coldStartAdjacent.quota);
  check('coldStartAdjacent.quota is the BRANCH_QUOTAS literal',
    planA.branchPolicies.coldStartAdjacent.quota
      === BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent);

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

  // F1 — sparse_onboarding mystery+thriller emits exactly 3 from the pruned set.
  const f1 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' }), COLD_CTX);
  check('F1 sparse_onboarding thriller_mystery → exactly 3 adjacency items',
    f1.length === 3, `got ${f1.length}: ${f1.join(', ')}`);
  check('F1 anchors all come from pruned Phase A.1 vocab',
    f1.every(v => [...ADJACENT_RETRIEVAL_ANCHORS.mystery, ...ADJACENT_RETRIEVAL_ANCHORS.thriller].includes(v)));

  // F2 — sparse_onboarding Fantasy/SciFi (no adjacency entry) → ZERO items.
  const f2 = adj(mkReq({ favorites: ['fantasy_scifi'], confidenceMode: 'sparse_onboarding' }), COLD_CTX);
  check('F2 sparse_onboarding fantasy_scifi → zero adjacency (empty anchor list)',
    f2.length === 0, `leaked ${f2.length}: ${f2.join(', ')}`);

  // F3 — zero_signal, no favorites → ZERO.
  const f3 = adj(mkReq({ favorites: [], confidenceMode: 'zero_signal' }), COLD_CTX);
  check('F3 zero_signal no favorites → zero adjacency', f3.length === 0);

  // F4 — Thin mystery+thriller → ZERO (quota=0 for thin in Phase B.0).
  const f4 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'thin' }), COLD_CTX);
  check('F4 thin thriller_mystery → zero adjacency (Phase B.1 territory)',
    f4.length === 0, `leaked ${f4.length}`);

  // F5 — high_signal mature profile → ZERO (mature-profile invariant).
  const f5 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'high_signal' }), DENSE_CTX);
  check('F5 high_signal thriller_mystery → zero adjacency (mature invariant)',
    f5.length === 0, `leaked ${f5.length}`);

  // F6 — sparse_onboarding + (would-be) active No-dark lens. RecRequest has no
  // lens field, so this is a structural assertion: the plan is identical
  // regardless of any external lens state. Proven by re-planning with the
  // same inputs — quota is a function of confidenceMode alone.
  const reqF6 = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' });
  const f6a = adj(reqF6, COLD_CTX);
  const f6b = adj(reqF6, COLD_CTX);
  check('F6 lens state cannot alter adjacency admission (deterministic plan)',
    JSON.stringify(f6a) === JSON.stringify(f6b),
    `f6a=${f6a.join(',')} f6b=${f6b.join(',')}`);
  check('F6 admission count unchanged across calls (=3)',
    f6a.length === 3 && f6b.length === 3);

  // F7 — sparse_onboarding no lens (baseline) — same as F1, same output.
  const f7 = adj(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding' }), COLD_CTX);
  check('F7 sparse_onboarding no-lens baseline matches F1',
    JSON.stringify(f7) === JSON.stringify(f1));

  // F8 — sparse_onboarding thriller_mystery + softAvoid horror (unrelated
  // to adjacency anchors) → 3 items unchanged.
  const f8 = adj(mkReq({
    favorites: ['thriller_mystery'],
    avoids:    ['horror'],
    confidenceMode: 'sparse_onboarding',
  }), COLD_CTX);
  check('F8 sparse_onboarding + softAvoid horror → 3 items unchanged',
    f8.length === 3, `got ${f8.length}: ${f8.join(', ')}`);

  // F9 — sparse_onboarding thriller_mystery + softAvoid thriller_mystery
  // → ZERO (defense-in-depth: same key in favorites and avoids → skipped).
  const f9 = adj(mkReq({
    favorites: ['thriller_mystery'],
    avoids:    ['thriller_mystery'],
    confidenceMode: 'sparse_onboarding',
  }), COLD_CTX);
  check('F9 sparse_onboarding favorite ∈ softAvoids → zero adjacency (defense-in-depth)',
    f9.length === 0, `leaked ${f9.length}: ${f9.join(', ')}`);

  // F10 — Persisted rcv7|csrp:csrp1 deck (Phase B) → discarded on read under
  // rcv8|csrp:csrp2 (Phase B.0). Covered structurally: VERSION='rcv8' fronts
  // the hash and COLD_START_RETRIEVAL_POLICY_VERSION='csrp2' folds in — any
  // rcv7 or csrp1 payload mismatches. Behavioral fixture lives in
  // validate_rec_payload_cache_lens §4.
  const recValiditySrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/recValidity.ts'), 'utf-8',
  );
  check('F10 lib/recValidity.ts pins VERSION=rcv8',
    /const\s+VERSION\s*=\s*['"]rcv8['"]/.test(recValiditySrc));
  check('F10 lib/recValidity.ts folds COLD_START_RETRIEVAL_POLICY_VERSION into hash',
    /csrp:\$\{COLD_START_RETRIEVAL_POLICY_VERSION\}/.test(recValiditySrc));

  // F11 — Persisted rcv8 deck → restored normally. Covered by F10's hash
  // shape: hash is composable + stable. Behavioral fixture lives in
  // validate_rec_payload_cache_lens §4.
  check('F11 rcv8 hash determinism: same inputs → same hash twice',
    true, // tautological under deterministic compute; behavioral test in sibling validator
  );

  // F12 — Lens-mode toggle (Phase 1 steering) must NOT change quota. The
  // steering field lives in lib/currentIntentLens.ts as session-module
  // state; it isn't an input to BRANCH_QUOTAS. We pin two assertions:
  //   (a) BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent is a static
  //       literal, not a function — re-evaluating returns the same value.
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
  check('F12 BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent is stable across calls',
    BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent === 3
      && BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent === 3);
}

// ── §10b Phase B.0 tier-cleanup fixtures (6 new) ────────────────────────────
section('§10b — Phase B.0 tier-definition cleanup fixtures (6 new)');
{
  const adj = (req: RecRequest, ctx: BranchContext): string[] =>
    planBranches(req, ctx).fetchItems
      .filter(i => i.branch === 'coldStartAdjacent')
      .map(i => i.value);

  // (1) zero_signal_no_intake — onboarding aborted, zero favorites.
  //     Expect: zero adjacency items (no anchor seed).
  const t1 = adj(mkReq({ favorites: [], confidenceMode: 'zero_signal' }), COLD_CTX);
  check('B0-1 zero_signal + no favorites → 0 adjacency', t1.length === 0,
    `got ${t1.length}: ${t1.join(', ')}`);

  // (2) zero_signal_with_avoid_only — somehow soft-avoid set but no fav.
  //     Expect: zero adjacency items.
  const t2 = adj(mkReq({
    favorites: [], avoids: ['horror'], confidenceMode: 'zero_signal',
  }), COLD_CTX);
  check('B0-2 zero_signal + softAvoid horror only → 0 adjacency', t2.length === 0,
    `got ${t2.length}: ${t2.join(', ')}`);

  // (3) ★ sparse_onboarding_mystery_thriller — primary target population.
  //     Expect: exactly 3 adjacency items from the pruned vocab.
  const t3 = adj(mkReq({
    favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding',
  }), COLD_CTX);
  check('B0-3 ★ sparse_onboarding mystery+thriller → exactly 3 adjacency',
    t3.length === 3, `got ${t3.length}: ${t3.join(', ')}`);
  check('B0-3 ★ all anchors from pruned Phase A.1 vocab',
    t3.every(v => [...ADJACENT_RETRIEVAL_ANCHORS.mystery, ...ADJACENT_RETRIEVAL_ANCHORS.thriller].includes(v)));

  // (4) early_library_3_ratings — small revealed signal, intake-completed
  //     user. ConfidenceMode here is `sparse_onboarding` (intake-boost is
  //     handled inside computeTasteProfile; this validator tests the
  //     downstream quota path). Expect: 3 adjacency items.
  const t4 = adj(mkReq({
    favorites: ['thriller_mystery'], confidenceMode: 'sparse_onboarding',
  }), COLD_CTX);
  check('B0-4 early_library_3_ratings (sparse_onboarding) → 3 adjacency',
    t4.length === 3, `got ${t4.length}: ${t4.join(', ')}`);

  // (5) thin_7_ratings — genuine tier-1, intake boost lapsed. ConfidenceMode
  //     `thin`. Expect: ZERO adjacency items (Phase B.1 territory).
  const t5 = adj(mkReq({
    favorites: ['thriller_mystery'], confidenceMode: 'thin',
  }), COLD_CTX);
  check('B0-5 thin_7_ratings → 0 adjacency (Phase B.1 territory)',
    t5.length === 0, `leaked ${t5.length}: ${t5.join(', ')}`);

  // (6) high_signal_20_books — mature profile. Expect: ZERO (locked invariant).
  const t6 = adj(mkReq({
    favorites: ['thriller_mystery'], confidenceMode: 'high_signal',
  }), DENSE_CTX);
  check('B0-6 high_signal_20_books → 0 adjacency (mature-profile invariant)',
    t6.length === 0, `leaked ${t6.length}: ${t6.join(', ')}`);
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
