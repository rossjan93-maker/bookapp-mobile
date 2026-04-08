import { createContext, useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { ToastContainer } from '../components/Toast';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { clearAllTabCaches } from '../lib/tabCache';
import { readOnboardingStage } from '../lib/onboardingStage';
import { clearLocalOnboardingState } from '../lib/localStateClear';

// ─── Bootstrap context ─────────────────────────────────────────────────────────
// Exposes live session + needsOnboarding so child routes (especially
// app/auth/callback.tsx) can actively wait for bootstrap to resolve
// rather than relying solely on the routing guard.

type BootstrapCtx = {
  session:         Session | null | undefined;
  needsOnboarding: boolean | undefined;
};

export const BootstrapContext = createContext<BootstrapCtx>({
  session:         undefined,
  needsOnboarding: undefined,
});
export const useBootstrap = () => useContext(BootstrapContext);

// ─── Onboarding bridge ────────────────────────────────────────────────────────
// Lets onboarding.tsx call completeOnboarding() to update needsOnboarding in
// the root layout BEFORE navigating away. Without this the routing guard sees
// needsOnboarding=true when segments changes and redirects back to /onboarding.

type OnboardingBridgeCtx = { completeOnboarding: () => void };
export const OnboardingBridgeContext = createContext<OnboardingBridgeCtx>({
  completeOnboarding: () => {},
});
export const useOnboardingBridge = () => useContext(OnboardingBridgeContext);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureProfile(
  userId: string,
  email: string,
  firstName?: string | null,
  lastName?: string | null,
) {
  if (!supabase) return;
  const emailPrefix      = email.split('@')[0] || 'user';
  const idSuffix         = userId.replace(/-/g, '').slice(0, 6);
  const fallbackUsername = `${emailPrefix}_${idSuffix}`;

  const upsertData: Record<string, unknown> = { id: userId, username: fallbackUsername };
  if (firstName) upsertData.first_name = firstName;
  if (lastName)  upsertData.last_name  = lastName;

  await supabase
    .from('profiles')
    .upsert(upsertData, { onConflict: 'id', ignoreDuplicates: true });
}

async function checkOnboardingCompleted(userId: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from('profiles')
    .select('onboarding_completed')
    .eq('id', userId)
    .maybeSingle();
  // On any DB error, assume not completed — never skip onboarding on a failure.
  if (error) return false;
  // maybeSingle returns data=null when no row exists (new user).
  // null?.onboarding_completed === true → false → correctly sends to onboarding.
  return data?.onboarding_completed === true;
}

// ─── Root layout ──────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [session,         setSession]         = useState<Session | null | undefined>(undefined);
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | undefined>(undefined);
  const router   = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (!supabase) {
      setSession(null);
      setNeedsOnboarding(false);
      return;
    }

    // ── Cold-start: hydrate session from persisted storage ─────────────────
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      console.log('[DELETE_TRACE] cold-start userId=', data.session?.user?.id?.slice(0, 8) ?? null);
      if (data.session) {
        const meta = data.session.user.user_metadata;
        await ensureProfile(
          data.session.user.id,
          data.session.user.email ?? '',
          meta?.first_name,
          meta?.last_name,
        );
        const completed = await checkOnboardingCompleted(data.session.user.id);
        console.log('[DELETE_TRACE] cold-start DB onboarding_completed=', completed);
        if (completed) {
          console.log('[DELETE_TRACE] cold-start → needsOnboarding=false (DB says done)');
          setNeedsOnboarding(false);
        } else {
          const localStage = await readOnboardingStage();
          const locallyDone = localStage === 'done';
          const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup';
          console.log('[DELETE_TRACE] cold-start localStage=', localStage, '→ needsOnboarding=', !midFlow && !locallyDone);
          setNeedsOnboarding(!midFlow && !locallyDone);
        }
      } else {
        setNeedsOnboarding(false);
      }
    });

    // ── Auth state listener ────────────────────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      // Handle both SIGNED_IN and USER_UPDATED (email confirmation can fire either
      // depending on Supabase version / PKCE configuration).
      if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && newSession) {
        console.log('[WARM_BOOT] onAuthStateChange SIGNED_IN — userId=', newSession.user.id.slice(0, 8));

        // ── CRITICAL: reset needsOnboarding to undefined BEFORE setSession ─
        // The routing guard bails when needsOnboarding===undefined, keeping the
        // user on the callback loading screen until bootstrap fully resolves.
        // Without this, the guard fires the moment setSession runs and races
        // against the DB calls with a potentially stale needsOnboarding value.
        setNeedsOnboarding(undefined);
        setSession(newSession);

        console.log('[WARM_BOOT] session state updated — bootstrap starting');

        // ── Wrap ALL async bootstrap work in try/catch ─────────────────────
        // If any DB call throws (RLS, network, trigger conflict from a freshly-
        // deleted row, etc.) the handler must NOT leave needsOnboarding===undefined
        // forever — that is the exact deadlock that hangs the callback screen.
        // Fallback: needsOnboarding=true sends the user to onboarding, which is
        // the correct safe default for any recreated or genuinely new account.
        try {
          // Check if a profile row already exists BEFORE ensureProfile runs.
          // In the delete→recreate path the new UUID will have no profile yet.
          const { data: preProfile } = await supabase
            .from('profiles')
            .select('id, onboarding_completed')
            .eq('id', newSession.user.id)
            .maybeSingle();
          console.log('[WARM_BOOT] profile pre-exists=', !!preProfile, 'existing onboarding_completed=', preProfile?.onboarding_completed ?? null);

          if (!preProfile) {
            // No pre-existing row → brand-new or recreated account on this device.
            console.log('[DELETE_TRACE] recreated account signup start — no existing profile for userId=', newSession.user.id.slice(0, 8));
          }

          console.log('[WARM_BOOT] profile fetch start');
          const meta = newSession.user.user_metadata;
          await ensureProfile(
            newSession.user.id,
            newSession.user.email ?? '',
            meta?.first_name,
            meta?.last_name,
          );

          // Re-fetch the row to confirm upsert landed and log the result.
          const { data: postProfile } = await supabase
            .from('profiles')
            .select('id, onboarding_completed')
            .eq('id', newSession.user.id)
            .maybeSingle();
          console.log('[WARM_BOOT] profile fetch result — exists=', !!postProfile, 'onboarding_completed=', postProfile?.onboarding_completed ?? null);

          const completed = await checkOnboardingCompleted(newSession.user.id);
          console.log('[WARM_BOOT] onboarding_completed=', completed);

          if (completed) {
            console.log('[WARM_BOOT] needsOnboarding=', false);
            setNeedsOnboarding(false);
          } else {
            const localStage  = await readOnboardingStage();
            const locallyDone = localStage === 'done';
            const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup';
            const result      = !midFlow && !locallyDone;
            console.log('[WARM_BOOT] localStage=', localStage, 'locallyDone=', locallyDone, 'midFlow=', midFlow);
            console.log('[WARM_BOOT] needsOnboarding=', result);
            setNeedsOnboarding(result);
          }

          console.log('[WARM_BOOT] app shell ready — routing guard will now fire');

        } catch (err) {
          // Any throw here previously left needsOnboarding===undefined forever,
          // hanging the callback screen indefinitely. Now we always resolve.
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[WARM_BOOT] bootstrap threw — needsOnboarding fallback=true:', msg);
          setNeedsOnboarding(true);
        }

      } else if (event === 'SIGNED_OUT') {
        setSession(newSession);
        console.log('[DELETE_TRACE] SIGNED_OUT — clearing local state');
        setNeedsOnboarding(false);
        clearAllTabCaches();
        await clearLocalOnboardingState();
        const stageAfter = await readOnboardingStage();
        console.log('[DELETE_TRACE] cleared keys complete — stage=', stageAfter, '(expect null)');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Deep link handler — processes readstack://auth/callback URLs ────────────
  // Handles two scenarios:
  //   1. Cold start: app was closed when the user tapped a link in email
  //   2. Foreground: app was open when the link was tapped
  // Both email confirmation and password reset redirect here.
  // PKCE flow delivers a `code`; implicit fallback delivers access/refresh tokens.

  useEffect(() => {
    if (!supabase) return;

    async function handleAuthUrl(url: string) {
      if (!supabase || !url) return;

      // auth/callback URLs are handled by the dedicated route at
      // app/auth/callback.tsx — skip here to avoid double-processing
      // the one-time-use PKCE code.
      if (url.includes('auth/callback')) return;

      // Only process other auth deep links below (currently unused, but
      // kept as the canonical place for future deep link types).
      if (!url.includes('auth/')) return;

      console.log('[DeepLink] auth URL received:', url);

      try {
        const parsed = Linking.parse(url);
        const params = parsed.queryParams ?? {};

        // Surface any provider error before attempting token exchange
        const errorParam = params['error'] ?? params['error_description'];
        if (errorParam) {
          console.warn('[DeepLink] auth error in URL:', errorParam);
          return;
        }

        // Implicit flow fallback: tokens delivered directly in query params
        // (PKCE codes are handled inside app/auth/callback.tsx, not here)
        const access_token  = params['access_token']  as string | undefined;
        const refresh_token = params['refresh_token'] as string | undefined;
        if (access_token && refresh_token) {
          console.log('[DeepLink] implicit tokens found — setting session');
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          if (error) console.warn('[DeepLink] setSession error:', error.message);
          return;
        }

        console.warn('[DeepLink] auth URL had no usable params:', url);
      } catch (err) {
        console.warn('[DeepLink] error processing URL:', err);
      }
    }

    // Cold-start: handle the URL that launched the app (if any)
    Linking.getInitialURL().then(url => {
      if (url) handleAuthUrl(url);
    });

    // Foreground: handle URLs received while the app is running
    const sub = Linking.addEventListener('url', ({ url }) => handleAuthUrl(url));

    return () => sub.remove();
  }, []);

  // ── Routing guard ──────────────────────────────────────────────────────────
  // Fires whenever session, segments, or needsOnboarding changes.
  // Bails when either is undefined (still bootstrapping).
  // Note: the callback route handles its own navigation via BootstrapContext;
  // this guard acts as a safety net for other routes.

  useEffect(() => {
    if (session === undefined || needsOnboarding === undefined) return;

    // '(auth)' = login/signup screens; 'auth' = the auth/callback route group.
    // Both must be treated as "in auth" so the session guard does not redirect
    // while the callback screen is exchanging a PKCE code (no session yet).
    const seg0          = segments[0] as string;
    const inAuth        = seg0 === '(auth)' || seg0 === 'auth';
    // Treat /onboarding-import as part of the onboarding flow so the guard
    // never evicts the user mid-step.
    const inOnboarding  = segments[0] === 'onboarding' || segments[0] === 'onboarding-import' || segments[0] === 'onboarding-questions';

    console.log('[ROOT_GUARD] check', {
      segments: segments[0],
      session:        !!session,
      needsOnboarding,
      inAuth,
      inOnboarding,
    });

    if (session && inAuth) {
      // callback.tsx drives its own navigation via BootstrapContext;
      // the guard mirrors the same decision here as a safety net.
      if (needsOnboarding) {
        console.log('[ROOT_GUARD] session+inAuth → /onboarding');
        router.replace('/onboarding');
      } else {
        console.log('[ROOT_GUARD] session+inAuth → /');
        router.replace('/');
      }
    } else if (session && needsOnboarding && !inAuth && !inOnboarding) {
      console.log('[ROOT_GUARD] → route=/onboarding (guard redirect)');
      router.replace('/onboarding');
    } else if (!session && !inAuth) {
      console.log('[ROOT_GUARD] no session — redirecting to /login (segments:', segments[0], ')');
      router.replace('/login');
    }
  }, [session, segments, needsOnboarding]);

  return (
    <BootstrapContext.Provider value={{ session, needsOnboarding }}>
      <OnboardingBridgeContext.Provider value={{ completeOnboarding: () => setNeedsOnboarding(false) }}>
        <View style={{ flex: 1 }}>
          <Stack screenOptions={{ headerShown: false }} />
          <ToastContainer />
        </View>
      </OnboardingBridgeContext.Provider>
    </BootstrapContext.Provider>
  );
}
