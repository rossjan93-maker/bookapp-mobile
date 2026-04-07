import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';

/**
 * AuthCallbackScreen
 *
 * Matches the deep link path:  readstack://auth/callback
 *
 * Expo Router routes here instead of showing "Unmatched Route" when the user
 * taps a Supabase confirmation or password-reset email link.
 *
 * Responsibilities:
 *   1. Show a loading state so the user sees intentional UI, not a flash.
 *   2. Exchange the PKCE code for a Supabase session.
 *   3. Let the root layout's onAuthStateChange + session guard do all routing
 *      after SIGNED_IN fires — this screen does not navigate explicitly on
 *      success, so the guard owns the destination (onboarding vs. home).
 *   4. Show an error state with a back-to-sign-in button on failure.
 *
 * The root layout's Linking handler skips auth/callback URLs (they are
 * handled here) to avoid double-processing the one-time-use PKCE code.
 */
export default function AuthCallbackScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router    = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setError('Client not configured.');
      return;
    }

    if (!code) {
      // No PKCE code — malformed or already-consumed link.
      console.warn('[AuthCallback] no code param in URL');
      setError('This link has already been used or is invalid.');
      return;
    }

    console.log('[AuthCallback] exchanging PKCE code for session');
    supabase.auth.exchangeCodeForSession(code).then(({ error: err }) => {
      if (err) {
        console.warn('[AuthCallback] exchangeCodeForSession error:', err.message);
        setError('The link may have expired. Please try signing in again.');
        return;
      }
      // Success: supabase.auth.onAuthStateChange fires SIGNED_IN in the root
      // layout, which updates the session state and the guard routes the user
      // to onboarding (new account) or home (returning user).
      console.log('[AuthCallback] code exchanged — waiting for session guard to route');
    });
  }, [code]);

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
          Link expired
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

  // ── Loading state (default) ─────────────────────────────────────────────
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
