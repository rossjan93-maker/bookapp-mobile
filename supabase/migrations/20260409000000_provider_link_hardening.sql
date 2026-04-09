-- =============================================================================
-- Migration: Provider-link hardening + canonical book metadata fields
-- Created:   2026-04-09
-- =============================================================================
--
-- A. books — add cover_source, metadata_confidence
--    These let us track where a cover came from and how confident we are
--    in the overall metadata quality without touching provider-specific logic.
--
-- B. book_source_links — add raw_payload, last_fetched_at, fetch_status
--    Turns the existing thin source-link table into a full provider-audit
--    trail.  The unique constraint (source, source_book_id) stays unchanged.
--
-- =============================================================================

-- =============================================================================
-- A. books: canonical metadata provenance fields
-- =============================================================================

alter table books
  add column if not exists cover_source          text,
  add column if not exists metadata_confidence   text
    check (metadata_confidence is null or metadata_confidence in ('high','medium','low'));

comment on column books.cover_source is
  'Provider that supplied the current cover_url: google_books | open_library | user_upload | null';

comment on column books.metadata_confidence is
  'Confidence tier for canonical metadata: high (isbn-matched) | medium (title+author matched) | low (unverified)';

-- =============================================================================
-- B. book_source_links: provider audit trail
-- =============================================================================

alter table book_source_links
  add column if not exists raw_payload       jsonb,
  add column if not exists last_fetched_at   timestamptz,
  add column if not exists fetch_status      text default 'success'
    check (fetch_status is null or fetch_status in ('success','failed','rate_limited'));

comment on column book_source_links.raw_payload is
  'Raw JSON response item from the provider API — preserved for debug and reprocessing';

comment on column book_source_links.last_fetched_at is
  'Timestamp of the most recent successful provider fetch for this link';

comment on column book_source_links.fetch_status is
  'Outcome of the most recent fetch attempt: success | failed | rate_limited';

-- Index to support "give me all Google Books links fetched before T" queries
-- (useful for cache-staleness checks without a full scan).
create index if not exists idx_book_source_links_provider_fetched
  on book_source_links (source, last_fetched_at desc nulls last)
  where last_fetched_at is not null;
