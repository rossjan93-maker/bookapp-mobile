// =============================================================================
// Provider Health Monitor
// =============================================================================
//
// Lightweight, in-memory instrumentation for metadata provider outcomes.
// No persistence, no dashboard — signals are readable from the JS console
// during development and testing, and via getProviderHealth() in code.
//
// Usage:
//   import { recordProviderOutcome, logProviderHealthSummary } from './providerHealth';
//
//   recordProviderOutcome('google_books', 'success');
//   recordProviderOutcome('google_books', 'rate_limited');
//   recordProviderOutcome('open_library', 'failed');
//   recordMissingField('cover');
//   recordMissingField('description');
//
//   // Log a summary to the console (call after a repair batch, or on demand):
//   logProviderHealthSummary();
//
// All counters reset when the JS context restarts (app kill / hard reload).
// This is intentional — the module tracks per-session signal density only.
//
// =============================================================================

export type ProviderName = 'google_books' | 'open_library' | 'goodreads';
export type ProviderOutcome = 'success' | 'failed' | 'rate_limited' | 'skipped';
export type MissingField = 'cover' | 'description' | 'page_count';
export type CacheHitKind = 'cover_url' | 'repair_skip';

// ── Internal counters ─────────────────────────────────────────────────────────

type ProviderStats = {
  success:      number;
  failed:       number;
  rate_limited: number;
  skipped:      number;
};

type MissingStats = {
  cover:       number;
  description: number;
  page_count:  number;
};

type CacheHitStats = {
  cover_url:    number;   // CoverThumb skipped a known-failed derived URL
  repair_skip:  number;   // metadataRepair skipped a book already attempted this session
};

type HealthState = {
  providers:      Record<ProviderName, ProviderStats>;
  missing:        MissingStats;
  cacheHits:      CacheHitStats;
  sessionStart:   number;
  lastEventAt:    number | null;
};

function makeProviderStats(): ProviderStats {
  return { success: 0, failed: 0, rate_limited: 0, skipped: 0 };
}

const _health: HealthState = {
  providers: {
    google_books: makeProviderStats(),
    open_library: makeProviderStats(),
    goodreads:    makeProviderStats(),
  },
  missing:    { cover: 0, description: 0, page_count: 0 },
  cacheHits:  { cover_url: 0, repair_skip: 0 },
  sessionStart: Date.now(),
  lastEventAt:  null,
};

// ── Public write API ──────────────────────────────────────────────────────────

/**
 * Record the outcome of a single provider call.
 *
 * @param provider  - Which provider produced the result.
 * @param outcome   - What happened: success | failed | rate_limited | skipped.
 */
export function recordProviderOutcome(
  provider: ProviderName,
  outcome:  ProviderOutcome,
): void {
  _health.providers[provider][outcome] += 1;
  _health.lastEventAt = Date.now();
}

/**
 * Record that a book is missing a key metadata field after all providers ran.
 * Call this once per book per missing field at the end of an enrichment pass.
 *
 * @param field - 'cover' | 'description' | 'page_count'
 */
export function recordMissingField(field: MissingField): void {
  _health.missing[field] += 1;
  _health.lastEventAt = Date.now();
}

/**
 * Record a session-cache hit that avoided a provider call.
 *
 * @param kind - 'cover_url'   : CoverThumb skipped a known-failed derived OL URL
 *             - 'repair_skip' : metadataRepair skipped a book already attempted this session
 */
export function recordCacheHit(kind: CacheHitKind): void {
  _health.cacheHits[kind] += 1;
  _health.lastEventAt = Date.now();
}

// ── Public read API ───────────────────────────────────────────────────────────

export type ProviderHealthSnapshot = {
  providers:     Record<ProviderName, ProviderStats>;
  missing:       MissingStats;
  cacheHits:     CacheHitStats;
  sessionStart:  number;
  lastEventAt:   number | null;
  uptimeSeconds: number;
};

/**
 * Returns a deep-copy snapshot of current health counters.
 * Safe to call at any time; never throws.
 */
export function getProviderHealth(): ProviderHealthSnapshot {
  return {
    providers: {
      google_books: { ..._health.providers.google_books },
      open_library: { ..._health.providers.open_library },
      goodreads:    { ..._health.providers.goodreads    },
    },
    missing:       { ..._health.missing },
    cacheHits:     { ..._health.cacheHits },
    sessionStart:  _health.sessionStart,
    lastEventAt:   _health.lastEventAt,
    uptimeSeconds: Math.round((Date.now() - _health.sessionStart) / 1000),
  };
}

/**
 * Computes the success rate for a provider (0–1).
 * Returns null if no calls have been recorded.
 */
export function providerSuccessRate(provider: ProviderName): number | null {
  const s = _health.providers[provider];
  const total = s.success + s.failed + s.rate_limited;
  if (total === 0) return null;
  return s.success / total;
}

// ── Console output ────────────────────────────────────────────────────────────

/**
 * Logs a formatted health summary to the console.
 * Prefix: [HEALTH] — consistent with other instrumentation prefixes.
 *
 * Recommended call sites:
 *   • After each repair batch in metadataRepair.ts
 *   • On-demand in dev/testing
 */
export function logProviderHealthSummary(): void {
  const snap = getProviderHealth();
  const fmtProvider = (name: ProviderName) => {
    const s   = snap.providers[name];
    const tot = s.success + s.failed + s.rate_limited + s.skipped;
    if (tot === 0) return `${name}: no calls`;
    const rate = providerSuccessRate(name);
    const pct  = rate !== null ? `${(rate * 100).toFixed(0)}%` : 'n/a';
    return (
      `${name}: ${s.success} ok / ${s.failed} fail / ${s.rate_limited} rl / ${s.skipped} skip` +
      ` (success_rate=${pct})`
    );
  };

  const missingTotal =
    snap.missing.cover + snap.missing.description + snap.missing.page_count;
  const cacheTotal =
    snap.cacheHits.cover_url + snap.cacheHits.repair_skip;

  console.log(
    '[HEALTH] ─────────────────────────────────────',
    `\n[HEALTH] session_uptime=${snap.uptimeSeconds}s`,
    `\n[HEALTH] ${fmtProvider('google_books')}`,
    `\n[HEALTH] ${fmtProvider('open_library')}`,
    `\n[HEALTH] ${fmtProvider('goodreads')}`,
    `\n[HEALTH] missing: cover=${snap.missing.cover}` +
      ` desc=${snap.missing.description}` +
      ` pages=${snap.missing.page_count}` +
      ` total=${missingTotal}`,
    `\n[HEALTH] cache_hits: cover_url=${snap.cacheHits.cover_url}` +
      ` repair_skip=${snap.cacheHits.repair_skip}` +
      ` total=${cacheTotal}`,
    '\n[HEALTH] ─────────────────────────────────────',
  );
}

/**
 * Resets all counters back to zero.
 * Useful in tests or when starting a fresh repair pass.
 */
export function resetProviderHealth(): void {
  _health.providers.google_books = makeProviderStats();
  _health.providers.open_library = makeProviderStats();
  _health.providers.goodreads    = makeProviderStats();
  _health.missing   = { cover: 0, description: 0, page_count: 0 };
  _health.cacheHits = { cover_url: 0, repair_skip: 0 };
  _health.sessionStart = Date.now();
  _health.lastEventAt  = null;
}
