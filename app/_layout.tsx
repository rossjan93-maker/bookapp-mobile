import { createContext, useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { clearAllTabCaches } from '../lib/tabCache';
import { readOnboardingStage } from '../lib/onboardingStage';

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
  if (!supabase) return true;
  const { data, error } = await supabase
    .from('profiles')
    .select('onboarding_completed')
    .eq('id', userId)
    .maybeSingle();
  if (error) return true;
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
      if (data.session) {
        const meta = data.session.user.user_metadata;
        await ensureProfile(
          data.session.user.id,
          data.session.user.email ?? '',
          meta?.first_name,
          meta?.last_name,
        );
        const completed = await checkOnboardingCompleted(data.session.user.id);
        if (completed) {
          setNeedsOnboarding(false);
        } else {
          // DB may not have been written yet (first-run race or network blip).
          // If local stage is non-null the user already passed the welcome screen —
          // trust local and skip it; tabs layout resumes from the local stage.
          const localStage = await readOnboardingStage();
          setNeedsOnboarding(localStage === null);
        }
      } else {
        setNeedsOnboarding(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      setSession(newSession);
      if (event === 'SIGNED_IN' && newSession) {
        const meta = newSession.user.user_metadata;
        await ensureProfile(
          newSession.user.id,
          newSession.user.email ?? '',
          meta?.first_name,
          meta?.last_name,
        );
        const completed = await checkOnboardingCompleted(newSession.user.id);
        if (completed) {
          setNeedsOnboarding(false);
        } else {
          const localStage = await readOnboardingStage();
          setNeedsOnboarding(localStage === null);
        }
      } else if (event === 'SIGNED_OUT') {
        setNeedsOnboarding(false);
        clearAllTabCaches();
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
      router.replace(needsOnboarding ? '/onboarding' : '/');
    } else if (session && needsOnboarding && !inAuth && !inOnboarding) {
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
