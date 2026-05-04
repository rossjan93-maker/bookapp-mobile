import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase } from './supabase';

// Needed for web — completes the auth session after redirect
WebBrowser.maybeCompleteAuthSession();

// ─── OAuth in-flight lock ─────────────────────────────────────────────────────
// Both lib/socialAuth.ts and app/auth/callback.tsx historically called
// supabase.auth.exchangeCodeForSession() on the same single-use PKCE code,
// which causes "invalid grant" failures and intermittent UI hangs (notably
// on Android Custom Tabs and on web where the deep link route also mounts).
//
// We make socialAuth.ts the sole owner of the exchange whenever the
// WebBrowser flow is in-flight. callback.tsx checks isOAuthInFlight()
// before attempting its own exchange.
//
// Two flags compose the lock so that a cancelled/errored attempt does NOT
// silence a legitimate late-arriving deep link in app/auth/callback.tsx:
//
//   webBrowserActive — true only while the WebBrowser session is open.
//                      Cleared in finally for every outcome.
//   exchangeOwnedAt  — set only when we are committing to exchange a code
//                      we actually received. Provides a 5 s post-completion
//                      grace window so a late deep link to callback.tsx
//                      cannot double-exchange the same code we just used.
//
// On cancel / browser error / dismiss-without-deep-link, exchangeOwnedAt is
// NEVER set, so callback.tsx remains free to handle a late deep link.

let webBrowserActive = false;
let exchangeOwnedAt = 0;

export function isOAuthInFlight(): boolean {
  return webBrowserActive || (exchangeOwnedAt > 0 && Date.now() - exchangeOwnedAt < 5000);
}

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
  let parsedErrorCode = '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const jsonMsg    = String(parsed.msg ?? parsed.message ?? parsed.error ?? '').toLowerCase();
    const errorCode  = String(parsed.error_code ?? parsed.code ?? '').toLowerCase();
    parsedErrorCode  = errorCode;
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

  // ── Existing-account collision ──────────────────────────────────────────────
  // Apple (and Google) deliver an identity for an email that already has a
  // Supabase user via password.  Without "Link accounts with same email"
  // enabled in the Supabase dashboard, signInWithIdToken returns
  // `email_exists` / `user_already_exists` / `identity_already_exists`.
  // Tell the user clearly so they don't keep tapping the Apple button.
  if (
    parsedErrorCode === 'email_exists' ||
    parsedErrorCode === 'user_already_exists' ||
    parsedErrorCode === 'identity_already_exists' ||
    parsedErrorCode === 'user_already_registered' ||
    lower.includes('email already') ||
    lower.includes('already registered') ||
    lower.includes('already exists') ||
    lower.includes('identity_already_exists') ||
    lower.includes('user_already_exists')
  ) {
    return 'An account with this email already exists. Sign in with your password, then link this provider from Settings.';
  }

  if (
    lower.includes('provider not found') ||
    lower.includes('not enabled') ||
    lower.includes('unsupported provider') ||
    lower.includes('validation_failed') ||
    lower.includes('provider_disabled')
  ) {
    return "This sign-in option isn't available yet — try email instead.";
  }

  // ── Manual linking disabled in dashboard ───────────────────────────────────
  // supabase.auth.linkIdentity() returns this when "Allow manual linking" is
  // off in Supabase Auth settings. Surface a distinct message so the operator
  // can fix the dashboard without guessing — generic "try again" hides this.
  if (
    lower.includes('manual linking is disabled') ||
    lower.includes('manual_linking_disabled') ||
    parsedErrorCode === 'manual_linking_disabled'
  ) {
    return "Account linking isn't enabled yet — please contact support.";
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

  webBrowserActive = true;

  // ── Android dismiss fallback ─────────────────────────────────────────────
  // On Android (Custom Tabs) and some iOS configurations, the OS hands the
  // OAuth redirect to the app as a deep link instead of returning it inline
  // through WebBrowser.openAuthSessionAsync. In those cases the WebBrowser
  // session resolves with type='dismiss' and the redirect URL arrives over
  // expo-linking. We listen for it for the duration of this flow and use it
  // as a fallback if the inline result is dismiss/cancel.
  let dismissUrl: string | null = null;
  const linkSub = Linking.addEventListener('url', ({ url }) => {
    if (url && url.includes('auth/callback')) {
      dismissUrl = url;
    }
  });

  try {
    // ── Platform-split redirect target ──────────────────────────────────────
    // Web and native need genuinely different redirect URLs:
    //
    //   Native (iOS / Android dev client + standalone)
    //     readstack://auth/callback     — custom URL scheme deep link
    //
    //   Web (browser, including the Replit preview iframe)
    //     <window.location.origin>/auth/callback
    //     — Expo Router serves app/auth/callback.tsx universally, so the
    //       same screen handles the ?code=… on web exactly as on native.
    //
    // Both targets must be in the Supabase Auth → URL Configuration →
    // Redirect URLs allow-list. If a target is missing, Supabase silently
    // falls back to the project Site URL root, which surfaces as
    // {"error":"requested path is invalid"} on a `/<root>?code=…` URL.
    let redirectTo: string;
    if (Platform.OS === 'web') {
      const origin =
        typeof window !== 'undefined' && window.location?.origin
          ? window.location.origin
          : '';
      if (!origin) {
        return { error: 'Sign-in failed — please try again.' };
      }
      redirectTo = `${origin}/auth/callback`;
    } else {
      redirectTo = AuthSession.makeRedirectUri({
        scheme: 'readstack',
        path: 'auth/callback',
      });
    }

    // ── Sanity check: warn if Expo proxy URL is being used unexpectedly ──
    // The Supabase redirect allow-list is configured for the custom scheme
    // (readstack://auth/callback). If makeRedirectUri returns a proxy URL
    // (auth.expo.io / *.exp.direct) the redirect will not match and the
    // browser will land on a Supabase error page. Flag this loudly so the
    // next regression is obvious in console logs.
    if (
      redirectTo.includes('auth.expo.io') ||
      redirectTo.includes('.exp.direct') ||
      redirectTo.includes('exp://')
    ) {
      console.error(
        '[OAUTH] makeRedirectUri returned a proxy URL (' +
          redirectTo +
          ') — Google sign-in requires the dev client / standalone build, not Expo Go.',
      );
    } else {
      console.log('[OAUTH] redirectTo=', redirectTo, 'provider=', provider, 'platform=', Platform.OS);
    }

    const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });

    if (oauthError || !data.url) {
      return { error: mapOAuthError(oauthError ?? new Error('No authorization URL returned')) };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    console.log('[OAUTH] WebBrowser result.type=', result.type);

    let returnUrl: string | null = null;
    if (result.type === 'success') {
      returnUrl = result.url;
    } else if (result.type === 'cancel' || result.type === 'dismiss') {
      // Android Custom Tabs and some iOS configurations resolve with
      // dismiss/cancel BEFORE the deep link with the redirect URL fires.
      // Poll briefly so we don't mistakenly conclude the user cancelled.
      // Total wait budget: ~1000ms (10 × 100ms). Real cancellations don't
      // produce a deep link, so they still surface as cancel after the wait.
      if (!dismissUrl) {
        console.log('[OAUTH] dismiss with no deep link yet — waiting up to 1000ms for fallback');
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (dismissUrl) break;
        }
      }
      if (dismissUrl) {
        console.log('[OAUTH] dismiss + deep link fallback engaged');
        returnUrl = dismissUrl;
      } else {
        console.log('[OAUTH] dismiss — no deep link arrived, treating as cancel');
        return { error: '' };
      }
    } else {
      return { error: 'Sign-in failed — please try again.' };
    }

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
      // Set the post-completion grace window only now that we have a real
      // code we are about to exchange. This keeps callback.tsx unblocked
      // when the redirect URL turned out to carry no usable code.
      exchangeOwnedAt = Date.now();
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
  } finally {
    linkSub.remove();
    webBrowserActive = false;
    // exchangeOwnedAt is intentionally NOT touched here — see the lock
    // documentation at the top of the file. We only set it when we begin
    // the exchange, and rely on the 5-second grace window in
    // isOAuthInFlight() to expire it naturally.
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

// ─── Identity introspection ──────────────────────────────────────────────────
// Reads the providers attached to the current user. Used by the Settings
// "Sign-in methods" section to render which providers are connected and
// disable the link button for ones that already are.

export type ConnectedIdentity = {
  provider: 'email' | 'google' | 'apple' | string;
  identity_id?: string;
  email?: string | null;
};

export async function getConnectedIdentities(): Promise<ConnectedIdentity[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.auth.getUserIdentities();
    if (error || !data?.identities) return [];
    return data.identities.map((id) => ({
      provider:    id.provider,
      identity_id: id.identity_id,
      email:       (id.identity_data as { email?: string } | null)?.email ?? null,
    }));
  } catch (err) {
    console.warn('[socialAuth] getConnectedIdentities failed:', err);
    return [];
  }
}

// ─── Identity linking ────────────────────────────────────────────────────────
// Attaches an additional sign-in provider to the currently signed-in user so
// they can sign in with either email/password OR the linked provider next time.
//
// IMPORTANT: this requires "Allow manual linking" enabled in
//   Supabase Dashboard → Authentication → Settings → Manual linking
// Without it, supabase-js returns a "manual linking is disabled" error which
// we surface verbatim so the dashboard misconfiguration is obvious.
//
// Apple-on-iOS uses the native sheet exactly like sign-in: we obtain the
// identity token via expo-apple-authentication and attach it via
// signInWithIdToken — Supabase records it as a linked identity on the
// existing user when the email matches.
//
// Google (all platforms) and Apple (web/Android) use the OAuth browser flow
// via supabase.auth.linkIdentity() which returns a redirect URL we open in
// the same WebBrowser as sign-in.

export async function linkIdentityProvider(
  provider: 'google' | 'apple',
): Promise<{ error?: string }> {
  if (!supabase) return { error: 'Not configured.' };

  // ── Capture the current account email up-front ───────────────────────────
  // Used after the link completes to verify the provider account the user
  // chose matches the account they're signed into. If they pick a different
  // Google/Apple email by accident, we unlink immediately so the wrong
  // identity is never left attached.
  const { data: { user: currentUser } } = await supabase.auth.getUser();
  if (!currentUser) return { error: 'You need to be signed in to link an account.' };
  const currentEmail = (currentUser.email ?? '').toLowerCase();

  // Snapshot identities BEFORE linking so we can find the new one after.
  const beforeIdentitiesIds = new Set(
    (currentUser.identities ?? []).map((i) => i.identity_id).filter(Boolean) as string[],
  );

  // Apple on iOS — native sheet, no browser
  if (provider === 'apple' && Platform.OS === 'ios') {
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
      // Apple's email claim — only present on first auth, but that's exactly
      // when linking happens, so we can validate before even calling Supabase.
      const appleEmail = (credential.email ?? '').toLowerCase();
      if (appleEmail && currentEmail && appleEmail !== currentEmail) {
        return {
          error: `That Apple account uses a different email (${appleEmail}). Sign in with the Apple ID matching ${currentEmail} to link.`,
        };
      }
      // signInWithIdToken on an already-authenticated session attaches the
      // identity rather than creating a new user, provided the email matches
      // and manual linking is enabled in the dashboard.
      const { error: authError } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
      });
      if (authError) return { error: mapOAuthError(authError) };
      return {};
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('cancel') || msg.includes('1001')) return { error: '' };
      return { error: mapOAuthError(err) };
    }
  }

  // Google / Apple-on-web/Android — OAuth browser flow via linkIdentity()
  webBrowserActive = true;
  let dismissUrl: string | null = null;
  // Listen on BOTH callback paths so the dismiss-fallback works whether the
  // OS hands us the deep link via /auth/callback (legacy) or the new
  // /auth/link-callback (preferred — keeps Settings on screen).
  const linkSub = Linking.addEventListener('url', ({ url }) => {
    if (url && (url.includes('auth/link-callback') || url.includes('auth/callback'))) {
      dismissUrl = url;
    }
  });

  try {
    // ── Distinct redirect target for linking ────────────────────────────────
    // We deliberately do NOT reuse /auth/callback here. That screen is the
    // sign-in landing screen and runs the onboarding probe + routes the
    // user to /(tabs) — exactly the "normal login/profile-loading page"
    // bug the user reported. /auth/link-callback is a tiny screen that
    // does the code exchange (cold deep-link path only) and bounces back
    // to /settings. Add it to:
    //   Supabase Dashboard → Authentication → URL Configuration →
    //     Redirect URLs allow-list:
    //       https://<your-prod-domain>/auth/link-callback
    //       readstack://auth/link-callback
    let redirectTo: string;
    if (Platform.OS === 'web') {
      const origin =
        typeof window !== 'undefined' && window.location?.origin
          ? window.location.origin
          : '';
      if (!origin) return { error: 'Linking failed — please try again.' };
      redirectTo = `${origin}/auth/link-callback`;
    } else {
      redirectTo = AuthSession.makeRedirectUri({
        scheme: 'readstack',
        path: 'auth/link-callback',
      });
    }

    const { data, error: linkErr } = await supabase.auth.linkIdentity({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (linkErr || !data?.url) {
      return { error: mapOAuthError(linkErr ?? new Error('No authorization URL returned')) };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    let returnUrl: string | null = null;
    if (result.type === 'success') {
      returnUrl = result.url;
    } else if (result.type === 'cancel' || result.type === 'dismiss') {
      if (!dismissUrl) {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (dismissUrl) break;
        }
      }
      if (dismissUrl) returnUrl = dismissUrl;
      else            return { error: '' };
    } else {
      return { error: 'Linking failed — please try again.' };
    }

    const urlObj = new URL(returnUrl);
    const qError = urlObj.searchParams.get('error') ?? urlObj.searchParams.get('error_description');
    if (qError) return { error: mapOAuthError(new Error(qError)) };
    const hashParams = new URLSearchParams(urlObj.hash.slice(1));
    const hError = hashParams.get('error') ?? hashParams.get('error_description');
    if (hError) return { error: mapOAuthError(new Error(hError)) };

    const code = urlObj.searchParams.get('code');
    if (code) {
      exchangeOwnedAt = Date.now();
      const { error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
      if (sessionError) return { error: mapOAuthError(sessionError) };

      // ── Email-match validation (post-link) ────────────────────────────
      // Supabase manual linking does NOT enforce email match by default.
      // We compare the newly attached identity's email to the current
      // user's email; if they differ, unlink immediately so the wrong
      // identity is never left attached. This mirrors what users expect
      // — "I'm linking my Google" implies "the Google with my email".
      try {
        const { data: idData } = await supabase.auth.getUserIdentities();
        const newIdentity = (idData?.identities ?? []).find(
          (i) => i.provider === provider && !beforeIdentitiesIds.has(i.identity_id),
        );
        if (newIdentity) {
          const linkedEmail = ((newIdentity.identity_data as { email?: string } | null)?.email ?? '').toLowerCase();
          if (currentEmail && linkedEmail && linkedEmail !== currentEmail) {
            // Roll back. unlinkIdentity throws on failure, but if it does
            // the surface error is still better than silently keeping the
            // mismatched identity attached.
            try { await supabase.auth.unlinkIdentity(newIdentity); } catch (e) {
              console.warn('[LINK] rollback unlinkIdentity failed:', e);
            }
            const providerLabel = provider === 'apple' ? 'Apple' : 'Google';
            return {
              error: `That ${providerLabel} account uses a different email (${linkedEmail}). Sign in with the ${providerLabel} account matching ${currentEmail} to link.`,
            };
          }
        }
      } catch (e) {
        // Don't fail the link just because the email-match check threw —
        // log and proceed. The link itself succeeded.
        console.warn('[LINK] email-match validation threw:', e);
      }

      return {};
    }
    return { error: 'Linking failed — please try again.' };
  } catch (err) {
    return { error: mapOAuthError(err) };
  } finally {
    linkSub.remove();
    webBrowserActive = false;
  }
}
