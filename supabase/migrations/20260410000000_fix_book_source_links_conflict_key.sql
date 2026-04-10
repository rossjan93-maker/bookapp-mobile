-- =============================================================================
-- Migration: Fix book_source_links conflict key
-- Created:   2026-04-10
-- =============================================================================
--
-- Problem
-- -------
-- The existing unique constraint (source, source_book_id) is globally scoped:
-- only one row per provider volume ID across ALL users.  When two users have
-- the same book (same GB volume ID), the second upsert tries to UPDATE the
-- first user's row → RLS USING check rejects it with:
--   "new row violates row-level security policy (USING expression)"
--
-- Fix
-- ---
-- Replace with a per-book-per-provider constraint (book_id, source).
-- Each user's copy of a book gets its own independent provider-link row.
-- Multiple users can share the same source_book_id — that's fine.
--
-- Effect on recordProviderLink
-- ----------------------------
-- The upsert in lib/metadataProvider.ts is changed from:
--   onConflict: 'source,source_book_id'
-- to:
--   onConflict: 'book_id,source'
-- Now the upsert only ever touches rows the current user owns → RLS satisfied.
--
-- =============================================================================

-- Step 1: Drop the old globally-scoped unique constraint.
-- The constraint was created by Supabase's default migration naming convention.
-- We try both the auto-generated name and any legacy name.
ALTER TABLE book_source_links
  DROP CONSTRAINT IF EXISTS book_source_links_source_source_book_id_key;

ALTER TABLE book_source_links
  DROP CONSTRAINT IF EXISTS book_source_links_source_source_book_id_unique;

-- Step 2: Add the correct per-book-per-provider unique constraint.
-- This is what onConflict: 'book_id,source' resolves against.
ALTER TABLE book_source_links
  ADD CONSTRAINT book_source_links_book_id_source_unique UNIQUE (book_id, source);

-- Step 3 (optional cleanup): Remove old sentinel rows whose source_book_id is
-- a bookid: placeholder (written when GB failed before we had volume IDs).
-- These are not real provider links.  Comment out if you want to preserve history.
-- DELETE FROM book_source_links WHERE source_book_id LIKE 'bookid:%';

-- Step 4: Add supporting index (covers lookups by book + provider efficiently).
CREATE INDEX IF NOT EXISTS idx_book_source_links_book_source
  ON book_source_links (book_id, source);
