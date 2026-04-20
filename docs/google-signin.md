# Google Sign-In — Working Configuration

This doc captures the exact configuration required for Google sign-in to work
end-to-end in Readstack, plus a short troubleshooting checklist for the next
time it breaks.

## App scheme

`app.json` declares two URL schemes:

```
"scheme": ["readstack", "bookappmobile"]
```

The OAuth redirect uses `readstack://auth/callback`. Do not rename the
`readstack` scheme — the Supabase redirect allow list and the Google Cloud
OAuth client are configured against it.

## Build target

Google sign-in works in the **dev client** and in **standalone TestFlight /
App Store / Play Store builds**. It does **not** work in Expo Go: Expo Go uses
the auth proxy (`auth.expo.io`), which produces a redirect URL that is not in
the Supabase allow list. `lib/socialAuth.ts` logs a loud `[OAUTH]` error if
`AuthSession.makeRedirectUri` returns a proxy URL.

## Supabase Auth → URL Configuration → Redirect URLs

The allow list must include all of:

- `readstack://auth/callback`              (iOS / Android dev client + standalone)
- `bookappmobile://auth/callback`          (legacy scheme — kept for in-flight users)
- `https://<project-ref>.supabase.co/auth/v1/callback`  (default, used by Supabase itself)
- The deployed web origin if/when web sign-in is enabled (e.g. `https://readstack.app/auth/callback`)

### Site URL — critical

Site URL **must NOT** be set to a domain we do not actually host (for example
`https://readstack.co`). When the `redirect_to` value the app sends is not on
the allow list above, Supabase silently falls back to the Site URL and uses
the same path — so `redirect_to=readstack://auth/callback` with an empty allow
list and `Site URL=https://readstack.co` produces a real HTTPS redirect to
`https://readstack.co/auth/callback?code=…`. That URL 404s, the browser stops
there, the app never receives the deep link, and the user is stuck on
"Signing you in…".

Set Site URL to either:
- the default `https://<project-ref>.supabase.co`, OR
- a real owned web origin that serves the callback (we do not currently have one).

This is the single most common cause of "Google sign-in hangs" reports, and it
is a dashboard-only fix — no code change can recover from it because the
WebBrowser session never returns to the app.

## Supabase Auth → Providers → Google

- Enabled: **on**
- Client ID:     the Google Cloud OAuth client's Web Client ID
- Client Secret: the Google Cloud OAuth client's Web Client Secret
- Skip nonce check: **off**

## Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs

A single **Web application** OAuth client is used (Supabase brokers the
redirect, so iOS / Android client IDs are not required for this flow).

- Authorised JavaScript origins:
  - `https://<project-ref>.supabase.co`
- Authorised redirect URIs:
  - `https://<project-ref>.supabase.co/auth/v1/callback`

## Single-owner exchange contract

The PKCE code is single-use. Two paths historically tried to exchange it:

1. `lib/socialAuth.ts` after `WebBrowser.openAuthSessionAsync` resolves.
2. `app/auth/callback.tsx` when mounted with a `?code=…` deep link.

The second call always failed with "invalid grant" and could leave the UI
stuck on the "Signing you in…" screen. The current contract:

- `socialAuth.ts` is the **sole owner** of the exchange while a WebBrowser
  flow is in flight. It exposes `isOAuthInFlight()` (true while the flow is
  open and for 5 s after it completes).
- `app/auth/callback.tsx` checks `isOAuthInFlight()` and skips its own
  exchange when true. It still handles the cold-start case where the app is
  launched directly from a deep link with no in-flight WebBrowser session.

`socialAuth.ts` also subscribes to `Linking` for the duration of the flow
and uses any deep link delivered while `WebBrowser` reports `dismiss` /
`cancel` as a fallback redirect URL — this is the Android Custom Tabs case
where the OS hands the redirect to the app instead of returning it inline.

## Troubleshooting checklist

If Google sign-in breaks again, in order:

1. Check `[OAUTH] redirectTo=` in console — confirm it is
   `readstack://auth/callback` (not an `auth.expo.io` proxy URL).
2. Check Supabase → Auth → URL Configuration — confirm that exact URL is
   in the redirect allow list.
3. Check `[OAUTH] WebBrowser result.type=` — `success` is the inline path,
   `dismiss` should still recover via the deep link fallback. Anything else
   means the browser closed without a redirect.
4. Check Supabase → Auth → Providers → Google — confirm provider is enabled
   and the Web Client ID / Secret match the Google Cloud Console values.
5. Check Google Cloud Console → Credentials → OAuth client — confirm
   `https://<project-ref>.supabase.co/auth/v1/callback` is in the
   authorised redirect URIs list.
