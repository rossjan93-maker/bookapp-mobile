-- =============================================================================
-- Edition key per user-book
-- Stores the Open Library edition ID (e.g. "OL12345M") that the reader has
-- explicitly chosen for their copy.  Nullable — null means no override.
-- When set, the UI prefers this edition's cover and page count over the
-- canonical books row.
-- =============================================================================

ALTER TABLE user_books
  ADD COLUMN IF NOT EXISTS edition_key text;
