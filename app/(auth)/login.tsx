import { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';

type Mode = 'signin' | 'signup';

export default function LoginScreen() {
  const [mode, setMode]           = useState<Mode>('signin');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [username, setUsername]   = useState('');
  const [loading, setLoading]     = useState(false);
  const [status, setStatus]       = useState('');

  if (!hasSupabaseConfig || !supabase) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf9f7' }}>
        <Text style={{ color: '#78716c', fontSize: 14 }}>Supabase not configured.</Text>
      </View>
    );
  }

  async function handleSignUp() {
    setLoading(true);
    setStatus('');

    if (!firstName.trim()) {
      setStatus('First name is required.');
      setLoading(false);
      return;
    }
    if (!lastName.trim()) {
      setStatus('Last name is required.');
      setLoading(false);
      return;
    }
    const uname = username.trim().toLowerCase().replace(/\s+/g, '');
    if (!uname) {
      setStatus('Please choose a username.');
      setLoading(false);
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) {
      setStatus('Username must be 3–20 characters: letters, numbers, or underscores.');
      setLoading(false);
      return;
    }

    const { data: authData, error } = await supabase!.auth.signUp({
      email,
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
      setStatus(error.message);
    } else {
      if (authData?.user) {
        await supabase!.from('profiles').upsert({
          id:         authData.user.id,
          username:   uname,
          first_name: firstName.trim(),
          last_name:  lastName.trim(),
        });
      }
      setStatus('Check your email to confirm your account.');
    }
    setLoading(false);
  }

  async function handleSignIn() {
    setLoading(true);
    setStatus('');
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    if (error) {
      setStatus(error.message);
    }
    setLoading(false);
  }

  const inputStyle = {
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
      {/* ── App name ── */}
      <Text style={{
        fontSize: 28,
        fontWeight: '800',
        color: '#1c1917',
        letterSpacing: -0.5,
        marginBottom: 8,
      }}>
        readstack
      </Text>
      <Text style={{ fontSize: 14, color: '#a8a29e', marginBottom: mode === 'signup' ? 10 : 36 }}>
        Your reading, together.
      </Text>
      {mode === 'signup' && (
        <Text style={{ fontSize: 12, color: '#c4b5a5', marginBottom: 28, textAlign: 'center', lineHeight: 18 }}>
          Already on Goodreads? You can import your library right after signing up.
        </Text>
      )}

      {/* ── Mode toggle ── */}
      <View style={{
        flexDirection: 'row',
        backgroundColor: '#f0ede8',
        borderRadius: 10,
        padding: 3,
        marginBottom: 24,
        width: '100%',
      }}>
        {(['signin', 'signup'] as Mode[]).map(m => (
          <TouchableOpacity
            key={m}
            onPress={() => { setMode(m); setStatus(''); }}
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

      {/* ── Signup fields ── */}
      {mode === 'signup' && (
        <View style={{ width: '100%' }}>
          {/* Name row */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TextInput
              placeholder="First name"
              value={firstName}
              onChangeText={setFirstName}
              autoCapitalize="words"
              placeholderTextColor="#a8a29e"
              style={[inputStyle, { flex: 1 }]}
            />
            <TextInput
              placeholder="Last name"
              value={lastName}
              onChangeText={setLastName}
              autoCapitalize="words"
              placeholderTextColor="#a8a29e"
              style={[inputStyle, { flex: 1 }]}
            />
          </View>

          {/* Username */}
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

      {/* ── Email + password ── */}
      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholderTextColor="#a8a29e"
        style={inputStyle}
      />
      <TextInput
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholderTextColor="#a8a29e"
        style={[inputStyle, { marginBottom: 18 }]}
      />

      {/* ── Submit ── */}
      {loading ? (
        <ActivityIndicator color="#78716c" style={{ marginBottom: 12 }} />
      ) : (
        <TouchableOpacity
          onPress={mode === 'signin' ? handleSignIn : handleSignUp}
          style={{
            width: '100%',
            backgroundColor: '#1c1917',
            paddingVertical: 14,
            borderRadius: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
            {mode === 'signin' ? 'Sign In' : 'Create Account'}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Status message ── */}
      {status !== '' && (
        <Text style={{
          marginTop: 18,
          textAlign: 'center',
          fontSize: 13,
          color: status.includes('error') || status.includes('Error') || status.includes('required') || status.includes('must be') || status.includes('Please') ? '#b91c1c' : '#57534e',
          lineHeight: 20,
        }}>
          {status}
        </Text>
      )}
    </ScrollView>
  );
}
