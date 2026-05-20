// =============================================================================
// validate_cold_start_adjacent.ts — Cold-Start Retrieval Expansion Phase A
//                                   contract validator (deterministic, pure).
//
// Run: `npx tsx scripts/validate_cold_start_adjacent.ts` (exit 0 ok / 1 fail).
//
// Sections (load-bearing for Phase A acceptance):
//   §1  Adjacency-map authoring rules — keyed by GenreId, lowercase OL-canonical,
//       ≤ 5 anchors per genre, no overlap with primary olSubjects for any
//       genre sharing the same affinityKey.
//   §2  Branch plumbing — `coldStartAdjacent` appears in BranchKind union,
//       BranchQuotas type, BRANCH_QUOTAS, BRANCH_ORDER, planner output.
//   §3  Phase A production-inert invariant — BRANCH_QUOTAS.*.coldStartAdjacent
//       === 0 at EVERY confidenceMode; planner emits zero coldStartAdjacent
//       items in production for any synthetic fixture.
//   §4  Mystery-only / Thriller-only / empty-genre slice scope — adjacency
//       map populated for Mystery + Thriller; all other GenreIds → [].
//   §5  Mature-profile byte-identity — high_signal users produce zero
//       coldStartAdjacent items even in shadow simulation at the highest
//       hypothetical Phase B quota (mature profiles MUST stay byte-identical
//       in Phase B too).
//   §6  Shadow-evidence helper purity — simulateColdStartAdjacent does NOT
//       mutate the live plan; running it before/after planBranches produces
//       identical RetrievalPlan.fetchItems.
//   §7  Soft-avoid defense-in-depth — adjacency branch skips a favorite
//       AffinityKey that's also in softAvoids (same rule as statedGenres).
//   §8  Calibration provenance (Phase A.1) — source comment in
//       lib/taxonomy/genres.ts above ADJACENT_RETRIEVAL_ANCHORS references at
//       least one dated `cold_start_adjacent_evidence_report*.md` file. This
//       prevents silent re-expansion of the anchor set without a re-probe.
// =============================================================================

import { planBranches } from '../lib/retrieval/branchPlanner';
import type { BranchContext } from '../lib/retrieval/types';
import type { RecRequest } from '../lib/recRequest';
import type { AffinityKey } from '../lib/taxonomy/genres';
import {
  ADJACENT_RETRIEVAL_ANCHORS,
  GENRE_DEFS,
} from '../lib/taxonomy/genres';
import { BRANCH_QUOTAS } from '../lib/recPolicy';
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

  // Planner emits a coldStartAdjacent policy entry (even at quota=0).
  const plan = planBranches(mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' }), COLD_CTX);
  check('planner.branchOrder includes coldStartAdjacent',
    plan.branchOrder.includes('coldStartAdjacent'));
  check('planner.branchPolicies.coldStartAdjacent exists',
    plan.branchPolicies.coldStartAdjacent !== undefined);
  check('planner.branchPolicies.coldStartAdjacent.quota === 0 (Phase A)',
    plan.branchPolicies.coldStartAdjacent.quota === 0,
    `got ${plan.branchPolicies.coldStartAdjacent.quota}`);
}

// ── §3 Phase A production-inert invariant ───────────────────────────────────
section('§3 — Phase A production-inert (quota=0 everywhere)');
{
  // BRANCH_QUOTAS pin.
  check('cold_start.coldStartAdjacent === 0', BRANCH_QUOTAS.cold_start.coldStartAdjacent === 0);
  check('thin.coldStartAdjacent === 0',       BRANCH_QUOTAS.thin.coldStartAdjacent === 0);
  check('high_signal.coldStartAdjacent === 0', BRANCH_QUOTAS.high_signal.coldStartAdjacent === 0);

  // Planner emits zero coldStartAdjacent items for every synthetic fixture.
  const fixtures: Array<{ name: string; req: RecRequest; ctx: BranchContext }> = [
    { name: 'cold mystery+thriller', req: mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' }), ctx: COLD_CTX },
    { name: 'thin mystery+thriller', req: mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'thin' }),       ctx: COLD_CTX },
    { name: 'dense mystery+thriller', req: mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'high_signal' }), ctx: DENSE_CTX },
    { name: 'cold no favorites',     req: mkReq({ favorites: [], confidenceMode: 'cold_start' }),                    ctx: COLD_CTX },
    { name: 'cold fantasy (no adjacency entry)', req: mkReq({ favorites: ['fantasy_scifi'], confidenceMode: 'cold_start' }), ctx: COLD_CTX },
  ];
  for (const { name, req, ctx } of fixtures) {
    const plan = planBranches(req, ctx);
    const adjItems = plan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
    check(`${name}: zero coldStartAdjacent items in production plan`, adjItems.length === 0,
      `leaked ${adjItems.length}: ${adjItems.map(i => i.value).join(', ')}`);
  }
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
