import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ScoredBook, QualityGate, RankedRecsResult } from './recommender';
import type { ReaderThesis } from './expertRec';

// ── Persistent rec payload cache ──────────────────────────────────────────────
//
// Survives app restarts (AsyncStorage). One slot per user — overwritten on every
// successful Phase 2 commit and on every background prewarm.
//
// TTL: 2 hours. After expiry the payload is discarded and a skeleton is shown
// while Phase 2 runs fresh. Within TTL the payload is restored immediately on
// mount (before Phase 1 skeleton) and Phase 2 runs in background.
//
// Signal count is stored but does NOT block restoration. If signals changed,
// Phase 2 background refresh handles it; the user always sees the last known
// recs rather than a blank skeleton.
//
// Fingerprint: a string capturing all state that drives which recs are produced.
// Used by:
//   - Prewarm dedup (skip if same fingerprint warmed within cooldown window)
//   - Restore compatibility log (compare stored vs expected after Phase 1)
// It does NOT gate restore — fingerprint mismatch always allows restore with
// background refresh.

const KEY_PREFIX = 'readstack_rec_v1_';
const TTL_MS     = 2 * 60 * 60 * 1000; // 2 hours

// ── Fingerprint ───────────────────────────────────────────────────────────────
//
// v1:<signalCount>:<recMode>:<fp|nfp>:<intentTag>
//
// Examples:
//   v1:154:deterministic:nfp:none           ← no intent, deterministic mode
//   v1:154:expert:nfp:none                  ← expert mode
//   v1:162:deterministic:nfp:light & quick  ← after 8 more ratings, with intent

export function computeRecFingerprint(
  signalCount:   number,
  recMode:       'deterministic' | 'expert',
  isFreePreview: boolean,
  intentTag:     string | null,
): string {
  return [
    'v1',
    signalCount,
    recMode,
    isFreePreview ? 'fp' : 'nfp',
    intentTag ?? 'none',
  ].join(':');
}

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
  fingerprint:   string;
  loadedAt:      number;
};

export async function saveRecPayload(
  userId:  string,
  payload: PersistedRecPayload,
): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PREFIX + userId, JSON.stringify(payload));
    if (__DEV__) console.log('[PERSIST_CACHE] saved',
      `| recs=${payload.recs.length}`,
      `| signal=${payload.signalCount}`,
      `| fingerprint=${payload.fingerprint}`,
    );
  } catch (e) {
    if (__DEV__) console.warn('[PERSIST_CACHE] save failed', e);
  }
}

// ── Load + structural validation ──────────────────────────────────────────────
//
// Rejects on:
//   - TTL expired (>2h)
//   - recs field absent or not an array (corrupt / incompatible format)
//   - no recs and no continuations (empty payload, nothing to show)
//
// Does NOT reject on:
//   - signal count mismatch (Phase 2 background refresh corrects it)
//   - recMode mismatch (Phase 2 background refresh corrects it)
//   - isFreePreview mismatch (same)
//   - missing fingerprint field (pre-v2 payload — accepted, logged as legacy)

export async function loadRecPayload(userId: string): Promise<PersistedRecPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + userId);
    if (!raw) return null;

    let p: PersistedRecPayload;
    try {
      p = JSON.parse(raw);
    } catch {
      if (__DEV__) console.warn('[PERSIST_CACHE] corrupt JSON — discarding');
      return null;
    }

    // Structural guard: recs must be a real array
    if (!Array.isArray(p?.recs)) {
      if (__DEV__) console.warn('[PERSIST_CACHE] missing recs array — discarding (old format?)');
      return null;
    }

    // TTL check
    const age = Date.now() - (p.loadedAt ?? 0);
    if (age > TTL_MS) {
      if (__DEV__) console.log('[PERSIST_CACHE] expired',
        `| age_ms=${age}`,
        `| fingerprint=${p.fingerprint ?? 'legacy'}`,
      );
      return null;
    }

    // Empty guard
    if (p.recs.length === 0 && (p.continuations?.length ?? 0) === 0) {
      if (__DEV__) console.log('[PERSIST_CACHE] empty payload — discarding');
      return null;
    }

    if (__DEV__) console.log('[PERSIST_CACHE] hit',
      `| age_ms=${age}`,
      `| recs=${p.recs.length}`,
      `| signal=${p.signalCount}`,
      `| fingerprint=${p.fingerprint ?? 'legacy'}`,
      `| mode=${p.recMode ?? 'unknown'}`,
    );
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

// ── Acted-on recommendation IDs ───────────────────────────────────────────────
//
// Persists the set of recommendation external_ids / catalog ids the user has
// acted on (saved, dismissed, more-like-this).  Stored separately from the
// payload cache so it can be read at cache-restore time (before Phase 1 loads
// the full feedback context from Supabase).
//
// Each entry is an opaque string: the book's external_id (OL) or catalog UUID.
// The set is append-only; it is never pruned to avoid re-showing acted-on cards
// after the 2h payload TTL window.

const ACTED_ON_KEY_PREFIX = 'readstack_rec_acted_v1_';

export async function addActedOnIds(userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const key = ACTED_ON_KEY_PREFIX + userId;
    const raw = await AsyncStorage.getItem(key);
    const existing: string[] = raw ? JSON.parse(raw) : [];
    const merged = Array.from(new Set([...existing, ...ids]));
    await AsyncStorage.setItem(key, JSON.stringify(merged));
  } catch {}
}

export async function loadActedOnIds(userId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(ACTED_ON_KEY_PREFIX + userId);
    if (!raw) return new Set();
    const arr: string[] = JSON.parse(raw);
    return new Set(arr);
  } catch {
    return new Set();
  }
}

export async function clearActedOnIds(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(ACTED_ON_KEY_PREFIX + userId);
  } catch {}
}
