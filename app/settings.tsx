import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { getDisplayName } from '../lib/displayName';

function SectionHeader({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#a8a29e',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 8,
      marginTop: 28,
      paddingHorizontal: 4,
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
      paddingVertical: 13,
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
      width: 100,
      fontWeight: '500',
      flexShrink: 0,
    }}>
      {children}
    </Text>
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

export default function SettingsScreen() {
  const router = useRouter();

  const [userId, setUserId]   = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(true);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName]   = useState('');
  const [profileDirty, setProfileDirty] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved]   = useState(false);

  const [goalDraft, setGoalDraft] = useState('');
  const [goalDirty, setGoalDirty] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [goalSaved, setGoalSaved]   = useState(false);
  const [goalError, setGoalError]   = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!supabase) { setLoading(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      setUserId(user.id);

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
        Manage your profile and reading preferences.
      </Text>

      {/* ── Profile ── */}
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
            style={{ flex: 1, fontSize: 14, color: '#1c1917', paddingVertical: 2 }}
          />
        </SettingsRow>
        <SettingsRow>
          <RowLabel>Last name</RowLabel>
          <TextInput
            value={lastName}
            onChangeText={v => { setLastName(v); setProfileDirty(true); setProfileSaved(false); }}
            placeholder="Last"
            placeholderTextColor="#c4b5a5"
            autoCapitalize="words"
            style={{ flex: 1, fontSize: 14, color: '#1c1917', paddingVertical: 2 }}
          />
        </SettingsRow>
        <View style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderTopWidth: 1,
          borderTopColor: '#f5f5f4',
          backgroundColor: '#faf9f7',
        }}>
          <Text style={{ fontSize: 12, color: '#a8a29e' }}>
            Shown as{' '}
            <Text style={{ fontWeight: '600', color: '#78716c' }}>{displayPreview}</Text>
            {displayPreview !== username ? `  ·  @${username}` : ''}
          </Text>
        </View>
      </SettingsCard>

      {(profileDirty || profileSaved) && (
        <SaveButton
          onPress={handleSaveProfile}
          saving={savingProfile}
          saved={profileSaved}
          label="Save Name"
        />
      )}

      {/* ── Reading ── */}
      <SectionHeader>Reading</SectionHeader>
      <SettingsCard>
        <SettingsRow>
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
            style={{ flex: 1, fontSize: 14, color: '#1c1917', paddingVertical: 2 }}
          />
          <Text style={{ fontSize: 12, color: '#a8a29e', marginLeft: 4 }}>books / yr</Text>
        </SettingsRow>
        <TouchableOpacity
          onPress={() => router.push('/edit-preferences')}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          <Text style={{ fontSize: 14, color: '#57534e', fontWeight: '500', flex: 1 }}>
            Taste & Style
          </Text>
          <Text style={{ fontSize: 11, color: '#a8a29e', marginRight: 8 }}>Genres, styles, authors</Text>
          <Text style={{ fontSize: 18, color: '#d6d3d1' }}>›</Text>
        </TouchableOpacity>
      </SettingsCard>

      {goalError && (
        <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8, paddingHorizontal: 4 }}>
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

      {/* ── Account ── */}
      <SectionHeader>Account</SectionHeader>
      <SettingsCard>
        <TouchableOpacity
          onPress={handleSignOut}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 16,
          }}
        >
          <Text style={{ fontSize: 14, color: '#b91c1c', fontWeight: '500' }}>Sign Out</Text>
        </TouchableOpacity>
      </SettingsCard>
    </ScrollView>
  );
}
