/**
 * app/reset-password.tsx
 *
 * Set-new-password screen — only reachable after a PASSWORD_RECOVERY event.
 * The user arrives here via the "Reset password" email link; they are already
 * authenticated with a short-lived recovery session. Once they submit a new
 * password, supabase.auth.updateUser persists the change and the session
 * transitions to a normal SIGNED_IN state.
 *
 * Routing:
 *   entry  → passwordRecovery=true in BootstrapContext (set by _layout.tsx)
 *   exit   → clearPasswordRecovery() + router.replace('/') after success
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useBootstrap } from './_layout';

// ─── Shared input style ───────────────────────────────────────────────────────
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

export default function ResetPasswordScreen() {
  const router                             = useRouter();
  const { clearPasswordRecovery }          = useBootstrap();

  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword,    setShowPassword]    = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState('');
  const [done,            setDone]            = useState(false);

  async function handleSetPassword() {
    setError('');

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    const { error: updateError } = await supabase!.auth.updateUser({ password });

    setLoading(false);

    if (updateError) {
      const raw = updateError.message.toLowerCase();
      if (raw.includes('same password') || raw.includes('different from')) {
        setError('Please choose a new password that is different from your current one.');
      } else if (raw.includes('rate limit') || raw.includes('too many')) {
        setError('Too many attempts — wait a moment and try again.');
      } else {
        setError('Could not update your password. Please try again.');
      }
      return;
    }

    // Success — clear recovery state so the routing guard doesn't loop back
    setDone(true);
    clearPasswordRecovery();
    router.replace('/');
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#f5f1ec' }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: 'center',
          padding: 28,
          paddingTop: Platform.OS === 'ios' ? 90 : 60,
          paddingBottom: 48,
          backgroundColor: '#f5f1ec',
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ────────────────────────────────────────────────────────── */}
        <View style={{ alignItems: 'center', marginBottom: 32, width: '100%' }}>
          <Text style={{
            fontSize: 28,
            fontWeight: '800',
            color: '#231f1b',
            letterSpacing: -0.8,
            marginBottom: 8,
          }}>
            Set new password
          </Text>
          <Text style={{
            fontSize: 14,
            color: '#6b635c',
            textAlign: 'center',
            lineHeight: 21,
            maxWidth: 300,
          }}>
            Choose a strong password for your account. You'll use it to sign in going forward.
          </Text>
        </View>

        {/* ── Form ──────────────────────────────────────────────────────────── */}
        <View style={{ width: '100%', maxWidth: 380 }}>
          {/* New password */}
          <View style={{ position: 'relative' }}>
            <TextInput
              style={INPUT}
              placeholder="New password"
              placeholderTextColor="#9e958d"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              returnKeyType="next"
              editable={!loading && !done}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(v => !v)}
              style={{ position: 'absolute', right: 14, top: 14 }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color="#9e958d"
              />
            </TouchableOpacity>
          </View>

          {/* Confirm password */}
          <View style={{ position: 'relative' }}>
            <TextInput
              style={INPUT}
              placeholder="Confirm new password"
              placeholderTextColor="#9e958d"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={handleSetPassword}
              editable={!loading && !done}
            />
            <TouchableOpacity
              onPress={() => setShowConfirm(v => !v)}
              style={{ position: 'absolute', right: 14, top: 14 }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={showConfirm ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color="#9e958d"
              />
            </TouchableOpacity>
          </View>

          {/* Error */}
          {!!error && (
            <Text style={{
              fontSize: 13,
              color: '#b91c1c',
              marginBottom: 12,
              lineHeight: 19,
            }}>
              {error}
            </Text>
          )}

          {/* Submit */}
          <TouchableOpacity
            onPress={handleSetPassword}
            disabled={loading || done || !password || !confirmPassword}
            style={{
              backgroundColor: (!password || !confirmPassword || loading || done)
                ? '#d6cfc8'
                : '#231f1b',
              borderRadius: 12,
              paddingVertical: 15,
              alignItems: 'center',
              marginTop: 4,
            }}
          >
            {loading ? (
              <ActivityIndicator color="#f5f1ec" />
            ) : (
              <Text style={{
                fontSize: 15,
                fontWeight: '700',
                color: (!password || !confirmPassword || done) ? '#a09588' : '#f5f1ec',
                letterSpacing: -0.2,
              }}>
                Update password
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
