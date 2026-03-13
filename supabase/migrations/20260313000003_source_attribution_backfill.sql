-- =============================================================================
-- Migration: Source Attribution Backfill
-- Created:   2026-03-13
-- =============================================================================
-- Historical user_books rows that were created from a recommendation carry
-- source = 'self_added' (the column default) because they predate attribution
-- tracking. This migration corrects them using the ground-truth join:
--   recommendations.user_book_id → user_books.id
--
-- The WHERE source = 'self_added' guard makes this idempotent — safe to re-run.
-- =============================================================================

update user_books
set    source = 'recommendation'
where  id in (
         select user_book_id
         from   recommendations
         where  user_book_id is not null
       )
and    source = 'self_added';
