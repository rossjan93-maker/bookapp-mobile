import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTasteProfile } from './tasteProfile';
import { getPersonalizedRecsWithExpert } from './recommender';
import { saveRecPayload } from './recPayloadCache';
import type { RecEntitlement } from './recEntitlement';

// ── Background recommendation prewarm ─────────────────────────────────────────
//
// Fire-and-forget: populates rec_candidate_cache (24h DB), _olCandidateSession
// (10-min module cache), and the persistent AsyncStorage payload cache.
//
// Called after:
//   - book rated
//   - taste tags submitted
//   - book marked finished
//   - app session start when taste profile has sufficient signal
//
// Guards:
//   - Only one prewarm in flight at a time (module-level flag)
//   - Skipped if strongSignalCount < 3 (not enough signal to produce useful recs)
//   - All errors are caught and suppressed — prewarm must never break UI

let _prewarmInFlight = false;

const FREE_ENTITLEMENT: RecEntitlement = {
  plan:                                    'free',
  expert_recs_enabled:                     false,
  expert_refreshes_remaining_this_period:  0,
  has_used_free_import_analysis:           false,
  next_refresh_available_at:               null,
  _raw: {
    free_expert_used:             false,
    expert_refreshes_this_period: 0,
    period_start_at:              new Date().toISOString(),
    last_expert_refresh_at:       null,
  },
};

const MIN_SIGNAL_COUNT = 3;

export function triggerRecPrewarm(supabase: SupabaseClient, userId: string): void {
  if (_prewarmInFlight) {
    if (__DEV__) console.log('[PREWARM] skipped — already in flight');
    return;
  }
  _prewarmInFlight = true;
  if (__DEV__) console.log('[PREWARM] starting | userId=' + userId);

  (async () => {
    try {
      const _t0 = Date.now();

      const profile = await computeTasteProfile(supabase, userId);
      if (!profile || profile.strongSignalCount < MIN_SIGNAL_COUNT) {
        if (__DEV__) console.log('[PREWARM] skipped — insufficient signal', `| count=${profile?.strongSignalCount ?? 0}`);
        return;
      }

      const result = await getPersonalizedRecsWithExpert(
        supabase, userId, profile, FREE_ENTITLEMENT, 5,
      );

      const recs = result.recs ?? [];
      if (recs.length === 0 && (result.continuations ?? []).length === 0) {
        if (__DEV__) console.log('[PREWARM] skipped — empty result');
        return;
      }

      await saveRecPayload(userId, {
        recs,
        continuations: result.continuations ?? [],
        discoveries:   result.discoveries   ?? recs,
        meta:          result.meta,
        recMode:       result.meta.mode ?? 'deterministic',
        readerThesis:  result.meta.reader_thesis ?? null,
        qualityGate:   result.meta.quality_gate !== 'passed' ? result.meta.quality_gate : null,
        isFreePreview: result.meta.expert_decision?.is_free_preview ?? false,
        signalCount:   profile.strongSignalCount,
        intentTag:     null,
        loadedAt:      Date.now(),
      });

      if (__DEV__) console.log('[PREWARM] complete',
        `| recs=${recs.length}`,
        `| ms=${Date.now() - _t0}`,
      );
    } catch (e) {
      if (__DEV__) console.warn('[PREWARM] error', e);
    } finally {
      _prewarmInFlight = false;
    }
  })();
}
