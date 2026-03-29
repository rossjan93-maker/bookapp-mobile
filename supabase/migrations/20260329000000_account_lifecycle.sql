-- =============================================================================
-- Migration: Account lifecycle functions
-- 20260329000000_account_lifecycle.sql
--
-- Provides two server-side functions:
--
--   1. public.delete_own_account()
--      Called from the mobile client via supabase.rpc('delete_own_account').
--      Verifies auth.uid(), cascades all user data deletion, removes auth.users row.
--
--   2. public.admin_reset_account(p_email, p_secret)
--      Dev / admin only. Called from Supabase dashboard SQL Editor.
--      Not callable from the anon/authenticated client roles.
--
-- Deployment:
--   Apply via: Supabase dashboard > SQL Editor > run this file.
--   Or when Supabase CLI is available: supabase db push
--
-- One-time admin secret setup (run once in SQL Editor as a superuser):
--   ALTER DATABASE postgres SET app.admin_reset_secret = 'your-dev-secret-here';
-- =============================================================================


-- ─── 1. delete_own_account ───────────────────────────────────────────────────
--
-- Security model:
--   SECURITY DEFINER means the function runs with the privileges of its owner
--   (the postgres/superuser role), which can DELETE from auth.users.
--   auth.uid() is evaluated from the caller's JWT — the user can only ever
--   delete their own row.
--
-- Deletion order (FK dependency chain, leaf tables first):
--   credibility_events → activity_events → recommendations
--   → reader_preferences → user_books (cascades user_book_history)
--   → friendships → profiles (cascades reading_progress_events,
--     import_batches, import_rows) → auth.users (cascades rec_feedback,
--     rec_entitlements, rec_cache, rec_candidate_cache, scan_history)
--
-- Tables NOT deleted (shared catalog):
--   books, book_enrichment_cache, book_source_links
--
-- Returns: jsonb { ok: boolean, error?: string }

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

  -- credibility_events: FK to profiles(from_user_id, to_user_id), no cascade
  DELETE FROM public.credibility_events
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  -- activity_events: FK to profiles(actor_id), no cascade
  DELETE FROM public.activity_events
    WHERE actor_id = v_uid;

  -- recommendations: FK to profiles(from_user_id, to_user_id), no cascade
  DELETE FROM public.recommendations
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  -- reader_preferences: FK to profiles(user_id), no cascade
  DELETE FROM public.reader_preferences
    WHERE user_id = v_uid;

  -- user_books: FK to profiles(user_id), no cascade
  -- user_book_history cascades automatically via user_books(id) ON DELETE CASCADE
  DELETE FROM public.user_books
    WHERE user_id = v_uid;

  -- friendships: FK to profiles(requester_id, addressee_id), no cascade
  DELETE FROM public.friendships
    WHERE requester_id = v_uid OR addressee_id = v_uid;

  -- profiles: FK to auth.users(id), no cascade
  -- Cascades automatically: reading_progress_events, import_batches, import_rows
  DELETE FROM public.profiles
    WHERE id = v_uid;

  -- auth.users: deleting this row cascades automatically:
  --   rec_feedback, rec_entitlements, rec_cache, rec_candidate_cache, scan_history
  DELETE FROM auth.users
    WHERE id = v_uid;

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Only authenticated users may call this function.
-- The function itself verifies the caller can only delete their own account.
REVOKE ALL  ON FUNCTION public.delete_own_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;


-- ─── 2. admin_reset_account ──────────────────────────────────────────────────
--
-- FOR DEV / ADMIN USE ONLY.
-- NOT callable from the anon or authenticated client roles.
-- Primary usage surface: Supabase dashboard SQL Editor.
--
-- Example (run in SQL Editor):
--   SELECT public.admin_reset_account('test@example.com', 'your-dev-secret');
--
-- Secret setup (run once as superuser in SQL Editor):
--   ALTER DATABASE postgres SET app.admin_reset_secret = 'your-dev-secret-here';
--
-- Security model:
--   Secret is stored as a database-level configuration parameter — not in
--   the schema, not readable via the public API or client SDKs.
--   GRANT is restricted to service_role only, so anon/authenticated callers
--   cannot reach this function via the Supabase REST or RPC API.
--
-- Returns: jsonb { ok: boolean, deleted_user_id?: text, error?: string }

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
  -- Read the secret from database-level configuration
  v_expected := current_setting('app.admin_reset_secret', true);

  IF v_expected IS NULL OR trim(v_expected) = '' THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'admin_reset_not_configured',
      'hint',  'Run: ALTER DATABASE postgres SET app.admin_reset_secret = ''your-secret'';'
    );
  END IF;

  -- Reject mismatched secret
  IF p_secret IS DISTINCT FROM v_expected THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  -- Find user by email (case-insensitive)
  SELECT id INTO v_uid
    FROM auth.users
   WHERE lower(email) = lower(trim(p_email))
   LIMIT 1;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_not_found', 'email', p_email);
  END IF;

  -- Full cascade delete (same order as delete_own_account)
  DELETE FROM public.credibility_events
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  DELETE FROM public.activity_events
    WHERE actor_id = v_uid;

  DELETE FROM public.recommendations
    WHERE from_user_id = v_uid OR to_user_id = v_uid;

  DELETE FROM public.reader_preferences
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
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- Restricted to service_role only — NOT reachable via the anon/authenticated
-- Supabase REST/RPC API from the mobile client.
REVOKE ALL  ON FUNCTION public.admin_reset_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reset_account(text, text) TO service_role;
