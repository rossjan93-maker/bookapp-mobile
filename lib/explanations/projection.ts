// =============================================================================
// explanations/projection.ts — P3A-5 composer-backed reasons projection
//
// Default-OFF flag-gated path that derives `book.reasons[]` from the
// P3A-4 composer (which itself reads `_retrieval_contributions` +
// `_scoring_contributions`).
//
// IMPORTANT — P3A-5 scope:
//   - The flag `COMPOSER_REASONS_PROJECTION_ENABLED` defaults to FALSE.
//     The recommender's call site is a one-liner that returns
//     `legacyReasons` unchanged when the flag is off, so production
//     `book.reasons[]` output is byte-identical to pre-P3A-5.
//   - When ON (validator / fixture replay only in this batch), the
//     composer projection replaces `book.reasons[]` AFTER all of:
//       * the CoG `fit_explanation` overwrite at recommender L2179-2183
//       * `classifyExplanationQuality` at L2188-2193
//       * the `_score_breakdown` final assignment at L2196-2210
//     So flipping the flag CANNOT shift score, fit_class, market_position,
//     lane_match_strength, cog_score_delta, final_score, or
//     explanation_quality — those are all written from the legacy reasons
//     before the override runs.
//   - RecCard / RecommendationsFeed / visible copy untouched. The override
//     only affects what `book.reasons[]` carries; no consumer is rewired
//     yet. P3A-6+ will live-smoke under flag ON and (if accepted) flip the
//     default and delete the legacy reasons builder.
// =============================================================================

import {
  composeExplanation,
  deriveBackcompatReasons,
} from './compose';
import type { ExplanationBundle } from './compose';

// ── Flag ─────────────────────────────────────────────────────────────────────
/** Default OFF. Flip to true ONLY for local fixture replay or a future
 *  staged rollout per the P3A-6 plan. NOT user-configurable; NOT read
 *  from env so it cannot accidentally flip in production. */
export const COMPOSER_REASONS_PROJECTION_ENABLED: boolean = false;

// ── Pure projection (always projects; used by the validator) ────────────────
/** Returns the composer-derived back-compat `reasons[]` projection from
 *  the contribution bundle. Pure / synchronous / no I/O. Does NOT consult
 *  the flag. Empty array when the composer produces no primary or
 *  secondary causal/generic lines. */
export function projectComposerReasonsPure(bundle: ExplanationBundle): string[] {
  return deriveBackcompatReasons(composeExplanation(bundle));
}

// ── Flag-gated projection (used by the recommender call site) ───────────────
/** Recommender entry point. When the flag is OFF (default), returns
 *  `legacyReasons` byte-identically. When the flag is ON, returns the
 *  composer projection — BUT only when that projection is non-empty;
 *  otherwise falls back to `legacyReasons` so the candidate never loses
 *  its reason line entirely. */
export function projectComposerReasons(
  bundle:        ExplanationBundle,
  legacyReasons: readonly string[],
): readonly string[] {
  if (!COMPOSER_REASONS_PROJECTION_ENABLED) return legacyReasons;
  const projected = projectComposerReasonsPure(bundle);
  // Non-empty fallback guard: an above-floor causal contribution must
  // exist for the projection to win. Without one, keep legacy so we
  // never strip a reason line that the legacy builder produced. The
  // validator covers both branches.
  return projected.length > 0 ? projected : legacyReasons;
}
