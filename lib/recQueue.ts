import type { ScoredBook } from './recommender';
import { addActedOnIds } from './recPayloadCache';
import { assertCurrent } from './recValidity';
import {
  applyFinalIntentEligibility,
  formatFinalGateLog,
  type FinalGateSource,
} from './intent/finalGate';
import type { NextReadIntent } from './nextReadIntent';

// ── Constants ─────────────────────────────────────────────────────────────────
export const VISIBLE_STACK_SIZE  = 4;    // cards shown to the user at once
export const REPLENISH_WATERMARK = 6;    // start replenishing when total queue drops here
export const BACKSTAGE_TARGET    = 10;   // ideal total queue depth (visible + backstage)
export const DISMISS_UNDO_MS     = 4000; // undo window in ms

// ── Types ─────────────────────────────────────────────────────────────────────
export type QueueBucket = 'continuations' | 'discoveries';

export type QueueEntry = {
  book:   ScoredBook;
  bucket: QueueBucket;
};

export type PendingDismissRecord = {
  book:      ScoredBook;
  bucket:    QueueBucket;
  expiresAt: number;
  timerId:   ReturnType<typeof setTimeout> | null;
};

// ── Module-level state (survives tab switches, React re-renders) ───────────────
// All rec-specific module state consolidated here, previously scattered through
// search.tsx. initForUser() clears state when the user changes.

let _queue:          QueueEntry[]                = [];
let _actedOnIds:     Set<string>                 = new Set();
let _pendingUndoIds: Set<string>                 = new Set();
let _pendingDismiss: PendingDismissRecord | null = null;
let _currentUserId:  string | null               = null;
// P0B: recommendation-config identity the current queue contents were built
// against. null means "no identity stamped" (pre-pipeline / post-clear) and
// is treated as a mismatch by `assertQueueConfig`.
let _configHash:     string | null               = null;

// ── User lifecycle ────────────────────────────────────────────────────────────
/**
 * Must be called once per user session. Resets state when userId changes.
 * persistedActedOnIds comes from AsyncStorage (loaded on cold start).
 */
export function initForUser(userId: string, persistedActedOnIds: string[]): void {
  if (_currentUserId !== userId) {
    _queue          = [];
    _actedOnIds     = new Set();
    _pendingUndoIds = new Set();
    _pendingDismiss = null;
    _currentUserId  = userId;
    _configHash     = null;
  }
  for (const id of persistedActedOnIds) _actedOnIds.add(id);
}

/** Clears queue and pending dismiss (called on sign-out, or after pref save
 *  as the defense-in-depth manual triple in app/edit-preferences.tsx). */
export function clearAll(): void {
  _queue          = [];
  _pendingDismiss = null;
  _configHash     = null;
}

// ── P0B deck-validity ─────────────────────────────────────────────────────────
//
// Stamp the queue with the recommendation-config identity its contents were
// built against. Called by RecommendationsFeed after a successful pipeline run
// (alongside initQueue/appendToQueue).
export function setQueueConfigHash(hash: string | null): void {
  _configHash = hash;
}

export function getQueueConfigHash(): string | null {
  return _configHash;
}

/**
 * Strict validity check. Returns true when the queue's stamped configHash
 * matches `currentHash`. On mismatch (including no-stamp), the queue is
 * cleared in-place and the pending-dismiss record is dropped — preventing
 * stale visible-head reuse and stale-append behavior.
 *
 * This is the P0B guard against the prior bug class:
 *   1. user changes prefs
 *   2. pipeline rebuilds fresh entries
 *   3. (without P0B) old queue is non-empty → fresh entries APPEND to the
 *      tail → stale head remains visible
 * Calling assertQueueConfig(currentHash) BEFORE the pipeline writes ensures
 * step (3) cannot silently preserve stale cards.
 */
export function assertQueueConfig(currentHash: string): boolean {
  const check = assertCurrent(_configHash, currentHash);
  if (!check.valid) {
    if (__DEV__) console.log('[REC_QUEUE] config_mismatch — clearing',
      `| reason=${check.reason}`,
      `| stored=${_configHash ?? 'absent'}`,
      `| current=${currentHash}`,
      `| dropped_entries=${_queue.length}`,
    );
    _queue          = [];
    _pendingDismiss = null;
    _configHash     = null;
    return false;
  }
  return true;
}

// ── Eligibility ───────────────────────────────────────────────────────────────
/** Returns true if a book can be placed into (or kept in) the queue. */
export function isEligible(book: ScoredBook): boolean {
  return (
    !_actedOnIds.has(book.id) &&
    !(book.external_id && _actedOnIds.has(book.external_id)) &&
    !_pendingUndoIds.has(book.id) &&
    !(book.external_id && _pendingUndoIds.has(book.external_id))
  );
}

// ── Queue reads ───────────────────────────────────────────────────────────────
export function getQueue():          QueueEntry[]  { return _queue; }
export function getQueueDepth():     number        { return _queue.length; }
export function getVisibleStack():   QueueEntry[]  { return _queue.slice(0, VISIBLE_STACK_SIZE); }
export function getBackstageDepth(): number        { return Math.max(0, _queue.length - VISIBLE_STACK_SIZE); }

// ── Queue writes ──────────────────────────────────────────────────────────────

/**
 * Initialises the queue from a seed pool (e.g. session cache on cold start).
 * Filters against actedOnIds so deleted/acted-on books are never shown.
 *
 * P0B: optionally stamps the queue with the configHash these entries were
 * produced under, so subsequent assertQueueConfig() reads can detect when
 * the queue has outlived its source recommendation-config.
 */
export function initQueue(
  entries: QueueEntry[],
  configHash?: string | null,
  intent?: NextReadIntent | null,
  source: FinalGateSource = 'initQueue_cold_restore',
  intentTag: string | null = null,
): void {
  // Intent Lens Eligibility Stabilization (2026-05-18) — final visible-deck
  // safety gate. Runs BEFORE the actedOn eligibility filter so the queue
  // singleton cannot hold a hard-excluded book under an active lens,
  // regardless of which producer path delivered the entries (cold-start
  // restore, fresh pipeline, append-into-existing, background, exhaustion).
  // See lib/intent/finalGate.ts for the contract.
  const gated = applyFinalIntentEligibility({
    recs:        entries,
    intent:      intent ?? null,
    source,
    intentTag,
    projectBook: (e) => e.book as any,
  });
  if (__DEV__ && gated.diagnostics && gated.diagnostics.removedCount > 0) {
    console.log(formatFinalGateLog(gated.diagnostics));
  }
  _queue = gated.kept.filter(e => isEligible(e.book));
  if (configHash !== undefined) _configHash = configHash;
}

/**
 * Appends new books to the queue tail. Deduplicates against existing queue
 * AND actedOnIds. This is the only write path for background replenishment —
 * it never touches the visible head.
 *
 * Returns the number of books actually appended.
 */
export function appendToQueue(
  entries: QueueEntry[],
  intent: NextReadIntent | null = null,
  source: FinalGateSource = 'append_into_existing',
  intentTag: string | null = null,
): number {
  // Intent Lens Eligibility Stabilization (2026-05-18) — final visible-deck
  // safety gate (see lib/intent/finalGate.ts). Runs BEFORE the dedupe /
  // actedOn filters so the queue singleton cannot grow to hold a
  // hard-excluded book under an active lens, regardless of source path.
  const gated = applyFinalIntentEligibility({
    recs:        entries,
    intent,
    source,
    intentTag,
    projectBook: (e) => e.book as any,
  });
  if (__DEV__ && gated.diagnostics && gated.diagnostics.removedCount > 0) {
    console.log(formatFinalGateLog(gated.diagnostics));
  }
  const existingIds = new Set<string>();
  for (const e of _queue) {
    existingIds.add(e.book.id);
    if (e.book.external_id) existingIds.add(e.book.external_id);
  }
  const eligible = gated.kept.filter(e =>
    isEligible(e.book) &&
    !existingIds.has(e.book.id) &&
    !(e.book.external_id && existingIds.has(e.book.external_id))
  );
  _queue = [..._queue, ...eligible];
  if (__DEV__) console.log('[REC_QUEUE]',
    `visible_count=${Math.min(_queue.length, VISIBLE_STACK_SIZE)}`,
    `| queue_count=${_queue.length}`,
    `| appended=${eligible.length}`,
    `| watermark_hit=${_queue.length < REPLENISH_WATERMARK}`,
  );
  return eligible.length;
}

/**
 * Removes a book from the queue by ID. Returns the removed entry or null.
 */
export function removeFromQueue(bookId: string): QueueEntry | null {
  const idx = _queue.findIndex(e => e.book.id === bookId);
  if (idx < 0) return null;
  const [removed] = _queue.splice(idx, 1);
  return removed;
}

/**
 * Prepends an entry to the queue head (used by undo — restores dismissed card).
 */
export function prependToQueue(entry: QueueEntry): void {
  _queue = [entry, ..._queue.filter(e => e.book.id !== entry.book.id)];
}

// ── Acted-on tracking ─────────────────────────────────────────────────────────

/** Immediately marks a book as pending-undo.
 *  Card is excluded from all commit paths but no AsyncStorage write yet. */
export function trackActedOnPending(book: ScoredBook): void {
  if (book.external_id) _pendingUndoIds.add(book.external_id);
  _pendingUndoIds.add(book.id);
}

/** Promotes a pending-undo book to permanent acted-on and persists to AsyncStorage. */
export function commitActedOn(userId: string, book: ScoredBook): void {
  if (book.external_id) _pendingUndoIds.delete(book.external_id);
  _pendingUndoIds.delete(book.id);
  if (book.external_id) _actedOnIds.add(book.external_id);
  _actedOnIds.add(book.id);
  const ids = [book.external_id, book.id].filter(Boolean) as string[];
  addActedOnIds(userId, ids).catch(() => {});
}

/** Cancels a pending-undo (undo tapped — removes from pending, no write). */
export function cancelPendingUndo(book: ScoredBook): void {
  if (book.external_id) _pendingUndoIds.delete(book.external_id);
  _pendingUndoIds.delete(book.id);
}

/** Immediately marks a book as permanently acted-on (save / more-like-this path). */
export function trackActedOn(userId: string, book: ScoredBook): void {
  if (book.external_id) _actedOnIds.add(book.external_id);
  _actedOnIds.add(book.id);
  const ids = [book.external_id, book.id].filter(Boolean) as string[];
  addActedOnIds(userId, ids).catch(() => {});
}

export function getActedOnIds():     Set<string>   { return _actedOnIds; }
export function getPendingUndoIds(): Set<string>   { return _pendingUndoIds; }
export function getCurrentUserId():  string | null { return _currentUserId; }

// ── Pending dismiss record ─────────────────────────────────────────────────────
export function getPendingDismiss():                          PendingDismissRecord | null { return _pendingDismiss; }
export function setPendingDismiss(r: PendingDismissRecord | null): void                  { _pendingDismiss = r; }
