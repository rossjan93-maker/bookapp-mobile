import { useCallback, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { getDisplayName, getFirstName } from '../../lib/displayName';
import { computeAvgPagesPerDay, computeSourceCompletion } from '../../lib/signals';
import { ProfileScreenSkeleton } from '../../components/Placeholder';
import type { SourceCompletion } from '../../lib/signals';
import { registerCacheClearer } from '../../lib/tabCache';

type Profile = {
  username: string;
  first_name: string | null;
  last_name: string | null;
  yearly_reading_goal: number | null;
};

type AcceptedFriend = {
  id: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
};

type PendingRequest = {
  id: string;
  requester_id: string;
  requester: { username: string; first_name: string | null; last_name: string | null } | null;
};

type SentRecommendation = {
  id: string;
  book_id: string;
  status: string;
  created_at: string;
  note: string | null;
  to_user: { username: string; first_name: string | null; last_name: string | null } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

type ReaderPrefs = {
  favorite_genres: string[];
  avoid_genres: string[];
  reading_styles: string[];
  favorite_authors: string | null;
};

type ReaderSignals = {
  completionRate: number | null;
  avgPagesPerDay: number | null;
  recConversionRate: number | null;
  resolved: number;           // total finished + dnf (threshold gate)
  totalRecsReceived: number;  // total recs received (threshold gate)
};

type ReadingPatterns = {
  selfAdded: number;   // user_books added by user themselves
  recAdded: number;    // user_books sourced from a recommendation
};

const REC_STATUS: Record<string, { bg: string; text: string; label: string }> = {
  sent:     { bg: '#f0ece6', text: '#6b635c', label: 'Sent'          },
  saved:    { bg: '#e6f0e6', text: '#4d7f52', label: 'Want to Read'  },
  started:  { bg: '#e6f0e6', text: '#4d7f52', label: 'Reading'       },
  finished: { bg: '#e6f0e6', text: '#4d7f52', label: 'Finished'      },
  dnf:      { bg: '#fee2e2', text: '#b91c1c', label: 'Did Not Finish' },
};

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#9e958d',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 12,
    }}>
      {children}
    </Text>
  );
}

// ─── Module-level profile cache ───────────────────────────────────────────────
// 60 s staleness — same window as Home / Library.  Profile data (friend count,
// stats, sent recs) changes infrequently and never from within the Profile tab
// itself; the user can pull-to-refresh for an immediate update.

const PROFILE_STALE_MS = 60_000;

type ProfileSnapshot = { userId: string; fetchedAt: number };

let _profileCache: ProfileSnapshot | null = null;
// On sign-out, clear so the next user gets a fresh load
registerCacheClearer(() => { _profileCache = null; });

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [email, setEmail]               = useState<string | null>(null);
  const [userId, setUserId]             = useState<string | null>(null);
  const [profile, setProfile]           = useState<Profile | null>(null);
  const [pendingRequests, setPendingRequests]    = useState<PendingRequest[] | null>(null);
  const [sentRecs, setSentRecs]         = useState<SentRecommendation[] | null>(null);
  const [prefs, setPrefs]               = useState<ReaderPrefs | null>(null);
  const [stats, setStats]               = useState<{
    friendsCount: number;
    finishedBooks: number;
    finishedThisYear: number;
    recsLanded: number;
    finishedFromRecs: number;
  } | null>(null);
  const [signals, setSignals]             = useState<ReaderSignals | null>(null);
  const [patterns, setPatterns]           = useState<ReadingPatterns | null>(null);
  const [sourceCompletion, setSourceCompletion] = useState<SourceCompletion | null>(null);
  // Start false when module cache exists so no full-page spinner on revisit
  const [loading, setLoading]           = useState(() => !_profileCache);
  const [error, setError]               = useState<string | null>(null);
  const [recsExpanded, setRecsExpanded]         = useState(false);
  const [acceptedFriends, setAcceptedFriends]   = useState<AcceptedFriend[] | null>(null);
  const [refreshing, setRefreshing]             = useState(false);

  async function loadProfile(force = false) {
    if (!supabase) { setError('Supabase not configured.'); setLoading(false); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError('No signed-in user.'); setLoading(false); return; }

    setEmail(user.email ?? null);
    setUserId(user.id);

    // ── Staleness guard ───────────────────────────────────────────────────────
    if (_profileCache && _profileCache.userId !== user.id) _profileCache = null;
    if (!force && _profileCache && Date.now() - _profileCache.fetchedAt < PROFILE_STALE_MS) {
      setLoading(false);
      return;
    }

    const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;

    // ── Phase 1: above-the-fold (profile header + stat counts) ───────────────
    // 6 lightweight queries — profile row + 5 COUNT heads.
    // setLoading(false) fires here so the header is visible in ~400–600 ms.
    const [
      profileRes,
      friendsRes,
      finishedAllRes,
      finishedYearRes,
      landedRes,
      finishedFromRecRes,
    ] = await Promise.all([
      supabase.from('profiles').select('username, first_name, last_name, yearly_reading_goal').eq('id', user.id).single(),
      supabase.from('friendships').select('*', { count: 'exact', head: true }).eq('status', 'accepted').or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'finished').is('deleted_at', null),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'finished').is('deleted_at', null).gte('finished_at', yearStart),
      supabase.from('credibility_events').select('*', { count: 'exact', head: true }).eq('from_user_id', user.id),
      supabase.from('credibility_events').select('*', { count: 'exact', head: true }).eq('to_user_id', user.id),
    ]);

    if (profileRes.error) {
      setError('Could not load profile.');
    } else {
      setProfile(profileRes.data);
    }

    setStats({
      friendsCount:     friendsRes.count ?? 0,
      recsLanded:       landedRes.count ?? 0,
      finishedFromRecs: finishedFromRecRes.count ?? 0,
      finishedBooks:    finishedAllRes.count ?? 0,
      finishedThisYear: finishedYearRes.count ?? 0,
    });

    _profileCache = { userId: user.id, fetchedAt: Date.now() };
    setLoading(false);

    // ── Phase 2: below-the-fold (friends, recs, signals, prefs) ─────────────
    // Runs immediately after Phase 1 returns. All 15 queries in one Promise.all.
    // State is set silently; no loading flag changes — page is already visible.
    const finishedCount = finishedAllRes.count ?? 0;

    const [
      requestsRes,
      friendsListRes,
      sentRecsRes,
      prefsRes,
      dnfCountRes,
      recReceivedTotalRes,
      recReceivedFinishedRes,
      progressEventsRes,
      selfAddedRes,
      recAddedRes,
      selfAddedFinishedRes,
      selfAddedDnfRes,
      recAddedFinishedRes,
      recAddedDnfRes,
    ] = await Promise.all([
      supabase
        .from('friendships')
        .select('id, requester_id, requester:profiles!friendships_requester_id_fkey(username, first_name, last_name)')
        .eq('addressee_id', user.id)
        .eq('status', 'pending'),
      supabase
        .from('friendships')
        .select(
          'id, requester_id, addressee_id, ' +
          'requester:profiles!friendships_requester_id_fkey(id, username, first_name, last_name), ' +
          'addressee:profiles!friendships_addressee_id_fkey(id, username, first_name, last_name)'
        )
        .eq('status', 'accepted')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
      supabase
        .from('recommendations')
        .select(
          'id, book_id, status, created_at, note, ' +
          'to_user:profiles!recommendations_to_user_id_fkey(username, first_name, last_name), ' +
          'book:books!recommendations_book_id_fkey(title, author, cover_url, external_id)'
        )
        .eq('from_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('reader_preferences')
        .select('favorite_genres, avoid_genres, reading_styles, favorite_authors')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'dnf').is('deleted_at', null),
      supabase.from('recommendations').select('*', { count: 'exact', head: true }).eq('to_user_id', user.id),
      supabase.from('recommendations').select('*', { count: 'exact', head: true }).eq('to_user_id', user.id).eq('status', 'finished'),
      supabase.from('reading_progress_events').select('user_book_id, page, created_at').eq('user_id', user.id).order('created_at', { ascending: true }),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'self_added').is('deleted_at', null),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'recommendation').is('deleted_at', null),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'self_added').eq('status', 'finished').is('deleted_at', null),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'self_added').eq('status', 'dnf').is('deleted_at', null),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'recommendation').eq('status', 'finished').is('deleted_at', null),
      supabase.from('user_books').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'recommendation').eq('status', 'dnf').is('deleted_at', null),
    ]);

    setPendingRequests((requestsRes.data as unknown as PendingRequest[]) ?? []);
    setSentRecs((sentRecsRes.data as unknown as SentRecommendation[]) ?? []);
    setPrefs(prefsRes.data ?? null);

    type FriendshipListRow = {
      requester_id: string;
      addressee_id: string;
      requester: AcceptedFriend | null;
      addressee: AcceptedFriend | null;
    };
    const friendsList = ((friendsListRes.data ?? []) as FriendshipListRow[])
      .map(f => (f.requester_id === user.id ? f.addressee : f.requester))
      .filter((f): f is AcceptedFriend => f !== null);
    setAcceptedFriends(friendsList);

    const dnf      = dnfCountRes.count ?? 0;
    const resolved = finishedCount + dnf;
    const completionRate = resolved > 0 ? +(finishedCount / resolved).toFixed(2) : null;

    const totalRecsReceived    = recReceivedTotalRes.count ?? 0;
    const finishedRecsReceived = recReceivedFinishedRes.count ?? 0;
    const recConversionRate    = totalRecsReceived > 0
      ? +(finishedRecsReceived / totalRecsReceived).toFixed(2)
      : null;

    type ProgressEventRow = { user_book_id: string; page: number; created_at: string };
    const progressEvents = (progressEventsRes.data ?? []) as ProgressEventRow[];
    const avgPagesPerDay = computeAvgPagesPerDay(progressEvents);

    setSignals({ completionRate, avgPagesPerDay, recConversionRate, resolved, totalRecsReceived });

    setPatterns({
      selfAdded: selfAddedRes.count ?? 0,
      recAdded:  recAddedRes.count  ?? 0,
    });

    setSourceCompletion(computeSourceCompletion(
      selfAddedFinishedRes.count ?? 0,
      selfAddedDnfRes.count      ?? 0,
      recAddedFinishedRes.count  ?? 0,
      recAddedDnfRes.count       ?? 0,
    ));
  }

  useFocusEffect(useCallback(() => {
    loadProfile();
  }, []));

  async function handleAccept(friendshipId: string) {
    if (!supabase) return;
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', friendshipId);
    if (!error) {
      setPendingRequests(prev => prev ? prev.filter(r => r.id !== friendshipId) : prev);
      setStats(prev => prev ? { ...prev, friendsCount: prev.friendsCount + 1 } : prev);
    }
  }

  if (loading) {
    return <ProfileScreenSkeleton />;
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14, marginBottom: 18 }}>{error}</Text>
        <TouchableOpacity
          onPress={() => { setError(null); setLoading(true); loadProfile(true); }}
          style={{ backgroundColor: '#231f1b', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 24 }}
        >
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const username         = profile?.username?.trim() ?? '';
  const hasChosenUsername = username.length > 0;
  const displayName      = getDisplayName(profile);
  const yearlyGoal       = profile?.yearly_reading_goal ?? null;

  // On-pace computation (mirrors lib/pacing.ts → computeGoalProgress).
  let onPace = false;
  if (stats && yearlyGoal && yearlyGoal > 0) {
    const today = new Date();
    const dayOfYear = Math.floor(
      (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / (24 * 60 * 60 * 1000)
    );
    const expectedByNow = Math.floor((dayOfYear / 365) * yearlyGoal);
    onPace = stats.finishedThisYear >= expectedByNow;
  }

  const hasTasteData = prefs && (
    (prefs.favorite_genres?.length ?? 0) > 0 ||
    (prefs.avoid_genres?.length ?? 0) > 0 ||
    (prefs.reading_styles?.length ?? 0) > 0 ||
    !!prefs.favorite_authors
  );

  async function handleRefresh() {
    setRefreshing(true);
    await loadProfile(true); // force=true bypasses staleness guard
    setRefreshing(false);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f5f1ec' }}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
      }
    >
      {/* ── Profile header ── */}
      <View style={{
        paddingHorizontal: 24,
        paddingTop: insets.top + 16,
        paddingBottom: 28,
        borderBottomWidth: 1,
        borderBottomColor: '#ede9e4',
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          {/* Avatar */}
          <View style={{
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: '#231f1b',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 16,
            flexShrink: 0,
          }}>
            <Text style={{ fontSize: 23, fontWeight: '800', color: '#fff' }}>
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>

          {/* Identity */}
          <View style={{ flex: 1, paddingTop: 2 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#231f1b', letterSpacing: -0.5, lineHeight: 28 }}>
              {displayName}
            </Text>
            {hasChosenUsername ? (
              <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 4 }}>@{username}</Text>
            ) : (
              <TouchableOpacity onPress={() => router.push('/settings')} style={{ marginTop: 5 }}>
                <Text style={{ fontSize: 13, color: '#c4b5a5' }}>Choose a username →</Text>
              </TouchableOpacity>
            )}
            {stats && stats.finishedBooks > 0 && (
              <Text style={{ fontSize: 13, color: '#78716c', marginTop: 10 }}>
                {stats.finishedBooks} {stats.finishedBooks === 1 ? 'book' : 'books'} finished
              </Text>
            )}
          </View>

          {/* Settings — low-weight text link, top-aligned */}
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            style={{ paddingTop: 3, paddingLeft: 12 }}
          >
            <Text style={{ fontSize: 13, color: '#9e958d' }}>Settings</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Reading summary row ── */}
      {stats && (
        <View style={{ paddingHorizontal: 24, marginTop: 22 }}>
          {yearlyGoal ? (
            <View>
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b' }}>
                {stats.finishedThisYear} / {yearlyGoal} books this year
              </Text>
              <Text style={{ fontSize: 13, color: onPace ? '#4d7f52' : '#9e958d', marginTop: 4 }}>
                {onPace ? 'On pace' : 'Behind pace'}
              </Text>
            </View>
          ) : (
            <TouchableOpacity onPress={() => router.push('/settings')}>
              <Text style={{ fontSize: 13, color: '#9e958d' }}>Set a yearly reading goal →</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Taste profile card ── */}
      <View style={{ paddingHorizontal: 24, marginTop: 14, marginBottom: 24 }}>
        <TouchableOpacity
          onPress={() => router.push('/edit-preferences')}
          style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            padding: 16,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', marginBottom: hasTasteData ? 12 : 4 }}>
                {hasTasteData ? 'Reading Taste' : 'Build your taste profile'}
              </Text>
              {hasTasteData ? (
                <View style={{ gap: 10 }}>
                  {(prefs!.favorite_genres?.length ?? 0) > 0 && (
                    <View>
                      <Text style={{
                        fontSize: 10, fontWeight: '700', color: '#9e958d',
                        letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6,
                      }}>Genres</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                        {prefs!.favorite_genres.slice(0, 4).map(g => (
                          <View key={g} style={{
                            backgroundColor: '#ede9e4', borderRadius: 20,
                            paddingHorizontal: 10, paddingVertical: 4,
                          }}>
                            <Text style={{ fontSize: 12, color: '#57534e' }}>{g}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                  {(prefs!.reading_styles?.length ?? 0) > 0 && (
                    <View>
                      <Text style={{
                        fontSize: 10, fontWeight: '700', color: '#9e958d',
                        letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6,
                      }}>Style</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                        {prefs!.reading_styles.slice(0, 3).map(s => (
                          <View key={s} style={{
                            backgroundColor: '#f5f1ec', borderRadius: 20,
                            paddingHorizontal: 10, paddingVertical: 4,
                            borderWidth: 1, borderColor: '#ede9e4',
                          }}>
                            <Text style={{ fontSize: 12, color: '#78716c' }}>{s}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                  {!!prefs!.favorite_authors && (
                    <Text style={{ fontSize: 12, color: '#9e958d' }}>
                      Incl. {prefs!.favorite_authors.split(',')[0].trim()}
                    </Text>
                  )}
                </View>
              ) : (
                <Text style={{ fontSize: 13, color: '#9e958d', lineHeight: 19 }}>
                  Genres, styles, and authors — unlocks future taste insights.
                </Text>
              )}
            </View>
            <Text style={{ fontSize: 20, color: '#ede9e4', marginLeft: 12, marginTop: 2 }}>›</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* ── Friend Requests (only rendered when Phase 2 data has arrived and there are pending requests) ── */}
      {pendingRequests !== null && pendingRequests.length > 0 && (
        <View style={{ paddingHorizontal: 24, marginBottom: 28 }}>
          <SectionLabel>Friend Requests ({pendingRequests.length})</SectionLabel>
          {pendingRequests.map(req => (
            <View
              key={req.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: '#ede9e4',
              }}
            >
              <Text style={{ fontSize: 15, color: '#231f1b' }}>
                {getDisplayName(req.requester) !== 'Unknown' ? getDisplayName(req.requester) : req.requester_id}
              </Text>
              <TouchableOpacity
                onPress={() => handleAccept(req.id)}
                style={{ paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#231f1b', borderRadius: 8 }}
              >
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Accept</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* ── Friends (only when active) ── */}
      {acceptedFriends && acceptedFriends.length > 0 && (
        <View style={{ paddingHorizontal: 24, marginBottom: 28 }}>
          <SectionLabel>Friends</SectionLabel>
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
            {acceptedFriends.map((friend, idx) => {
              const name = getDisplayName(friend);
              const initial = name.charAt(0).toUpperCase();
              const showUsername = !!(friend.first_name || friend.last_name);
              return (
                <TouchableOpacity
                  key={friend.id}
                  activeOpacity={0.7}
                  onPress={() => router.push({
                    pathname: '/friend/[id]',
                    params: {
                      id: friend.id,
                      username: friend.username,
                      firstName: friend.first_name ?? '',
                      lastName: friend.last_name ?? '',
                    },
                  })}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 13,
                    paddingHorizontal: 16,
                    borderTopWidth: idx > 0 ? 1 : 0,
                    borderTopColor: '#ede9e4',
                  }}
                >
                  <View style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: '#ede9e4',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12,
                  }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: '#57534e' }}>
                      {initial}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, color: '#231f1b', fontWeight: '500' }}>
                      {name}
                    </Text>
                    {showUsername && (
                      <Text style={{ fontSize: 12, color: '#9e958d', marginTop: 1 }}>
                        @{friend.username}
                      </Text>
                    )}
                  </View>
                  <Text style={{ fontSize: 18, color: '#ede9e4', marginLeft: 8 }}>›</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* ── Sent Recommendations (only when active) ── */}
      {sentRecs && sentRecs.length > 0 && (
        <View style={{ paddingHorizontal: 24, marginBottom: 28 }}>
          <SectionLabel>Recommendations Sent</SectionLabel>
          {(recsExpanded ? sentRecs : sentRecs.slice(0, 3)).map(rec => {
            const badge = REC_STATUS[rec.status] ?? { bg: '#f1f5f9', text: '#475569', label: rec.status };
            return (
              <TouchableOpacity
                key={rec.id}
                activeOpacity={0.7}
                onPress={() => router.push({
                  pathname: '/book/[id]',
                  params: {
                    id: rec.book_id,
                    title: rec.book?.title ?? '',
                    author: rec.book?.author ?? '',
                    coverUrl: rec.book?.cover_url ?? '',
                    externalId: rec.book?.external_id ?? '',
                    status: rec.status,
                    note: rec.note ?? '',
                    toUser: getFirstName(rec.to_user),
                  },
                })}
                style={{
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: '#ede9e4',
                  flexDirection: 'row',
                  alignItems: 'center',
                }}
              >
                <CoverThumb
                  url={rec.book?.cover_url}
                  externalId={rec.book?.external_id}
                  title={rec.book?.title}
                  width={32}
                  height={46}
                />
                <View style={{ flex: 1, marginLeft: 12, marginRight: 10 }}>
                  <Text style={{ fontWeight: '600', fontSize: 14, color: '#231f1b', marginBottom: 3 }}>
                    {rec.book?.title ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#9e958d' }}>
                    → {getFirstName(rec.to_user)}
                  </Text>
                  {rec.note ? (
                    <Text style={{ fontSize: 12, color: '#78716c', fontStyle: 'italic', marginTop: 4 }} numberOfLines={1}>
                      "{rec.note}"
                    </Text>
                  ) : null}
                </View>
                <View style={{
                  backgroundColor: badge.bg,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  alignSelf: 'center',
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: badge.text }}>{badge.label}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
          {sentRecs.length > 3 && (
            <TouchableOpacity
              onPress={() => setRecsExpanded(e => !e)}
              style={{ paddingVertical: 13, alignItems: 'center' }}
            >
              <Text style={{ fontSize: 13, color: '#9e958d' }}>
                {recsExpanded ? 'Show less' : `${sentRecs.length - 3} more`}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Combined social CTA (only when both Friends and Recs are empty) ── */}
      {acceptedFriends && acceptedFriends.length === 0 && sentRecs && sentRecs.length === 0 && (
        <View style={{ paddingHorizontal: 24, marginBottom: 28 }}>
          <TouchableOpacity
            onPress={() => router.push('/')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#fefcf9',
              borderRadius: 12,
              paddingVertical: 14,
              paddingHorizontal: 16,
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          >
            <Text style={{ fontSize: 14, color: '#57534e' }}>
              Find friends &amp; share what you&apos;re reading
            </Text>
            <Text style={{ fontSize: 16, color: '#ede9e4' }}>›</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

