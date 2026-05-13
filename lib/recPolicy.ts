// =============================================================================
// recPolicy.ts — P1 Control-Plane policy values
//
// Centralizes numerical knobs for recommendation behavior so they stop being
// scattered as inline magic numbers across the recommender. Per the locked
// architecture spec, all values here are CALIBRATION HYPOTHESES — they are
// expected to be tuned over time without architecture changes. They are not
// architectural truths and should never be referenced as such.
//
// Ownership:
//   - P1 lands stated-pref + soft-avoid floors (this file).
//   - P3 will move all per-component scoring caps + decay knobs here too.
//   - P4+ premium scoring contributions plug in via the same shape.
// =============================================================================

import type { AffinityKey } from './taxonomy/genres';

// ── Confidence mode ──────────────────────────────────────────────────────────
//
// Derived from TasteProfile.tier; surfaces in RecRequest.policy.confidenceMode
// so downstream policy logic can vary without scattering tier branches across
// the codebase. Tier remains its own concept on TasteProfile; confidenceMode
// is the policy projection.

export type ConfidenceMode = 'cold_start' | 'thin' | 'high_signal';

export function confidenceModeForTier(tier: number): ConfidenceMode {
  if (tier <= 0) return 'cold_start';
  if (tier <= 1) return 'thin';
  return 'high_signal';
}

// ── Stated taste policy (P1) ─────────────────────────────────────────────────
//
// The locked spec requires "+0.05 floor at all tiers" for stated_taste_fit.
// This module owns the floors and tier multipliers; the recommender consumes
// `computeStatedTasteContribution` rather than re-implementing the math.
//
// Why a separate contribution rather than mutating tasteProfile.genre_affinities:
//   - tasteProfile.ts already blends prefs into affinities at tier ≤ 1
//     (the historical "onboarding genre prior" path). Removing that would
//     change tier 0/1 behavior in a P1 batch that promises retrieval/scoring
//     stability outside the intended fix. Keeping the blend AND adding a
//     parallel per-tier-floor contribution closes the tier ≥ 2 zero-effect
//     gap WITHOUT regressing tier 0/1.
//   - At tier 0/1 the new contribution is small (multiplier 1.0/0.8 × floor)
//     and additive — overlap with the existing blend is intentional and
//     bounded by STATED_PREF_BONUS_HIGH.

export type StatedTastePolicy = {
  /** Minimum positive contribution when book.primaryGenre matches a stated favorite. Always > 0. */
  prefFloor:           number;
  /** Maximum positive contribution from stated-favorite match. */
  prefBonusHigh:       number;
  /** Minimum (most-negative) contribution when book.primaryGenre matches a stated avoid. Always < 0. */
  avoidFloor:          number;
  /** Maximum (most-negative) contribution from stated-avoid match. */
  avoidPenaltyHigh:    number;
  /** Per-tier multiplier on the stated contribution. Floor never multiplies to zero. */
  tierMultipliers:     Readonly<Record<number, number>>;
};

export const STATED_TASTE_POLICY: StatedTastePolicy = {
  prefFloor:        0.05,
  prefBonusHigh:    0.12,
  avoidFloor:      -0.06,
  avoidPenaltyHigh: -0.15,
  // Tier 0/1 already get the legacy tasteProfile blend; multipliers here are
  // intentionally reduced for them so the additive overlap stays bounded.
  // Tier 2+ multipliers stay > 0 — that is the entire P1 fix.
  tierMultipliers: {
    0: 0.6,
    1: 0.7,
    2: 1.0,
    3: 1.0,
  },
};

function multiplierForTier(tier: number): number {
  const tm = STATED_TASTE_POLICY.tierMultipliers;
  if (tier <= 0) return tm[0];
  if (tier >= 3) return tm[3];
  return tm[tier] ?? 1.0;
}

// ── Pure contribution helper ─────────────────────────────────────────────────
//
// Single source of truth for stated-taste scoring math. Recommender step 7
// calls this; the validator script calls this. Pure / synchronous / no IO.
//
// Inputs:
//   - primaryGenre:    book.primaryGenre (the AffinityKey the scorer uses)
//   - statedFavorites: AffinityKey[] resolved from reader_preferences.favorite_genres
//   - statedAvoids:    AffinityKey[] resolved from reader_preferences.avoid_genres
//   - tier:            TasteProfile.tier (0..3+)
//
// Output: a contribution object the scorer adds to the running score, plus
// the floor/cap rationale tag for future explanation work (P3 will read it).

export type StatedTasteContribution = {
  bonus:    number;   // ≥ 0
  penalty:  number;   // ≤ 0
  matched:  null | { kind: 'favorite' | 'avoid'; key: AffinityKey };
  rationale: string;  // human-debug, not user-facing
};

export function computeStatedTasteContribution(
  primaryGenre:    string | null | undefined,
  statedFavorites: readonly AffinityKey[],
  statedAvoids:    readonly AffinityKey[],
  tier:            number,
): StatedTasteContribution {
  const empty: StatedTasteContribution = {
    bonus: 0, penalty: 0, matched: null, rationale: 'no_primary_genre',
  };
  if (!primaryGenre || primaryGenre === 'general') return empty;

  const mult = multiplierForTier(tier);

  // Avoid takes precedence over favorite when both somehow match — soft avoid
  // is a stronger user signal than a stale favorite. (Hard avoid lands in P4
  // as a global pre-branch exclusion; this is the soft path.)
  if (statedAvoids.includes(primaryGenre as AffinityKey)) {
    const raw = STATED_TASTE_POLICY.avoidPenaltyHigh * mult;
    const floored = Math.min(raw, STATED_TASTE_POLICY.avoidFloor); // closer to 0 than floor → use floor
    return {
      bonus:   0,
      penalty: floored,
      matched: { kind: 'avoid', key: primaryGenre as AffinityKey },
      rationale: `avoid:tier${tier}:mult${mult.toFixed(2)}`,
    };
  }

  if (statedFavorites.includes(primaryGenre as AffinityKey)) {
    const raw = STATED_TASTE_POLICY.prefBonusHigh * mult;
    const floored = Math.max(raw, STATED_TASTE_POLICY.prefFloor); // smaller than floor → use floor
    return {
      bonus:   floored,
      penalty: 0,
      matched: { kind: 'favorite', key: primaryGenre as AffinityKey },
      rationale: `favorite:tier${tier}:mult${mult.toFixed(2)}`,
    };
  }

  return empty;
}
