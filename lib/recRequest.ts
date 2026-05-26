// =============================================================================
// recRequest.ts — P1 Recommendation Control-Plane request object
//
// Single typed request object that the recommender consumes. Compiles all
// signals + policy + build cause + identity. P1 shape is intentionally narrow:
// only fields with present consumers, plus a small forward-compatible policy
// + signal surface so P2 (branch planner) and P3 (contribution scoring) plug
// in additively rather than via a request-shape rewrite.
//
// Schema versioning:
//   - SCHEMA_VERSION is bumped when the request shape changes incompatibly.
//   - Currently `rrv1`. P3 will likely bump to `rrv2` when contribution
//     sources become a first-class field.
//
// Forward-compatibility with P0B configHash:
//   - build.configHash is the existing P0B `rcv1` hash (string), passed
//     through unchanged. The recommender uses it for forensic tagging only;
//     deck-validity gating remains owned by recValidity / the three stores.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TasteProfile } from './tasteProfile';
import type { Signals } from './recSignals/types';
import { buildSignals, type RawPrefsRow } from './recSignals/build';
import { confidenceModeForTier, type ConfidenceMode, STATED_TASTE_POLICY } from './recPolicy';

export const SCHEMA_VERSION = 'rrv1';

// ── BuildCause ───────────────────────────────────────────────────────────────
//
// Reason the recommender pipeline ran. Behavioral semantics live where the
// cause is consumed (P1: forensic tagging; P2: branch planner will key
// quotas off it; P3: explanations may cite it).
//
// P1 ACTIVELY USES:
//   - 'session_open'             — default for normal pipeline runs
//   - 'explicit_preference_edit' — set from app/edit-preferences.tsx via
//                                  the pending-cause module state below
//
// Typed but not yet behaviorally distinct (defined to avoid future union
// widening as a breaking change):
//   - 'manual_refresh'
//   - 'intent_apply'
//   - 'intent_clear'
//   - 'feedback_action'
//   - 'onboarding_completion'

export type BuildCause =
  | 'session_open'
  | 'explicit_preference_edit'
  | 'manual_refresh'
  | 'intent_apply'
  | 'intent_clear'
  | 'feedback_action'
  | 'onboarding_completion';

// ── Pending build cause (cross-screen propagation) ───────────────────────────
//
// edit-preferences.tsx → setPendingBuildCause('explicit_preference_edit')
// before back-nav. The next runPipeline() call in RecommendationsFeed reads
// the pending value via consumePendingBuildCause() — it self-clears so a
// subsequent normal pipeline run defaults back to 'session_open'.
//
// Why module state vs nav-param vs AsyncStorage:
//   - The next pipeline run happens in the same JS runtime, on next focus,
//     within milliseconds of router.back(). Module state is sound, no
//     persistence is needed, and there is no cross-process consumer.
//   - AsyncStorage would survive a cold start and incorrectly tag the
//     subsequent fresh app launch's pipeline as explicit_preference_edit.
//   - Nav-params would require plumbing through three screens.

let _pendingBuildCause: BuildCause | null = null;

export function setPendingBuildCause(cause: BuildCause): void {
  _pendingBuildCause = cause;
  if (__DEV__) console.log('[P2DEBUG/cause-set]', `cause=${cause}`, `ts=${Date.now()}`);
}

export function consumePendingBuildCause(): BuildCause | null {
  const c = _pendingBuildCause;
  _pendingBuildCause = null;
  if (__DEV__) console.log('[P2DEBUG/cause-consume]', `cause=${c ?? 'null'}`, `ts=${Date.now()}`);
  return c;
}

/** Test-only: peek without consuming. */
export function peekPendingBuildCause(): BuildCause | null {
  return _pendingBuildCause;
}

/** Test-only: reset. */
export function _resetPendingBuildCauseForTest(): void {
  _pendingBuildCause = null;
}

// ── Policy projection ────────────────────────────────────────────────────────
//
// P1 carries the floor + multiplier values the recommender step 7 uses.
// Numbers are calibration hypotheses owned by lib/recPolicy.ts; this is a
// snapshot at request build time so a mid-run policy change cannot affect
// an in-flight ranking pass.

export type RecRequestPolicy = {
  confidenceMode:        ConfidenceMode;
  statedPreferenceFloor: number;
  statedPreferenceWeight: number;  // bonusHigh — caller may treat as the cap
  softAvoidFloor:        number;
  softAvoidPenalty:      number;   // avoidPenaltyHigh — caller may treat as the cap
};

// ── RecRequest ───────────────────────────────────────────────────────────────

export type RecRequest = {
  userId:  string;
  signals: Signals;
  policy:  RecRequestPolicy;
  build: {
    cause:         BuildCause;
    configHash?:   string;
    builtAt:       number;
    schemaVersion: string;
  };
};

// ── Async builder ────────────────────────────────────────────────────────────
//
// Fetches the reader_preferences row once and compiles a RecRequest. Errors
// fall back to an empty prefs row — the recommender's existing zero-signal
// behavior covers that case unchanged.

export async function buildRecRequest(
  client: SupabaseClient,
  opts: {
    userId:      string;
    profile:     TasteProfile;
    cause:       BuildCause;
    configHash?: string;
    intent?:     unknown | null;
    feedback?:   unknown | null;
  },
): Promise<RecRequest> {
  let prefsRow: RawPrefsRow | null = null;
  // P4A: select diagnosis_answers alongside existing columns. Migration
  // 20260318000001_reader_preferences_diagnosis adds the jsonb column with a
  // default '{}'; on stale projects without the migration the select would
  // raise 42703/PGRST204 and the outer catch falls through to the legacy
  // shape (schema-tolerant — same pattern as book-detail user_books select).
  try {
    const { data, error } = await client
      .from('reader_preferences')
      .select('favorite_genres, avoid_genres, reading_styles, favorite_authors, updated_at, diagnosis_answers')
      .eq('user_id', opts.userId)
      .maybeSingle();
    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      const fallback = await client
        .from('reader_preferences')
        .select('favorite_genres, avoid_genres, reading_styles, favorite_authors, updated_at')
        .eq('user_id', opts.userId)
        .maybeSingle();
      if (fallback.data) {
        prefsRow = {
          favorite_genres:  (fallback.data as any).favorite_genres  ?? [],
          avoid_genres:     (fallback.data as any).avoid_genres     ?? [],
          reading_styles:   (fallback.data as any).reading_styles   ?? [],
          favorite_authors: (fallback.data as any).favorite_authors ?? null,
          updated_at:       (fallback.data as any).updated_at       ?? null,
          diagnosis_answers: null,
        };
      }
    } else if (data) {
      prefsRow = {
        favorite_genres:  (data as any).favorite_genres  ?? [],
        avoid_genres:     (data as any).avoid_genres     ?? [],
        reading_styles:   (data as any).reading_styles   ?? [],
        favorite_authors: (data as any).favorite_authors ?? null,
        updated_at:       (data as any).updated_at       ?? null,
        diagnosis_answers: (data as any).diagnosis_answers ?? null,
      };
    }
  } catch {
    // best-effort: empty prefs row falls through to empty stated/avoid signals
  }

  const signals = buildSignals({
    profile:  opts.profile,
    prefsRow,
    intent:   opts.intent ?? null,
    feedback: opts.feedback ?? null,
  });

  const policy: RecRequestPolicy = {
    // Phase B.0 (2026-05-26): 2-arg projection. `profile.tier` still carries
    // the BOOSTED tier value (unchanged for all other consumers);
    // `profile.intakeBoosted` is the new flag that distinguishes
    // sparse_onboarding (intake-boosted tier-0) from zero_signal (raw tier-0).
    confidenceMode:         confidenceModeForTier(opts.profile.tier, opts.profile.intakeBoosted),
    statedPreferenceFloor:  STATED_TASTE_POLICY.prefFloor,
    statedPreferenceWeight: STATED_TASTE_POLICY.prefBonusHigh,
    softAvoidFloor:         STATED_TASTE_POLICY.avoidFloor,
    softAvoidPenalty:       STATED_TASTE_POLICY.avoidPenaltyHigh,
  };

  return {
    userId:  opts.userId,
    signals,
    policy,
    build: {
      cause:         opts.cause,
      configHash:    opts.configHash,
      builtAt:       Date.now(),
      schemaVersion: SCHEMA_VERSION,
    },
  };
}
