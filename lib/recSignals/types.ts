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
  /**
   * Full reading_styles list as stored — preserved unchanged for back-compat
   * with applyStyleBoosts in lib/tasteProfile.ts which still consumes the
   * union. P4A introduces the partition fields below alongside it; no
   * existing consumer is rewired.
   */
  readingStyles:   readonly string[];
  /**
   * P4A partition (additive). `readingStylesDurable` are enduring craft
   * preferences (character-driven, plot-driven, reflective, dense prose);
   * `readingStylesIntent` are mood/pace/tone chips that a reader may toggle
   * session-to-session. A style appears in EXACTLY ONE of these arrays
   * (validator-enforced). `readingStylesUnknown` captures any stored chip
   * not yet classified, for telemetry — never silently merged.
   *
   * Behavior contract for P4A: emitted but NOT yet consumed by the scorer.
   * Forward-compat surface for P4B/P4C.
   */
  readingStylesDurable: readonly string[];
  readingStylesIntent:  readonly string[];
  readingStylesUnknown: readonly string[];
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

// ── Diagnosis-answer signal (P4A) ────────────────────────────────────────────
//
// Quick-taste answers carried explicitly so downstream code can route the
// intent-shaped subset (q_outcome / pacing / tone / what_grips) separately
// from durable answers (fic_nonfic_split, etc.). P4A introduces the typed
// surface ONLY — existing applyDiagnosisBoosts in lib/tasteProfile.ts still
// consumes the raw map unchanged. `intentScope` defaults to 'durable' with
// legacy=true for any row written before this contract landed.

export type DiagnosisAnswersSignal = {
  signalClass:   'current_intent';
  intentScope:   'session' | 'durable';
  /** true iff source row lacked an explicit intentScope key (back-compat). */
  legacy:        boolean;
  /** Subset whose keys are intent-shaped (DIAGNOSIS_INTENT_KEYS). */
  intentShaped:  Readonly<Record<string, string>>;
  /** Subset whose keys are durable-shaped (everything else). */
  durableShaped: Readonly<Record<string, string>>;
  /** Full raw answers map — preserved for back-compat consumers. */
  raw:           Readonly<Record<string, string>>;
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
  /** P4A: typed quick-taste diagnosis answers with intentScope discriminator. */
  diagnosisAnswers?:  DiagnosisAnswersSignal;
  shortTermFeedback?: ShortTermFeedbackSignal;
};
