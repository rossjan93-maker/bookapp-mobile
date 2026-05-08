// Token-bucket rate limiter, per-provider, per Edge Function invocation.
//
// State is in-memory only (one bucket per ProviderName). This is correct for
// the reconciler's single-invocation model — a fresh batch run starts with
// fresh buckets, and the advisory lock in verify-books-batch prevents
// overlapping invocations.
//
// Limits chosen with substantial headroom under each provider's documented
// rate (Open Library: ~100/min/IP guideline → 30/min cap; Google Books:
// quota-based but safer to cap minute-rate → 60/min cap).

import type { ProviderName } from './types.ts';

interface Bucket {
  capacity: number;       // max tokens
  tokens: number;         // current tokens (may be fractional)
  refillPerMs: number;    // tokens added per millisecond
  lastRefillAt: number;   // timestamp of last refill (ms epoch)
  paused: boolean;        // 429 received → pause for the rest of the run
}

const DEFAULTS: Record<ProviderName, { capacity: number; perMinute: number }> = {
  open_library: { capacity: 30, perMinute: 30 },
  google_books: { capacity: 60, perMinute: 60 },
};

const buckets = new Map<ProviderName, Bucket>();

function getBucket(provider: ProviderName): Bucket {
  let b = buckets.get(provider);
  if (!b) {
    const def = DEFAULTS[provider];
    b = {
      capacity: def.capacity,
      tokens: def.capacity,
      refillPerMs: def.perMinute / 60_000,
      lastRefillAt: Date.now(),
      paused: false,
    };
    buckets.set(provider, b);
  }
  return b;
}

function refill(b: Bucket) {
  const now = Date.now();
  const elapsed = now - b.lastRefillAt;
  if (elapsed > 0) {
    b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
    b.lastRefillAt = now;
  }
}

/**
 * Try to take one token from this provider's bucket.
 * Returns false if the bucket is empty or the provider has been paused
 * (e.g. saw a 429). The reconciler checks this before each request and
 * skips remaining rows for that provider when it returns false.
 */
export function tryAcquire(provider: ProviderName): boolean {
  const b = getBucket(provider);
  if (b.paused) return false;
  refill(b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Mark a provider as paused for the rest of this Edge Function invocation.
 * Called when the provider returns HTTP 429.
 */
export function pauseProvider(provider: ProviderName): void {
  getBucket(provider).paused = true;
}

/**
 * Returns true iff at least one provider is still acquirable. The reconciler
 * uses this to short-circuit the batch loop when both providers are exhausted.
 */
export function anyProviderAvailable(): boolean {
  return tryPeek('open_library') || tryPeek('google_books');
}

function tryPeek(provider: ProviderName): boolean {
  const b = getBucket(provider);
  if (b.paused) return false;
  refill(b);
  return b.tokens >= 1;
}

// Test-only: reset all bucket state. The verification harness uses this
// between test groups when present; production code never calls it.
export function _resetForTests(): void {
  buckets.clear();
}
