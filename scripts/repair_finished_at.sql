-- =============================================================================
-- repair_finished_at.sql
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor).
-- It bypasses RLS and directly shows + fixes bad finished_at timestamps.
-- =============================================================================

-- ── STEP 1: AUDIT — show what is currently wrong ─────────────────────────────
-- Books with status='finished', finished_at in the current year (2026),
-- but whose linked import_row has a date_read from a prior year.
-- These are "incorrectly dated" rows that will be repaired.

SELECT
  ub.id               AS user_book_id,
  p.username,
  b.title,
  b.author,
  ub.finished_at      AS current_finished_at,
  ir.date_read        AS goodreads_date_read,
  EXTRACT(YEAR FROM ir.date_read::timestamptz)  AS goodreads_year,
  ub.import_source,
  ir.match_method,
  ir.match_confidence
FROM user_books ub
JOIN books b          ON b.id = ub.book_id
JOIN profiles p       ON p.id = ub.user_id
JOIN import_rows ir   ON ir.user_book_id = ub.id
WHERE ub.status = 'finished'
  AND ub.finished_at >= '2026-01-01T00:00:00Z'
  AND ir.date_read IS NOT NULL
  AND ir.date_read < '2026-01-01'
ORDER BY p.username, ir.date_read;

-- ── STEP 2: AUDIT — flagged books (no reliable import date) ──────────────────
-- Books with status='finished' and finished_at in 2026 but no import date to
-- cross-reference. These need manual user review.

SELECT
  ub.id               AS user_book_id,
  p.username,
  b.title,
  b.author,
  ub.finished_at      AS current_finished_at,
  ub.import_source,
  CASE
    WHEN ub.import_source = 'goodreads' THEN 'Goodreads import — CSV had no Date Read'
    ELSE 'Manually added — no source date to verify against'
  END AS reason
FROM user_books ub
JOIN books b     ON b.id = ub.book_id
JOIN profiles p  ON p.id = ub.user_id
WHERE ub.status = 'finished'
  AND ub.finished_at >= '2026-01-01T00:00:00Z'
  AND NOT EXISTS (
    SELECT 1 FROM import_rows ir
    WHERE ir.user_book_id = ub.id
      AND ir.date_read IS NOT NULL
  )
ORDER BY p.username, b.title;

-- ── STEP 3: PRE-REPAIR count — yearly goal state before fix ──────────────────

SELECT
  p.username,
  COUNT(*) AS books_counted_this_year_BEFORE
FROM user_books ub
JOIN profiles p ON p.id = ub.user_id
WHERE ub.status = 'finished'
  AND ub.finished_at >= '2026-01-01T00:00:00Z'
GROUP BY p.username
ORDER BY p.username;

-- ── STEP 4: APPLY REPAIR — update finished_at from Goodreads date_read ────────
-- Only updates rows where:
--   a) status = 'finished'
--   b) current finished_at is in 2026 (wrong)
--   c) import_row has a non-null date_read from a prior year (the truth)
-- Uses DISTINCT ON to take the highest-confidence import row per user_book.

UPDATE user_books ub
SET finished_at = best.date_read_ts
FROM (
  SELECT DISTINCT ON (ir.user_book_id)
    ir.user_book_id,
    (ir.date_read::text || 'T00:00:00.000Z')::timestamptz AS date_read_ts
  FROM import_rows ir
  WHERE ir.date_read IS NOT NULL
    AND ir.date_read < '2026-01-01'
  ORDER BY ir.user_book_id, ir.match_confidence DESC NULLS LAST
) AS best
WHERE ub.id = best.user_book_id
  AND ub.status = 'finished'
  AND ub.finished_at >= '2026-01-01T00:00:00Z'
RETURNING
  ub.id          AS user_book_id,
  ub.user_id,
  (SELECT title FROM books WHERE id = ub.book_id) AS title,
  best.date_read_ts  AS new_finished_at;

-- ── STEP 5: POST-REPAIR count — yearly goal state after fix ──────────────────

SELECT
  p.username,
  COUNT(*) AS books_counted_this_year_AFTER
FROM user_books ub
JOIN profiles p ON p.id = ub.user_id
WHERE ub.status = 'finished'
  AND ub.finished_at >= '2026-01-01T00:00:00Z'
GROUP BY p.username
ORDER BY p.username;

-- ── STEP 6: POST-REPAIR — show the remaining "this year" list ────────────────

SELECT
  p.username,
  b.title,
  b.author,
  ub.finished_at,
  ub.import_source
FROM user_books ub
JOIN books b     ON b.id = ub.book_id
JOIN profiles p  ON p.id = ub.user_id
WHERE ub.status = 'finished'
  AND ub.finished_at >= '2026-01-01T00:00:00Z'
ORDER BY p.username, ub.finished_at DESC;

-- ── STEP 7: DUPLICATE CHECK ───────────────────────────────────────────────────
-- The DB unique(user_id, book_id) constraint prevents true duplicates, but
-- verify no anomalies exist.

SELECT
  p.username,
  b.title,
  COUNT(*) AS row_count
FROM user_books ub
JOIN books b     ON b.id = ub.book_id
JOIN profiles p  ON p.id = ub.user_id
GROUP BY p.username, b.title, ub.user_id, ub.book_id
HAVING COUNT(*) > 1
ORDER BY row_count DESC, p.username;
