import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { registerWtTarget, useWalkthrough } from '../../lib/walkthroughEngine';
import { WtDemoHome } from '../../components/walkthrough/WtDemoHome';
import { supabase } from '../../lib/supabase';
import { registerCacheClearer } from '../../lib/tabCache';
import { CoverThumb } from '../../components/CoverThumb';
import { HomeScreenSkeleton } from '../../components/Placeholder';
import { getDisplayName, getFirstName } from '../../lib/displayName';
import { computePagePacing, computeUserAvgPace } from '../../lib/pacing';
import { showToast } from '../../lib/toast';

// ─── Types ────────────────────────────────────────────────────────────────────

type CurrentRead = {
  id: string;
  book_id: string;
  started_at: string | null;
  current_page: number | null;
  title: string;
  author: string;
  cover_url: string | null;
  external_id: string | null;
  page_count: number | null;
};

type FeedEvent = {
  id: string;
  actor_id: string;
  event_type: string;
  created_at: string;
  book_id: string | null;
  rating: number | null;
  actor: { username: string; first_name: string | null; last_name: string | null } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

type ProfileResult = {
  id: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
};

type FriendshipRow = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  requester: { id: string; username: string; first_name: string | null; last_name: string | null } | null;
  addressee: { id: string; username: string; first_name: string | null; last_name: string | null } | null;
};

type YearBook = {
  id: string;
  book_id: string;
  finished_at: string | null;
  started_at: string | null;
  title: string;
  author: string;
  cover_url: string | null;
  external_id: string | null;
  page_count: number | null;
};

type RelationshipState = 'none' | 'pending' | 'accepted';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRelationship(
  userId: string,
  otherId: string,
  friendships: FriendshipRow[]
): RelationshipState {
  const row = friendships.find(
    f =>
      (f.requester_id === userId && f.addressee_id === otherId) ||
      (f.addressee_id === userId && f.requester_id === otherId)
  );
  if (!row) return 'none';
  if (row.status === 'accepted') return 'accepted';
  return 'pending';
}

function eventVerb(eventType: string): string {
  switch (eventType) {
    case 'recommendation_sent':     return 'recommended';
    case 'recommendation_saved':    return 'saved';
    case 'recommendation_started':  return 'started reading';
    case 'recommendation_finished': return 'finished';
    case 'book_finished':           return 'finished';
    case 'book_rated':              return 'rated';
    default: return '';
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}


function shortFinishDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

function InitialAvatar({ name }: { name: string }) {
  return (
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
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

// ─── Module-level session cache ───────────────────────────────────────────────
//
// Survives tab switches and sub-screen navigation. Cleared on sign-out.
// On cold mount: state initialised from cache → zero-spinner for return visits.
// Background refresh fires when cache is stale (> 60 s).

type HomeSnapshot = {
  userId:          string;
  greeting:        string;
  currentReads:    CurrentRead[];
  yearlyGoal:      number | null;
  pendingRecCount: number;
  booksThisYear:   YearBook[];
  feed:            FeedEvent[];
  friendships:     FriendshipRow[];
  fetchedAt:       number;
};

let _homeCache: HomeSnapshot | null = null;
const HOME_STALE_MS = 60_000;
// 'bookData' tag: also cleared when Book Detail performs a status/page action
registerCacheClearer(() => { _homeCache = null; }, 'bookData');

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Initialise from cache when it exists — renders meaningful content immediately
  // without a network round-trip on return visits.
  const [userId,          setUserId]          = useState<string | null>(() => _homeCache?.userId ?? null);
  const [greeting,        setGreeting]        = useState<string>(() => _homeCache?.greeting ?? '');

  // Dashboard modules
  const [currentReads,    setCurrentReads]    = useState<CurrentRead[]>(() => _homeCache?.currentReads ?? []);
  const [yearlyGoal,      setYearlyGoal]      = useState<number | null>(() => _homeCache?.yearlyGoal ?? null);
  const [pendingRecCount, setPendingRecCount] = useState<number>(() => _homeCache?.pendingRecCount ?? 0);
  const [booksThisYear,   setBooksThisYear]   = useState<YearBook[]>(() => _homeCache?.booksThisYear ?? []);
  const [goalExpanded,    setGoalExpanded]    = useState(false);

  // Activity feed
  const [feed,            setFeed]            = useState<FeedEvent[]>(() => _homeCache?.feed ?? []);
  // feedLoading is only true on a genuine cold start (no cache at all)
  const [feedLoading,     setFeedLoading]     = useState<boolean>(() => !_homeCache);
  const [feedError,       setFeedError]       = useState<string | null>(null);

  // Friends
  const [friendships,       setFriendships]       = useState<FriendshipRow[]>(() => _homeCache?.friendships ?? []);
  const [loadingFriendships, setLoadingFriendships] = useState<boolean>(() => !_homeCache);

  // Search
  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<ProfileResult[]>([]);
  const [searching,     setSearching]     = useState(false);
  const [searchError,   setSearchError]   = useState<string | null>(null);
  const [addingId,      setAddingId]      = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── Goal progress bar animation ──────────────────────────────────────────────
  // Animates the fill from 0 → actual% whenever the reading-goal data settles.
  const barFillAnim = useRef(new Animated.Value(0)).current;

  // Refs so we can write to the cache after all setters have been called
  // (state is async; refs give us the live values within the async load).
  const _crRef    = useRef<CurrentRead[]>([]);
  const _gyRef    = useRef<number | null>(null);
  const _prRef    = useRef<number>(0);
  const _byRef    = useRef<YearBook[]>([]);
  const _feedRef  = useRef<FeedEvent[]>([]);
  const _fsRef    = useRef<FriendshipRow[]>([]);

  // ── Walkthrough target measurement ──────────────────────────────────────────
  // Measure the first primary content section once data is loaded.
  // The overlay polls for this registration before showing the coach card.

  const { wtStep } = useWalkthrough();
  const homeTargetRef = useRef<any>(null);

  function measureHomeContent() {
    homeTargetRef.current?.measureInWindow((x: number, y: number, w: number, h: number) => {
      if (w > 0 && h > 0) {
        registerWtTarget('home_content', { x, y, width: w, height: h });
      }
    });
  }

  useEffect(() => {
    if (feedLoading || wtStep !== 'home') return;
    // Brief settle time after render before measuring
    const t = setTimeout(measureHomeContent, 120);
    return () => clearTimeout(t);
  }, [feedLoading, wtStep]);

  // Animate progress bar whenever the goal data settles.
  // Uses raw state values (available before the loading guard) rather than the
  // derived goalActualPct (which is computed after the early return).
  useEffect(() => {
    if (feedLoading || !yearlyGoal || yearlyGoal <= 0) return;
    const pct = Math.min(100, Math.round((booksThisYear.length / yearlyGoal) * 100));
    Animated.timing(barFillAnim, {
      toValue:         pct,
      duration:        900,
      delay:           120,
      easing:          Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [feedLoading, yearlyGoal, booksThisYear.length]);

  async function loadAll() {
    const t0 = Date.now();
    if (!supabase) {
      setFeedLoading(false);
      setLoadingFriendships(false);
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setFeedLoading(false);
      setLoadingFriendships(false);
      return;
    }
    // Belt-and-suspenders: clear stale cache if the user switched accounts
    if (_homeCache && _homeCache.userId !== user.id) _homeCache = null;
    setUserId(user.id);

    const meta = user.user_metadata as { first_name?: string } | undefined;
    const greetingName = meta?.first_name ?? '';
    setGreeting(greetingName);

    // ── Parallel fetch: friendships + all user-specific data at once ────────────
    // Previously: loadFriendships() was awaited alone, blocking everything else.
    // Now: all 4 queries start simultaneously. Feed is kicked off once friend IDs
    // are known, but the dashboard content is unblocked from the start.
    const [friendshipRows] = await Promise.all([
      loadFriendships(user.id),
      loadCurrentRead(user.id),
      loadPendingRecs(user.id),
      loadBooksThisYear(user.id),
    ]);

    // Dashboard is ready — clear the loading gate (if it was set on cold start)
    setFeedLoading(false);
    setLoadingFriendships(false);

    if (__DEV__) console.log(`[PERF] Home dashboard ready in ${Date.now() - t0}ms (source: ${_homeCache ? 'background-refresh' : 'cold-start'})`);

    // Feed requires friend IDs — start it after friendships resolves
    const acceptedFriendIds = (friendshipRows ?? [])
      .filter(f => f.status === 'accepted')
      .map(f => (f.requester_id === user.id ? f.addressee_id : f.requester_id));

    await loadFeed([user.id, ...acceptedFriendIds]);

    if (__DEV__) console.log(`[PERF] Home fully loaded in ${Date.now() - t0}ms`);

    // Persist snapshot for future cold starts / tab switches
    _homeCache = {
      userId:          user.id,
      greeting:        greetingName,
      currentReads:    _crRef.current,
      yearlyGoal:      _gyRef.current,
      pendingRecCount: _prRef.current,
      booksThisYear:   _byRef.current,
      feed:            _feedRef.current,
      friendships:     _fsRef.current,
      fetchedAt:       Date.now(),
    };
  }

  useFocusEffect(useCallback(() => {
    // Skip re-fetch if we have a fresh snapshot — avoids churn on every tab tap.
    if (_homeCache && Date.now() - _homeCache.fetchedAt < HOME_STALE_MS) return;
    loadAll();
  }, []));

  // ── Data loaders ─────────────────────────────────────────────────────────────

  async function loadFeed(actorIds: string[]) {
    if (!supabase) return;
    if (actorIds.length === 0) {
      const empty: FeedEvent[] = [];
      setFeed(empty);
      _feedRef.current = empty;
      return;
    }
    const { data, error } = await supabase
      .from('activity_events')
      .select(
        'id, actor_id, event_type, created_at, book_id, rating, ' +
        'actor:profiles!activity_events_actor_id_fkey(username, first_name, last_name), ' +
        'book:books!activity_events_book_id_fkey(title, author, cover_url, external_id)'
      )
      .in('actor_id', actorIds)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      setFeedError('Could not load feed.');
    } else {
      const rows = (data as FeedEvent[]) ?? [];
      setFeed(rows);
      _feedRef.current = rows;
    }
  }

  async function loadFriendships(uid: string): Promise<FriendshipRow[]> {
    if (!supabase) return [];
    const { data } = await supabase
      .from('friendships')
      .select(
        'id, requester_id, addressee_id, status, ' +
        'requester:profiles!friendships_requester_id_fkey(id, username, first_name, last_name), ' +
        'addressee:profiles!friendships_addressee_id_fkey(id, username, first_name, last_name)'
      )
      .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
    const rows = (data as FriendshipRow[]) ?? [];
    setFriendships(rows);
    _fsRef.current = rows;
    return rows;
  }

  async function loadCurrentRead(uid: string) {
    if (!supabase) return;

    // Fetch yearly goal and reading books in parallel — previously sequential
    const [profileRes, readingRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('yearly_reading_goal')
        .eq('id', uid)
        .single(),
      supabase
        .from('user_books')
        .select('id, book_id, started_at, current_page, book:books(title, author, cover_url, external_id, page_count)')
        .eq('user_id', uid)
        .eq('status', 'reading')
        .is('deleted_at', null)
        .order('progress_updated_at', { ascending: false, nullsFirst: false }),
    ]);

    const goal = profileRes.data?.yearly_reading_goal ?? null;
    setYearlyGoal(goal);
    _gyRef.current = goal;

    // Fall back to older schema if progress_updated_at column is missing
    let res = readingRes;
    if (res.error) {
      res = await supabase
        .from('user_books')
        .select('id, book_id, started_at, book:books(title, author, cover_url, external_id)')
        .eq('user_id', uid)
        .eq('status', 'reading')
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
    }

    const rows = (res.data as any[]) ?? [];
    const mapped = rows.map(r => {
      const b = r.book as any;
      return {
        id:           r.id,
        book_id:      r.book_id,
        started_at:   r.started_at ?? null,
        current_page: r.current_page ?? null,
        title:        b?.title ?? '',
        author:       b?.author ?? '',
        cover_url:    b?.cover_url ?? null,
        external_id:  b?.external_id ?? null,
        page_count:   b?.page_count ?? null,
      };
    });
    setCurrentReads(mapped);
    _crRef.current = mapped;
  }

  async function loadPendingRecs(uid: string) {
    if (!supabase) return;
    const { count } = await supabase
      .from('recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('to_user_id', uid)
      .eq('status', 'pending');
    const n = count ?? 0;
    setPendingRecCount(n);
    _prRef.current = n;
  }

  async function loadBooksThisYear(uid: string) {
    if (!supabase) return;
    const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;
    const { data } = await supabase
      .from('user_books')
      .select('id, book_id, started_at, finished_at, book:books(title, author, cover_url, external_id, page_count)')
      .eq('user_id', uid)
      .eq('status', 'finished')
      .is('deleted_at', null)
      .gte('finished_at', yearStart)
      .order('finished_at', { ascending: false });
    const rows = (data as any[]) ?? [];
    const mapped = rows.map(r => {
      const b = r.book as any;
      return {
        id:          r.id,
        book_id:     r.book_id,
        started_at:  r.started_at ?? null,
        finished_at: r.finished_at ?? null,
        title:       b?.title ?? '',
        author:      b?.author ?? '',
        cover_url:   b?.cover_url ?? null,
        external_id: b?.external_id ?? null,
        page_count:  b?.page_count ?? null,
      };
    });
    setBooksThisYear(mapped);
    _byRef.current = mapped;
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      runSearch(trimmed);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, userId]);

  async function runSearch(query: string) {
    if (!supabase || !userId) return;
    setSearching(true);
    setSearchError(null);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, first_name, last_name')
      .ilike('username', `%${query}%`)
      .neq('id', userId)
      .limit(20);
    if (error) {
      setSearchError('Search failed.');
    } else {
      setSearchResults((data as ProfileResult[]) ?? []);
    }
    setSearching(false);
  }

  async function handleAddFriend(otherId: string) {
    if (!supabase || !userId) return;
    setAddingId(otherId);
    const { error } = await supabase.from('friendships').insert({
      requester_id: userId,
      addressee_id: otherId,
      status: 'pending',
    });
    if (!error) {
      await loadFriendships(userId);
      showToast('Friend request sent');
    }
    setAddingId(null);
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const acceptedFriends = friendships
    .filter(f => f.status === 'accepted')
    .map(f => (f.requester_id === userId ? f.addressee : f.requester))
    .filter(Boolean) as { id: string; username: string; first_name: string | null; last_name: string | null }[];

  const displayedFeed = feed.filter(e => eventVerb(e.event_type)).slice(0, 10);
  const totalFeedWithVerb = feed.filter(e => eventVerb(e.event_type)).length;

  // ── Loading ───────────────────────────────────────────────────────────────────

  if (feedLoading || loadingFriendships) {
    return <HomeScreenSkeleton />;
  }

  // ── Progress + pacing helpers ─────────────────────────────────────────────────

  const yearAvgPace: number | null = computeUserAvgPace(
    booksThisYear.map(b => ({
      started_at:  b.started_at,
      finished_at: b.finished_at,
      pageCount:   b.page_count,
    }))
  );

  // ── Reading Goal card derived values ─────────────────────────────────────────
  const goalDayOfYear = Math.floor(
    (new Date().getTime() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000
  );
  const goalExpectedByNow  = yearlyGoal ? Math.floor((goalDayOfYear / 365) * yearlyGoal) : 0;
  const goalSurplus        = Math.max(0, booksThisYear.length - goalExpectedByNow);
  const goalDeficit        = Math.max(0, goalExpectedByNow - booksThisYear.length);
  const goalActualPct      = yearlyGoal ? Math.min(100, Math.round((booksThisYear.length / yearlyGoal) * 100)) : 0;
  const goalExpectedPct    = yearlyGoal ? Math.min(100, Math.round((goalExpectedByNow / yearlyGoal) * 100)) : 0;
  const goalIsAhead        = goalSurplus >= 2;
  const goalIsBehind       = goalDeficit >= 2;
  const goalDirIcon        = goalIsAhead ? '↑' : goalIsBehind ? '↓' : '→';
  const goalDirColor       = goalIsAhead ? '#15803d' : goalIsBehind ? '#d97706' : '#78716c';
  const goalStatusText     = goalIsAhead
    ? `You're ${goalSurplus} book${goalSurplus !== 1 ? 's' : ''} ahead of pace`
    : goalIsBehind
    ? `You're ${goalDeficit} book${goalDeficit !== 1 ? 's' : ''} behind pace`
    : goalExpectedByNow === 0
    ? 'Keep reading to build your pace'
    : "You're right on pace";
  const goalProjected: number | null =
    booksThisYear.length > 0 && goalDayOfYear >= 14
      ? Math.round(booksThisYear.length / (goalDayOfYear / 365))
      : null;

  function homeCardBorderColor(cr: CurrentRead, goal: number | null): string {
    const pageCount = cr.page_count;
    if (!goal || !pageCount || pageCount <= 0) return '#ede9e4';
    const { state } = computePagePacing(cr.current_page ?? 0, pageCount, cr.started_at, goal);
    if (state === 'ahead' || state === 'on_pace') return '#86efac';
    if (state === 'behind') return '#fcd34d';
    return '#ede9e4';
  }

  function progressLabel(cr: CurrentRead): string {
    if (cr.current_page && cr.page_count) {
      const pct = Math.round((cr.current_page / cr.page_count) * 100);
      return `Page ${cr.current_page} of ${cr.page_count} · ${pct}%`;
    }
    if (cr.current_page) return `Page ${cr.current_page}`;
    return 'In progress';
  }

  function progressPct(cr: CurrentRead): number {
    if (cr.current_page && cr.page_count && cr.page_count > 0) {
      return Math.min(cr.current_page / cr.page_count, 1);
    }
    return 0;
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  async function handleRefresh() {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }

  if (wtStep === 'home') {
    return (
      <ScrollView
        style={{ backgroundColor: '#f5f1ec' }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 16, paddingBottom: 40 }}
      >
        <WtDemoHome greeting={greeting} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: '#f5f1ec' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 16, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
      }
    >
      {/* ── Hero heading ── */}
      <View style={{ marginBottom: 28 }}>
        <Text style={{
          fontSize: 20,
          fontWeight: '600',
          color: '#78716c',
          letterSpacing: -0.2,
        }}>
          {greeting ? `Hi, ${greeting}` : 'Home'}
        </Text>
      </View>

      {/* ── 1. Continue Reading ── */}
      {currentReads.length > 0 && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Continue Reading</SectionLabel>

          {/* Walkthrough ref wraps only the card(s), not the section label */}
          <View ref={homeTargetRef} onLayout={measureHomeContent}>
          {currentReads.length === 1 ? (() => {
            const cr = currentReads[0];
            const accentColor = homeCardBorderColor(cr, yearlyGoal);
            return (
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => router.push({
                  pathname: '/book/[id]',
                  params: {
                    id: cr.book_id,
                    title: cr.title,
                    author: cr.author,
                    coverUrl: cr.cover_url ?? '',
                    externalId: cr.external_id ?? '',
                    status: 'reading',
                    startedAt: cr.started_at ?? '',
                  },
                })}
              >
                <View style={{
                  backgroundColor: '#fefcf9',
                  borderRadius: 16,
                  padding: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  shadowColor: '#000',
                  shadowOpacity: 0.06,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: 2,
                  borderLeftWidth: 3,
                  borderLeftColor: accentColor,
                }}>
                  <CoverThumb url={cr.cover_url} externalId={cr.external_id} title={cr.title} width={56} height={82} />
                  <View style={{ flex: 1, marginLeft: 16 }}>
                    <Text style={{
                      fontSize: 16, fontWeight: '700', color: '#231f1b', lineHeight: 22, marginBottom: 3,
                    }} numberOfLines={2}>{cr.title}</Text>
                    <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 12 }} numberOfLines={1}>
                      {cr.author}
                    </Text>
                    {(cr.current_page || cr.page_count) ? (
                      <>
                        <View style={{
                          height: 3, backgroundColor: '#ede9e4', borderRadius: 2, marginBottom: 6, overflow: 'hidden',
                        }}>
                          {progressPct(cr) > 0 && (
                            <View style={{
                              height: 3, width: `${progressPct(cr) * 100}%`, backgroundColor: '#231f1b', borderRadius: 2,
                            }} />
                          )}
                        </View>
                        <Text style={{ fontSize: 11, color: '#9e958d' }}>{progressLabel(cr)}</Text>
                      </>
                    ) : (
                      <Text style={{ fontSize: 11, color: '#9e958d' }}>In progress</Text>
                    )}
                  </View>
                  <Text style={{ fontSize: 20, color: '#ede9e4', marginLeft: 8 }}>›</Text>
                </View>
              </TouchableOpacity>
            );
          })() : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginHorizontal: -20 }}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
            >
              {currentReads.map(cr => {
                const accentColor = homeCardBorderColor(cr, yearlyGoal);
                const hasProgress = !!(cr.current_page && cr.page_count && cr.page_count > 0);
                const pct = hasProgress
                  ? Math.min(100, Math.round((cr.current_page! / cr.page_count!) * 100))
                  : null;
                const hasPacingData = !!(yearlyGoal && cr.page_count && cr.page_count > 0);
                const pacingNote = hasPacingData
                  ? computePagePacing(cr.current_page ?? 0, cr.page_count!, cr.started_at, yearlyGoal!).note
                  : null;
                return (
                  <TouchableOpacity
                    key={cr.id}
                    activeOpacity={0.8}
                    onPress={() => router.push({
                      pathname: '/book/[id]',
                      params: {
                        id: cr.book_id,
                        title: cr.title,
                        author: cr.author,
                        coverUrl: cr.cover_url ?? '',
                        externalId: cr.external_id ?? '',
                        status: 'reading',
                        startedAt: cr.started_at ?? '',
                      },
                    })}
                  >
                    <View style={{
                      backgroundColor: '#fefcf9',
                      borderRadius: 14,
                      padding: 14,
                      width: 220,
                      borderLeftWidth: 3,
                      borderLeftColor: accentColor,
                      shadowColor: '#000',
                      shadowOpacity: 0.06,
                      shadowRadius: 8,
                      shadowOffset: { width: 0, height: 2 },
                      elevation: 2,
                    }}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
                        <CoverThumb url={cr.cover_url} externalId={cr.external_id} title={cr.title} width={44} height={64} />
                        <View style={{ flex: 1, marginLeft: 10 }}>
                          <Text numberOfLines={2} style={{
                            fontSize: 14, fontWeight: '700', color: '#231f1b', lineHeight: 19, marginBottom: 3,
                          }}>{cr.title}</Text>
                          <Text numberOfLines={1} style={{ fontSize: 12, color: '#78716c' }}>{cr.author}</Text>
                        </View>
                      </View>
                      {hasProgress ? (
                        <>
                          <View style={{
                            height: 3, backgroundColor: '#ede9e4', borderRadius: 2, overflow: 'hidden', marginBottom: 4,
                          }}>
                            <View style={{
                              height: 3, width: `${pct ?? 0}%`, backgroundColor: '#231f1b', borderRadius: 2,
                            }} />
                          </View>
                          <Text style={{ fontSize: 10, color: '#9e958d', marginBottom: pacingNote ? 5 : 0 }}>
                            {progressLabel(cr)}
                          </Text>
                        </>
                      ) : (
                        <Text style={{ fontSize: 10, color: '#9e958d', marginBottom: pacingNote ? 5 : 0 }}>
                          In progress
                        </Text>
                      )}
                      {pacingNote && (
                        <Text style={{ fontSize: 10, color: '#78716c' }}>{pacingNote}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          </View>{/* close homeTargetRef wrapper */}
        </View>
      )}

      {/* ── Yearly Reading Goal ── */}
      {yearlyGoal && yearlyGoal > 0 && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Reading Goal</SectionLabel>
          {/* Walkthrough ref wraps only the goal card, not the section label */}
          <View
            ref={currentReads.length === 0 ? homeTargetRef : undefined}
            onLayout={currentReads.length === 0 ? measureHomeContent : undefined}
          >
          <TouchableOpacity activeOpacity={0.8} onPress={() => setGoalExpanded(e => !e)}>
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 16,
              padding: 18,
              shadowColor: '#000',
              shadowOpacity: 0.06,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              elevation: 2,
            }}>
              {/* ── 1. Headline + directional icon ── */}
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 24, fontWeight: '800', color: '#231f1b', letterSpacing: -0.6 }}>
                    {booksThisYear.length}
                    <Text style={{ fontSize: 15, fontWeight: '400', color: '#9e958d' }}> / {yearlyGoal} books</Text>
                  </Text>
                </View>
                <Text style={{ fontSize: 22, color: goalDirColor, marginLeft: 10, marginTop: 3 }}>
                  {goalDirIcon}
                </Text>
              </View>

              {/* ── 2. Status statement ── */}
              <Text style={{ fontSize: 13, color: goalDirColor, fontWeight: '500', marginBottom: 14 }}>
                {goalStatusText}
              </Text>

              {/* ── 3. Goal-aware progress bar ── */}
              <View style={{
                height: 7,
                backgroundColor: '#ede9e4',
                borderRadius: 4,
                marginBottom: 14,
                overflow: 'hidden',
              }}>
                <Animated.View style={{
                  height: 7,
                  width: barFillAnim.interpolate({
                    inputRange:  [0, 100],
                    outputRange: ['0%', '100%'],
                    extrapolate: 'clamp',
                  }),
                  backgroundColor: '#231f1b',
                  borderRadius: 4,
                }} />
                {goalExpectedPct > 0 && goalExpectedPct < 100 && (
                  <View style={{
                    position: 'absolute',
                    left: `${goalExpectedPct}%`,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    backgroundColor: goalActualPct >= goalExpectedPct
                      ? 'rgba(255,255,255,0.55)'
                      : 'rgba(0,0,0,0.22)',
                  }} />
                )}
              </View>

              {/* ── 4. Finish projection ── */}
              {goalProjected !== null && (
                <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18, marginBottom: 10 }}>
                  {`At your current pace, you'll finish ~${goalProjected} book${goalProjected !== 1 ? 's' : ''} this year`}
                </Text>
              )}

              {/* ── 5. Compact pace chip + expand indicator ── */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                {yearAvgPace !== null ? (
                  <Text style={{ fontSize: 11, color: '#9e958d' }}>
                    {`~${yearAvgPace} pages/day · ${goalIsAhead ? 'Ahead of pace' : goalIsBehind ? 'Behind pace' : 'On pace'}`}
                  </Text>
                ) : <View />}
                {booksThisYear.length > 0 && (
                  <Text style={{ fontSize: 11, color: '#c4b5a5' }}>
                    {goalExpanded
                      ? '▴ hide'
                      : `▾ ${booksThisYear.length} book${booksThisYear.length !== 1 ? 's' : ''}`}
                  </Text>
                )}
              </View>
            </View>
          </TouchableOpacity>

          {goalExpanded && (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              marginTop: 8,
              overflow: 'hidden',
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}>
              {booksThisYear.length === 0 ? (
                <View style={{ padding: 18 }}>
                  <Text style={{ fontSize: 13, color: '#9e958d', lineHeight: 20 }}>
                    No books finished yet this year.{'\n'}Keep reading — you've got this.
                  </Text>
                </View>
              ) : (
                booksThisYear.map((book, idx) => (
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
                      paddingVertical: 10,
                      paddingHorizontal: 14,
                      borderTopWidth: idx > 0 ? 1 : 0,
                      borderTopColor: '#ede9e4',
                    }}
                  >
                    <CoverThumb
                      url={book.cover_url}
                      externalId={book.external_id}
                      title={book.title}
                      width={32}
                      height={46}
                    />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#231f1b' }} numberOfLines={1}>
                        {book.title}
                      </Text>
                      <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 1 }} numberOfLines={1}>
                        {book.author}
                      </Text>
                    </View>
                    {book.finished_at && (
                      <Text style={{ fontSize: 11, color: '#c4b5a5', marginLeft: 8 }}>
                        {shortFinishDate(book.finished_at)}
                      </Text>
                    )}
                  </TouchableOpacity>
                ))
              )}
            </View>
          )}
          </View>{/* close homeTargetRef wrapper */}
        </View>
      )}

      {/* ── 2. Timeline (self + network activity) ── */}
      {/* For new users with no reads and no goal, the "Nothing yet" card below
          is the walkthrough target — a specific bounded white card, not this wrapper. */}
      <View style={{ marginBottom: 32 }}>
        <SectionLabel>Timeline</SectionLabel>

        {/* Pending recs banner — surfaces above the event stream */}
        {pendingRecCount > 0 && (
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push('/(tabs)/notes')}
            style={{ marginBottom: 12 }}
          >
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              flexDirection: 'row',
              alignItems: 'center',
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}>
              <View style={{
                width: 38, height: 38, borderRadius: 19,
                backgroundColor: '#ede9e4',
                alignItems: 'center', justifyContent: 'center',
                marginRight: 12,
              }}>
                <Text style={{ fontSize: 18 }}>📬</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 1 }}>
                  {pendingRecCount === 1
                    ? '1 recommendation waiting'
                    : `${pendingRecCount} recommendations waiting`}
                </Text>
                <Text style={{ fontSize: 12, color: '#9e958d' }}>
                  See what your friends picked for you
                </Text>
              </View>
              <Text style={{ fontSize: 18, color: '#ede9e4' }}>›</Text>
            </View>
          </TouchableOpacity>
        )}

        {feedError ? (
          <View style={{ marginBottom: 16 }}>
            <Text style={{ color: '#b91c1c', fontSize: 14, marginBottom: 10 }}>{feedError}</Text>
            <TouchableOpacity
              onPress={() => { setFeedError(null); loadAll(); }}
              style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: '#ede9e4', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 14 }}
            >
              <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500' }}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : totalFeedWithVerb === 0 && pendingRecCount === 0 ? (
          <View
            ref={(!currentReads.length && !(yearlyGoal && yearlyGoal > 0)) ? homeTargetRef : undefined}
            onLayout={(!currentReads.length && !(yearlyGoal && yearlyGoal > 0)) ? measureHomeContent : undefined}
            style={{
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              padding: 24,
              alignItems: 'center',
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          >
            <Text style={{ color: '#9e958d', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
              Nothing yet.{'\n'}Finish or rate a book to get started.
            </Text>
          </View>
        ) : (
          <>
            {displayedFeed.map(event => {
              const verb = eventVerb(event.event_type);
              const isSelf = event.actor_id === userId;
              const actor = isSelf ? 'You' : getFirstName(event.actor);
              const title = event.book?.title ?? '';
              const author = event.book?.author ?? '';
              const canTap = !!event.book_id && !!title;

              const card = (
                <View
                  style={{
                    backgroundColor: '#fefcf9',
                    borderRadius: 14,
                    padding: 16,
                    marginBottom: 10,
                    shadowColor: '#000',
                    shadowOpacity: 0.05,
                    shadowRadius: 6,
                    shadowOffset: { width: 0, height: 1 },
                    elevation: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                >
                  <CoverThumb
                    url={event.book?.cover_url}
                    externalId={event.book?.external_id}
                    title={event.book?.title}
                    width={40}
                    height={58}
                  />
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', marginBottom: 2 }}>
                      {actor}{' '}
                      <Text style={{ fontWeight: '400', color: '#57534e' }}>{verb}</Text>
                    </Text>
                    {title ? (
                      <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', lineHeight: 20, marginBottom: 2 }}>
                        {title}
                      </Text>
                    ) : null}
                    {author ? (
                      <Text style={{ fontSize: 12, color: '#9e958d', marginBottom: 4 }}>
                        {author}
                      </Text>
                    ) : null}
                    {event.rating != null ? (
                      <Text style={{ fontSize: 12, color: '#78716c', marginBottom: 4 }}>
                        {'★'.repeat(event.rating)}{'☆'.repeat(5 - event.rating)} · {event.rating}/5
                      </Text>
                    ) : null}
                    <Text style={{ fontSize: 11, color: '#c4b5a5' }}>
                      {relativeTime(event.created_at)}
                    </Text>
                  </View>
                </View>
              );

              if (canTap) {
                return (
                  <TouchableOpacity
                    key={event.id}
                    activeOpacity={0.75}
                    onPress={() => router.push({
                      pathname: '/book/[id]',
                      params: {
                        id: event.book_id!,
                        title: event.book?.title ?? '',
                        author: event.book?.author ?? '',
                        coverUrl: event.book?.cover_url ?? '',
                        externalId: event.book?.external_id ?? '',
                      },
                    })}
                  >
                    {card}
                  </TouchableOpacity>
                );
              }
              return <View key={event.id}>{card}</View>;
            })}
            {totalFeedWithVerb > 10 && (
              <Text
                onPress={() => router.push('/(tabs)/notes')}
                style={{
                  color: '#9e958d',
                  fontSize: 13,
                  textAlign: 'center',
                  marginTop: 8,
                }}
              >
                View all activity
              </Text>
            )}
          </>
        )}
      </View>

      {/* ── 4. Friends (unified: search + list) ── */}
      <View>
        <SectionLabel>Friends</SectionLabel>

        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search by username…"
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor="#9e958d"
          style={{
            backgroundColor: '#fefcf9',
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15,
            color: '#231f1b',
            marginBottom: 10,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        />

        {searching && <ActivityIndicator color="#78716c" style={{ marginVertical: 10 }} />}

        {searchError && (
          <Text style={{ color: '#b91c1c', marginBottom: 8, fontSize: 13 }}>{searchError}</Text>
        )}

        {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
          <Text style={{ color: '#9e958d', marginBottom: 16, fontSize: 14 }}>No users found.</Text>
        )}

        {searchResults.length > 0 && (
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
            overflow: 'hidden',
            marginBottom: acceptedFriends.length > 0 ? 16 : 0,
          }}>
            {searchResults.map((result, idx) => {
              const rel = userId ? getRelationship(userId, result.id, friendships) : 'none';
              const isAdding = addingId === result.id;
              return (
                <View
                  key={result.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingVertical: 12,
                    paddingHorizontal: 16,
                    borderBottomWidth: idx < searchResults.length - 1 ? 1 : 0,
                    borderBottomColor: '#ede9e4',
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <InitialAvatar name={getDisplayName(result)} />
                    <View>
                      <Text style={{ fontSize: 15, color: '#231f1b' }}>{getDisplayName(result)}</Text>
                      {(result.first_name || result.last_name) && (
                        <Text style={{ fontSize: 12, color: '#9e958d' }}>@{result.username}</Text>
                      )}
                    </View>
                  </View>
                  {isAdding ? (
                    <ActivityIndicator color="#78716c" size="small" />
                  ) : rel === 'none' ? (
                    <TouchableOpacity
                      onPress={() => handleAddFriend(result.id)}
                      disabled={addingId !== null}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        backgroundColor: addingId !== null ? '#ede9e4' : '#231f1b',
                        borderRadius: 8,
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Add</Text>
                    </TouchableOpacity>
                  ) : rel === 'pending' ? (
                    <Text style={{ color: '#9e958d', fontSize: 13 }}>Pending</Text>
                  ) : (
                    <Text style={{ color: '#78716c', fontSize: 13 }}>Friends</Text>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {acceptedFriends.length === 0 ? (
          <Text style={{ color: '#9e958d', fontSize: 14, marginBottom: 16 }}>No friends yet.</Text>
        ) : (
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
            overflow: 'hidden',
          }}>
            {acceptedFriends.map((friend, idx) => (
              <TouchableOpacity
                key={friend.id}
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
                  justifyContent: 'space-between',
                  paddingVertical: 13,
                  paddingHorizontal: 16,
                  borderBottomWidth: idx < acceptedFriends.length - 1 ? 1 : 0,
                  borderBottomColor: '#ede9e4',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <InitialAvatar name={getDisplayName(friend)} />
                  <View>
                    <Text style={{ fontSize: 15, color: '#231f1b' }}>{getDisplayName(friend)}</Text>
                    {(friend.first_name || friend.last_name) && (
                      <Text style={{ fontSize: 12, color: '#9e958d' }}>@{friend.username}</Text>
                    )}
                  </View>
                </View>
                <Text style={{ fontSize: 18, color: '#ede9e4', marginRight: 2 }}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
