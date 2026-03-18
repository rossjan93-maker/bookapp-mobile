-- =============================================================================
-- book_enrichment_cache
-- Stores structured enrichment profiles for books fetched from Open Library
-- and Google Books.  Used to improve scoring explanations and candidate hygiene
-- without re-fetching on every recommendation run.
--
-- TTL is application-managed (cached_at compared at read time).
-- external_id is unique — enrichment is shared across users.
-- =============================================================================

create table if not exists book_enrichment_cache (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text        not null,         -- OL works key e.g. /works/OL123456W
  book_id             uuid        references books(id) on delete set null,
  language            text,                         -- ISO 639-1 e.g. 'en'
  first_publish_year  integer,
  consensus_traits    jsonb,                        -- ConsensusTraits shape
  repeated_praise     text[],
  repeated_risks      text[],
  comparable_titles   text[],
  audience_signals    text[],
  popularity_signals  jsonb,                        -- PopularitySignals shape
  source_summary      jsonb,                        -- { google_books?, open_library? }
  cached_at           timestamptz not null default now(),

  constraint book_enrichment_cache_external_id_unique unique (external_id)
);

-- Enrichment is shared data — any authenticated user can read it.
-- Any authenticated user can insert/update (best-effort write from any session).
alter table book_enrichment_cache enable row level security;

create policy "book_enrichment_cache_select"
  on book_enrichment_cache for select
  using (auth.role() = 'authenticated');

create policy "book_enrichment_cache_insert"
  on book_enrichment_cache for insert
  with check (auth.role() = 'authenticated');

create policy "book_enrichment_cache_update"
  on book_enrichment_cache for update
  using (auth.role() = 'authenticated');

create index if not exists book_enrichment_cache_external_id_idx
  on book_enrichment_cache (external_id);

create index if not exists book_enrichment_cache_cached_at_idx
  on book_enrichment_cache (cached_at desc);
