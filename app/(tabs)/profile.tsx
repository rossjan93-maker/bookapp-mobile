import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { computeDatePacing, computePagePacing, computeGoalProgress } from '../../lib/pacing';
import { computeAvgPagesPerDay } from '../../lib/signals';

type Profile = {
  username: string;
  yearly_reading_goal: number | null;
};

type CurrentlyReading = {
  id: string;
  book_id: string;
  started_at: string | null;
  current_page: number | null;
  book: {
    title: string;
    author: string;
    cover_url: string | null;
    external_id: string;
    page_count: number | null;
  } | null;
};

type PendingRequest = {
  id: string;
  requester_id: string;
  requester: { username: string } | null;
};

type SentRecommendation = {
  id: string;
  book_id: string;
  status: string;
  created_at: string;
  note: string | null;
  to_user: { username: string } | null;
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
  const [currentlyReading, setCurrentlyReading] = useState<CurrentlyReading[]>([]);
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
  const [signals, setSignals]           = useState<ReaderSignals | null>(null);
  const [patterns, setPatterns]         = useState<ReadingPatterns | null>(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);

  // ── Inline goal editor state ──
  const [editingGoal, setEditingGoal]   = useState(false);
  const [goalDraft, setGoalDraft]       = useState('');
  const [savingGoal, setSavingGoal]     = useState(false);
  const [goalError, setGoalError]       = useState<string | null>(null);

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
      ] = await Promise.all([
        supabase.from('profiles').select('username, yearly_reading_goal').eq('id', user.id).single(),
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
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'finished')
          .gte('finished_at', yearStart),
        supabase
          .from('recommendations')
          .select(
            'id, book_id, status, created_at, note, ' +
            'to_user:profiles!recommendations_to_user_id_fkey(username), ' +
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
      ]);

      // Currently reading: try with progress columns, fall back if migration not yet applied.
      let crResult = await supabase
        .from('user_books')
        .select('id, book_id, started_at, current_page, book:books(title, author, cover_url, external_id, page_count)')
        .eq('user_id', user.id)
        .eq('status', 'reading')
        .order('started_at', { ascending: false });

      if (crResult.error) {
        crResult = await supabase
          .from('user_books')
          .select('id, book_id, started_at, book:books(title, author, cover_url, external_id)')
          .eq('user_id', user.id)
          .eq('status', 'reading')
          .order('started_at', { ascending: false });
      }

      if (profileRes.error) {
        setError('Could not load profile.');
      } else {
        setProfile(profileRes.data);
      }

      setCurrentlyReading((crResult.data as unknown as CurrentlyReading[]) ?? []);
      setPendingRequests((requestsRes.data as unknown as PendingRequest[]) ?? []);
      setSentRecs((sentRecsRes.data as unknown as SentRecommendation[]) ?? []);
      setPrefs(prefsRes.data ?? null);
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

      setLoading(false);
    }
    load();
  }, []));

  async function handleSaveGoal() {
    if (!supabase || !userId) return;
    const newGoal = parseInt(goalDraft.trim(), 10);
    if (isNaN(newGoal) || newGoal < 1 || newGoal > 365) {
      setGoalError('Enter a number between 1 and 365.');
      return;
    }
    setGoalError(null);
    setSavingGoal(true);
    const { error: updateErr } = await supabase
      .from('profiles')
      .update({ yearly_reading_goal: newGoal })
      .eq('id', userId);
    setSavingGoal(false);
    if (!updateErr) {
      setProfile(prev => prev ? { ...prev, yearly_reading_goal: newGoal } : prev);
      setEditingGoal(false);
    } else {
      setGoalError('Could not save goal — try again.');
    }
  }

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
  const yearlyGoal  = profile?.yearly_reading_goal ?? null;
  const goalProgress = stats ? computeGoalProgress(stats.finishedThisYear, yearlyGoal) : null;

  const hasTasteData = prefs && (
    (prefs.favorite_genres?.length ?? 0) > 0 ||
    (prefs.avoid_genres?.length ?? 0) > 0 ||
    (prefs.reading_styles?.length ?? 0) > 0 ||
    !!prefs.favorite_authors
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Hero header ── */}
      <View style={{
        backgroundColor: '#fff',
        paddingHorizontal: 20,
        paddingTop: 32,
        paddingBottom: 20,
        borderBottomWidth: 1,
        borderBottomColor: '#f5f5f4',
        shadowColor: '#000',
        shadowOpacity: 0.03,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 1 },
        elevation: 1,
      }}>
        {/* Avatar + name row */}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{
            width: 70,
            height: 70,
            borderRadius: 35,
            backgroundColor: '#1c1917',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 16,
          }}>
            <Text style={{ fontSize: 28, fontWeight: '800', color: '#fff' }}>
              {username.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#1c1917', letterSpacing: -0.4 }}>
              {username}
            </Text>
            <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 2 }}>{email ?? '—'}</Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push('/edit-preferences')}
            style={{
              borderWidth: 1,
              borderColor: '#e7e5e4',
              borderRadius: 8,
              paddingHorizontal: 11,
              paddingVertical: 7,
            }}
          >
            <Text style={{ fontSize: 12, color: '#57534e', fontWeight: '500' }}>Edit Taste</Text>
          </TouchableOpacity>
        </View>

        {/* ── Inline goal editor ── */}
        {!editingGoal ? (
          <View style={{ marginTop: 18 }}>
            {goalProgress ? (
              <View style={{
                backgroundColor: '#faf9f7',
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 12,
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500', flex: 1, marginRight: 10 }}>
                    {goalProgress}
                  </Text>
                  <TouchableOpacity
                    onPress={() => { setGoalDraft(String(yearlyGoal ?? '')); setGoalError(null); setEditingGoal(true); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={{ fontSize: 12, color: '#78716c', textDecorationLine: 'underline' }}>Edit goal</Text>
                  </TouchableOpacity>
                </View>
                {yearlyGoal && stats && (
                  <View style={{ height: 5, backgroundColor: '#e7e5e4', borderRadius: 3, overflow: 'hidden' }}>
                    <View style={{
                      height: 5,
                      width: `${Math.min(100, Math.round((stats.finishedThisYear / yearlyGoal) * 100))}%`,
                      backgroundColor: '#1c1917',
                      borderRadius: 3,
                    }} />
                  </View>
                )}
              </View>
            ) : (
              <TouchableOpacity
                onPress={() => { setGoalDraft(''); setGoalError(null); setEditingGoal(true); }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  backgroundColor: '#faf9f7',
                  borderRadius: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  borderWidth: 1,
                  borderColor: '#e7e5e4',
                  borderStyle: 'dashed',
                }}
              >
                <Text style={{ fontSize: 13, color: '#a8a29e' }}>
                  Set a yearly reading goal →
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <View style={{
            marginTop: 18,
            backgroundColor: '#faf9f7',
            borderRadius: 10,
            padding: 14,
            borderWidth: 1,
            borderColor: '#e7e5e4',
          }}>
            <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '600', marginBottom: 10 }}>
              Books per year goal
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TextInput
                value={goalDraft}
                onChangeText={setGoalDraft}
                keyboardType="number-pad"
                placeholder="24"
                placeholderTextColor="#a8a29e"
                returnKeyType="done"
                onSubmitEditing={handleSaveGoal}
                style={{
                  width: 72,
                  height: 40,
                  borderWidth: 1.5,
                  borderColor: '#d6d3d1',
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  fontSize: 18,
                  fontWeight: '700',
                  color: '#1c1917',
                  backgroundColor: '#fff',
                  textAlign: 'center',
                }}
              />
              <TouchableOpacity
                onPress={handleSaveGoal}
                disabled={savingGoal}
                style={{
                  backgroundColor: savingGoal ? '#d6d3d1' : '#1c1917',
                  borderRadius: 8,
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                }}
              >
                {savingGoal
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Save</Text>
                }
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setEditingGoal(false); setGoalError(null); }}
                style={{ paddingHorizontal: 10, paddingVertical: 10 }}
              >
                <Text style={{ fontSize: 13, color: '#a8a29e' }}>Cancel</Text>
              </TouchableOpacity>
            </View>
            {goalError && (
              <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{goalError}</Text>
            )}
          </View>
        )}
      </View>

      {/* ── Stats row ── */}
      {stats && (
        <View style={{
          flexDirection: 'row',
          backgroundColor: '#fff',
          paddingTop: 16,
          paddingBottom: 20,
          borderBottomWidth: 1,
          borderBottomColor: '#f5f5f4',
        }}>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 30, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 36 }}>{stats.finishedBooks}</Text>
            <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 2, letterSpacing: 0.7, textTransform: 'uppercase' }}>Finished</Text>
          </View>
          <View style={{ width: 1, backgroundColor: '#f0ede8', alignSelf: 'stretch', marginVertical: 6 }} />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 30, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 36 }}>{stats.friendsCount}</Text>
            <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 2, letterSpacing: 0.7, textTransform: 'uppercase' }}>Friends</Text>
          </View>
          <View style={{ width: 1, backgroundColor: '#f0ede8', alignSelf: 'stretch', marginVertical: 6 }} />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 30, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 36 }}>{stats.recsLanded}</Text>
            <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 2, letterSpacing: 0.7, textTransform: 'uppercase' }}>Recs Landed</Text>
          </View>
        </View>
      )}

      {/* ── Taste profile card ── */}
      <View style={{ paddingHorizontal: 20, marginBottom: 24 }}>
        <TouchableOpacity
          onPress={() => router.push('/edit-preferences')}
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 16,
            flexDirection: 'row',
            alignItems: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917', marginBottom: 4 }}>
              {hasTasteData ? 'Reading Taste' : 'Build your taste profile'}
            </Text>
            {hasTasteData ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                {prefs!.favorite_genres.slice(0, 4).map(g => (
                  <View key={g} style={{ backgroundColor: '#f5f5f4', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 11, color: '#57534e' }}>{g}</Text>
                  </View>
                ))}
                {(prefs!.favorite_genres.length + prefs!.reading_styles.length) > 4 && (
                  <View style={{ backgroundColor: '#f5f5f4', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 11, color: '#a8a29e' }}>
                      +{prefs!.favorite_genres.length + prefs!.reading_styles.length - 4} more
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 19 }}>
                Genres, styles, and authors — unlocks future taste insights.
              </Text>
            )}
          </View>
          <Text style={{ fontSize: 20, color: '#d6d3d1', marginLeft: 10 }}>›</Text>
        </TouchableOpacity>
      </View>

      {/* ── Currently Reading ── */}
      {currentlyReading.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
            <SectionLabel>Currently Reading</SectionLabel>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
          >
            {currentlyReading.map(item => {
              const hasPageData = !!(
                item.current_page && item.current_page > 0 &&
                item.book?.page_count && item.book.page_count > 0
              );
              const pct = hasPageData
                ? Math.min(100, Math.round((item.current_page! / item.book!.page_count!) * 100))
                : null;

              let pacingStr: string | null = null;
              let pacingIsAhead = false;
              let pacingState: 'ahead' | 'on_pace' | 'behind' | null = null;
              if (hasPageData) {
                const p = computePagePacing(
                  item.current_page!,
                  item.book!.page_count!,
                  item.started_at,
                  yearlyGoal
                );
                pacingStr   = p.note;
                pacingState = p.state;
                pacingIsAhead = p.state === 'ahead';
              } else {
                const dp  = computeDatePacing(item.started_at, yearlyGoal);
                pacingStr   = dp?.note ?? null;
                pacingState = dp?.state ?? null;
                pacingIsAhead = false; // date-based never claims 'ahead'
              }

              return (
                <TouchableOpacity
                  key={item.id}
                  activeOpacity={0.75}
                  onPress={() => router.push({
                    pathname: '/book/[id]',
                    params: {
                      id: item.book_id,
                      title: item.book?.title ?? '',
                      author: item.book?.author ?? '',
                      coverUrl: item.book?.cover_url ?? '',
                      externalId: item.book?.external_id ?? '',
                      status: 'reading',
                      startedAt: item.started_at ?? '',
                      readingGoal: String(yearlyGoal ?? ''),
                    },
                  })}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 14,
                    padding: 16,
                    width: 170,
                    borderWidth: pacingState ? 1.5 : 1,
                    borderColor: pacingState === 'behind'
                      ? '#fcd34d'
                      : pacingState === 'ahead'
                      ? '#86efac'
                      : '#f0ede8',
                    shadowColor: '#000',
                    shadowOpacity: 0.06,
                    shadowRadius: 8,
                    shadowOffset: { width: 0, height: 2 },
                    elevation: 2,
                  }}
                >
                  <CoverThumb
                    url={item.book?.cover_url}
                    externalId={item.book?.external_id}
                    width={90}
                    height={130}
                  />
                  <Text
                    numberOfLines={2}
                    style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginTop: 11, lineHeight: 18 }}
                  >
                    {item.book?.title ?? '—'}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 12, color: '#a8a29e', marginTop: 3 }}
                  >
                    {item.book?.author ?? '—'}
                  </Text>

                  {/* Progress bar */}
                  {pct !== null && (
                    <View style={{ marginTop: 8 }}>
                      <View style={{ height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden' }}>
                        <View style={{ height: 3, width: `${pct}%`, backgroundColor: '#1c1917', borderRadius: 2 }} />
                      </View>
                      <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 3 }}>
                        p.{item.current_page} of {item.book?.page_count}
                      </Text>
                    </View>
                  )}

                  {/* Pacing note */}
                  {pacingStr && (
                    <View style={{
                      backgroundColor: pacingIsAhead
                        ? '#f0fdf4'
                        : pacingState === 'behind'
                        ? '#fef9f0'
                        : '#faf9f7',
                      borderRadius: 6,
                      paddingHorizontal: 7,
                      paddingVertical: 4,
                      marginTop: pct !== null ? 5 : 8,
                    }}>
                      <Text style={{
                        fontSize: 10,
                        lineHeight: 14,
                        color: pacingIsAhead
                          ? '#15803d'
                          : pacingState === 'behind'
                          ? '#92400e'
                          : '#78716c',
                      }}>
                        {pacingStr}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* ── Reader Insights ── */}
      {signals && (() => {
        type InsightItem = { key: string; value: string; label: string };
        const items: InsightItem[] = [];

        // Completion rate — gated on ≥ 3 resolved books
        if (signals.resolved >= 3 && signals.completionRate !== null) {
          const pct = Math.round(signals.completionRate * 100);
          items.push({
            key: 'completion',
            value: `${pct}%`,
            label: pct >= 80
              ? 'of books finished — you rarely put them down'
              : pct >= 50
              ? 'of books read to completion'
              : 'of books finished — it\'s fine to DNF',
          });
        }

        // Avg pages/day — gated on actual data
        if (signals.avgPagesPerDay !== null) {
          items.push({
            key: 'pace',
            value: `~${signals.avgPagesPerDay}`,
            label: 'pages read per day on average',
          });
        }

        // Rec conversion — gated on ≥ 3 recs received
        if (signals.totalRecsReceived >= 3 && signals.recConversionRate !== null) {
          const pct = Math.round(signals.recConversionRate * 100);
          items.push({
            key: 'recs',
            value: `${pct}%`,
            label: 'of recommendations you\'ve finished',
          });
        }

        return (
          <View style={{ paddingHorizontal: 20, marginBottom: 28 }}>
            <SectionLabel>Reader Insights</SectionLabel>
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
              {items.length > 0 ? items.map((insight, i) => (
                <View
                  key={insight.key}
                  style={{
                    paddingHorizontal: 18,
                    paddingVertical: 14,
                    borderTopWidth: i > 0 ? 1 : 0,
                    borderTopColor: '#f5f5f4',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 14,
                  }}
                >
                  <Text style={{
                    fontSize: 26,
                    fontWeight: '800',
                    color: '#1c1917',
                    minWidth: 66,
                  }}>
                    {insight.value}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#78716c', flex: 1, lineHeight: 19 }}>
                    {insight.label}
                  </Text>
                </View>
              )) : (
                <View style={{ paddingHorizontal: 18, paddingVertical: 18 }}>
                  <Text style={{ fontSize: 14, color: '#a8a29e', lineHeight: 21 }}>
                    We're still learning your reading habits. Finish a few more books to unlock insights.
                  </Text>
                </View>
              )}
            </View>
          </View>
        );
      })()}

      {/* ── Reading Patterns ── */}
      {(() => {
        const lines: string[] = [];

        // Pattern 1: Library source mix
        // Threshold: ≥5 books with source attribution data
        if (patterns) {
          const sourceTotal = patterns.selfAdded + patterns.recAdded;
          if (sourceTotal >= 5) {
            const recShare = patterns.recAdded / sourceTotal;
            if (recShare >= 0.7) {
              lines.push("Your reading list leans heavily on friends' recommendations — you trust their taste.");
            } else if (recShare >= 0.4) {
              lines.push("About half your library came from recommendations, half from your own picks.");
            } else {
              lines.push("Most of your library is self-picked — you know what you want to read.");
            }
          }
        }

        // Pattern 2: Completion tendency (editorial phrasing)
        // Threshold: ≥5 resolved books (stricter than Reader Insights' ≥3)
        if (signals && signals.resolved >= 5 && signals.completionRate !== null) {
          const rate = signals.completionRate;
          let phrase: string;
          if (rate >= 0.90)      phrase = 'nearly every book you start';
          else if (rate >= 0.75) phrase = 'about 3 in 4 books you start';
          else if (rate >= 0.60) phrase = 'about 2 in 3 books you start';
          else if (rate >= 0.50) phrase = 'about half the books you start';
          else                   phrase = 'fewer than half the books you start';
          lines.push(`You tend to finish ${phrase}.`);
        }

        // Pattern 3: Social direction — giver vs receiver
        // Threshold: ≥3 total recommendation interactions
        const sentCount = sentRecs.length;
        const recvCount = signals?.totalRecsReceived ?? 0;
        if (sentCount + recvCount >= 3) {
          if (sentCount > recvCount * 1.5) {
            lines.push("You recommend more than you receive — your friends are in good hands.");
          } else if (recvCount > sentCount * 1.5) {
            lines.push("Friends recommend to you more than you recommend back.");
          } else {
            lines.push("You and your friends trade recommendations in both directions.");
          }
        }

        // Pattern 4: Pace context
        // Threshold: avgPagesPerDay ≥ 5 (filters out noise from very sparse data)
        if (signals?.avgPagesPerDay && signals.avgPagesPerDay >= 5) {
          const days = Math.round(300 / signals.avgPagesPerDay);
          lines.push(
            `At your typical pace, a 300-page book takes you about ${days} day${days === 1 ? '' : 's'}.`
          );
        }

        return (
          <View style={{ paddingHorizontal: 20, marginBottom: 28 }}>
            <SectionLabel>Reading Patterns</SectionLabel>
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
              {lines.length > 0 ? lines.map((line, i) => (
                <View
                  key={i}
                  style={{
                    paddingHorizontal: 18,
                    paddingVertical: 15,
                    borderTopWidth: i > 0 ? 1 : 0,
                    borderTopColor: '#f5f5f4',
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <View style={{
                    width: 2,
                    height: 20,
                    borderRadius: 1,
                    backgroundColor: '#d6d3d1',
                    marginTop: 1,
                    flexShrink: 0,
                  }} />
                  <Text style={{ fontSize: 14, color: '#1c1917', lineHeight: 21, flex: 1 }}>
                    {line}
                  </Text>
                </View>
              )) : (
                <View style={{ paddingHorizontal: 18, paddingVertical: 18 }}>
                  <Text style={{ fontSize: 14, color: '#a8a29e', lineHeight: 21 }}>
                    As you finish more books, your reading patterns will take shape.
                  </Text>
                </View>
              )}
            </View>
          </View>
        );
      })()}

      {/* ── Friend Requests ── */}
      <View style={{ paddingHorizontal: 20, marginBottom: 28 }}>
        <SectionLabel>
          {pendingRequests.length > 0
            ? `Friend Requests (${pendingRequests.length})`
            : 'Friend Requests'}
        </SectionLabel>
        {pendingRequests.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14 }}>No pending requests.</Text>
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
                borderBottomColor: '#f5f5f4',
              }}
            >
              <Text style={{ fontSize: 15, color: '#1c1917' }}>
                {req.requester?.username ?? req.requester_id}
              </Text>
              <TouchableOpacity
                onPress={() => handleAccept(req.id)}
                style={{ paddingHorizontal: 14, paddingVertical: 7, backgroundColor: '#1c1917', borderRadius: 8 }}
              >
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Accept</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      {/* ── Sent Recommendations ── */}
      <View style={{ paddingHorizontal: 20, marginBottom: 28 }}>
        <SectionLabel>Recommendations Sent</SectionLabel>
        {sentRecs.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14 }}>No recommendations sent yet.</Text>
        ) : (
          sentRecs.map(rec => {
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
                    toUser: rec.to_user?.username ?? '',
                  },
                })}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: '#f5f5f4',
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                }}
              >
                <CoverThumb
                  url={rec.book?.cover_url}
                  externalId={rec.book?.external_id}
                  width={36}
                  height={52}
                />
                <View style={{ flex: 1, marginLeft: 12, marginRight: 10 }}>
                  <Text style={{ fontWeight: '600', fontSize: 15, color: '#1c1917', marginBottom: 2 }}>
                    {rec.book?.title ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 3 }}>
                    {rec.book?.author ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                    to {rec.to_user?.username ?? '—'}
                  </Text>
                  {rec.note ? (
                    <Text style={{ fontSize: 12, color: '#78716c', fontStyle: 'italic', marginTop: 4 }}>
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
                  <Text style={{ fontSize: 11, fontWeight: '600', color: badge.text }}>{badge.label}</Text>
                </View>
              </TouchableOpacity>
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
          borderColor: '#e7e5e4',
          borderRadius: 8,
        }}
      >
        <Text style={{ fontSize: 14, color: '#78716c' }}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

