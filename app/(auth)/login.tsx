import { useState } from 'react';
import {
  ActivityIndicator,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  if (!hasSupabaseConfig || !supabase) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text>Supabase not configured.</Text>
      </View>
    );
  }

  async function handleSignUp() {
    setLoading(true);
    setStatus('');
    const { error } = await supabase!.auth.signUp({ email, password });
    if (error) {
      setStatus('Sign up error: ' + error.message);
    } else {
      setStatus('Sign up submitted. Check your email to confirm your account.');
    }
    setLoading(false);
  }

  async function handleSignIn() {
    setLoading(true);
    setStatus('');
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    if (error) {
      setStatus('Sign in error: ' + error.message);
    } else {
      setStatus('Signed in successfully.');
    }
    setLoading(false);
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ fontSize: 18, marginBottom: 24 }}>Login</Text>

      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        style={{
          width: '100%',
          borderWidth: 1,
          borderColor: '#ccc',
          borderRadius: 6,
          padding: 10,
          marginBottom: 12,
        }}
      />

      <TextInput
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        style={{
          width: '100%',
          borderWidth: 1,
          borderColor: '#ccc',
          borderRadius: 6,
          padding: 10,
          marginBottom: 20,
        }}
      />

      {loading ? (
        <ActivityIndicator style={{ marginBottom: 12 }} />
      ) : (
        <>
          <TouchableOpacity
            onPress={handleSignIn}
            style={{
              width: '100%',
              backgroundColor: '#000',
              padding: 12,
              borderRadius: 6,
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <Text style={{ color: '#fff' }}>Sign In</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleSignUp}
            style={{
              width: '100%',
              borderWidth: 1,
              borderColor: '#000',
              padding: 12,
              borderRadius: 6,
              alignItems: 'center',
            }}
          >
            <Text>Sign Up</Text>
          </TouchableOpacity>
        </>
      )}

      {status !== '' && (
        <Text style={{ marginTop: 20, textAlign: 'center', color: '#555' }}>
          {status}
        </Text>
      )}
    </View>
  );
}
