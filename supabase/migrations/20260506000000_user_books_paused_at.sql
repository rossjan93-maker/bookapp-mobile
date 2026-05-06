-- =============================================================================
-- Explicit user-set "paused" state for a currently-reading book
--
-- Until now `Paused` was inferred purely from inactivity (no progress update
-- in 14–60 days, see lib/pacing.ts → inferReadState). Readers who knew they
-- were stepping away from a book had no way to label it as such — they had
-- to either DNF it (which records a permanent abandon and affects taste
-- signals) or wait for the inactivity threshold to surface the Paused pill.
--
-- `paused_at` is a self-set timestamp on user_books. When non-null on a row
-- whose status is 'reading', the read-state inference returns 'paused' even
-- when activity is recent. Setting status to 'finished' / 'dnf' / 'want_to_read'
-- (via transitionStatus) clears it. Pure metadata: does not affect pacing
-- calculations or session aggregation.
-- =============================================================================

ALTER TABLE user_books
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;
