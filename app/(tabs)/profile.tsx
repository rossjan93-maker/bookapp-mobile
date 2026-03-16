import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
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
import { computeAvgPagesPerDay, computeSourceCompletion, sourceCompletionInsight } from '../../lib/signals';
import type { SourceCompletion } from '../../lib/signals';

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

export default function ProfileScreen() {
  const router = useRouter();
  const [email, setEmail]               = useState<string | null>(null);
  const [userId, setUserId]             = useState<string | null>(null);
  const [profile, setProfile]           = useState<Profile | null>(null);
  const [pendingRequests, setPendingRequests]    = useState<PendingRequest[]>([]);
  const [sentRecs, setSentRecs]         = useState<SentRecommendation[]>([]);
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
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [recsExpanded, setRecsExpanded]         = useState(false);
  const [acceptedFriends, setAcceptedFriends]   = useState<AcceptedFriend[]>([]);
  const [booksThisYear, setBooksThisYear]       = useState<YearBook[]>([]);
  const [goalExpanded, setGoalExpanded]         = useState(false);


  useFocusEffect(useCallback(() => {
    async function load() {
      if (!supabase) { setError('Supabase not configured.'); setLoading(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('No signed-in user.'); setLoading(false); return; }

      setEmail(user.email ?? null);
      setUserId(user.id);

      const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;

      const [
        profileRes,
        requestsRes,
        friendsRes,
        friendsListRes,
        landedRes,
        finishedFromRecRes,
        finishedAllRes,
        finishedYearRes,
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
        supabase.from('profiles').select('username, first_name, last_name, yearly_reading_goal').eq('id', user.id).single(),
        supabase
          .from('friendships')
          .select('id, requester_id, requester:profiles!friendships_requester_id_fkey(username, first_name, last_name)')
          .eq('addressee_id', user.id)
          .eq('status', 'pending'),
        supabase
          .from('friendships')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
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
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'finished')
          .gte('finished_at', yearStart),
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
        // ── Signal queries ──
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'dnf'),
        supabase
          .from('recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('to_user_id', user.id),
        supabase
          .from('recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('to_user_id', user.id)
          .eq('status', 'finished'),
        supabase
          .from('reading_progress_events')
          .select('user_book_id, page, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true }),
        // ── Pattern queries ──
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('source', 'self_added'),
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('source', 'recommendation'),
        // ── Source-completion queries ──
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('source', 'self_added')
          .eq('status', 'finished'),
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('source', 'self_added')
          .eq('status', 'dnf'),
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('source', 'recommendation')
          .eq('status', 'finished'),
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('source', 'recommendation')
          .eq('status', 'dnf'),
        supabase
          .from('user_books')
          .select('id, book_id, finished_at, book:books(title, author, cover_url, external_id)')
          .eq('user_id', user.id)
          .eq('status', 'finished')
          .gte('finished_at', yearStart)
          .order('finished_at', { ascending: false })
          .limit(50),
      ]);

      if (profileRes.error) {
        setError('Could not load profile.');
      } else {
        setProfile(profileRes.data);
      }

      setPendingRequests((requestsRes.data as unknown as PendingRequest[]) ?? []);
      setSentRecs((sentRecsRes.data as unknown as SentRecommendation[]) ?? []);
      setPrefs(prefsRes.data ?? null);

      // Derive accepted friends list from friendship rows
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

      setStats({
        friendsCount:      friendsRes.count ?? 0,
        recsLanded:        landedRes.count ?? 0,
        finishedFromRecs:  finishedFromRecRes.count ?? 0,
        finishedBooks:     finishedAllRes.count ?? 0,
        finishedThisYear:  finishedYearRes.count ?? 0,
      });

      // ── Reader signals ──
      const finished     = finishedAllRes.count ?? 0;
      const dnf          = dnfCountRes.count ?? 0;
      const resolved     = finished + dnf;
      const completionRate = resolved > 0 ? +(finished / resolved).toFixed(2) : null;

      const totalRecsReceived   = recReceivedTotalRes.count ?? 0;
      const finishedRecsReceived = recReceivedFinishedRes.count ?? 0;
      const recConversionRate = totalRecsReceived > 0
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

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf9f7' }}>
        <ActivityIndicator color="#78716c" />
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

  const username    = profile?.username ?? '—';
  const displayName = getDisplayName(profile);
  const yearlyGoal  = profile?.yearly_reading_goal ?? null;
  const goalProgress = stats ? computeGoalProgress(stats.finishedThisYear, yearlyGoal) : null;

  const hasTasteData = prefs && (
    (prefs.favorite_genres?.length ?? 0) > 0 ||
    (prefs.avoid_genres?.length ?? 0) > 0 ||
    (prefs.reading_styles?.length ?? 0) > 0 ||
    !!prefs.favorite_authors
  );

  // ── Reading Intelligence: Signals (quantitative) & Patterns (editorial) ──
  type SignalRow = { key: string; value: string; label: string };
  type PatternRow = { key: string; text: string };

  const signalRows: SignalRow[] = [];
  const patternRows: PatternRow[] = [];

  if (signals) {
    if (signals.avgPagesPerDay !== null && signals.avgPagesPerDay > 0) {
      const days = Math.round(300 / signals.avgPagesPerDay);
      const paceLabel = `pages/day \u00B7 a 300-page book in about ${days} day${days === 1 ? '' : 's'}`;
      signalRows.push({ key: 'pace', value: `~${signals.avgPagesPerDay}`, label: paceLabel });
    }
    if (signals.resolved >= 3 && signals.completionRate !== null) {
      const pct = Math.round(signals.completionRate * 100);
      signalRows.push({
        key: 'completion', value: `${pct}%`,
        label: pct >= 80 ? 'of books finished \u2014 you rarely put them down'
             : pct >= 50 ? 'of books read to completion'
             : 'of books finished \u2014 it\u2019s fine to DNF',
      });
    }
    if (signals.totalRecsReceived >= 3 && signals.recConversionRate !== null) {
      const pct = Math.round(signals.recConversionRate * 100);
      signalRows.push({ key: 'recs', value: `${pct}%`, label: 'of recommendations you\u2019ve finished' });
    }
  }

  if (sourceCompletion) {
    const srcLine = sourceCompletionInsight(sourceCompletion);
    if (srcLine) patternRows.push({ key: 'source_completion', text: srcLine });
  }
  if (patterns) {
    const sourceTotal = patterns.selfAdded + patterns.recAdded;
    if (sourceTotal >= 5) {
      const recShare = patterns.recAdded / sourceTotal;
      patternRows.push({
        key: 'source_mix',
        text: recShare >= 0.7 ? "Your reading list leans heavily on friends\u2019 recommendations \u2014 you trust their taste."
            : recShare >= 0.4 ? "About half your library came from recommendations, half from your own picks."
            : "Most of your library is self-picked \u2014 you know what you want to read.",
      });
    }
  }
  const sentCountIntel = sentRecs.length;
  const recvCountIntel = signals?.totalRecsReceived ?? 0;
  if (sentCountIntel + recvCountIntel >= 3) {
    const text = sentCountIntel > recvCountIntel * 1.5
      ? "You recommend more than you receive \u2014 your friends are in good hands."
      : recvCountIntel > sentCountIntel * 1.5
      ? "Friends recommend to you more than you recommend back."
      : "You and your friends trade recommendations in both directions.";
    patternRows.push({ key: 'social_direction', text });
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Hero header ── */}
      <View style={{
        paddingHorizontal: 24,
        paddingTop: 44,
        paddingBottom: 24,
      }}>
        {/* Avatar + name row */}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: '#1c1917',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 14,
          }}>
            <Text style={{ fontSize: 25, fontWeight: '800', color: '#fff' }}>
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5 }}>
              {displayName}
            </Text>
            <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 1 }}>@{username}</Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              borderWidth: 1,
              borderColor: '#e7e5e4',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 16, lineHeight: 20 }}>⚙</Text>
          </TouchableOpacity>
        </View>

        {/* ── Goal display ── */}
        {goalProgress ? (
          <View style={{ marginTop: 20 }}>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => setGoalExpanded(e => !e)}
              style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}
            >
              <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500', flex: 1 }}>
                {goalProgress}
              </Text>
              <Text style={{ fontSize: 15, color: '#d6d3d1', marginLeft: 8 }}>
                {goalExpanded ? '↑' : '↓'}
              </Text>
            </TouchableOpacity>
            {yearlyGoal && stats && (
              <View style={{ height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden' }}>
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
                {booksThisYear.length === 0 ? (
                  <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20 }}>
                    No books finished yet this year.
                  </Text>
                ) : (
                  <View style={{ borderRadius: 12, overflow: 'hidden' }}>
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
            style={{ marginTop: 16 }}
          >
            <Text style={{ fontSize: 13, color: '#a8a29e' }}>
              Set a yearly reading goal →
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Stats row ── */}
      {stats && (
        <View style={{
          flexDirection: 'row',
          paddingHorizontal: 24,
          paddingBottom: 24,
          borderBottomWidth: 1,
          borderBottomColor: '#e7e5e4',
        }}>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 28, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 34 }}>{stats.finishedBooks}</Text>
            <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 3, letterSpacing: 0.7, textTransform: 'uppercase' }}>Finished</Text>
          </View>
          <View style={{ width: 1, backgroundColor: '#e7e5e4', alignSelf: 'stretch', marginVertical: 4 }} />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <Text style={{ fontSize: 28, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 34 }}>{stats.friendsCount}</Text>
              {pendingRequests.length > 0 && (
                <View style={{
                  width: 7, height: 7, borderRadius: 4,
                  backgroundColor: '#f59e0b',
                  marginTop: 5, marginLeft: 3,
                }} />
              )}
            </View>
            <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 3, letterSpacing: 0.7, textTransform: 'uppercase' }}>Friends</Text>
          </View>
          <View style={{ width: 1, backgroundColor: '#e7e5e4', alignSelf: 'stretch', marginVertical: 4 }} />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 28, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 34 }}>{stats.recsLanded}</Text>
            <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 3, letterSpacing: 0.7, textTransform: 'uppercase' }}>Recs Landed</Text>
          </View>
        </View>
      )}

      {/* ── Taste profile card ── */}
      <View style={{ paddingHorizontal: 24, marginTop: 28, marginBottom: 24 }}>
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

        {/* Signals card */}
        <View style={{
          backgroundColor: '#fff',
          borderRadius: 14,
          overflow: 'hidden',
          shadowColor: '#000',
          shadowOpacity: 0.04,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
          marginBottom: 14,
        }}>
          <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: signalRows.length > 0 ? 0 : 14 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: signalRows.length > 0 ? 10 : 0 }}>Signals</Text>
          </View>
          {signalRows.length === 0 ? (
            <View style={{ paddingHorizontal: 18, paddingBottom: 18 }}>
              <Text style={{ fontSize: 14, color: '#a8a29e', lineHeight: 21 }}>
                Finish a few more books to unlock reading signals.
              </Text>
            </View>
          ) : (
            signalRows.map((row, i) => (
              <View key={row.key} style={{
                paddingHorizontal: 18, paddingVertical: 14,
                borderTopWidth: i > 0 ? 1 : 0, borderTopColor: '#f5f5f4',
                flexDirection: 'row', alignItems: 'center', gap: 14,
              }}>
                <Text style={{ fontSize: 26, fontWeight: '800', color: '#1c1917', minWidth: 66 }}>
                  {row.value}
                </Text>
                <Text style={{ fontSize: 13, color: '#78716c', flex: 1, lineHeight: 19 }}>
                  {row.label}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Patterns card */}
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
          <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: patternRows.length > 0 ? 0 : 14 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: patternRows.length > 0 ? 10 : 0 }}>Patterns</Text>
          </View>
          {patternRows.length === 0 ? (
            <View style={{ paddingHorizontal: 18, paddingBottom: 18 }}>
              <Text style={{ fontSize: 14, color: '#a8a29e', lineHeight: 21 }}>
                Keep reading to reveal your patterns.
              </Text>
            </View>
          ) : (
            patternRows.map((row, i) => (
              <View key={row.key} style={{
                paddingHorizontal: 18, paddingVertical: 14,
                borderTopWidth: i > 0 ? 1 : 0, borderTopColor: '#f5f5f4',
                flexDirection: 'row', alignItems: 'flex-start', gap: 12,
              }}>
                <View style={{
                  width: 2, height: 18, borderRadius: 1,
                  backgroundColor: '#d6d3d1', marginTop: 2, flexShrink: 0,
                }} />
                <Text style={{ fontSize: 13, color: '#57534e', lineHeight: 20, flex: 1 }}>
                  {row.text}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* ── Friend Requests (only rendered when pending) ── */}
      {pendingRequests.length > 0 && (
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
        {acceptedFriends.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14 }}>No friends yet.</Text>
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
        {sentRecs.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14 }}>No recommendations sent yet.</Text>
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

