// =============================================================================
// recCache.ts — Recommendation result cache (deterministic + expert)
//
// Cache strategy:
//   Deterministic results: 24h TTL, rebuilt when new signal arrives
//   Expert results:        7-day TTL, rebuilt when:
//                            • new meaningful signal (rated/tagged book)
//                            • rec feedback count changes materially (+3)
//                            • import completes
//                            • cache expires
//                            • user explicitly requests refresh
//
// The cache is stored per-user in the rec_cache table. On cache miss the caller
// runs the recommendation pipeline and calls persistRecCache to save the result.
// On cache hit, the saved rec_set is returned directly to skip expensive OL/GB
// API calls and scoring — only the rendering layer is needed.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScoredBook, RankedRecsResult } from './recommender';
import type { ReaderThesis, ExpertRecResult } from './expertRec';
import { EXPERT_CACHE_TTL_MS, DETERMINISTIC_CACHE_TTL_MS } from './recEntitlement';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecMode = 'deterministic' | 'expert';

export type SignalSnapshot = {
  signal_count:    number;
  feedback_count:  number;
  import_complete: boolean;
  built_at:        string;
};

export type RecCacheEntry = {
  user_id:         string;
  mode:            RecMode;
  rec_set:         ScoredBook[];
  reader_thesis:   ReaderThesis | null;
  built_at:        string;
  valid_until:     string;
  signal_snapshot: SignalSnapshot;
  debug_meta:      Record<string, unknown> | null;
};

export type CacheCheckResult = {
  hit:   boolean;
  entry: RecCacheEntry | null;
  reason: string;
};

export type RebuildDecision = {
  should_rebuild: boolean;
  reason:         string;
};

// ── Cache loader ──────────────────────────────────────────────────────────────

/**
 * Load cached recommendation results. Returns null on cache miss, table-not-found,
 * or any DB error (all degrade gracefully to a fresh rebuild).
 */
export async function loadCachedRecs(
  client: SupabaseClient,
  userId: string,
): Promise<CacheCheckResult> {
  try {
    const { data, error } = await client
      .from('rec_cache')
      .select('user_id, mode, rec_set, reader_thesis, built_at, valid_until, signal_snapshot, debug_meta')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) {
      return { hit: false, entry: null, reason: error ? 'db_error' : 'no_cache' };
    }

    // TTL check
    if (new Date(data.valid_until) < new Date()) {
      return { hit: false, entry: data as unknown as RecCacheEntry, reason: 'expired' };
    }

    return {
      hit:    true,
      entry:  data as unknown as RecCacheEntry,
      reason: 'cache_hit',
    };
  } catch {
    return { hit: false, entry: null, reason: 'table_missing' };
  }
}

// ── Rebuild decision ──────────────────────────────────────────────────────────

/**
 * Given a cached entry and the current signal state, decide whether to rebuild.
 * Even if the TTL is valid, certain triggers force a rebuild.
 */
export function shouldRebuild(
  cache:           RecCacheEntry,
  currentSignals:  SignalSnapshot,
  forceRefresh:    boolean = false,
): RebuildDecision {
  if (forceRefresh) {
    return { should_rebuild: true, reason: 'user_requested_refresh' };
  }

  const snap = cache.signal_snapshot;

  // Import completion trigger
  if (!snap.import_complete && currentSignals.import_complete) {
    return { should_rebuild: true, reason: 'import_completed' };
  }

  // New meaningful signal: rated/tagged enough new books since last build
  const SIGNAL_DELTA_THRESHOLD = 2;
  if (currentSignals.signal_count - snap.signal_count >= SIGNAL_DELTA_THRESHOLD) {
    return { should_rebuild: true, reason: 'new_reading_signal' };
  }

  // Feedback delta: user gave feedback on 3+ more books since last build
  const FEEDBACK_DELTA_THRESHOLD = 3;
  if (currentSignals.feedback_count - snap.feedback_count >= FEEDBACK_DELTA_THRESHOLD) {
    return { should_rebuild: true, reason: 'feedback_changed' };
  }

  return { should_rebuild: false, reason: 'cache_valid' };
}

// ── Cache writer ──────────────────────────────────────────────────────────────

/**
 * Persist a recommendation result to the cache. Best-effort — never throws.
 */
export async function persistRecCache(
  client:        SupabaseClient,
  userId:        string,
  recs:          ScoredBook[],
  mode:          RecMode,
  signals:       SignalSnapshot,
  thesis?:       ReaderThesis | null,
  debugMeta?:    Record<string, unknown>,
): Promise<void> {
  try {
    const now       = new Date();
    const ttlMs     = mode === 'expert' ? EXPERT_CACHE_TTL_MS : DETERMINISTIC_CACHE_TTL_MS;
    const validUntil = new Date(now.getTime() + ttlMs).toISOString();

    await client.from('rec_cache').upsert({
      user_id:          userId,
      mode,
      rec_set:          recs,
      reader_thesis:    thesis ?? null,
      built_at:         now.toISOString(),
      valid_until:      validUntil,
      signal_snapshot:  signals,
      debug_meta:       debugMeta ?? null,
      updated_at:       now.toISOString(),
    }, { onConflict: 'user_id' });
  } catch {
    // Best-effort — never throw
  }
}

// ── Signal snapshot builder ────────────────────────────────────────────────────

/**
 * Build a signal snapshot from the current taste profile + feedback count.
 * Used both to persist with a new cache entry and to check if rebuild is needed.
 */
export function buildSignalSnapshot(
  strongSignalCount: number,
  feedbackCount:     number,
  importComplete:    boolean,
): SignalSnapshot {
  return {
    signal_count:    strongSignalCount,
    feedback_count:  feedbackCount,
    import_complete: importComplete,
    built_at:        new Date().toISOString(),
  };
}
