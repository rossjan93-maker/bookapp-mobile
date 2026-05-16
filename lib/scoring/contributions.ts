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
export const DISPLAY_FLOORS: Readonly<Record<ScoringContributionKind, number>> = {
  behavioral_fit:        0,
  stated_taste_fit:      0,
  intent_fit:            0,
  quality_reliability:   0,
  feedback_fit:          0,
  novelty_diversity:     0,
  soft_avoid_penalty:    0,
  repetition_suppression: 0,
  hygiene_floor:         0,
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
