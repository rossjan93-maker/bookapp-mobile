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
  note: string | null;
  to_user: { username: string } | null;
  book: { title: string; author: string } | null;
};

const REC_STATUS: Record<string, { bg: string; text: string; label: string }> = {
  sent:     { bg: '#f1f5f9', text: '#475569', label: 'Sent'          },
  saved:    { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read'  },
  started:  { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'       },
  finished: { bg: '#dcfce7', text: '#15803d', label: 'Finished'      },
  dnf:      { bg: '#fee2e2', text: '#b91c1c', label: 'Did Not Finish' },
};

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#9ca3af',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      marginBottom: 10,
    }}>
      {children}
    </Text>
  );
}

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
            'id, status, created_at, note, ' +
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
        <ActivityIndicator color="#111827" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14 }}>{error}</Text>
      </View>
    );
  }

  const username = profile?.username ?? '—';

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 28, paddingBottom: 40 }}>

      {/* ── Avatar + Username ── */}
      <View style={{ alignItems: 'center', marginBottom: 28 }}>
        <View style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: '#e5e7eb',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
        }}>
          <Text style={{ fontSize: 26, fontWeight: '700', color: '#374151' }}>
            {username.charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text style={{ fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 4 }}>
          {username}
        </Text>
        <Text style={{ fontSize: 13, color: '#9ca3af', marginBottom: 6 }}>
          {email ?? '—'}
        </Text>
        {profile?.yearly_reading_goal != null && (
          <View style={{ backgroundColor: '#f1f5f9', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 }}>
            <Text style={{ fontSize: 12, color: '#475569' }}>
              Goal: {profile.yearly_reading_goal} books/year
            </Text>
          </View>
        )}
      </View>

      {/* ── Stats ── */}
      {stats && (
        <View style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          marginBottom: 32,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: '#e5e7eb',
          overflow: 'hidden',
        }}>
          <StatCell label="Friends"           value={stats.friendsCount}               borderRight borderBottom />
          <StatCell label="Books Finished"     value={stats.finishedBooks}              borderBottom />
          <StatCell label="Recs Landed"        value={stats.recommendationsLanded}      borderRight />
          <StatCell label="Finished from Recs" value={stats.finishedFromRecommendations} />
        </View>
      )}

      {/* ── Friend Requests ── */}
      <View style={{ marginBottom: 32 }}>
        <SectionLabel>
          {pendingRequests.length > 0
            ? `Friend Requests (${pendingRequests.length})`
            : 'Friend Requests'}
        </SectionLabel>

        {pendingRequests.length === 0 ? (
          <Text style={{ color: '#9ca3af', fontSize: 14 }}>No pending requests.</Text>
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
                borderBottomColor: '#f3f4f6',
              }}
            >
              <Text style={{ fontSize: 15, color: '#111827' }}>
                {req.requester?.username ?? req.requester_id}
              </Text>
              <TouchableOpacity
                onPress={() => handleAccept(req.id)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  backgroundColor: '#111827',
                  borderRadius: 8,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Accept</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      {/* ── Recommendations Sent ── */}
      <View style={{ marginBottom: 32 }}>
        <SectionLabel>Recommendations Sent</SectionLabel>

        {sentRecsError ? (
          <Text style={{ color: '#b91c1c', fontSize: 14 }}>{sentRecsError}</Text>
        ) : sentRecs.length === 0 ? (
          <Text style={{ color: '#9ca3af', fontSize: 14 }}>No recommendations sent yet.</Text>
        ) : (
          sentRecs.map(rec => {
            const badge = REC_STATUS[rec.status] ?? { bg: '#f1f5f9', text: '#475569', label: rec.status };
            return (
              <View
                key={rec.id}
                style={{
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: '#f3f4f6',
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ fontWeight: '600', fontSize: 15, color: '#111827', marginBottom: 2 }}>
                    {rec.book?.title ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#6b7280', marginBottom: 3 }}>
                    {rec.book?.author ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#9ca3af' }}>
                    to {rec.to_user?.username ?? '—'}
                  </Text>
                  {rec.note ? (
                    <Text style={{ fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginTop: 4 }}>
                      "{rec.note}"
                    </Text>
                  ) : null}
                </View>
                <View style={{
                  backgroundColor: badge.bg,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  alignSelf: 'flex-start',
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: badge.text }}>
                    {badge.label}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      {/* ── Sign Out ── */}
      <TouchableOpacity
        onPress={handleSignOut}
        style={{
          alignSelf: 'center',
          paddingHorizontal: 24,
          paddingVertical: 10,
          borderWidth: 1,
          borderColor: '#e5e7eb',
          borderRadius: 8,
        }}
      >
        <Text style={{ fontSize: 14, color: '#6b7280' }}>Sign Out</Text>
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
        paddingVertical: 18,
        borderRightWidth: borderRight ? 1 : 0,
        borderBottomWidth: borderBottom ? 1 : 0,
        borderColor: '#e5e7eb',
      }}
    >
      <Text style={{ fontSize: 28, fontWeight: '700', color: '#111827', marginBottom: 4 }}>
        {value}
      </Text>
      <Text style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center' }}>{label}</Text>
    </View>
  );
}
