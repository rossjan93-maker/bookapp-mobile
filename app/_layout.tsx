import { createContext, useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { ToastContainer } from '../components/Toast';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { clearAllTabCaches } from '../lib/tabCache';
import { readOnboardingStage, writeOnboardingStage } from '../lib/onboardingStage';
import { clearLocalOnboardingState } from '../lib/localStateClear';

// ─── Bootstrap context ─────────────────────────────────────────────────────────
// Exposes live session + needsOnboarding so child routes (especially
// app/auth/callback.tsx) can actively wait for bootstrap to resolve
// rather than relying solely on the routing guard.
// Also exposes passwordRecovery so the reset-password screen knows why
// the user is here and callback.tsx can route correctly after a reset link.

type BootstrapCtx = {
  session:              Session | null | undefined;
  needsOnboarding:      boolean | undefined;
  passwordRecovery:     boolean;
  clearPasswordRecovery: () => void;
};

export const BootstrapContext = createContext<BootstrapCtx>({
  session:              undefined,
  needsOnboarding:      undefined,
  passwordRecovery:     false,
  clearPasswordRecovery: () => {},
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

// Reject after `ms` milliseconds so a hanging Supabase promise always
// surfaces in the try/catch rather than waiting forever.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[WARM_BOOT] ${label} timed out after ${ms / 1000}s`)),
        ms,
      ),
    ),
  ]);
}

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

  await withTimeout(
    supabase.from('profiles').upsert(upsertData, { onConflict: 'id', ignoreDuplicates: true }),
    8000,
    'ensureProfile upsert',
  );
}

async function checkOnboardingCompleted(userId: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await withTimeout(
    supabase.from('profiles').select('onboarding_completed').eq('id', userId).maybeSingle(),
    8000,
    'checkOnboardingCompleted',
  );
  // On any DB error, assume not completed — never skip onboarding on a failure.
  if (error) return false;
  // maybeSingle returns data=null when no row exists (new user).
  // null?.onboarding_completed === true → false → correctly sends to onboarding.
  return data?.onboarding_completed === true;
}

// ─── Root layout ──────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [session,          setSession]          = useState<Session | null | undefined>(undefined);
  const [needsOnboarding,  setNeedsOnboarding]  = useState<boolean | undefined>(undefined);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
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
          // 'intake_active' is mid-flow: the user started the genres intake but
          // didn't finish. Tabs layout (and the routing guard below) redirects
          // them back to /onboarding-questions to resume.
          const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup' || localStage === 'intake_active';
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
          // ── Critical path: route as soon as possible ──────────────────────
          //
          // Only AsyncStorage (≈10ms) is on the routing critical path.
          // Every DB operation has been moved off it:
          //
          //   localStage='done'        → returning user     → needsOnboarding=false (fast, no DB call)
          //   localStage='walkthrough' → mid-tour           → needsOnboarding=false (fast, no DB call)
          //   localStage='final_setup' → mid-import step    → needsOnboarding=false (fast, no DB call)
          //   localStage=null          → new OR signed-out  → check DB to distinguish
          //
          // After routing, ensureProfile runs in the background so the profile
          // row exists for subsequent app operations — it does not affect where
          // the user lands.
          //
          const t0          = Date.now();
          const localStage  = await withTimeout(readOnboardingStage(), 3000, 'readOnboardingStage');
          const locallyDone = localStage === 'done';
          // 'intake_active' is mid-flow (the user is partway through the genres
          // intake). Tabs layout's mount-stage switch routes them back to
          // /onboarding-questions on the next render.
          const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup' || localStage === 'intake_active';

          if (locallyDone || midFlow) {
            // Fast path: local state is conclusive. No DB call needed.
            //   'done'         → returning user, normal app
            //   'walkthrough'  → mid-tour, tabs layout handles it
            //   'final_setup'  → mid-import step, tabs layout redirects
            console.log('[WARM_BOOT] localStage=', localStage, '→ needsOnboarding=false (fast path) in', Date.now() - t0, 'ms');
            setNeedsOnboarding(false);
          } else {
            // localStage === null.
            //
            // Two cases that look identical locally:
            //   A) Genuinely new user (first sign-in on any device)
            //   B) Returning user who signed out — clearLocalOnboardingState()
            //      wiped readstack_onboarding_stage_v1 on sign-out.
            //
            // Without a DB check, case B always re-triggers onboarding.
            // The fast path was an intentional optimisation that accepted this
            // tradeoff; it breaks correctness for every sign-out+sign-back-in
            // cycle. We always check DB when local state is absent.
            console.log('[WARM_BOOT] localStage=null — checking DB to distinguish new vs returning user');
            const completed = await checkOnboardingCompleted(newSession.user.id);
            if (completed) {
              // Returning user: repair local stage so future sign-ins stay on
              // the fast path and skip this DB call.
              writeOnboardingStage('done').catch(() => {});
              console.log('[WARM_BOOT] DB confirmed complete — needsOnboarding=false, local stage repaired in', Date.now() - t0, 'ms');
              setNeedsOnboarding(false);
            } else {
              console.log('[WARM_BOOT] DB: onboarding not complete — needsOnboarding=true (new user) in', Date.now() - t0, 'ms');
              setNeedsOnboarding(true);
            }
          }

          // ── Background: upsert profile row (non-blocking) ─────────────────
          const meta = newSession.user.user_metadata;
          ensureProfile(
            newSession.user.id,
            newSession.user.email ?? '',
            meta?.first_name,
            meta?.last_name,
          ).catch(e => console.warn('[WARM_BOOT] background ensureProfile error:', e));

          console.log('[WARM_BOOT] routing guard fired — profile upsert running in background');

        } catch (err) {
          // Any throw here previously left needsOnboarding===undefined forever,
          // hanging the callback screen indefinitely. Now we always resolve.
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[WARM_BOOT] bootstrap threw — needsOnboarding fallback=true:', msg);
          setNeedsOnboarding(true);
        }

      } else if (event === 'PASSWORD_RECOVERY' && newSession) {
        // User arrived via a password-reset email link.
        // Set session so they're authenticated, mark passwordRecovery=true so the
        // routing guard routes them to /reset-password instead of the main app,
        // and set needsOnboarding=false (they're an existing user).
        console.log('[WARM_BOOT] PASSWORD_RECOVERY — routing to /reset-password');
        setPasswordRecovery(true);
        setSession(newSession);
        setNeedsOnboarding(false);

      } else if (event === 'SIGNED_OUT') {
        setSession(newSession);
        console.log('[DELETE_TRACE] SIGNED_OUT — clearing local state');
        setNeedsOnboarding(false);
        setPasswordRecovery(false);
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
  // Fires whenever session, segments, needsOnboarding, or passwordRecovery changes.
  // Bails when session/needsOnboarding are undefined (still bootstrapping).
  // Note: the callback route handles its own navigation via BootstrapContext;
  // this guard acts as a safety net for other routes.

  useEffect(() => {
    if (session === undefined || needsOnboarding === undefined) return;

    // '(auth)' = login/signup screens; 'auth' = the auth/callback route group.
    // Both must be treated as "in auth" so the session guard does not redirect
    // while the callback screen is exchanging a PKCE code (no session yet).
    const seg0         = segments[0] as string;
    const inAuth       = seg0 === '(auth)' || seg0 === 'auth';
    // Treat /onboarding-* as part of the onboarding flow so the guard
    // never evicts the user mid-step.
    const inOnboarding = seg0 === 'onboarding' || seg0 === 'onboarding-import' || seg0 === 'onboarding-questions';
    // /reset-password is a protected route only reachable after a PASSWORD_RECOVERY event.
    const inResetPw    = seg0 === 'reset-password';

    console.log('[ROOT_GUARD] check', {
      segments: seg0,
      session:         !!session,
      needsOnboarding,
      passwordRecovery,
      inAuth,
      inOnboarding,
      inResetPw,
    });

    // ── Password recovery: highest-priority routing ─────────────────────────
    // When in PASSWORD_RECOVERY state, always route to /reset-password
    // regardless of which screen the user is currently on.
    if (passwordRecovery) {
      if (!inResetPw) {
        console.log('[ROOT_GUARD] passwordRecovery=true → /reset-password');
        router.replace('/reset-password');
      }
      return;
    }

    // ── Normal flows ────────────────────────────────────────────────────────
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
    } else if (!session && !inAuth && !inResetPw) {
      console.log('[ROOT_GUARD] no session — redirecting to /login (segments:', seg0, ')');
      router.replace('/login');
    }
  }, [session, segments, needsOnboarding, passwordRecovery]);

  return (
    <BootstrapContext.Provider value={{
      session,
      needsOnboarding,
      passwordRecovery,
      clearPasswordRecovery: () => setPasswordRecovery(false),
    }}>
      <OnboardingBridgeContext.Provider value={{ completeOnboarding: () => setNeedsOnboarding(false) }}>
        <View style={{ flex: 1 }}>
          <Stack screenOptions={{ headerShown: false }} />
          <ToastContainer />
        </View>
      </OnboardingBridgeContext.Provider>
    </BootstrapContext.Provider>
  );
}
