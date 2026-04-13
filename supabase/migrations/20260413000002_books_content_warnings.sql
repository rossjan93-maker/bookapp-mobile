-- =============================================================================
-- Migration: Add content_warnings column to books table
-- Created:   2026-04-13
-- =============================================================================
-- Persists derived content-warning tags so they can later be filtered or
-- personalized per user. Populated silently from Book Detail after subjects
-- are fetched and the subject→warning mapping is applied.

alter table books
  add column if not exists content_warnings text[];
