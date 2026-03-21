-- =============================================================================
-- Migration: Case-insensitive unique index on profiles.username
-- Created:   2026-03-21
-- =============================================================================
-- The foundation migration enforces uniqueness on the raw username column, but
-- PostgreSQL text comparisons are case-sensitive by default — meaning 'Ross'
-- and 'ross' would be stored as different values.
--
-- The app layer already normalizes usernames to lowercase before writing, but
-- this adds a belt-and-suspenders DB-level guarantee so no bypass (direct SQL,
-- future migration, trigger, etc.) can introduce a case-variant duplicate.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower
  ON profiles (lower(username));
