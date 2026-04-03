import { useCallback, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { getDisplayName, getFirstName } from '../../lib/displayName';
import { computeGoalProgress } from '../../lib/pacing';
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

type YearBook = {
  id: string;
  book_id: string;
  finished_at: string | null;
  title: string;
  author: string;
  cover_url: string | null;
  external_id: string | null;
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
      color: '#a8a29e',
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
  const [booksThisYear, setBooksThisYear]       = useState<YearBook[] | null>(null);
  const [goalExpanded, setGoalExpanded]         = useState(false);
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
      finishedYearBooksRes,
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
      supabase
        .from('user_books')
        .select('id, book_id, finished_at, book:books(title, author, cover_url, external_id)')
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .is('deleted_at', null)
        .gte('finished_at', yearStart)
        .order('finished_at', { ascending: false })
        .limit(50),
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

    setBooksThisYear(((finishedYearBooksRes.data ?? []) as any[]).map(r => {
      const b = r.book as any;
      return {
        id:          r.id,
        book_id:     r.book_id,
        finished_at: r.finished_at ?? null,
        title:       b?.title ?? '',
        author:      b?.author ?? '',
        cover_url:   b?.cover_url ?? null,
        external_id: b?.external_id ?? null,
      };
    }));

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
          style={{ backgroundColor: '#1c1917', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 24 }}
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
  const goalProgress     = stats ? computeGoalProgress(stats.finishedThisYear, yearlyGoal) : null;

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
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
      }
    >
      {/* ── Profile header ── */}
      <View style={{
        paddingHorizontal: 24,
        paddingTop: 48,
        paddingBottom: 28,
        borderBottomWidth: 1,
        borderBottomColor: '#f0ede8',
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          {/* Avatar */}
          <View style={{
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: '#1c1917',
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
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 28 }}>
              {displayName}
            </Text>
            {hasChosenUsername ? (
              <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 4 }}>@{username}</Text>
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
            <Text style={{ fontSize: 13, color: '#a8a29e' }}>Settings</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Reading Goal ── */}
      <View style={{ paddingHorizontal: 24, marginTop: 24, marginBottom: 0 }}>
        {goalProgress ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 16,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => setGoalExpanded(e => !e)}
              style={{ flexDirection: 'row', alignItems: 'center' }}
            >
              <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500', flex: 1 }}>
                {goalProgress}
              </Text>
              <Text style={{ fontSize: 14, color: '#d6d3d1', marginLeft: 8 }}>
                {goalExpanded ? '↑' : '↓'}
              </Text>
            </TouchableOpacity>
            {yearlyGoal && stats && (
              <View style={{ height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden', marginTop: 10 }}>
                <View style={{
                  height: 3,
                  width: `${Math.min(100, Math.round((stats.finishedThisYear / yearlyGoal) * 100))}%`,
                  backgroundColor: '#1c1917',
                  borderRadius: 2,
                }} />
              </View>
            )}
            {goalExpanded && (
              <View style={{ marginTop: 14 }}>
                {booksThisYear === null ? (
                  <Text style={{ fontSize: 13, color: '#d6d3d1', lineHeight: 20 }}>Loading…</Text>
                ) : booksThisYear.length === 0 ? (
                  <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20 }}>
                    No books finished yet this year.
                  </Text>
                ) : (
                  <View>
                    {booksThisYear.map((book, idx) => (
                      <TouchableOpacity
                        key={book.id}
                        activeOpacity={0.7}
                        onPress={() => router.push({
                          pathname: '/book/[id]',
                          params: {
                            id: book.book_id,
                            title: book.title,
                            author: book.author,
                            coverUrl: book.cover_url ?? '',
                            externalId: book.external_id ?? '',
                            status: 'finished',
                          },
                        })}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 9,
                          borderTopWidth: idx > 0 ? 1 : 0,
                          borderTopColor: 'rgba(231,229,228,0.5)',
                        }}
                      >
                        <CoverThumb
                          url={book.cover_url}
                          externalId={book.external_id}
                          title={book.title}
                          width={28}
                          height={40}
                        />
                        <View style={{ flex: 1, marginLeft: 10 }}>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>
                            {book.title}
                          </Text>
                          <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }} numberOfLines={1}>
                            {book.author}
                          </Text>
                        </View>
                        {book.finished_at && (
                          <Text style={{ fontSize: 11, color: '#c4b5a5', marginLeft: 8 }}>
                            {new Date(book.finished_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </Text>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            style={{
              backgroundColor: '#fff',
              borderRadius: 14,
              padding: 16,
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text style={{ fontSize: 13, color: '#a8a29e' }}>Set a yearly reading goal</Text>
            <Text style={{ fontSize: 14, color: '#d6d3d1' }}>›</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Taste profile card ── */}
      <View style={{ paddingHorizontal: 24, marginTop: 14, marginBottom: 24 }}>
        <TouchableOpacity
          onPress={() => router.push('/edit-preferences')}
          style={{
            backgroundColor: '#fff',
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
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginBottom: hasTasteData ? 12 : 4 }}>
                {hasTasteData ? 'Reading Taste' : 'Build your taste profile'}
              </Text>
              {hasTasteData ? (
                <View style={{ gap: 10 }}>
                  {(prefs!.favorite_genres?.length ?? 0) > 0 && (
                    <View>
                      <Text style={{
                        fontSize: 10, fontWeight: '700', color: '#a8a29e',
                        letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6,
                      }}>Genres</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                        {prefs!.favorite_genres.slice(0, 4).map(g => (
                          <View key={g} style={{
                            backgroundColor: '#f5f5f4', borderRadius: 20,
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
                        fontSize: 10, fontWeight: '700', color: '#a8a29e',
                        letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6,
                      }}>Style</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                        {prefs!.reading_styles.slice(0, 3).map(s => (
                          <View key={s} style={{
                            backgroundColor: '#faf9f7', borderRadius: 20,
                            paddingHorizontal: 10, paddingVertical: 4,
                            borderWidth: 1, borderColor: '#e7e5e4',
                          }}>
                            <Text style={{ fontSize: 12, color: '#78716c' }}>{s}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                  {!!prefs!.favorite_authors && (
                    <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                      Incl. {prefs!.favorite_authors.split(',')[0].trim()}
                    </Text>
                  )}
                </View>
              ) : (
                <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 19 }}>
                  Genres, styles, and authors — unlocks future taste insights.
                </Text>
              )}
            </View>
            <Text style={{ fontSize: 20, color: '#d6d3d1', marginLeft: 12, marginTop: 2 }}>›</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* ── Reading Intelligence ── */}
      <View style={{ paddingHorizontal: 24, marginBottom: 28 }}>
        <SectionLabel>Reading Intelligence</SectionLabel>
        <View style={{
          backgroundColor: '#fff',
          borderRadius: 14,
          padding: 18,
          shadowColor: '#000',
          shadowOpacity: 0.04,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        }}>
          <View style={{
            alignSelf: 'flex-start',
            backgroundColor: '#f5f5f4',
            borderRadius: 6,
            paddingHorizontal: 8,
            paddingVertical: 3,
            marginBottom: 10,
          }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.7, textTransform: 'uppercase' }}>
              Coming soon
            </Text>
          </View>
          <Text style={{ fontSize: 14, color: '#57534e', lineHeight: 22 }}>
            Signals and patterns from your reading life.
          </Text>
          <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20, marginTop: 6 }}>
            Pace, completion habits, and how your taste aligns with friends — surfaced as you read.
          </Text>
        </View>
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
                borderBottomColor: '#f5f5f4',
              }}
            >
              <Text style={{ fontSize: 15, color: '#1c1917' }}>
                {getDisplayName(req.requester) !== 'Unknown' ? getDisplayName(req.requester) : req.requester_id}
              </Text>
              <TouchableOpacity
                onPress={() => handleAccept(req.id)}
                style={{ paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#1c1917', borderRadius: 8 }}
              >
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Accept</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* ── Friends ── */}
      <View style={{ paddingHorizontal: 24, marginBottom: 28 }}>
        <SectionLabel>Friends</SectionLabel>
        {acceptedFriends === null ? null : acceptedFriends.length === 0 ? (
          <TouchableOpacity
            onPress={() => router.push('/(tabs)/')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#fff',
              borderRadius: 12,
              paddingVertical: 13,
              paddingHorizontal: 16,
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          >
            <Text style={{ fontSize: 14, color: '#57534e' }}>Find friends to connect with</Text>
            <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
          </TouchableOpacity>
        ) : (
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
                    borderTopColor: '#f5f5f4',
                  }}
                >
                  <View style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: '#e7e5e4',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 12,
                  }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: '#57534e' }}>
                      {initial}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, color: '#1c1917', fontWeight: '500' }}>
                      {name}
                    </Text>
                    {showUsername && (
                      <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 1 }}>
                        @{friend.username}
                      </Text>
                    )}
                  </View>
                  <Text style={{ fontSize: 18, color: '#d6d3d1', marginLeft: 8 }}>›</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

      {/* ── Sent Recommendations ── */}
      <View style={{ paddingHorizontal: 24, marginBottom: 28 }}>
        <SectionLabel>Recommendations Sent</SectionLabel>
        {sentRecs === null ? null : sentRecs.length === 0 ? (
          <TouchableOpacity
            onPress={() => router.push('/(tabs)/library')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#fff',
              borderRadius: 12,
              paddingVertical: 13,
              paddingHorizontal: 16,
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          >
            <Text style={{ fontSize: 14, color: '#57534e' }}>Browse your library to send one</Text>
            <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
          </TouchableOpacity>
        ) : (
          <>
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
                    borderBottomColor: '#f5f5f4',
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
                    <Text style={{ fontWeight: '600', fontSize: 14, color: '#1c1917', marginBottom: 3 }}>
                      {rec.book?.title ?? '—'}
                    </Text>
                    <Text style={{ fontSize: 12, color: '#a8a29e' }}>
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
                <Text style={{ fontSize: 13, color: '#a8a29e' }}>
                  {recsExpanded ? 'Show less' : `${sentRecs.length - 3} more`}
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      {/* ── Settings link ── */}
      <TouchableOpacity
        onPress={() => router.push('/settings')}
        style={{
          alignSelf: 'center',
          paddingHorizontal: 24,
          paddingVertical: 10,
          borderWidth: 1,
          borderColor: '#e7e5e4',
          borderRadius: 8,
        }}
      >
        <Text style={{ fontSize: 14, color: '#78716c' }}>Settings</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

