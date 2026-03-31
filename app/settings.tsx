import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDisplayName } from '../lib/displayName';
import { ONBOARDING_STAGE_KEY } from '../lib/onboardingStage';

// ─── Primitives ───────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#a8a29e',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 8,
      marginTop: 32,
      paddingHorizontal: 2,
    }}>
      {children}
    </Text>
  );
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <View style={{
      backgroundColor: '#fff',
      borderRadius: 14,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }}>
      {children}
    </View>
  );
}

function SettingsRow({ last, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: last ? 0 : 1,
      borderBottomColor: '#f5f5f4',
      minHeight: 52,
    }}>
      {children}
    </View>
  );
}

function RowLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 14,
      color: '#57534e',
      width: 96,
      fontWeight: '500',
      flexShrink: 0,
    }}>
      {children}
    </Text>
  );
}

function CardFooter({ children }: { children: React.ReactNode }) {
  return (
    <View style={{
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: '#f5f5f4',
      backgroundColor: '#faf9f7',
    }}>
      {children}
    </View>
  );
}

function SaveButton({
  onPress,
  saving,
  saved,
  label,
}: {
  onPress: () => void;
  saving: boolean;
  saved: boolean;
  label: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={saving || saved}
      style={{
        marginTop: 10,
        backgroundColor: saved ? '#15803d' : saving ? '#d6d3d1' : '#1c1917',
        borderRadius: 10,
        paddingVertical: 13,
        alignItems: 'center',
      }}
    >
      {saving ? (
        <ActivityIndicator color="#fff" size="small" />
      ) : (
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
          {saved ? 'Saved ✓' : label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const router = useRouter();

  const [userId, setUserId]     = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [email, setEmail]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  const [firstName, setFirstName]       = useState('');
  const [lastName, setLastName]         = useState('');
  const [profileDirty, setProfileDirty] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved]   = useState(false);
  const [profileError, setProfileError]   = useState<string | null>(null);

  const [goalDraft, setGoalDraft] = useState('');
  const [goalDirty, setGoalDirty] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [goalSaved, setGoalSaved]   = useState(false);
  const [goalError, setGoalError]   = useState<string | null>(null);

  // ── Delete account state ──────────────────────────────────────────────────
  const [deleteExpanded, setDeleteExpanded]   = useState(false);
  const [deleteConfirm, setDeleteConfirm]     = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError]         = useState<string | null>(null);
  const deleteInputRef = useRef<TextInput>(null);

  // ── Dev reset state ───────────────────────────────────────────────────────
  const [resetting, setResetting]   = useState(false);
  const [resetDone, setResetDone]   = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!supabase) { setLoading(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      setUserId(user.id);
      setEmail(user.email ?? null);

      const { data } = await supabase
        .from('profiles')
        .select('username, first_name, last_name, yearly_reading_goal')
        .eq('id', user.id)
        .single();

      if (data) {
        setUsername(data.username ?? '');
        setFirstName(data.first_name ?? '');
        setLastName(data.last_name ?? '');
        setGoalDraft(data.yearly_reading_goal ? String(data.yearly_reading_goal) : '');
      }
      setLoading(false);
    }
    load();
  }, []);

  async function handleSaveProfile() {
    if (!supabase || !userId) return;
    setProfileError(null);

    const uname = username.trim().toLowerCase().replace(/\s+/g, '');
    if (uname && !/^[a-z0-9_]{3,20}$/.test(uname)) {
      setProfileError('Username must be 3–20 characters: letters, numbers, or underscores.');
      return;
    }

    setSavingProfile(true);
    const { error } = await supabase
      .from('profiles')
      .update({
        first_name: firstName.trim() || null,
        last_name:  lastName.trim()  || null,
        username:   uname || null,
      })
      .eq('id', userId);
    setSavingProfile(false);
    if (!error) {
      setProfileDirty(false);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } else if (error.code === '23505') {
      setProfileError('That username is already taken. Please choose another.');
    } else {
      setProfileError('Could not save — try again.');
    }
  }

  async function handleSaveGoal() {
    if (!supabase || !userId) return;
    const raw = goalDraft.trim();
    if (raw === '') {
      setSavingGoal(true);
      const { error } = await supabase
        .from('profiles')
        .update({ yearly_reading_goal: null })
        .eq('id', userId);
      setSavingGoal(false);
      if (!error) {
        setGoalDirty(false);
        setGoalSaved(true);
        setTimeout(() => setGoalSaved(false), 2500);
      }
      return;
    }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1 || n > 365) {
      setGoalError('Enter a number between 1 and 365.');
      return;
    }
    setGoalError(null);
    setSavingGoal(true);
    const { error } = await supabase
      .from('profiles')
      .update({ yearly_reading_goal: n })
      .eq('id', userId);
    setSavingGoal(false);
    if (!error) {
      setGoalDirty(false);
      setGoalSaved(true);
      setTimeout(() => setGoalSaved(false), 2500);
    } else {
      setGoalError('Could not save — try again.');
    }
  }

  async function handleSignOut() {
    await supabase?.auth.signOut();
  }

  async function handleDeleteAccount() {
    if (!supabase) return;
    if (deleteConfirm.trim().toUpperCase() !== 'DELETE') {
      setDeleteError('Type DELETE (all caps) to confirm.');
      return;
    }
    setDeletingAccount(true);
    setDeleteError(null);

    const { data, error } = await supabase.rpc('delete_own_account');

    if (error || !data?.ok) {
      const raw = error?.message ?? data?.error ?? '';
      console.error('[settings] delete_own_account failed:', raw, data?.detail ?? '');

      let friendly = 'Deletion failed — please try again.';
      if (raw.includes('foreign key') || raw.includes('violates') || raw.includes('fkey')) {
        friendly = 'Could not delete — a linked record is blocking deletion. Please contact support if this persists.';
      } else if (raw.includes('not_authenticated')) {
        friendly = 'Session expired. Please sign out and sign back in, then try again.';
      } else if (raw.length > 0 && raw.length < 120) {
        friendly = raw;
      }
      setDeleteError(friendly);
      setDeletingAccount(false);
      return;
    }

    // Clear local onboarding state so a new sign-up on the same device
    // gets a fresh onboarding experience (no stale stage key left behind).
    await AsyncStorage.multiRemove([
      ONBOARDING_STAGE_KEY,
      'readstack_walkthrough_v1',
    ]);

    await supabase.auth.signOut();
  }

  async function handleResetOnboarding(coldStart = false) {
    if (!supabase || !userId) return;
    setResetting(true);
    setResetDone(false);
    setResetError(null);

    const rpc = coldStart ? 'reset_own_data_cold' : 'reset_own_onboarding';
    const { data, error } = await supabase.rpc(rpc);

    if (error || !data?.ok) {
      const raw = error?.message ?? data?.error ?? 'Reset failed';
      console.error(`[settings] ${rpc} failed:`, raw);
      setResetError(raw.length < 120 ? raw : 'Reset failed — try again.');
      setResetting(false);
      return;
    }

    // Clear client-side caches so the app cold-starts clean
    const keysToRemove = [
      'readstack_guided_v1',
      `readstack_rec_v1_${userId}`,
      `readstack_rec_acted_v1_${userId}`,
      'readstack_tooltip_v1_scan_result',
    ];
    await AsyncStorage.multiRemove(keysToRemove);

    setResetting(false);
    setResetDone(true);

    Alert.alert(
      coldStart ? 'Cold start reset complete' : 'Onboarding reset',
      coldStart
        ? 'Library, recs, and taste data cleared. Sign out and back in to start the onboarding flow fresh.'
        : 'Taste data and onboarding state cleared. Sign out and back in to re-experience onboarding.',
      [{ text: 'Sign out now', onPress: () => supabase?.auth.signOut() }, { text: 'Later' }]
    );
  }

  const hasName = !!(firstName.trim() || lastName.trim());
  const displayPreview = getDisplayName({
    first_name: firstName.trim() || null,
    last_name:  lastName.trim()  || null,
    username,
  });

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf9f7' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 56, paddingBottom: 60 }}
      keyboardShouldPersistTaps="handled"
    >
      <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 24 }}>
        <Text style={{ fontSize: 14, color: '#78716c' }}>← Back</Text>
      </TouchableOpacity>

      <Text style={{
        fontSize: 28,
        fontWeight: '800',
        color: '#1c1917',
        letterSpacing: -0.5,
        marginBottom: 4,
      }}>
        Settings
      </Text>
      <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20 }}>
        Profile, reading goals, and preferences.
      </Text>

      {/* ── Profile / Identity ───────────────────────────────────────────────── */}
      <SectionHeader>Profile</SectionHeader>
      <SettingsCard>
        <SettingsRow>
          <RowLabel>Username</RowLabel>
          <Text style={{ fontSize: 15, color: '#a8a29e', paddingVertical: 2 }}>@</Text>
          <TextInput
            value={username}
            onChangeText={v => { setUsername(v); setProfileDirty(true); setProfileSaved(false); setProfileError(null); }}
            placeholder="your_username"
            placeholderTextColor="#c4b5a5"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, fontSize: 15, color: '#1c1917', paddingVertical: 2, marginLeft: 2 }}
          />
        </SettingsRow>
        <SettingsRow>
          <RowLabel>First name</RowLabel>
          <TextInput
            value={firstName}
            onChangeText={v => { setFirstName(v); setProfileDirty(true); setProfileSaved(false); }}
            placeholder="First"
            placeholderTextColor="#c4b5a5"
            autoCapitalize="words"
            style={{ flex: 1, fontSize: 15, color: '#1c1917', paddingVertical: 2 }}
          />
        </SettingsRow>
        <SettingsRow last>
          <RowLabel>Last name</RowLabel>
          <TextInput
            value={lastName}
            onChangeText={v => { setLastName(v); setProfileDirty(true); setProfileSaved(false); }}
            placeholder="Last"
            placeholderTextColor="#c4b5a5"
            autoCapitalize="words"
            style={{ flex: 1, fontSize: 15, color: '#1c1917', paddingVertical: 2 }}
          />
        </SettingsRow>
        <CardFooter>
          {hasName ? (
            <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18 }}>
              Shown as{' '}
              <Text style={{ fontWeight: '600', color: '#57534e' }}>{displayPreview}</Text>
              {' '}to friends across the app.
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18 }}>
              Add your name — shown to friends instead of your username.
            </Text>
          )}
        </CardFooter>
      </SettingsCard>

      {profileError && (
        <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8, paddingHorizontal: 2 }}>
          {profileError}
        </Text>
      )}

      {(profileDirty || profileSaved) && (
        <SaveButton
          onPress={handleSaveProfile}
          saving={savingProfile}
          saved={profileSaved}
          label="Save Profile"
        />
      )}

      {/* ── Reading / Goal ──────────────────────────────────────────────────── */}
      <SectionHeader>Reading</SectionHeader>
      <SettingsCard>
        <SettingsRow last>
          <RowLabel>Yearly goal</RowLabel>
          <TextInput
            value={goalDraft}
            onChangeText={v => {
              setGoalDraft(v);
              setGoalDirty(true);
              setGoalSaved(false);
              setGoalError(null);
            }}
            placeholder="e.g. 24"
            placeholderTextColor="#c4b5a5"
            keyboardType="number-pad"
            returnKeyType="done"
            onSubmitEditing={handleSaveGoal}
            style={{ flex: 1, fontSize: 22, fontWeight: '700', color: '#1c1917', paddingVertical: 2 }}
          />
          <Text style={{ fontSize: 13, color: '#a8a29e', marginLeft: 6 }}>books / yr</Text>
        </SettingsRow>
        <CardFooter>
          <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18 }}>
            Books you aim to finish by Dec 31. Drives pacing on your dashboard.
          </Text>
        </CardFooter>
      </SettingsCard>

      {goalError && (
        <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8, paddingHorizontal: 2 }}>
          {goalError}
        </Text>
      )}

      {(goalDirty || goalSaved) && (
        <SaveButton
          onPress={handleSaveGoal}
          saving={savingGoal}
          saved={goalSaved}
          label="Save Goal"
        />
      )}

      {/* ── Reading / Taste ──────────────────────────────────────────────────── */}
      <View style={{ marginTop: 12 }}>
        <SettingsCard>
          <TouchableOpacity
            onPress={() => router.push('/edit-preferences')}
            activeOpacity={0.75}
            style={{ paddingHorizontal: 16, paddingVertical: 16 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 3 }}>
                  Taste & Style
                </Text>
                <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18 }}>
                  Genres, styles, and authors you love
                </Text>
              </View>
              <Text style={{ fontSize: 20, color: '#c4b5a5', marginLeft: 10 }}>›</Text>
            </View>
          </TouchableOpacity>
        </SettingsCard>
      </View>

      {/* ── Library ──────────────────────────────────────────────────────────── */}
      <SectionHeader>Library</SectionHeader>
      <SettingsCard>
        <TouchableOpacity
          onPress={() => router.push('/import/goodreads')}
          activeOpacity={0.75}
          style={{ paddingHorizontal: 16, paddingVertical: 16 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 3 }}>
                Import from Goodreads
              </Text>
              <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18 }}>
                Bring your reading history into readstack
              </Text>
            </View>
            <Text style={{ fontSize: 20, color: '#c4b5a5', marginLeft: 10 }}>›</Text>
          </View>
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#f5f5f4', marginHorizontal: 16 }} />
        <TouchableOpacity
          onPress={() => router.push('/import/repair-dates')}
          activeOpacity={0.75}
          style={{ paddingHorizontal: 16, paddingVertical: 16 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 3 }}>
                Repair reading dates
              </Text>
              <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18 }}>
                Fix yearly goal count if old books appear as finished this year
              </Text>
            </View>
            <Text style={{ fontSize: 20, color: '#c4b5a5', marginLeft: 10 }}>›</Text>
          </View>
        </TouchableOpacity>
      </SettingsCard>

      {/* ── Account ──────────────────────────────────────────────────────────── */}
      <SectionHeader>Account</SectionHeader>
      <SettingsCard>
        {/* Identity info */}
        <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5 }}>
            <Text style={{ fontSize: 13, color: '#a8a29e' }}>Username</Text>
            <Text style={{ fontSize: 13, color: '#78716c', fontWeight: '500' }}>@{username}</Text>
          </View>
          <View style={{ height: 1, backgroundColor: '#f5f5f4', marginVertical: 2 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5 }}>
            <Text style={{ fontSize: 13, color: '#a8a29e' }}>Email</Text>
            <Text style={{ fontSize: 13, color: '#78716c', fontWeight: '500' }}>{email ?? '—'}</Text>
          </View>
        </View>

        {/* Sign out */}
        <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />
        <TouchableOpacity
          onPress={handleSignOut}
          style={{ paddingHorizontal: 16, paddingVertical: 15 }}
        >
          <Text style={{ fontSize: 14, color: '#b91c1c', fontWeight: '500' }}>Sign Out</Text>
        </TouchableOpacity>

        {/* Delete account — collapsed trigger */}
        {!deleteExpanded && (
          <>
            <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />
            <TouchableOpacity
              onPress={() => {
                setDeleteExpanded(true);
                setDeleteConfirm('');
                setDeleteError(null);
                setTimeout(() => deleteInputRef.current?.focus(), 150);
              }}
              style={{ paddingHorizontal: 16, paddingVertical: 15 }}
            >
              <Text style={{ fontSize: 14, color: '#a8a29e', fontWeight: '400' }}>Delete Account…</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Delete account — expanded confirmation */}
        {deleteExpanded && (
          <>
            <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />
            <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 18 }}>
              <Text style={{
                fontSize: 13,
                fontWeight: '700',
                color: '#b91c1c',
                marginBottom: 8,
              }}>
                Delete your account?
              </Text>
              <Text style={{
                fontSize: 12,
                color: '#78716c',
                lineHeight: 18,
                marginBottom: 14,
              }}>
                This permanently removes your library, ratings, recommendations, and all activity.
                Books in the shared catalog are not affected.{'\n\n'}
                Type{' '}
                <Text style={{ fontFamily: 'System', fontWeight: '700', color: '#57534e' }}>DELETE</Text>
                {' '}to confirm. This cannot be undone.
              </Text>

              <TextInput
                ref={deleteInputRef}
                placeholder="Type DELETE to confirm"
                value={deleteConfirm}
                onChangeText={v => { setDeleteConfirm(v); setDeleteError(null); }}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholderTextColor="#c4b5a5"
                style={{
                  borderWidth: 1,
                  borderColor: deleteConfirm.toUpperCase() === 'DELETE' ? '#b91c1c' : '#e7e5e4',
                  borderRadius: 8,
                  padding: 11,
                  fontSize: 15,
                  color: '#1c1917',
                  backgroundColor: '#fff',
                  marginBottom: 4,
                  letterSpacing: 1,
                }}
              />

              {deleteError && (
                <Text style={{ fontSize: 12, color: '#b91c1c', marginBottom: 10, lineHeight: 17 }}>
                  {deleteError}
                </Text>
              )}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <TouchableOpacity
                  onPress={() => {
                    setDeleteExpanded(false);
                    setDeleteConfirm('');
                    setDeleteError(null);
                  }}
                  disabled={deletingAccount}
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor: '#e7e5e4',
                    borderRadius: 9,
                    paddingVertical: 11,
                    alignItems: 'center',
                    backgroundColor: '#fff',
                  }}
                >
                  <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500' }}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleDeleteAccount}
                  disabled={deletingAccount || deleteConfirm.trim().toUpperCase() !== 'DELETE'}
                  style={{
                    flex: 1,
                    borderRadius: 9,
                    paddingVertical: 11,
                    alignItems: 'center',
                    backgroundColor: deleteConfirm.trim().toUpperCase() === 'DELETE' ? '#b91c1c' : '#e7e5e4',
                  }}
                >
                  {deletingAccount ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={{
                      fontSize: 13,
                      fontWeight: '600',
                      color: deleteConfirm.trim().toUpperCase() === 'DELETE' ? '#fff' : '#a8a29e',
                    }}>
                      Delete Account
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </SettingsCard>

      {/* ── Developer / Test Tools (dev mode only) ───────────────────────────── */}
      {__DEV__ && (
        <>
          <SectionHeader>Developer</SectionHeader>
          <SettingsCard>
            {/* Reset onboarding (keep library) */}
            <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#57534e', marginBottom: 4 }}>
                Reset Onboarding
              </Text>
              <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18, marginBottom: 12 }}>
                Clears taste intake, genre picks, and rec cache. Library stays intact.
                You'll be routed back through the new onboarding flow on next sign-in.
              </Text>

              {resetError && (
                <Text style={{ fontSize: 12, color: '#b91c1c', marginBottom: 8 }}>
                  {resetError}
                </Text>
              )}

              <TouchableOpacity
                onPress={() => handleResetOnboarding(false)}
                disabled={resetting}
                style={{
                  backgroundColor: resetting ? '#e7e5e4' : '#78716c',
                  borderRadius: 9,
                  paddingVertical: 11,
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                {resetting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={{ fontSize: 13, color: '#fff', fontWeight: '600' }}>
                    {resetDone ? 'Reset ✓  (sign out to take effect)' : 'Reset Onboarding State'}
                  </Text>
                )}
              </TouchableOpacity>

              {/* Cold start: also nukes library + recs */}
              <TouchableOpacity
                onPress={() => {
                  Alert.alert(
                    'Cold start reset',
                    'This clears your entire library, recommendations, and taste data. Your account stays. Continue?',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Reset Everything', style: 'destructive', onPress: () => handleResetOnboarding(true) },
                    ]
                  );
                }}
                disabled={resetting}
                style={{
                  borderWidth: 1,
                  borderColor: '#e7e5e4',
                  borderRadius: 9,
                  paddingVertical: 11,
                  alignItems: 'center',
                  backgroundColor: '#fff',
                }}
              >
                <Text style={{ fontSize: 12, color: '#b91c1c', fontWeight: '500' }}>
                  Cold Start (clear library too)
                </Text>
              </TouchableOpacity>
            </View>
          </SettingsCard>
        </>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}
