import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTasteProfile } from './tasteProfile';
import { getPersonalizedRecsWithExpert } from './recommender';
import { saveRecPayload, computeRecFingerprint } from './recPayloadCache';
import type { RecEntitlement } from './recEntitlement';

// ── Background recommendation prewarm ─────────────────────────────────────────
//
// Fire-and-forget: called from UI event handlers (rating, taste-tags, finish).
// Must NEVER delay or block the calling action — triggerRecPrewarm() returns
// void synchronously; the async work runs in an unhandled IIFE with a catch
// so no rejection can escape to the caller.
//
// What it populates:
//   1. rec_candidate_cache (Supabase, 24h TTL) — eliminates ol_ms on next open
//   2. _olCandidateSession (module-level, 10-min TTL) — OL session cache
//   3. recPayloadCache (AsyncStorage, 2h TTL) — instant restore on next restart
//
// Guards:
//   - One concurrent prewarm at a time (_prewarmInFlight)
//   - Fingerprint dedup: if same fingerprint was warmed within PREWARM_COOLDOWN_MS
//     AND no signal change, skip — prevents back-to-back identical prewarms
//     (e.g., user rates three books in quick succession)
//   - Minimum signal gate: strongSignalCount < MIN_SIGNAL_COUNT → skip
//   - All errors caught and suppressed

let _prewarmInFlight          = false;
let _lastPrewarmFingerprint: string | null = null;
let _lastPrewarmAt            = 0;

const PREWARM_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MIN_SIGNAL_COUNT    = 3;

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

export function triggerRecPrewarm(supabase: SupabaseClient, userId: string): void {
  // ── Concurrency guard ──────────────────────────────────────────────────────
  if (_prewarmInFlight) {
    if (__DEV__) console.log('[PREWARM] skipped — already in flight');
    return;
  }

  // ── Non-blocking: return immediately, run async work in background ─────────
  _prewarmInFlight = true;
  if (__DEV__) console.log('[PREWARM] queued | userId=' + userId);

  (async () => {
    try {
      const _t0 = Date.now();

      // ── Load taste profile ──────────────────────────────────────────────────
      const profile = await computeTasteProfile(supabase, userId);
      if (!profile || profile.strongSignalCount < MIN_SIGNAL_COUNT) {
        if (__DEV__) console.log('[PREWARM] skipped — insufficient signal',
          `| count=${profile?.strongSignalCount ?? 0}`,
        );
        return;
      }

      // ── Fingerprint dedup ───────────────────────────────────────────────────
      // Prewarm always uses deterministic/free mode — no intent active.
      const fingerprint = computeRecFingerprint(
        profile.strongSignalCount, 'deterministic', false, null,
      );
      const sinceLastMs = Date.now() - _lastPrewarmAt;
      if (fingerprint === _lastPrewarmFingerprint && sinceLastMs < PREWARM_COOLDOWN_MS) {
        if (__DEV__) console.log('[PREWARM] skipped — same fingerprint within cooldown',
          `| fingerprint=${fingerprint}`,
          `| sinceLastMs=${sinceLastMs}`,
        );
        return;
      }
      if (__DEV__) console.log('[PREWARM] starting',
        `| fingerprint=${fingerprint}`,
        `| sinceLastMs=${_lastPrewarmAt ? sinceLastMs : -1}`,
      );

      // ── Run deterministic pipeline ──────────────────────────────────────────
      const result = await getPersonalizedRecsWithExpert(
        supabase, userId, profile, FREE_ENTITLEMENT, 5,
      );

      const recs = result.recs ?? [];
      if (recs.length === 0 && (result.continuations ?? []).length === 0) {
        if (__DEV__) console.log('[PREWARM] skipped — empty result');
        return;
      }

      // ── Persist payload ─────────────────────────────────────────────────────
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
        fingerprint,
        loadedAt:      Date.now(),
      });

      // ── Update dedup state ──────────────────────────────────────────────────
      _lastPrewarmFingerprint = fingerprint;
      _lastPrewarmAt          = Date.now();

      if (__DEV__) console.log('[PREWARM] complete',
        `| recs=${recs.length}`,
        `| ms=${Date.now() - _t0}`,
        `| fingerprint=${fingerprint}`,
      );
    } catch (e) {
      if (__DEV__) console.warn('[PREWARM] error', e);
    } finally {
      _prewarmInFlight = false;
    }
  })().catch(() => {
    // Belt-and-suspenders: if the IIFE itself throws synchronously (shouldn't
    // happen since it's async) this prevents an unhandled rejection from
    // surfacing to the caller.
    _prewarmInFlight = false;
  });
}
