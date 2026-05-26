// =============================================================================
// retrieval/branchPlanner.ts — P2A retrieval branch planner
//
// Replaces the inline `if (isDense) { ... } else { ... }` orchestration that
// lived inside lib/recommender.ts:getOLCandidates and silently bypassed
// stated favorite_genres for dense users.
//
// Pipeline (all pure / synchronous):
//   1. Resolve base quotas from BRANCH_QUOTAS keyed off confidenceMode.
//   2. Apply BuildCause modifier — 'explicit_preference_edit' boosts the
//      statedGenres quota by +1 and trims revealedLanes by -1 (within-budget
//      rebalance, no net plan-size change).
//   3. Apply soft-avoid retrieval policy — when the user's dominant lanes
//      intersect their soft-avoids, multiply revealedLanes quota by
//      SOFT_AVOID_RETRIEVAL_MULTIPLIER (floor 1).
//   4. Disable statedGenres when no mapped favorites exist (degenerates to
//      pre-P2A behavior for users with empty Reading Taste).
//   5. Run each branch up to its quota, in branch order.
//
// Branch order: statedGenres → revealedAuthors → revealedLanes. Stated runs
// first so quota-constrained edits prefer stated anchors over revealed
// anchors when the explicit_preference_edit boost is in effect. Authors run
// before lanes because authors are the strongest behavioral anchor in dense
// mode and we never want lanes to crowd them out.
//
// Plan-size invariant: the final fetchItems.length stays at or below the
// pre-P2A maximum (~10 dense / ~11 non-dense), so OL load characteristics
// are preserved.
// =============================================================================

import type { RecRequest } from '../recRequest';
import { BRANCH_QUOTAS, EDIT_CAUSE_BRANCH_BOOST, SOFT_AVOID_RETRIEVAL_MULTIPLIER } from '../recPolicy';
import type { AffinityKey } from '../taxonomy/genres';
import {
  type BranchContext,
  type BranchKind,
  type BranchPolicy,
  type FetchItem,
  type RetrievalPlan,
} from './types';
import { buildStatedGenresBranch } from './branches/statedGenres';
import { buildRevealedAuthorsBranch } from './branches/revealedAuthors';
import { buildRevealedLanesBranch, softAvoidedLanes, softAvoidedTopGenres } from './branches/revealedLanes';
import { buildColdStartAdjacentBranch, simulateColdStartAdjacent } from './branches/coldStartAdjacent';

// Cold-Start Retrieval Expansion — `coldStartAdjacent` appended at the END
// of BRANCH_ORDER so primary branches always win quota races. Phase B
// (2026-05-21): cold_start quota=3 live; thin/high_signal stay 0.
const BRANCH_ORDER: readonly BranchKind[] = ['statedGenres', 'revealedAuthors', 'revealedLanes', 'coldStartAdjacent'];

// FORENSIC_USER_ID for the live-admission observation log. Currently ''
// (no live user matches), so the log is dormant in normal operation.
// Setting this to a real userId in a dev build surfaces what
// `coldStartAdjacent` ACTUALLY admitted into the plan under live Phase B
// quotas. Mirrors the FORENSIC_USER_ID pattern in lib/recommender.ts.
const FORENSIC_USER_ID = '7fb52f14-e447-42de-acf4-0120a1213294';

/** Pure: decide which branches run and at what quota, before fetching. */
export function planBranches(req: RecRequest, ctx: BranchContext): RetrievalPlan {
  const base = BRANCH_QUOTAS[req.policy.confidenceMode];
  const cause = req.build.cause;

  // Step 1 + 2: base quotas + BuildCause modifier.
  let qStated  = base.statedGenres;
  let qAuthors = base.revealedAuthors;
  let qLanes   = base.revealedLanes;

  const causeNotes: Partial<Record<BranchKind, string>> = {};
  if (cause === 'explicit_preference_edit') {
    qStated += EDIT_CAUSE_BRANCH_BOOST.statedGenres;
    qLanes  += EDIT_CAUSE_BRANCH_BOOST.revealedLanes;
    causeNotes.statedGenres = `+${EDIT_CAUSE_BRANCH_BOOST.statedGenres} from explicit_preference_edit`;
    causeNotes.revealedLanes = `${EDIT_CAUSE_BRANCH_BOOST.revealedLanes} from explicit_preference_edit`;
  }

  // Step 3: soft-avoid retrieval policy. Only revealedLanes is reduced —
  // statedGenres already drops conflicted favorites at anchor selection.
  // P2C: trigger covers BOTH dense (dominantLanes ∩ softAvoids) AND sparse
  // (topGenres ∩ softAvoids) intersections. Pre-P2C only dense triggered.
  const avoidsAsKeys   = req.signals.softAvoids.genres as readonly AffinityKey[];
  const avoidedLanes   = softAvoidedLanes(ctx.dominantLanes, avoidsAsKeys);
  const avoidedTopGens = softAvoidedTopGenres(ctx.topGenres,  avoidsAsKeys);
  const softAvoidLanesApplied: AffinityKey[] = [];
  let lanesDeprioritized = false;
  if (avoidedLanes.length > 0 || avoidedTopGens.length > 0) {
    const reduced = Math.max(1, Math.floor(qLanes * SOFT_AVOID_RETRIEVAL_MULTIPLIER));
    const triggers = [
      ...avoidedLanes.length   > 0 ? [`dominant_lanes:${avoidedLanes.join(',')}`] : [],
      ...avoidedTopGens.length > 0 ? [`top_genres:${avoidedTopGens.join(',')}`]   : [],
    ].join(' & ');
    causeNotes.revealedLanes = (causeNotes.revealedLanes ?? '') +
      ` | soft-avoid intersect: ${triggers} → quota ${qLanes}→${reduced}`;
    qLanes = reduced;
    lanesDeprioritized = true;
    // Surface the AffinityKeys (not the lane labels) for validator inspection.
    const seen = new Set<AffinityKey>();
    for (const k of req.signals.softAvoids.genres) {
      if (seen.has(k)) continue;
      seen.add(k);
      softAvoidLanesApplied.push(k);
    }
  }

  // Step 4: degenerate cases.
  const statedEnabled = req.signals.statedTaste.favoriteGenres.length > 0 && qStated > 0;
  if (!statedEnabled) {
    causeNotes.statedGenres = (causeNotes.statedGenres ?? '') +
      ' | disabled (no mapped favorite_genres)';
  }

  // Cold-Start Retrieval Expansion · Phase B — quota slot. Live for
  // cold_start (quota=3); zero for thin and high_signal (mature-profile
  // invariant). NOT modulated by BuildCause or active lens in Phase B —
  // lens-aware breadth modulation is Phase B.1 surface.
  const qAdjacent = base.coldStartAdjacent;

  const policies: Record<BranchKind, BranchPolicy> = {
    statedGenres: {
      enabled: statedEnabled,
      quota:   statedEnabled ? qStated : 0,
      notes:   causeNotes.statedGenres,
    },
    revealedAuthors: {
      enabled: qAuthors > 0,
      quota:   qAuthors,
      notes:   causeNotes.revealedAuthors,
    },
    revealedLanes: {
      enabled: qLanes > 0,
      quota:   qLanes,
      notes:   causeNotes.revealedLanes,
    },
    coldStartAdjacent: {
      enabled: qAdjacent > 0,
      quota:   qAdjacent,
      notes:   qAdjacent === 0
        ? `phase_b: inert at confidenceMode=${req.policy.confidenceMode} (quota=0)`
        : `phase_b: live at confidenceMode=${req.policy.confidenceMode} (quota=${qAdjacent})`,
    },
  };

  // Step 5: execute branches and collect items in branch order.
  const items: FetchItem[] = [];
  for (const branch of BRANCH_ORDER) {
    const pol = policies[branch];
    if (!pol.enabled) continue;
    let branchItems: FetchItem[] = [];
    if (branch === 'statedGenres') {
      branchItems = buildStatedGenresBranch(req, pol.quota);
    } else if (branch === 'revealedAuthors') {
      branchItems = buildRevealedAuthorsBranch(ctx, pol.quota);
    } else if (branch === 'revealedLanes') {
      branchItems = buildRevealedLanesBranch(req, ctx, pol.quota, lanesDeprioritized);
    } else {
      // coldStartAdjacent — Phase A: quota=0 → branch returns []. Pure call;
      // safe to invoke even at quota=0 (early-returns inside the builder).
      branchItems = buildColdStartAdjacentBranch(req, pol.quota);
    }
    items.push(...branchItems);
  }

  // ── Phase B live-admission observation log ─────────────────────────────────
  // Gated by __DEV__ + FORENSIC_USER_ID. When a forensic user is set in a
  // dev build, this emits ONE `[COLD_START_ADJACENT]` line per planBranches
  // call showing what `coldStartAdjacent` ACTUALLY admitted into the plan
  // under the live Phase B quota. Plan-stage observation only — no
  // downstream deck-survival hook this slice. NEVER fires in production
  // builds and NEVER fires for non-forensic users; FORENSIC_USER_ID is
  // currently ''.
  if (typeof __DEV__ !== 'undefined' && __DEV__ && req.userId === FORENSIC_USER_ID) {
    const liveItems = items.filter(i => i.branch === 'coldStartAdjacent');
    // simulateColdStartAdjacent stays available as a counterfactual lens
    // (what WOULD a quota of N admit) — useful when calibrating Phase B.1
    // increases. Default counterfactual mirrors the live quota.
    const sim = simulateColdStartAdjacent(req, qAdjacent);
    console.log('[COLD_START_ADJACENT]',
      `phase=B`,
      `density=${req.policy.confidenceMode}`,
      `liveQuota=${qAdjacent}`,
      `liveAdmittedCount=${liveItems.length}`,
      `liveAnchors=${JSON.stringify(liveItems.map(i => i.value))}`,
      `statedGenresUsed=${JSON.stringify(sim.statedGenresUsed)}`,
      `counterfactualAnchors=${JSON.stringify(sim.anchorsWouldRun)}`,
      `admitted=true`,
    );
  }

  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const stCount = items.filter(i => i.branch === 'statedGenres').length;
    const auCount = items.filter(i => i.branch === 'revealedAuthors').length;
    const laCount = items.filter(i => i.branch === 'revealedLanes').length;
    console.log('[P2DEBUG/plan]',
      `cause=${cause}`,
      `stated=${policies.statedGenres.enabled ? policies.statedGenres.quota : 'OFF'}`,
      `authors=${policies.revealedAuthors.enabled ? policies.revealedAuthors.quota : 'OFF'}`,
      `lanes=${policies.revealedLanes.enabled ? policies.revealedLanes.quota : 'OFF'}`,
      `fetchItems=${items.length}`,
      `byBranch=stated:${stCount}/authors:${auCount}/lanes:${laCount}`,
      `softAvoidLanesApplied=${JSON.stringify(softAvoidLanesApplied)}`,
      policies.statedGenres.notes ? `statedNotes="${policies.statedGenres.notes}"` : '',
    );
  }

  return {
    branchOrder:           BRANCH_ORDER,
    branchPolicies:        policies,
    softAvoidLanesApplied,
    buildCause:            cause,
    fetchItems:            items,
  };
}
