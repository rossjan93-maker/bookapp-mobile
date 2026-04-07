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
          // onboarding_completed=false means the user has not finished onboarding.
          // Trust the local stage for:
          //   - mid-flow stages (walkthrough/final_setup): DB write may have raced
          //   - 'done': user just completed a dismissal action; the DB write is in
          //     flight or the auth event fired before it committed. Never redirect
          //     a user whose local stage already says they are done.
          // A null local stage while DB says false = fresh user → needs welcome.
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      setSession(newSession);
      // Handle both SIGNED_IN and USER_UPDATED (email confirmation can fire either
      // depending on Supabase version / PKCE configuration).
      if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && newSession) {
        console.log('[DELETE_TRACE]', event, 'userId=', newSession.user.id.slice(0, 8));
        // Check if a profile row already exists BEFORE ensureProfile runs.
        // Detects UUID recycling: if pre-exists=true with onboarding_completed=true,
        // the old profile survived account deletion and is poisoning the new account.
        const { data: preProfile } = await supabase
          .from('profiles')
          .select('id, onboarding_completed')
          .eq('id', newSession.user.id)
          .maybeSingle();
        console.log('[DELETE_TRACE] profile pre-exists=', !!preProfile, 'existing onboarding_completed=', preProfile?.onboarding_completed ?? null);
        const meta = newSession.user.user_metadata;
        await ensureProfile(
          newSession.user.id,
          newSession.user.email ?? '',
          meta?.first_name,
          meta?.last_name,
        );
        const completed = await checkOnboardingCompleted(newSession.user.id);
        console.log('[DELETE_TRACE] DB onboarding_completed=', completed);
        if (completed) {
          console.log('[DELETE_TRACE] → needsOnboarding=false (DB says done)');
          setNeedsOnboarding(false);
        } else {
          const localStage  = await readOnboardingStage();
          const locallyDone = localStage === 'done';
          const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup';
          console.log('[DELETE_TRACE] localStage=', localStage, 'locallyDone=', locallyDone, 'midFlow=', midFlow);
          console.log('[DELETE_TRACE] → needsOnboarding=', !midFlow && !locallyDone);
          setNeedsOnboarding(!midFlow && !locallyDone);
        }
      } else if (event === 'SIGNED_OUT') {
        console.log('[DELETE_TRACE] SIGNED_OUT — awaiting full local state clear');
        setNeedsOnboarding(false);
        clearAllTabCaches();
        await clearLocalOnboardingState();
        const stageAfter = await readOnboardingStage();
        console.log('[DELETE_TRACE] post-SIGNED_OUT stage=', stageAfter, '(expect null)');
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

  useEffect(() => {
    if (session === undefined || needsOnboarding === undefined) return;
    // '(auth)' = login/signup screens; 'auth' = the auth/callback route group.
    // Both must be treated as "in auth" so the session guard does not redirect
    // while the callback screen is exchanging a PKCE code (no session yet).
    // Cast to string: Expo Router's generated segment union won't include 'auth'
    // until after the first build that picks up app/auth/callback.tsx.
    const seg0          = segments[0] as string;
    const inAuth        = seg0 === '(auth)' || seg0 === 'auth';
    // Treat /onboarding-import as part of the onboarding flow so the guard
    // never evicts the user mid-step (e.g. on token refresh or if the DB
    // check returns false again after completeOnboarding() was called).
    const inOnboarding  = segments[0] === 'onboarding' || segments[0] === 'onboarding-import' || segments[0] === 'onboarding-questions';

    console.log('[ROOT_GUARD] check', {
      segments: segments[0],
      session:        !!session,
      needsOnboarding,
      inAuth,
      inOnboarding,
    });

    if (session && inAuth) {
      const route = needsOnboarding ? '/onboarding' : '/';
      console.log('[ROOT_GUARD] → route=', route, '(session+inAuth)');
      router.replace(route);
    } else if (session && needsOnboarding && !inAuth && !inOnboarding) {
      console.log('[ROOT_GUARD] → route=/onboarding (guard redirect)');
      router.replace('/onboarding');
    } else if (!session && !inAuth) {
      console.log('[ROOT_GUARD] no session — redirecting to /login (segments:', segments[0], ')');
      router.replace('/login');
    }
  }, [session, segments, needsOnboarding]);

  return (
    <OnboardingBridgeContext.Provider value={{ completeOnboarding: () => setNeedsOnboarding(false) }}>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }} />
        <ToastContainer />
      </View>
    </OnboardingBridgeContext.Provider>
  );
}
