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

export type ConfidenceMode =
  | 'zero_signal'        // tier 0, no intake boost — true net-new account
  | 'sparse_onboarding'  // tier 0 raw, intake-boosted (onboarded but no library)
  | 'thin'               // tier 1 from real signal (no boost dependency)
  | 'high_signal';       // tier 2 or 3 — mature-profile invariant

// Phase B.0 (2026-05-26): ConfidenceMode split 3 → 4. `cold_start` retired as
// a mode value; the "tier 0, no real history" lattice position is now
// expressed via two states: `zero_signal` (auth-new, no onboarding) and
// `sparse_onboarding` (onboarded with favorite genres, no library yet).
// The Phase B `coldStartAdjacent=3` quota moves from the (unreachable in
// practice) cold_start mode to sparse_onboarding, which is the product state
// the Phase B planning chapter actually targeted. See
// docs/plan_phase_b0_tier_definition_cleanup.md.
//
// `rawTier` is the tier computed from the UNBOOSTED strongSignalCount.
// `intakeBoosted` is the new TasteProfile flag indicating the intake-boost
// predicate fired (intake_completed=true AND favorite_genres.length > 0 AND
// strongSignalCount < 5).
export function confidenceModeForTier(
  rawTier:       number,
  intakeBoosted: boolean,
): ConfidenceMode {
  if (rawTier >= 2) return 'high_signal';
  if (rawTier === 1) return 'thin';
  // rawTier <= 0
  return intakeBoosted ? 'sparse_onboarding' : 'zero_signal';
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

// ── P2A: branch planner quotas ───────────────────────────────────────────────
//
// Per-branch retrieval quotas keyed off confidenceMode. These are the
// maximum FetchItem counts each branch may emit, BEFORE BuildCause modifier
// and soft-avoid multiplier. Calibration hypotheses; tunable without
// architecture change.
//
// Plan-size invariant: sum across branches at every confidenceMode is ≤ 11
// (the pre-P2A maximum), so OL load characteristics are preserved. The
// statedGenres quota is intentionally non-zero at every confidenceMode —
// that is the entire P2A retrieval-side fix mirroring the P1 scoring fix.

export type BranchQuotas = {
  statedGenres:       number;
  revealedAuthors:    number;
  revealedLanes:      number;
  /** Cold-Start Retrieval Expansion · Phase B (live).
   *  Phase A shipped this slot at quota=0 everywhere (production-inert).
   *  Phase B (2026-05-21) introduced live admission at cold_start=3.
   *  Phase B.0 (2026-05-26) RE-KEYS the live quota: the ConfidenceMode union
   *  split (cold_start → {zero_signal, sparse_onboarding}) moves the live
   *  `=3` quota onto BOTH new tier-0 modes. thin and high_signal MUST stay 0:
   *    - thin: real-library tier-1 user; whether adjacency helps here is a
   *      Phase B.1 question with its own evidence cycle.
   *    - high_signal: mature-profile byte-identity invariant (pinned by
   *      scripts/validate_cold_start_adjacent.ts §5; broadened in Phase B.0
   *      to include thin).
   *  Branch runs LAST in BRANCH_ORDER so primary branches always win quota
   *  races. ANY change to these numbers MUST bump
   *  COLD_START_RETRIEVAL_POLICY_VERSION below — that constant is folded into
   *  the recValidity hash so cached decks invalidate cleanly. */
  coldStartAdjacent:  number;
};

export const BRANCH_QUOTAS: Readonly<Record<ConfidenceMode, BranchQuotas>> = {
  // Zero signal: auth-new user, no onboarding intake. Same retrieval recipe
  // as sparse_onboarding — both are tier-0 raw; splitting at the type level
  // future-proofs the surface without forcing a numeric difference now.
  zero_signal:       { statedGenres: 4, revealedAuthors: 1, revealedLanes: 5, coldStartAdjacent: 3 },
  // Sparse onboarding: intake-boosted tier-0 user. THE primary target of
  // Cold-Start Retrieval Expansion Phase B — adjacency injection runs here
  // for favorites that map to populated adjacency entries (Mystery + Thriller
  // only in the current slice).
  sparse_onboarding: { statedGenres: 4, revealedAuthors: 1, revealedLanes: 5, coldStartAdjacent: 3 },
  // Thin (real-library tier 1, strong=5..9): library starts to anchor the
  // deck. coldStartAdjacent stays 0 — Phase B.1 may revisit with its own
  // evidence; Phase B.0 explicitly does not pre-commit.
  thin:              { statedGenres: 4, revealedAuthors: 1, revealedLanes: 5, coldStartAdjacent: 0 },
  // High signal (dense / tier ≥ 2): revealed dominates BUT stated keeps a
  // material seat at the table — the pre-P2A bug was statedGenres = 0 here.
  // coldStartAdjacent stays 0 here forever (mature-profile invariant).
  high_signal:       { statedGenres: 3, revealedAuthors: 3, revealedLanes: 4, coldStartAdjacent: 0 },
};

// ── Cold-Start Retrieval Policy Version (Phase B) ────────────────────────────
//
// Explicit, stable, traceable retrieval-policy identifier folded into the
// recValidity hash via lib/recValidity.ts. Bump this constant on any
// MEANINGFUL change to cold-start retrieval policy (BRANCH_QUOTAS for
// coldStartAdjacent, anchor set, branch order placement, soft-avoid
// defense-in-depth rule). Bumping invalidates any persisted rec payload
// whose hash was computed under the old policy version — the user gets a
// fresh deck on next foreground without an explicit prefs edit.
//
// Why a constant rather than serialising BRANCH_QUOTAS into the hash:
// future retrieval-policy changes should be INTENTIONAL and TRACEABLE.
// Serialising the object would silently invalidate every device every time
// any unrelated quota tweaked (e.g., statedGenres for high_signal). A
// constant means a change is opt-in, code-reviewable, and grep-discoverable.
//
// History:
//   csrp1 (2026-05-21) — Phase B initial live admission:
//                        cold_start.coldStartAdjacent 0 → 3.
//   csrp2 (2026-05-26) — Phase B.0 re-keying: cold_start retired as a
//                        ConfidenceMode value; live quota=3 moves to
//                        zero_signal AND sparse_onboarding. thin and
//                        high_signal stay 0 (mature-profile invariant
//                        broadened to both).
// csrp3 (2026-06-22) — rawTier fix: recRequest now passes profile.rawTier
// into confidenceModeForTier, correctly routing intake-only users to
// sparse_onboarding (quota=3) instead of thin (quota=0). No quota values
// changed; this bump ensures decks built under csrp2 (wrong mode) are
// discarded and rebuilt under the correct classification.
export const COLD_START_RETRIEVAL_POLICY_VERSION = 'csrp3';

/** BuildCause = 'explicit_preference_edit': boost stated, trim lanes,
 *  net plan size unchanged. Other causes leave quotas at base. */
export const EDIT_CAUSE_BRANCH_BOOST: { statedGenres: number; revealedLanes: number } = {
  statedGenres:  +1,
  revealedLanes: -1,
};

/** Multiplier applied to revealedLanes quota when the user's dominant lanes
 *  OR topGenres (P2C) intersect their soft-avoids. 0.5 = retrieve half as
 *  much from a lane the user said they want less of. Floored at 1 so the
 *  branch never zeroes out (revealed lanes still inform some retrieval —
 *  soft avoid is not exclude). */
export const SOFT_AVOID_RETRIEVAL_MULTIPLIER = 0.5;

// ── P2C: liked-subject guard list + local soft-avoid classifier ──────────────
//
// `liked_subjects` are free-form strings sourced from books the user has rated
// well. They aren't AffinityKeys, so the per-anchor mask in revealedLanes
// can't filter them by AffinityKey equality. The guard list maps each
// AffinityKey to a small curated set of substring patterns that obviously
// belong to that key. A liked_subject whose lower-cased value contains any
// guard substring for a *soft-avoided* key is dropped at the anchor stage.
//
// Doubles as the local-candidate classifier (subject → soft-avoided
// AffinityKey) consumed by lib/retrieval/softAvoidLocal.ts. Guard substrings
// are intentionally narrow and unambiguous — bias toward false negatives
// (let a borderline subject through) rather than false positives (drop a
// subject the user actually wants). Editable without architecture change.
//
// Empty-by-default safe: if a key is absent here, the local classifier
// returns null for it and the liked_subject loop skips the guard check.
//
// Key universe matches `lib/taxonomy/genres.ts` AffinityKey union.

export const LIKED_SUBJECT_AVOID_GUARDS: Partial<Record<AffinityKey, readonly string[]>> = {
  fantasy_scifi:    ['fantasy', 'sci-fi', 'sci fi', 'science fiction', 'dystopian', 'wizard', 'dragon', 'magic', 'epic'],
  thriller_mystery: ['thriller', 'mystery', 'detective', 'whodunit', 'noir', 'crime fiction', 'suspense'],
  horror:           ['horror', 'supernatural', 'gothic', 'haunted', 'occult'],
  romance:          ['romance', 'romantic', 'love story', 'rom-com'],
  literary:         ['literary fiction'],
  memoir_bio:       ['memoir', 'biography', 'autobiography'],
  nonfiction:       ['business', 'economics', 'self-help', 'self help', 'science writing'],
};

// ── P2B: BuildCause-aware top-slate reservation policy ───────────────────────
//
// After an explicit_preference_edit, guarantee that at least one quality-
// clearing stated-branch candidate can surface in the top slate. Lives in the
// composition layer (NOT retrieval — P2A handles retrieval-side stated influx).
// Surgical slate-assembly knob; consumed by lib/composition/statedReservation.ts.
//
// Calibration hypotheses; tunable without architectural change.

import type { BuildCause } from './recRequest';

export type StatedReservationPolicy = {
  /** Causes that trigger a top-slate reservation attempt. */
  eligibleCauses:            readonly BuildCause[];
  /** Maximum slots reserved per pipeline call. P2B ships with 1; multi-slot
   *  reservation is P3 slate-diversity territory. NOTE: today this value is
   *  informational — it is enforced by `pickStatedReservation`'s API shape
   *  (single `pick` return). Raising this constant alone will NOT cause more
   *  slots to be reserved; the helper signature must change first. */
  maxReservedSlots:          number;
  /** When false, only CORE candidates may be reserved. Conservative default —
   *  setting true would silently widen ADJACENT exposure on every pref edit. */
  allowAdjacentReservation:  boolean;
  /** Per-cause allowlist that widens reservation to ADJACENT candidates
   *  ONLY for the listed BuildCauses, while keeping the global default
   *  (allowAdjacentReservation) conservative. Required for the Phase 2
   *  product contract: a dense user editing toward an off-lane genre
   *  routinely produces adjacent_fit (not core_fit) stated candidates,
   *  and core-only reservation cannot honor the "visible deck shift after
   *  pref edit, dense users included" pre-beta gate. All other P2B.1
   *  AND-gates (retrieval provenance, scoring provenance, positive
   *  stated_taste, non-weak metadata, composition caps) still apply. */
  allowAdjacentForCauses:    readonly BuildCause[];
};

export const STATED_RESERVATION_POLICY: StatedReservationPolicy = {
  eligibleCauses:           ['explicit_preference_edit'],
  maxReservedSlots:         1,
  allowAdjacentReservation: false,
  allowAdjacentForCauses:   ['explicit_preference_edit'],
};

// ── P4C.1: limited ranking influence for current intent / semantic-fit ──────
//
// First P4 batch that lets P4C contribution kinds carry signed score values.
// All values are calibration hypotheses, intentionally conservative so P4C.1
// SHAPES the deck rather than DOMINATES it. Caps below are validator-enforced
// by scripts/validate_p4c_limited_ranking.ts.
//
// Locked properties (do not silently relax these — bump the policy version
// and the validators in lockstep):
//   - perKindAbsCap   : no single P4C kind may contribute more than ±0.20.
//   - stackPosCap     : total of positive P4 contributions cannot exceed +0.30.
//   - stackNegCap     : total of negative P4 contributions cannot exceed -0.30.
//   - stated-taste protection: when a candidate has positive stated_taste
//     (stated favorite match), the P4 NEGATIVE stack is clamped to
//     max(stackNegCap, -stated_taste) so the stated +0.05 floor is never
//     fully erased by P4 nudges. Mirrored for negative stated_taste
//     (stated avoid match) against the P4 positive stack.
//   - kinds whose evidence is "negative or neutral only" (avoidance_conflict,
//     not_right_now_risk) NEVER emit a positive value.

export type P4cLimitedRankingPolicy = {
  perKindAbsCap:        number;
  stackPosCap:          number;
  stackNegCap:          number;
  toneFitMatch:         number;
  toneFitMismatch:      number;
  paceFitMatch:         number;
  paceFitMismatch:      number;
  complexityFitMatch:   number;
  complexityFitMismatch: number;
  seriesContinuation:   number;
  currentIntentFit:     number;
  avoidanceConflictPerHit: number;
  notRightNowRiskPerAxis:  number;
};

export const P4C_LIMITED_RANKING_POLICY: P4cLimitedRankingPolicy = {
  perKindAbsCap:           0.20,
  stackPosCap:             0.30,
  stackNegCap:            -0.30,
  toneFitMatch:            0.06,
  toneFitMismatch:        -0.06,
  paceFitMatch:            0.04,
  paceFitMismatch:        -0.04,
  complexityFitMatch:      0.04,
  complexityFitMismatch:  -0.04,
  seriesContinuation:      0.10,
  currentIntentFit:        0.02,
  avoidanceConflictPerHit:-0.08,
  notRightNowRiskPerAxis: -0.06,
};

/** Apply the P4C.1 stack caps + stated-taste protection to a raw P4 sum.
 *  Pure / synchronous. Inputs:
 *    - positives: sum of positive P4 contribution values (each already
 *      capped at perKindAbsCap at emit time).
 *    - negatives: sum of negative P4 contribution values (each already
 *      capped at -perKindAbsCap at emit time).
 *    - statedTaste: the candidate's stated_taste breakdown value (signed).
 *  Output: the net P4 stack adjustment to apply to the candidate score. */
export function clampP4IntentStack(
  positives:    number,
  negatives:    number,
  statedTaste:  number,
): number {
  const { stackPosCap, stackNegCap } = P4C_LIMITED_RANKING_POLICY;
  // 1. Stack caps first.
  let pos = Math.min(positives, stackPosCap);
  let neg = Math.max(negatives, stackNegCap);
  // 2. Stated-taste floor protection. When stated_taste is positive (favorite
  //    match), keep |neg| ≤ stated_taste so the stated bump survives. When
  //    stated_taste is negative (avoid match), keep pos ≤ |stated_taste| so
  //    the stated penalty survives.
  if (statedTaste > 0 && neg < -statedTaste) neg = -statedTaste;
  if (statedTaste < 0 && pos >  -statedTaste) pos = -statedTaste;
  return pos + neg;
}
