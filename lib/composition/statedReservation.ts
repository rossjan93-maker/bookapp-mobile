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

export type StatedReservationTrace = {
  applied: boolean;
  cause?:  BuildCause;
  key?:    string;        // the AffinityKey that the reserved candidate matched
  reason:  StatedReservationReason;
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

  // (3) (4) (5) (6) candidate scan — single pass, first eligible wins.
  for (const book of compPool) {
    if (alreadyComposedKeys.has(compIdOf(book))) continue;

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
    if (!reason.startsWith('stated_genre:')) continue;

    const sb = book._score_breakdown;
    if (!sb) continue;

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
    if (!flag) continue;
    const statedContrib = (sb.stated_taste ?? 0);
    if (statedContrib <= 0) continue;

    // CORE gate (unless adjacent allowed). Mirrors isCompCore() in recommender.
    const isCore = sb.fit_class === 'core_fit' && !sb.audit_flags?.includes('weak_metadata');
    if (!isCore && !STATED_RESERVATION_POLICY.allowAdjacentReservation) continue;

    // Existing author/lane caps must hold.
    if (!compositionAllows(book)) continue;

    const key = flag.slice('stated_favorite:'.length);
    return {
      pick:  book,
      trace: { applied: true, cause, key, reason: 'reserved' },
    };
  }

  return { pick: null, trace: { applied: false, cause, reason: 'no_eligible_candidate' } };
}
