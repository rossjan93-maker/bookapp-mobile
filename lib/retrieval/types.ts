// =============================================================================
// retrieval/types.ts — P2A retrieval branch planner shared types
//
// The planner replaces the inline `if (isDense) { ... } else { ... }` retrieval
// orchestration that lived inside `getOLCandidates` (lib/recommender.ts) and
// silently bypassed stated favorite_genres for dense users. The new shape:
//
//   plan = planBranches(req, ctx)        // pure: decide which branches run
//   plan = applySoftAvoidPolicy(plan)    // pure: deprioritize soft-avoid lanes
//   items = executePlan(plan)            // pure: flatten to FetchItem[]
//   merged = await fetchAll(items)       // IO: existing OL helpers, untouched
//
// Each FetchItem carries `branch` + `signalClass` provenance so downstream
// retrieval_trace and (P3) explanation/contribution attribution can identify
// where each candidate came from. The `reason:` prefix scheme is preserved
// verbatim so the existing trace-extraction code in getOLCandidates keeps
// working without changes to its parsing.
// =============================================================================

import type { AffinityKey } from '../taxonomy/genres';
import type { BuildCause } from '../recRequest';

/** Branch kinds implemented in P2A. Intent / exploration are explicitly
 *  deferred (intent is post-retrieval today; exploration is implicit in the
 *  catalog-fallback scan). Adding a new branch is additive and does not
 *  require touching the planner core. */
export type BranchKind = 'statedGenres' | 'revealedLanes' | 'revealedAuthors';

/** Provenance class on each FetchItem. Mirrors lib/recSignals/types.SignalClass
 *  but narrowed to the classes that produce retrieval (not e.g. feedback). */
export type RetrievalSignalClass = 'stated_durable' | 'revealed_behavioral';

/** A single OL retrieval target. Shape is intentionally identical to the
 *  pre-P2A inline FetchItem so the existing fetch loop is a drop-in. The
 *  `branch` and `signalClass` fields are additive metadata. */
export type FetchItem = {
  kind:        'subject' | 'author';
  value:       string;
  /** Reason prefix preserved verbatim from pre-P2A so retrieval_trace
   *  extraction (top_genres_used / liked_subjects_used / liked_authors_used)
   *  continues to work without changes to its parsing logic. */
  reason:      string;
  branch:      BranchKind;
  signalClass: RetrievalSignalClass;
  /** True when this item was retained at a reduced priority due to a soft-
   *  avoid lane intersection. Diagnostic only; not consumed by the fetch loop. */
  softAvoidDeprioritized?: boolean;
};

/** Per-branch policy snapshot the planner produces. `quota` is the maximum
 *  number of FetchItems the branch may emit. Quotas come from
 *  recPolicy.BRANCH_QUOTAS, modulated by BuildCause and soft-avoid multiplier. */
export type BranchPolicy = {
  enabled: boolean;
  quota:   number;
  /** Diagnostic note — why quota landed where it did. Never user-facing. */
  notes?:  string;
};

/** Inputs the planner needs from the live recommender state. Kept narrow so
 *  branches can be tested independently with a synthetic context. */
export type BranchContext = {
  /** Sorted top-3..5 affinity keys (post-fallback) — feeds revealedLanes
   *  non-dense path. Pre-P2A this was the `topGenres` local variable. */
  topGenres:        readonly string[];
  /** profile.det_lanes.dominant_lanes (top 3) — feeds revealedLanes dense
   *  path. Strings typed as DeterministicLane upstream. */
  dominantLanes:    readonly string[];
  /** profile.det_lanes.repeated_liked_authors (top 3) — feeds
   *  revealedAuthors dense path. */
  repeatedAuthors:  readonly string[];
  /** profile.liked_authors (top 1) — feeds revealedAuthors non-dense path. */
  likedAuthors:     readonly string[];
  /** profile.liked_subjects (filtered, top 3) — feeds revealedLanes
   *  non-dense path subject anchors. */
  likedSubjects:    readonly string[];
  /** True when ≥2 dominant lanes OR ≥3 repeated authors. The planner uses
   *  this only to choose between dense/non-dense within revealedLanes /
   *  revealedAuthors — it is NEVER a gate that excludes statedGenres. */
  isDense:          boolean;
};

/** The full plan the planner emits. `softAvoidLanesApplied` records which
 *  AffinityKeys triggered a quota reduction, for validator inspection. */
export type RetrievalPlan = {
  branchOrder:           readonly BranchKind[];
  branchPolicies:        Readonly<Record<BranchKind, BranchPolicy>>;
  softAvoidLanesApplied: readonly AffinityKey[];
  buildCause:            BuildCause;
  /** Final flattened fetch list, in branch order. */
  fetchItems:            readonly FetchItem[];
};
