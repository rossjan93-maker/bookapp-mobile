// =============================================================================
// retrieval/branches/revealedLanes.ts — P2A revealed-lane retrieval branch
//
// Wraps the pre-P2A revealed-lane retrieval logic. This branch retains the
// USEFUL behavior from the dense bypass (specific OL anchors per dominant
// reading lane, e.g. "psychological thriller" / "domestic thriller" for
// modern_suspense users) — it is NOT eliminated, only relocated from being
// a hard `if (isDense)` switch into one branch among several in the planner.
//
// Two paths preserved verbatim from the pre-P2A inline plan:
//   - dense:    profile.det_lanes.dominant_lanes (top 3) →
//               LANE_OL_SUBJECTS[lane] anchors (2 per lane)
//   - non-dense: topGenres (already computed in recommender) →
//               getRetrievalSubjects(genre) anchors (2 per genre),
//               plus liked_subjects fallback anchors
//
// Soft-avoid handling: anchors derived from a lane that maps to a soft-
// avoided AffinityKey are filtered out (per-anchor), AND the branch quota
// is reduced by SOFT_AVOID_RETRIEVAL_MULTIPLIER when the user's dominant
// lane set intersects soft-avoids (per-branch). Both layers are policy in
// recPolicy.ts; this file only consults the resolved quota + anchor mask.
//
// LANE_OL_SUBJECTS lives here (not taxonomy) because per replit.md the
// dense-lane → OL-subject mapping is a DeterministicLane concept from
// lib/bookTraits.ts with no 1:1 GenreDef — folding into taxonomy would be
// a leaky abstraction. Moved verbatim from lib/recommender.ts:307.
// =============================================================================

import type { RecRequest } from '../../recRequest';
import type { DeterministicLane } from '../../bookTraits';
import { getRetrievalSubjects, type AffinityKey } from '../../taxonomy/genres';
import { LIKED_SUBJECT_AVOID_GUARDS } from '../../recPolicy';
import type { BranchContext, FetchItem } from '../types';

// ── Dense-lane → OL subject anchors (moved from recommender.ts:307) ─────────
//
// More specific than getRetrievalSubjects() — avoids literary / canon drift
// entirely unless 'literary' is actually a dominant lane for this user.

const LANE_OL_SUBJECTS: Record<DeterministicLane, [string, string]> = {
  romantasy:            ['romantasy',                     'fantasy romance'],
  contemporary_fiction: ["women's fiction",               'book club fiction'],
  modern_suspense:      ['psychological thriller',         'domestic thriller'],
  memoir_nonfiction:    ['personal memoirs',               'narrative nonfiction'],
  literary:             ['literary fiction',               'contemporary literary fiction'],
  scifi_fantasy:        ['epic fantasy',                   'dystopian fiction'],
  romance:              ['contemporary romance',           'romance fiction'],
  horror:               ['horror fiction',                 'supernatural fiction'],
};

// ── Lane → AffinityKey for soft-avoid intersection ──────────────────────────
//
// Approximate mapping — DeterministicLane is coarser than AffinityKey in
// some spots and finer in others. The mapping is intentionally local to
// this branch (the only consumer); folding into taxonomy would require a
// bidirectional model that taxonomy doesn't currently own.

const LANE_TO_AFFINITY: Record<DeterministicLane, AffinityKey> = {
  romantasy:            'fantasy_scifi',
  contemporary_fiction: 'literary',
  modern_suspense:      'thriller_mystery',
  memoir_nonfiction:    'memoir_bio',
  literary:             'literary',
  scifi_fantasy:        'fantasy_scifi',
  romance:              'romance',
  horror:               'horror',
};

/** Lanes whose AffinityKey intersects the user's soft-avoids. Public only
 *  for the planner so it can decide quota reduction. Pure / synchronous. */
export function softAvoidedLanes(
  dominantLanes: readonly string[],
  softAvoids:    readonly AffinityKey[],
): DeterministicLane[] {
  const avoidSet = new Set<string>(softAvoids);
  const out: DeterministicLane[] = [];
  for (const lane of dominantLanes) {
    const aff = LANE_TO_AFFINITY[lane as DeterministicLane];
    if (aff && avoidSet.has(aff)) out.push(lane as DeterministicLane);
  }
  return out;
}

/** P2C: topGenres (sparse-user signal) whose AffinityKey intersects the
 *  user's soft-avoids. Mirrors `softAvoidedLanes` but for the sparse path
 *  where dominantLanes is empty. Pure / synchronous. */
export function softAvoidedTopGenres(
  topGenres:  readonly string[],
  softAvoids: readonly AffinityKey[],
): AffinityKey[] {
  if (topGenres.length === 0 || softAvoids.length === 0) return [];
  const avoidSet = new Set<string>(softAvoids);
  const out: AffinityKey[] = [];
  for (const g of topGenres) {
    if (avoidSet.has(g)) out.push(g as AffinityKey);
  }
  return out;
}

/** P2C: returns true when a free-form liked_subject string clearly belongs
 *  to a soft-avoided AffinityKey via the curated guard list. Used by the
 *  sparse-path liked_subjects loop to skip "epic fantasy" / "magic systems"
 *  / etc. when the user soft-avoided fantasy_scifi. */
function isLikedSubjectAvoided(
  subject:    string,
  softAvoids: ReadonlySet<string>,
): boolean {
  if (softAvoids.size === 0) return false;
  const lower = subject.toLowerCase();
  for (const key of softAvoids) {
    const guards = LIKED_SUBJECT_AVOID_GUARDS[key as AffinityKey];
    if (!guards) continue;
    for (const g of guards) {
      if (lower.includes(g.toLowerCase())) return true;
    }
  }
  return false;
}

export function buildRevealedLanesBranch(
  req: RecRequest,
  ctx: BranchContext,
  quota: number,
  /** P2C: when true, every emitted FetchItem carries
   *  `softAvoidDeprioritized=true` so debug surfaces can identify items
   *  retained at reduced priority. The planner sets this when it applied
   *  the SOFT_AVOID_RETRIEVAL_MULTIPLIER quota reduction. */
  deprioritizedFlag: boolean = false,
): FetchItem[] {
  if (quota <= 0) return [];

  const avoidSet = new Set<string>(req.signals.softAvoids.genres);
  const isLaneAvoided = (lane: DeterministicLane): boolean => {
    const aff = LANE_TO_AFFINITY[lane];
    return !!aff && avoidSet.has(aff);
  };

  const items: FetchItem[] = [];
  const push = (item: FetchItem): void => {
    if (deprioritizedFlag) item.softAvoidDeprioritized = true;
    items.push(item);
  };

  if (ctx.isDense) {
    // Dense path: dominant_lanes → LANE_OL_SUBJECTS anchors. Lanes whose
    // AffinityKey is in soft-avoids are skipped entirely (per-anchor mask).
    for (const lane of ctx.dominantLanes.slice(0, 3) as DeterministicLane[]) {
      if (items.length >= quota) break;
      if (isLaneAvoided(lane)) continue;
      const anchors = LANE_OL_SUBJECTS[lane];
      if (!anchors) continue;
      const [s1, s2] = anchors;
      push({
        kind: 'subject', value: s1,
        reason: `lane:${lane}`,
        branch: 'revealedLanes',
        signalClass: 'revealed_behavioral',
      });
      if (items.length < quota && s2) {
        push({
          kind: 'subject', value: s2,
          reason: `lane:${lane}`,
          branch: 'revealedLanes',
          signalClass: 'revealed_behavioral',
        });
      }
    }
  } else {
    // Non-dense path: topGenres → getRetrievalSubjects() anchors. A genre
    // that is itself in soft-avoids is skipped (per-anchor mask).
    for (const genre of ctx.topGenres) {
      if (items.length >= quota) break;
      if (avoidSet.has(genre)) continue;
      const [s1, s2] = getRetrievalSubjects(genre);
      push({
        kind: 'subject', value: s1,
        reason: `genre:${genre}`,
        branch: 'revealedLanes',
        signalClass: 'revealed_behavioral',
      });
      if (items.length < quota && s2) {
        push({
          kind: 'subject', value: s2,
          reason: `genre:${genre}`,
          branch: 'revealedLanes',
          signalClass: 'revealed_behavioral',
        });
      }
    }

    // Liked-subject fallback anchors (only if quota remains). Pre-P2A this
    // ran unconditionally up to 3 items; here it consumes residual quota.
    // P2C: skip subjects whose substring matches the LIKED_SUBJECT_AVOID_GUARDS
    // entry for any soft-avoided AffinityKey.
    for (const subject of ctx.likedSubjects) {
      if (items.length >= quota) break;
      if (isLikedSubjectAvoided(subject, avoidSet)) continue;
      push({
        kind: 'subject', value: subject,
        reason: `liked_subject:${subject}`,
        branch: 'revealedLanes',
        signalClass: 'revealed_behavioral',
      });
    }
  }

  return items;
}
