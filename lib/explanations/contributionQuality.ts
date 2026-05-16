// =============================================================================
// explanations/contributionQuality.ts — P3A-6-B contribution-based
// explanation-quality classifier
//
// Phrasing-independent classifier that derives an ExplanationQuality tier
// from typed `ScoringContribution[]` (P3A-3 output). Used ONLY when the
// composer-backed reasons projection flag
// (lib/explanations/projection.ts:COMPOSER_REASONS_PROJECTION_ENABLED) is
// true. Under the production default (flag OFF), the legacy phrasing-keyed
// `classifyExplanationQuality()` in lib/recommender.ts remains the sole
// authority for `_score_breakdown.explanation_quality`.
//
// Why this exists (P3A-6-A finding):
//   The legacy classifier matches startsWith() prefixes against the
//   variant-pool phrasings ('By {Author}, …', 'Aligns with your preference
//   for …', …). The composer (lib/explanations/compose.ts) emits a
//   different phrasing surface ('Matches your stated <key> preference',
//   'Aligns with your reading patterns', …). Flipping the composer
//   projection ON without a contribution-aware classifier degrades almost
//   every card to `weak`, and since `explanation_quality` is the primary
//   composition sort key (lib/recommender.ts L2810-2815), that shifts
//   ranking — violating P3A's no-ranking-change rule for an internal
//   integration change. This classifier closes the seam.
//
// Mapping (locked):
//   stated_taste_fit  ≥ DISPLAY_FLOORS.stated_taste_fit and
//                      evidence.matchedKey is set        → 'strong'
//   stated_taste_fit  ≥ DISPLAY_FLOORS.stated_taste_fit
//                      (no matchedKey)                   → 'acceptable_specific'
//   behavioral_fit    ≥ DISPLAY_FLOORS.behavioral_fit
//                      source='genre_affinity'           → 'acceptable_specific'
//   behavioral_fit    ≥ DISPLAY_FLOORS.behavioral_fit
//                      (aggregate, other source)         → 'acceptable_generic'
//   feedback_fit      ≥ DISPLAY_FLOORS.feedback_fit      → 'acceptable_specific'
//   quality_reliability ≥ DISPLAY_FLOORS.quality_reliability
//                      AND no other positive above-floor → 'acceptable_generic'
//   nothing above floor                                  → 'weak'
//
// Negative contributions (soft_avoid_penalty, hygiene_floor) NEVER raise
// the tier. They are surfaced through composer cautions, not as positive
// explanation evidence.
//
// `repeated_author_match` (the legacy `strong` trigger when combined with
// core_fit) is NOT yet represented as a typed contribution — it lives in
// `_score_breakdown.repeated_author_match` which the recommender writes
// independently. The legacy classifier reads that boolean directly. Until
// P3A-7 attaches it as evidence on a `behavioral_fit` contribution, this
// classifier intentionally does NOT recover the `strong` tier for repeated
// author matches that lack an above-floor stated_taste_fit. The
// no-ranking-shift validator fixture is calibrated around this gap.
// =============================================================================

import { DISPLAY_FLOORS } from '../scoring/contributions';
import type { ScoringContribution } from '../scoring/contributions';

// Local copy of the legacy ExplanationQuality union — kept here (rather
// than imported from lib/recommender.ts) to avoid a circular dependency
// between this module and the recommender. Must stay in sync.
export type ExplanationQuality =
  | 'strong'
  | 'acceptable_specific'
  | 'acceptable_generic'
  | 'weak';

// Internal numeric ranking — lower = stronger. Mirrors `explanationTier()`
// in lib/recommender.ts L2803-2808 so the composition sort comparator
// produces identical ordering whichever classifier wrote the tier.
const TIER_RANK: Readonly<Record<ExplanationQuality, number>> = {
  strong:              0,
  acceptable_specific: 1,
  acceptable_generic:  2,
  weak:                3,
};

function stronger(a: ExplanationQuality, b: ExplanationQuality): ExplanationQuality {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * Pure / synchronous / read-only. Returns the strongest tier supported by
 * any single above-floor positive scoring contribution. Negative
 * contributions are ignored (they surface as cautions in the composer,
 * not as positive explanation evidence).
 */
export function classifyContributionExplanationQuality(
  contributions: readonly ScoringContribution[],
): ExplanationQuality {
  let best: ExplanationQuality = 'weak';

  // Track whether any non-quality_reliability positive cleared its floor —
  // quality_reliability is descriptive-only and may classify
  // acceptable_generic only when it is the sole above-floor positive.
  let qualityReliabilityAboveFloor = false;
  let anyOtherPositiveAboveFloor   = false;

  for (const c of contributions) {
    if (c.value <= 0) continue;
    const floor = DISPLAY_FLOORS[c.kind];
    if (floor === undefined || c.value < floor) continue;

    switch (c.kind) {
      case 'stated_taste_fit': {
        anyOtherPositiveAboveFloor = true;
        const matchedKey =
          (c.evidence?.matchedKey as string | undefined) ?? undefined;
        // Source-based fallback: deriveScoringContributions today sets
        // contribution.source to the matched stated key (e.g.
        // 'stated_favorite:thriller_mystery'); evidence may be absent.
        const sourceCarriesKey =
          typeof c.source === 'string'
          && (c.source.startsWith('stated_favorite:')
              || c.source.startsWith('stated_softavoid:'));
        if ((matchedKey && matchedKey.length > 0) || sourceCarriesKey) {
          best = stronger(best, 'strong');
        } else {
          best = stronger(best, 'acceptable_specific');
        }
        break;
      }
      case 'behavioral_fit': {
        anyOtherPositiveAboveFloor = true;
        if (c.source === 'genre_affinity') {
          best = stronger(best, 'acceptable_specific');
        } else {
          best = stronger(best, 'acceptable_generic');
        }
        break;
      }
      case 'feedback_fit': {
        anyOtherPositiveAboveFloor = true;
        best = stronger(best, 'acceptable_specific');
        break;
      }
      case 'quality_reliability': {
        qualityReliabilityAboveFloor = true;
        // Tier upgrade applied below, only if NO other positive cleared.
        break;
      }
      // intent_fit / novelty_diversity / repetition_suppression are not
      // emitted by deriveScoringContributions today. They will land in a
      // later P3A batch; treat as conservative no-ops until then to avoid
      // overclassification on synthetic fixtures.
      default:
        break;
    }
  }

  if (qualityReliabilityAboveFloor && !anyOtherPositiveAboveFloor) {
    best = stronger(best, 'acceptable_generic');
  }

  return best;
}
