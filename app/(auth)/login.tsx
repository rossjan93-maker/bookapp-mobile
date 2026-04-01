import { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';

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
    return { text: 'Email or password is incorrect.', offerResend: false };
  }

  // Network / server errors
  return { text: 'Something went wrong. Check your connection and try again.', offerResend: false };
}

function mapSignUpError(error: { message?: string; status?: number }): string {
  const status = error.status ?? 0;
  if (status === 429) return 'Too many attempts — wait a moment and try again.';
  // Other raw errors from signUp (shouldn't surface to the user)
  return 'Something went wrong. Please try again.';
}

// ─── Shared style primitives ─────────────────────────────────────────────────
const INPUT: object = {
  width: '100%' as const,
  borderWidth: 1,
  borderColor: '#e7e5e4',
  borderRadius: 10,
  padding: 13,
  fontSize: 15,
  color: '#1c1917',
  backgroundColor: '#fff',
  marginBottom: 10,
};

// ─── Screen ──────────────────────────────────────────────────────────────────
export default function LoginScreen() {
  if (!hasSupabaseConfig || !supabase) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf9f7' }}>
        <Text style={{ color: '#78716c', fontSize: 14 }}>Supabase not configured.</Text>
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
  // duplicateEmail  — shown when signup detects an existing account on this email
  // emailConfirmPending — shown after a new signup; waiting for confirmation
  // emailSent       — shown after forgot / resend flow completes
  const [duplicateEmail, setDuplicateEmail]           = useState(false);
  const [emailConfirmPending, setEmailConfirmPending] = useState(false);
  const [emailSent, setEmailSent]                     = useState(false);

  // ── Mode switching ──────────────────────────────────────────────────────────
  function switchMode(m: Mode) {
    setMode(m);
    setStatus('');
    setStatusIsError(false);
    setOfferResend(false);
    setDuplicateEmail(false);
    setEmailConfirmPending(false);
    setEmailSent(false);
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirm(false);
  }

  // ── Sign up ─────────────────────────────────────────────────────────────────
  async function handleSignUp() {
    setLoading(true);
    setStatus('');
    setStatusIsError(false);
    setOfferResend(false);
    setDuplicateEmail(false);
    setEmailConfirmPending(false);

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
      },
    });

    if (error) {
      setStatus(mapSignUpError(error));
      setStatusIsError(true);
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

    const { error } = await supabase!.auth.resetPasswordForEmail(email.trim());

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
    if (error && error.status === 429) {
      setStatus('Too many requests — please wait a moment and try again.');
      setStatusIsError(true);
      return;
    }

    setEmailSent(true);
    setStatus('If that address has an unconfirmed account, we sent a new confirmation link. Check your email.');
    setStatusIsError(false);
  }

  // ── Derived flags ────────────────────────────────────────────────────────────
  const inTabMode   = mode === 'signin' || mode === 'signup';
  const inEmailMode = mode === 'forgot'  || mode === 'resend';

  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 28,
        backgroundColor: '#faf9f7',
      }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── App name ─────────────────────────────────────────────────────────── */}
      <Text style={{
        fontSize: 28,
        fontWeight: '800',
        color: '#1c1917',
        letterSpacing: -0.5,
        marginBottom: 8,
      }}>
        readstack
      </Text>
      <Text style={{ fontSize: 14, color: '#a8a29e', marginBottom: inTabMode ? (mode === 'signup' ? 10 : 36) : 28 }}>
        Your reading, together.
      </Text>

      {/* ── Goodreads nudge (signup only) ────────────────────────────────────── */}
      {mode === 'signup' && (
        <Text style={{ fontSize: 12, color: '#c4b5a5', marginBottom: 28, textAlign: 'center', lineHeight: 18 }}>
          Already on Goodreads? You can import your library right after signing up.
        </Text>
      )}

      {/* ── Secondary flow label ─────────────────────────────────────────────── */}
      {inEmailMode && (
        <Text style={{
          fontSize: 13,
          fontWeight: '600',
          color: '#57534e',
          marginBottom: 18,
          alignSelf: 'flex-start',
        }}>
          {mode === 'forgot' ? 'Reset your password' : 'Resend confirmation email'}
        </Text>
      )}

      {/* ── Mode toggle (signin / signup) ────────────────────────────────────── */}
      {inTabMode && (
        <View style={{
          flexDirection: 'row',
          backgroundColor: '#f0ede8',
          borderRadius: 10,
          padding: 3,
          marginBottom: 24,
          width: '100%',
        }}>
          {(['signin', 'signup'] as const).map(m => (
            <TouchableOpacity
              key={m}
              onPress={() => switchMode(m)}
              style={{
                flex: 1,
                paddingVertical: 9,
                borderRadius: 8,
                backgroundColor: mode === m ? '#fff' : 'transparent',
                alignItems: 'center',
                shadowColor: mode === m ? '#000' : 'transparent',
                shadowOpacity: mode === m ? 0.06 : 0,
                shadowRadius: mode === m ? 4 : 0,
                shadowOffset: { width: 0, height: 1 },
                elevation: mode === m ? 1 : 0,
              }}
            >
              <Text style={{
                fontSize: 14,
                fontWeight: mode === m ? '600' : '400',
                color: mode === m ? '#1c1917' : '#78716c',
              }}>
                {m === 'signin' ? 'Sign In' : 'Create Account'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Back link (forgot / resend) ───────────────────────────────────────── */}
      {inEmailMode && (
        <TouchableOpacity
          onPress={() => switchMode('signin')}
          style={{ alignSelf: 'flex-start', marginBottom: 20 }}
        >
          <Text style={{ fontSize: 13, color: '#78716c' }}>← Back to sign in</Text>
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
              placeholderTextColor="#a8a29e"
              style={[INPUT, { flex: 1, marginBottom: 0 }]}
            />
            <TextInput
              placeholder="Last name"
              value={lastName}
              onChangeText={setLastName}
              autoCapitalize="words"
              placeholderTextColor="#a8a29e"
              style={[INPUT, { flex: 1, marginBottom: 0 }]}
            />
          </View>
          <View style={{ height: 10 }} />
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            borderWidth: 1,
            borderColor: '#e7e5e4',
            borderRadius: 10,
            backgroundColor: '#fff',
            marginBottom: 10,
            paddingHorizontal: 13,
          }}>
            <Text style={{ fontSize: 15, color: '#a8a29e', paddingVertical: 13 }}>@</Text>
            <TextInput
              placeholder="username"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor="#a8a29e"
              style={{ flex: 1, fontSize: 15, color: '#1c1917', paddingVertical: 13 }}
            />
          </View>
          <Text style={{ fontSize: 12, color: '#a8a29e', marginBottom: 16, marginTop: -4, lineHeight: 17 }}>
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
        placeholderTextColor="#a8a29e"
        style={INPUT}
      />

      {/* ── Password field (signin / signup only) ────────────────────────────── */}
      {inTabMode && (
        <View style={{
          width: '100%',
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: '#e7e5e4',
          borderRadius: 10,
          backgroundColor: '#fff',
          marginBottom: 10,
          paddingRight: 4,
        }}>
          <TextInput
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            placeholderTextColor="#a8a29e"
            style={{ flex: 1, fontSize: 15, color: '#1c1917', padding: 13 }}
          />
          <TouchableOpacity
            onPress={() => setShowPassword(p => !p)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ paddingHorizontal: 8 }}
          >
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color="#a8a29e"
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
          borderColor: '#e7e5e4',
          borderRadius: 10,
          backgroundColor: '#fff',
          marginBottom: 18,
          paddingRight: 4,
        }}>
          <TextInput
            placeholder="Confirm password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry={!showConfirm}
            placeholderTextColor="#a8a29e"
            style={{ flex: 1, fontSize: 15, color: '#1c1917', padding: 13 }}
          />
          <TouchableOpacity
            onPress={() => setShowConfirm(p => !p)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ paddingHorizontal: 8 }}
          >
            <Ionicons
              name={showConfirm ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color="#a8a29e"
            />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Bottom margin for signin (no confirm field) ───────────────────────── */}
      {mode === 'signin' && <View style={{ height: 8 }} />}

      {/* ── Submit button ─────────────────────────────────────────────────────── */}
      {loading ? (
        <ActivityIndicator color="#78716c" style={{ marginBottom: 12 }} />
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
            backgroundColor: emailSent ? '#a8a29e' : '#1c1917',
            paddingVertical: 14,
            borderRadius: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
            {mode === 'signin'  ? 'Sign In' :
             mode === 'signup'  ? 'Create Account' :
             mode === 'forgot'  ? (emailSent ? 'Link sent' : 'Send reset link') :
             (emailSent ? 'Email sent' : 'Resend confirmation')}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Signin helper links ───────────────────────────────────────────────── */}
      {mode === 'signin' && (
        <View style={{ width: '100%', marginTop: 18, gap: 10 }}>
          <TouchableOpacity onPress={() => switchMode('forgot')}>
            <Text style={{ fontSize: 13, color: '#78716c', textAlign: 'center' }}>
              Forgot your password?
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => switchMode('resend')}>
            <Text style={{ fontSize: 13, color: '#78716c', textAlign: 'center' }}>
              Didn't receive a confirmation email?
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Status message ────────────────────────────────────────────────────── */}
      {status !== '' && !duplicateEmail && !emailConfirmPending && (
        <View style={{ width: '100%', marginTop: 18 }}>
          <Text style={{
            textAlign: 'center',
            fontSize: 13,
            color: statusIsError ? '#b91c1c' : '#57534e',
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
              <Text style={{ fontSize: 13, color: '#1c1917', fontWeight: '600', textDecorationLine: 'underline' }}>
                Resend confirmation email
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── New signup: email confirmation pending ────────────────────────────── */}
      {emailConfirmPending && (
        <View style={{
          marginTop: 24,
          width: '100%',
          backgroundColor: '#f0fdf4',
          borderRadius: 12,
          padding: 18,
          borderWidth: 1,
          borderColor: '#bbf7d0',
        }}>
          <Text style={{
            fontSize: 14,
            fontWeight: '700',
            color: '#15803d',
            marginBottom: 6,
          }}>
            Almost there — check your email
          </Text>
          <Text style={{
            fontSize: 13,
            color: '#166534',
            lineHeight: 20,
            marginBottom: 16,
          }}>
            We sent a confirmation link to {email.trim() || 'your email'}. Click it to activate your account.
          </Text>
          <TouchableOpacity
            onPress={() => switchMode('resend')}
            style={{
              borderWidth: 1,
              borderColor: '#86efac',
              borderRadius: 9,
              paddingVertical: 10,
              alignItems: 'center',
              backgroundColor: '#fff',
            }}
          >
            <Text style={{ fontSize: 13, color: '#15803d', fontWeight: '600' }}>Resend confirmation email</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Duplicate email recovery panel ────────────────────────────────────── */}
      {duplicateEmail && (
        <View style={{
          marginTop: 24,
          width: '100%',
          backgroundColor: '#fef9f0',
          borderRadius: 12,
          padding: 18,
          borderWidth: 1,
          borderColor: '#fde68a',
        }}>
          <Text style={{
            fontSize: 14,
            fontWeight: '700',
            color: '#92400e',
            marginBottom: 6,
          }}>
            An account already exists with this email.
          </Text>
          <Text style={{
            fontSize: 13,
            color: '#78350f',
            lineHeight: 20,
            marginBottom: 18,
          }}>
            Sign in to your existing account, or reset your password if you've forgotten it.
          </Text>

          <TouchableOpacity
            onPress={() => switchMode('signin')}
            style={{
              backgroundColor: '#1c1917',
              borderRadius: 9,
              paddingVertical: 11,
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Sign In</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => switchMode('forgot')}
            style={{
              borderWidth: 1,
              borderColor: '#d6cfc8',
              borderRadius: 9,
              paddingVertical: 10,
              alignItems: 'center',
              backgroundColor: '#fff',
            }}
          >
            <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500' }}>Reset Password</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── After-send back link (forgot / resend) ────────────────────────────── */}
      {inEmailMode && emailSent && (
        <TouchableOpacity
          onPress={() => switchMode('signin')}
          style={{ marginTop: 18 }}
        >
          <Text style={{ fontSize: 13, color: '#78716c', textAlign: 'center' }}>← Back to sign in</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}
