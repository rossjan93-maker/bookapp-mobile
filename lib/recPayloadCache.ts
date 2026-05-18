import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ScoredBook, QualityGate, RankedRecsResult } from './recommender';
import type { ReaderThesis } from './expertRec';
import { assertCurrent } from './recValidity';

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
  /**
   * P0B recommendation-config identity (lib/recValidity.ts). Optional because
   * legacy payloads written before P0B (and writes from the prewarm path,
   * which is out-of-scope for this batch) lack the field. When a caller
   * supplies `opts.currentConfigHash` to `loadRecPayload`, a missing or
   * mismatched hash invalidates the payload and forces a fresh rebuild.
   * Forward-compatible: P1's RecRequest.configHash will populate this slot.
   */
  configHash?:   string;
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
//   - P0B: when `opts.currentConfigHash` is supplied AND the stored payload's
//     `configHash` is missing or does not match — payload is cleared from
//     AsyncStorage and null is returned (forces rebuild).
//
// Does NOT reject on:
//   - signal count mismatch (Phase 2 background refresh corrects it)
//   - recMode mismatch (Phase 2 background refresh corrects it)
//   - isFreePreview mismatch (same)
//   - missing fingerprint field (pre-v2 payload — accepted, logged as legacy)
//   - missing configHash WHEN no currentConfigHash supplied by caller
//     (preserves backward-compat for callers that haven't opted into the
//     P0B gate yet, e.g., the cold-start prewarm restore in (tabs)/_layout.tsx)

export type LoadRecPayloadOpts = {
  /** P0B: when supplied, payload is rejected (and cleared) on hash mismatch
   *  or missing stored hash. Omit to retain legacy "always restore" behavior. */
  currentConfigHash?: string | null;
};

export async function loadRecPayload(
  userId: string,
  opts?:  LoadRecPayloadOpts,
): Promise<PersistedRecPayload | null> {
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

    // P0B: opt-in deck-validity gate.
    if (opts?.currentConfigHash != null) {
      const check = assertCurrent(p.configHash, opts.currentConfigHash);
      if (!check.valid) {
        if (__DEV__) console.log('[PERSIST_CACHE] config_mismatch — discarding',
          `| reason=${check.reason}`,
          `| stored=${p.configHash ?? 'absent'}`,
          `| current=${opts.currentConfigHash}`,
        );
        // Best-effort clear so the next cold start doesn't re-hit the same
        // stale payload before runPipeline overwrites it.
        try { await AsyncStorage.removeItem(KEY_PREFIX + userId); } catch {}
        return null;
      }
    }

    // ── P4D-followup (2026-05-18): lens-tagged payload guard ─────────────
    //
    // Your-Next-Read intent (the "lens") is session-only by design: it is
    // never persisted, the user must re-apply it on every cold start, and
    // its retrieval/scoring effects (avoid_dark, hard.max_page_count,
    // soft pace/tone boosts, evaluateBookAgainstIntentLens decisions) are
    // produced inline against the *current* signal map.
    //
    // A persisted payload with a non-null `intentTag` is therefore a
    // contradiction: it captures the deck-as-filtered-under-a-past-lens
    // and replays it without re-running the evaluator. If the lens-eval
    // logic shifts (e.g., DARK_SIGNALS extension, word-boundary
    // tightening, new evidence dimension), the restored deck may include
    // titles the current evaluator would reject — exactly the
    // "stale eligibility decision" failure mode from the 2026-05-18
    // No-dark live smoke.
    //
    // We could rebuild this safely by either (a) re-running the
    // evaluator at restore time, but the lens itself isn't persisted so
    // we have no intent object to evaluate against, or (b) versioning
    // the lens fingerprint and discarding on version drift. The clean
    // minimal answer is to never restore a lens-tagged payload at all:
    // the writer path is now gated symmetrically (RecommendationsFeed
    // skips `saveRecPayload` when an intent is active), and this guard
    // catches any payload written before the writer guard shipped (or
    // by a future caller that forgets the contract).
    if (p.intentTag != null && p.intentTag !== 'none') {
      if (__DEV__) console.log('[PERSIST_CACHE] lens_tagged_payload — discarding',
        `| intentTag=${p.intentTag}`,
        `| fingerprint=${p.fingerprint ?? 'legacy'}`,
      );
      try { await AsyncStorage.removeItem(KEY_PREFIX + userId); } catch {}
      return null;
    }

    if (__DEV__) console.log('[PERSIST_CACHE] hit',
      `| age_ms=${age}`,
      `| recs=${p.recs.length}`,
      `| signal=${p.signalCount}`,
      `| fingerprint=${p.fingerprint ?? 'legacy'}`,
      `| configHash=${p.configHash ?? 'absent'}`,
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
