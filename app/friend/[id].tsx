import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BackButton } from '../../components/BackButton';
import { supabase } from '../../lib/supabase';
import { getDisplayName } from '../../lib/displayName';
import { directionalTrustInsight } from '../../lib/signals';

// ─── Types ────────────────────────────────────────────────────────────────────

type Stats = {
  recsSentToMe: number;
  iFinished: number;
  recsSentToThem: number;
  theyFinished: number;
};

type ActivityEventRaw = {
  id: string;
  event_type: string;
  created_at: string;
  book: { title: string; author: string }[] | null;
  recommendation: { from_user_id: string; to_user_id: string }[] | null;
};

type ActivityEvent = {
  id: string;
  event_type: string;
  created_at: string;
  book: { title: string; author: string } | null;
  recommendation: { from_user_id: string; to_user_id: string } | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const EXCHANGE_EVENT_TYPES = new Set([
  'recommendation_sent',
  'recommendation_saved',
  'recommendation_started',
  'recommendation_finished',
]);

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#a8a29e',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 12,
    }}>
      {children}
    </Text>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function FriendDetailScreen() {
  const { id: friendId, username, firstName, lastName } = useLocalSearchParams<{
    id: string;
    username: string;
    firstName: string;
    lastName: string;
  }>();
  const router = useRouter();

  const [stats, setStats]       = useState<Stats | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [meId, setMeId]         = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!supabase || !friendId) { setLoading(false); return; }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError('No signed-in user.');
        setLoading(false);
        return;
      }

      const me = user.id;
      setMeId(me);

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
          .select('id, event_type, created_at, book:books!activity_events_book_id_fkey(title, author), recommendation:recommendations!activity_events_recommendation_id_fkey(from_user_id, to_user_id)')
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
        const raw = (activityResult.data as ActivityEventRaw[]) ?? [];
        setActivity(raw.map(e => ({
          ...e,
          book: Array.isArray(e.book) ? e.book[0] ?? null : e.book,
          recommendation: Array.isArray(e.recommendation) ? e.recommendation[0] ?? null : e.recommendation,
        })));
      }

      setLoading(false);
    }

    load();
  }, [friendId]);

  const displayName    = getDisplayName({ username, first_name: firstName || null, last_name: lastName || null });
  const friendFirstName = firstName?.trim() || displayName;
  const initial        = displayName.charAt(0).toUpperCase();

  // ─── Derived stats ──────────────────────────────────────────────────────

  const totalExchanged   = (stats?.recsSentToMe ?? 0) + (stats?.recsSentToThem ?? 0);
  const hasInbound       = (stats?.recsSentToMe ?? 0) > 0;
  const inboundLandRate  = hasInbound && stats ? stats.iFinished / stats.recsSentToMe : null;

  function landingInsight(): string | null {
    if (!stats || !hasInbound) return null;
    const sent     = stats.recsSentToMe;
    const finished = stats.iFinished;

    if (sent <= 2) {
      if (finished === 0) return `You haven't finished any of ${friendFirstName}'s picks yet.`;
      return `You've finished ${finished} of ${sent} from ${friendFirstName} so far.`;
    }

    if (finished === 0) return `You haven't finished any of ${friendFirstName}'s picks yet.`;
    if (finished / sent >= 0.5) return `${friendFirstName}'s recommendations are landing well for you.`;
    return `Some of ${friendFirstName}'s recommendations have worked for you.`;
  }

  // ─── Activity feed split ───────────────────────────────────────────────

  const exchangeEvents = activity.filter(e => {
    if (!EXCHANGE_EVENT_TYPES.has(e.event_type)) return false;
    if (!e.recommendation || !meId) return false;
    const { from_user_id, to_user_id } = e.recommendation;
    const participants = new Set([from_user_id, to_user_id]);
    return participants.has(friendId!) && participants.has(meId);
  });
  const exchangeIds = new Set(exchangeEvents.map(e => e.id));
  const generalEvents = activity.filter(e => !exchangeIds.has(e.id));

  // ─── Loading / error ────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf9f7' }}>
        <ActivityIndicator color="#a8a29e" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#faf9f7' }}>
        <Text style={{ color: '#b91c1c', fontSize: 14, textAlign: 'center' }}>{error}</Text>
      </View>
    );
  }

  // ─── Activity row renderer ─────────────────────────────────────────────

  function renderActivityRow(event: ActivityEvent) {
    const title = event.book?.title ?? 'a book';
    const text = activityText(event.event_type, title);
    if (!text) return null;
    return (
      <View
        key={event.id}
        style={{
          paddingVertical: 13,
          borderBottomWidth: 1,
          borderBottomColor: '#f5f5f4',
          flexDirection: 'row',
          alignItems: 'flex-start',
        }}
      >
        <View style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: '#d6d3d1',
          marginTop: 8,
          marginRight: 12,
          flexShrink: 0,
        }} />
        <Text style={{ fontSize: 14, color: '#1c1917', lineHeight: 21, flex: 1, marginRight: 12 }}>
          {text}
        </Text>
        <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 4, flexShrink: 0 }}>
          {relativeTime(event.created_at)}
        </Text>
      </View>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 56, paddingBottom: 48 }}
    >
      {/* ── Back ── */}
      <BackButton onPress={() => router.back()} style={{ marginBottom: 28 }} />

      {/* ── Avatar + Name ── */}
      <View style={{ alignItems: 'center', marginBottom: 36 }}>
        <View style={{
          width: 68,
          height: 68,
          borderRadius: 34,
          backgroundColor: '#f0ede8',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        }}>
          <Text style={{ fontSize: 28, fontWeight: '700', color: '#57534e' }}>{initial}</Text>
        </View>
        <Text style={{ fontSize: 24, fontWeight: '800', color: '#1c1917', letterSpacing: -0.3, marginBottom: 6 }}>
          {displayName}
        </Text>
        {totalExchanged > 0 && (
          <Text style={{ fontSize: 13, color: '#a8a29e' }}>
            {totalExchanged === 1
              ? '1 recommendation exchanged'
              : `${totalExchanged} recommendations exchanged`}
          </Text>
        )}
        {totalExchanged === 0 && (
          <>
            <Text style={{ fontSize: 13, color: '#a8a29e', marginBottom: 6 }}>No recommendations yet</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/search')}>
              <Text style={{ fontSize: 13, color: '#a8a29e' }}>
                Recommend a book to {friendFirstName} →
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* ── Your Exchange ── */}
      {stats && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Your Exchange</SectionLabel>

          {/* Two side-by-side exchange cards */}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
            {/* From them → you */}
            <View style={{
              flex: 1,
              backgroundColor: '#fff',
              borderRadius: 14,
              padding: 16,
              borderWidth: 1,
              borderColor: '#e7e5e4',
            }}>
              <Text style={{
                fontSize: 11,
                fontWeight: '700',
                color: '#a8a29e',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                marginBottom: 12,
              }}>
                {friendFirstName} → You
              </Text>
              <Text style={{ fontSize: 30, fontWeight: '800', color: '#1c1917', marginBottom: 2 }}>
                {stats.recsSentToMe}
              </Text>
              <Text style={{ fontSize: 12, color: '#a8a29e', marginBottom: stats.recsSentToMe > 0 ? 12 : 0 }}>
                {stats.recsSentToMe === 1 ? 'sent' : 'sent'}
              </Text>
              {stats.recsSentToMe > 0 && (
                <View style={{ borderTopWidth: 1, borderTopColor: '#f5f5f4', paddingTop: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917' }}>
                    {stats.iFinished}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }}>
                    you read
                  </Text>
                  <Text style={{ fontSize: 11, color: '#78716c', marginTop: 4, fontWeight: '500' }}>
                    {stats.iFinished === 0
                      ? 'none read yet'
                      : stats.recsSentToMe <= 2
                      ? `${stats.iFinished} of ${stats.recsSentToMe} read`
                      : `${Math.round((stats.iFinished / stats.recsSentToMe) * 100)}% read through`}
                  </Text>
                </View>
              )}
            </View>

            {/* From you → them */}
            <View style={{
              flex: 1,
              backgroundColor: '#fff',
              borderRadius: 14,
              padding: 16,
              borderWidth: 1,
              borderColor: '#e7e5e4',
            }}>
              <Text style={{
                fontSize: 11,
                fontWeight: '700',
                color: '#a8a29e',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                marginBottom: 12,
              }}>
                You → {friendFirstName}
              </Text>
              <Text style={{ fontSize: 30, fontWeight: '800', color: '#1c1917', marginBottom: 2 }}>
                {stats.recsSentToThem}
              </Text>
              <Text style={{ fontSize: 12, color: '#a8a29e', marginBottom: stats.recsSentToThem > 0 ? 12 : 0 }}>
                {stats.recsSentToThem === 1 ? 'sent' : 'sent'}
              </Text>
              {stats.recsSentToThem > 0 && (
                <View style={{ borderTopWidth: 1, borderTopColor: '#f5f5f4', paddingTop: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917' }}>
                    {stats.theyFinished}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }}>
                    they read
                  </Text>
                  <Text style={{ fontSize: 11, color: '#78716c', marginTop: 4, fontWeight: '500' }}>
                    {stats.theyFinished === 0
                      ? 'none read yet'
                      : stats.recsSentToThem <= 2
                      ? `${stats.theyFinished} of ${stats.recsSentToThem} read`
                      : `${Math.round((stats.theyFinished / stats.recsSentToThem) * 100)}% read through`}
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* Landing rate insight */}
          {landingInsight() && (
            <View style={{
              backgroundColor: '#fff',
              borderRadius: 10,
              paddingHorizontal: 14,
              paddingVertical: 11,
              borderWidth: 1,
              borderColor: '#f0ede8',
              borderLeftWidth: 3,
              borderLeftColor: '#d4a574',
            }}>
              <Text style={{ fontSize: 13, color: '#57534e', lineHeight: 20 }}>
                {landingInsight()}
              </Text>
            </View>
          )}

          {/* Directional trust insight — requires ≥3 sent in each direction */}
          {(() => {
            if (!stats) return null;
            const insight = directionalTrustInsight(
              stats.recsSentToMe,
              stats.iFinished,
              stats.recsSentToThem,
              stats.theyFinished,
              friendFirstName,
            );
            if (!insight) return null;
            return (
              <View style={{
                backgroundColor: '#faf9f7',
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 11,
                borderWidth: 1,
                borderColor: '#e7e5e4',
                borderLeftWidth: 3,
                borderLeftColor: '#d6d3d1',
                marginTop: 8,
              }}>
                <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
                  {insight}
                </Text>
              </View>
            );
          })()}
        </View>
      )}

      {/* ── Recent Activity ── */}
      <View>
        <SectionLabel>Recent Activity</SectionLabel>
        {activity.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14 }}>No recent activity.</Text>
        ) : (
          <>
            {exchangeEvents.length > 0 && (
              <View style={{ marginBottom: generalEvents.length > 0 ? 16 : 0 }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '600',
                  color: '#a8a29e',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}>
                  Between You Two
                </Text>
                {exchangeEvents.map(renderActivityRow)}
              </View>
            )}
            {generalEvents.length > 0 && (
              <View>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '600',
                  color: '#a8a29e',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}>
                  Their Reading
                </Text>
                {generalEvents.map(renderActivityRow)}
              </View>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
