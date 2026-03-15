-- =============================================================================
-- Migration: Add subjects column to books table
-- Created:   2026-03-15
-- =============================================================================
-- Persists Open Library subjects so there is a structural link between a
-- book's taxonomy and the user's genre preferences. Populated silently
-- from Book Detail when OL metadata is fetched and the column is null.

alter table books
  add column if not exists subjects text[];
