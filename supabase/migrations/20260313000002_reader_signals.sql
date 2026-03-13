-- =============================================================================
-- Migration: Reader Signals Foundation
-- Created:   2026-03-13
-- =============================================================================
-- A. reading_progress_events — timestamped reading progress history log
-- B. user_books.sentiment    — optional finish / DNF taste feedback
-- C. user_books.source       — book-source attribution (self_added / recommendation)
-- =============================================================================

-- A. Progress history --------------------------------------------------------

create table if not exists reading_progress_events (
  id           uuid        primary key default gen_random_uuid(),
  user_book_id uuid        not null references user_books(id)  on delete cascade,
  book_id      uuid        not null references books(id)       on delete cascade,
  user_id      uuid        not null references profiles(id)    on delete cascade,
  page         integer     not null check (page >= 0),
  created_at   timestamptz not null default now()
);

alter table reading_progress_events enable row level security;

create policy "Users manage own progress events"
  on reading_progress_events for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Efficient per-book timeline and per-user analytics queries
create index if not exists idx_progress_events_user_book
  on reading_progress_events (user_book_id, created_at);

create index if not exists idx_progress_events_user_id
  on reading_progress_events (user_id, created_at);

-- B. Sentiment feedback ------------------------------------------------------
-- One optional signal per user_book. Kept on user_books (1-to-1) rather than
-- a separate table to avoid extra joins for future taste-fit queries.

alter table user_books
  add column if not exists sentiment text
  check (sentiment in ('loved', 'liked', 'okay', 'not_for_me'));

-- C. Source attribution ------------------------------------------------------
-- Captures where the book entered the library. Default is self_added so all
-- pre-existing rows get a sensible value without a backfill.

alter table user_books
  add column if not exists source text not null default 'self_added'
  check (source in ('self_added', 'recommendation'));
