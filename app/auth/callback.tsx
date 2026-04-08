/**
 * app/auth/callback.tsx
 *
 * Diagnostic-first auth callback screen.
 * Renders a Bootstrap Diagnostic panel from the very first frame with
 * individual substep rows so we can see exactly which step hangs.
 *
 * Layout: plain View(flex:1) → fixed header + ScrollView body.
 * Never uses ScrollView+justifyContent:center (clips content on Android).
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { readOnboardingStage } from '../../lib/onboardingStage';
import { useBootstrap } from '../_layout';

// ─── Module-level mount counter ──────────────────────────────────────────────
let _mountCount = 0;

// ─── Types ────────────────────────────────────────────────────────────────────
type S = 'pending' | 'ok' | 'fail' | 'skip';

type DiagState = {
  codeExchange:           S;
  sessionLive:            S;
  preProfile:             S;
  ensureProfile:          S;
  checkOnboardingCompleted: S;
  localStage:             S;
  needsOnboarding:        S;
  routeDecision:          string;
  lastError:              string | null;
  timerElapsed:           number;
  mountCount:             number;
  stalled:                boolean;
};

const INIT: DiagState = {
  codeExchange:             'pending',
  sessionLive:              'pending',
  preProfile:               'pending',
  ensureProfile:            'pending',
  checkOnboardingCompleted: 'pending',
  localStage:               'pending',
  needsOnboarding:          'pending',
  routeDecision:            'pending',
  lastError:                null,
  timerElapsed:             0,
  mountCount:               0,
  stalled:                  false,
};

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

// ─── DiagRow ──────────────────────────────────────────────────────────────────
function DiagRow({ label, value }: { label: string; value: string }) {
  const isOk   = value === 'ok';
  const isBad  = value === 'fail';
  const isSkip = value === 'skip';
  const color  = isOk ? '#15803d' : isBad ? '#dc2626' : isSkip ? '#b45309' : '#1c1917';
  return (
    <View style={{
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingVertical: 8, paddingHorizontal: 12,
      borderBottomWidth: 1, borderBottomColor: '#e7e5e4', minHeight: 36,
    }}>
      <Text style={{ fontSize: 13, color: '#44403c', fontFamily: 'monospace', flex: 1 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: '800', color, fontFamily: 'monospace' }}>
        {value}
      </Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function AuthCallbackScreen() {
  const { code }  = useLocalSearchParams<{ code?: string }>();
  const router    = useRouter();
  const { session, needsOnboarding: ctxOnboarding } = useBootstrap();

  const [diag,     setDiag]     = useState<DiagState>(INIT);
  const [retrying, setRetrying] = useState(false);

  const navigatedRef  = useRef(false);
  const probeStarted  = useRef(false);

  // ── Mount / unmount ─────────────────────────────────────────────────────────
  useEffect(() => {
    _mountCount += 1;
    console.log('[WARM_BOOT] callback mounted count=', _mountCount);
    setDiag(d => ({ ...d, mountCount: _mountCount }));
    return () => console.log('[WARM_BOOT] callback unmounted count=', _mountCount);
  }, []);

  // ── 1-second elapsed ticker ─────────────────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() =>
      setDiag(d => ({ ...d, timerElapsed: d.timerElapsed + 1 })), 1000);
    return () => clearInterval(iv);
  }, []);

  // ── 15-second stall marker ──────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      if (navigatedRef.current) return;
      console.warn('[WARM_BOOT] overall 15s timeout fired — bootstrap never completed');
      setDiag(d => ({
        ...d,
        stalled:   true,
        lastError: d.lastError ?? 'Bootstrap did not complete within 15 s',
      }));
    }, 15000);
    return () => clearTimeout(t);
  }, []);

  // ── Phase A: code exchange (only when `code` param is present) ─────────────
  useEffect(() => {
    if (!supabase) {
      setDiag(d => ({ ...d, codeExchange: 'fail', lastError: 'Supabase client not configured' }));
      return;
    }
    if (!code) {
      // No code param — Supabase SDK may have already handled the exchange
      // via the deep-link handler in _layout.tsx. Mark as skip; we'll
      // update to ok once session arrives via auth listener.
      console.log('[WARM_BOOT] no code param — exchange will come via auth listener');
      setDiag(d => ({ ...d, codeExchange: 'skip' }));
      return;
    }

    console.log('[WARM_BOOT] exchangeCodeForSession start — code=', code.slice(0, 8) + '…');
    withTimeout(
      supabase.auth.exchangeCodeForSession(code),
      10000,
      'exchangeCodeForSession',
    )
      .then(({ data, error: err }) => {
        if (err) {
          console.warn('[WARM_BOOT] exchangeCodeForSession failed:', err.message);
          setDiag(d => ({ ...d, codeExchange: 'fail', lastError: err.message }));
          return;
        }
        const uid = data.session?.user?.id ?? 'none';
        console.log('[WARM_BOOT] exchangeCodeForSession success — userId=', uid.slice(0, 8));
        setDiag(d => ({ ...d, codeExchange: 'ok' }));
      })
      .catch((e: Error) => {
        console.warn('[WARM_BOOT] exchangeCodeForSession threw:', e.message);
        setDiag(d => ({ ...d, codeExchange: 'fail', lastError: e.message }));
      });
  }, [code]);

  // ── Phase B: session arrives (via either path) → run substep probe ─────────
  useEffect(() => {
    if (session === undefined) return; // still bootstrapping

    if (session === null) {
      console.warn('[WARM_BOOT] session resolved to null');
      setDiag(d => ({
        ...d,
        sessionLive: 'fail',
        codeExchange: d.codeExchange === 'pending' ? 'fail' : d.codeExchange,
        lastError: d.lastError ?? 'No session after auth event',
      }));
      return;
    }

    // session is active — if codeExchange was skip/pending, the auth listener
    // handled the exchange; treat it as ok.
    setDiag(d => ({
      ...d,
      sessionLive:  'ok',
      codeExchange: d.codeExchange === 'pending' || d.codeExchange === 'skip' ? 'ok' : d.codeExchange,
    }));

    if (probeStarted.current) return;
    probeStarted.current = true;
    runProbe(session.user.id);
  }, [session]);

  // ── Phase C: BootstrapContext needsOnboarding resolved ────────────────────
  // Mirror it to diag. If the probe already navigated, ignore.
  useEffect(() => {
    if (ctxOnboarding === undefined) return;
    const val: S = ctxOnboarding ? 'ok' : 'fail'; // ok means "needs onboarding"
    setDiag(d => ({ ...d, needsOnboarding: val }));
  }, [ctxOnboarding]);

  // ── Probe: run each bootstrap substep with individual timeouts ─────────────
  async function runProbe(userId: string) {
    if (!supabase) {
      setDiag(d => ({ ...d, lastError: 'Supabase client not configured' }));
      return;
    }

    // ── preProfile ────────────────────────────────────────────────────────────
    let preProfileData: { id: string; onboarding_completed: boolean | null } | null = null;
    try {
      console.log('[WARM_BOOT] preProfile start');
      const res = await withTimeout(
        supabase.from('profiles').select('id, onboarding_completed').eq('id', userId).maybeSingle(),
        8000,
        'preProfile',
      );
      console.log('[WARM_BOOT] preProfile result data=', res.data, 'error=', res.error?.message ?? null);
      if (res.error) {
        setDiag(d => ({ ...d, preProfile: 'fail', lastError: 'preProfile: ' + res.error!.message }));
        return;
      }
      preProfileData = res.data;
      setDiag(d => ({ ...d, preProfile: 'ok' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[WARM_BOOT] preProfile threw:', msg);
      setDiag(d => ({ ...d, preProfile: 'fail', lastError: msg }));
      return;
    }

    // ── ensureProfile (upsert) ────────────────────────────────────────────────
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const meta            = s?.user?.user_metadata ?? {};
      const emailPrefix     = (s?.user?.email ?? '').split('@')[0] || 'user';
      const idSuffix        = userId.replace(/-/g, '').slice(0, 6);
      const fallbackUsername = `${emailPrefix}_${idSuffix}`;
      const upsertData: Record<string, unknown> = { id: userId, username: fallbackUsername };
      if (meta.first_name) upsertData.first_name = meta.first_name;
      if (meta.last_name)  upsertData.last_name  = meta.last_name;

      console.log('[WARM_BOOT] ensureProfile start');
      const res = await withTimeout(
        supabase.from('profiles').upsert(upsertData, { onConflict: 'id', ignoreDuplicates: true }),
        8000,
        'ensureProfile',
      );
      console.log('[WARM_BOOT] ensureProfile result data=', res.data, 'error=', res.error?.message ?? null);
      if (res.error) {
        setDiag(d => ({ ...d, ensureProfile: 'fail', lastError: 'ensureProfile: ' + res.error!.message }));
        // don't return — try to continue; upsert may fail on recreated rows
      } else {
        setDiag(d => ({ ...d, ensureProfile: 'ok' }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[WARM_BOOT] ensureProfile threw:', msg);
      setDiag(d => ({ ...d, ensureProfile: 'fail', lastError: msg }));
      // don't return — try to proceed
    }

    // ── checkOnboardingCompleted ──────────────────────────────────────────────
    let onboardingDoneDB = false;
    try {
      console.log('[WARM_BOOT] checkOnboardingCompleted start');
      const res = await withTimeout(
        supabase.from('profiles').select('onboarding_completed').eq('id', userId).maybeSingle(),
        8000,
        'checkOnboardingCompleted',
      );
      console.log('[WARM_BOOT] checkOnboardingCompleted result data=', res.data, 'error=', res.error?.message ?? null);
      if (res.error) {
        setDiag(d => ({ ...d, checkOnboardingCompleted: 'fail', lastError: 'checkOnboarding: ' + res.error!.message }));
      } else {
        onboardingDoneDB = res.data?.onboarding_completed === true;
        setDiag(d => ({ ...d, checkOnboardingCompleted: 'ok' }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[WARM_BOOT] checkOnboardingCompleted threw:', msg);
      setDiag(d => ({ ...d, checkOnboardingCompleted: 'fail', lastError: msg }));
      // continue — fall through to localStage
    }

    // ── localStage ────────────────────────────────────────────────────────────
    let locallyDone = false;
    let midFlow     = false;
    try {
      console.log('[WARM_BOOT] localStage start');
      const stage = await withTimeout(readOnboardingStage(), 3000, 'localStage');
      console.log('[WARM_BOOT] localStage result', stage);
      locallyDone = stage === 'done';
      midFlow     = stage === 'walkthrough' || stage === 'final_setup';
      setDiag(d => ({ ...d, localStage: 'ok' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[WARM_BOOT] localStage threw:', msg);
      setDiag(d => ({ ...d, localStage: 'fail', lastError: msg }));
      // continue — default to needs onboarding
    }

    // ── needsOnboarding + routeDecision ───────────────────────────────────────
    const needsOb = !onboardingDoneDB && !locallyDone && !midFlow;
    const route   = needsOb ? '/onboarding' : '/';
    console.log('[WARM_BOOT] routeDecision result needsOnboarding=', needsOb, 'route=', route);

    setDiag(d => ({
      ...d,
      needsOnboarding: needsOb ? 'ok' : 'fail', // ok = "yes, needs onboarding"
      routeDecision:   route,
    }));

    // Navigate (if not already done by BootstrapContext path)
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    console.log('[WARM_BOOT] probe routing to', route);
    router.replace(route as '/onboarding' | '/');
  }

  // ── Retry: re-run probe from scratch ────────────────────────────────────────
  async function handleRetry() {
    if (!supabase) return;
    setRetrying(true);
    probeStarted.current = false;
    navigatedRef.current = false;
    setDiag(d => ({
      ...INIT,
      codeExchange: d.codeExchange, // preserve what we know
      sessionLive:  d.sessionLive,
      timerElapsed: d.timerElapsed,
      mountCount:   d.mountCount,
    }));
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        probeStarted.current = true;
        setDiag(d => ({ ...d, sessionLive: 'ok', codeExchange: d.codeExchange === 'pending' ? 'ok' : d.codeExchange }));
        await runProbe(data.session.user.id);
      } else {
        setDiag(d => ({ ...d, sessionLive: 'fail', lastError: 'Retry: no active session' }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDiag(d => ({ ...d, lastError: 'Retry threw: ' + msg }));
    }
    setRetrying(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f7' }}>

      {/* Fixed header ──────────────────────────────────────────────────────── */}
      <View style={{
        backgroundColor:   diag.stalled ? '#fef2f2' : '#faf9f7',
        paddingTop:        72,
        paddingBottom:     20,
        alignItems:        'center',
        borderBottomWidth: 2,
        borderBottomColor: diag.stalled ? '#fca5a5' : '#d6d3d1',
      }}>
        <ActivityIndicator size="large" color={diag.stalled ? '#dc2626' : '#1c1917'} />
        <Text style={{
          fontSize: 16, fontWeight: '700', marginTop: 12,
          color: diag.stalled ? '#dc2626' : '#1c1917', letterSpacing: -0.3,
        }}>
          {diag.stalled ? 'STALLED — see below' : 'Signing you in…'}
        </Text>
        <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 4, letterSpacing: 0.2 }}>
          DEBUG: auth-callback-diag-v1
        </Text>
      </View>

      {/* Scrollable diagnostic body ────────────────────────────────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >

        {/* Diagnostic panel */}
        <View style={{
          backgroundColor: '#ffffff',
          borderRadius: 10, borderWidth: 2, borderColor: '#1c1917',
          overflow: 'hidden', marginBottom: 14,
        }}>
          <View style={{ backgroundColor: '#1c1917', paddingVertical: 6, paddingHorizontal: 12 }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: '#fff', letterSpacing: 0.8, textTransform: 'uppercase' }}>
              Bootstrap Diagnostic
            </Text>
          </View>
          <DiagRow label="codeExchange"            value={diag.codeExchange} />
          <DiagRow label="session"                 value={diag.sessionLive} />
          <DiagRow label="preProfile"              value={diag.preProfile} />
          <DiagRow label="ensureProfile"           value={diag.ensureProfile} />
          <DiagRow label="checkOnboardingDone"     value={diag.checkOnboardingCompleted} />
          <DiagRow label="localStage"              value={diag.localStage} />
          <DiagRow label="needsOnboarding"         value={diag.needsOnboarding} />
          <DiagRow label="routeDecision"           value={diag.routeDecision} />
          <DiagRow label="timerElapsed"            value={diag.timerElapsed + 's'} />
          <DiagRow label="mountCount"              value={String(diag.mountCount)} />
        </View>

        {/* lastError — always rendered */}
        <View style={{
          backgroundColor: diag.lastError ? '#fef2f2' : '#f5f5f4',
          borderRadius: 8, padding: 12, marginBottom: 18,
          borderWidth: 1, borderColor: diag.lastError ? '#fca5a5' : '#e7e5e4',
          minHeight: 52,
        }}>
          <Text style={{ fontSize: 11, fontWeight: '800', marginBottom: 3,
            color: diag.lastError ? '#991b1b' : '#a8a29e' }}>
            lastError
          </Text>
          <Text style={{ fontSize: 11, lineHeight: 16, fontFamily: 'monospace',
            color: diag.lastError ? '#b91c1c' : '#a8a29e' }}>
            {diag.lastError ?? 'none'}
          </Text>
        </View>

        {/* Retry */}
        <TouchableOpacity
          onPress={handleRetry} disabled={retrying}
          style={{
            backgroundColor: '#1c1917', borderRadius: 10,
            paddingVertical: 15, alignItems: 'center',
            marginBottom: 10, opacity: retrying ? 0.55 : 1,
          }}
        >
          {retrying
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Retry</Text>}
        </TouchableOpacity>

        {/* Back to sign in */}
        <TouchableOpacity
          onPress={() => router.replace('/login')}
          style={{
            borderWidth: 2, borderColor: '#1c1917',
            borderRadius: 10, paddingVertical: 15,
            alignItems: 'center', marginBottom: 10,
          }}
        >
          <Text style={{ color: '#1c1917', fontSize: 15, fontWeight: '700' }}>Back to sign in</Text>
        </TouchableOpacity>

        {/* Debug fallback */}
        <TouchableOpacity
          onPress={() => {
            console.warn('[WARM_BOOT] debug-forced navigation to /onboarding');
            navigatedRef.current = true;
            router.replace('/onboarding');
          }}
          style={{
            borderWidth: 2, borderColor: '#d97706', borderRadius: 10,
            paddingVertical: 15, alignItems: 'center', backgroundColor: '#fffbeb',
          }}
        >
          <Text style={{ color: '#92400e', fontSize: 14, fontWeight: '700' }}>
            [DEBUG] Continue to onboarding
          </Text>
        </TouchableOpacity>

      </ScrollView>
    </View>
  );
}
