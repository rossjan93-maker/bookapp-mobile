-- =============================================================================
-- Migration: Profiles RLS Policies
-- Created:   2026-03-11
-- =============================================================================
-- Minimum policies needed for the client to create and read its own profile row.
-- RLS is already enabled on profiles from the foundation migration.
-- =============================================================================

create policy "profiles: users can select own row"
  on profiles
  for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles: users can insert own row"
  on profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

create policy "profiles: users can update own row"
  on profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
