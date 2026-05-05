# Device Testing Workflow

Fastest path to test JS changes on a real Android phone (and iOS) without rebuilding every time.

---

## TL;DR — when to do what

| Change you made                                 | Action                                  | Wait time |
|-------------------------------------------------|-----------------------------------------|-----------|
| TS / TSX / JS / styles / images bundled in JS   | Save → reload dev client (no rebuild)   | 1–3 s     |
| `package.json` JS-only dep added                | Save → reload dev client                | 1–3 s     |
| `package.json` **native** dep added/removed     | New **development build**               | ~10–15 m  |
| New entry in `app.json` `plugins`               | New **development build**               | ~10–15 m  |
| `app.json` permissions / scheme / bundle ID     | New **development build**               | ~10–15 m  |
| Want to share with a non-dev tester (Android)   | New **preview build**                   | ~10–15 m  |
| Ship to App Store testers (iOS)                 | New **TestFlight (beta) build**         | ~15–25 m  |

Rule of thumb: **JS-only change → reload. Anything that touches native code or `app.json` plugins/permissions → rebuild.**

---

## Audit (current state, October 2026)

1. **Valid Android development build profile?** Yes. `eas.json → build.development` is configured with `developmentClient: true`, `distribution: internal`, `channel: development`, APK output. Good for sideloading on a test phone.
2. **Does the dev build include all required native modules?** Now yes. `expo-camera` was missing from `app.json → plugins`, which meant the dev build had no `CAMERA` permission and the scan screen could not request it on Android. Fixed in this commit. Other native deps (`expo-apple-authentication`, `expo-router`, `expo-dev-client`, `expo-updates`, `expo-sharing`, `expo-camera`, `expo-haptics`, `expo-clipboard`, `expo-file-system`, `expo-document-picker`, `expo-web-browser`, `expo-auth-session`, `expo-linking`, `expo-linear-gradient`, `expo-status-bar`, `expo-constants`, `react-native-safe-area-context`, `react-native-screens`, `react-native-view-shot`, `react-native-webview`, `@react-native-async-storage/async-storage`) either need no plugin entry (autolinked) or are already registered. **You must rebuild the dev APK once after this change so the camera plugin is included.**
3. **Serve the latest JS bundle from Replit:** `npm run dev:device` (tunnel — works across networks) or `npm run dev:device:lan` (faster, requires phone + Replit on the same network).
4. **Open the dev build on your phone:** install the dev APK once (see below), launch it, and either scan the QR shown by Metro or paste the `exp+bookappmobile://…` URL into the dev client's "Enter URL manually" box. Metro will push the latest bundle.
5. **Verify the phone is on the latest JS:** in the dev client, shake the device → Dev Menu → "Reload". The JS bundle redownloads from your Replit Metro server. The Metro terminal will print `BUNDLE ./node_modules/expo-router/entry.js` followed by the timestamp. If you want a hard check, edit a visible string (e.g. the title in `app/(tabs)/index.tsx`), save, reload — the new string should appear within seconds.
6. **When do you need a new development build?** Only when you change native code: a new native module in `package.json`, a new entry in `app.json → plugins`, a permission/scheme change, a bundle identifier change, or an SDK upgrade.
7. **When do you need a new preview build?** When you want a non-developer to test a build that does NOT need a Metro server (preview builds embed a snapshot of the JS). Useful for stakeholder demos and any time you cannot ask the tester to run `npm run dev:device`.
8. **When do you need a new iOS TestFlight build?** Only for App Store-distributed testing on iOS, or when you change anything native on iOS (same trigger list as #6).

---

## Android — fast iteration loop

### One-time setup (rebuild the APK after any native/plugin change)

```bash
# Build the dev APK — produces a downloadable .apk you sideload once.
npm run build:android:dev
# eas will print a URL when done — open it on the phone, install the APK,
# allow installs from unknown sources if prompted.
```

### Every-day loop (JS changes only)

1. From Replit shell:
   ```bash
   npm run dev:device          # tunnel — works on cellular + cross-network
   # OR, if your phone and Replit are on the same Wi-Fi:
   npm run dev:device:lan      # lower latency
   ```
2. Open the **Readstack (dev)** app on your phone.
3. Tap "Scan QR code" on the dev client launcher and scan the QR Metro printed in the Replit terminal. (First connection only — after that, the dev client remembers the URL and you can just tap "Recently opened".)
4. Edit any `.ts`/`.tsx` file in Replit, save, the bundle hot-reloads. If hot reload glitches, shake the phone → Reload.

### Verify you're on the latest JS

- Shake → Dev Menu shows the bundle URL pointing at your Replit Metro instance.
- In Metro's terminal output, every reload prints a fresh `Web Bundled NNNms` (or `Android Bundled`) line with the current timestamp.
- Smoke test: change one visible string, save, reload — the change shows in 1–3 s.

---

## Android — preview builds (for non-dev testers)

Preview builds bundle the JS at build time. The tester does NOT run Metro.

```bash
npm run build:android:preview
# Send the resulting APK URL to your tester. They install it the same way
# as the dev APK. No Replit dev server needed.
```

To **update** an existing preview install without rebuilding native code, push a JS-only OTA update on the `preview` channel:

```bash
npm run update:preview
# Tester reopens the app — it pulls the new JS at startup.
```

OTA only works for JS-only changes. Anything native (new plugin, new module, permission change) requires a fresh `build:android:preview`.

---

## iOS — TestFlight loop

```bash
# 1. Build the iOS .ipa using the beta profile (auto-increments build number).
npm run build:ios:beta

# 2. Submit it to App Store Connect / TestFlight.
npm run submit:ios:beta
```

`appleTeamId` and `ascAppId` are already configured in `eas.json → submit.beta.ios`. TestFlight takes 5–15 minutes to process the build, then your testers get a notification.

For JS-only iterations on iOS in development, the same `npm run dev:device` works — open the iOS dev client (separate one-time `eas build --profile development --platform ios` is required first, run from your Mac because iOS dev builds need a provisioned simulator or device).

---

## Decision tree

```
Did you change anything in app.json `plugins`, `permissions`, `scheme`,
or add/remove a native module in package.json?
├── YES → Rebuild
│        ├── Android dev:        npm run build:android:dev
│        ├── Android preview:    npm run build:android:preview
│        └── iOS TestFlight:     npm run build:ios:beta && npm run submit:ios:beta
│
└── NO → Reload (no rebuild)
         ├── On your dev phone:  npm run dev:device  → shake → Reload
         └── On a tester's preview build: npm run update:preview
```

---

## Common pitfalls

- **"My phone isn't picking up the change"** — you're probably looking at the embedded bundle from a preview/release build. The dev client must show a Metro URL in its launcher. If it shows "No connection", restart `npm run dev:device` and re-scan the QR.
- **"Camera doesn't work on my dev build"** — you're on the pre-fix dev APK without the `expo-camera` plugin. Run `npm run build:android:dev` again.
- **"Metro won't start"** — clear Metro cache: `npx expo start --dev-client --tunnel --clear`.
- **"Tunnel is slow"** — switch to `npm run dev:device:lan` (requires same network).
- **"Auth deep links don't return to the app"** — confirm the `readstack://auth/callback` and `readstack://auth/link-callback` URLs are in the Supabase dashboard's redirect allow-list (see `docs/google-signin.md`).
