import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useBootstrap } from '../_layout';

// ─── Diagnostic state ─────────────────────────────────────────────────────────
// Each field tracks one stage of the sign-in bootstrap.
// Values: 'pending' = not yet known | 'ok' = confirmed good |
//         'fail' = confirmed bad    | 'unknown' = skipped / n/a

type StepStatus = 'pending' | 'ok' | 'fail' | 'unknown';

type DiagState = {
  codeExchange:  StepStatus;
  sessionLive:   StepStatus;
  profileExists: StepStatus;
  onboarding:    'pending' | 'true' | 'false';
  lastError:     string | null;
};

const DIAG_INIT: DiagState = {
  codeExchange:  'pending',
  sessionLive:   'pending',
  profileExists: 'pending',
  onboarding:    'pending',
  lastError:     null,
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
      flexDirection:   'row',
      justifyContent:  'space-between',
      paddingVertical: 7,
      borderBottomWidth: 1,
      borderBottomColor: '#f5f5f4',
    }}>
      <Text style={{ fontSize: 12, color: '#78716c', fontFamily: 'monospace' }}>
        {label}
      </Text>
      <Text style={{ fontSize: 12, fontWeight: '700', color: rowColor(value), fontFamily: 'monospace' }}>
        {value}
      </Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * AuthCallbackScreen
 *
 * Phase 1 — exchange the PKCE code for a session.
 * Phase 2 — wait for root layout bootstrap (session + needsOnboarding).
 * Diagnostic — if bootstrap stalls beyond 10 s, surface every tracked state
 *              visibly on-device so the exact blocker can be identified
 *              without relying on shell logs.
 */
export default function AuthCallbackScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router   = useRouter();

  const [diag,     setDiag]     = useState<DiagState>(DIAG_INIT);
  const [showDiag, setShowDiag] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [exchanged, setExchanged] = useState(false);

  // userId captured after exchange succeeds — used for the profile check
  const exchangedUserIdRef = useRef<string | null>(null);
  // guard against double-navigation
  const navigatedRef = useRef(false);

  // BootstrapContext: live session + needsOnboarding from root layout.
  const { session, needsOnboarding } = useBootstrap();

  // Refs so timeout callback always sees latest bootstrap state.
  const sessionRef    = useRef(session);
  const onboardingRef = useRef(needsOnboarding);
  useEffect(() => { sessionRef.current    = session;         }, [session]);
  useEffect(() => { onboardingRef.current = needsOnboarding; }, [needsOnboarding]);

  // Mirror BootstrapContext into diag whenever it changes.
  useEffect(() => {
    setDiag(d => ({
      ...d,
      sessionLive: session === undefined ? 'pending' : session ? 'ok' : 'fail',
      onboarding:  needsOnboarding === undefined
        ? 'pending'
        : (String(needsOnboarding) as 'true' | 'false'),
    }));
  }, [session, needsOnboarding]);

  // ── Phase 1: Exchange PKCE code ─────────────────────────────────────────────
  useEffect(() => {
    console.log('[WARM_BOOT] callback route mounted');

    if (!supabase) {
      console.warn('[WARM_BOOT] supabase client not configured');
      setDiag(d => ({
        ...d,
        codeExchange:  'fail',
        sessionLive:   'unknown',
        profileExists: 'unknown',
        lastError: 'Supabase client not configured',
      }));
      setShowDiag(true);
      return;
    }

    if (!code) {
      console.warn('[WARM_BOOT] no code param — link may be expired or already used');
      setDiag(d => ({
        ...d,
        codeExchange:  'fail',
        sessionLive:   'unknown',
        profileExists: 'unknown',
        lastError: 'No code param — link may be expired or already used',
      }));
      setShowDiag(true);
      return;
    }

    console.log('[WARM_BOOT] exchangeCodeForSession start — code=', code.slice(0, 8) + '…');
    supabase.auth.exchangeCodeForSession(code).then(({ data, error: err }) => {
      if (err) {
        console.warn('[WARM_BOOT] exchangeCodeForSession failed:', err.message);
        setDiag(d => ({
          ...d,
          codeExchange:  'fail',
          sessionLive:   'unknown',
          profileExists: 'unknown',
          lastError: err.message,
        }));
        setShowDiag(true);
        return;
      }
      const userId = data.session?.user?.id ?? null;
      console.log('[WARM_BOOT] exchangeCodeForSession success — userId=', userId?.slice(0, 8) ?? 'none');
      exchangedUserIdRef.current = userId;
      setDiag(d => ({ ...d, codeExchange: 'ok' }));
      setExchanged(true);
    });
  }, [code]);

  // ── Phase 2a: 10-second diagnostic timeout ──────────────────────────────────
  // If bootstrap still hasn't resolved after exchange succeeded, reveal the
  // diagnostic surface so the exact blocking state is visible on-device.
  useEffect(() => {
    if (!exchanged) return;

    const timer = setTimeout(async () => {
      if (navigatedRef.current) return;

      const s = sessionRef.current;
      const o = onboardingRef.current;
      const sessionStatus    = s === undefined ? 'pending' : s ? 'active' : 'null';
      const onboardingStatus = o === undefined ? 'pending' : String(o);

      console.warn(
        '[WARM_BOOT] callback stalled because session=', sessionStatus,
        'needsOnboarding=', onboardingStatus,
        '(10 s timeout — bootstrap never resolved)',
      );

      // Direct profile check — independent of the bootstrap listener path.
      let profileStatus: StepStatus = 'unknown';
      const userId = exchangedUserIdRef.current ?? s?.user?.id ?? null;
      if (userId && supabase) {
        try {
          const { data: prof, error: pErr } = await supabase
            .from('profiles')
            .select('id')
            .eq('id', userId)
            .maybeSingle();
          profileStatus = pErr ? 'fail' : prof ? 'ok' : 'fail';
          console.log('[WARM_BOOT] timeout profile check — exists=', !!prof, 'error=', pErr?.message ?? null);
        } catch (e) {
          profileStatus = 'fail';
          console.warn('[WARM_BOOT] timeout profile check threw:', e);
        }
      }

      setDiag(d => ({
        ...d,
        profileExists: profileStatus,
        lastError: d.lastError ?? 'Bootstrap timed out after 10 s',
      }));
      setShowDiag(true);
    }, 10000);

    return () => clearTimeout(timer);
  }, [exchanged]);

  // ── Phase 2b: Watch bootstrap, navigate when ready ──────────────────────────
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

  // ── Retry: direct session re-check, bypass bootstrap wait ──────────────────
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

  // ── Diagnostic surface ──────────────────────────────────────────────────────
  if (showDiag) {
    return (
      <ScrollView
        contentContainerStyle={{
          flexGrow:         1,
          backgroundColor:  '#faf9f7',
          paddingHorizontal: 24,
          paddingTop:        64,
          paddingBottom:     48,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <Text style={{
          fontSize:      18,
          fontWeight:    '700',
          color:         '#1c1917',
          letterSpacing: -0.3,
          marginBottom:  4,
        }}>
          Sign-in stalled
        </Text>
        <Text style={{
          fontSize:     12,
          color:        '#a8a29e',
          lineHeight:   18,
          marginBottom: 24,
        }}>
          Bootstrap did not complete. Tap Retry to re-attempt.
        </Text>

        {/* Diagnostic table */}
        <View style={{
          backgroundColor: '#fff',
          borderRadius:    10,
          paddingHorizontal: 14,
          paddingTop:      4,
          paddingBottom:   4,
          marginBottom:    24,
          borderWidth:     1,
          borderColor:     '#e7e5e4',
        }}>
          <DiagRow label="codeExchange"    value={diag.codeExchange} />
          <DiagRow label="session"         value={diag.sessionLive} />
          <DiagRow label="profile"         value={diag.profileExists} />
          <DiagRow label="needsOnboarding" value={diag.onboarding} />
        </View>

        {/* lastError */}
        {diag.lastError ? (
          <View style={{
            backgroundColor: '#fff1f2',
            borderRadius:    8,
            padding:         12,
            marginBottom:    24,
            borderWidth:     1,
            borderColor:     '#fecdd3',
          }}>
            <Text style={{ fontSize: 11, color: '#9f1239', fontWeight: '700', marginBottom: 3 }}>
              lastError
            </Text>
            <Text style={{ fontSize: 11, color: '#be123c', fontFamily: 'monospace', lineHeight: 16 }}>
              {diag.lastError}
            </Text>
          </View>
        ) : null}

        {/* Retry */}
        <TouchableOpacity
          onPress={handleRetry}
          disabled={retrying}
          style={{
            backgroundColor: '#1c1917',
            borderRadius:    10,
            paddingVertical: 13,
            alignItems:      'center',
            marginBottom:    10,
            opacity: retrying ? 0.55 : 1,
          }}
        >
          {retrying
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Retry</Text>
          }
        </TouchableOpacity>

        {/* Back to sign in */}
        <TouchableOpacity
          onPress={() => router.replace('/login')}
          style={{
            borderWidth:     1.5,
            borderColor:     '#d6d3d1',
            borderRadius:    10,
            paddingVertical: 13,
            alignItems:      'center',
            marginBottom:    10,
          }}
        >
          <Text style={{ color: '#57534e', fontSize: 14, fontWeight: '600' }}>
            Back to sign in
          </Text>
        </TouchableOpacity>

        {/* Debug fallback */}
        <TouchableOpacity
          onPress={() => {
            console.warn('[WARM_BOOT] debug-forced navigation to /onboarding');
            navigatedRef.current = true;
            router.replace('/onboarding');
          }}
          style={{
            borderWidth:     1.5,
            borderColor:     '#fcd34d',
            borderRadius:    10,
            paddingVertical: 13,
            alignItems:      'center',
          }}
        >
          <Text style={{ color: '#92400e', fontSize: 13, fontWeight: '600' }}>
            [DEBUG] Continue to onboarding
          </Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Loading state ───────────────────────────────────────────────────────────
  return (
    <View style={{
      flex:            1,
      backgroundColor: '#faf9f7',
      alignItems:      'center',
      justifyContent:  'center',
      gap:             16,
    }}>
      <ActivityIndicator size="large" color="#1c1917" />
      <Text style={{
        fontSize:      15,
        fontWeight:    '500',
        color:         '#78716c',
        letterSpacing: -0.2,
      }}>
        Signing you in…
      </Text>
      {/* DEBUG MARKER — remove after confirming EAS update delivery */}
      <Text style={{ fontSize: 10, color: '#d6d3d1', letterSpacing: 0.2, marginTop: 8 }}>
        DEBUG: auth-callback-diag-v1
      </Text>
    </View>
  );
}
