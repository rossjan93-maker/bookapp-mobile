// =============================================================================
// recSignals/types.ts — P1 typed signal classes
//
// Per the locked Recommendation Architecture, every input the recommender
// consumes carries explicit provenance. P1 lands the smallest viable subset:
// stated_durable + revealed_behavioral + soft_avoid, with hard_avoid /
// current_intent / short_term_feedback typed for forward compatibility.
//
// Naming note: the directory is `lib/recSignals/` (not `lib/signals/`)
// because `lib/signals.ts` already exists as a tasteProfile internal helper
// for ReadingSignals (completion/dnf rate, pages-per-day). That file is a
// derived-features helper — distinct concept from this typed-control-plane
// signal model. Keeping the names disjoint avoids import ambiguity.
// =============================================================================

import type { AffinityKey } from '../taxonomy/genres';
import type { TasteProfile } from '../tasteProfile';

// ── Signal class union ───────────────────────────────────────────────────────
//
// Explicit class tag on every signal so downstream policy can branch on
// provenance instead of inferring it from shape. Hard avoid is reserved
// (P4); included so the union doesn't widen later as a breaking change.

export type SignalClass =
  | 'stated_durable'
  | 'revealed_behavioral'
  | 'soft_avoid'
  | 'hard_avoid'         // reserved for P4 (UI + storage); not consumed in P1
  | 'current_intent'
  | 'short_term_feedback';

// ── Stated durable taste ─────────────────────────────────────────────────────
//
// Sourced from reader_preferences (the Reading Taste editor). Genres are
// pre-resolved to canonical AffinityKey via normalizeGenreInput at build
// time, so the scorer never has to re-normalize. Unmappable labels are
// dropped at build time (the canonical taxonomy already telemetered them).

export type StatedTasteSignal = {
  signalClass:     'stated_durable';
  favoriteGenres:  readonly AffinityKey[];
  readingStyles:   readonly string[];
  favoriteAuthors: readonly string[];
  /** Source row updated_at; null if unknown. P1 does not use it for decay. */
  updatedAt:       number | null;
};

// ── Revealed behavioral taste ────────────────────────────────────────────────
//
// Wraps the existing TasteProfile by reference. P1 does NOT rederive any
// behavioral feature — TasteProfile remains the canonical revealed view.
// The wrapper exists so downstream code can address "revealed" as a first-
// class signal class with stable shape, and so P3+ contribution sources
// can attribute scoring math to a `revealed_behavioral` provenance tag.

export type RevealedTasteSignal = {
  signalClass: 'revealed_behavioral';
  profile:     TasteProfile;
};

// ── Soft avoid ───────────────────────────────────────────────────────────────
//
// Sourced from reader_preferences.avoid_genres. Soft = deprioritize, not
// exclude. Hard avoid (P4) will be a separate signal class with global
// pre-branch exclusion semantics. Keeping them disjoint now means P4 will
// not need to retypecheck this surface.

export type SoftAvoidSignal = {
  signalClass: 'soft_avoid';
  genres:      readonly AffinityKey[];
  updatedAt:   number | null;
};

// ── Reserved / forward-compat signal classes ─────────────────────────────────

export type CurrentIntentSignal = {
  signalClass: 'current_intent';
  /** Opaque payload — P1 carries the pre-existing NextReadIntent shape unmodified. */
  payload:     unknown | null;
};

export type ShortTermFeedbackSignal = {
  signalClass: 'short_term_feedback';
  /** Opaque payload — P1 carries the pre-existing FeedbackContext shape unmodified. */
  payload:     unknown | null;
};

// ── Aggregate ────────────────────────────────────────────────────────────────
//
// All signal classes addressable from a single root. P1 consumes
// statedTaste, revealedTaste, softAvoids; the rest are typed placeholders.

export type Signals = {
  statedTaste:        StatedTasteSignal;
  revealedTaste:      RevealedTasteSignal;
  softAvoids:         SoftAvoidSignal;
  currentIntent?:     CurrentIntentSignal;
  shortTermFeedback?: ShortTermFeedbackSignal;
};
