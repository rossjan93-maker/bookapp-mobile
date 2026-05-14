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

const BRANCH_ORDER: readonly BranchKind[] = ['statedGenres', 'revealedAuthors', 'revealedLanes'];

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
    } else {
      branchItems = buildRevealedLanesBranch(req, ctx, pol.quota, lanesDeprioritized);
    }
    items.push(...branchItems);
  }

  if (__DEV__) {
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
