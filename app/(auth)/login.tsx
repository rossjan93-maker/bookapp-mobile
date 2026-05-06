import { useThemedTokens } from '../../lib/theme/useThemedTokens';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BookStackLoader } from '../../components/BookStackLoader';
import { Ionicons } from '@expo/vector-icons';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';
import { isAppleAvailable, signInWithApple, signInWithGoogle } from '../../lib/socialAuth';

// ─── Mode type ───────────────────────────────────────────────────────────────
// signin / signup — primary tab-toggle modes
// forgot         — password reset flow (email only)
// resend         — resend confirmation email flow (email only)
type Mode = 'signin' | 'signup' | 'forgot' | 'resend';

// ─── Error message mapping ────────────────────────────────────────────────────
// Maps raw Supabase/backend auth errors to clean product language.
// No raw backend text should ever reach the UI.

function mapSignInError(error: { message?: string; status?: number }): {
  text: string;
  offerResend: boolean;  // true → show "Resend confirmation" CTA inline
} {
  const raw    = (error.message ?? '').toLowerCase();
  const status = error.status ?? 0;

  // Rate limit — safe to surface explicitly (doesn't reveal account existence)
  if (status === 429 || raw.includes('too many') || raw.includes('rate limit')) {
    return { text: 'Too many attempts — wait a moment and try again.', offerResend: false };
  }

  // Email not confirmed — user signed up but hasn't clicked confirmation link
  if (raw.includes('not confirmed') || raw.includes('email not confirmed')) {
    return {
      text: 'Check your inbox — you need to confirm this email before signing in.',
      offerResend: true,
    };
  }

  // All other sign-in failures (wrong password, unknown email, etc.) are mapped to
  // a single clear message. We deliberately do not distinguish "wrong password" from
  // "unknown email" to prevent email enumeration.
  if (
    status === 400 ||
    raw.includes('invalid') ||
    raw.includes('credentials') ||
    raw.includes('password') ||
    raw.includes('user not found') ||
    raw.includes('no user')
  ) {
    // We deliberately do not distinguish "wrong password" from "unknown email"
    // from "account exists but is Google/Apple only" — Supabase returns the
    // same `invalid_credentials` for all three to prevent account enumeration.
    // The provider-mismatch hint shown below the status (see render block)
    // covers the social-only case without revealing which path applied.
    return { text: "We couldn\u2019t sign you in with that email and password.", offerResend: false };
  }

  // Network / server errors
  return { text: 'Something went wrong. Check your connection and try again.', offerResend: false };
}

function mapSignUpError(error: { message?: string; status?: number }): {
  text: string;
  rateLimited: boolean;
} {
  const status = error.status ?? 0;
  const raw    = (error.message ?? '').toLowerCase();
  if (
    status === 429 ||
    raw.includes('rate limit') ||
    raw.includes('over email send rate limit') ||
    raw.includes('too many')
  ) {
    return {
      text: 'Too many emails sent to this address recently — wait a minute and try again.',
      rateLimited: true,
    };
  }
  return { text: 'Something went wrong. Please try again.', rateLimited: false };
}

// ─── Unconfirmed-existing-account helper ──────────────────────────────────────
// Detects signUp errors that indicate the email already belongs to an existing
// but unconfirmed account. Routes to duplicate/resend guidance rather than a
// generic error, since the user just needs to confirm their existing account.
function isUnconfirmedAccountError(error: { message?: string; status?: number } | null): boolean {
  if (!error) return false;
  const raw    = (error.message ?? '').toLowerCase();
  const status = error.status ?? 0;
  return (
    // Supabase "user already registered" variants
    raw.includes('already registered') ||
    raw.includes('already exists') ||
    raw.includes('user already') ||
    raw.includes('email already') ||
    raw.includes('email exists') ||
    // "email not confirmed" can surface as an error on re-signup
    raw.includes('not confirmed') ||
    raw.includes('email not confirmed') ||
    // 422 Unprocessable Entity — Supabase uses this for existing-user conflicts
    status === 422
  );
}

// ─── Rate-limit helper ────────────────────────────────────────────────────────
// Detects rate-limit errors from supabase.auth.resend responses.
// Checks both HTTP status and message text for robustness.
function isResendRateLimitError(error: { message?: string; status?: number } | null): boolean {
  if (!error) return false;
  const raw    = (error.message ?? '').toLowerCase();
  const status = error.status ?? 0;
  return (
    status === 429 ||
    raw.includes('rate limit') ||
    raw.includes('over email send rate limit') ||
    raw.includes('too many')
  );
}

// ─── Shared style primitives ─────────────────────────────────────────────────
const INPUT: object = {
  width: '100%' as const,
  borderWidth: 1,
  borderColor: '#e8e3dc',
  borderRadius: 12,
  padding: 14,
  fontSize: 15,
  color: '#231f1b',
  backgroundColor: '#f5f1ec',
  marginBottom: 10,
};

// ─── Book glyph mark — 3 stacked horizontal spines, static identity mark ─────
function BookGlyph() {
  const T = useThemedTokens();
  return (
    <View style={{ alignItems: 'center', marginBottom: 16 }}>
      {[
        { w: 28, c: T.SAGE, dx:  1 },
        { w: 36, c: '#b5c4b1', dx: -2 },
        { w: 44, c: '#c9bdb0', dx:  1 },
      ].map((b, i) => (
        <View
          key={i}
          style={{
            width:           b.w,
            height:          6,
            borderRadius:    2,
            backgroundColor: b.c,
            marginBottom:    i < 2 ? 3 : 0,
            transform:       [{ translateX: b.dx }],
          }}
        />
      ))}
    </View>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────
export default function LoginScreen() {
  const T = useThemedTokens();
  if (!hasSupabaseConfig || !supabase) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.BG }}>
        <Text style={{ color: T.STONE, fontSize: 14 }}>Supabase not configured.</Text>
      </View>
    );
  }

  // ── Form state ──────────────────────────────────────────────────────────────
  const [mode, setMode]           = useState<Mode>('signin');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [username, setUsername]           = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword]   = useState(false);
  const [showConfirm, setShowConfirm]     = useState(false);
  const [loading, setLoading]             = useState(false);

  // ── Status state ────────────────────────────────────────────────────────────
  // status        — message shown below the form
  // statusIsError — true → red text, false → neutral stone text
  const [status, setStatus]         = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  // offerResend — true when the error specifically means "email not confirmed";
  // shows a one-tap "Resend confirmation" link alongside the error message.
  const [offerResend, setOfferResend] = useState(false);

  // ── Post-action states ───────────────────────────────────────────────────────
  // duplicateEmail      — shown when signup detects an existing account on this email
  // emailConfirmPending — shown after a new signup; waiting for confirmation
  // emailSent           — shown after forgot / resend flow completes
  // signUpRateLimited   — shown when signup hits a rate limit (distinct amber panel)
  // resendRateLimited   — shown inline in emailConfirmPending when resend is rate-limited
  // resendSent          — shown inline in emailConfirmPending after a successful resend
  const [duplicateEmail, setDuplicateEmail]           = useState(false);
  const [emailConfirmPending, setEmailConfirmPending] = useState(false);
  const [emailSent, setEmailSent]                     = useState(false);
  const [signUpRateLimited, setSignUpRateLimited]     = useState(false);
  const [resendRateLimited, setResendRateLimited]     = useState(false);
  const [resendSent, setResendSent]                   = useState(false);

  // ── Mode switching ──────────────────────────────────────────────────────────
  function switchMode(m: Mode) {
    setMode(m);
    setStatus('');
    setStatusIsError(false);
    setOfferResend(false);
    setDuplicateEmail(false);
    setEmailConfirmPending(false);
    setEmailSent(false);
    setSignUpRateLimited(false);
    setResendRateLimited(false);
    setResendSent(false);
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirm(false);
    setSocialError('');
  }

  // ── Sign up ─────────────────────────────────────────────────────────────────
  async function handleSignUp() {
    setLoading(true);
    setStatus('');
    setStatusIsError(false);
    setOfferResend(false);
    setDuplicateEmail(false);
    setEmailConfirmPending(false);
    setSignUpRateLimited(false);
    setResendRateLimited(false);
    setResendSent(false);

    // ── Client-side validation ───────────────────────────────────────────────
    if (!firstName.trim()) {
      setStatus('First name is required.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }
    if (!lastName.trim()) {
      setStatus('Last name is required.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }
    const uname = username.trim().toLowerCase().replace(/\s+/g, '');
    if (!uname) {
      setStatus('Please choose a username.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) {
      setStatus('Username must be 3–20 characters: letters, numbers, or underscores.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }
    if (!email.trim()) {
      setStatus('Email is required.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }
    if (password.length < 6) {
      setStatus('Password must be at least 6 characters.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }
    if (password !== confirmPassword) {
      setStatus('Passwords do not match.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }

    // ── Pre-check username availability ──────────────────────────────────────
    // Prevents orphaned auth users when username is already taken.
    const { data: taken } = await supabase!
      .from('profiles')
      .select('id')
      .eq('username', uname)
      .maybeSingle();

    if (taken) {
      setStatus('That username is already taken. Please choose another.');
      setStatusIsError(true);
      setLoading(false);
      return;
    }

    // ── Supabase sign-up ─────────────────────────────────────────────────────
    const { data: authData, error } = await supabase!.auth.signUp({
      email:    email.trim(),
      password,
      options: {
        data: {
          first_name: firstName.trim(),
          last_name:  lastName.trim(),
          username:   uname,
        },
        // Redirect to the native app after email confirmation.
        // Without this, Supabase falls back to the Site URL (readstack.co)
        // which is a web URL and won't open the app.
        emailRedirectTo: 'readstack://auth/callback',
      },
    });

    if (error) {
      // Unconfirmed-existing-account: route to duplicate/resend guidance.
      // This catches cases where the account exists but email confirmation is
      // pending — the user should resend confirmation, not see a generic error.
      if (isUnconfirmedAccountError(error)) {
        setDuplicateEmail(true);
        setLoading(false);
        return;
      }
      const { text, rateLimited } = mapSignUpError(error);
      if (rateLimited) {
        setSignUpRateLimited(true);
      } else {
        setStatus(text);
        setStatusIsError(true);
      }
      setLoading(false);
      return;
    }

    if (authData?.user) {
      // ── Happy path: new user created ────────────────────────────────────────
      const { error: profileError } = await supabase!.from('profiles').upsert({
        id:         authData.user.id,
        username:   uname,
        first_name: firstName.trim(),
        last_name:  lastName.trim(),
      });
      // Unique constraint violation — username race condition
      if (profileError?.code === '23505') {
        setStatus('That username is already taken. Please choose another.');
        setStatusIsError(true);
        setLoading(false);
        return;
      }
      // New user created — waiting for email confirmation
      setEmailConfirmPending(true);
    } else {
      // ── Existing account detected ────────────────────────────────────────────
      // Supabase returns user=null (no error) when email confirmation is enabled
      // and the submitted email already belongs to an existing confirmed account.
      // This is intentional on Supabase's side (prevents email enumeration), but
      // we can treat user=null as "account exists" in this configuration.
      setDuplicateEmail(true);
    }

    setLoading(false);
  }

  // ── Sign in ─────────────────────────────────────────────────────────────────
  async function handleSignIn() {
    setLoading(true);
    setStatus('');
    setStatusIsError(false);
    setOfferResend(false);
    const { error } = await supabase!.auth.signInWithPassword({
      email:    email.trim(),
      password,
    });
    if (error) {
      const { text, offerResend: shouldOfferResend } = mapSignInError(error);
      setStatus(text);
      setStatusIsError(true);
      setOfferResend(shouldOfferResend);
    }
    setLoading(false);
  }

  // ── Forgot password ─────────────────────────────────────────────────────────
  async function handleForgotPassword() {
    if (!email.trim()) {
      setStatus('Enter your email address above first.');
      setStatusIsError(true);
      return;
    }
    setLoading(true);
    setStatus('');
    setStatusIsError(false);
    setOfferResend(false);

    const { error } = await supabase!.auth.resetPasswordForEmail(email.trim(), {
      // Redirect to the native app after the user clicks the reset link.
      redirectTo: 'readstack://auth/callback',
    });

    setLoading(false);

    // Supabase does NOT return an error for non-existent emails — it always returns
    // success for valid addresses to prevent email enumeration. Any error we receive
    // here is therefore a genuine system failure (rate limit, network error, etc.)
    // and safe to surface.
    if (error) {
      setStatus(
        error.status === 429
          ? 'Too many requests — please wait a moment and try again.'
          : 'Something went wrong. Check your connection and try again.'
      );
      setStatusIsError(true);
      return;
    }

    setEmailSent(true);
    setStatus('If an account exists for that address, we sent a reset link. Check your email (including spam).');
    setStatusIsError(false);
  }

  // ── Resend confirmation ──────────────────────────────────────────────────────
  // Used in the standalone resend mode (mode === 'resend').
  async function handleResendConfirmation() {
    if (!email.trim()) {
      setStatus('Enter your email address above first.');
      setStatusIsError(true);
      return;
    }
    setLoading(true);
    setStatus('');
    setStatusIsError(false);
    setOfferResend(false);

    const { error } = await supabase!.auth.resend({ type: 'signup', email: email.trim() });

    setLoading(false);

    // For resend, stay neutral on most errors to avoid enumeration — a 404/422
    // "user not found" from Supabase should not be revealed to the caller.
    // Rate limit (429) is safe to surface explicitly: it does not reveal whether
    // the email exists or not.
    if (isResendRateLimitError(error)) {
      setStatus('Too many requests — please wait a moment and try again.');
      setStatusIsError(true);
      return;
    }

    setEmailSent(true);
    setStatus('If that address has an unconfirmed account, we sent a new confirmation link. Check your email.');
    setStatusIsError(false);
  }

  // ── Inline resend (from emailConfirmPending or duplicateEmail panels) ────────
  // Performs resend without navigating away; updates inline flags instead.
  async function handleInlineResend() {
    setLoading(true);
    setResendRateLimited(false);
    setResendSent(false);

    const { error } = await supabase!.auth.resend({ type: 'signup', email: email.trim() });

    setLoading(false);

    if (isResendRateLimitError(error)) {
      setResendRateLimited(true);
      return;
    }

    // For any non-rate-limit error (404/422 enumeration etc.) we show success
    // to avoid revealing account existence, matching the standalone resend behaviour.
    setResendSent(true);
  }

  // ── Social auth state ────────────────────────────────────────────────────────
  const [socialLoading,  setSocialLoading]  = useState<'google' | 'apple' | null>(null);
  const [socialError,    setSocialError]    = useState('');
  // socialSignedIn: true after a successful social auth while _layout bootstrap runs.
  // Keeps the screen in a clear loading state so there's no apparent freeze.
  const [socialSignedIn, setSocialSignedIn] = useState(false);
  const appleAvailable = isAppleAvailable();

  async function handleGoogleSignIn() {
    setSocialLoading('google');
    setSocialError('');
    const { error } = await signInWithGoogle();
    setSocialLoading(null);
    if (error) {
      setSocialError(error);
    } else {
      // Success — show loading state while _layout bootstrap resolves and navigates.
      setSocialSignedIn(true);
    }
  }

  async function handleAppleSignIn() {
    setSocialLoading('apple');
    setSocialError('');
    const { error } = await signInWithApple();
    setSocialLoading(null);
    if (error) {
      setSocialError(error);
    } else {
      setSocialSignedIn(true);
    }
  }

  // ── Derived flags ────────────────────────────────────────────────────────────
  const inTabMode   = mode === 'signin' || mode === 'signup';
  const inEmailMode = mode === 'forgot'  || mode === 'resend';

  // ── Entrance animations ───────────────────────────────────────────────────────
  const headerOpacity = useRef(new Animated.Value(0)).current;
  const headerSlide   = useRef(new Animated.Value(-14)).current;
  const formOpacity   = useRef(new Animated.Value(0)).current;
  const formSlide     = useRef(new Animated.Value(22)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(headerOpacity, { toValue: 1, duration: 520, useNativeDriver: false }),
      Animated.timing(headerSlide,   { toValue: 0, duration: 520, useNativeDriver: false }),
      Animated.timing(formOpacity,   { toValue: 1, duration: 600, delay: 140, useNativeDriver: false }),
      Animated.timing(formSlide,     { toValue: 0, duration: 600, delay: 140, useNativeDriver: false }),
    ]).start();
  }, []);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: T.BG }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: 'center',
        padding: 28,
        paddingTop: Platform.OS === 'ios' ? 80 : 52,
        paddingBottom: 48,
        backgroundColor: T.BG,
      }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      showsVerticalScrollIndicator={false}
    >
      {/* ── App header — animated entrance ────────────────────────────────────── */}
      <Animated.View style={{
        alignItems:  'center',
        marginBottom: inTabMode ? (mode === 'signup' ? 20 : 28) : 22,
        opacity:     headerOpacity,
        transform:   [{ translateY: headerSlide }],
      }}>
        <BookGlyph />
        <Text style={{
          fontSize:      46,
          fontWeight:    '800',
          color:         T.INK,
          letterSpacing: -1.5,
          lineHeight:    52,
          marginBottom:  6,
        }}>
          readstack
        </Text>
        <View style={{ width: 32, height: 3, borderRadius: 2, backgroundColor: T.SAGE, marginBottom: 10 }} />
        <Text style={{ fontSize: 12, color: T.DUST, letterSpacing: 0.8, textTransform: 'uppercase' }}>
          your reading, together.
        </Text>
        {mode === 'signup' && (
          <Text style={{ fontSize: 12, color: '#a09588', marginTop: 12, textAlign: 'center', lineHeight: 18, maxWidth: 260 }}>
            Already on Goodreads? You can import your library right after signing up.
          </Text>
        )}
      </Animated.View>

      {/* ── Form card — floats above the ivory background ─────────────────────── */}
      <Animated.View style={{
        width:           '100%',
        backgroundColor: T.CARD,
        borderRadius:    24,
        paddingHorizontal: 22,
        paddingTop:      22,
        paddingBottom:   24,
        shadowColor:     T.INK,
        shadowOpacity:   0.07,
        shadowRadius:    24,
        shadowOffset:    { width: 0, height: 8 },
        elevation:       5,
        opacity:         formOpacity,
        transform:       [{ translateY: formSlide }],
      }}>

      {/* ── Secondary flow label ─────────────────────────────────────────────── */}
      {inEmailMode && (
        <Text style={{
          fontSize:     20,
          fontWeight:   '800',
          color:        T.INK,
          letterSpacing: -0.5,
          marginBottom: 18,
          alignSelf:    'flex-start',
        }}>
          {mode === 'forgot' ? 'Reset your password' : 'Resend confirmation'}
        </Text>
      )}

      {/* ── Mode toggle — editorial underline tabs ────────────────────────────── */}
      {inTabMode && (
        <View style={{ flexDirection: 'row', gap: 24, marginBottom: 22 }}>
          {(['signin', 'signup'] as const).map(m => (
            <TouchableOpacity
              key={m}
              onPress={() => switchMode(m)}
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            >
              <Text style={{
                fontSize:      17,
                fontWeight:    mode === m ? '700' : '400',
                color:         mode === m ? T.INK : T.DUST,
                letterSpacing: mode === m ? -0.3 : 0,
              }}>
                {m === 'signin' ? 'Sign in' : 'Create account'}
              </Text>
              <View style={{
                height:          2,
                borderRadius:    1,
                backgroundColor: mode === m ? T.SAGE : 'transparent',
                marginTop:       5,
              }} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Social sign-in buttons ─────────────────────────────────────────────── */}
      {inTabMode && (
        <View style={{ width: '100%', marginBottom: 20 }}>

          {/* Google */}
          <TouchableOpacity
            onPress={handleGoogleSignIn}
            disabled={socialLoading !== null || loading}
            style={{
              flexDirection:    'row',
              alignItems:       'center',
              justifyContent:   'center',
              borderWidth:      1,
              borderColor:      '#e8e3dc',
              borderRadius:     12,
              paddingVertical:  13,
              backgroundColor:  T.BG,
              gap:              10,
              opacity:          socialLoading !== null || loading ? 0.65 : 1,
            }}
          >
            {socialLoading === 'google' ? (
              <ActivityIndicator size="small" color={T.DUST} />
            ) : (
              <>
                <Ionicons name="logo-google" size={18} color="#4285F4" />
                <Text style={{ fontSize: 15, fontWeight: '600', color: T.INK }}>
                  Continue with Google
                </Text>
              </>
            )}
          </TouchableOpacity>

          {/* Apple — iOS only */}
          {appleAvailable && (
            <TouchableOpacity
              onPress={handleAppleSignIn}
              disabled={socialLoading !== null || loading}
              style={{
                flexDirection:    'row',
                alignItems:       'center',
                justifyContent:   'center',
                borderRadius:     12,
                paddingVertical:  13,
                backgroundColor:  '#000',
                gap:              10,
                marginTop:        10,
                opacity:          socialLoading !== null || loading ? 0.65 : 1,
              }}
            >
              {socialLoading === 'apple' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="logo-apple" size={18} color="#fff" />
                  <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>
                    Continue with Apple
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {/* Social error message */}
          {socialError !== '' && (
            <Text style={{
              fontSize: 13,
              color: '#b91c1c',
              textAlign: 'center',
              lineHeight: 20,
              marginTop: 10,
            }}>
              {socialError}
            </Text>
          )}

          {/* OR divider */}
          <View style={{
            flexDirection: 'row',
            alignItems:    'center',
            gap:           12,
            marginTop:     20,
          }}>
            <View style={{ flex: 1, height: 1, backgroundColor: '#ddd8d0' }} />
            <Text style={{ fontSize: 12, color: T.DUST, fontWeight: '500' }}>or</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: '#ddd8d0' }} />
          </View>

        </View>
      )}

      {/* ── Back link (forgot / resend) ───────────────────────────────────────── */}
      {inEmailMode && (
        <TouchableOpacity
          onPress={() => switchMode('signin')}
          style={{ alignSelf: 'flex-start', marginBottom: 20 }}
        >
          <Text style={{ fontSize: 13, color: T.STONE }}>← Back to sign in</Text>
        </TouchableOpacity>
      )}

      {/* ── Signup extra fields (name + username) ────────────────────────────── */}
      {mode === 'signup' && (
        <View style={{ width: '100%' }}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TextInput
              placeholder="First name"
              value={firstName}
              onChangeText={setFirstName}
              autoCapitalize="words"
              placeholderTextColor={T.DUST}
              style={[INPUT, { flex: 1, marginBottom: 0 }]}
            />
            <TextInput
              placeholder="Last name"
              value={lastName}
              onChangeText={setLastName}
              autoCapitalize="words"
              placeholderTextColor={T.DUST}
              style={[INPUT, { flex: 1, marginBottom: 0 }]}
            />
          </View>
          <View style={{ height: 10 }} />
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            borderWidth: 1,
            borderColor: '#e8e3dc',
            borderRadius: 12,
            backgroundColor: T.BG,
            marginBottom: 10,
            paddingHorizontal: 13,
          }}>
            <Text style={{ fontSize: 15, color: T.DUST, paddingVertical: 13 }}>@</Text>
            <TextInput
              placeholder="username"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor={T.DUST}
              style={{ flex: 1, fontSize: 15, color: T.INK, paddingVertical: 13 }}
            />
          </View>
          <Text style={{ fontSize: 12, color: T.DUST, marginBottom: 16, marginTop: -4, lineHeight: 17 }}>
            3–20 characters, letters, numbers, or underscores.
          </Text>
        </View>
      )}

      {/* ── Email field (all modes) ───────────────────────────────────────────── */}
      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholderTextColor={T.DUST}
        style={INPUT}
      />

      {/* ── Password field (signin / signup only) ────────────────────────────── */}
      {inTabMode && (
        <View style={{
          width: '100%',
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: '#e8e3dc',
          borderRadius: 12,
          backgroundColor: T.BG,
          marginBottom: 10,
          paddingRight: 4,
        }}>
          <TextInput
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            placeholderTextColor={T.DUST}
            style={{ flex: 1, fontSize: 15, color: T.INK, padding: 14 }}
          />
          <TouchableOpacity
            onPress={() => setShowPassword(p => !p)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ paddingHorizontal: 8 }}
          >
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={T.DUST}
            />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Confirm password field (signup only) ─────────────────────────────── */}
      {mode === 'signup' && (
        <View style={{
          width: '100%',
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: '#e8e3dc',
          borderRadius: 12,
          backgroundColor: T.BG,
          marginBottom: 18,
          paddingRight: 4,
        }}>
          <TextInput
            placeholder="Confirm password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry={!showConfirm}
            placeholderTextColor={T.DUST}
            style={{ flex: 1, fontSize: 15, color: T.INK, padding: 14 }}
          />
          <TouchableOpacity
            onPress={() => setShowConfirm(p => !p)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ paddingHorizontal: 8 }}
          >
            <Ionicons
              name={showConfirm ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={T.DUST}
            />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Bottom margin for signin (no confirm field) ───────────────────────── */}
      {mode === 'signin' && <View style={{ height: 8 }} />}

      {/* ── Submit button ─────────────────────────────────────────────────────── */}
      {loading ? (
        <ActivityIndicator color={T.DUST} style={{ marginBottom: 12 }} />
      ) : (
        <TouchableOpacity
          onPress={
            mode === 'signin'  ? handleSignIn :
            mode === 'signup'  ? handleSignUp :
            mode === 'forgot'  ? handleForgotPassword :
            handleResendConfirmation
          }
          disabled={emailSent}
          style={{
            width: '100%',
            backgroundColor: emailSent ? T.DUST : T.INK,
            paddingVertical: 16,
            borderRadius: 14,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: T.BG, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 }}>
            {mode === 'signin'  ? 'Sign in →' :
             mode === 'signup'  ? 'Create account →' :
             mode === 'forgot'  ? (emailSent ? 'Link sent ✓' : 'Send reset link →') :
             (emailSent ? 'Email sent ✓' : 'Resend confirmation →')}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Signin helper links ───────────────────────────────────────────────── */}
      {mode === 'signin' && (
        <View style={{ width: '100%', marginTop: 18, gap: 10 }}>
          <TouchableOpacity onPress={() => switchMode('forgot')}>
            <Text style={{ fontSize: 13, color: T.STONE, textAlign: 'center' }}>
              Forgot your password?
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => switchMode('resend')}>
            <Text style={{ fontSize: 13, color: T.STONE, textAlign: 'center' }}>
              Didn't receive a confirmation email?
            </Text>
          </TouchableOpacity>
        </View>
      )}

      </Animated.View>{/* end form card */}

      {/* ── Status message ────────────────────────────────────────────────────── */}
      {status !== '' && !duplicateEmail && !emailConfirmPending && !signUpRateLimited && (
        <View style={{ width: '100%', marginTop: 18 }}>
          <Text style={{
            textAlign: 'center',
            fontSize: 13,
            color: statusIsError ? '#b91c1c' : T.STONE,
            lineHeight: 20,
          }}>
            {status}
          </Text>
          {/* Inline resend CTA — shown when the error is "email not confirmed" */}
          {offerResend && mode === 'signin' && (
            <TouchableOpacity
              onPress={() => switchMode('resend')}
              style={{ marginTop: 10, alignItems: 'center' }}
            >
              <Text style={{ fontSize: 13, color: T.INK, fontWeight: '600', textDecorationLine: 'underline' }}>
                Resend confirmation email
              </Text>
            </TouchableOpacity>
          )}

          {/* ── Provider-mismatch hint (sign-in failures) ─────────────────────
              Shown on EVERY sign-in failure, not only when we know the account
              is social-only.  Supabase deliberately returns the same
              invalid_credentials error for wrong-password, unknown-email, and
              "this email is a Google/Apple identity with no password" — so
              showing this on every failure is the only way to help the
              social-only user without leaking which case they hit. */}
          {statusIsError && mode === 'signin' && !offerResend && (
            <View style={{
              marginTop: 14,
              paddingTop: 14,
              borderTopWidth: 1,
              borderTopColor: T.BORDER,
            }}>
              <Text style={{
                textAlign: 'center',
                fontSize: 12,
                color: T.STONE,
                lineHeight: 18,
              }}>
                If you originally signed up with Google{appleAvailable ? ' or Apple' : ''},
                use the {appleAvailable ? 'buttons' : 'button'} above to continue.
              </Text>
              <TouchableOpacity
                onPress={() => switchMode('forgot')}
                style={{ marginTop: 10, alignItems: 'center' }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={{
                  fontSize: 13,
                  color: T.INK,
                  fontWeight: '600',
                  textDecorationLine: 'underline',
                }}>
                  Reset your password
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Provider-mismatch hint (forgot-password "sent") ──────────────
              Reset emails are never sent for social-only identities, so the
              "we sent a link" success message can feel like a silent no-op
              for those users.  This footnote acknowledges that case without
              confirming whether the address was social-only. */}
          {!statusIsError && emailSent && mode === 'forgot' && (
            <View style={{
              marginTop: 14,
              paddingTop: 14,
              borderTopWidth: 1,
              borderTopColor: T.BORDER,
            }}>
              <Text style={{
                textAlign: 'center',
                fontSize: 12,
                color: T.STONE,
                lineHeight: 18,
              }}>
                No email arriving? If you originally signed up with Google
                {appleAvailable ? ' or Apple' : ''}, password reset doesn't
                apply — sign in with that {appleAvailable ? 'provider' : 'option'} instead.
              </Text>
              <TouchableOpacity
                onPress={() => switchMode('signin')}
                style={{ marginTop: 10, alignItems: 'center' }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={{
                  fontSize: 13,
                  color: T.INK,
                  fontWeight: '600',
                  textDecorationLine: 'underline',
                }}>
                  Back to sign-in options
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* ── Signup rate-limit panel ───────────────────────────────────────────── */}
      {signUpRateLimited && (
        <View style={{
          marginTop: 24,
          width: '100%',
          backgroundColor: '#f5ede0',
          borderRadius: 14,
          padding: 18,
          borderWidth: 1,
          borderColor: '#d8c9b4',
        }}>
          <Text style={{
            fontSize: 14,
            fontWeight: '700',
            color: T.INK,
            marginBottom: 6,
          }}>
            Too many emails sent
          </Text>
          <Text style={{
            fontSize: 13,
            color: T.STONE,
            lineHeight: 20,
            marginBottom: 16,
          }}>
            We've sent too many emails to this address recently. Please wait a minute before trying again.
          </Text>
          <TouchableOpacity
            onPress={() => setSignUpRateLimited(false)}
            style={{
              borderWidth: 1,
              borderColor: T.BORDER,
              borderRadius: 10,
              paddingVertical: 10,
              alignItems: 'center',
              backgroundColor: T.CARD,
            }}
          >
            <Text style={{ fontSize: 13, color: T.STONE, fontWeight: '600' }}>Try again later</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── New signup: email confirmation pending ────────────────────────────── */}
      {emailConfirmPending && (
        <View style={{
          marginTop: 24,
          width: '100%',
          backgroundColor: '#f5ede0',
          borderRadius: 14,
          padding: 18,
          borderWidth: 1,
          borderColor: '#d8c9b4',
        }}>
          <Text style={{
            fontSize: 14,
            fontWeight: '700',
            color: T.INK,
            marginBottom: 6,
          }}>
            Almost there — check your email
          </Text>
          <Text style={{
            fontSize: 13,
            color: T.STONE,
            lineHeight: 20,
            marginBottom: 16,
          }}>
            We sent a confirmation link to {email.trim() || 'your email'}. Click it to activate your account.
          </Text>

          {/* Inline resend feedback */}
          {resendSent && (
            <Text style={{ fontSize: 13, color: T.SAGE, fontWeight: '600', marginBottom: 10, textAlign: 'center' }}>
              Sent! Check your inbox again.
            </Text>
          )}
          {resendRateLimited && (
            <View style={{
              backgroundColor: '#f5ede0',
              borderRadius: 10,
              padding: 12,
              borderWidth: 1,
              borderColor: '#d8c9b4',
              marginBottom: 10,
            }}>
              <Text style={{ fontSize: 13, color: T.STONE, lineHeight: 19 }}>
                We've sent too many emails to this address recently. Please wait a minute before trying again.
              </Text>
            </View>
          )}

          {!resendSent && (
            <TouchableOpacity
              onPress={handleInlineResend}
              disabled={loading}
              style={{
                borderWidth: 1,
                borderColor: T.BORDER,
                borderRadius: 10,
                paddingVertical: 10,
                alignItems: 'center',
                backgroundColor: T.CARD,
              }}
            >
              <Text style={{ fontSize: 13, color: T.STONE, fontWeight: '600' }}>
                {resendRateLimited ? 'Try resending later' : 'Resend confirmation email'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Duplicate email recovery panel ────────────────────────────────────── */}
      {duplicateEmail && (
        <View style={{
          marginTop: 24,
          width: '100%',
          backgroundColor: '#f5ede0',
          borderRadius: 14,
          padding: 18,
          borderWidth: 1,
          borderColor: '#d8c9b4',
        }}>
          <Text style={{
            fontSize: 14,
            fontWeight: '700',
            color: T.INK,
            marginBottom: 6,
          }}>
            An account already exists with this email.
          </Text>
          <Text style={{
            fontSize: 13,
            color: T.STONE,
            lineHeight: 20,
            marginBottom: 18,
          }}>
            Sign in to your existing account, reset your password if you've forgotten it, or resend your confirmation email if you haven't confirmed yet.
          </Text>

          <TouchableOpacity
            onPress={() => switchMode('signin')}
            style={{
              backgroundColor: T.INK,
              borderRadius: 10,
              paddingVertical: 11,
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Text style={{ color: T.BG, fontSize: 14, fontWeight: '600' }}>Sign In</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => switchMode('forgot')}
            style={{
              borderWidth: 1,
              borderColor: T.BORDER,
              borderRadius: 10,
              paddingVertical: 10,
              alignItems: 'center',
              backgroundColor: T.CARD,
              marginBottom: 8,
            }}
          >
            <Text style={{ fontSize: 13, color: T.STONE, fontWeight: '500' }}>Reset Password</Text>
          </TouchableOpacity>

          {/* Resend confirmation — for unconfirmed accounts */}
          {resendSent ? (
            <Text style={{ fontSize: 13, color: T.SAGE, fontWeight: '600', textAlign: 'center', marginTop: 4 }}>
              Confirmation email sent — check your inbox.
            </Text>
          ) : (
            <>
              {resendRateLimited && (
                <View style={{
                  backgroundColor: '#f5ede0',
                  borderRadius: 10,
                  padding: 10,
                  borderWidth: 1,
                  borderColor: '#d8c9b4',
                  marginBottom: 8,
                }}>
                  <Text style={{ fontSize: 12, color: T.STONE, lineHeight: 18 }}>
                    Too many emails sent recently — wait a minute before trying again.
                  </Text>
                </View>
              )}
              <TouchableOpacity
                onPress={handleInlineResend}
                disabled={loading}
                style={{
                  borderWidth: 1,
                  borderColor: T.BORDER,
                  borderRadius: 10,
                  paddingVertical: 10,
                  alignItems: 'center',
                  backgroundColor: T.CARD,
                }}
              >
                <Text style={{ fontSize: 13, color: T.STONE, fontWeight: '500' }}>
                  {resendRateLimited ? 'Try resending later' : 'Resend confirmation email'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* ── After-send back link (forgot / resend) ────────────────────────────── */}
      {inEmailMode && emailSent && (
        <TouchableOpacity
          onPress={() => switchMode('signin')}
          style={{ marginTop: 18 }}
        >
          <Text style={{ fontSize: 13, color: T.STONE, textAlign: 'center' }}>← Back to sign in</Text>
        </TouchableOpacity>
      )}
    </ScrollView>

    {/* ── Post-social-auth loading overlay ─────────────────────────────────────
        Shown after signInWithGoogle / signInWithApple returns success while the
        _layout.tsx bootstrap resolves and the routing guard navigates. Without
        this the screen goes idle for 1–3 s with no visible feedback. */}
    {socialSignedIn && (
      <View style={{
        position:        'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: T.BG,
        alignItems:      'center',
        justifyContent:  'center',
        gap:             20,
      }}>
        <BookStackLoader size="sm" />
        <Text style={{ fontSize: 15, fontWeight: '600', color: T.INK, letterSpacing: -0.2 }}>
          Signed in — loading your account…
        </Text>
      </View>
    )}

    </KeyboardAvoidingView>
  );
}
