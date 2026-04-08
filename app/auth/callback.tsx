import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useBootstrap } from '../_layout';

// ─── Module-level mount counter ───────────────────────────────────────────────
// Increments on every mount of this component within the same JS bundle session.
// If this exceeds 1 during a single sign-in attempt, the screen is remounting.
let _mountCount = 0;

// ─── Diagnostic state ─────────────────────────────────────────────────────────
type StepStatus = 'pending' | 'ok' | 'fail' | 'unknown';

type DiagState = {
  codeExchange:  StepStatus;
  sessionLive:   StepStatus;
  profileExists: StepStatus;
  onboarding:    'pending' | 'true' | 'false';
  lastError:     string | null;
  timerElapsed:  number;   // seconds since mount
  mountCount:    number;
  stalled:       boolean;  // true once 10 s timeout fires
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rowColor(value: string): string {
  if (value === 'ok' || value === 'true')    return '#16a34a';
  if (value === 'fail' || value === 'false') return '#dc2626';
  if (value === 'pending')                   return '#a8a29e';
  if (value === 'unknown')                   return '#d97706';
  return '#1c1917';
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{
      flexDirection:     'row',
      justifyContent:    'space-between',
      paddingVertical:   5,
      borderBottomWidth: 1,
      borderBottomColor: '#f5f5f4',
    }}>
      <Text style={{ fontSize: 11, color: '#78716c', fontFamily: 'monospace' }}>{label}</Text>
      <Text style={{ fontSize: 11, fontWeight: '700', color: rowColor(value), fontFamily: 'monospace' }}>{value}</Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function AuthCallbackScreen() {
  const { code }  = useLocalSearchParams<{ code?: string }>();
  const router    = useRouter();

  const [diag,     setDiag]     = useState<DiagState>(DIAG_INIT);
  const [exchanged, setExchanged] = useState(false);
  const [retrying, setRetrying]  = useState(false);

  const navigatedRef = useRef(false);
  const mountNumRef  = useRef(0);  // this mount's assigned number

  // BootstrapContext
  const { session, needsOnboarding } = useBootstrap();
  const sessionRef    = useRef(session);
  const onboardingRef = useRef(needsOnboarding);
  useEffect(() => { sessionRef.current    = session;         }, [session]);
  useEffect(() => { onboardingRef.current = needsOnboarding; }, [needsOnboarding]);

  // ── Mount / unmount tracking ──────────────────────────────────────────────
  useEffect(() => {
    _mountCount += 1;
    mountNumRef.current = _mountCount;
    console.log('[WARM_BOOT] callback mounted count=', _mountCount);
    setDiag(d => ({ ...d, mountCount: _mountCount }));

    return () => {
      console.log('[WARM_BOOT] callback unmounted count=', mountNumRef.current);
    };
  }, []);

  // ── Elapsed timer (starts from mount, 1 s tick) ───────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      setDiag(d => ({ ...d, timerElapsed: d.timerElapsed + 1 }));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── Mirror BootstrapContext → diag live ───────────────────────────────────
  useEffect(() => {
    const sessionStatus   = session === undefined ? 'pending' : session ? 'ok' : 'fail';
    const onboardingVal   = needsOnboarding === undefined
      ? 'pending'
      : (String(needsOnboarding) as 'true' | 'false');
    console.log('[WARM_BOOT] diag state update — session=', sessionStatus, 'needsOnboarding=', onboardingVal);
    setDiag(d => ({ ...d, sessionLive: sessionStatus, onboarding: onboardingVal }));
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
      setDiag(d => ({ ...d, codeExchange: 'fail', sessionLive: 'unknown', profileExists: 'unknown', lastError: 'No code param — link may be expired or already used' }));
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

      // Immediately check profile — don't wait for the timeout.
      if (userId && supabase) {
        try {
          const { data: prof, error: pErr } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', userId)
            .maybeSingle();
          const profileStatus: StepStatus = pErr ? 'fail' : prof ? 'ok' : 'fail';
          console.log('[WARM_BOOT] immediate profile check — exists=', !!prof, 'error=', pErr?.message ?? null);
          setDiag(d => ({ ...d, profileExists: profileStatus }));
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
      const sessionStatus    = s === undefined ? 'pending' : s ? 'active' : 'null';
      const onboardingStatus = o === undefined ? 'pending' : String(o);
      console.warn('[WARM_BOOT] timeout fired — session=', sessionStatus, 'needsOnboarding=', onboardingStatus);
      setDiag(d => ({
        ...d,
        stalled:   true,
        lastError: d.lastError ?? 'Bootstrap timed out after 10 s',
      }));
    }, 10000);

    return () => {
      console.log('[WARM_BOOT] timeout cleared');
      clearTimeout(timer);
    };
  }, [exchanged]);

  // ── Phase 2b: Watch bootstrap, navigate when ready ────────────────────────
  useEffect(() => {
    if (!exchanged) return;
    if (navigatedRef.current) return;

    const sessionStatus    = session === undefined ? 'pending' : session ? 'active' : 'null';
    const onboardingStatus = needsOnboarding === undefined ? 'pending' : String(needsOnboarding);
    console.log('[WARM_BOOT] callback waiting on — session=', sessionStatus, 'needsOnboarding=', onboardingStatus);

    if (session === undefined || needsOnboarding === undefined) return;

    if (!session) {
      console.warn('[WARM_BOOT] exchange succeeded but session is null after bootstrap — routing to login');
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
        setDiag(d => ({ ...d, sessionLive: 'fail', lastError: 'Retry: getSession returned null' }));
        setRetrying(false);
        return;
      }

      const { data: prof, error: pErr } = await supabase
        .from('profiles')
        .select('id, onboarding_completed')
        .eq('id', s.user.id)
        .maybeSingle();
      console.log('[WARM_BOOT] retry profile — exists=', !!prof, 'onboarding_completed=', prof?.onboarding_completed ?? null);

      const profileOk     = !pErr && !!prof;
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
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow:          1,
        backgroundColor:   '#faf9f7',
        alignItems:        'center',
        justifyContent:    'center',
        paddingHorizontal: 28,
        paddingVertical:   48,
      }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Spinner + status label ──────────────────────────────────────── */}
      <ActivityIndicator size="large" color="#1c1917" />
      <Text style={{
        fontSize:      15,
        fontWeight:    '500',
        color:         diag.stalled ? '#b91c1c' : '#78716c',
        letterSpacing: -0.2,
        marginTop:     14,
        marginBottom:  28,
      }}>
        {diag.stalled ? 'Stalled — check debug below' : 'Signing you in…'}
      </Text>

      {/* ── Live diagnostic block — visible from first render ─────────── */}
      <View style={{
        width:           '100%',
        backgroundColor: '#fff',
        borderRadius:    10,
        paddingHorizontal: 14,
        paddingTop:      6,
        paddingBottom:   6,
        borderWidth:     1,
        borderColor:     '#e7e5e4',
        marginBottom:    16,
      }}>
        <DiagRow label="codeExchange"    value={diag.codeExchange} />
        <DiagRow label="session"         value={diag.sessionLive} />
        <DiagRow label="profile"         value={diag.profileExists} />
        <DiagRow label="needsOnboarding" value={diag.onboarding} />
        <DiagRow label="timerElapsed"    value={diag.timerElapsed + 's'} />
        <DiagRow label="mountCount"      value={String(diag.mountCount)} />
      </View>

      {/* ── lastError ───────────────────────────────────────────────────── */}
      {diag.lastError ? (
        <View style={{
          width:           '100%',
          backgroundColor: '#fff1f2',
          borderRadius:    8,
          padding:         10,
          marginBottom:    16,
          borderWidth:     1,
          borderColor:     '#fecdd3',
        }}>
          <Text style={{ fontSize: 10, color: '#9f1239', fontWeight: '700', marginBottom: 2 }}>lastError</Text>
          <Text style={{ fontSize: 10, color: '#be123c', fontFamily: 'monospace', lineHeight: 15 }}>
            {diag.lastError}
          </Text>
        </View>
      ) : null}

      {/* ── Buttons — always visible ────────────────────────────────────── */}
      <TouchableOpacity
        onPress={handleRetry}
        disabled={retrying}
        style={{
          width:           '100%',
          backgroundColor: '#1c1917',
          borderRadius:    10,
          paddingVertical: 12,
          alignItems:      'center',
          marginBottom:    8,
          opacity: retrying ? 0.55 : 1,
        }}
      >
        {retrying
          ? <ActivityIndicator color="#fff" size="small" />
          : <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Retry</Text>
        }
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => router.replace('/login')}
        style={{
          width:           '100%',
          borderWidth:     1.5,
          borderColor:     '#d6d3d1',
          borderRadius:    10,
          paddingVertical: 12,
          alignItems:      'center',
          marginBottom:    8,
        }}
      >
        <Text style={{ color: '#57534e', fontSize: 13, fontWeight: '600' }}>Back to sign in</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => {
          console.warn('[WARM_BOOT] debug-forced navigation to /onboarding');
          navigatedRef.current = true;
          router.replace('/onboarding');
        }}
        style={{
          width:           '100%',
          borderWidth:     1.5,
          borderColor:     '#fcd34d',
          borderRadius:    10,
          paddingVertical: 12,
          alignItems:      'center',
        }}
      >
        <Text style={{ color: '#92400e', fontSize: 12, fontWeight: '600' }}>
          [DEBUG] Continue to onboarding
        </Text>
      </TouchableOpacity>

      {/* DEBUG MARKER — remove after confirming EAS update delivery */}
      <Text style={{ fontSize: 10, color: '#d6d3d1', letterSpacing: 0.2, marginTop: 20 }}>
        DEBUG: auth-callback-diag-v1
      </Text>
    </ScrollView>
  );
}
