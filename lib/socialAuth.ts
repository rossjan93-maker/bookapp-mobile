import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';

// Needed for web — completes the auth session after redirect
WebBrowser.maybeCompleteAuthSession();

// ─── Friendly error mapper ────────────────────────────────────────────────────
// Handles raw strings, Error instances, Supabase AuthError objects, and JSON
// error body strings (which supabase-js sometimes puts as err.message).

function mapOAuthError(err: unknown): string {
  let raw = '';

  if (err instanceof Error) {
    raw = err.message;
  } else if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    raw = String(obj.message ?? obj.msg ?? JSON.stringify(obj));
  } else {
    raw = String(err ?? '');
  }

  // Parse JSON error bodies — supabase-js v2 sometimes puts the full API
  // response JSON as the error message string.
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const jsonMsg    = String(parsed.msg ?? parsed.message ?? parsed.error ?? '').toLowerCase();
    const errorCode  = String(parsed.error_code ?? parsed.code ?? '').toLowerCase();
    if (
      jsonMsg.includes('not enabled') ||
      jsonMsg.includes('unsupported provider') ||
      jsonMsg.includes('provider not found') ||
      errorCode === 'validation_failed' ||
      errorCode === 'provider_disabled'
    ) {
      return "This sign-in option isn't available yet — try email instead.";
    }
    // Fall through to string checks using the human-readable portion
    if (jsonMsg) raw = jsonMsg;
  } catch {
    // Not JSON — continue with raw string checks
  }

  const lower = raw.toLowerCase();

  if (
    lower.includes('provider not found') ||
    lower.includes('not enabled') ||
    lower.includes('unsupported provider') ||
    lower.includes('validation_failed') ||
    lower.includes('provider_disabled')
  ) {
    return "This sign-in option isn't available yet — try email instead.";
  }
  if (lower.includes('cancelled') || lower.includes('cancel') || lower.includes('dismiss')) {
    return '';
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('offline')) {
    return 'No internet connection — check your network and try again.';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many attempts — please wait a moment and try again.';
  }

  // Catch-all — never show raw error text
  return 'Sign-in failed — please try again or use email instead.';
}

// ─── Shared OAuth browser flow ────────────────────────────────────────────────
// Used for Google (all platforms) and Apple (web + Android).
// Opens an in-app browser, handles the redirect, and exchanges the token.

async function handleOAuthBrowserFlow(
  provider: 'google' | 'apple',
): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Not configured.' };

  try {
    const redirectTo = AuthSession.makeRedirectUri({
      scheme: 'readstack',
      path: 'auth/callback',
    });

    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });

    if (oauthError || !data.url) {
      return { error: mapOAuthError(oauthError ?? new Error('No authorization URL returned')) };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { error: '' };
    }

    if (result.type !== 'success') {
      return { error: 'Sign-in failed — please try again.' };
    }

    const returnUrl = result.url;
    const urlObj    = new URL(returnUrl);

    // Check for error params in the redirect URL before looking for tokens.
    // Supabase redirects with ?error= or #error= when the provider rejects.
    const qError = urlObj.searchParams.get('error') ?? urlObj.searchParams.get('error_description');
    if (qError) return { error: mapOAuthError(new Error(qError)) };

    const hashParams = new URLSearchParams(urlObj.hash.slice(1));
    const hError = hashParams.get('error') ?? hashParams.get('error_description');
    if (hError) return { error: mapOAuthError(new Error(hError)) };

    // PKCE flow: authorization code in query params
    const code = urlObj.searchParams.get('code');
    if (code) {
      const { error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
      if (sessionError) return { error: mapOAuthError(sessionError) };
      console.log('[WARM_BOOT] socialAuth exchangeCodeForSession success — provider=', provider);
      return {};
    }

    // Implicit flow: tokens in hash fragment
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

// ─── Google Sign-In ───────────────────────────────────────────────────────────
// OAuth browser flow on all platforms.
// Returns: { error?: string } — empty string means user cancelled (no message).

export async function signInWithGoogle(): Promise<{ error?: string }> {
  return handleOAuthBrowserFlow('google');
}

// ─── Profile name persistence (Apple) ─────────────────────────────────────────
// Writes Apple-provided first/last name into the profiles row, with retry to
// survive the race against ensureProfile() in app/_layout.tsx (which runs in
// parallel via onAuthStateChange and uses ignoreDuplicates:true).

async function persistAppleNamesToProfile(
  userId: string,
  email: string,
  firstName: string | null,
  lastName: string | null,
): Promise<void> {
  if (!supabase) return;
  if (!firstName && !lastName) return;

  // Step 1: ensure the profiles row exists.
  // Mirrors the username-fallback logic in ensureProfile so a row created here
  // (when we win the race) carries the same shape as one created there.
  const emailPrefix      = (email || 'user').split('@')[0] || 'user';
  const idSuffix         = userId.replace(/-/g, '').slice(0, 6);
  const fallbackUsername = `${emailPrefix}_${idSuffix}`;

  try {
    await supabase
      .from('profiles')
      .upsert(
        { id: userId, username: fallbackUsername },
        { onConflict: 'id', ignoreDuplicates: true },
      );
  } catch (e) {
    console.warn('[APPLE_AUTH] profiles upsert (row create) failed:', e);
  }

  // Step 2: set first_name/last_name on the row.
  // Retry up to 3 times so we win even if ensureProfile is mid-flight elsewhere.
  // Filter on first_name IS NULL so we never overwrite a value the user has
  // since edited themselves.
  const updates: Record<string, unknown> = {};
  if (firstName) updates.first_name = firstName;
  if (lastName)  updates.last_name  = lastName;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userId)
        .is('first_name', null);
      if (!error) {
        console.log('[APPLE_AUTH] profile names persisted (attempt', attempt + 1, ')');
        return;
      }
      console.warn('[APPLE_AUTH] profile name update error (attempt', attempt + 1, '):', error.message);
    } catch (e) {
      console.warn('[APPLE_AUTH] profile name update threw (attempt', attempt + 1, '):', e);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ─── Apple Sign-In ────────────────────────────────────────────────────────────
// iOS:          native system sheet (expo-apple-authentication)
// Web/Android:  intentionally hidden until Apple web Service ID is configured.
//               Apple's OIDC browser flow requires a registered Service ID +
//               return URL in Apple Developer — without that it always fails.
//
// isAppleAvailable() returns true only on iOS where the native path works.

export function isAppleAvailable(): boolean {
  return Platform.OS === 'ios';
}

export async function signInWithApple(): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Not configured.' };

  if (Platform.OS === 'ios') {
    // ── Native iOS path: system sheet, no browser required ──
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

      // Apple only sends the full name on the very first sign-in.
      //
      // Race we are defending against:
      //   1. signInWithIdToken() returns → onAuthStateChange fires in _layout.tsx
      //   2. ensureProfile() upserts a profiles row using user_metadata, which
      //      at this instant has NO names (Apple delivers them out-of-band, in
      //      the credential object — not in the id-token claims).
      //   3. ensureProfile() uses ignoreDuplicates:true, so once the row exists
      //      with NULL names a later metadata refresh will NOT update it.
      //   4. Result: profile permanently shows the fallback "user_xxx" username
      //      instead of the user's real Apple-provided name.
      //
      // Fix: after updating auth metadata, also write the names directly into
      // the profiles row. Run an UPSERT first to guarantee the row exists, then
      // an UPDATE that only touches first_name/last_name — this avoids
      // overwriting any fields ensureProfile (or another path) may have set.
      if (credential.fullName?.givenName || credential.fullName?.familyName) {
        const firstName = credential.fullName.givenName ?? null;
        const lastName  = credential.fullName.familyName ?? null;
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          // 1. Refresh auth metadata so getSession() reflects the names.
          try {
            await supabase.auth.updateUser({
              data: {
                first_name: firstName ?? undefined,
                last_name:  lastName  ?? undefined,
              },
            });
          } catch (e) {
            console.warn('[APPLE_AUTH] updateUser metadata failed:', e);
          }

          // 2. Defensively persist names directly into the profiles row.
          //    Retry briefly because ensureProfile (which creates the row) may
          //    not have completed yet — onAuthStateChange runs in parallel.
          await persistAppleNamesToProfile(user.id, user.email ?? '', firstName, lastName);
        }
      }

      return {};
    } catch (err) {
      // ERR_CANCELED (code 1001) — user tapped Cancel on Apple's sheet
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('cancel') || msg.includes('1001')) return { error: '' };
      return { error: mapOAuthError(err) };
    }
  }

  // ── Web / Android path: OAuth browser flow ──
  return handleOAuthBrowserFlow('apple');
}
