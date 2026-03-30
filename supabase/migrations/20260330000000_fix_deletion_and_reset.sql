-- =============================================================================
-- Migration: Fix account deletion + add onboarding reset function
-- 20260330000000_fix_deletion_and_reset.sql
--
-- Problems fixed
-- ──────────────
-- 1. activity_events.recommendation_id FK had no ON DELETE CASCADE.
--    When user B sent a recommendation to user A (being deleted), the
--    resulting activity_event had actor_id = B. The old delete_own_account()
--    only deleted activity_events WHERE actor_id = uid (step 2), leaving B's
--    activity_event alive. Step 3 then tried to delete the recommendation —
--    FK violation: activity_events_recommendation_id_fkey.
--
-- 2. credibility_events.recommendation_id has the same structural gap.
--    ON DELETE CASCADE is the correct product behavior: a credibility event
--    or activity event about a deleted recommendation is meaningless.
--
-- 3. delete_own_account() and admin_reset_account() deletion order was
--    under-specified. Rewritten to be FK-safe with explicit pre-delete of
--    cross-user activity_events before deleting recommendations.
--
-- Changes
-- ───────
-- A. activity_events.recommendation_id → ON DELETE CASCADE
-- B. credibility_events.recommendation_id → ON DELETE CASCADE
-- C. Rewrite delete_own_account() — correct cross-user deletion order
-- D. Rewrite admin_reset_account() — same fix
-- E. New function: reset_own_onboarding() — for dev/test use
-- F. New function: reset_own_data_cold() — full cold-start (keeps auth row)
-- =============================================================================


-- ─── A. Fix FK: activity_events.recommendation_id ────────────────────────────
--
-- Old: no ON DELETE behaviour (defaults to RESTRICT)
-- New: ON DELETE CASCADE — deleting a recommendation auto-removes its events.

ALTER TABLE public.activity_events
  DROP CONSTRAINT IF EXISTS activity_events_recommendation_id_fkey;

ALTER TABLE public.activity_events
  ADD CONSTRAINT activity_events_recommendation_id_fkey
  FOREIGN KEY (recommendation_id)
  REFERENCES public.recommendations (id)
  ON DELETE CASCADE;


-- ─── B. Fix FK: credibility_events.recommendation_id ─────────────────────────
--
-- Old: no ON DELETE behaviour (RESTRICT)
-- New: ON DELETE CASCADE — deleting a recommendation auto-removes its events.

ALTER TABLE public.credibility_events
  DROP CONSTRAINT IF EXISTS credibility_events_recommendation_id_fkey;

ALTER TABLE public.credibility_events
  ADD CONSTRAINT credibility_events_recommendation_id_fkey
  FOREIGN KEY (recommendation_id)
  REFERENCES public.recommendations (id)
  ON DELETE CASCADE;


-- ─── C. Rewrite delete_own_account() ─────────────────────────────────────────
--
-- Correct deletion order (leaf → root, FK dependency chain):
--
--  1. activity_events WHERE recommendation_id IN (user's recs)
--     — catches cross-user events (actor_id ≠ uid) BEFORE recs are deleted.
--     (With the CASCADE fix above this is now redundant, but kept for safety
--      so the function works even if applied to an older DB without the FK fix.)
--
--  2. activity_events WHERE actor_id = uid
--     — catches non-recommendation activity events.
--
--  3. credibility_events WHERE from/to = uid OR rec IN (user's recs)
--     — same defensive double-delete.
--
--  4. recommendations WHERE from/to = uid
--     — CASCADE now auto-removes any remaining ae/ce rows referencing these.
--
--  5. reader_preferences, user_books, friendships, profiles, auth.users
--     (unchanged)

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


-- ─── D. Rewrite admin_reset_account() ────────────────────────────────────────

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


-- ─── E. reset_own_onboarding() ───────────────────────────────────────────────
--
-- Lightweight dev/test reset.  Keeps the auth account and library intact.
-- Clears only the state needed to re-experience the onboarding flow:
--
--   • profiles.onboarding_completed → false
--   • reader_preferences: clear genres, styles, taste answers
--   • rec_feedback: removed (dismissed/saved signals would colour new recs)
--   • rec_cache, rec_candidate_cache: removed (stale for new cold-start state)
--
-- Does NOT touch:
--   • user_books / library (the user's reading history stays)
--   • friendships, recommendations, activity_events (social graph stays)
--   • rec_entitlements (plan/access tier stays)
--   • auth.users (account stays)
--
-- AsyncStorage keys (readstack_guided_v1, readstack_rec_v1_*, etc.) must be
-- cleared client-side in the app — the server cannot reach them.

CREATE OR REPLACE FUNCTION public.reset_own_onboarding()
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

  -- 1. Mark onboarding as incomplete so the app routes to /onboarding
  UPDATE public.profiles
     SET onboarding_completed = false
   WHERE id = v_uid;

  -- 2. Clear taste intake (genres, styles, diagnosis answers)
  UPDATE public.reader_preferences
     SET favorite_genres   = '{}'::text[],
         avoid_genres      = '{}'::text[],
         reading_styles    = '{}'::text[],
         diagnosis_answers = '{}'::jsonb
   WHERE user_id = v_uid;

  -- 3. Clear rec engine state so the user gets a fresh cold-start pass
  DELETE FROM public.rec_feedback        WHERE user_id = v_uid;
  DELETE FROM public.rec_cache           WHERE user_id = v_uid;
  DELETE FROM public.rec_candidate_cache WHERE user_id = v_uid;

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;

REVOKE ALL    ON FUNCTION public.reset_own_onboarding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_own_onboarding() TO authenticated;


-- ─── F. reset_own_data_cold() ────────────────────────────────────────────────
--
-- Hard dev reset: everything reset_own_onboarding() does PLUS clears the
-- library (user_books) and recommendation inbox/history.
-- Use this when you need a truly cold account (zero reading history).
--
-- Does NOT touch friendships or auth.users.

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

  -- Library (user_book_history cascades automatically)
  DELETE FROM public.user_books WHERE user_id = v_uid;

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'detail', SQLSTATE);
END;
$$;

REVOKE ALL    ON FUNCTION public.reset_own_data_cold() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_own_data_cold() TO authenticated;
