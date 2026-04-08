import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useBootstrap } from '../_layout';

// ─── Module-level mount counter ───────────────────────────────────────────────
let _mountCount = 0;

// ─── Diagnostic state ─────────────────────────────────────────────────────────
type StepStatus = 'pending' | 'ok' | 'fail' | 'unknown';

type DiagState = {
  codeExchange:  StepStatus;
  sessionLive:   StepStatus;
  profileExists: StepStatus;
  onboarding:    'pending' | 'true' | 'false';
  lastError:     string | null;
  timerElapsed:  number;
  mountCount:    number;
  stalled:       boolean;
};

const DIAG_INIT: DiagState = {
  codeExchange:  'pending',
  sessionLive:   'pending',
  profileExists: 'pending',
  onboarding:    'pending',
  lastError:     null,
  timerElapsed:  0,
  mountCount:    0,
  stalled:       false,
};

// ─── Diagnostic row ───────────────────────────────────────────────────────────
function DiagRow({ label, value }: { label: string; value: string }) {
  const isGood    = value === 'ok' || value === 'true';
  const isBad     = value === 'fail' || value === 'false';
  const isUnknown = value === 'unknown';
  const valueColor = isGood ? '#15803d' : isBad ? '#dc2626' : isUnknown ? '#b45309' : '#1c1917';

  return (
    <View style={{
      flexDirection:     'row',
      justifyContent:    'space-between',
      alignItems:        'center',
      paddingVertical:   8,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: '#e7e5e4',
      minHeight:         36,
    }}>
      <Text style={{ fontSize: 13, color: '#1c1917', fontFamily: 'monospace', fontWeight: '500' }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontWeight: '800', color: valueColor, fontFamily: 'monospace' }}>
        {value}
      </Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function AuthCallbackScreen() {
  const { code }  = useLocalSearchParams<{ code?: string }>();
  const router    = useRouter();

  const [diag,      setDiag]      = useState<DiagState>(DIAG_INIT);
  const [exchanged, setExchanged] = useState(false);
  const [retrying,  setRetrying]  = useState(false);

  const navigatedRef = useRef(false);
  const mountNumRef  = useRef(0);

  const { session, needsOnboarding } = useBootstrap();
  const sessionRef    = useRef(session);
  const onboardingRef = useRef(needsOnboarding);
  useEffect(() => { sessionRef.current    = session;         }, [session]);
  useEffect(() => { onboardingRef.current = needsOnboarding; }, [needsOnboarding]);

  // ── Mount / unmount ───────────────────────────────────────────────────────
  useEffect(() => {
    _mountCount += 1;
    mountNumRef.current = _mountCount;
    console.log('[WARM_BOOT] callback mounted count=', _mountCount);
    setDiag(d => ({ ...d, mountCount: _mountCount }));
    return () => {
      console.log('[WARM_BOOT] callback unmounted count=', mountNumRef.current);
    };
  }, []);

  // ── Elapsed timer (1 s tick, from mount) ──────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      setDiag(d => ({ ...d, timerElapsed: d.timerElapsed + 1 }));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── Mirror BootstrapContext → diag ────────────────────────────────────────
  useEffect(() => {
    const sv = session === undefined ? 'pending' : session ? 'ok' : 'fail';
    const ov = needsOnboarding === undefined ? 'pending' : (String(needsOnboarding) as 'true' | 'false');
    console.log('[WARM_BOOT] diag state update — session=', sv, 'needsOnboarding=', ov);
    setDiag(d => ({ ...d, sessionLive: sv, onboarding: ov }));
  }, [session, needsOnboarding]);

  // ── Phase 1: Exchange PKCE code ──────────────────────────────────────────
  useEffect(() => {
    console.log('[WARM_BOOT] callback route mounted');

    if (!supabase) {
      console.warn('[WARM_BOOT] supabase client not configured');
      setDiag(d => ({ ...d, codeExchange: 'fail', sessionLive: 'unknown', profileExists: 'unknown', lastError: 'Supabase client not configured' }));
      return;
    }
    if (!code) {
      console.warn('[WARM_BOOT] no code param — link may be expired or already used');
      setDiag(d => ({ ...d, codeExchange: 'fail', sessionLive: 'unknown', profileExists: 'unknown', lastError: 'No code param — link expired or already used' }));
      return;
    }

    console.log('[WARM_BOOT] exchangeCodeForSession start — code=', code.slice(0, 8) + '…');
    supabase.auth.exchangeCodeForSession(code).then(async ({ data, error: err }) => {
      if (err) {
        console.warn('[WARM_BOOT] exchangeCodeForSession failed:', err.message);
        setDiag(d => ({ ...d, codeExchange: 'fail', sessionLive: 'unknown', profileExists: 'unknown', lastError: err.message }));
        return;
      }
      const userId = data.session?.user?.id ?? null;
      console.log('[WARM_BOOT] exchangeCodeForSession success — userId=', userId?.slice(0, 8) ?? 'none');
      setDiag(d => ({ ...d, codeExchange: 'ok' }));
      setExchanged(true);

      // Immediate profile check — don't wait for timeout.
      if (userId && supabase) {
        try {
          const { data: prof, error: pErr } = await supabase
            .from('profiles').select('id').eq('id', userId).maybeSingle();
          const ps: StepStatus = pErr ? 'fail' : prof ? 'ok' : 'fail';
          console.log('[WARM_BOOT] immediate profile check — exists=', !!prof, 'error=', pErr?.message ?? null);
          setDiag(d => ({ ...d, profileExists: ps }));
        } catch (e) {
          console.warn('[WARM_BOOT] immediate profile check threw:', e);
          setDiag(d => ({ ...d, profileExists: 'fail' }));
        }
      }
    });
  }, [code]);

  // ── Phase 2a: 10-second stall marker ─────────────────────────────────────
  useEffect(() => {
    if (!exchanged) return;
    console.log('[WARM_BOOT] timeout scheduled for 10s');
    const timer = setTimeout(() => {
      if (navigatedRef.current) return;
      const s = sessionRef.current;
      const o = onboardingRef.current;
      console.warn('[WARM_BOOT] timeout fired — session=', s === undefined ? 'pending' : s ? 'active' : 'null', 'needsOnboarding=', o === undefined ? 'pending' : String(o));
      setDiag(d => ({ ...d, stalled: true, lastError: d.lastError ?? 'Bootstrap timed out after 10 s' }));
    }, 10000);
    return () => {
      console.log('[WARM_BOOT] timeout cleared');
      clearTimeout(timer);
    };
  }, [exchanged]);

  // ── Phase 2b: Navigate when bootstrap resolves ────────────────────────────
  useEffect(() => {
    if (!exchanged) return;
    if (navigatedRef.current) return;
    const sv = session === undefined ? 'pending' : session ? 'active' : 'null';
    const ov = needsOnboarding === undefined ? 'pending' : String(needsOnboarding);
    console.log('[WARM_BOOT] callback waiting on — session=', sv, 'needsOnboarding=', ov);
    if (session === undefined || needsOnboarding === undefined) return;
    if (!session) {
      console.warn('[WARM_BOOT] exchange succeeded but session null — routing to login');
      navigatedRef.current = true;
      router.replace('/login');
      return;
    }
    navigatedRef.current = true;
    if (needsOnboarding) {
      console.log('[WARM_BOOT] routing to onboarding');
      router.replace('/onboarding');
    } else {
      console.log('[WARM_BOOT] routing to tabs');
      router.replace('/');
    }
  }, [exchanged, session, needsOnboarding]);

  // ── Retry ─────────────────────────────────────────────────────────────────
  async function handleRetry() {
    if (!supabase) return;
    setRetrying(true);
    console.log('[WARM_BOOT] retry — calling getSession()');
    try {
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      console.log('[WARM_BOOT] retry getSession —', s ? 'present userId=' + s.user.id.slice(0, 8) : 'null');
      if (!s) {
        setDiag(d => ({ ...d, sessionLive: 'fail', lastError: 'Retry: no session' }));
        setRetrying(false);
        return;
      }
      const { data: prof, error: pErr } = await supabase
        .from('profiles').select('id, onboarding_completed').eq('id', s.user.id).maybeSingle();
      console.log('[WARM_BOOT] retry profile — exists=', !!prof, 'onboarding_completed=', prof?.onboarding_completed ?? null);
      const profileOk      = !pErr && !!prof;
      const onboardingDone = prof?.onboarding_completed === true;
      setDiag(d => ({
        ...d,
        sessionLive:   'ok',
        profileExists: pErr ? 'fail' : profileOk ? 'ok' : 'fail',
        onboarding:    onboardingDone ? 'false' : 'true',
        lastError:     pErr ? pErr.message : null,
      }));
      if (navigatedRef.current) { setRetrying(false); return; }
      navigatedRef.current = true;
      if (onboardingDone) {
        console.log('[WARM_BOOT] retry routing to tabs');
        router.replace('/');
      } else {
        console.log('[WARM_BOOT] retry routing to onboarding');
        router.replace('/onboarding');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[WARM_BOOT] retry threw:', msg);
      setDiag(d => ({ ...d, lastError: 'Retry threw: ' + msg }));
    }
    setRetrying(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Root is a plain flex:1 View — NO ScrollView with justifyContent:center
  // (that pattern clips content on Android when height overflows).
  // Spinner lives in a fixed-height header; diagnostic panel scrolls below it.
  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f7' }}>

      {/* ── Fixed header: spinner + status ─────────────────────────────── */}
      <View style={{
        backgroundColor: diag.stalled ? '#fef2f2' : '#faf9f7',
        paddingTop:      72,
        paddingBottom:   20,
        alignItems:      'center',
        borderBottomWidth: 2,
        borderBottomColor: diag.stalled ? '#fca5a5' : '#e7e5e4',
      }}>
        <ActivityIndicator size="large" color={diag.stalled ? '#dc2626' : '#1c1917'} />
        <Text style={{
          fontSize:     16,
          fontWeight:   '700',
          color:        diag.stalled ? '#dc2626' : '#1c1917',
          marginTop:    12,
          letterSpacing: -0.3,
        }}>
          {diag.stalled ? 'STALLED — see below' : 'Signing you in…'}
        </Text>
        {/* DEBUG MARKER — remove after confirming EAS update delivery */}
        <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 4, letterSpacing: 0.2 }}>
          DEBUG: auth-callback-diag-v1
        </Text>
      </View>

      {/* ── Scrollable diagnostic body ──────────────────────────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >

        {/* Diagnostic panel */}
        <View style={{
          backgroundColor: '#ffffff',
          borderRadius:    10,
          borderWidth:     2,
          borderColor:     '#1c1917',
          overflow:        'hidden',
          marginBottom:    16,
        }}>
          <View style={{ backgroundColor: '#1c1917', paddingVertical: 6, paddingHorizontal: 12 }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: '#ffffff', letterSpacing: 0.8, textTransform: 'uppercase' }}>
              Bootstrap Diagnostic
            </Text>
          </View>
          <DiagRow label="codeExchange"    value={diag.codeExchange} />
          <DiagRow label="session"         value={diag.sessionLive} />
          <DiagRow label="profile"         value={diag.profileExists} />
          <DiagRow label="needsOnboarding" value={diag.onboarding} />
          <DiagRow label="timerElapsed"    value={diag.timerElapsed + 's'} />
          <DiagRow label="mountCount"      value={String(diag.mountCount)} />
        </View>

        {/* lastError — always rendered, shows placeholder if null */}
        <View style={{
          backgroundColor: diag.lastError ? '#fef2f2' : '#f5f5f4',
          borderRadius:    8,
          padding:         12,
          marginBottom:    20,
          borderWidth:     1,
          borderColor:     diag.lastError ? '#fca5a5' : '#e7e5e4',
          minHeight:       48,
        }}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: diag.lastError ? '#991b1b' : '#a8a29e', marginBottom: 3 }}>
            lastError
          </Text>
          <Text style={{ fontSize: 11, color: diag.lastError ? '#b91c1c' : '#a8a29e', fontFamily: 'monospace', lineHeight: 16 }}>
            {diag.lastError ?? 'none'}
          </Text>
        </View>

        {/* Retry */}
        <TouchableOpacity
          onPress={handleRetry}
          disabled={retrying}
          style={{
            backgroundColor: '#1c1917',
            borderRadius:    10,
            paddingVertical: 15,
            alignItems:      'center',
            marginBottom:    10,
            opacity: retrying ? 0.55 : 1,
          }}
        >
          {retrying
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Retry</Text>
          }
        </TouchableOpacity>

        {/* Back to sign in */}
        <TouchableOpacity
          onPress={() => router.replace('/login')}
          style={{
            borderWidth:     2,
            borderColor:     '#1c1917',
            borderRadius:    10,
            paddingVertical: 15,
            alignItems:      'center',
            marginBottom:    10,
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
            borderWidth:     2,
            borderColor:     '#d97706',
            borderRadius:    10,
            paddingVertical: 15,
            alignItems:      'center',
            backgroundColor: '#fffbeb',
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
