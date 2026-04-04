import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';

// Needed for web — completes the auth session after redirect
WebBrowser.maybeCompleteAuthSession();

// ─── Friendly error mapper ────────────────────────────────────────────────────
// Maps raw Supabase/OAuth errors to clean product language.

function mapOAuthError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (raw.includes('provider not found') || raw.includes('not enabled') || raw.includes('unsupported provider')) {
    return 'This sign-in option isn\'t available yet — try email instead.';
  }
  if (raw.includes('cancelled') || raw.includes('cancel') || raw.includes('dismiss')) {
    return '';  // User cancelled — no error to show
  }
  if (raw.includes('network') || raw.includes('fetch') || raw.includes('offline')) {
    return 'No internet connection — check your network and try again.';
  }
  if (raw.includes('rate limit') || raw.includes('too many')) {
    return 'Too many attempts — please wait a moment and try again.';
  }
  // Catch-all — never show raw error text
  return 'Sign-in failed — please try again or use email instead.';
}

// ─── Google Sign-In ───────────────────────────────────────────────────────────
// Uses Supabase OAuth + Expo WebBrowser.
// On native: opens an in-app browser (Safari/Chrome Custom Tabs).
// On web: same OAuth browser redirect flow.
//
// Returns: { error?: string }  — empty string means user cancelled (no message).

export async function signInWithGoogle(): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Not configured.' };

  try {
    const redirectTo = AuthSession.makeRedirectUri();

    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (oauthError || !data.url) {
      return { error: mapOAuthError(oauthError ?? new Error('No URL returned')) };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { error: '' };
    }

    if (result.type !== 'success') {
      return { error: 'Sign-in failed — please try again.' };
    }

    // Extract tokens from the redirect URL.
    // Supabase uses PKCE (code param) or implicit (hash fragment) depending on config.
    const returnUrl = result.url;

    // PKCE flow: code in query params
    const urlObj = new URL(returnUrl);
    const code = urlObj.searchParams.get('code');
    if (code) {
      const { error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
      if (sessionError) return { error: mapOAuthError(sessionError) };
      return {};
    }

    // Implicit flow: tokens in hash fragment
    const hashParams = new URLSearchParams(urlObj.hash.slice(1));
    const access_token  = hashParams.get('access_token');
    const refresh_token = hashParams.get('refresh_token');
    if (access_token && refresh_token) {
      const { error: sessionError } = await supabase.auth.setSession({ access_token, refresh_token });
      if (sessionError) return { error: mapOAuthError(sessionError) };
      return {};
    }

    return { error: 'Sign-in failed — please try again.' };
  } catch (err) {
    return { error: mapOAuthError(err) };
  }
}

// ─── Apple Sign-In ────────────────────────────────────────────────────────────
// Uses expo-apple-authentication (native iOS Apple Sign-In sheet).
// Only available on iOS — call isAppleAvailable() before rendering the button.
//
// Returns: { error?: string }

export async function isAppleAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    const AppleAuthentication = await import('expo-apple-authentication');
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function signInWithApple(): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Not configured.' };

  try {
    const AppleAuthentication = await import('expo-apple-authentication');

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });

    if (!credential.identityToken) {
      return { error: 'Apple sign-in failed — no identity token received.' };
    }

    const { error: authError } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
    });

    if (authError) return { error: mapOAuthError(authError) };

    // Store the full name from Apple (only sent on first sign-in)
    if (credential.fullName?.givenName || credential.fullName?.familyName) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.auth.updateUser({
          data: {
            first_name: credential.fullName.givenName ?? undefined,
            last_name:  credential.fullName.familyName ?? undefined,
          },
        });
      }
    }

    return {};
  } catch (err) {
    // ERR_CANCELED — user tapped Cancel on Apple's sheet
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('cancel') || msg.includes('1001')) {
      return { error: '' };
    }
    return { error: mapOAuthError(err) };
  }
}
