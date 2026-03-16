-- =============================================================================
-- Migration: Add description column to books table
-- Created:   2026-03-15
-- =============================================================================
-- Persists book description/about text so that Book Detail can show it without
-- re-fetching on every visit.  Populated silently from Book Detail (Open Library
-- or Google Books) when the column is null.

alter table books
  add column if not exists description text;
