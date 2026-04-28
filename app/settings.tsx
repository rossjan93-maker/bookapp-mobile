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
import { BackButton } from '../components/BackButton';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { getDisplayName } from '../lib/displayName';
import { ONBOARDING_STAGE_KEY, readOnboardingStage } from '../lib/onboardingStage';
import { clearLocalOnboardingState } from '../lib/localStateClear';
import { repairSubjectCoverage, type RepairSummary } from '../lib/subjectRepair';

// ─── Primitives ───────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#9e958d',
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
      backgroundColor: '#fefcf9',
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
      borderBottomColor: '#ede9e4',
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
      borderTopColor: '#ede9e4',
      backgroundColor: '#f5f1ec',
    }}>
      {children}
    </View>
  );
}

function SaveButton({
  onPress,
  saving,
  saved,
  disabled,
  label,
}: {
  onPress: () => void;
  saving: boolean;
  saved: boolean;
  disabled?: boolean;
  label: string;
}) {
  const isDisabled = saving || saved || !!disabled;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      style={{
        marginTop: 10,
        backgroundColor: saved ? '#15803d' : isDisabled ? '#ede9e4' : '#231f1b',
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

  const [userId, setUserId]         = useState<string | null>(null);
  const [username, setUsername]     = useState('');
  const [originalUsername, setOriginalUsername] = useState('');
  const [email, setEmail]           = useState<string | null>(null);
  const [loading, setLoading]       = useState(true);

  const [firstName, setFirstName]       = useState('');
  const [lastName, setLastName]         = useState('');

  // Account section (username) save state
  const [accountDirty, setAccountDirty]   = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountSaved, setAccountSaved]   = useState(false);
  const [accountError, setAccountError]   = useState<string | null>(null);

  // Profile section (first/last name) save state
  const [profileDirty, setProfileDirty]   = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved]   = useState(false);
  const [profileError, setProfileError]   = useState<string | null>(null);

  type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>('idle');

  // Advanced section (collapsed by default)
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  const [goalDraft, setGoalDraft] = useState('');
  const [goalDirty, setGoalDirty] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [goalSaved, setGoalSaved]   = useState(false);
  const [goalError, setGoalError]   = useState<string | null>(null);

  // ── Delete account state ──────────────────────────────────────────────────
  const [signingOut, setSigningOut] = useState(false);

  const [deleteExpanded, setDeleteExpanded]   = useState(false);
  const [deleteConfirm, setDeleteConfirm]     = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError]         = useState<string | null>(null);
  const deleteInputRef = useRef<TextInput>(null);

  // ── Subject repair (dev only) ─────────────────────────────────────────────
  const [subjectRepairRunning, setSubjectRepairRunning] = useState(false);

  async function handleSubjectRepair() {
    if (!userId) {
      Alert.alert('Subject Repair', 'No user session — sign in first.');
      return;
    }
    setSubjectRepairRunning(true);
    try {
      const summary: RepairSummary = await repairSubjectCoverage({
        userId,
        batchSize: 50,
        dryRun: false,
        client: supabase,
      });
      Alert.alert(
        'Subject Repair Done',
        `Eligible:  ${summary.eligible}\n` +
        `Enriched:  ${summary.enriched}\n` +
        `Failed:    ${summary.failed}\n` +
        `Skipped:   ${summary.skipped}\n` +
        `Fields improved: ${summary.fieldsImproved}`,
      );
    } catch (err) {
      Alert.alert('Subject Repair Error', String(err));
    } finally {
      setSubjectRepairRunning(false);
    }
  }

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
        const saved = data.username ?? '';
        setUsername(saved);
        setOriginalUsername(saved);
        setFirstName(data.first_name ?? '');
        setLastName(data.last_name ?? '');
        setGoalDraft(data.yearly_reading_goal ? String(data.yearly_reading_goal) : '');
      }
      setLoading(false);
    }
    load();
  }, []);

  // ── Debounced username availability check ─────────────────────────────────
  useEffect(() => {
    const uname = username.trim().toLowerCase().replace(/\s+/g, '');

    // Empty or unchanged — no check needed
    if (!uname || uname === originalUsername) {
      setUsernameStatus('idle');
      return;
    }
    // Format validation first — no round-trip if invalid
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) {
      setUsernameStatus('invalid');
      return;
    }

    setUsernameStatus('checking');
    const timer = setTimeout(async () => {
      if (!supabase || !userId) return;
      const { data } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', uname)
        .neq('id', userId)
        .limit(1);
      setUsernameStatus(data && data.length > 0 ? 'taken' : 'available');
    }, 500);

    return () => clearTimeout(timer);
  }, [username, userId, originalUsername]);

  async function handleSaveAccount() {
    if (!supabase || !userId) return;
    setAccountError(null);

    const uname = username.trim().toLowerCase().replace(/\s+/g, '');
    if (uname && !/^[a-z0-9_]{3,20}$/.test(uname)) {
      setAccountError('Username must be 3–20 characters: letters, numbers, or underscores.');
      return;
    }
    if (usernameStatus === 'taken') {
      setAccountError('That username is already taken. Please choose another.');
      return;
    }
    if (usernameStatus === 'checking') {
      setAccountError('Still checking availability — try again in a moment.');
      return;
    }

    setSavingAccount(true);
    const { error } = await supabase
      .from('profiles')
      .update({ username: uname || null })
      .eq('id', userId);
    setSavingAccount(false);
    if (!error) {
      setOriginalUsername(uname);
      setUsernameStatus('idle');
      setAccountDirty(false);
      setAccountSaved(true);
      setTimeout(() => setAccountSaved(false), 2500);
    } else if (error.code === '23505') {
      setAccountError('That username is already taken. Please choose another.');
    } else {
      setAccountError('Could not save — try again.');
    }
  }

  async function handleSaveProfile() {
    if (!supabase || !userId) return;
    setProfileError(null);

    setSavingProfile(true);
    const { error } = await supabase
      .from('profiles')
      .update({
        first_name: firstName.trim() || null,
        last_name:  lastName.trim()  || null,
      })
      .eq('id', userId);
    setSavingProfile(false);
    if (!error) {
      setProfileDirty(false);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
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
    if (signingOut) return;
    setSigningOut(true);
    await supabase?.auth.signOut();
    // SIGNED_OUT event in _layout.tsx handles navigation — no need to redirect here.
    // setSigningOut(false) is intentionally omitted: the component unmounts on sign-out.
  }

  async function handleDeleteAccount() {
    if (!supabase) return;
    if (deleteConfirm.trim().toUpperCase() !== 'DELETE') {
      setDeleteError('Type DELETE (all caps) to confirm.');
      return;
    }
    setDeletingAccount(true);
    setDeleteError(null);

    console.log('[DELETE_TRACE] account delete start — userId=', userId?.slice(0, 8) ?? '(unknown)');

    const { data, error } = await supabase.rpc('delete_own_account');

    if (error || !data?.ok) {
      const raw = error?.message ?? data?.error ?? '';
      console.error('[settings] delete_own_account failed:', raw, data?.detail ?? '');
      console.log('[DELETE_TRACE] delete_own_account FAILED — no local clear');

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

    console.log('[DELETE_TRACE] delete_own_account succeeded — clearing all local onboarding state');

    // Comprehensive clear of all local onboarding/rec-entry state so a new
    // sign-up on the same device starts completely clean.  This runs before
    // signOut() so the keys are gone before SIGNED_OUT fires (belt-and-suspenders
    // alongside the SIGNED_OUT handler in _layout.tsx which also awaits this).
    await clearLocalOnboardingState();

    const stageAfterClear = await readOnboardingStage();
    console.log('[DELETE_TRACE] post-clear stage=', stageAfterClear, '(expect null)');

    console.log('[DELETE_TRACE] calling signOut()');
    await supabase.auth.signOut();
    console.log('[DELETE_TRACE] signOut() returned');
  }

  const hasName = !!(firstName.trim() || lastName.trim());
  const displayPreview = getDisplayName({
    first_name: firstName.trim() || null,
    last_name:  lastName.trim()  || null,
    username,
  });

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f5f1ec' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f5f1ec' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 56, paddingBottom: 60 }}
      keyboardShouldPersistTaps="handled"
    >
      <BackButton onPress={() => router.back()} style={{ marginBottom: 24 }} />

      <Text style={{
        fontSize: 28,
        fontWeight: '800',
        color: '#231f1b',
        letterSpacing: -0.5,
        marginBottom: 4,
      }}>
        Settings
      </Text>
      <Text style={{ fontSize: 13, color: '#9e958d', lineHeight: 20 }}>
        Profile, reading goals, and preferences.
      </Text>

      {/* ── Account (email + username) ───────────────────────────────────────── */}
      <SectionHeader>Account</SectionHeader>
      <SettingsCard>
        <SettingsRow>
          <RowLabel>Email</RowLabel>
          <Text style={{ flex: 1, fontSize: 15, color: '#78716c', paddingVertical: 2 }}>
            {email ?? '—'}
          </Text>
        </SettingsRow>
        <SettingsRow last>
          <RowLabel>Username</RowLabel>
          <Text style={{ fontSize: 15, color: '#9e958d', paddingVertical: 2 }}>@</Text>
          <TextInput
            value={username}
            onChangeText={v => { setUsername(v); setAccountDirty(true); setAccountSaved(false); setAccountError(null); }}
            placeholder="your_username"
            placeholderTextColor="#c4b5a5"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, fontSize: 15, color: '#231f1b', paddingVertical: 2, marginLeft: 2 }}
          />
          {usernameStatus === 'checking' && (
            <ActivityIndicator size="small" color="#9e958d" style={{ marginLeft: 6 }} />
          )}
          {usernameStatus === 'available' && (
            <Text style={{ fontSize: 15, color: '#16a34a', marginLeft: 6 }}>✓</Text>
          )}
          {usernameStatus === 'taken' && (
            <Text style={{ fontSize: 15, color: '#dc2626', marginLeft: 6 }}>✕</Text>
          )}
        </SettingsRow>
      </SettingsCard>

      {usernameStatus === 'taken' && !accountError && (
        <Text style={{ fontSize: 12, color: '#dc2626', marginTop: 8, paddingHorizontal: 2 }}>
          That username is already taken.
        </Text>
      )}
      {usernameStatus === 'invalid' && !accountError && (
        <Text style={{ fontSize: 12, color: '#92400e', marginTop: 8, paddingHorizontal: 2 }}>
          3–20 characters — letters, numbers, or underscores only.
        </Text>
      )}
      {usernameStatus === 'available' && !accountError && (
        <Text style={{ fontSize: 12, color: '#16a34a', marginTop: 8, paddingHorizontal: 2 }}>
          Username is available.
        </Text>
      )}

      {accountError && (
        <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8, paddingHorizontal: 2 }}>
          {accountError}
        </Text>
      )}

      {(accountDirty || accountSaved) && (
        <SaveButton
          onPress={handleSaveAccount}
          saving={savingAccount}
          saved={accountSaved}
          disabled={usernameStatus === 'taken' || usernameStatus === 'checking' || usernameStatus === 'invalid'}
          label="Save Username"
        />
      )}

      {/* ── Profile (first + last name) ──────────────────────────────────────── */}
      <SectionHeader>Profile</SectionHeader>
      <SettingsCard>
        <SettingsRow>
          <RowLabel>First name</RowLabel>
          <TextInput
            value={firstName}
            onChangeText={v => { setFirstName(v); setProfileDirty(true); setProfileSaved(false); }}
            placeholder="First"
            placeholderTextColor="#c4b5a5"
            autoCapitalize="words"
            style={{ flex: 1, fontSize: 15, color: '#231f1b', paddingVertical: 2 }}
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
            style={{ flex: 1, fontSize: 15, color: '#231f1b', paddingVertical: 2 }}
          />
        </SettingsRow>
        <CardFooter>
          {hasName ? (
            <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>
              Shown as{' '}
              <Text style={{ fontWeight: '600', color: '#57534e' }}>{displayPreview}</Text>
              {' '}to friends across the app.
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>
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

      {/* ── Reading (yearly goal) ────────────────────────────────────────────── */}
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
            style={{ flex: 1, fontSize: 17, fontWeight: '600', color: '#231f1b', paddingVertical: 2 }}
          />
          <Text style={{ fontSize: 13, color: '#9e958d', marginLeft: 8 }}>books / yr</Text>
        </SettingsRow>
        <CardFooter>
          <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>
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

      {/* ── Library (Goodreads import + repair dates) ────────────────────────── */}
      <SectionHeader>Library</SectionHeader>
      <SettingsCard>
        <TouchableOpacity
          onPress={() => router.push('/import/goodreads')}
          activeOpacity={0.75}
          style={{ paddingHorizontal: 16, paddingVertical: 16 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 3 }}>
                Import from Goodreads
              </Text>
              <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>
                Bring your reading history into readstack
              </Text>
            </View>
            <Text style={{ fontSize: 20, color: '#c4b5a5', marginLeft: 10 }}>›</Text>
          </View>
        </TouchableOpacity>
        <View style={{ height: 1, backgroundColor: '#ede9e4', marginHorizontal: 16 }} />
        <TouchableOpacity
          onPress={() => router.push('/import/repair-dates')}
          activeOpacity={0.75}
          style={{ paddingHorizontal: 16, paddingVertical: 16 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 3 }}>
                Repair reading dates
              </Text>
              <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>
                Fix yearly goal count if old books appear as finished this year
              </Text>
            </View>
            <Text style={{ fontSize: 20, color: '#c4b5a5', marginLeft: 10 }}>›</Text>
          </View>
        </TouchableOpacity>
      </SettingsCard>

      {/* ── Advanced (collapsed, DEV only) ───────────────────────────────────── */}
      {__DEV__ && (
        <>
          <SectionHeader>Advanced</SectionHeader>
          <SettingsCard>
            <TouchableOpacity
              onPress={() => setAdvancedExpanded(e => !e)}
              activeOpacity={0.75}
              style={{ paddingHorizontal: 16, paddingVertical: 16 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 3 }}>
                    Developer tools
                  </Text>
                  <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>
                    {advancedExpanded ? 'Tap to collapse' : 'Tap to reveal'}
                  </Text>
                </View>
                <Text style={{ fontSize: 14, color: '#c4b5a5', marginLeft: 10 }}>
                  {advancedExpanded ? '↑' : '↓'}
                </Text>
              </View>
            </TouchableOpacity>
            {advancedExpanded && (
              <>
                <View style={{ height: 1, backgroundColor: '#ede9e4', marginHorizontal: 16 }} />
                <TouchableOpacity
                  onPress={handleSubjectRepair}
                  disabled={subjectRepairRunning}
                  activeOpacity={0.75}
                  style={{ paddingHorizontal: 16, paddingVertical: 16 }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '500', color: '#231f1b', marginBottom: 3 }}>
                        Repair Subject Coverage
                      </Text>
                      <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>
                        Enrich books with null or sparse subjects via Open Library
                      </Text>
                    </View>
                    {subjectRepairRunning ? (
                      <ActivityIndicator size="small" color="#9e958d" style={{ marginLeft: 10 }} />
                    ) : (
                      <Text style={{ fontSize: 20, color: '#c4b5a5', marginLeft: 10 }}>›</Text>
                    )}
                  </View>
                </TouchableOpacity>
              </>
            )}
          </SettingsCard>
        </>
      )}

      {/* ── Danger zone (sign out + delete account) ──────────────────────────── */}
      <SectionHeader>Danger zone</SectionHeader>
      <SettingsCard>
        <TouchableOpacity
          onPress={handleSignOut}
          disabled={signingOut}
          style={{
            paddingHorizontal: 16,
            paddingVertical: 15,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            opacity: signingOut ? 0.55 : 1,
          }}
        >
          {signingOut && <ActivityIndicator size="small" color="#b91c1c" />}
          <Text style={{ fontSize: 14, color: '#b91c1c', fontWeight: '500' }}>
            {signingOut ? 'Signing out…' : 'Sign Out'}
          </Text>
        </TouchableOpacity>

        {/* Delete account — collapsed trigger */}
        {!deleteExpanded && (
          <>
            <View style={{ height: 1, backgroundColor: '#ede9e4' }} />
            <TouchableOpacity
              onPress={() => {
                setDeleteExpanded(true);
                setDeleteConfirm('');
                setDeleteError(null);
                setTimeout(() => deleteInputRef.current?.focus(), 150);
              }}
              style={{ paddingHorizontal: 16, paddingVertical: 15 }}
            >
              <Text style={{ fontSize: 14, color: '#9e958d', fontWeight: '400' }}>Delete Account…</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Delete account — expanded confirmation */}
        {deleteExpanded && (
          <>
            <View style={{ height: 1, backgroundColor: '#ede9e4' }} />
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
                  borderColor: deleteConfirm.toUpperCase() === 'DELETE' ? '#b91c1c' : '#ede9e4',
                  borderRadius: 8,
                  padding: 11,
                  fontSize: 15,
                  color: '#231f1b',
                  backgroundColor: '#fefcf9',
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
                    borderColor: '#ede9e4',
                    borderRadius: 9,
                    paddingVertical: 11,
                    alignItems: 'center',
                    backgroundColor: '#fefcf9',
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
                    backgroundColor: deleteConfirm.trim().toUpperCase() === 'DELETE' ? '#b91c1c' : '#ede9e4',
                  }}
                >
                  {deletingAccount ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={{
                      fontSize: 13,
                      fontWeight: '600',
                      color: deleteConfirm.trim().toUpperCase() === 'DELETE' ? '#fff' : '#9e958d',
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

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}
