-- =============================================================================
-- Diagnose Open Library cover-source consistency
-- =============================================================================
-- Run in Supabase SQL Editor (or via psql against your project).
--
-- Checks:
--   1. OL-sourced books whose cover_url doesn't match the expected OL domain.
--      These are inconsistent — source says OL but URL is not OL.
--
--   2. OL-sourced books that have an ISBN (isbn13 or isbn).
--      These are upgrade candidates: an ISBN-matched GB fetch could supersede
--      the OL cover during the next repair pass.
--
--   3. OL-sourced books with no description.
--      OL is the best description source; if description is still missing,
--      the OL external_id may be wrong or the OL work has no description.
--
--   4. Books with an OL cover URL but cover_source != 'open_library'.
--      These have a provenance labelling gap (the URL is OL but it wasn't
--      recorded as such — probably pre-migration books).
-- =============================================================================

-- Result 1: Inconsistent OL source label (cover_source='open_library' but URL is not OL)
SELECT
  id,
  title,
  author,
  cover_url,
  cover_source,
  metadata_confidence,
  external_id
FROM books
WHERE cover_source = 'open_library'
  AND (
    cover_url IS NULL
    OR cover_url NOT LIKE '%covers.openlibrary.org%'
  )
ORDER BY title;

-- Result 2: OL-sourced books eligible for GB ISBN upgrade
-- (has isbn and OL cover — next repair pass should evaluate these)
SELECT
  id,
  title,
  author,
  cover_source,
  metadata_confidence,
  COALESCE(isbn13, isbn) AS isbn,
  cover_url
FROM books
WHERE cover_source = 'open_library'
  AND (isbn13 IS NOT NULL OR isbn IS NOT NULL)
ORDER BY title;

-- Result 3: OL-sourced books still missing a description
SELECT
  id,
  title,
  author,
  cover_source,
  external_id,
  cover_url
FROM books
WHERE cover_source = 'open_library'
  AND (description IS NULL OR description = '')
ORDER BY title;

-- Result 4: OL URL with non-OL (or null) cover_source label
SELECT
  id,
  title,
  author,
  cover_url,
  cover_source,
  external_id
FROM books
WHERE cover_url LIKE '%covers.openlibrary.org%'
  AND (cover_source IS NULL OR cover_source != 'open_library')
ORDER BY title;
