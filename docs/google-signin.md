# Google Sign-In — Working Configuration

This doc captures the exact configuration required for Google sign-in to work
end-to-end in Readstack, plus a short troubleshooting checklist for the next
time it breaks.

## Project values used below

- Supabase project ref: `dqveycawauuwcplowmrd`
- Supabase project URL: `https://dqveycawauuwcplowmrd.supabase.co`
- Web app origin (when web sign-in is intended to work): `https://readstack.co`
- Native URL schemes: `readstack` (current), `bookappmobile` (legacy)

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

On **web**, `AuthSession.makeRedirectUri({ scheme: 'readstack', path:
'auth/callback' })` ignores the scheme and returns
`<window.location.origin>/auth/callback`. So **every web origin the app is
served from** must be in the Supabase redirect allow list (production,
staging, local dev — each is a separate entry).

## Supabase Auth → URL Configuration

### Site URL

Must be the **user-facing web origin**, NOT the Supabase project root.

- Correct (production):   `https://readstack.co`
- Wrong (causes the `{"error":"requested path is invalid"}` symptom):
  `https://dqveycawauuwcplowmrd.supabase.co` — Supabase strips the path and
  redirects the user to its own API root with `?code=...`, which has no
  handler.

If web sign-in is not yet deployed, set Site URL to the deep link instead
(`readstack://auth/callback`). Never leave it pointing at the Supabase API
host.

### Redirect URLs (allow list)

Must include all of:

- `readstack://auth/callback`              (iOS / Android dev client + standalone)
- `bookappmobile://auth/callback`          (legacy scheme — kept for in-flight users)
- `https://readstack.co/auth/callback`     (production web — required for browser Google sign-in)
- Any additional web origins used during development (e.g. preview deploys)
- `https://<project-ref>.supabase.co/auth/v1/callback`  (default, used by Supabase itself)
- **Every web origin where sign-in runs**, with `/auth/callback` appended:
  - Replit dev preview: e.g. `https://873b2006-24b4-4f11-90d7-d43f33b13819-00-1is2pqlq3lp0f.picard.replit.dev/auth/callback`
    (the host changes per Repl — re-add when it changes)
  - Local web dev: `http://localhost:5000/auth/callback`
  - Future production web origin once a real domain is live
    (e.g. `https://app.readstack.com/auth/callback`)

Native uses the `readstack://` scheme; the browser uses the current origin
plus `/auth/callback` (Expo Router serves `app/auth/callback.tsx` universally,
so the same screen handles `?code=…` on web and on native).

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
- Client ID:     the Google Cloud OAuth Web client's Client ID (`Readstack-web`)
- Client Secret: the Google Cloud OAuth Web client's Client Secret
- Skip nonce check: **off**

## Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs

### Web client (`Readstack-web`)

This is the client Supabase brokers with. It is the only Google client
required for the redirect-based `signInWithOAuth` flow used by both web and
native (native opens the browser flow, Google posts back to Supabase, Supabase
posts back to the app via the redirect URI).

- Authorised redirect URIs:
  - `https://dqveycawauuwcplowmrd.supabase.co/auth/v1/callback`
- Authorised JavaScript origins:
  - Optional. Only required if the app ever uses Google's JS SDK / Identity
    Services / one-tap directly in the browser. The current
    `signInWithOAuth` flow does not need it. If web one-tap is added later,
    add `https://readstack.co` here.

### Android client (`Readstack-android`)

Present in the dashboard with package name `com.readstack.app` and a SHA-1
fingerprint. It is **not** used by the current sign-in code path — the
Android flow goes through the same Supabase-brokered browser redirect. Keep
it for future native Google Sign-In integration; it is harmless if unused.

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
   `readstack://auth/callback` on native, or `https://<your-origin>/auth/callback`
   on web (not an `auth.expo.io` proxy URL).
2. Check Supabase → Auth → URL Configuration → Redirect URLs — confirm that
   exact URL is in the allow list. Web origins must be added per environment.
3. Check Supabase → Auth → URL Configuration → Site URL — confirm it is the
   web app origin (`https://readstack.co`), NOT the Supabase project root.
   Wrong Site URL is what produces `{"error":"requested path is invalid"}`
   when the redirect URL isn't matched by the allow list and Supabase falls
   back.
4. Check `[OAUTH] WebBrowser result.type=` — `success` is the inline path,
   `dismiss` should still recover via the deep link fallback. Anything else
   means the browser closed without a redirect.
5. Check Supabase → Auth → Providers → Google — confirm provider is enabled
   and the Web Client ID / Secret match the Google Cloud Console values.
6. Check Google Cloud Console → Credentials → OAuth web client — confirm
   `https://dqveycawauuwcplowmrd.supabase.co/auth/v1/callback` is in the
   authorised redirect URIs list.
