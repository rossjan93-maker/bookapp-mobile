/**
 * app/auth/link-callback.tsx
 *
 * Post-OAuth landing screen for **identity linking** initiated from
 * Settings → Sign-in methods. Distinct from app/auth/callback.tsx (which is
 * the normal sign-in landing screen) so that linking does NOT trigger the
 * onboarding probe, profile bootstrap, or "/(tabs)" redirect that a fresh
 * sign-in needs.
 *
 * Why a separate route is required:
 *   The user is ALREADY authenticated when they tap "Connect Google" from
 *   Settings. Supabase's linkIdentity() flow ends with a redirect to a URL
 *   we choose. If that redirect is `/auth/callback`, the sign-in screen
 *   mounts, runs needsOnboarding probes, and router.replace('/')s the user
 *   off Settings — which surfaces as the "normal login/profile-loading
 *   page" the user reported. Pointing Supabase at this route instead keeps
 *   the user on Settings.
 *
 * What this screen does:
 *   1. If a `?code=` is present AND lib/socialAuth.ts is NOT in-flight
 *      (cold deep-link path on Android), exchange the code so the linked
 *      identity is attached to the session.
 *   2. Show a brief "Linking…" message — never the onboarding probe.
 *   3. router.replace('/settings') — straight back to where the user came
 *      from. Settings re-fetches connected identities on focus so the new
 *      "Connected ✓" badge appears immediately.
 */
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { BookStackLoader } from '../../components/BookStackLoader';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { isOAuthInFlight } from '../../lib/socialAuth';

export default function LinkCallbackScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router   = useRouter();
  const navigatedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Cold deep-link path: app was reopened with a code in the URL and
      // socialAuth.ts is no longer holding the in-flight lock. Exchange
      // here so the linked identity sticks. The hot path (WebBrowser
      // captured the redirect inline) is owned by linkIdentityProvider in
      // socialAuth.ts and we MUST skip the exchange here to avoid the
      // single-use PKCE code being consumed twice.
      if (supabase && code && !isOAuthInFlight()) {
        try {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            console.warn('[LINK_CALLBACK] exchangeCodeForSession failed:', error.message);
          } else {
            console.log('[LINK_CALLBACK] exchangeCodeForSession ok (cold deep-link)');
          }
        } catch (e) {
          console.warn('[LINK_CALLBACK] exchangeCodeForSession threw:', e);
        }
      }

      if (cancelled || navigatedRef.current) return;
      navigatedRef.current = true;
      // Hand control back to Settings. Use replace so the link-callback
      // screen does not appear in the back stack.
      router.replace('/settings');
    })();

    return () => { cancelled = true; };
  }, [code]);

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f1ec', alignItems: 'center', justifyContent: 'center' }}>
      <BookStackLoader size="lg" />
      <Text style={{
        fontSize: 17, fontWeight: '700', color: '#231f1b',
        marginTop: 20, letterSpacing: -0.3,
      }}>
        Linking your account…
      </Text>
      <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 6 }}>
        Just a moment
      </Text>
    </View>
  );
}
