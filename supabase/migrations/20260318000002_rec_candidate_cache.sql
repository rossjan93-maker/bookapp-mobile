-- =============================================================================
-- rec_candidate_cache
--
-- Stores externally-fetched recommendation candidates (Open Library) per user
-- so that:
--   1. Subsequent hub loads read from cache instead of hitting the OL API
--   2. Cached books are inspectable/auditable (source, retrieval_reason)
--   3. The canonical recommendation-eligible pool is explicit:
--        - books (catalog tier, eligibility-filtered)       → source 'catalog'
--        - rec_candidate_cache rows                         → source 'cached_external'
--        - live OL rows (current session, pre-cache write)  → source 'open_library'
--
-- Cache freshness: 24 hours. Rows older than that trigger a live re-fetch.
-- Conflict resolution: upsert on (user_id, external_id) — refreshes cached_at.
-- =============================================================================

create table if not exists rec_candidate_cache (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  external_id      text        not null,        -- OL /works/OLxxxW key
  source           text        not null default 'open_library',
  retrieval_reason text,                        -- e.g. 'ol:genre:thriller_mystery'
  title            text        not null,
  author           text,
  cover_url        text,
  subjects         text[],
  page_count       integer,
  cached_at        timestamptz not null default now(),

  unique (user_id, external_id)
);

alter table rec_candidate_cache enable row level security;

create policy "users manage own rec candidate cache"
  on rec_candidate_cache for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists rec_candidate_cache_user_cached
  on rec_candidate_cache (user_id, cached_at desc);
