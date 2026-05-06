# Readstack — iOS / TestFlight QA Checklist

Run this checklist on a real iPhone (TestFlight build) before each beta cycle.
Native config changes (anything in `app.json` `ios.*` or `plugins`) require a
fresh build — `npm run build:ios:beta`. JS-only changes can use OTA via
`npm run dev:device`.

## Pre-flight (one-time per build)
- [ ] `app.json` `version` bumped if user-visible changes shipped
- [ ] `eas.json` `beta` profile points to correct `ascAppId` / `appleTeamId`
- [ ] Supabase Auth → URL Configuration → Redirect URLs includes:
  - [ ] `readstack://auth/callback`
  - [ ] `readstack://auth/link-callback`
- [ ] Supabase Apple provider has Service ID + key configured (only required
      for the web/Android Apple path — iOS uses the native sheet)
- [ ] EAS build succeeded; build uploaded to TestFlight
- [ ] Tester is on iOS 16+ (minimum supported)

## 1. Auth — Apple
- [ ] First-time Apple sign-in: name appears in profile (not "user_xxxx")
- [ ] Repeat Apple sign-in on same device: signs in instantly, no name overwrite
- [ ] Apple sign-in with email that already has a password account: shows
      "An account with this email already exists. Sign in with your password,
      then link this provider from Settings."
- [ ] Tap Cancel on Apple sheet: no error toast, button re-enables

## 2. Auth — Google
- [ ] First-time Google sign-in opens system in-app browser (SFSafariViewController)
- [ ] After consent, lands on Readstack (no Safari dead-end), then onboarding
- [ ] Existing user Google sign-in skips onboarding, lands on Library tab
- [ ] No "requested path is invalid" error (would indicate redirect URL not in
      Supabase allow-list)
- [ ] Cancel mid-browser: returns to login screen cleanly

## 3. Auth — Email + password reset deep link
- [ ] Request reset → email arrives within ~30s
- [ ] Tap link in iOS Mail app → opens Readstack (not Safari)
- [ ] Lands on Set-new-password screen, not onboarding or home
- [ ] Set new password succeeds → home tab
- [ ] Re-tap the same link after use → "This reset link has expired or
      already been used. Request a new one from the sign-in screen."
- [ ] Wait 1 hour, tap stale link → same expired message

## 4. Onboarding
- [ ] New account walks through onboarding-questions → onboarding-import
- [ ] Skip import works; lands on home with empty library
- [ ] Killing app mid-onboarding resumes at correct step on relaunch

## 5. Add Book / Search / Scan
- [ ] Search by title returns Open Library + Google Books results
- [ ] Tap "Scan barcode" → camera permission prompt fires once with the
      Readstack copy ("Readstack uses the camera to scan book barcodes.")
- [ ] After granting, scanning a real ISBN13 barcode resolves and opens the
      book preview ("Will I like this?")
- [ ] Deny camera permission once → tap Scan again → in-app explanation +
      Settings deep link (no silent failure)

## 6. Library
- [ ] All four smart shelves render with correct counts
- [ ] Custom shelves render alongside; long-press → confirm-delete
- [ ] "+ New shelf" tile creates a shelf inline
- [ ] Long-press on a library row → ShelfPickerSheet opens; toggle membership
- [ ] Want-to-Read intent filter ("short fantasy", "fast paced") returns
      sensible matches; empty state distinguishes "no matches" vs "metadata
      limited"
- [ ] Gallery view + list view both scroll smoothly with safe-area padding
      below tab bar (no clipping on iPhone with home indicator)

## 7. Recommendations
- [ ] Open a finished book → "Recommend to a friend" button visible (sage)
- [ ] Open a non-finished book → button hidden
- [ ] Sheet loads accepted friends; "Already recommended" badges show
- [ ] Send → toast "Recommendation sent"; recipient sees it in RecsInboxSheet
- [ ] Native Share fallback opens iOS share sheet with `Title by Author`
- [ ] Zero-friends state shows "Add friends to send book recommendations"

## 8. Book detail
- [ ] Edition picker swaps cover + page count without losing current_page
- [ ] Reading-progress card: pause toggle persists (paused_at)
- [ ] Content warnings render with "may include" preface for broad-confidence
      labels; specific labels suppress their broad parent
- [ ] Bottom-sheet modals respect safe area (no content under home indicator)

## 9. Reading Progress / Stats
- [ ] Home dashboard streak flame pulses only when streak > 0
- [ ] Yearly-goal bar animates from 0 → live %
- [ ] Stats screen renders charts; no clipping behind nav bar
- [ ] Monthly / yearly Wrap → Share renders the JPG via native share sheet
      (no MediaLibrary write — Sharing.shareAsync only)

## 10. Settings / Account linking
- [ ] Sign-in methods section shows email + connected providers
- [ ] "Connect Google" from Settings uses link-callback route, returns to
      Settings (NOT home / onboarding)
- [ ] Linking with a different-email Google account: surfaces "wrong email"
      message and unlinks the bad identity
- [ ] Sign out → login screen; re-sign-in works

## Native module readiness (verified by static audit)
- expo-camera 55 — plugin configured with `cameraPermission` + explicit
  `NSCameraUsageDescription` in infoPlist (defense-in-depth)
- expo-apple-authentication 55 — `ios.usesAppleSignIn: true`
- expo-auth-session 55 + expo-web-browser 55 — Google OAuth via in-app browser
- expo-linking 55 — deep-link handler in `app/_layout.tsx`; `auth/callback`
  excluded so `socialAuth.ts` retains PKCE exchange ownership
- react-native-view-shot 4.0.3 + expo-sharing 55 — wrap screens render JPG
  and hand to native share sheet (no photo-library write)
- URL schemes registered: `readstack`, `bookappmobile` (legacy alias)

## When to ship a new iOS build (vs OTA update)
- **Fresh build required:** any change to `app.json` (`ios.*`, `plugins`,
  `scheme`), `eas.json`, native deps in `package.json`, or `Podfile`-affecting
  config.
- **OTA via dev:device:** any pure JS/TS change inside `app/`, `components/`,
  `lib/`.

