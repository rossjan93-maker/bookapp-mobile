import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { supabase } from '../../lib/supabase';

type Profile = {
  username: string;
  yearly_reading_goal: number | null;
};

export default function ProfileScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!supabase) {
        setError('Supabase not configured.');
        setLoading(false);
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError('No signed-in user.');
        setLoading(false);
        return;
      }

      setEmail(user.email ?? null);

      const { data, error: dbError } = await supabase
        .from('profiles')
        .select('username, yearly_reading_goal')
        .eq('id', user.id)
        .single();

      if (dbError) {
        setError('Could not load profile.');
      } else {
        setProfile(data);
      }

      setLoading(false);
    }

    load();
  }, []);

  async function handleSignOut() {
    await supabase?.auth.signOut();
  }

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#c00' }}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 20 }}>
        {profile?.username ?? '—'}
      </Text>

      <Text style={{ color: '#555', marginBottom: 8 }}>
        {email ?? '—'}
      </Text>

      <Text style={{ color: '#555', marginBottom: 32 }}>
        Reading goal:{' '}
        {profile?.yearly_reading_goal != null
          ? `${profile.yearly_reading_goal} books`
          : 'not set'}
      </Text>

      <TouchableOpacity
        onPress={handleSignOut}
        style={{
          padding: 12,
          borderWidth: 1,
          borderColor: '#000',
          borderRadius: 6,
        }}
      >
        <Text>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}
