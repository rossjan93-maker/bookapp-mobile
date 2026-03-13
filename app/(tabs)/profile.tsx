import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
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

type Stats = {
  friendsCount: number;
  recommendationsLanded: number;
  finishedFromRecommendations: number;
  finishedBooks: number;
};

type SentRecommendation = {
  id: string;
  status: string;
  created_at: string;
  to_user: { username: string } | null;
  book: { title: string; author: string } | null;
};

const REC_STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  saved: 'Saved',
  started: 'Reading',
  finished: 'Finished',
  dnf: 'DNF',
};

export default function ProfileScreen() {
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sentRecs, setSentRecs] = useState<SentRecommendation[]>([]);
  const [sentRecsError, setSentRecsError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
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

      const [
        profileResult,
        requestsResult,
        friendsResult,
        landedResult,
        finishedFromRecResult,
        finishedBooksResult,
        sentRecsResult,
      ] = await Promise.all([
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
        supabase
          .from('friendships')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
        supabase
          .from('credibility_events')
          .select('*', { count: 'exact', head: true })
          .eq('from_user_id', user.id),
        supabase
          .from('credibility_events')
          .select('*', { count: 'exact', head: true })
          .eq('to_user_id', user.id),
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'finished'),
        supabase
          .from('recommendations')
          .select(
            'id, status, created_at, ' +
            'to_user:profiles!recommendations_to_user_id_fkey(username), ' +
            'book:books!recommendations_book_id_fkey(title, author)'
          )
          .eq('from_user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      if (profileResult.error) {
        setError('Could not load profile.');
      } else {
        setProfile(profileResult.data);
      }

      setPendingRequests((requestsResult.data as PendingRequest[]) ?? []);

      if (sentRecsResult.error) {
        setSentRecsError('Could not load sent recommendations.');
      } else {
        setSentRecs((sentRecsResult.data as SentRecommendation[]) ?? []);
      }

      setStats({
        friendsCount: friendsResult.count ?? 0,
        recommendationsLanded: landedResult.count ?? 0,
        finishedFromRecommendations: finishedFromRecResult.count ?? 0,
        finishedBooks: finishedBooksResult.count ?? 0,
      });

      setLoading(false);
    }

    load();
  }, []));

  async function handleAccept(friendshipId: string) {
    if (!supabase) return;
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', friendshipId);
    if (!error) {
      setPendingRequests(prev => prev.filter(r => r.id !== friendshipId));
      setStats(prev => prev ? { ...prev, friendsCount: prev.friendsCount + 1 } : prev);
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

      {stats && (
        <View
          style={{
            width: '100%',
            flexDirection: 'row',
            flexWrap: 'wrap',
            marginBottom: 32,
            borderWidth: 1,
            borderColor: '#eee',
            borderRadius: 8,
          }}
        >
          <StatCell label="Friends" value={stats.friendsCount} borderRight borderBottom />
          <StatCell label="Books finished" value={stats.finishedBooks} borderBottom />
          <StatCell label="Recs landed" value={stats.recommendationsLanded} borderRight />
          <StatCell label="Recs finished" value={stats.finishedFromRecommendations} />
        </View>
      )}

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

      <View style={{ width: '100%', marginBottom: 32 }}>
        <Text style={{ fontWeight: '600', marginBottom: 12 }}>
          Recommendations Sent
        </Text>

        {sentRecsError ? (
          <Text style={{ color: '#c00' }}>{sentRecsError}</Text>
        ) : sentRecs.length === 0 ? (
          <Text style={{ color: '#999' }}>No recommendations sent yet.</Text>
        ) : (
          sentRecs.map(rec => (
            <View
              key={rec.id}
              style={{
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: '#eee',
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ fontWeight: '500', marginBottom: 2 }}>
                    {rec.book?.title ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#666', marginBottom: 2 }}>
                    {rec.book?.author ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#999' }}>
                    to {rec.to_user?.username ?? '—'}
                  </Text>
                </View>
                <Text
                  style={{
                    fontSize: 11,
                    color: rec.status === 'finished' ? '#080' : rec.status === 'dnf' ? '#c00' : '#555',
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderWidth: 1,
                    borderColor: rec.status === 'finished' ? '#080' : rec.status === 'dnf' ? '#c00' : '#ccc',
                    borderRadius: 4,
                    alignSelf: 'flex-start',
                  }}
                >
                  {REC_STATUS_LABELS[rec.status] ?? rec.status}
                </Text>
              </View>
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

function StatCell({
  label,
  value,
  borderRight,
  borderBottom,
}: {
  label: string;
  value: number;
  borderRight?: boolean;
  borderBottom?: boolean;
}) {
  return (
    <View
      style={{
        width: '50%',
        alignItems: 'center',
        paddingVertical: 16,
        borderRightWidth: borderRight ? 1 : 0,
        borderBottomWidth: borderBottom ? 1 : 0,
        borderColor: '#eee',
      }}
    >
      <Text style={{ fontSize: 24, fontWeight: '700', marginBottom: 4 }}>
        {value}
      </Text>
      <Text style={{ fontSize: 12, color: '#999' }}>{label}</Text>
    </View>
  );
}
