-- =============================================================================
-- Migration: Reading progress + page-count pacing foundation
-- Created:   2026-03-13
-- =============================================================================

-- ---------------------------------------------------------------------------
-- books: add page_count (populated opportunistically from OL or manual entry)
-- ---------------------------------------------------------------------------

alter table books add column if not exists page_count integer;

-- ---------------------------------------------------------------------------
-- user_books: add current_page and progress_updated_at
-- ---------------------------------------------------------------------------

alter table user_books add column if not exists current_page       integer;
alter table user_books add column if not exists progress_updated_at timestamptz;
