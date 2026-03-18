-- ─────────────────────────────────────────────────────────────────────────────
-- rec_entitlements — per-user recommendation plan & expert access tracking
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.rec_entitlements (
  user_id                       uuid primary key references auth.users(id) on delete cascade,

  -- Plan tier
  plan                          text not null default 'free'
                                  check (plan in ('free', 'paid', 'beta')),

  -- One-time free expert analysis (granted after import or signal threshold)
  free_expert_used              boolean not null default false,
  free_expert_used_at           timestamptz,

  -- Period-based expert refreshes
  -- Free tier: FREE_EXPERT_REFRESHES_PER_PERIOD (1) refresh per period
  -- Paid tier: unlimited (expert_refreshes_this_period is unused)
  expert_refreshes_this_period  integer not null default 0,
  period_start_at               timestamptz not null default now(),
  last_expert_refresh_at        timestamptz,

  -- Audit
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

alter table public.rec_entitlements enable row level security;

create policy "users can read own entitlement"
  on public.rec_entitlements for select
  using (auth.uid() = user_id);

create policy "users can insert own entitlement"
  on public.rec_entitlements for insert
  with check (auth.uid() = user_id);

create policy "users can update own entitlement"
  on public.rec_entitlements for update
  using (auth.uid() = user_id);

create index if not exists rec_entitlements_user_id_idx
  on public.rec_entitlements (user_id);
