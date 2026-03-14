import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { getDisplayName } from '../../lib/displayName';

type Stats = {
  recsSentToMe: number;
  iFinished: number;
  recsSentToThem: number;
  theyFinished: number;
};

type ActivityEvent = {
  id: string;
  event_type: string;
  created_at: string;
  book: { title: string; author: string } | null;
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function activityText(eventType: string, title: string): string {
  switch (eventType) {
    case 'recommendation_sent':     return `Recommended "${title}"`;
    case 'recommendation_saved':    return `Saved "${title}"`;
    case 'recommendation_started':  return `Started reading "${title}"`;
    case 'recommendation_finished': return `Finished "${title}"`;
    case 'book_finished':           return `Finished "${title}"`;
    default: return '';
  }
}

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
    <View style={{
      width: '50%',
      alignItems: 'center',
      paddingVertical: 18,
      borderRightWidth: borderRight ? 1 : 0,
      borderBottomWidth: borderBottom ? 1 : 0,
      borderColor: '#e5e7eb',
    }}>
      <Text style={{ fontSize: 26, fontWeight: '700', color: '#111827', marginBottom: 4 }}>
        {value}
      </Text>
      <Text style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center' }}>{label}</Text>
    </View>
  );
}

export default function FriendDetailScreen() {
  const { id: friendId, username, firstName, lastName } = useLocalSearchParams<{ id: string; username: string; firstName: string; lastName: string }>();
  const router = useRouter();

  const [stats, setStats] = useState<Stats | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!supabase || !friendId) {
        setLoading(false);
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError('No signed-in user.');
        setLoading(false);
        return;
      }

      const me = user.id;

      const [
        recsSentToMeResult,
        iFinishedResult,
        recsSentToThemResult,
        theyFinishedResult,
        activityResult,
      ] = await Promise.all([
        supabase
          .from('recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('from_user_id', friendId)
          .eq('to_user_id', me),
        supabase
          .from('credibility_events')
          .select('*', { count: 'exact', head: true })
          .eq('from_user_id', friendId)
          .eq('to_user_id', me),
        supabase
          .from('recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('from_user_id', me)
          .eq('to_user_id', friendId),
        supabase
          .from('credibility_events')
          .select('*', { count: 'exact', head: true })
          .eq('from_user_id', me)
          .eq('to_user_id', friendId),
        supabase
          .from('activity_events')
          .select('id, event_type, created_at, book:books!activity_events_book_id_fkey(title, author)')
          .eq('actor_id', friendId)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      setStats({
        recsSentToMe:   recsSentToMeResult.count   ?? 0,
        iFinished:      iFinishedResult.count       ?? 0,
        recsSentToThem: recsSentToThemResult.count  ?? 0,
        theyFinished:   theyFinishedResult.count    ?? 0,
      });

      if (!activityResult.error) {
        setActivity((activityResult.data as ActivityEvent[]) ?? []);
      }

      setLoading(false);
    }

    load();
  }, [friendId]);

  const displayName = getDisplayName({ username, first_name: firstName || null, last_name: lastName || null });

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
        <Text style={{ color: '#b91c1c', fontSize: 14, textAlign: 'center' }}>{error}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 56, paddingBottom: 40 }}>

      {/* ── Back ── */}
      <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 24 }}>
        <Text style={{ fontSize: 14, color: '#6b7280' }}>← Back</Text>
      </TouchableOpacity>

      {/* ── Avatar + Username ── */}
      <View style={{ alignItems: 'center', marginBottom: 32 }}>
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
            {displayName.charAt(0).toUpperCase()}
          </Text>
        </View>
        <Text style={{ fontSize: 22, fontWeight: '700', color: '#111827' }}>
          {displayName}
        </Text>
      </View>

      {/* ── Between You ── */}
      {stats && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Between You</SectionLabel>
          <View style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            borderRadius: 12,
            borderWidth: 1,
            borderColor: '#e5e7eb',
            overflow: 'hidden',
          }}>
            <StatCell label="Sent to You"    value={stats.recsSentToMe}   borderRight borderBottom />
            <StatCell label="You Finished"   value={stats.iFinished}      borderBottom />
            <StatCell label="You Sent"       value={stats.recsSentToThem} borderRight />
            <StatCell label="They Finished"  value={stats.theyFinished} />
          </View>
        </View>
      )}

      {/* ── Recent Activity ── */}
      <View>
        <SectionLabel>Recent Activity</SectionLabel>
        {activity.length === 0 ? (
          <Text style={{ color: '#9ca3af', fontSize: 14 }}>No recent activity.</Text>
        ) : (
          activity.map(event => {
            const title = event.book?.title ?? 'a book';
            const text = activityText(event.event_type, title);
            if (!text) return null;
            return (
              <View
                key={event.id}
                style={{
                  paddingVertical: 13,
                  borderBottomWidth: 1,
                  borderBottomColor: '#f3f4f6',
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                <Text style={{ fontSize: 14, color: '#111827', lineHeight: 20, flex: 1, marginRight: 12 }}>
                  {text}
                </Text>
                <Text style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {relativeTime(event.created_at)}
                </Text>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
