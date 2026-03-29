// lib/tabCache.ts
//
// Registry of cache-clearing functions, one per tab module.
// Each tab file calls registerCacheClearer() at module load time.
//
// Two kinds of invalidation:
//   clearAllTabCaches()        — called on SIGNED_OUT; clears every tab
//   invalidateBookDataCaches() — called after any book status / page action
//                                in Book Detail; clears only Home + Library so
//                                the staleness guard does not show stale data

type CacheClearer = () => void;

const _allClearers:      CacheClearer[] = [];
const _bookDataClearers: CacheClearer[] = [];

/** Register fn to be called on sign-out. Pass 'bookData' tag to also clear on book actions. */
export function registerCacheClearer(fn: CacheClearer, tag?: 'bookData'): void {
  _allClearers.push(fn);
  if (tag === 'bookData') _bookDataClearers.push(fn);
}

/** Called on SIGNED_OUT — prevents previous user's data showing for next user. */
export function clearAllTabCaches(): void {
  _allClearers.forEach(f => f());
}

/**
 * Called after any book status transition or page update in Book Detail.
 * Clears only Home + Library caches so returning to those tabs re-fetches
 * instead of showing stale book status / current-reads data.
 * Inbox and Recs hub caches are unaffected (not book-status-sensitive).
 */
export function invalidateBookDataCaches(): void {
  _bookDataClearers.forEach(f => f());
}
