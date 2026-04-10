-- =============================================================================
-- Diagnostic: Classify remaining books with cover_source IS NULL
-- Created:   2026-04-10
-- =============================================================================
-- Run this in Supabase SQL Editor to get the full classification report.
-- Produces three result sets:
--   1. Summary: counts by category
--   2. Examples: 5 representative rows per category
--   3. Detail: full list of remaining books for hand-review
-- =============================================================================


-- =============================================================================
-- RESULT SET 1 — Summary counts by category
-- =============================================================================

WITH classified AS (
  SELECT
    b.id,
    b.title,
    b.author,
    b.cover_url,
    b.description,
    b.isbn13,
    b.isbn,
    CASE
      -- GB URL with parseable volume ID (should have been caught by backfill)
      WHEN b.cover_url LIKE '%books.google.com%'
        AND (regexp_match(b.cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] IS NOT NULL
        THEN 'gb_url_parseable'

      -- GB URL but volume ID unextractable (malformed URL)
      WHEN b.cover_url LIKE '%books.google.com%'
        THEN 'gb_url_malformed'

      -- Open Library cover URL (backfill missed these — different domain)
      WHEN b.cover_url LIKE '%covers.openlibrary.org%'
        THEN 'open_library_url'

      -- Goodreads / Amazon CDN (imported from Goodreads export)
      WHEN b.cover_url LIKE '%i.gr-assets.com%'
        OR  b.cover_url LIKE '%images-na.ssl-images-amazon.com%'
        OR  b.cover_url LIKE '%m.media-amazon.com%'
        OR  b.cover_url LIKE '%goodreads.com%'
        THEN 'goodreads_cdn'

      -- Some other recognisable CDN / external URL
      WHEN b.cover_url IS NOT NULL
        AND b.cover_url NOT LIKE '%books.google.com%'
        AND b.cover_url NOT LIKE '%covers.openlibrary.org%'
        THEN 'other_external_url'

      -- No cover at all — needs repair / provider fetch
      WHEN b.cover_url IS NULL
        THEN 'no_cover'

      ELSE 'uncategorised'
    END AS category
  FROM books b
  WHERE b.cover_source IS NULL
)
SELECT
  category,
  COUNT(*) AS count,
  CASE category
    WHEN 'gb_url_parseable'  THEN 'Re-run Section 2 of backfill script — skipped on first pass'
    WHEN 'gb_url_malformed'  THEN 'Inspect URL structure; may need manual source_book_id or re-fetch'
    WHEN 'open_library_url'  THEN 'UPDATE books SET cover_source=''open_library'' WHERE cover_url LIKE ''%covers.openlibrary.org%'''
    WHEN 'goodreads_cdn'     THEN 'Set cover_source=''goodreads''; optionally replace with GB cover via repair'
    WHEN 'other_external_url' THEN 'Manual review; may be user-uploaded or unknown CDN'
    WHEN 'no_cover'          THEN 'Run repairBooksMetadata — these have never had a cover fetched'
    ELSE                          'Manual triage required'
  END AS recommended_action
FROM classified
GROUP BY category
ORDER BY count DESC;


-- =============================================================================
-- RESULT SET 2 — 5 representative examples per category
-- =============================================================================

WITH classified AS (
  SELECT
    b.id,
    b.title,
    b.author,
    b.cover_url,
    b.description IS NOT NULL AS has_desc,
    b.isbn13,
    b.isbn,
    b.page_count,
    CASE
      WHEN b.cover_url LIKE '%books.google.com%'
        AND (regexp_match(b.cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] IS NOT NULL
        THEN 'gb_url_parseable'
      WHEN b.cover_url LIKE '%books.google.com%'
        THEN 'gb_url_malformed'
      WHEN b.cover_url LIKE '%covers.openlibrary.org%'
        THEN 'open_library_url'
      WHEN b.cover_url LIKE '%i.gr-assets.com%'
        OR  b.cover_url LIKE '%images-na.ssl-images-amazon.com%'
        OR  b.cover_url LIKE '%m.media-amazon.com%'
        OR  b.cover_url LIKE '%goodreads.com%'
        THEN 'goodreads_cdn'
      WHEN b.cover_url IS NOT NULL
        THEN 'other_external_url'
      WHEN b.cover_url IS NULL
        THEN 'no_cover'
      ELSE 'uncategorised'
    END AS category,
    -- Extract volume ID for GB categories
    (regexp_match(b.cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] AS extracted_volume_id
  FROM books b
  WHERE b.cover_source IS NULL
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY category ORDER BY title) AS rn
  FROM classified
)
SELECT
  category,
  rn          AS example_num,
  title,
  author,
  isbn13,
  isbn,
  has_desc,
  page_count,
  extracted_volume_id,
  left(cover_url, 80) AS cover_url_prefix
FROM ranked
WHERE rn <= 5
ORDER BY category, rn;


-- =============================================================================
-- RESULT SET 3 — Full list for hand-review (all remaining books)
-- =============================================================================

SELECT
  b.id,
  b.title,
  b.author,
  b.isbn13,
  b.isbn,
  b.cover_url IS NOT NULL AS has_cover,
  b.description IS NOT NULL AS has_desc,
  b.page_count,
  left(b.cover_url, 100) AS cover_url_prefix,
  CASE
    WHEN b.cover_url LIKE '%books.google.com%'
      AND (regexp_match(b.cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] IS NOT NULL
      THEN 'gb_url_parseable'
    WHEN b.cover_url LIKE '%books.google.com%'
      THEN 'gb_url_malformed'
    WHEN b.cover_url LIKE '%covers.openlibrary.org%'
      THEN 'open_library_url'
    WHEN b.cover_url LIKE '%i.gr-assets.com%'
      OR  b.cover_url LIKE '%images-na.ssl-images-amazon.com%'
      OR  b.cover_url LIKE '%m.media-amazon.com%'
      OR  b.cover_url LIKE '%goodreads.com%'
      THEN 'goodreads_cdn'
    WHEN b.cover_url IS NOT NULL
      THEN 'other_external_url'
    WHEN b.cover_url IS NULL
      THEN 'no_cover'
    ELSE 'uncategorised'
  END AS category,
  (regexp_match(b.cover_url, '[?&]id=([A-Za-z0-9_-]+)'))[1] AS extracted_volume_id,
  -- Show if any book_source_links row exists for this book at all
  EXISTS (
    SELECT 1 FROM book_source_links bsl
    WHERE bsl.book_id = b.id AND bsl.source = 'google_books'
  ) AS has_gb_link
FROM books b
WHERE b.cover_source IS NULL
ORDER BY
  CASE
    WHEN b.cover_url LIKE '%books.google.com%' THEN 0
    WHEN b.cover_url LIKE '%covers.openlibrary.org%' THEN 1
    WHEN b.cover_url IS NULL THEN 2
    ELSE 3
  END,
  b.title;
