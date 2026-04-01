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

  // ── Post-action states ───────────────────────────────────────────────────────
  // signupAmbiguous — shown after signup returns user=null (may be duplicate email)
  // emailSent       — shown after forgot / resend flow completes
  const [signupAmbiguous, setSignupAmbiguous] = useState(false);
  const [emailSent, setEmailSent]             = useState(false);

  // ── Mode switching ──────────────────────────────────────────────────────────
  function switchMode(m: Mode) {
    setMode(m);
    setStatus('');
    setStatusIsError(false);
    setSignupAmbiguous(false);
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
    setSignupAmbiguous(false);

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
      // Supabase error — show as-is (e.g. "Password should be at least 6 characters")
      setStatus(error.message);
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
      // Unique constraint violation — username is already taken.
      if (profileError?.code === '23505') {
        setStatus('That username is already taken. Please choose another.');
        setStatusIsError(true);
        setLoading(false);
        return;
      }
      setStatus('Check your email to confirm your account.');
      setStatusIsError(false);
    } else {
      // ── Ambiguous outcome ────────────────────────────────────────────────────
      // Supabase returned user=null without an error. This happens when email
      // confirmation is enabled and the address already has an account — Supabase
      // does not reveal this to prevent email enumeration. We surface a neutral
      // recovery panel so the user can find their way forward without guessing.
      setSignupAmbiguous(true);
    }

    setLoading(false);
  }

  // ── Sign in ─────────────────────────────────────────────────────────────────
  async function handleSignIn() {
    setLoading(true);
    setStatus('');
    setStatusIsError(false);
    const { error } = await supabase!.auth.signInWithPassword({
      email:    email.trim(),
      password,
    });
    if (error) {
      setStatus(error.message);
      setStatusIsError(true);
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

      {/* ── Ambiguous signup recovery panel ──────────────────────────────────── */}
      {signupAmbiguous && (
        <View style={{
          marginTop: 24,
          width: '100%',
          backgroundColor: '#f5f0e8',
          borderRadius: 12,
          padding: 18,
          borderWidth: 1,
          borderColor: '#e7ddd0',
        }}>
          <Text style={{
            fontSize: 14,
            fontWeight: '600',
            color: '#1c1917',
            marginBottom: 8,
            lineHeight: 20,
          }}>
            Check your email
          </Text>
          <Text style={{
            fontSize: 13,
            color: '#57534e',
            lineHeight: 20,
            marginBottom: 18,
          }}>
            If this address is new, we sent a confirmation link.{'\n'}
            If you already have an account, sign in or reset your password below.
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

          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              onPress={() => switchMode('forgot')}
              style={{
                flex: 1,
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

            <TouchableOpacity
              onPress={() => switchMode('resend')}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: '#d6cfc8',
                borderRadius: 9,
                paddingVertical: 10,
                alignItems: 'center',
                backgroundColor: '#fff',
              }}
            >
              <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500' }}>Resend Email</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Status message ────────────────────────────────────────────────────── */}
      {status !== '' && !signupAmbiguous && (
        <Text style={{
          marginTop: 18,
          textAlign: 'center',
          fontSize: 13,
          color: statusIsError ? '#b91c1c' : '#57534e',
          lineHeight: 20,
        }}>
          {status}
        </Text>
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
