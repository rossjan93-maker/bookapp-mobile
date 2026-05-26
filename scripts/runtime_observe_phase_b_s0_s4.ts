// =============================================================================
// runtime_observe_phase_b_s0_s4.ts — Phase B re-observation, plan-level only
//
// Sandbox-feasible portion of the Phase B Lens Arbitration re-observation.
// The live recommender cannot be invoked headlessly from this environment
// (see docs/diag_lens_arbitration_blocker_2026-05-19.md §A) — so the
// `[LENS_ARBITRATION]` and visible top-deck portion of the observation must
// be captured from a real dev session with FORENSIC_USER_ID set locally.
//
// What THIS script DOES capture (without product changes, without a UUID,
// without an OL fetch, without Supabase):
//   - The retrieval plan emitted by planBranches() across S0..S4 lens chip
//     variants, for a sparse cold-start Mystery+Thriller profile.
//   - Confirms coldStartAdjacent admission count is identical across all
//     five scenarios (lens-blindness invariant — Phase B does NOT
//     pre-empt Phase B.1 lens-aware breadth modulation).
//   - high_signal sibling plan for the same five lens variants
//     (mature-profile invariant: 0 adjacency, no scenario-driven change).
//
// What this script CANNOT capture (sandbox-blocked):
//   - Visible top-deck titles per scenario (needs real OL + scoring pass)
//   - n_tlm / n_wem / lfa_any / classifier_miss_rate aggregates
//   - finalGate hardExclusion of adjacency candidates
//
// Read-only. No source mutations. No FORENSIC_USER_ID change.
// =============================================================================

import { BRANCH_QUOTAS, COLD_START_RETRIEVAL_POLICY_VERSION } from '../lib/recPolicy';
import { planBranches } from '../lib/retrieval/branchPlanner';
import type { RecRequest } from '../lib/recRequest';
import type { BranchContext } from '../lib/retrieval/types';

const SCENARIOS: Array<{
  id: string;
  label: string;
  chips: RecRequest['signals']['nextReadChips'] | undefined;
}> = [
  { id: 'S0', label: 'Baseline (no lens)', chips: undefined },
  { id: 'S1', label: 'Light & accessible',
    chips: { signalClass: 'current_intent', intentScope: 'session', tone: 'light', energy: 'light_fun' } },
  { id: 'S2', label: 'Short & light / palate cleanser',
    chips: { signalClass: 'current_intent', intentScope: 'session', energy: 'palate_cleanser' } },
  { id: 'S3', label: 'Less dark',
    chips: { signalClass: 'current_intent', intentScope: 'session', intensity: 'low', energy: 'palate_cleanser' } },
  { id: 'S4', label: 'Fast-paced / immersive',
    chips: { signalClass: 'current_intent', intentScope: 'session', pace: 'fast', energy: 'palate_cleanser' } },
];

function makeReq(
  confidenceMode: 'zero_signal' | 'sparse_onboarding' | 'thin' | 'high_signal',
  chips: RecRequest['signals']['nextReadChips'] | undefined,
): RecRequest {
  return {
    userId: 'observe-phase-b',
    signals: {
      statedTaste: {
        signalClass: 'stated_durable',
        favoriteGenres: ['thriller_mystery'] as any,
        readingStyles: [], readingStylesDurable: [],
        readingStylesIntent: [], readingStylesUnknown: [],
        favoriteAuthors: [], updatedAt: null,
      },
      revealedTaste: { signalClass: 'revealed_behavioral', profile: { tier: 'low' } as any },
      softAvoids:    { signalClass: 'soft_avoid', genres: ['horror'] as any, updatedAt: null },
      ...(chips ? { nextReadChips: chips } : {}),
    },
    policy: {
      confidenceMode,
      statedPreferenceFloor: 0, statedPreferenceWeight: 0,
      softAvoidFloor: 0, softAvoidPenalty: 0,
    },
    build: { cause: 'session_open', builtAt: Date.now(), schemaVersion: 'rrv1' },
  };
}

const ctx: BranchContext = {
  topGenres: [], dominantLanes: [],
  repeatedAuthors: [], likedAuthors: [], likedSubjects: [],
  isDense: false,
};

console.log('═══ Phase B re-observation · plan-level capture (sandbox-feasible) ═══');
console.log(`COLD_START_RETRIEVAL_POLICY_VERSION = ${JSON.stringify(COLD_START_RETRIEVAL_POLICY_VERSION)}`);
console.log(`BRANCH_QUOTAS.sparse_onboarding  = ${JSON.stringify(BRANCH_QUOTAS.sparse_onboarding)}`);
console.log(`BRANCH_QUOTAS.zero_signal        = ${JSON.stringify(BRANCH_QUOTAS.zero_signal)}`);
console.log(`BRANCH_QUOTAS.high_signal = ${JSON.stringify(BRANCH_QUOTAS.high_signal)}`);
console.log(`fixture profile: sparse_onboarding | favoriteGenres=['thriller_mystery'] | softAvoids=['horror']\n`);

console.log('## sparse_onboarding across S0..S4');
console.log('| scn | label                         | lens chip                  | adj_quota | adj_admitted | total_plan | adj_anchors |');
console.log('|-----|-------------------------------|----------------------------|-----------|--------------|------------|-------------|');
for (const s of SCENARIOS) {
  const plan = planBranches(makeReq('sparse_onboarding', s.chips), ctx);
  const adj  = plan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  const chipStr = s.chips ? JSON.stringify({
    ...(s.chips.tone ? { tone: s.chips.tone } : {}),
    ...(s.chips.pace ? { pace: s.chips.pace } : {}),
    ...(s.chips.intensity ? { intensity: s.chips.intensity } : {}),
    ...(s.chips.energy ? { energy: s.chips.energy } : {}),
  }) : '—';
  console.log(`| ${s.id.padEnd(3)} | ${s.label.padEnd(29)} | ${chipStr.padEnd(26)} | ${
    String(plan.branchPolicies.coldStartAdjacent.quota).padEnd(9)} | ${
    String(adj.length).padEnd(12)} | ${
    String(plan.fetchItems.length).padEnd(10)} | ${JSON.stringify(adj.map(i => i.value))} |`);
}

console.log('\n## high_signal across S0..S4 (mature-profile invariant)');
console.log('| scn | adj_quota | adj_admitted | total_plan |');
console.log('|-----|-----------|--------------|------------|');
for (const s of SCENARIOS) {
  const plan = planBranches(makeReq('high_signal', s.chips), ctx);
  const adj  = plan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
  console.log(`| ${s.id.padEnd(3)} | ${
    String(plan.branchPolicies.coldStartAdjacent.quota).padEnd(9)} | ${
    String(adj.length).padEnd(12)} | ${
    String(plan.fetchItems.length).padEnd(10)} |`);
}

console.log('\n## Plan-level invariants');
const coldFingerprints = SCENARIOS.map(s => {
  const adj = planBranches(makeReq('sparse_onboarding', s.chips), ctx).fetchItems
    .filter(i => i.branch === 'coldStartAdjacent');
  return JSON.stringify(adj.map(i => ({ kind: i.kind, value: i.value, reason: i.reason })));
});
const allSame = coldFingerprints.every(f => f === coldFingerprints[0]);
console.log(`sparse_onboarding adjacency fingerprint identical S0..S4 → ${allSame}`);
console.log(`  (expected true: Phase B is lens-BLIND at the plan; B.1 deferred)`);

const matureNonZero = SCENARIOS.some(s =>
  planBranches(makeReq('high_signal', s.chips), ctx).fetchItems
    .some(i => i.branch === 'coldStartAdjacent'),
);
console.log(`high_signal ever admits any adjacency → ${matureNonZero}`);
console.log(`  (expected false: mature-profile invariant)\n`);
