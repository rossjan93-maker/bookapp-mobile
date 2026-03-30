import type { ScoredBook } from './recommender';
import { addActedOnIds } from './recPayloadCache';

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
  }
  for (const id of persistedActedOnIds) _actedOnIds.add(id);
}

/** Clears queue and pending dismiss (called on sign-out). */
export function clearAll(): void {
  _queue          = [];
  _pendingDismiss = null;
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
 */
export function initQueue(entries: QueueEntry[]): void {
  _queue = entries.filter(e => isEligible(e.book));
}

/**
 * Appends new books to the queue tail. Deduplicates against existing queue
 * AND actedOnIds. This is the only write path for background replenishment —
 * it never touches the visible head.
 *
 * Returns the number of books actually appended.
 */
export function appendToQueue(entries: QueueEntry[]): number {
  const existingIds = new Set<string>();
  for (const e of _queue) {
    existingIds.add(e.book.id);
    if (e.book.external_id) existingIds.add(e.book.external_id);
  }
  const eligible = entries.filter(e =>
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
