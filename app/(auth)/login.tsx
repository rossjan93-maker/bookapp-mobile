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
    const { error } = await supabase!.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName.trim() || null,
          last_name:  lastName.trim()  || null,
        },
      },
    });
    if (error) {
      setStatus(error.message);
    } else {
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
        flex: 1,
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
      <Text style={{ fontSize: 14, color: '#a8a29e', marginBottom: 36 }}>
        Your reading, together.
      </Text>

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

      {/* ── Name fields (signup only) ── */}
      {mode === 'signup' && (
        <View style={{ width: '100%' }}>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 0 }}>
            <TextInput
              placeholder="First name"
              value={firstName}
              onChangeText={setFirstName}
              autoCapitalize="words"
              placeholderTextColor="#a8a29e"
              style={[inputStyle, { flex: 1, marginBottom: 10 }]}
            />
            <TextInput
              placeholder="Last name"
              value={lastName}
              onChangeText={setLastName}
              autoCapitalize="words"
              placeholderTextColor="#a8a29e"
              style={[inputStyle, { flex: 1, marginBottom: 10 }]}
            />
          </View>
          <Text style={{ fontSize: 12, color: '#a8a29e', marginBottom: 14, marginTop: -4 }}>
            Optional — you can add this later.
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
          color: status.includes('error') || status.includes('Error') ? '#b91c1c' : '#57534e',
          lineHeight: 20,
        }}>
          {status}
        </Text>
      )}
    </ScrollView>
  );
}
