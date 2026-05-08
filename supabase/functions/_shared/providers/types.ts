// Shared types for the verify-books-batch reconciler and (future)
// upsert-book-from-provider trusted-write Edge Function.
//
// Kept deliberately small — full provider response types live inside the
// individual provider modules (openLibrary.ts, googleBooks.ts).

export type ProviderName = 'open_library' | 'google_books';

export type LookupKind = 'works_key' | 'isbn' | 'isbn13' | 'volume_id';

export type LookupStatus =
  | 'cache_hit'
  | 'success'
  | 'not_found'
  | 'rate_limited'
  | 'provider_error'
  | 'timeout'
  | 'conflict';

// One row to be reconciled. Mirrors the SELECT in verify-books-batch.
export interface ReconcilerRow {
  id: string;
  title: string | null;
  author: string | null;
  isbn: string | null;
  isbn13: string | null;
  external_id: string | null;
  provenance_state: 'unverified' | 'legacy' | 'verified';
  verification_attempt_count: number;
  last_verification_attempt_at: string | null;
}

// Canonical fields the reconciler may write back to public.books on success.
// Keys mirror books column names. Values are nullable; the reconciler applies
// fill-empty / longer-wins policy in code (see verify-books-batch index.ts).
export interface CanonicalBookFields {
  external_id?: string | null;
  cover_url?: string | null;
  description?: string | null;
  subjects?: string[] | null;
  isbn?: string | null;
  isbn13?: string | null;
  publication_year?: number | null;
  original_publication_year?: number | null;
}

// Outcome of one provider lookup. The reconciler converts this into both:
//   (a) a write to public.books (on 'success')
//   (b) one row in public.provider_lookup_log (always)
export interface LookupOutcome {
  provider: ProviderName;
  lookup_kind: LookupKind;
  identifier: string;
  status: LookupStatus;
  latency_ms: number;
  http_status: number | null;
  error_detail: string | null;
  conflict_field: string | null;
  // Only populated when status === 'success' or 'cache_hit'.
  fields: CanonicalBookFields | null;
}

// Shape persisted in book_enrichment_cache.source_summary for reconciler-
// originated cache rows. Distinct from the existing client-side enrichment
// shape so we can tell them apart (the 'reconciler' marker is the discriminator).
export interface ReconcilerCachePayload {
  source: 'reconciler';
  provider: ProviderName;
  fetched_at: string;
  fields: CanonicalBookFields;
}
