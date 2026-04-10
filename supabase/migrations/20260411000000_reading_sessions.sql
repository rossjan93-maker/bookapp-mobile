-- =============================================================================
-- Migration: Reading Sessions
-- Created:   2026-04-11
--
-- reading_sessions is a richer companion to reading_progress_events.
-- While progress_events records "I am now on page X", a session records
-- "I read from page A to page B today".  Sessions are derived automatically
-- by saveCurrentPage() whenever the user advances their page — no manual
-- session-logging UI is required.
--
-- Sessions are append-only and always represent forward progress (ended_page
-- >= started_page).  Silent regressions (page going backward) do not produce
-- a session row; they remain visible in progress_events for audit purposes.
-- =============================================================================

create table reading_sessions (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references profiles(id)    on delete cascade,
  book_id          uuid        not null references books(id)       on delete cascade,
  user_book_id     uuid        not null references user_books(id)  on delete cascade,

  -- Calendar date of the session (local date formatted YYYY-MM-DD).
  -- Stored as text to avoid timezone ambiguity on clients in different zones.
  -- Streak logic uses this field directly for day-boundary comparisons.
  session_date     text        not null,

  -- Page range read in this session.
  started_page     integer     not null,
  ended_page       integer     not null,
  pages_read       integer     not null,

  -- Optional duration; null when not tracked (v1 always null — reserved for v2).
  duration_minutes integer,

  created_at       timestamptz not null default now(),

  -- Structural integrity: only forward reads are valid sessions.
  constraint reading_sessions_forward_progress
    check (ended_page >= started_page and pages_read >= 0)
);

alter table reading_sessions enable row level security;

create policy "Users manage own reading sessions"
  on reading_sessions for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Per-book timeline: pacing and session history queries, ordered by date.
create index idx_reading_sessions_user_book_date
  on reading_sessions (user_book_id, session_date);

-- Per-user streak and cross-book analytics, ordered by date.
create index idx_reading_sessions_user_date
  on reading_sessions (user_id, session_date);
