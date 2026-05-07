// =============================================================================
// recEntitlement.ts — user plan & expert recommendation access control
//
// Two-tier model:
//   free — deterministic recs always; one expert analysis after signal/import;
//           then 1 expert refresh per FREE_EXPERT_PERIOD_DAYS
//   paid  — expert mode as default when signal is sufficient; unlimited refreshes
//   beta  — same as paid (for internal testing / founding users)
//
// The entitlement row is created on first access (upsert-like pattern) and
// degrades gracefully if the table doesn't exist yet (migration pending).
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TasteProfile }   from './tasteProfile';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Free users get this many expert refreshes per period after the initial grant. */
export const FREE_EXPERT_REFRESHES_PER_PERIOD = 1;

/** Period length for the free expert refresh quota. */
export const FREE_EXPERT_PERIOD_DAYS = 30;

/**
 * Minimum "strong signal" count a user needs to qualify for expert mode.
 * A strong signal is a finished book with at least one of: rating, taste_tags,
 * review_body, or source = 'goodreads'. See computeTasteProfile().
 */
export const EXPERT_SIGNAL_THRESHOLD = 6;

/**
 * Expert mode TTL (milliseconds). Cached expert results are valid for 7 days.
 * Deterministic results are valid for 24 h (handled separately in recCache).
 */
export const EXPERT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Deterministic cache TTL (ms). */
export const DETERMINISTIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecPlan = 'free' | 'paid' | 'beta';

export type RecEntitlement = {
  /** User's plan tier. */
  plan: RecPlan;

  /** Whether the user has expert-grade recommendations enabled at all. */
  expert_recs_enabled: boolean;

  /**
   * For free users: refreshes remaining in the current period (0 or 1).
   * For paid/beta: null (unlimited).
   */
  expert_refreshes_remaining_this_period: number | null;

  /** True if the user has already consumed their one-time free expert analysis. */
  has_used_free_import_analysis: boolean;

  /**
   * ISO timestamp of when the next free expert refresh becomes available.
   * null for paid users or if a refresh is currently available.
   */
  next_refresh_available_at: string | null;

  /** Raw DB row (internal, used by decision logic). */
  _raw: {
    free_expert_used: boolean;
    expert_refreshes_this_period: number;
    period_start_at: string;
    last_expert_refresh_at: string | null;
  };
};

export type ExpertAccessDecision = {
  /** Whether expert recommendations can be run now. */
  allowed: boolean;

  /** Reason for the decision (for logging / UI messaging). */
  reason:
    | 'paid_plan'
    | 'beta_plan'
    | 'free_first_use'
    | 'free_period_refresh'
    | 'insufficient_signal'
    | 'quota_exhausted'
    | 'not_entitled';

  /** True when this is the user's free preview moment (should be surfaced in UI). */
  is_free_preview: boolean;

  /** Human-readable description for UI display. */
  message: string;
};

// ── Default entitlement ────────────────────────────────────────────────────────

function defaultEntitlement(): RecEntitlement {
  return {
    plan:                                   'free',
    expert_recs_enabled:                    false,
    expert_refreshes_remaining_this_period: 0,
    has_used_free_import_analysis:          false,
    next_refresh_available_at:              null,
    _raw: {
      free_expert_used:              false,
      expert_refreshes_this_period:  0,
      period_start_at:               new Date().toISOString(),
      last_expert_refresh_at:        null,
    },
  };
}

// ── Entitlement loader ─────────────────────────────────────────────────────────

/**
 * Load the user's entitlement from the DB.
 * Returns a sensible free-tier default if the table doesn't exist yet or if
 * no row exists for this user (row is created lazily on first consume).
 */
export async function getEntitlement(
  client: SupabaseClient,
  userId: string,
): Promise<RecEntitlement> {
  try {
    const { data, error } = await client
      .from('rec_entitlements')
      .select('plan, free_expert_used, free_expert_used_at, expert_refreshes_this_period, period_start_at, last_expert_refresh_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return defaultEntitlement();

    const plan: RecPlan = (data.plan as RecPlan) ?? 'free';
    const isPaid  = plan === 'paid' || plan === 'beta';
    const periodStart = new Date(data.period_start_at ?? Date.now());
    const periodAgeMs = Date.now() - periodStart.getTime();
    const periodExpired = periodAgeMs > FREE_EXPERT_PERIOD_DAYS * 24 * 60 * 60 * 1000;

    // Compute refreshes remaining for this period (auto-reset if period expired)
    const refreshesUsed    = periodExpired ? 0 : (data.expert_refreshes_this_period ?? 0);
    const refreshesRemaing = isPaid ? null : Math.max(0, FREE_EXPERT_REFRESHES_PER_PERIOD - refreshesUsed);

    // Next refresh available at
    let nextRefreshAt: string | null = null;
    if (!isPaid && refreshesRemaing === 0 && !periodExpired) {
      const nextPeriod = new Date(periodStart.getTime() + FREE_EXPERT_PERIOD_DAYS * 24 * 60 * 60 * 1000);
      nextRefreshAt = nextPeriod.toISOString();
    }

    return {
      plan,
      expert_recs_enabled:                    isPaid || !data.free_expert_used || (refreshesRemaing ?? 0) > 0,
      expert_refreshes_remaining_this_period: refreshesRemaing,
      has_used_free_import_analysis:          data.free_expert_used ?? false,
      next_refresh_available_at:              nextRefreshAt,
      _raw: {
        free_expert_used:             data.free_expert_used ?? false,
        expert_refreshes_this_period: refreshesUsed,
        period_start_at:              data.period_start_at ?? new Date().toISOString(),
        last_expert_refresh_at:       data.last_expert_refresh_at ?? null,
      },
    };
  } catch {
    // Table may not exist yet — return free default gracefully
    return defaultEntitlement();
  }
}

// ── Access decision ────────────────────────────────────────────────────────────

/**
 * Determine whether expert recommendations should run for this user right now.
 * Takes both the entitlement AND the taste profile (for signal threshold check).
 */
export function canRunExpertRecs(
  entitlement: RecEntitlement,
  profile:     TasteProfile,
): ExpertAccessDecision {
  const { plan, _raw } = entitlement;

  // Signal check: do we have enough data to make expert mode meaningful?
  const signalCount = profile.strongSignalCount ?? 0;
  const importCount = profile.evidence.imported_books_count ?? 0;
  const hasEnoughSignal = signalCount >= EXPERT_SIGNAL_THRESHOLD || importCount >= 10;

  if (!hasEnoughSignal) {
    return {
      allowed:         false,
      reason:          'insufficient_signal',
      is_free_preview: false,
      message:         'Rate a few more books to unlock expert recommendations.',
    };
  }

  // Paid / beta: always allowed
  if (plan === 'paid' || plan === 'beta') {
    return {
      allowed:         true,
      reason:          plan === 'beta' ? 'beta_plan' : 'paid_plan',
      is_free_preview: false,
      message:         'Expert recommendations enabled.',
    };
  }

  // Free — first ever use (one-time complimentary analysis)
  if (!_raw.free_expert_used) {
    return {
      allowed:         true,
      reason:          'free_first_use',
      is_free_preview: true,
      message:         'Your complimentary taste profile is ready.',
    };
  }

  // Free — period refresh available
  const periodAgeMs  = Date.now() - new Date(_raw.period_start_at).getTime();
  const periodExpired = periodAgeMs > FREE_EXPERT_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const refreshesUsed = periodExpired ? 0 : _raw.expert_refreshes_this_period;

  if (refreshesUsed < FREE_EXPERT_REFRESHES_PER_PERIOD) {
    return {
      allowed:         true,
      reason:          'free_period_refresh',
      is_free_preview: false,
      message:         'Expert recommendations refreshed.',
    };
  }

  // Free — quota exhausted
  return {
    allowed:         false,
    reason:          'quota_exhausted',
    is_free_preview: false,
    message:         entitlement.next_refresh_available_at
      ? `Next expert refresh available ${new Date(entitlement.next_refresh_available_at).toLocaleDateString()}.`
      : 'Upgrade for ongoing expert recommendations.',
  };
}

// ── Usage tracking ─────────────────────────────────────────────────────────────

/**
 * Record that an expert recommendation run has been consumed.
 * Creates the entitlement row if it doesn't exist yet.
 * Best-effort — does not throw on failure.
 */
export async function consumeExpertRefresh(
  client:      SupabaseClient,
  _userId:     string,
  decision:    ExpertAccessDecision,
  _currentRow?: RecEntitlement,
): Promise<void> {
  try {
    // P0 security: client INSERT/UPDATE on rec_entitlements is removed
    // (migration 20260508000000_p0_security_hardening.sql). All counter
    // mutations go through the consume_expert_refresh SECURITY DEFINER RPC,
    // which never touches the `plan` column — paid promotion can only happen
    // via a future server-side payment webhook. The action taken (first-use
    // vs period-refresh vs quota-exhausted vs paid) is decided server-side
    // from the current row, NOT from `decision.reason`, so a malicious client
    // cannot reset its quota by lying about the reason.
    await client.rpc('consume_expert_refresh');
    void decision; // reason is intentionally not forwarded — see RPC comment.
  } catch {
    // Best-effort — never throw
  }
}
