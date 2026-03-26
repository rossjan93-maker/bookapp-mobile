import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ScoredBook, QualityGate, RankedRecsResult } from './recommender';
import type { ReaderThesis } from './expertRec';

// ── Persistent rec payload cache ──────────────────────────────────────────────
//
// Survives app restarts (AsyncStorage). Keyed per-user. One slot per user —
// overwritten on every successful Phase 2 commit.
//
// TTL: 2 hours. After expiry the payload is discarded and a skeleton is shown
// while Phase 2 runs. Within TTL the payload is restored immediately on mount
// (before any skeleton) and Phase 2 runs in background with isBackgroundRefreshing.
//
// Signal count is stored in the payload but does NOT invalidate restoration.
// If signals have changed, Phase 2 background refresh handles it; the user
// always sees the last known recs immediately rather than a skeleton.

const KEY_PREFIX = 'readstack_rec_v1_';
const TTL_MS     = 2 * 60 * 60 * 1000; // 2 hours

export type PersistedRecPayload = {
  recs:          ScoredBook[];
  continuations: ScoredBook[];
  discoveries:   ScoredBook[];
  meta:          RankedRecsResult['meta'];
  recMode:       'deterministic' | 'expert';
  readerThesis:  ReaderThesis | null;
  qualityGate:   QualityGate | null;
  isFreePreview: boolean;
  signalCount:   number;
  intentTag:     string | null;
  loadedAt:      number;
};

export async function saveRecPayload(
  userId:  string,
  payload: PersistedRecPayload,
): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PREFIX + userId, JSON.stringify(payload));
    if (__DEV__) console.log('[PERSIST_CACHE] saved', `| recs=${payload.recs.length}`, `| signal=${payload.signalCount}`);
  } catch (e) {
    if (__DEV__) console.warn('[PERSIST_CACHE] save failed', e);
  }
}

export async function loadRecPayload(userId: string): Promise<PersistedRecPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + userId);
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedRecPayload;
    const age = Date.now() - p.loadedAt;
    if (age > TTL_MS) {
      if (__DEV__) console.log('[PERSIST_CACHE] expired', `| age_ms=${age}`);
      return null;
    }
    if (__DEV__) console.log('[PERSIST_CACHE] hit', `| age_ms=${age}`, `| recs=${p.recs?.length ?? 0}`, `| signal=${p.signalCount}`);
    return p;
  } catch (e) {
    if (__DEV__) console.warn('[PERSIST_CACHE] load failed', e);
    return null;
  }
}

export async function clearRecPayload(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_PREFIX + userId);
  } catch {}
}
