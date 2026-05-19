// =============================================================================
// lib/currentIntentLens.ts — P4C.1 follow-up · session-lens view-model
//
// Pure derived classifier over a `NextReadIntent` and (optionally) a
// `TasteProfile`. Translates the existing chip-driven intent object into
// three behavior tiers + a stated-favorite conflict report.
//
// Scope (locked):
//   - Read-only. Does NOT mutate `NextReadIntent`, `reader_preferences`,
//     `tasteProfile`, or any cache.
//   - Behavior-neutral. The legacy `hard.*` / `exclude.*` rule object is
//     still the source of truth for retrieval + ranking today. This file
//     is the seam future batches will use to (a) emit typed `current_intent`
//     signals from chips, (b) move "Less X" chips off legacy hard excludes
//     onto `not_right_now_risk` / `avoidance_conflict` P4C contributions,
//     and (c) drive an inline "X books hidden by this lens" affordance.
//
// What this file DOES NOT do (deferred — explicit implementation seams):
//   - It does not change ranking math. `clampP4IntentStack` is unaffected.
//   - It does not change retrieval — `getIntentExclusionReason` is still
//     the gate.
//   - It does not write the conflict UI — `detectStatedFavoriteConflicts`
//     returns descriptors only; the surface that consumes them is a
//     separate batch.
//   - It does not persist lens state. The lens is session-only by contract.
//
// Origin: P4C.1 product acceptance + Your-Next-Read vs Reading-Taste
// semantics audit (2026-05-16). See replit.md phase status row for P4C.1.
// =============================================================================

import type { NextReadIntent, ReadingEnergyMode } from './nextReadIntent';

// ── Tier model ───────────────────────────────────────────────────────────────
//
// hard          — must-not-violate session rules. Books matching these are
//                 removed from the deck pre-scoring via
//                 `getIntentExclusionReason` or a hard.* filter.
// soft          — directional nudges. Reorder the deck without removing.
//                 Today these are pure UI-soft (handleApplyIntent only
//                 records them on `intent.soft`; the ranking soft-boost
//                 contribution is intentionally tiny so chip selections
//                 visibly act through their accompanying hard rule).
// notRightNow   — "less of X, not none of X" preferences. Today these are
//                 implemented as hard excludes (the "Less dark" chip really
//                 hides dark content). Future batches will route these
//                 through the P4C `not_right_now_risk` contribution so the
//                 caps and stated-taste floor protection apply.

export type IntentLensTier = 'hard' | 'soft' | 'notRightNow';

export type IntentLensEntry = {
  /** Stable id used for telemetry / future signal binding. */
  id: string;
  /** User-facing label matching the chip the user picked. */
  label: string;
  /** Tier this entry currently behaves as in production. */
  tier: IntentLensTier;
  /**
   * Free-text describing the effect (used for the future "what is this
   * lens doing?" affordance — do not surface raw rule keys to users).
   */
  effect: string;
  /**
   * The legacy rule key(s) this entry corresponds to. Used by the
   * conflict detector and (future) signal binder. Optional because
   * pure soft chips do not produce a legacy rule.
   */
  legacyRules?: string[];
};

export type CurrentIntentLens = {
  active:        boolean;
  hard:          IntentLensEntry[];
  soft:          IntentLensEntry[];
  notRightNow:   IntentLensEntry[];
  /** Total entries across all tiers. */
  totalEntries:  number;
};

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Derives the lens view-model from the live `NextReadIntent`.
 *
 * Behavior contract: any chip the user picks shows up in exactly one tier.
 * Today the tier assignment reflects PRODUCTION behavior (e.g. "Less dark"
 * lives in `hard` because it currently performs a hard exclude.avoid_dark
 * exclusion). A future batch that moves "Less X" chips onto P4C signed
 * contributions will reclassify them into `notRightNow` here — that is
 * the only change required on the consumer side.
 */
export function classifyIntentLens(intent: NextReadIntent | null | undefined): CurrentIntentLens {
  const empty: CurrentIntentLens = {
    active: false, hard: [], soft: [], notRightNow: [], totalEntries: 0,
  };
  if (!intent) return empty;

  const hard:        IntentLensEntry[] = [];
  const soft:        IntentLensEntry[] = [];
  const notRightNow: IntentLensEntry[] = [];

  // ── Hard exclusions (the "No X" tier + length/format/standalone) ─────────
  const e = intent.exclude ?? {};
  const h = intent.hard    ?? {};

  if (e.avoid_dark) {
    hard.push({
      id: 'avoid_dark', label: 'No dark', tier: 'hard',
      effect: 'Hides books with dark/disturbing content signals',
      legacyRules: ['exclude.avoid_dark'],
    });
  }
  if (e.avoid_literary) {
    hard.push({
      id: 'avoid_literary', label: 'No literary', tier: 'hard',
      effect: 'Hides books classified as literary-prestige',
      legacyRules: ['exclude.avoid_literary'],
    });
  }
  if (e.avoid_romance) {
    hard.push({
      id: 'avoid_romance', label: 'No romance', tier: 'hard',
      effect: 'Hides romance and romantasy market positions',
      legacyRules: ['exclude.avoid_romance'],
    });
  }
  if (e.avoid_classics) {
    hard.push({
      id: 'avoid_classics', label: 'No classics', tier: 'hard',
      effect: 'Hides classic-canon market position',
      legacyRules: ['exclude.avoid_classics'],
    });
  }
  if (e.avoid_nonfiction) {
    hard.push({
      id: 'avoid_nonfiction', label: 'No nonfiction', tier: 'hard',
      effect: 'Hides nonfiction',
      legacyRules: ['exclude.avoid_nonfiction'],
    });
  }
  if (e.avoid_series) {
    hard.push({
      id: 'avoid_series', label: 'No series', tier: 'hard',
      effect: 'Hides books that are part of a series',
      legacyRules: ['exclude.avoid_series'],
    });
  }
  if (h.fiction_only) {
    hard.push({
      id: 'fiction_only', label: 'Fiction only', tier: 'hard',
      effect: 'Shows only fiction',
      legacyRules: ['hard.fiction_only'],
    });
  }
  if (h.nonfiction_only) {
    hard.push({
      id: 'nonfiction_only', label: 'Nonfiction only', tier: 'hard',
      effect: 'Shows only nonfiction',
      legacyRules: ['hard.nonfiction_only'],
    });
  }
  if (h.standalone_only) {
    hard.push({
      id: 'standalone_only', label: 'Standalone', tier: 'hard',
      effect: 'Hides series entries',
      legacyRules: ['hard.standalone_only'],
    });
  }
  if (typeof h.max_page_count === 'number') {
    hard.push({
      id: 'max_page_count', label: `Under ${h.max_page_count}p`, tier: 'hard',
      effect: `Hides books over ${h.max_page_count} pages`,
      legacyRules: ['hard.max_page_count'],
    });
  }

  // ── Soft preferences + notRightNow (P4C.1 follow-up batch) ─────────────
  //
  // After the chip→typed signal plumbing batch, these chips emit typed
  // `current_intent` signals through `nextReadChips` and flow through
  // `deriveP4CContributions` (tone_fit / pace_fit / not_right_now_risk).
  // No accompanying `exclude.*` rules are written.
  //
  // Tier assignment:
  //   - `soft`        — pure directional nudges with no negative implication
  //                     ("prefer faster", "prefer immersive")
  //   - `notRightNow` — directional nudges that imply demoting the opposite
  //                     ("Less dark" → prefer light, demote dark; same for
  //                     "Light & accessible" and "Short & light"). These
  //                     used to be hard excludes — now they are signed
  //                     contributions under the P4C.1 caps.
  const s = intent.soft ?? {};
  if (s.pace === 'fast') {
    soft.push({ id: 'pace_fast', label: 'Fast-paced', tier: 'soft',
      effect: 'Prefer faster-paced books (typed chip signal)' });
  }
  if (s.pace === 'slow') {
    soft.push({ id: 'pace_slow', label: 'Slow burn', tier: 'soft',
      effect: 'Prefer slower-paced books (typed chip signal)' });
  }
  if (s.tone === 'dark') {
    soft.push({ id: 'tone_dark', label: 'Dark / serious', tier: 'soft',
      effect: 'Prefer darker tone (typed chip signal; overrides light-inferring chips)' });
  }
  if (s.intensity === 'high') {
    soft.push({ id: 'intensity_high', label: 'High intensity', tier: 'soft',
      effect: 'Prefer emotionally intense books (typed chip signal)' });
  }
  const ENERGY_SOFT_LABELS: Partial<Record<ReadingEnergyMode, string>> = {
    immersive:         'Immersive',
    deep_demanding:    'Deep & demanding',
    emotionally_heavy: 'Emotionally heavy',
  };
  if (s.readingEnergy && ENERGY_SOFT_LABELS[s.readingEnergy]) {
    soft.push({
      id: `energy_${s.readingEnergy}`,
      label: ENERGY_SOFT_LABELS[s.readingEnergy]!,
      tier: 'soft',
      effect: 'Energy preference (typed chip signal — soft nudge)',
    });
  }

  // notRightNow — chips with light-tone implication that demote dark books
  // via the typed signal, instead of removing them via a hard exclude.
  if (s.intensity === 'low') {
    notRightNow.push({
      id: 'intensity_low', label: 'Less dark', tier: 'notRightNow',
      effect: 'Prefer lighter tone; demotes dark books under P4C.1 caps (no hard removal)',
    });
  }
  if (s.readingEnergy === 'light_fun') {
    notRightNow.push({
      id: 'energy_light_fun', label: 'Light & accessible', tier: 'notRightNow',
      effect: 'Prefer lighter, less-literary feel; demotes dark / dense books under P4C.1 caps',
    });
  }
  if (s.readingEnergy === 'palate_cleanser') {
    notRightNow.push({
      id: 'energy_palate_cleanser', label: 'Short & light', tier: 'notRightNow',
      effect: 'Prefer lighter tone via typed signal; length cap (≤400p) remains a hard rule',
    });
  }

  const totalEntries = hard.length + soft.length + notRightNow.length;
  return {
    active: totalEntries > 0,
    hard,
    soft,
    notRightNow,
    totalEntries,
  };
}

// ── Stated-favorite conflict detector ────────────────────────────────────────

export type StatedFavoriteConflict = {
  /** Lens entry that conflicts with a stated favorite. */
  lensEntry: IntentLensEntry;
  /** What in the durable taste it conflicts with. */
  statedFavorite: {
    kind:  'genre' | 'reading_style';
    value: string;
  };
  /**
   * Human-readable explanation suitable for an inline affordance.
   * Surface unchanged by this batch — consumer is responsible for the UI.
   */
  message: string;
};

/**
 * Detect when the session lens hides books the user has stated as favorites.
 *
 * Today the only conflicts we can detect are:
 *   - `exclude.avoid_romance` while `favorite_genres` includes 'romance'
 *   - `exclude.avoid_nonfiction` while `favorite_genres` contains a
 *     nonfiction-affinity genre (history, biography, science, ...)
 *   - `hard.fiction_only` while every favorite is nonfiction-affinity
 *   - `hard.nonfiction_only` while every favorite is fiction-affinity
 *
 * Returns an empty array when the lens is inactive, the profile is
 * unavailable, or no conflicts apply. Designed to be cheap to call on
 * every deck render — pure synchronous, no allocations beyond the result.
 *
 * Implementation seam: the UI affordance ("Hiding 14 books from your
 * Romance favorite — clear lens") consumes this return value. That UI is
 * intentionally deferred to a follow-up batch so this file ships
 * behavior-neutral.
 */
export function detectStatedFavoriteConflicts(
  intent:         NextReadIntent | null | undefined,
  /**
   * Plain list of the user's stated favorite genre keys (e.g. from
   * `reader_preferences.favorite_genres`). Caller normalises shape so
   * this helper stays decoupled from any specific profile type — the
   * conflict detector only needs the favorites list.
   */
  favoriteGenres: readonly string[] | null | undefined,
): StatedFavoriteConflict[] {
  if (!intent || !favoriteGenres) return [];
  const lens = classifyIntentLens(intent);
  if (!lens.active) return [];

  const favs = new Set(
    favoriteGenres
      .filter((x): x is string => typeof x === 'string')
      .map(s => s.toLowerCase().trim())
      .filter(s => s.length > 0),
  );
  if (favs.size === 0) return [];

  const out: StatedFavoriteConflict[] = [];
  const NONFICTION_AFFINITIES = new Set([
    'history', 'biography', 'science', 'self_help', 'business',
    'politics', 'reference', 'health', 'nonfiction', 'memoir_nonfiction',
  ]);
  const FICTION_FAVORITES = (() => {
    const s = new Set<string>();
    for (const f of favs) if (!NONFICTION_AFFINITIES.has(f)) s.add(f);
    return s;
  })();

  for (const entry of lens.hard) {
    if (entry.id === 'avoid_romance' && favs.has('romance')) {
      out.push({
        lensEntry: entry,
        statedFavorite: { kind: 'genre', value: 'romance' },
        message: 'Hiding romance picks while this lens is active — your Reading Taste still includes Romance.',
      });
    }
    if (entry.id === 'avoid_nonfiction') {
      for (const f of favs) {
        if (NONFICTION_AFFINITIES.has(f)) {
          out.push({
            lensEntry: entry,
            statedFavorite: { kind: 'genre', value: f },
            message: `Hiding nonfiction while this lens is active — your Reading Taste includes ${f}.`,
          });
          break;
        }
      }
    }
    if (entry.id === 'fiction_only') {
      for (const f of favs) {
        if (NONFICTION_AFFINITIES.has(f)) {
          out.push({
            lensEntry: entry,
            statedFavorite: { kind: 'genre', value: f },
            message: `Hiding nonfiction while this lens is active — your Reading Taste includes ${f}.`,
          });
          break;
        }
      }
    }
    if (entry.id === 'nonfiction_only' && FICTION_FAVORITES.size > 0) {
      const f = [...FICTION_FAVORITES][0];
      out.push({
        lensEntry: entry,
        statedFavorite: { kind: 'genre', value: f },
        message: `Hiding fiction while this lens is active — your Reading Taste includes ${f}.`,
      });
    }
  }
  return out;
}

// =============================================================================
// Lens-vs-Taste Steering — Phase 1 (shadow-mode arbitration field)
//
// Session-only steering mode controlling how much the active intent lens is
// allowed to override durable Reading Taste. Phase 1 is contract-only:
//   - `getSessionSteering()` is consumed ONLY by the DEV+forensic-gated
//     `[LENS_ARBITRATION]` diagnostic log in `lib/recommender.ts`. No
//     production ranking, scoring, composer, RecCard, finalGate, or
//     No-dark code path reads this value.
//   - Default is `'balanced'`. At the default value, the recommender is
//     byte-identical to a build without this field — pinned by
//     `scripts/validate_lens_arbitration_log_shape.ts §6`.
//   - Module-state only. Never persisted. Never included in `configHash`.
//
// Phase 2 (separate chapter, separate approval) will wire the modes into
// ranking arbitration. Until then, treat this as an observation knob.
//
// See: docs/plan_lens_steering_phase1.md
// =============================================================================

export type TasteVsIntent = 'taste_first' | 'balanced' | 'mood_first';

const DEFAULT_STEERING: TasteVsIntent = 'balanced';

let _sessionSteering: TasteVsIntent = DEFAULT_STEERING;

/** Read the current session steering mode. Default `'balanced'`. Never
 *  persisted. In Phase 1 this is read only by the DEV+forensic diagnostic
 *  log — no production code path consumes it. */
export function getSessionSteering(): TasteVsIntent {
  return _sessionSteering;
}

/** Set the steering mode for the current session. Phase 1: only intended
 *  for forensic toggling (dev menu / test fixture). Never wired to a user
 *  control in this phase. Does NOT persist. */
export function setSessionSteering(mode: TasteVsIntent): void {
  _sessionSteering = mode;
}

/** Test-only reset hook — mirrors `_resetPendingBuildCauseForTest()` in
 *  `lib/recRequest.ts`. */
export function _resetSessionSteeringForTest(): void {
  _sessionSteering = DEFAULT_STEERING;
}
