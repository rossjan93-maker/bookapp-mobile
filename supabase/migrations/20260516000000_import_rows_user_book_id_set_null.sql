-- =============================================================================
-- Migration: Promote import_rows.user_book_id FK to ON DELETE SET NULL
-- 20260516000000_import_rows_user_book_id_set_null.sql
--
-- Background
-- ──────────
-- 20260515000000_account_deletion_fix_import_rows.sql closed the
-- account-deletion failure by changing three SECURITY DEFINER function
-- bodies (delete_own_account / admin_reset_account / reset_own_data_cold)
-- to delete import_rows BEFORE user_books. That migration explicitly
-- documented a remaining latent risk:
--
--   "There IS a latent secondary bug (per-book DELETE FROM user_books
--    WHERE id = X would trip the same FK if any import_row references
--    that book — affects normal 'remove a book from my library' flow
--    for imported books); that is documented as a remaining risk and
--    intentionally NOT fixed here to keep this patch narrowly scoped to
--    the reported account-deletion blocker. Promotion of the FK to
--    ON DELETE SET NULL would address both in one schema change and is
--    the recommended follow-up."
--
-- This migration is that follow-up.
--
-- Current FK (from 20260315000003_goodreads_import_foundation_repair.sql:147)
-- ─────────────────────────────────────────────────────────────────────────
--   import_rows.user_book_id  uuid  references user_books(id)        -- (no ON DELETE)
--
-- Default behaviour with no ON DELETE clause is NO ACTION (effectively
-- RESTRICT): any DELETE of a user_books row referenced by an import_rows
-- row raises 23503 import_rows_user_book_id_fkey.
--
-- Why ON DELETE SET NULL is the correct shape
-- ────────────────────────────────────────────
-- 1. Column is already nullable (no NOT NULL on the column definition;
--    rows in 'pending' / 'failed' / 'review_needed' state legitimately
--    carry user_book_id = NULL).
-- 2. import_rows is an audit/history record of one-time CSV ingest.
--    It is meaningful to keep the row ("we imported this Goodreads CSV
--    line") even after the user later deletes the resulting user_books
--    entry. SET NULL preserves the audit trail; CASCADE would erase it.
-- 3. user-scoped via user_id NOT NULL → profile cascade still cleans
--    everything on account deletion. The explicit pre-step inserted by
--    20260515000000 in the three deletion functions becomes a
--    defence-in-depth no-op for the user_book_id FK after this migration
--    (it still does useful work: it deletes import_rows owned by the user
--    deterministically before the profile-cascade fires, which keeps
--    those three functions simple to reason about). We deliberately
--    leave the explicit pre-step in place — removing it would couple
--    correctness of the deletion functions to schema state that future
--    migrations could drift.
-- 4. RLS unchanged: SET NULL acts at the constraint layer, not the row
--    visibility layer. The existing "Users access own import rows"
--    policy on import_rows continues to scope reads/writes to rows whose
--    parent batch belongs to auth.uid(). No new grants. No new policies.
-- 5. Global books catalog untouched: this migration only alters the FK
--    on import_rows; it does not touch books, user_books, or any
--    catalog table. matched_book_id (which references books) is also
--    unchanged.
--
-- Behaviour after this migration
-- ──────────────────────────────
-- DELETE FROM user_books WHERE id = X
--   → any import_rows where user_book_id = X get user_book_id = NULL.
--   → resolution / matched_book_id / created_at / raw_data preserved
--     so the audit trail remains intact ("this CSV row was imported,
--     and its resulting library entry was later removed").
--
-- Idempotency
-- ───────────
-- Wrapped in a DO block that drops the existing constraint only if
-- present and re-creates it with ON DELETE SET NULL. Safe to re-apply.
--
-- Scope
-- ─────
-- One FK alter on import_rows. No table change. No column change.
-- No RLS change. No grant change. No function change. No data change.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'import_rows_user_book_id_fkey'
       AND conrelid = 'public.import_rows'::regclass
  ) THEN
    ALTER TABLE public.import_rows
      DROP CONSTRAINT import_rows_user_book_id_fkey;
  END IF;

  ALTER TABLE public.import_rows
    ADD CONSTRAINT import_rows_user_book_id_fkey
    FOREIGN KEY (user_book_id)
    REFERENCES public.user_books(id)
    ON DELETE SET NULL;
END $$;

COMMENT ON CONSTRAINT import_rows_user_book_id_fkey ON public.import_rows IS
  'ON DELETE SET NULL so deleting a single imported user_book preserves the import_rows audit row with user_book_id cleared. Promoted from default NO ACTION on 2026-05-16 (see 20260516000000_import_rows_user_book_id_set_null.sql).';
