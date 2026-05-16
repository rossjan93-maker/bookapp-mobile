// =============================================================================
// scoring/contributions.ts — P3A typed contribution / provenance model
//
// This file defines the typed shape that P3 reasoning will live on. P3A-1
// (this batch) only LANDS the schema and the retrieval-side merge helper;
// scoring contributions are not yet populated by `scoreBookForUser`, and
// `lib/explanations/compose.ts` is not yet wired to read from contributions.
// Both ship in subsequent P3A batches.
//
// Three-phase split (per D3 / D4 architecture intent):
//   - retrieval     : where a candidate came from. May have multiple sources
//                     (D1 multi-source provenance). NOT score-summable.
//   - scoring       : signed numeric contributions to the final score. Only
//                     these participate in score-sum validation in P3A-2+.
//   - composition   : post-scoring decisions (reservation, demotion,
//                     suppression). Recorded for explanation completeness;
//                     never collapsed into a score sum.
//
// Per D4: per-kind display floors live HERE, not in lib/recPolicy.ts. They
// are inert until P3A-2 wires `compose.ts`. Default to 0 so nothing is
// gated out by accident pre-wiring.
// =============================================================================

import type { BranchKind, RetrievalSignalClass } from '../retrieval/types';

// ── Phase tag ────────────────────────────────────────────────────────────────
export type ContributionPhase = 'retrieval' | 'scoring' | 'composition';

// ── Retrieval-phase ──────────────────────────────────────────────────────────
//
// One per (candidate, branch) pairing. A candidate retrieved by both
// `statedGenres` AND `revealedLanes` carries TWO RetrievalContributions and
// has TWO entries in `_retrieval_reasons[]`. The legacy single-string
// `_retrieval_reason` is preserved as the FIRST/dominant reason
// (first-seen-wins at the dedup site) for backward compatibility with the
// statedReservation AND-gate and the cache-restore trace reconstruction.
//
// `evidence` is intentionally narrow at P3A-1 — just the raw query value
// the branch fed into the OL helper (subject string or author name). P3A-2+
// can extend.
export type RetrievalContribution = {
  phase:       'retrieval';
  /** Canonical branch identity. Foreign branches (catalog, cache restore,
   *  exact-series seed, fallback scan) carry the literal source string from
   *  the legacy `_source` / `_retrieval_reason` namespace and use 'unknown'
   *  here so this stays a closed union of real planner branches. */
  source:      BranchKind | 'catalog' | 'cached_external' | 'exact_series_seed' | 'fallback_scan' | 'unknown';
  /** The full `_retrieval_reason` prefix string, verbatim
   *  (e.g. `stated_genre:thriller_mystery`, `author_anchor:Sanderson`). */
  reason:      string;
  signalClass?: RetrievalSignalClass;
  evidence?:   { queryKind: 'subject' | 'author' | 'title'; queryValue: string };
};

// ── Scoring-phase ────────────────────────────────────────────────────────────
//
// Signed numeric contributions that, summed, equal the candidate's pre-CoG
// score. P3A-1 only LANDS this type — it is not yet attached to ScoredBook
// and `scoreBookForUser` is not yet refactored to emit it. P3A-2 will
// populate, P3A-3 will gate explanations.
export type ScoringContributionKind =
  | 'behavioral_fit'
  | 'stated_taste_fit'
  | 'intent_fit'
  | 'quality_reliability'
  | 'feedback_fit'
  | 'novelty_diversity'
  | 'soft_avoid_penalty'
  | 'repetition_suppression'
  | 'hygiene_floor';

export type ScoringContribution = {
  phase:    'scoring';
  kind:     ScoringContributionKind;
  /** Signed numeric contribution to the pre-CoG score. */
  value:    number;
  /** Optional anchor identifier (e.g. matched genre key, matched author, intent slot). */
  source?:  string;
  /** Free-form evidence payload — kept open so each kind can carry its own. */
  evidence?: Record<string, unknown>;
  /** P3A-3 explanation gate. Defaults to undefined here; per-kind display
   *  floors in DISPLAY_FLOORS decide eligibility at compose time. */
  displayEligible?: boolean;
};

// ── Composition-phase ────────────────────────────────────────────────────────
//
// Records post-scoring decisions: top-slate reservation, slate-diversity
// demotion (D3 — lib/composition/slateDiversity.ts in a later P3A batch),
// hard suppression (RIL, finished-author cap, etc.). NEVER summed into a
// score; explanation surface only.
export type CompositionEffect = 'reserved' | 'demoted' | 'suppressed' | 'promoted';

export type CompositionContribution = {
  phase:   'composition';
  kind:    string;     // e.g. 'stated_reservation' | 'slate_diversity' | 'ril' | 'continuation_cap'
  effect:  CompositionEffect;
  reason:  string;     // diagnostic, not user-facing copy
  evidence?: Record<string, unknown>;
};

// ── Discriminated union ──────────────────────────────────────────────────────
export type Contribution =
  | RetrievalContribution
  | ScoringContribution
  | CompositionContribution;

// ── Per-kind display floors (D4) ─────────────────────────────────────────────
//
// Threshold below which a positive scoring contribution is NOT eligible to
// surface as an explanation reason, even though it counted in the score
// sum. Defaults to 0 at P3A-1 (i.e. inert) — P3A-3 will set real values
// once `lib/explanations/compose.ts` is wired and the explanation-faithful-
// ness validator can measure their impact.
//
// PER D4: lives here, NOT in lib/recPolicy.ts. recPolicy is for branch
// quotas / score caps / retrieval policy. Display floors are explanation-
// faithfulness thresholds and belong with the contribution model.
//
// Calibration (P3A-4) — picked against the actual scoring scale documented
// in lib/recommender.ts Steps 1–7:
//   trait_alignment   range ~0..0.42  → behavioral_fit floor 0.10
//                                        (a single capped trait hit of
//                                        TRAIT_CONTRIB_CAP=0.18 sits above
//                                        the floor; pure subject-overlap
//                                        noise of one match (+0.02) does
//                                        not)
//   genre_bonus       range −0.18..0.22 → uses behavioral_fit floor 0.10
//                                        (STEP3_BONUS_MED=0.10 is the
//                                        explicit "above floor" threshold)
//   feedback_boost    range 0..0.10  → feedback_fit floor 0.05
//   enrichment_bonus  range 0..0.08  → quality_reliability floor 0.04
//                                        (descriptive only — never causal)
//   stated_taste      ± with +0.05 stated-pref floor → 0.04 so the policy-
//                                        guaranteed +0.05 floor surfaces
//                                        as a real reason at all tiers
//   metadata_penalty  range −0.25..+0.05 → hygiene_floor floor 0.10 (abs);
//                                        cautions fire on penalties ≤ −0.10
//   avoided_penalty   range −0.30..0 → soft_avoid_penalty floor 0.10 (abs)
//   intent_fit / novelty_diversity / repetition_suppression — not yet
//                     emitted by deriveScoringContributions(); floors set
//                     conservatively (0.04) for when scoring wires them.
export const DISPLAY_FLOORS: Readonly<Record<ScoringContributionKind, number>> = {
  behavioral_fit:         0.10,
  stated_taste_fit:       0.04,
  intent_fit:             0.04,
  quality_reliability:    0.04,
  feedback_fit:           0.05,
  novelty_diversity:      0.04,
  soft_avoid_penalty:     0.10,
  repetition_suppression: 0.04,
  hygiene_floor:          0.10,
};

// ── Reason-string → RetrievalContribution mapping (P3A-2) ────────────────────
//
// Pure classifier from the legacy `_retrieval_reason` prefix scheme (set by
// the planner branches and the OL fetch helpers in lib/recommender.ts) to a
// typed RetrievalContribution. The prefix scheme is the public contract
// between branches and downstream code; we centralize the mapping here so
// the recommender doesn't need a second copy of this knowledge.
//
// Mapping table (kept in sync with lib/retrieval/branches/* + recommender
// fetch helpers):
//
//   stated_genre:<key>             → statedGenres        / stated_durable      / subject
//   genre:<key>                    → revealedLanes       / revealed_behavioral / subject
//   lane:<key>                     → revealedLanes       / revealed_behavioral / subject
//   liked_subject:<subject>        → revealedLanes       / revealed_behavioral / subject
//   author_anchor:<author>         → revealedAuthors     / revealed_behavioral / author
//   repeated_author:<author>       → revealedAuthors     / revealed_behavioral / author
//   exact_series_seed:<series>#N   → exact_series_seed                          / title
//   local:eligible                 → catalog
//   local:fallback_scan            → fallback_scan
//   cache:restored                 → cached_external
//   <anything else>                → unknown
//
// `displayEligible` is conservatively `false` here: P3A-2 only carries
// retrieval evidence forward — the explanation-faithfulness rewire that
// turns retrieval contributions into surfaced reasons ships in P3A-3 and
// will set per-source eligibility there.
export function classifyRetrievalReason(reason: string): RetrievalContribution {
  const colon = reason.indexOf(':');
  const prefix = colon >= 0 ? reason.slice(0, colon) : reason;
  const value  = colon >= 0 ? reason.slice(colon + 1) : '';

  switch (prefix) {
    case 'stated_genre':
      return {
        phase: 'retrieval', source: 'statedGenres', reason,
        signalClass: 'stated_durable',
        evidence: { queryKind: 'subject', queryValue: value },
      };
    case 'genre':
    case 'lane':
    case 'liked_subject':
      return {
        phase: 'retrieval', source: 'revealedLanes', reason,
        signalClass: 'revealed_behavioral',
        evidence: { queryKind: 'subject', queryValue: value },
      };
    case 'author_anchor':
    case 'repeated_author':
      return {
        phase: 'retrieval', source: 'revealedAuthors', reason,
        signalClass: 'revealed_behavioral',
        evidence: { queryKind: 'author', queryValue: value },
      };
    case 'exact_series_seed':
      return {
        phase: 'retrieval', source: 'exact_series_seed', reason,
        evidence: { queryKind: 'title', queryValue: value },
      };
    case 'local': {
      // local:eligible vs local:fallback_scan — distinguish by suffix.
      const sub: 'catalog' | 'fallback_scan' =
        value === 'fallback_scan' ? 'fallback_scan' : 'catalog';
      return { phase: 'retrieval', source: sub, reason };
    }
    case 'cache':
      return { phase: 'retrieval', source: 'cached_external', reason };
    default:
      return { phase: 'retrieval', source: 'unknown', reason };
  }
}

// Map a candidate's full `_retrieval_reasons[]` to a typed contribution
// list, preserving arrival order. One contribution per reason — no
// deduplication beyond what `mergeRetrievalReasons` already enforced at
// merge time. Stable across cache restore vs. live retrieval (same
// classifier reads either path's reason strings).
export function mapRetrievalContributions(
  reasons: readonly string[],
): RetrievalContribution[] {
  return reasons.map(classifyRetrievalReason);
}

// ── Scoring-phase derivation (P3A-3) ─────────────────────────────────────────
//
// Pure projection from the existing `_score_breakdown` (+ `audit_flags`)
// into typed `ScoringContribution[]`. NO scoring math change — every field
// is read verbatim from the breakdown produced by `scoreBookForUser`.
//
// Component → kind mapping (mirrors `lib/recommender.ts` Steps 1–7):
//
//   trait_alignment   → behavioral_fit       source='preferred_traits+liked_subjects'
//                       Step 1 (preferred trait alignment, capped) + Step 1b
//                       (liked-subject overlap). Aggregate value only; the
//                       breakdown does not retain per-trait sub-attribution,
//                       so contribution.evidence is intentionally empty.
//
//   avoided_penalty   → soft_avoid_penalty   source='avoided_traits'
//                       Step 2. Aggregate (negative); no per-trait split.
//
//   genre_bonus       → behavioral_fit       source='genre_affinity'
//                       Step 3 (revealed-from-rated genre affinity). Signed
//                       — bonus or penalty. Aggregate value only.
//
//   feedback_boost    → feedback_fit         source='more_like_this'
//                       Step 4 (per-genre MLT boost). Aggregate.
//
//   enrichment_bonus  → quality_reliability  source='enrichment_signals'
//                       Step 5 — consensus traits + popularity signal.
//                       NOT personal-taste evidence; do not let downstream
//                       (P3A-4 compose) surface this as a "you like X"
//                       reason. Marker is conveyed via kind=quality_reliability
//                       and source='enrichment_signals'.
//
//   metadata_penalty  → hygiene_floor        source='metadata+subtype_drift'
//                       Step 6 (metadata-quality penalty) + 7b/7c (noir /
//                       spy / philosophy / literary / graphic-format drift
//                       penalties + commercial-prior boost), already floored
//                       at S6_PENALTY_FLOOR. Aggregate — the recommender
//                       does not retain per-rule attribution beyond the
//                       string entries in `audit_flags`. Treated as a
//                       hygiene/drift penalty for explanation purposes.
//
//   stated_taste      → stated_taste_fit     source=matched stated key (when
//                       audit_flags carries `stated_favorite:<key>` or
//                       `stated_softavoid:<key>` from `computeStatedTasteContribution`).
//                       The ONLY scoring component with per-signal evidence
//                       attribution today (via audit_flags). Other kinds
//                       must wait for P3A-5+ to gain real attribution.
//
// Components from the existing model deferred (not emitted):
//   - intent_fit / novelty_diversity / repetition_suppression — not yet
//     implemented as breakdown fields in `scoreBookForUser`. Listed in the
//     locked architecture for P3 but require scoring-side wiring outside
//     P3A-3's "represent current math" scope.
//
// Zero/absent components produce NO contribution entry — explicit silence
// rather than a zero-valued contribution avoids polluting the eligibility
// check downstream consumers will do (P3A-4 compose, sum invariant tests).
//
// `displayEligible` is intentionally left undefined here. The P3A-4
// explanation rewire owns per-kind eligibility (gated by DISPLAY_FLOORS).
// =============================================================================

/** Minimal shape this helper reads from `_score_breakdown`. Mirrors the
 *  `ScoreBreakdown` type in `lib/recommender.ts` but kept local so this
 *  module stays free of a circular dependency on the recommender. */
export type ScoreBreakdownLike = {
  trait_alignment:  number;
  avoided_penalty:  number;
  genre_bonus:      number;
  feedback_boost:   number;
  enrichment_bonus: number;
  metadata_penalty: number;
  stated_taste?:    number;
  raw_score:        number;
};

/** Parse a single `audit_flags[]` entry that records stated-taste match
 *  evidence (`stated_favorite:<key>` / `stated_softavoid:<key>`), if any. */
function findStatedTasteEvidence(
  audit_flags: readonly string[],
): { kind: 'favorite' | 'softavoid'; key: string } | null {
  for (const f of audit_flags) {
    if (f.startsWith('stated_favorite:')) {
      return { kind: 'favorite', key: f.slice('stated_favorite:'.length) };
    }
    if (f.startsWith('stated_softavoid:')) {
      return { kind: 'softavoid', key: f.slice('stated_softavoid:'.length) };
    }
  }
  return null;
}

/** Derive typed scoring-phase contributions from an existing
 *  `_score_breakdown` + `audit_flags`. Pure / synchronous / read-only. */
export function deriveScoringContributions(
  breakdown:   ScoreBreakdownLike,
  audit_flags: readonly string[] = [],
): ScoringContribution[] {
  const out: ScoringContribution[] = [];

  if (breakdown.trait_alignment !== 0) {
    out.push({
      phase: 'scoring', kind: 'behavioral_fit',
      value: breakdown.trait_alignment,
      source: 'preferred_traits+liked_subjects',
    });
  }
  if (breakdown.avoided_penalty !== 0) {
    out.push({
      phase: 'scoring', kind: 'soft_avoid_penalty',
      value: breakdown.avoided_penalty,
      source: 'avoided_traits',
    });
  }
  if (breakdown.genre_bonus !== 0) {
    out.push({
      phase: 'scoring', kind: 'behavioral_fit',
      value: breakdown.genre_bonus,
      source: 'genre_affinity',
    });
  }
  if (breakdown.feedback_boost !== 0) {
    out.push({
      phase: 'scoring', kind: 'feedback_fit',
      value: breakdown.feedback_boost,
      source: 'more_like_this',
    });
  }
  if (breakdown.enrichment_bonus !== 0) {
    out.push({
      phase: 'scoring', kind: 'quality_reliability',
      value: breakdown.enrichment_bonus,
      source: 'enrichment_signals',
    });
  }
  if (breakdown.metadata_penalty !== 0) {
    out.push({
      phase: 'scoring', kind: 'hygiene_floor',
      value: breakdown.metadata_penalty,
      source: 'metadata+subtype_drift',
      // The drift sub-rules that fired are visible in audit_flags
      // (noir_drift / spy_drift / philosophy_drift / literary_drift /
      // weak_metadata / classic_signal / graphic_format / etc.) — pass
      // them through as evidence so any future surface can disambiguate
      // without re-parsing the recommender.
      evidence: { audit_subflags: audit_flags.filter(f =>
           f === 'weak_metadata'
        || f === 'classic_signal'
        || f === 'noir_drift'
        || f === 'noir_drift_confirmed'
        || f === 'spy_drift'
        || f === 'philosophy_drift'
        || f === 'literary_drift'
        || f === 'graphic_format'
      ) },
    });
  }
  const stated = breakdown.stated_taste ?? 0;
  if (stated !== 0) {
    const ev = findStatedTasteEvidence(audit_flags);
    out.push({
      phase: 'scoring', kind: 'stated_taste_fit',
      value: stated,
      source: ev ? `stated_${ev.kind}:${ev.key}` : 'stated_taste',
      ...(ev ? { evidence: { matchedKind: ev.kind, matchedKey: ev.key } } : {}),
    });
  }

  return out;
}

// ── Retrieval-phase merge helper (D1) ────────────────────────────────────────
//
// Single source of truth for accumulating `_retrieval_reasons[]` when the
// merge/dedup loop in `getOLCandidates` (lib/recommender.ts) sees the same
// candidate returned by multiple branches.
//
// Contract:
//   - `existing` is the list already attached to the kept candidate
//     (first-seen-wins at the dedup site).
//   - `incoming` is the reason string from the duplicate that is being
//     dropped from the merged list.
//   - Returns a NEW array: existing reasons in order, then `incoming`
//     appended ONLY if not already present (case-sensitive exact match —
//     reason strings are machine-generated with stable prefixes so no
//     normalization is needed).
//   - Order is meaningful: `existing[0]` is the dominant reason and MUST
//     equal the candidate's legacy `_retrieval_reason` field for the
//     P2B.1 stated-reservation AND-gate (statedReservation.ts) and the
//     cache-restore trace reconstruction (recommender.ts cache_hit branch)
//     to keep working without changes.
//
// Pure / synchronous / no I/O. Tested by
// scripts/validate_multi_source_provenance.ts.
export function mergeRetrievalReasons(
  existing: readonly string[],
  incoming: string,
): string[] {
  if (!incoming) return [...existing];
  if (existing.includes(incoming)) return [...existing];
  return [...existing, incoming];
}
