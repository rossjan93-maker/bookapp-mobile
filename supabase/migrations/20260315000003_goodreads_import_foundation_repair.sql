-- =============================================================================
-- Migration: Goodreads Import Foundation — Non-Destructive Repair
-- Created:   2026-03-15
-- Follows:   20260315000001_goodreads_import_foundation.sql
-- =============================================================================
-- Purpose
-- -------
-- Ensure all Goodreads import foundation objects exist and are usable,
-- without relying on DROP POLICY or any other destructive pattern.
-- Safe to run whether the original foundation migration was fully applied,
-- partially applied, or has not been applied at all.
--
-- Why a new file rather than re-running the original?
--   The original uses DROP POLICY IF EXISTS, which Supabase flags as
--   potentially destructive.  This repair file uses DO $$ ... $$ blocks
--   that check pg_policies / pg_constraint before creating anything, so
--   every statement is additive / conditional only.
--
-- Rules enforced throughout this file
-- ------------------------------------
--   Tables     →  CREATE TABLE IF NOT EXISTS
--   Columns    →  ADD COLUMN IF NOT EXISTS
--   Indexes    →  CREATE INDEX IF NOT EXISTS
--   Policies   →  DO $$ IF NOT EXISTS (pg_policies check) THEN CREATE POLICY
--   Constraints→  DO $$ IF NOT EXISTS (pg_constraint check) THEN ALTER TABLE
--   No DROP of any kind.
--   No data resets.
-- =============================================================================


-- =============================================================================
-- A. books: enrich metadata columns
-- =============================================================================
-- ISBN as text (not numeric): leading zeros must be preserved.
-- publication_year / original_publication_year kept as integer (year only).

alter table books
  add column if not exists isbn                      text,
  add column if not exists isbn13                    text,
  add column if not exists additional_authors        text,
  add column if not exists publisher                 text,
  add column if not exists binding                   text,
  add column if not exists publication_year          integer,
  add column if not exists original_publication_year integer;

create index if not exists idx_books_isbn
  on books (isbn)   where isbn   is not null;

create index if not exists idx_books_isbn13
  on books (isbn13) where isbn13 is not null;


-- =============================================================================
-- B. user_books: import provenance + reading-memory fields
-- =============================================================================

alter table user_books
  -- Reading memory
  add column if not exists date_added                date,
  add column if not exists review_body               text,
  add column if not exists private_note              text,
  add column if not exists review_contains_spoiler   boolean     not null default false,
  add column if not exists read_count                integer,
  add column if not exists owned_copies              integer,

  -- Raw import shelf data (preserved verbatim for future re-processing)
  add column if not exists raw_shelves               text[],
  add column if not exists raw_shelf_positions       jsonb,
  add column if not exists exclusive_shelf_imported  text,

  -- Import provenance (orthogonal to app-native source attribution)
  add column if not exists import_source             text,
  add column if not exists import_source_book_id     text,
  add column if not exists import_batch_id           uuid,
  add column if not exists imported_at               timestamptz;


-- =============================================================================
-- C. import_batches
-- =============================================================================

create table if not exists import_batches (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references profiles(id) on delete cascade,
  source          text        not null,
  filename        text,
  status          text        not null default 'pending'
                              check (status in ('pending', 'processing', 'complete', 'failed')),
  total_rows      integer,
  imported_rows   integer,
  skipped_rows    integer,
  failed_rows     integer,
  review_needed   integer,
  error_message   text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);

alter table import_batches enable row level security;


-- =============================================================================
-- D. import_rows
-- =============================================================================

create table if not exists import_rows (
  id                        uuid        primary key default gen_random_uuid(),
  batch_id                  uuid        not null references import_batches(id) on delete cascade,
  user_id                   uuid        not null references profiles(id)       on delete cascade,

  raw_data                  jsonb       not null default '{}',

  title                     text,
  author                    text,
  isbn                      text,
  isbn13                    text,
  additional_authors        text,
  publisher                 text,
  binding                   text,
  publication_year          integer,
  original_publication_year integer,

  date_read                 date,
  date_added                date,
  exclusive_shelf           text,
  raw_shelves               text[],
  source_rating             integer,
  review_body               text,
  read_count                integer,
  owned_copies              integer,

  matched_book_id           uuid        references books(id),
  match_confidence          numeric(4,3) check (match_confidence between 0 and 1),
  match_method              text,

  resolution                text        not null default 'pending'
                             check (resolution in (
                               'pending',
                               'matched',
                               'created',
                               'merged',
                               'skipped',
                               'failed',
                               'review_needed'
                             )),
  user_book_id              uuid        references user_books(id),
  error_message             text,
  review_reason             text,

  created_at                timestamptz not null default now(),
  resolved_at               timestamptz
);

alter table import_rows enable row level security;


-- =============================================================================
-- E. book_source_links
-- =============================================================================

create table if not exists book_source_links (
  id             uuid        primary key default gen_random_uuid(),
  book_id        uuid        not null references books(id) on delete cascade,
  source         text        not null,
  source_book_id text        not null,
  source_url     text,
  created_at     timestamptz not null default now(),

  unique (source, source_book_id)
);

alter table book_source_links enable row level security;


-- =============================================================================
-- F. Indexes
-- =============================================================================

create index if not exists idx_import_batches_user_id
  on import_batches (user_id, created_at desc);

create index if not exists idx_import_batches_status
  on import_batches (status) where status in ('pending', 'processing');

create index if not exists idx_import_rows_batch_id
  on import_rows (batch_id);

create index if not exists idx_import_rows_user_id
  on import_rows (user_id);

create index if not exists idx_import_rows_resolution
  on import_rows (batch_id, resolution);

create index if not exists idx_import_rows_matched_book
  on import_rows (matched_book_id) where matched_book_id is not null;

create index if not exists idx_book_source_links_book_id
  on book_source_links (book_id);

create index if not exists idx_book_source_links_source
  on book_source_links (source, source_book_id);

create index if not exists idx_user_books_import_batch
  on user_books (import_batch_id) where import_batch_id is not null;

create index if not exists idx_user_books_import_source
  on user_books (import_source, import_source_book_id)
  where import_source is not null;


-- =============================================================================
-- G. RLS Policies
-- =============================================================================
-- Each policy is wrapped in a DO block that checks pg_policies first.
-- If the policy already exists (from a previous run of this or the original
-- migration) the block does nothing.  No DROP of any kind is used.

-- ── import_batches ───────────────────────────────────────────────────────────

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename  = 'import_batches'
      and policyname = 'Users manage own import batches'
  ) then
    create policy "Users manage own import batches"
      on import_batches for all
      using  (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;

-- ── import_rows ──────────────────────────────────────────────────────────────

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename  = 'import_rows'
      and policyname = 'Users access own import rows'
  ) then
    create policy "Users access own import rows"
      on import_rows for all
      using (
        exists (
          select 1 from import_batches b
          where b.id      = import_rows.batch_id
            and b.user_id = auth.uid()
        )
      )
      with check (auth.uid() = user_id);
  end if;
end $$;

-- ── book_source_links ─────────────────────────────────────────────────────────

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename  = 'book_source_links'
      and policyname = 'Authenticated users can read book source links'
  ) then
    create policy "Authenticated users can read book source links"
      on book_source_links for select
      using (auth.role() = 'authenticated');
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename  = 'book_source_links'
      and policyname = 'Authenticated users can insert book source links'
  ) then
    create policy "Authenticated users can insert book source links"
      on book_source_links for insert
      with check (auth.role() = 'authenticated');
  end if;
end $$;


-- =============================================================================
-- H. FK: user_books.import_batch_id → import_batches.id
-- =============================================================================
-- Added in a DO block so it is safe whether or not the FK already exists.

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname    = 'fk_user_books_import_batch'
      and conrelid   = 'user_books'::regclass
  ) then
    alter table user_books
      add constraint fk_user_books_import_batch
      foreign key (import_batch_id)
      references import_batches(id)
      on delete set null;
  end if;
end $$;
