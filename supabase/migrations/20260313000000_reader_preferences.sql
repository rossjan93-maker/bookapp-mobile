-- =============================================================================
-- Migration: Reader Preferences + Books external_id nullable fix
-- Created:   2026-03-13
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Fix: books.external_id should be nullable for manually-added books
-- ---------------------------------------------------------------------------

alter table books alter column external_id drop not null;

-- ---------------------------------------------------------------------------
-- reader_preferences
-- ---------------------------------------------------------------------------

create table reader_preferences (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null unique references profiles (id),
  favorite_genres  text[]      not null default '{}',
  avoid_genres     text[]      not null default '{}',
  favorite_authors text,
  reading_styles   text[]      not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table reader_preferences enable row level security;

create index idx_reader_preferences_user_id on reader_preferences (user_id);

create policy "Users can view their own preferences"
  on reader_preferences for select
  using (auth.uid() = user_id);

create policy "Users can insert their own preferences"
  on reader_preferences for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own preferences"
  on reader_preferences for update
  using (auth.uid() = user_id);
