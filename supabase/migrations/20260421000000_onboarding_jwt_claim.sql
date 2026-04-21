-- =============================================================================
-- Migration: Mirror profiles.onboarding_completed into auth JWT app_metadata
-- Created:   2026-04-21
-- =============================================================================
-- Why:
--   The warm-boot path in app/_layout.tsx had to issue a SELECT on `profiles`
--   on every sign-in just to read a single boolean (onboarding_completed).
--   PostgREST cold starts and slow network hops occasionally pushed that query
--   past the 8-10s timeout fallback, leaving the user staring at the
--   "Signing you in…" screen.
--
--   By mirroring the flag into auth.users.raw_app_meta_data, the same value
--   is delivered as part of the JWT issued at sign-in (and refreshed
--   thereafter). The client can then read it directly from
--   session.user.app_metadata.onboarding_completed with zero DB round trip.
--
--   The trigger keeps the two sources in sync whenever the profiles row is
--   inserted or updated. Existing rows are backfilled below.
--
-- Notes:
--   - SECURITY DEFINER is required because authenticated users do not have
--     write access to the auth schema.
--   - The function is owned by the postgres role (set by Supabase migration
--     runner), which has the necessary privileges.
--   - We only touch the `onboarding_completed` key inside raw_app_meta_data
--     so any other claims set by Supabase or future hooks are preserved.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_onboarding_to_app_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- Skip when the value did not actually change (UPDATE only).
  IF TG_OP = 'UPDATE'
     AND NEW.onboarding_completed IS NOT DISTINCT FROM OLD.onboarding_completed
  THEN
    RETURN NEW;
  END IF;

  UPDATE auth.users
     SET raw_app_meta_data =
           COALESCE(raw_app_meta_data, '{}'::jsonb)
           || jsonb_build_object('onboarding_completed', NEW.onboarding_completed)
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_onboarding_to_app_metadata() FROM PUBLIC;

DROP TRIGGER IF EXISTS profiles_sync_onboarding_to_app_metadata ON public.profiles;

CREATE TRIGGER profiles_sync_onboarding_to_app_metadata
AFTER INSERT OR UPDATE OF onboarding_completed ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.sync_onboarding_to_app_metadata();

-- Backfill: copy current profiles.onboarding_completed into every matching
-- auth.users.raw_app_meta_data so existing users benefit on their next
-- token refresh / sign-in without waiting for an UPDATE on profiles.
--
-- We compare the existing claim defensively: extracting it as text and only
-- treating exact 'true'/'false' as known booleans. Any other value (NULL,
-- malformed string, number, etc.) is treated as "unknown" so we always
-- write the canonical value rather than aborting the migration on a cast
-- failure.
UPDATE auth.users u
   SET raw_app_meta_data =
         COALESCE(u.raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object('onboarding_completed', p.onboarding_completed)
  FROM public.profiles p
 WHERE p.id = u.id
   AND CASE u.raw_app_meta_data ->> 'onboarding_completed'
         WHEN 'true'  THEN true
         WHEN 'false' THEN false
         ELSE NULL
       END IS DISTINCT FROM p.onboarding_completed;
