import { createContext, useContext, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import { ToastContainer } from '../components/Toast';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { clearAllTabCaches } from '../lib/tabCache';
import { readOnboardingStage, writeOnboardingStage } from '../lib/onboardingStage';
import { clearLocalOnboardingState } from '../lib/localStateClear';
import { ThemeProvider } from '../lib/theme/ThemeProvider';

// ─── Bootstrap context ─────────────────────────────────────────────────────────
// Exposes live session + needsOnboarding so child routes (especially
// app/auth/callback.tsx) can actively wait for bootstrap to resolve
// rather than relying solely on the routing guard.
// Also exposes passwordRecovery so the reset-password screen knows why
// the user is here and callback.tsx can route correctly after a reset link.

type BootstrapCtx = {
  session:              Session | null | undefined;
  needsOnboarding:      boolean | undefined;
  passwordRecovery:     boolean;
  clearPasswordRecovery: () => void;
};

export const BootstrapContext = createContext<BootstrapCtx>({
  session:              undefined,
  needsOnboarding:      undefined,
  passwordRecovery:     false,
  clearPasswordRecovery: () => {},
});
export const useBootstrap = () => useContext(BootstrapContext);

// ─── Onboarding bridge ────────────────────────────────────────────────────────
// Lets onboarding.tsx call completeOnboarding() to update needsOnboarding in
// the root layout BEFORE navigating away. Without this the routing guard sees
// needsOnboarding=true when segments changes and redirects back to /onboarding.

type OnboardingBridgeCtx = { completeOnboarding: () => void };
export const OnboardingBridgeContext = createContext<OnboardingBridgeCtx>({
  completeOnboarding: () => {},
});
export const useOnboardingBridge = () => useContext(OnboardingBridgeContext);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Reject after `ms` milliseconds so a hanging Supabase promise always
// surfaces in the try/catch rather than waiting forever.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[WARM_BOOT] ${label} timed out after ${ms / 1000}s`)),
        ms,
      ),
    ),
  ]);
}

async function ensureProfile(
  userId: string,
  email: string,
  firstName?: string | null,
  lastName?: string | null,
) {
  if (!supabase) return;
  const emailPrefix      = email.split('@')[0] || 'user';
  const idSuffix         = userId.replace(/-/g, '').slice(0, 6);
  const fallbackUsername = `${emailPrefix}_${idSuffix}`;

  const upsertData: Record<string, unknown> = { id: userId, username: fallbackUsername };
  if (firstName) upsertData.first_name = firstName;
  if (lastName)  upsertData.last_name  = lastName;

  await withTimeout(
    supabase.from('profiles').upsert(upsertData, { onConflict: 'id', ignoreDuplicates: true }),
    8000,
    'ensureProfile upsert',
  );
}

// Returns:
//   true  — DB row exists and onboarding_completed=true (returning user, done)
//   false — DB row exists with onboarding_completed=false, OR no row exists
//           (genuinely new user)
//   null  — DB call timed out or errored. Caller MUST apply a heuristic
//           (e.g. user.created_at age) before deciding which way to route,
//           otherwise a transient slowness sends existing users back through
//           onboarding.
async function checkOnboardingCompleted(userId: string): Promise<boolean | null> {
  if (!supabase) return false;

  // First attempt: 10s. Most cold PostgREST hits resolve within 2–3s; the
  // wider window absorbs occasional slow hops without surfacing a fallback.
  // On timeout/error we retry once with a tighter 3s window — if even that
  // fails, the network is genuinely degraded and we hand control back to
  // the caller's heuristic.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ms = attempt === 0 ? 10000 : 3000;
    try {
      const { data, error } = await withTimeout(
        supabase.from('profiles').select('onboarding_completed').eq('id', userId).maybeSingle(),
        ms,
        `checkOnboardingCompleted(attempt ${attempt + 1})`,
      );
      if (error) {
        console.warn('[WARM_BOOT] checkOnboardingCompleted DB error (attempt', attempt + 1, '):', error.message);
        // Real DB error (RLS, schema, etc.) — don't retry, return null so the
        // caller can fall back to the created_at heuristic.
        return null;
      }
      // maybeSingle returns data=null when no row exists (new user).
      return data?.onboarding_completed === true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[WARM_BOOT] checkOnboardingCompleted timed out (attempt', attempt + 1, '):', msg);
      // Loop to retry once; after the retry we fall through and return null.
    }
  }
  return null;
}

// Reads onboarding_completed from the JWT's app_metadata claim. Populated by a
// Postgres trigger (supabase/migrations/20260421000000_onboarding_jwt_claim.sql)
// that mirrors profiles.onboarding_completed → auth.users.raw_app_meta_data.
//
// IMPORTANT correctness note: a persisted JWT can be up to one refresh window
// stale. If the user finished onboarding and then closed the app before the
// next token refresh, the persisted JWT still carries
// onboarding_completed=false even though the DB row is true. We therefore
// treat ONLY a `true` claim as authoritative — it can only become true after
// the row was already true. A `false` claim (or missing claim) falls through
// to local stage / DB verification so a freshly-onboarded user is never
// dumped back into the onboarding flow on cold start.
//
// Returns:
//   true  — JWT claims onboarding is complete (safe fast-path)
//   null  — claim is `false` or missing; caller MUST verify via local stage /
//           DB / heuristic before deciding to send the user to onboarding.
function readOnboardingFromAppMetadata(session: Session): true | null {
  const claim = (session.user.app_metadata as { onboarding_completed?: unknown } | undefined)?.onboarding_completed;
  return claim === true ? true : null;
}

// Heuristic used whenever checkOnboardingCompleted returns null (DB unreachable).
// New accounts (created in the last 5 minutes) → treat as needing onboarding.
// Older accounts → treat as returning users so a transient DB slowness never
// dumps an established user back through the onboarding flow.
function needsOnboardingFromCreatedAt(createdAtIso: string | undefined | null): boolean {
  if (!createdAtIso) return false;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return false;
  const ageMs = Date.now() - createdMs;
  return ageMs < 5 * 60 * 1000;
}

// Brand-new account fast path: a user whose account was created seconds ago
// definitionally needs onboarding — there is no DB state worth checking
// because ensureProfile has not even run yet. This avoids the 10s+3s
// checkOnboardingCompleted wait on the most common Google-signup path on
// Android, where the just-signed-up user has:
//   - no profiles row yet (background upsert runs after routing)
//   - no app_metadata.onboarding_completed claim (trigger only sets true)
//   - no localStage (fresh install or post-sign-out wipe)
// The 60s window is intentionally tight: it only matches the just-completed
// SIGNED_IN event, never an established account.
function isFreshlyCreatedAccount(createdAtIso: string | undefined | null): boolean {
  if (!createdAtIso) return false;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return false;
  const ageMs = Date.now() - createdMs;
  // Reject negative ages (client clock skew/forward) — never treat a
  // "future-dated" account as fresh, that direction is always a bug.
  return ageMs >= 0 && ageMs < 60 * 1000;
}

// ─── Root layout ──────────────────────────────────────────────────────────────

export default function RootLayout() {
  const [session,          setSession]          = useState<Session | null | undefined>(undefined);
  const [needsOnboarding,  setNeedsOnboarding]  = useState<boolean | undefined>(undefined);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const router   = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (!supabase) {
      setSession(null);
      setNeedsOnboarding(false);
      return;
    }

    // ── Cold-start: hydrate session from persisted storage ─────────────────
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      console.log('[DELETE_TRACE] cold-start userId=', data.session?.user?.id?.slice(0, 8) ?? null);
      if (data.session) {
        const meta = data.session.user.user_metadata;
        const t0   = Date.now();

        // ── Fast path: JWT claim === true (zero DB round trip) ────────────
        // The Postgres trigger added in migration 20260421000000 mirrors
        // profiles.onboarding_completed into auth.users.raw_app_meta_data,
        // which Supabase serialises into the JWT as user.app_metadata.
        // We only treat `true` as authoritative — see readOnboardingFromAppMetadata
        // for why a stale `false` cannot be trusted on cold start.
        const jwtCompleted = readOnboardingFromAppMetadata(data.session);
        if (jwtCompleted === true) {
          console.log('[WARM_BOOT] cold-start JWT onboarding_completed=true in', Date.now() - t0, 'ms');
          setNeedsOnboarding(false);
          // Profile upsert in background — does not affect routing.
          ensureProfile(
            data.session.user.id,
            data.session.user.email ?? '',
            meta?.first_name,
            meta?.last_name,
          ).catch(e => console.warn('[WARM_BOOT] cold-start background ensureProfile error:', e));
          return;
        }

        // ── Brand-new account fast path on cold start ─────────────────────
        // If the persisted session belongs to an account created in the last
        // 60s (e.g. user signed up, app crashed/closed, reopened immediately)
        // skip the DB call — the answer is unambiguously needsOnboarding=true.
        //
        // CRITICAL: check localStage first. A user who finished onboarding
        // less than 60s ago and force-quits + reopens the app would have:
        //   - createdAt < 60s    (matches the fresh check)
        //   - JWT claim stale    (issued before completion, not refreshed)
        //   - localStage='done'  (they DID complete onboarding)
        // Without the local-stage gate the fresh path would wrongly send
        // them back through onboarding.
        if (isFreshlyCreatedAccount(data.session.user.created_at)) {
          const localStageEarly = await readOnboardingStage().catch(() => null);
          const earlyDone = localStageEarly === 'done'
            || localStageEarly === 'walkthrough'
            || localStageEarly === 'final_setup'
            || localStageEarly === 'intake_active';
          if (!earlyDone) {
            console.log('[WARM_BOOT] cold-start freshly-created account → needsOnboarding=true, skipping DB in', Date.now() - t0, 'ms');
            setNeedsOnboarding(true);
            ensureProfile(
              data.session.user.id,
              data.session.user.email ?? '',
              meta?.first_name,
              meta?.last_name,
            ).catch(e => console.warn('[WARM_BOOT] cold-start background ensureProfile error:', e));
            return;
          }
          console.log('[WARM_BOOT] cold-start fresh account but localStage=', localStageEarly, '— treating as returning user');
          setNeedsOnboarding(false);
          ensureProfile(
            data.session.user.id,
            data.session.user.email ?? '',
            meta?.first_name,
            meta?.last_name,
          ).catch(e => console.warn('[WARM_BOOT] cold-start background ensureProfile error:', e));
          return;
        }

        // ── Slow path: JWT claim absent or false (legacy/stale session) ───
        // Run ensureProfile and checkOnboardingCompleted in parallel so the
        // worst case is the slower of the two rather than the sum.
        const [, completed] = await Promise.all([
          ensureProfile(
            data.session.user.id,
            data.session.user.email ?? '',
            meta?.first_name,
            meta?.last_name,
          ).catch(e => {
            console.warn('[WARM_BOOT] cold-start ensureProfile error:', e);
            return null;
          }),
          checkOnboardingCompleted(data.session.user.id),
        ]);
        console.log('[DELETE_TRACE] cold-start DB onboarding_completed=', completed, 'in', Date.now() - t0, 'ms');
        if (completed === true) {
          console.log('[DELETE_TRACE] cold-start → needsOnboarding=false (DB says done)');
          setNeedsOnboarding(false);
        } else if (completed === false) {
          const localStage = await readOnboardingStage();
          const locallyDone = localStage === 'done';
          // 'intake_active' is mid-flow: the user started the genres intake but
          // didn't finish. Tabs layout (and the routing guard below) redirects
          // them back to /onboarding-questions to resume.
          const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup' || localStage === 'intake_active';
          console.log('[DELETE_TRACE] cold-start localStage=', localStage, '→ needsOnboarding=', !midFlow && !locallyDone);
          setNeedsOnboarding(!midFlow && !locallyDone);
        } else {
          // completed === null — DB unavailable. Trust local stage if conclusive,
          // otherwise fall back to the created_at heuristic so an established
          // user is never re-routed into onboarding by a transient slowness.
          const localStage = await readOnboardingStage();
          const locallyDone = localStage === 'done';
          const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup' || localStage === 'intake_active';
          if (locallyDone || midFlow) {
            console.warn('[WARM_BOOT] cold-start DB unavailable — local stage conclusive (', localStage, ') → needsOnboarding=false');
            setNeedsOnboarding(false);
          } else {
            const fallback = needsOnboardingFromCreatedAt(data.session.user.created_at);
            console.warn('[WARM_BOOT] cold-start DB unavailable — created_at heuristic → needsOnboarding=', fallback);
            setNeedsOnboarding(fallback);
          }
        }
      } else {
        setNeedsOnboarding(false);
      }
    });

    // ── Auth state listener ────────────────────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      // Handle both SIGNED_IN and USER_UPDATED (email confirmation can fire either
      // depending on Supabase version / PKCE configuration).
      if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && newSession) {
        console.log('[WARM_BOOT] onAuthStateChange SIGNED_IN — userId=', newSession.user.id.slice(0, 8));

        // ── CRITICAL: reset needsOnboarding to undefined BEFORE setSession ─
        // The routing guard bails when needsOnboarding===undefined, keeping the
        // user on the callback loading screen until bootstrap fully resolves.
        // Without this, the guard fires the moment setSession runs and races
        // against the DB calls with a potentially stale needsOnboarding value.
        setNeedsOnboarding(undefined);
        setSession(newSession);

        console.log('[WARM_BOOT] session state updated — bootstrap starting');

        // ── Wrap ALL async bootstrap work in try/catch ─────────────────────
        // If any DB call throws (RLS, network, trigger conflict from a freshly-
        // deleted row, etc.) the handler must NOT leave needsOnboarding===undefined
        // forever — that is the exact deadlock that hangs the callback screen.
        // Fallback: needsOnboarding=true sends the user to onboarding, which is
        // the correct safe default for any recreated or genuinely new account.
        try {
          // ── Critical path: route as soon as possible ──────────────────────
          //
          // Only AsyncStorage (≈10ms) is on the routing critical path.
          // Every DB operation has been moved off it:
          //
          //   localStage='done'        → returning user     → needsOnboarding=false (fast, no DB call)
          //   localStage='walkthrough' → mid-tour           → needsOnboarding=false (fast, no DB call)
          //   localStage='final_setup' → mid-import step    → needsOnboarding=false (fast, no DB call)
          //   localStage=null          → new OR signed-out  → check DB to distinguish
          //
          // After routing, ensureProfile runs in the background so the profile
          // row exists for subsequent app operations — it does not affect where
          // the user lands.
          //
          const t0          = Date.now();
          const localStage  = await withTimeout(readOnboardingStage(), 3000, 'readOnboardingStage');
          const locallyDone = localStage === 'done';
          // 'intake_active' is mid-flow (the user is partway through the genres
          // intake). Tabs layout's mount-stage switch routes them back to
          // /onboarding-questions on the next render.
          const midFlow     = localStage === 'walkthrough' || localStage === 'final_setup' || localStage === 'intake_active';

          if (locallyDone || midFlow) {
            // Fast path: local state is conclusive. No DB call needed.
            //   'done'         → returning user, normal app
            //   'walkthrough'  → mid-tour, tabs layout handles it
            //   'final_setup'  → mid-import step, tabs layout redirects
            console.log('[WARM_BOOT] localStage=', localStage, '→ needsOnboarding=false (fast path) in', Date.now() - t0, 'ms');
            setNeedsOnboarding(false);
          } else {
            // localStage === null.
            //
            // Two cases that look identical locally:
            //   A) Genuinely new user (first sign-in on any device)
            //   B) Returning user who signed out — clearLocalOnboardingState()
            //      wiped readstack_onboarding_stage_v1 on sign-out.
            //
            // Without disambiguation, case B always re-triggers onboarding.
            // First try the JWT app_metadata claim (zero round trip). Only a
            // `true` claim is treated as authoritative — a stale `false`
            // could be carried by a session issued before the user finished
            // onboarding (see readOnboardingFromAppMetadata).
            const jwtCompleted = readOnboardingFromAppMetadata(newSession);
            if (jwtCompleted === true) {
              writeOnboardingStage('done').catch(() => {});
              console.log('[WARM_BOOT] JWT confirmed complete — needsOnboarding=false, local stage repaired in', Date.now() - t0, 'ms');
              setNeedsOnboarding(false);
              // Background profile upsert; routing already resolved.
              const meta = newSession.user.user_metadata;
              ensureProfile(
                newSession.user.id,
                newSession.user.email ?? '',
                meta?.first_name,
                meta?.last_name,
              ).catch(e => console.warn('[WARM_BOOT] background ensureProfile error:', e));
              return;
            }
            // Brand-new account fast path: account created in the last 60s.
            // The DB lookup is guaranteed to return either no row (profile
            // upsert hasn't run yet) or onboarding_completed=false — both
            // mean needsOnboarding=true. Skip the (potentially 13s) DB call
            // and route immediately. This is the dominant Google-signup
            // path on Android and was the source of the long wait.
            if (isFreshlyCreatedAccount(newSession.user.created_at)) {
              console.log('[WARM_BOOT] freshly-created account (<60s) → needsOnboarding=true, skipping DB in', Date.now() - t0, 'ms');
              setNeedsOnboarding(true);
              const meta = newSession.user.user_metadata;
              ensureProfile(
                newSession.user.id,
                newSession.user.email ?? '',
                meta?.first_name,
                meta?.last_name,
              ).catch(e => console.warn('[WARM_BOOT] background ensureProfile error:', e));
              return;
            }

            // JWT claim absent or false. Fall back to a DB lookup so a
            // freshly-onboarded user with a stale session is not dumped
            // back into onboarding.
            console.log('[WARM_BOOT] localStage=null + JWT not authoritative — checking DB to distinguish new vs returning user');
            const completed = await checkOnboardingCompleted(newSession.user.id);
            if (completed === true) {
              // Returning user: repair local stage so future sign-ins stay on
              // the fast path and skip this DB call.
              writeOnboardingStage('done').catch(() => {});
              console.log('[WARM_BOOT] DB confirmed complete — needsOnboarding=false, local stage repaired in', Date.now() - t0, 'ms');
              setNeedsOnboarding(false);
            } else if (completed === false) {
              console.log('[WARM_BOOT] DB: onboarding not complete — needsOnboarding=true (new user) in', Date.now() - t0, 'ms');
              setNeedsOnboarding(true);
            } else {
              // completed === null — DB call timed out or errored after retry.
              // Apply the created_at heuristic instead of defaulting to true,
              // which would wrongly send established users back to onboarding.
              const fallback = needsOnboardingFromCreatedAt(newSession.user.created_at);
              console.warn('[WARM_BOOT] DB unavailable — created_at heuristic (account ageMs=',
                Date.now() - Date.parse(newSession.user.created_at ?? ''),
                ') → needsOnboarding=', fallback, 'in', Date.now() - t0, 'ms');
              // If the heuristic decided the user is returning, repair local
              // stage so the next sign-in stays on the fast path.
              if (!fallback) writeOnboardingStage('done').catch(() => {});
              setNeedsOnboarding(fallback);
            }
          }

          // ── Background: upsert profile row (non-blocking) ─────────────────
          const meta = newSession.user.user_metadata;
          ensureProfile(
            newSession.user.id,
            newSession.user.email ?? '',
            meta?.first_name,
            meta?.last_name,
          ).catch(e => console.warn('[WARM_BOOT] background ensureProfile error:', e));

          console.log('[WARM_BOOT] routing guard fired — profile upsert running in background');

        } catch (err) {
          // Any throw here previously left needsOnboarding===undefined forever,
          // hanging the callback screen indefinitely. We always resolve — but
          // the resolution uses the created_at heuristic rather than blindly
          // defaulting to true, so an established user is not dumped back into
          // onboarding when something transient (e.g. AsyncStorage hiccup, a
          // late DB error not caught by checkOnboardingCompleted) blows up the
          // bootstrap path.
          const msg      = err instanceof Error ? err.message : String(err);
          const fallback = needsOnboardingFromCreatedAt(newSession.user.created_at);
          console.error('[WARM_BOOT] bootstrap threw — created_at heuristic → needsOnboarding=', fallback, 'msg=', msg);
          setNeedsOnboarding(fallback);
        }

      } else if (event === 'PASSWORD_RECOVERY' && newSession) {
        // User arrived via a password-reset email link.
        // Set session so they're authenticated, mark passwordRecovery=true so the
        // routing guard routes them to /reset-password instead of the main app,
        // and set needsOnboarding=false (they're an existing user).
        console.log('[WARM_BOOT] PASSWORD_RECOVERY — routing to /reset-password');
        setPasswordRecovery(true);
        setSession(newSession);
        setNeedsOnboarding(false);

      } else if (event === 'SIGNED_OUT') {
        setSession(newSession);
        console.log('[DELETE_TRACE] SIGNED_OUT — clearing local state');
        setNeedsOnboarding(false);
        setPasswordRecovery(false);
        clearAllTabCaches();
        await clearLocalOnboardingState();
        const stageAfter = await readOnboardingStage();
        console.log('[DELETE_TRACE] cleared keys complete — stage=', stageAfter, '(expect null)');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Deep link handler — processes readstack://auth/callback URLs ────────────
  // Handles two scenarios:
  //   1. Cold start: app was closed when the user tapped a link in email
  //   2. Foreground: app was open when the link was tapped
  // Both email confirmation and password reset redirect here.
  // PKCE flow delivers a `code`; implicit fallback delivers access/refresh tokens.

  useEffect(() => {
    if (!supabase) return;

    async function handleAuthUrl(url: string) {
      if (!supabase || !url) return;

      // auth/callback URLs are handled by the dedicated route at
      // app/auth/callback.tsx — skip here to avoid double-processing
      // the one-time-use PKCE code.
      if (url.includes('auth/callback')) return;

      // Only process other auth deep links below (currently unused, but
      // kept as the canonical place for future deep link types).
      if (!url.includes('auth/')) return;

      console.log('[DeepLink] auth URL received:', url);

      try {
        const parsed = Linking.parse(url);
        const params = parsed.queryParams ?? {};

        // Surface any provider error before attempting token exchange
        const errorParam = params['error'] ?? params['error_description'];
        if (errorParam) {
          console.warn('[DeepLink] auth error in URL:', errorParam);
          return;
        }

        // Implicit flow fallback: tokens delivered directly in query params
        // (PKCE codes are handled inside app/auth/callback.tsx, not here)
        const access_token  = params['access_token']  as string | undefined;
        const refresh_token = params['refresh_token'] as string | undefined;
        if (access_token && refresh_token) {
          console.log('[DeepLink] implicit tokens found — setting session');
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          if (error) console.warn('[DeepLink] setSession error:', error.message);
          return;
        }

        console.warn('[DeepLink] auth URL had no usable params:', url);
      } catch (err) {
        console.warn('[DeepLink] error processing URL:', err);
      }
    }

    // Cold-start: handle the URL that launched the app (if any)
    Linking.getInitialURL().then(url => {
      if (url) handleAuthUrl(url);
    });

    // Foreground: handle URLs received while the app is running
    const sub = Linking.addEventListener('url', ({ url }) => handleAuthUrl(url));

    return () => sub.remove();
  }, []);

  // ── Routing guard ──────────────────────────────────────────────────────────
  // Fires whenever session, segments, needsOnboarding, or passwordRecovery changes.
  // Bails when session/needsOnboarding are undefined (still bootstrapping).
  // Note: the callback route handles its own navigation via BootstrapContext;
  // this guard acts as a safety net for other routes.

  useEffect(() => {
    if (session === undefined || needsOnboarding === undefined) return;

    // '(auth)' = login/signup screens; 'auth' = the auth/callback route group.
    // Both must be treated as "in auth" so the session guard does not redirect
    // while the callback screen is exchanging a PKCE code (no session yet).
    const seg0         = segments[0] as string;
    const seg1         = segments[1] as string | undefined;
    // /auth/link-callback is special: it's the post-OAuth landing page for
    // identity linking initiated from Settings. The user is ALREADY signed in
    // when they get there and the screen self-routes back to /settings. We
    // must NOT treat it as part of the sign-in `inAuth` bucket — otherwise
    // the safety-net branch below force-redirects authenticated users to
    // `/(tabs)`, which surfaces as the "normal login/profile-loading page"
    // bug after Connect Google. Excluding it here lets link-callback do its
    // own navigation in peace.
    const inLinkCallback = seg0 === 'auth' && seg1 === 'link-callback';
    const inAuth       = (seg0 === '(auth)' || seg0 === 'auth') && !inLinkCallback;
    // Treat /onboarding-* as part of the onboarding flow so the guard
    // never evicts the user mid-step.
    const inOnboarding = seg0 === 'onboarding' || seg0 === 'onboarding-import' || seg0 === 'onboarding-questions';
    // /reset-password is a protected route only reachable after a PASSWORD_RECOVERY event.
    const inResetPw    = seg0 === 'reset-password';

    console.log('[ROOT_GUARD] check', {
      segments: seg0,
      session:         !!session,
      needsOnboarding,
      passwordRecovery,
      inAuth,
      inOnboarding,
      inResetPw,
    });

    // ── Password recovery: highest-priority routing ─────────────────────────
    // When in PASSWORD_RECOVERY state, always route to /reset-password
    // regardless of which screen the user is currently on.
    if (passwordRecovery) {
      if (!inResetPw) {
        console.log('[ROOT_GUARD] passwordRecovery=true → /reset-password');
        router.replace('/reset-password');
      }
      return;
    }

    // ── Normal flows ────────────────────────────────────────────────────────
    if (session && inAuth) {
      // callback.tsx drives its own navigation via BootstrapContext;
      // the guard mirrors the same decision here as a safety net.
      if (needsOnboarding) {
        console.log('[ROOT_GUARD] session+inAuth → /onboarding');
        router.replace('/onboarding');
      } else {
        console.log('[ROOT_GUARD] session+inAuth → /');
        router.replace('/');
      }
    } else if (session && needsOnboarding && !inAuth && !inOnboarding) {
      console.log('[ROOT_GUARD] → route=/onboarding (guard redirect)');
      router.replace('/onboarding');
    } else if (!session && !inAuth && !inResetPw && !inLinkCallback) {
      // Skip link-callback too: a cold deep-link with ?code= can land here
      // before Supabase finishes rehydrating the session. The link-callback
      // screen owns its own redirect to /settings; bouncing to /login here
      // would dump the user out mid-exchange.
      console.log('[ROOT_GUARD] no session — redirecting to /login (segments:', seg0, ')');
      router.replace('/login');
    }
  }, [session, segments, needsOnboarding, passwordRecovery]);

  return (
    <ThemeProvider>
      <BootstrapContext.Provider value={{
        session,
        needsOnboarding,
        passwordRecovery,
        clearPasswordRecovery: () => setPasswordRecovery(false),
      }}>
        <OnboardingBridgeContext.Provider value={{ completeOnboarding: () => setNeedsOnboarding(false) }}>
          <View style={{ flex: 1 }}>
            <Stack screenOptions={{ headerShown: false }} />
            <ToastContainer />
          </View>
        </OnboardingBridgeContext.Provider>
      </BootstrapContext.Provider>
    </ThemeProvider>
  );
}
