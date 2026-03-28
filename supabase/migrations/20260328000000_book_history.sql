-- =============================================================================
-- Book history + reversible state system
--   • deleted_at  – soft-delete; null = active
--   • finished_year – year-only resolution for finished date
--   • user_book_history – full audit trail for undo and history
-- =============================================================================

-- ── user_books additions ──────────────────────────────────────────────────────

ALTER TABLE user_books
  ADD COLUMN IF NOT EXISTS deleted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS finished_year smallint;

-- ── user_book_history ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_book_history (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_book_id     uuid        NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  prev_status      text,
  prev_started_at  timestamptz,
  prev_finished_at timestamptz,
  prev_finished_year smallint,
  prev_deleted_at  timestamptz,
  action           text        NOT NULL
    CHECK (action IN ('status_change', 'date_edit', 'delete', 'restore')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_book_history ENABLE ROW LEVEL SECURITY;

-- Users can read/insert their own history rows (via the parent user_book).
CREATE POLICY "Users own their book history"
  ON user_book_history
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_books ub
      WHERE ub.id = user_book_id
        AND ub.user_id = auth.uid()
    )
  );

-- Index for fast lookups by user_book_id (most common query).
CREATE INDEX IF NOT EXISTS user_book_history_user_book_id_idx
  ON user_book_history (user_book_id, created_at DESC);
