import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useBootstrap } from '../_layout';

/**
 * AuthCallbackScreen
 *
 * Matches the deep link path:  readstack://auth/callback
 *
 * Responsibilities:
 *   1. Show a loading state so the user sees intentional UI, not a flash.
 *   2. Exchange the PKCE code for a Supabase session.
 *   3. ACTIVELY wait for the root layout's bootstrap to fully resolve
 *      (session + needsOnboarding both defined) via BootstrapContext.
 *   4. Navigate explicitly once the app is ready — does not rely solely
 *      on the routing guard to eventually notice the state change.
 *   5. Show an error state with a back-to-sign-in button on failure.
 *   6. Time out after 15 s if bootstrap never resolves — never hang forever.
 *
 * This two-phase approach (exchange → wait for context → navigate) is
 * what closes the warm-start hydration gap: the app is only navigated
 * away from this screen once it is provably ready.
 */
export default function AuthCallbackScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router   = useRouter();

  const [error,     setError]    = useState<string | null>(null);
  const [exchanged, setExchanged] = useState(false);

  // Track whether we've already navigated away to prevent double-navigation.
  const navigatedRef = useRef(false);

  // BootstrapContext: live session + needsOnboarding from root layout.
  // These transition: undefined → undefined → resolved value, signalling
  // that the root layout has finished its profile/onboarding DB queries.
  const { session, needsOnboarding } = useBootstrap();

  // Refs that mirror the latest bootstrap state so the timeout callback
  // always reads current values without being in its dependency array.
  const sessionRef     = useRef(session);
  const onboardingRef  = useRef(needsOnboarding);
  useEffect(() => { sessionRef.current    = session;         }, [session]);
  useEffect(() => { onboardingRef.current = needsOnboarding; }, [needsOnboarding]);

  // ── Phase 1: Exchange PKCE code ────────────────────────────────────────────
  useEffect(() => {
    console.log('[WARM_BOOT] callback route mounted');

    if (!supabase) {
      setError('Client not configured.');
      return;
    }

    if (!code) {
      console.warn('[WARM_BOOT] no code param in URL — link may be malformed or already used');
      setError('This link has already been used or is invalid.');
      return;
    }

    console.log('[WARM_BOOT] exchangeCodeForSession start — code=', code.slice(0, 8) + '…');
    supabase.auth.exchangeCodeForSession(code).then(({ data, error: err }) => {
      if (err) {
        console.warn('[WARM_BOOT] exchangeCodeForSession failed:', err.message);
        setError('The link may have expired. Please try signing in again.');
        return;
      }
      console.log('[WARM_BOOT] exchangeCodeForSession success — userId=', data.session?.user.id.slice(0, 8) ?? 'none');
      // Marks Phase 2 to begin: watch BootstrapContext until app is ready.
      setExchanged(true);
    });
  }, [code]);

  // ── Phase 2a: 15-second escape hatch ──────────────────────────────────────
  // If bootstrap never resolves (e.g. DB call threw, SIGNED_IN never fired,
  // or session exchange succeeded but the auth listener silently failed),
  // the callback screen must NOT hang forever. After 15 s we show an
  // actionable error and log exactly what state was blocking progress.
  useEffect(() => {
    if (!exchanged) return;

    const timer = setTimeout(() => {
      if (navigatedRef.current) return;

      const s = sessionRef.current;
      const o = onboardingRef.current;
      const sessionStatus    = s === undefined ? 'pending' : s ? 'active' : 'null';
      const onboardingStatus = o === undefined ? 'pending' : String(o);

      console.warn(
        '[WARM_BOOT] callback stalled because session=', sessionStatus,
        'needsOnboarding=', onboardingStatus,
        '(15 s timeout — bootstrap never resolved)',
      );

      setError('Sign-in is taking too long. Please try again.');
    }, 15000);

    return () => clearTimeout(timer);
  }, [exchanged]);

  // ── Phase 2b: Wait for bootstrap, then navigate ────────────────────────────
  // This effect re-runs every time session or needsOnboarding changes.
  // It only acts once exchange has succeeded AND bootstrap has fully resolved.
  useEffect(() => {
    if (!exchanged) return;
    if (navigatedRef.current) return;

    // Log every evaluation so we can trace the progression in Metro.
    const sessionStatus    = session === undefined ? 'pending' : session ? 'active' : 'null';
    const onboardingStatus = needsOnboarding === undefined ? 'pending' : String(needsOnboarding);
    console.log('[WARM_BOOT] callback waiting on — session=', sessionStatus, 'needsOnboarding=', onboardingStatus);

    // Both states must be defined before we can make a routing decision.
    if (session === undefined || needsOnboarding === undefined) return;

    // Guard: if bootstrap resolved but session is null, something went wrong.
    // The exchange reported success but Supabase didn't surface the session —
    // send user back to login rather than showing a blank screen.
    if (!session) {
      console.warn('[WARM_BOOT] exchange succeeded but session is null after bootstrap — routing to login');
      navigatedRef.current = true;
      router.replace('/login');
      return;
    }

    // App is ready. Navigate explicitly based on the resolved onboarding state.
    navigatedRef.current = true;
    if (needsOnboarding) {
      console.log('[WARM_BOOT] routing to onboarding');
      router.replace('/onboarding');
    } else {
      console.log('[WARM_BOOT] routing to tabs');
      router.replace('/');
    }
  }, [exchanged, session, needsOnboarding]);

  // ── Error state ────────────────────────────────────────────────────────────
  if (error) {
    return (
      <View style={{
        flex: 1,
        backgroundColor: '#faf9f7',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}>
        <Text style={{
          fontSize: 17,
          fontWeight: '700',
          color: '#1c1917',
          marginBottom: 10,
          textAlign: 'center',
          letterSpacing: -0.3,
        }}>
          Sign-in failed
        </Text>
        <Text style={{
          fontSize: 14,
          color: '#78716c',
          lineHeight: 21,
          textAlign: 'center',
          marginBottom: 32,
        }}>
          {error}
        </Text>
        <TouchableOpacity
          onPress={() => router.replace('/login')}
          style={{
            backgroundColor: '#1c1917',
            borderRadius: 10,
            paddingVertical: 13,
            paddingHorizontal: 32,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
            Back to sign in
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Loading state (default) ─────────────────────────────────────────────────
  // Stays visible until Phase 2 confirms the app is ready and navigates.
  return (
    <View style={{
      flex: 1,
      backgroundColor: '#faf9f7',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
    }}>
      <ActivityIndicator size="large" color="#1c1917" />
      <Text style={{
        fontSize: 15,
        fontWeight: '500',
        color: '#78716c',
        letterSpacing: -0.2,
      }}>
        Signing you in…
      </Text>
    </View>
  );
}
