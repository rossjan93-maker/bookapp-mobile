// =============================================================================
// statedReservation.ts — P2B BuildCause-aware top-slate reservation
//
// Pure helper. Given a sorted compPool (already passed all upstream quality
// gates), the active RecRequest, the current composition state, and the
// existing compositionAllows() predicate, return the first eligible
// "stated-branch" candidate that should be reserved into the top slate.
//
// Eligibility:
//   1. req exists AND req.build.cause is in STATED_RESERVATION_POLICY.eligibleCauses
//      (currently only 'explicit_preference_edit').
//   2. User has ≥1 stated favorite genre (req.signals.statedTaste.favoriteGenres).
//   3. Candidate book carries a `stated_favorite:<key>` audit_flag from
//      P1 step 7 AND has a positive _score_breakdown.stated_taste contribution.
//   4. Candidate is CORE (fit_class === 'core_fit' AND not weak_metadata),
//      unless STATED_RESERVATION_POLICY.allowAdjacentReservation = true.
//   5. compositionAllows(book) returns true (respects existing author/lane caps).
//   6. Candidate's composition key is not already in alreadyComposedKeys
//      (defensive — at the canonical pre-Phase-1 call site this set is empty).
//
// Returns:
//   { pick: ScoredBook | null; trace: { applied; cause?; key?; reason } }
//   reason ∈ 'no_req' | 'wrong_cause' | 'no_favorites' | 'no_eligible_candidate' | 'reserved'
//
// This module is single-call by design (maxReservedSlots=1). Multi-slot
// reservation is P3 slate-diversity territory.
//
// Pure / synchronous / no I/O. Mirrors lib/retrieval/branches/* discipline.
// =============================================================================

import type { ScoredBook } from '../recommender';
import type { RecRequest, BuildCause } from '../recRequest';
import { STATED_RESERVATION_POLICY } from '../recPolicy';

export type StatedReservationReason =
  | 'no_req'
  | 'wrong_cause'
  | 'no_favorites'
  | 'no_eligible_candidate'
  | 'reserved';

/** Per-gate failure tally for the candidate scan. Aggregate counts only —
 *  read by the recommender to emit a single grep-friendly diagnostic line.
 *  Counts are mutually exclusive per candidate: each book that is skipped
 *  increments exactly one bucket (the FIRST gate it fails). A reserved
 *  candidate's trace will show zeroes for every later candidate it short-
 *  circuited. `pool_eligible_for_scan` reflects compPool minus
 *  alreadyComposedKeys; the per-gate counts sum to <= that figure. */
export type StatedReservationGateCounts = {
  retrieval_provenance: number; // _retrieval_reason did not start with stated_genre:
  no_score_breakdown:   number; // candidate had no _score_breakdown
  scoring_provenance:   number; // no audit_flags 'stated_favorite:*'
  stated_contribution:  number; // stated_taste <= 0
  fit_class:            number; // adjacent/stretch/reject without policy widening
  weak_metadata:        number; // weak_metadata flag rejected even when widened
  caps:                 number; // compositionAllows() returned false
  pool_eligible_for_scan: number;
};

export type StatedReservationTrace = {
  applied:     boolean;
  cause?:      BuildCause;
  key?:        string;        // the AffinityKey that the reserved candidate matched
  reason:      StatedReservationReason;
  gateCounts?: StatedReservationGateCounts;
};

export type StatedReservationResult = {
  pick:  ScoredBook | null;
  trace: StatedReservationTrace;
};

/**
 * Identify a quality-clearing stated-branch candidate to pre-seed the
 * composition engine when BuildCause warrants it. See module header for
 * full eligibility contract.
 */
export function pickStatedReservation(
  compPool:             readonly ScoredBook[],
  req:                  RecRequest | undefined,
  alreadyComposedKeys:  ReadonlySet<string>,
  compositionAllows:    (b: ScoredBook) => boolean,
  compIdOf:             (b: ScoredBook) => string,
): StatedReservationResult {
  // (1) cause gate
  if (!req) {
    return { pick: null, trace: { applied: false, reason: 'no_req' } };
  }
  const cause = req.build.cause;
  if (!STATED_RESERVATION_POLICY.eligibleCauses.includes(cause)) {
    return { pick: null, trace: { applied: false, cause, reason: 'wrong_cause' } };
  }

  // (2) favorites gate — handles user who triggered the edit but cleared all favorites.
  if (req.signals.statedTaste.favoriteGenres.length === 0) {
    return { pick: null, trace: { applied: false, cause, reason: 'no_favorites' } };
  }

  // ── Adjacent-fit policy resolution (per-cause widening) ──────────────────
  // Global default `allowAdjacentReservation` stays conservative (false). The
  // per-cause allowlist `allowAdjacentForCauses` widens reservation to
  // adjacent_fit ONLY for explicitly listed causes (currently only
  // `explicit_preference_edit`). Required for the Phase 2 product contract:
  // dense users editing toward off-lane genres routinely produce only
  // adjacent_fit stated candidates because computeFitClass keys on the
  // user's REVEALED dominant lane. All other P2B.1 AND-gates (retrieval
  // provenance, scoring provenance, positive stated_taste, non-weak
  // metadata, composition caps) still apply.
  const allowAdjacentThisCause =
       STATED_RESERVATION_POLICY.allowAdjacentReservation
    || STATED_RESERVATION_POLICY.allowAdjacentForCauses.includes(cause);

  // (3) (4) (5) (6) candidate scan — single pass, first eligible wins.
  // gateCounts increments at most once per candidate (first-failed-gate wins)
  // so the recommender can emit a tight diagnostic summary post-scan.
  const gateCounts: StatedReservationGateCounts = {
    retrieval_provenance: 0,
    no_score_breakdown:   0,
    scoring_provenance:   0,
    stated_contribution:  0,
    fit_class:            0,
    weak_metadata:        0,
    caps:                 0,
    pool_eligible_for_scan: 0,
  };

  for (const book of compPool) {
    if (alreadyComposedKeys.has(compIdOf(book))) continue;
    gateCounts.pool_eligible_for_scan += 1;

    // ── Retrieval-provenance gate (P2B.1) ──────────────────────────────────
    // The candidate must have been fetched by the P2A statedGenres branch in
    // THIS pipeline run. Without this gate, a book that arrived via lane /
    // author / catalog branches and merely happened to match a stated
    // favorite at scoring time would qualify — which would conflate scoring
    // alignment with retrieval origin and let the reservation slot fire on
    // a candidate the user's stated edit did NOT actually steer the planner
    // toward.
    //
    // Soundness: the planner's branchOrder puts statedGenres FIRST
    // (lib/retrieval/branchPlanner.ts), and the merge-dedup at
    // lib/recommender.ts:~1176 is first-seen-wins. So any book the
    // statedGenres branch returned reliably retains its `stated_genre:`
    // _retrieval_reason. Books returned ONLY by other branches carry
    // `lane:` / `genre:` / `liked_subject:` / `author_anchor:` /
    // `repeated_author:` / `local:*` / `cache:*` and correctly fail here.
    const reason = book._retrieval_reason ?? '';
    if (!reason.startsWith('stated_genre:')) {
      gateCounts.retrieval_provenance += 1;
      continue;
    }

    const sb = book._score_breakdown;
    if (!sb) {
      gateCounts.no_score_breakdown += 1;
      continue;
    }

    // ── Scoring-provenance gate (P2B original) ─────────────────────────────
    // P1 step 7 surface: audit_flags carry `stated_favorite:<key>`; stated_taste
    // breakdown carries the numeric contribution. Both must be present and
    // positive — flag alone could match an avoid case in the future.
    // The `stated_favorite:<key>` audit flag is pushed by recommender step 7
    // ONLY when computeStatedTasteContribution matched a key in
    // req.signals.statedTaste.favoriteGenres. We trust that invariant rather
    // than re-checking favoriteGenres.includes(key) here — adding the runtime
    // check would mask any future scorer-side drift instead of surfacing it.
    //
    // Both gates are required (defense-in-depth):
    //   - retrieval-only would let a stated-branch book with zero scoring
    //     contribution be reserved (e.g., book primaryGenre doesn't actually
    //     match any stated favorite — common for broad subject queries).
    //   - scoring-only is the pre-P2B.1 drift the architect audit caught.
    const flag = sb.audit_flags?.find(f => f.startsWith('stated_favorite:'));
    if (!flag) {
      gateCounts.scoring_provenance += 1;
      continue;
    }
    const statedContrib = (sb.stated_taste ?? 0);
    if (statedContrib <= 0) {
      gateCounts.stated_contribution += 1;
      continue;
    }

    // ── Fit-class gate ─────────────────────────────────────────────────────
    // weak_metadata is ALWAYS a hard reject (mirrors isCompCore()) regardless
    // of whether adjacent is allowed: the quality floor is independent of
    // fit class. Otherwise: core_fit is always accepted; adjacent/stretch/
    // reject are accepted only when the per-cause allowlist widened the gate
    // for this BuildCause.
    const isWeak = sb.audit_flags?.includes('weak_metadata') ?? false;
    if (isWeak) {
      gateCounts.weak_metadata += 1;
      continue;
    }
    if (sb.fit_class !== 'core_fit' && !allowAdjacentThisCause) {
      gateCounts.fit_class += 1;
      continue;
    }

    // Existing author/lane caps must hold.
    if (!compositionAllows(book)) {
      gateCounts.caps += 1;
      continue;
    }

    const key = flag.slice('stated_favorite:'.length);
    return {
      pick:  book,
      trace: { applied: true, cause, key, reason: 'reserved', gateCounts },
    };
  }

  return {
    pick:  null,
    trace: { applied: false, cause, reason: 'no_eligible_candidate', gateCounts },
  };
}
