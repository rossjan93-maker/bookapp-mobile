-- =============================================================================
-- Migration: Add taste_tags column to user_books
-- Created:   2026-03-18
-- =============================================================================
-- Stores optional structured taste signals captured after a user finishes a
-- book.  Format: { "liked": ["pacing","characters"], "didnt_work": ["ending"] }
-- Used for future persona modelling and "why this fits you" explanations.

alter table user_books
  add column if not exists taste_tags jsonb;
