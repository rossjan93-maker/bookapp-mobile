-- ─────────────────────────────────────────────────────────────────────────────
-- rec_cache — per-user cached recommendation sets + reader thesis
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.rec_cache (
  user_id         uuid primary key references auth.users(id) on delete cascade,

  -- Which pipeline produced this result
  mode            text not null check (mode in ('deterministic', 'expert')),

  -- Cached recommendation set (array of ScoredBook-like objects with expert fields)
  rec_set         jsonb not null default '[]',

  -- Reader thesis — only populated in expert mode
  reader_thesis   jsonb,

  -- Cache validity
  built_at        timestamptz not null default now(),
  valid_until     timestamptz not null,

  -- Invalidation signals snapshot (used to detect when to rebuild)
  -- Stores: { signal_count, feedback_count, import_complete, last_rated_at }
  signal_snapshot jsonb not null default '{}',

  -- Debug metadata (refresh reason, cost, etc.)
  debug_meta      jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.rec_cache enable row level security;

create policy "users can read own rec cache"
  on public.rec_cache for select
  using (auth.uid() = user_id);

create policy "users can insert own rec cache"
  on public.rec_cache for insert
  with check (auth.uid() = user_id);

create policy "users can update own rec cache"
  on public.rec_cache for update
  using (auth.uid() = user_id);

create index if not exists rec_cache_user_id_idx
  on public.rec_cache (user_id);
create index if not exists rec_cache_valid_until_idx
  on public.rec_cache (valid_until);
