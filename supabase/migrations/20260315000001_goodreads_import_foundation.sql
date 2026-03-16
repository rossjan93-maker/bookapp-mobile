-- =============================================================================
-- Migration: Goodreads Import Schema + Provenance Foundation
-- Created:   2026-03-15
-- =============================================================================
-- A. Strengthen book-level metadata
-- B. Strengthen user-memory fields on user_books
-- C. Add import_batches provenance table
-- D. Add import_rows staging table
-- E. Add book_source_links external-ID mapping table
-- F. Indexes and constraints
-- G. RLS policies
-- =============================================================================


-- =============================================================================
-- A. books: enrich metadata
-- =============================================================================
-- ISBN as text (not numeric): leading zeros must be preserved.
-- publication_year / original_publication_year kept as integer (year only).
-- additional_authors / publisher / binding are free-text, nullable.

alter table books
  add column if not exists isbn                     text,
  add column if not exists isbn13                   text,
  add column if not exists additional_authors       text,
  add column if not exists publisher                text,
  add column if not exists binding                  text,
  add column if not exists publication_year         integer,
  add column if not exists original_publication_year integer;

-- Indexes: ISBN lookups are the primary match path for Goodreads imports.
create index if not exists idx_books_isbn   on books (isbn)   where isbn   is not null;
create index if not exists idx_books_isbn13 on books (isbn13) where isbn13 is not null;


-- =============================================================================
-- B. user_books: import provenance + user reading-memory fields
-- =============================================================================
-- Design note:
--   source (existing)         = how the book entered the in-app library
--                               ('self_added' | 'recommendation')
--   import_source (new)       = which external platform supplied this row
--                               ('goodreads' | … future platforms)
-- These are orthogonal: an imported book may later receive a recommendation
-- that changes its in-app source, without losing import provenance.

alter table user_books
  -- Reading memory
  add column if not exists date_added                date,
  add column if not exists review_body               text,
  add column if not exists private_note              text,
  add column if not exists review_contains_spoiler   boolean    not null default false,
  add column if not exists read_count                integer,
  add column if not exists owned_copies              integer,

  -- Raw import shelf data (preserved verbatim for future re-processing)
  add column if not exists raw_shelves               text[],
  add column if not exists raw_shelf_positions       jsonb,
  add column if not exists exclusive_shelf_imported  text,

  -- Import provenance (orthogonal to app-native source attribution)
  add column if not exists import_source             text,
  add column if not exists import_source_book_id     text,
  add column if not exists import_batch_id           uuid,   -- FK added after table creation
  add column if not exists imported_at               timestamptz;


-- =============================================================================
-- C. import_batches
-- =============================================================================
-- One row per upload attempt.  status progresses:
--   pending → processing → complete | failed
-- review_needed counts rows that could not be auto-resolved.

create table if not exists import_batches (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references profiles(id) on delete cascade,
  source          text        not null,          -- 'goodreads', future: 'storygraph', …
  filename        text,                          -- original uploaded filename
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
-- One row per source CSV row.  Stores raw + normalized data, match result,
-- and resolution outcome so the import can be audited, retried, or reviewed.

create table if not exists import_rows (
  id                        uuid        primary key default gen_random_uuid(),
  batch_id                  uuid        not null references import_batches(id) on delete cascade,
  user_id                   uuid        not null references profiles(id)       on delete cascade,

  -- ── Raw source data ─────────────────────────────────────────────────────
  raw_data                  jsonb       not null default '{}',

  -- ── Normalized fields parsed from source ────────────────────────────────
  title                     text,
  author                    text,
  isbn                      text,
  isbn13                    text,
  additional_authors        text,
  publisher                 text,
  binding                   text,
  publication_year          integer,
  original_publication_year integer,

  -- ── User reading data from source ───────────────────────────────────────
  date_read                 date,
  date_added                date,
  exclusive_shelf           text,
  raw_shelves               text[],
  source_rating             integer,          -- raw star value from source (1-5)
  review_body               text,
  read_count                integer,
  owned_copies              integer,

  -- ── Match result ────────────────────────────────────────────────────────
  -- confidence: 0.000 (no match) → 1.000 (exact isbn13 hit)
  matched_book_id           uuid        references books(id),
  match_confidence          numeric(4,3) check (match_confidence between 0 and 1),
  match_method              text,        -- 'isbn13'|'isbn'|'external_id'|'title_author'|null

  -- ── Resolution ──────────────────────────────────────────────────────────
  resolution                text        not null default 'pending'
                             check (resolution in (
                               'pending',
                               'matched',   -- existing book found, user_book written
                               'created',   -- new book inserted, user_book written
                               'merged',    -- merged with existing user_book
                               'skipped',   -- duplicate, no action needed
                               'failed',    -- unrecoverable error
                               'review_needed' -- needs human resolution
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
-- Maps internal book UUIDs to canonical IDs on external platforms.
-- unique(source, source_book_id) prevents duplicate link rows.
-- Designed to be source-agnostic: works for Goodreads today, others later.

create table if not exists book_source_links (
  id             uuid        primary key default gen_random_uuid(),
  book_id        uuid        not null references books(id) on delete cascade,
  source         text        not null,        -- 'goodreads', 'openlibrary', …
  source_book_id text        not null,        -- platform's own ID for the book
  source_url     text,                        -- optional canonical URL
  created_at     timestamptz not null default now(),

  unique (source, source_book_id)
);

alter table book_source_links enable row level security;


-- =============================================================================
-- F. Indexes
-- =============================================================================

-- import_batches
create index if not exists idx_import_batches_user_id
  on import_batches (user_id, created_at desc);

create index if not exists idx_import_batches_status
  on import_batches (status) where status in ('pending', 'processing');

-- import_rows
create index if not exists idx_import_rows_batch_id
  on import_rows (batch_id);

create index if not exists idx_import_rows_user_id
  on import_rows (user_id);

create index if not exists idx_import_rows_resolution
  on import_rows (batch_id, resolution);

create index if not exists idx_import_rows_matched_book
  on import_rows (matched_book_id) where matched_book_id is not null;

-- book_source_links
create index if not exists idx_book_source_links_book_id
  on book_source_links (book_id);

create index if not exists idx_book_source_links_source
  on book_source_links (source, source_book_id);

-- user_books: import lookups
create index if not exists idx_user_books_import_batch
  on user_books (import_batch_id) where import_batch_id is not null;

create index if not exists idx_user_books_import_source
  on user_books (import_source, import_source_book_id)
  where import_source is not null;


-- =============================================================================
-- G. RLS Policies
-- =============================================================================

-- ── import_batches ──────────────────────────────────────────────────────────
-- Users can only see and manage their own batches.

drop policy if exists "Users manage own import batches" on import_batches;
create policy "Users manage own import batches"
  on import_batches for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── import_rows ─────────────────────────────────────────────────────────────
-- A user may access import_rows only when they own the parent batch.
-- The join back to import_batches keeps access airtight even if batch_id is
-- passed directly.

drop policy if exists "Users access own import rows" on import_rows;
create policy "Users access own import rows"
  on import_rows for all
  using (
    exists (
      select 1 from import_batches b
      where b.id = import_rows.batch_id
        and b.user_id = auth.uid()
    )
  )
  with check (auth.uid() = user_id);

-- ── book_source_links ────────────────────────────────────────────────────────
-- Book metadata is global knowledge: any authenticated user can read links.
-- Inserts come from the importer running as the authenticated user.
-- Updates and deletes are locked to service-role only (no client policy),
-- which prevents accidental overwrites of shared book mappings.

drop policy if exists "Authenticated users can read book source links" on book_source_links;
create policy "Authenticated users can read book source links"
  on book_source_links for select
  using (auth.role() = 'authenticated');

drop policy if exists "Authenticated users can insert book source links" on book_source_links;
create policy "Authenticated users can insert book source links"
  on book_source_links for insert
  with check (auth.role() = 'authenticated');


-- =============================================================================
-- FK: user_books.import_batch_id → import_batches.id
-- Added after import_batches is created (ordering requirement).
-- =============================================================================

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_user_books_import_batch'
      and conrelid = 'user_books'::regclass
  ) then
    alter table user_books
      add constraint fk_user_books_import_batch
      foreign key (import_batch_id)
      references import_batches(id)
      on delete set null;
  end if;
end $$;

-- =============================================================================
-- Verification queries (run manually in Supabase SQL editor to confirm)
-- =============================================================================
-- -- Tables
-- select table_name from information_schema.tables
--   where table_schema = 'public'
--     and table_name in ('import_batches','import_rows','book_source_links');
--
-- -- Columns added to books
-- select column_name from information_schema.columns
--   where table_name = 'books'
--     and column_name in ('isbn','isbn13','additional_authors','publisher',
--                         'binding','publication_year','original_publication_year');
--
-- -- Columns added to user_books
-- select column_name from information_schema.columns
--   where table_name = 'user_books'
--     and column_name in ('import_source','import_batch_id','imported_at','date_added',
--                         'review_body','raw_shelves','exclusive_shelf_imported');
--
-- -- RLS policies
-- select policyname, tablename from pg_policies
--   where tablename in ('import_batches','import_rows','book_source_links')
--   order by tablename, policyname;
--
-- -- FK constraint
-- select conname from pg_constraint
--   where conname = 'fk_user_books_import_batch'
--     and conrelid = 'user_books'::regclass;
