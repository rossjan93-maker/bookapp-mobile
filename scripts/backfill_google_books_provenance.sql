-- =============================================================================
-- Backfill: Google Books provenance for books with GB cover URLs
-- Created:   2026-04-10
-- =============================================================================
--
-- Context
-- -------
-- Books imported before the cover_source / book_source_links audit trail was
-- in place received Google Books cover URLs (books.google.com/books/content?id=…)
-- but never had provenance recorded:
--   - books.cover_source  stayed null
--   - no google_books row written to book_source_links
--
-- This script is idempotent — safe to run multiple times.
-- It does not touch books that already have cover_source set.
-- It does not overwrite existing successful book_source_links rows.
--
-- Prerequisites
-- -------------
-- The migration 20260410000000_fix_book_source_links_conflict_key.sql must have
-- been applied first (adds the UNIQUE (book_id, source) constraint used by
-- ON CONFLICT below).
--
-- =============================================================================


-- =============================================================================
-- SECTION 0 — Pre-flight: how many books need this backfill?
-- Run this SELECT first; it does not modify anything.
-- =============================================================================

SELECT
  COUNT(*)                                              AS books_needing_backfill,
  COUNT(DISTINCT
    (regexp_match(cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1]
  )                                                     AS distinct_volume_ids
FROM books
WHERE cover_url LIKE '%books.google.com%'
  AND cover_source IS NULL
  AND (regexp_match(cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] IS NOT NULL;


-- =============================================================================
-- SECTION 1 — Backfill books.cover_source
--
-- Sets cover_source = 'google_books' for every book whose cover_url is a
-- Google Books URL and whose cover_source is still null.
-- Only touches rows where the volume ID can be extracted from the URL.
-- =============================================================================

UPDATE books
SET
  cover_source = 'google_books',
  updated_at   = now()
WHERE cover_url  LIKE '%books.google.com%'
  AND cover_source IS NULL
  AND (regexp_match(cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] IS NOT NULL;


-- =============================================================================
-- SECTION 2 — Backfill book_source_links
--
-- Inserts a success provenance row for every book whose cover_url is a GB URL.
-- Uses ON CONFLICT (book_id, source) — requires the new unique constraint.
--
-- On conflict:
--   - If the existing row is a failed sentinel (source_book_id LIKE 'bookid:%'
--     or fetch_status != 'success'), upgrade it to a success row.
--   - If a real success row already exists, leave it completely untouched.
-- =============================================================================

INSERT INTO book_source_links (
  book_id,
  source,
  source_book_id,
  fetch_status,
  last_fetched_at,
  raw_payload,
  created_at
)
SELECT
  b.id                                                                  AS book_id,
  'google_books'                                                        AS source,
  (regexp_match(b.cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1]            AS source_book_id,
  'success'                                                             AS fetch_status,
  now()                                                                 AS last_fetched_at,
  jsonb_build_object(
    'backfill',    true,
    'backfill_at', now()::text,
    'cover_url',   b.cover_url,
    'title',       b.title,
    'author',      b.author
  )                                                                     AS raw_payload,
  now()                                                                 AS created_at
FROM books b
WHERE b.cover_url LIKE '%books.google.com%'
  AND (regexp_match(b.cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] IS NOT NULL
ON CONFLICT (book_id, source)
  DO UPDATE SET
    source_book_id  = EXCLUDED.source_book_id,
    fetch_status    = 'success',
    last_fetched_at = now(),
    raw_payload     = EXCLUDED.raw_payload
  WHERE
    book_source_links.source_book_id LIKE 'bookid:%'
    OR book_source_links.fetch_status != 'success';


-- =============================================================================
-- SECTION 3 — Verification
-- Run after sections 1 + 2 to confirm the backfill is complete.
-- =============================================================================

-- A. This specific book (Before We Were Strangers)
SELECT
  b.title,
  b.author,
  b.cover_source,
  b.metadata_confidence,
  bsl.source_book_id,
  bsl.fetch_status,
  bsl.last_fetched_at IS NOT NULL AS has_timestamp,
  bsl.raw_payload IS NOT NULL     AS has_payload,
  (bsl.raw_payload ->> 'backfill')::bool AS was_backfilled
FROM books b
LEFT JOIN book_source_links bsl
  ON bsl.book_id = b.id AND bsl.source = 'google_books'
WHERE b.id = '2a411899-a3eb-4732-9a63-71ced63d9d24';
-- Expect:
--   cover_source     = 'google_books'
--   source_book_id   = 'FMAvBgAAQBAJ'
--   fetch_status     = 'success'
--   has_timestamp    = true
--   has_payload      = true
--   was_backfilled   = true

-- B. Remaining gap: how many books still have cover_url without cover_source?
SELECT
  COUNT(*) FILTER (WHERE cover_url IS NOT NULL AND cover_source IS NULL) AS remaining_gap,
  COUNT(*) FILTER (WHERE cover_url IS NOT NULL AND cover_source IS NOT NULL) AS with_provenance,
  COUNT(*) FILTER (WHERE cover_url IS NOT NULL) AS total_with_cover
FROM books;
-- After the backfill: remaining_gap should = 0 for GB-covered books.
-- (Non-GB covers without a known source will still show here until separately addressed.)

-- C. Spot-check: all backfilled rows in book_source_links
SELECT
  b.title,
  b.author,
  bsl.source_book_id,
  bsl.fetch_status,
  (bsl.raw_payload ->> 'backfill')::bool AS was_backfilled,
  bsl.last_fetched_at
FROM book_source_links bsl
JOIN books b ON b.id = bsl.book_id
WHERE bsl.source = 'google_books'
  AND (bsl.raw_payload ->> 'backfill')::bool = true
ORDER BY bsl.last_fetched_at DESC;
