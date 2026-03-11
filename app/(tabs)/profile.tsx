import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { supabase } from '../../lib/supabase';

type Profile = {
  username: string;
  yearly_reading_goal: number | null;
};

type PendingRequest = {
  id: string;
  requester_id: string;
  requester: { username: string } | null;
};

export default function ProfileScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
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

      const [profileResult, requestsResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('username, yearly_reading_goal')
          .eq('id', user.id)
          .single(),
        supabase
          .from('friendships')
          .select('id, requester_id, requester:profiles!friendships_requester_id_fkey(username)')
          .eq('addressee_id', user.id)
          .eq('status', 'pending'),
      ]);

      if (profileResult.error) {
        setError('Could not load profile.');
      } else {
        setProfile(profileResult.data);
      }

      setPendingRequests((requestsResult.data as PendingRequest[]) ?? []);
      setLoading(false);
    }

    load();
  }, []);

  async function handleAccept(friendshipId: string) {
    if (!supabase) return;
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', friendshipId);
    if (!error) {
      setPendingRequests(prev => prev.filter(r => r.id !== friendshipId));
    }
  }

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
    <ScrollView contentContainerStyle={{ padding: 24, alignItems: 'center' }}>
      <Text style={{ fontSize: 20, fontWeight: '600', marginBottom: 20, marginTop: 8 }}>
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

      <View style={{ width: '100%', marginBottom: 32 }}>
        <Text style={{ fontWeight: '600', marginBottom: 12 }}>
          Friend Requests{pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}
        </Text>

        {pendingRequests.length === 0 ? (
          <Text style={{ color: '#999' }}>No pending requests.</Text>
        ) : (
          pendingRequests.map(req => (
            <View
              key={req.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: '#eee',
              }}
            >
              <Text>{req.requester?.username ?? req.requester_id}</Text>
              <TouchableOpacity
                onPress={() => handleAccept(req.id)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: '#000',
                  borderRadius: 6,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13 }}>Accept</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

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
    </ScrollView>
  );
}
