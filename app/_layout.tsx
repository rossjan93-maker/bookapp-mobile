import { createContext, useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
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

  useEffect(() => {
    if (session === undefined || needsOnboarding === undefined) return;
    const inAuth        = segments[0] === '(auth)';
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
      </View>
    </OnboardingBridgeContext.Provider>
  );
}
