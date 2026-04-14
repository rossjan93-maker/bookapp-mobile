/**
 * app/auth/callback.tsx
 *
 * Post-OAuth landing screen.
 *
 * Two parallel paths race to navigate:
 *  A) BootstrapContext (Phase C) — _layout.tsx resolves needsOnboarding and
 *     this screen navigates immediately. This is the fast path.
 *  B) runProbe — independent substep chain that navigates if Phase C hasn't
 *     fired yet. Runs minimal sequential queries, parallelised where possible.
 *
 * The diagnostic panel and debug buttons have been removed for production.
 */
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { BookStackLoader } from '../../components/BookStackLoader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { readOnboardingStage } from '../../lib/onboardingStage';
import { useBootstrap } from '../_layout';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

export default function AuthCallbackScreen() {
  const { code }    = useLocalSearchParams<{ code?: string }>();
  const router      = useRouter();
  const insets      = useSafeAreaInsets();
  const { session, needsOnboarding: ctxOnboarding, passwordRecovery } = useBootstrap();

  const navigatedRef  = useRef(false);
  const probeStarted  = useRef(false);

  // ── Phase A: code exchange (only when `code` param is present) ─────────────
  useEffect(() => {
    if (!supabase || !code) return;
    console.log('[CALLBACK] exchangeCodeForSession start');
    withTimeout(supabase.auth.exchangeCodeForSession(code), 10000, 'exchangeCodeForSession')
      .then(({ error }) => {
        if (error) console.warn('[CALLBACK] exchangeCodeForSession failed:', error.message);
        else       console.log('[CALLBACK] exchangeCodeForSession ok');
      })
      .catch((e: Error) => console.warn('[CALLBACK] exchangeCodeForSession threw:', e.message));
  }, [code]);

  // ── Phase B: session live → start probe as backup ──────────────────────────
  useEffect(() => {
    if (session === undefined || session === null) return;
    if (probeStarted.current) return;
    probeStarted.current = true;
    console.log('[CALLBACK] session live — starting probe backup');
    runProbe(session.user.id);
  }, [session]);

  // ── Phase C: BootstrapContext resolved — fast path ─────────────────────────
  useEffect(() => {
    if (ctxOnboarding === undefined) return;
    if (!session) return;
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    // PASSWORD_RECOVERY: always route to the set-new-password screen.
    if (passwordRecovery) {
      console.log('[CALLBACK] ctx fast path → /reset-password (PASSWORD_RECOVERY)');
      router.replace('/reset-password');
      return;
    }
    const route = ctxOnboarding ? '/onboarding' : '/';
    console.log('[CALLBACK] ctx fast path → ', route);
    router.replace(route as '/onboarding' | '/');
  }, [ctxOnboarding, session, passwordRecovery]);

  // ── Probe: minimal sequential fallback ─────────────────────────────────────
  async function runProbe(userId: string) {
    if (!supabase) return;
    try {
      // Parallel: fetch profile row + local stage simultaneously
      console.log('[CALLBACK] probe: parallel preProfile + localStage');
      const [profileRes, localStage] = await Promise.all([
        withTimeout(
          supabase.from('profiles').select('id, onboarding_completed').eq('id', userId).maybeSingle(),
          8000,
          'probe:preProfile',
        ),
        withTimeout(readOnboardingStage(), 3000, 'probe:localStage'),
      ]);

      const locallyDone = localStage === 'done';
      const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup';

      // Fast path: if local state is clear, route immediately and upsert in background
      if (locallyDone || midFlow) {
        console.log('[CALLBACK] probe: localStage fast path → /');
        navigate(false);
        // Profile upsert in background — non-blocking
        supabase.from('profiles').upsert(
          { id: userId },
          { onConflict: 'id', ignoreDuplicates: true },
        ).then(() => console.log('[CALLBACK] probe: background upsert done'));
        return;
      }

      // Upsert profile row (only blocks when local state is unknown)
      const { data: { session: s } } = await supabase.auth.getSession();
      const meta = s?.user?.user_metadata ?? {};
      const emailPrefix = (s?.user?.email ?? '').split('@')[0] || 'user';
      const idSuffix    = userId.replace(/-/g, '').slice(0, 6);
      await withTimeout(
        supabase.from('profiles').upsert(
          { id: userId, username: `${emailPrefix}_${idSuffix}`, ...meta.first_name ? { first_name: meta.first_name } : {}, ...meta.last_name ? { last_name: meta.last_name } : {} },
          { onConflict: 'id', ignoreDuplicates: true },
        ),
        8000,
        'probe:ensureProfile',
      );

      // Use the onboarding_completed from the pre-fetched row — no extra query
      const completed  = profileRes.data?.onboarding_completed === true;
      const needsOb    = !completed && !locallyDone && !midFlow;
      console.log('[CALLBACK] probe: onboarding_completed=', completed, 'needsOnboarding=', needsOb);
      navigate(needsOb);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[CALLBACK] probe threw — defaulting to onboarding:', msg);
      navigate(true);
    }
  }

  function navigate(needsOnboarding: boolean) {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    const route = needsOnboarding ? '/onboarding' : '/';
    console.log('[CALLBACK] probe routing to', route);
    router.replace(route as '/onboarding' | '/');
  }

  // ── Render: clean branded loading screen ───────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: '#f5f1ec', alignItems: 'center', justifyContent: 'center' }}>
      <BookStackLoader size="lg" />
      <Text style={{
        fontSize: 17, fontWeight: '700', color: '#231f1b',
        marginTop: 20, letterSpacing: -0.3,
      }}>
        Signing you in…
      </Text>
      <Text style={{
        fontSize: 13, color: '#9e958d', marginTop: 6,
      }}>
        Just a moment
      </Text>
    </View>
  );
}
