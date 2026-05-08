// book_enrichment_cache adapter for the reconciler.
//
// Reuses the existing public.book_enrichment_cache table (created in
// 20260318000004) — keyed by external_id, unique. The reconciler stores
// successful provider responses with a discriminator marker
// (source_summary.source = 'reconciler') so we can distinguish them from
// rows the client-side enrichment path writes.
//
// Policy:
//   - Only successful lookups are cached. Failures NEVER poison the cache.
//   - 30-day TTL: a cache hit older than 30 days is treated as a miss.
//   - Cache hits skip the provider HTTP request entirely (zero rate-limit
//     consumption) — important for resilience to provider outages.

import type { CanonicalBookFields, ProviderName, ReconcilerCachePayload } from './types.ts';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type AdminClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
    upsert: (
      row: Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: unknown }>;
  };
};

interface CacheRow {
  external_id: string;
  book_id: string | null;
  cached_at: string;
  source_summary: ReconcilerCachePayload | Record<string, unknown> | null;
}

export interface CacheLookupResult {
  hit: boolean;
  fields: CanonicalBookFields | null;
  ageMs: number | null;
}

export async function getCachedFields(
  admin: AdminClient,
  externalId: string,
): Promise<CacheLookupResult> {
  const { data, error } = await admin
    .from('book_enrichment_cache')
    .select('external_id, book_id, cached_at, source_summary')
    .eq('external_id', externalId)
    .maybeSingle();
  if (error || !data) return { hit: false, fields: null, ageMs: null };

  const row = data as CacheRow;
  const cachedAt = Date.parse(row.cached_at);
  if (!Number.isFinite(cachedAt)) return { hit: false, fields: null, ageMs: null };
  const ageMs = Date.now() - cachedAt;
  if (ageMs > CACHE_TTL_MS) return { hit: false, fields: null, ageMs };

  // Only treat reconciler-shaped payloads as a usable hit. Client-side
  // enrichment payloads have a different shape and are not safe to feed back
  // into the reconciler's write path.
  const ss = row.source_summary;
  if (!ss || typeof ss !== 'object') return { hit: false, fields: null, ageMs };
  const payload = ss as Partial<ReconcilerCachePayload>;
  if (payload.source !== 'reconciler' || !payload.fields) {
    return { hit: false, fields: null, ageMs };
  }
  return { hit: true, fields: payload.fields, ageMs };
}

export async function writeCachedFields(
  admin: AdminClient,
  externalId: string,
  bookId: string,
  provider: ProviderName,
  fields: CanonicalBookFields,
): Promise<void> {
  const payload: ReconcilerCachePayload = {
    source: 'reconciler',
    provider,
    fetched_at: new Date().toISOString(),
    fields,
  };
  await admin.from('book_enrichment_cache').upsert(
    {
      external_id: externalId,
      book_id: bookId,
      source_summary: payload,
      cached_at: new Date().toISOString(),
    },
    { onConflict: 'external_id' },
  );
}
