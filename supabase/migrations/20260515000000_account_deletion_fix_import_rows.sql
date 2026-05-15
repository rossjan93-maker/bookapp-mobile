-- =============================================================================
-- Migration: Fix account deletion FK violation against import_rows.user_book_id
-- 20260515000000_account_deletion_fix_import_rows.sql
--
-- Problem
-- ───────
-- Live failure observed from app/settings.tsx → supabase.rpc('delete_own_account'):
--
--   update or delete on table "user_books" violates foreign key constraint
--   "import_rows_user_book_id_fkey" on table "import_rows"
--
-- Reproduces for any user who has imported a Goodreads CSV.
--
-- Root cause
-- ──────────
-- supabase/migrations/20260315000003_goodreads_import_foundation_repair.sql:147
-- defines:
--
--   import_rows.user_book_id  uuid  references user_books(id)        -- (no ON DELETE)
--   import_rows.user_id       uuid  not null references profiles(id) on delete cascade
--   import_rows.batch_id      uuid  not null references import_batches(id) on delete cascade
--
-- The user_book_id FK has no ON DELETE clause and therefore defaults to
-- NO ACTION (effectively RESTRICT). The existing delete_own_account() body
-- (20260330000000_fix_deletion_and_reset.sql Step 5) deletes user_books
-- WHERE user_id = v_uid before reaching Step 7 (DELETE FROM profiles, which
-- WOULD cascade-clean import_rows via the user_id FK). Step 5 therefore
-- trips the user_book_id FK because import_rows still reference the
-- user_books rows we are trying to delete. Same shape applies to:
--   • admin_reset_account()        (same Step 5 in 20260330000000)
--   • reset_own_data_cold()        (DELETE FROM user_books in 20260330000000)
--
-- Fix
-- ───
-- Insert one explicit DELETE step in each function: clear THIS USER's own
-- import_rows BEFORE deleting user_books. This is FK-safe because
-- import_rows is user-scoped (user_id NOT NULL) and the rows are pure
-- audit/history of one-time CSV ingest — they have no value once the
-- user_books they document are gone, and zero value once the account is
-- deleted. import_batches still cascades automatically when profiles is
-- deleted at Step 7, so we do not need to touch it explicitly.
--
-- Why an explicit step instead of altering the FK to ON DELETE CASCADE
-- or SET NULL: the user explicitly preferred the smaller, function-local
-- delete-order fix unless the schema strongly indicated cascade. There IS
-- a latent secondary bug (per-book DELETE FROM user_books WHERE id = X
-- would trip the same FK if any import_row references that book — affects
-- normal "remove a book from my library" flow for imported books); that
-- is documented as a remaining risk and intentionally NOT fixed here to
-- keep this patch narrowly scoped to the reported account-deletion
-- blocker. Promotion of the FK to ON DELETE SET NULL would address both
-- in one schema change and is the recommended follow-up.
--
-- Scope
-- ─────
-- Three CREATE OR REPLACE function bodies, each receiving one new line:
--   DELETE FROM public.import_rows WHERE user_id = v_uid;
-- inserted immediately before the user_books DELETE.
-- No FK changes. No RLS changes. No grant changes. No table changes.
-- Function signatures, security context (DEFINER), search_path, GRANT/REVOKE
-- preserved exactly as in 20260330000000_fix_deletion_and_reset.sql.
-- =============================================================================


-- ─── 1. delete_own_account() ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_own_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  -- Step 1a: activity_events referencing THIS USER's recommendations
  --          (handles cross-user events where actor_id ≠ v_uid)
  DELETE FROM public.activity_events
    WHERE recommendation_id IN (
      SELECT id FROM public.recommendations
       WHERE from_user_id = v_uid OR to_user_id = v_uid
    );

  -- Step 1b: remaining activity_events where the user was the actor
  DELETE FROM public.activity_events
    WHERE actor_id = v_uid;

  -- Step 2a: credibility_events referencing THIS USER's recommendations
  DELETE FROM public.credibility_events
    WHERE recommendation_id IN (
      SELECT id FROM public.recommendations
       WHERE from_user_id = v_uid OR to_user_id = v_uid
    );

  -- Step 2b: remaining credibility_events involving this user
  DELETE FROM public.credibility_events
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  -- Step 3: recommendations — CASCADE handles any remaining ae/ce references
  DELETE FROM public.recommendations
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  -- Step 4: reader_preferences
  DELETE FROM public.reader_preferences
    WHERE user_id = v_uid;

  -- Step 4.5 (NEW): import_rows owned by this user.
  -- MUST run before Step 5 (user_books). import_rows.user_book_id has no
  -- ON DELETE behaviour, so user_books deletion would otherwise fail with
  -- import_rows_user_book_id_fkey. import_batches is not deleted here —
  -- it cascades automatically when profiles is deleted at Step 7.
  DELETE FROM public.import_rows
    WHERE user_id = v_uid;

  -- Step 5: user_books (user_book_history cascades automatically)
  DELETE FROM public.user_books
    WHERE user_id = v_uid;

  -- Step 6: friendships
  DELETE FROM public.friendships
    WHERE requester_id = v_uid OR addressee_id = v_uid;

  -- Step 7: profiles (cascades reading_progress_events, import_batches, import_rows)
  DELETE FROM public.profiles
    WHERE id = v_uid;

  -- Step 8: auth.users — cascades rec_feedback, rec_entitlements, rec_cache,
  --                       rec_candidate_cache, scan_history
  DELETE FROM auth.users
    WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;

REVOKE ALL    ON FUNCTION public.delete_own_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;


-- ─── 2. admin_reset_account(text, text) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_reset_account(
  p_email  text,
  p_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected text;
  v_uid      uuid;
BEGIN
  v_expected := current_setting('app.admin_reset_secret', true);

  IF v_expected IS NULL OR trim(v_expected) = '' THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'admin_reset_not_configured',
      'hint',  'Run: ALTER DATABASE postgres SET app.admin_reset_secret = ''your-secret'';'
    );
  END IF;

  IF p_secret IS DISTINCT FROM v_expected THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  SELECT id INTO v_uid
    FROM auth.users
   WHERE lower(email) = lower(trim(p_email))
   LIMIT 1;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_not_found', 'email', p_email);
  END IF;

  -- Same corrected order as delete_own_account()
  DELETE FROM public.activity_events
    WHERE recommendation_id IN (
      SELECT id FROM public.recommendations
       WHERE from_user_id = v_uid OR to_user_id = v_uid
    );

  DELETE FROM public.activity_events
    WHERE actor_id = v_uid;

  DELETE FROM public.credibility_events
    WHERE recommendation_id IN (
      SELECT id FROM public.recommendations
       WHERE from_user_id = v_uid OR to_user_id = v_uid
    );

  DELETE FROM public.credibility_events
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  DELETE FROM public.recommendations
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  DELETE FROM public.reader_preferences
    WHERE user_id = v_uid;

  -- NEW: import_rows before user_books (see delete_own_account for rationale)
  DELETE FROM public.import_rows
    WHERE user_id = v_uid;

  DELETE FROM public.user_books
    WHERE user_id = v_uid;

  DELETE FROM public.friendships
    WHERE requester_id = v_uid OR addressee_id = v_uid;

  DELETE FROM public.profiles
    WHERE id = v_uid;

  DELETE FROM auth.users
    WHERE id = v_uid;

  RETURN jsonb_build_object(
    'ok',              true,
    'deleted_user_id', v_uid::text,
    'email',           p_email
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_reset_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reset_account(text, text) TO service_role;


-- ─── 3. reset_own_data_cold() ────────────────────────────────────────────────
-- This dev/test function deletes user_books to produce a cold account; it
-- has the same FK-violation hazard against import_rows as the account-
-- deletion functions. (reset_own_onboarding() does NOT touch user_books
-- and is unaffected — left as-is.)
CREATE OR REPLACE FUNCTION public.reset_own_data_cold()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  -- Onboarding + taste
  UPDATE public.profiles
     SET onboarding_completed = false
   WHERE id = v_uid;

  UPDATE public.reader_preferences
     SET favorite_genres   = '{}'::text[],
         avoid_genres      = '{}'::text[],
         reading_styles    = '{}'::text[],
         diagnosis_answers = '{}'::jsonb
   WHERE user_id = v_uid;

  -- Rec engine
  DELETE FROM public.rec_feedback        WHERE user_id = v_uid;
  DELETE FROM public.rec_cache           WHERE user_id = v_uid;
  DELETE FROM public.rec_candidate_cache WHERE user_id = v_uid;

  -- Activity events from this user (social graph activity)
  DELETE FROM public.activity_events
    WHERE recommendation_id IN (
      SELECT id FROM public.recommendations
       WHERE from_user_id = v_uid OR to_user_id = v_uid
    );
  DELETE FROM public.activity_events  WHERE actor_id = v_uid;

  -- Credibility events
  DELETE FROM public.credibility_events
    WHERE recommendation_id IN (
      SELECT id FROM public.recommendations
       WHERE from_user_id = v_uid OR to_user_id = v_uid
    );
  DELETE FROM public.credibility_events
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  -- Recommendations inbox/history (CASCADE cleans ae/ce refs)
  DELETE FROM public.recommendations
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  -- NEW: import_rows before user_books (see delete_own_account for rationale).
  -- Unlike delete_own_account this function does NOT delete the profile, so
  -- there is no profile-cascade safety net later — explicit delete is
  -- the only thing that prevents the FK violation.
  DELETE FROM public.import_rows WHERE user_id = v_uid;

  -- Library (user_book_history cascades automatically)
  DELETE FROM public.user_books WHERE user_id = v_uid;

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;

REVOKE ALL    ON FUNCTION public.reset_own_data_cold() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_own_data_cold() TO authenticated;
