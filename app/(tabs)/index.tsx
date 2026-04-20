import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { registerWtTarget, useWalkthrough } from '../../lib/walkthroughEngine';
import { WtDemoHome } from '../../components/walkthrough/WtDemoHome';
import { supabase } from '../../lib/supabase';
import { registerCacheClearer } from '../../lib/tabCache';
import { CoverThumb } from '../../components/CoverThumb';
import { HomeScreenSkeleton } from '../../components/Placeholder';
import { getDisplayName, getFirstName } from '../../lib/displayName';
import { computePagePacing, computeUserAvgPace, inferReadState, computeSessionPacing, formatProjectedFinish, computeMonthlyStats, type SessionRow, type ReadState, type MonthlyStats } from '../../lib/pacing';
import { aggregatePeriod, computeMonthlyWrap, computeYearlyWrap, deriveInsights, type WrapSession, type WrapBookRef, type ReaderInsight } from '../../lib/readingWraps';
import { computeStreaks } from '../../lib/streaks';
import { showToast } from '../../lib/toast';
import { BadgeContext } from './_layout';
import { RecsInboxSheet } from '../../components/RecsInboxSheet';

// ─── Types ────────────────────────────────────────────────────────────────────

type CurrentRead = {
  id: string;
  book_id: string;
  started_at: string | null;
  progress_updated_at: string | null;
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

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h >= 5  && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 21) return 'Good evening';
  return 'Good night';
}

function SectionLabel({ children }: { children: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 10 }}>
      <Text style={{
        fontSize: 10,
        fontWeight: '700',
        color: '#9e958d',
        letterSpacing: 1.6,
        textTransform: 'uppercase',
      }}>
        {children}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: '#ede9e4' }} />
    </View>
  );
}

type HeroReadCardProps = {
  book:            CurrentRead;
  yearlyGoal:      number | null;
  onPress:         () => void;
  accentColor:     string;
  projectedFinish: string | null;
  readState:       ReadState;
  pacingStrength?: 'strong' | 'moderate' | 'weak';
};

function HeroReadCard({ book, onPress, accentColor, projectedFinish, readState, pacingStrength }: HeroReadCardProps) {
  const barAnim = useRef(new Animated.Value(0)).current;
  const cardAnim = useRef(new Animated.Value(0)).current;

  const pct = (book.current_page && book.page_count && book.page_count > 0)
    ? Math.min(1, book.current_page / book.page_count)
    : 0;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(cardAnim, {
        toValue: 1,
        duration: 380,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(barAnim, {
        toValue: pct * 100,
        duration: 550,
        delay: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Card height grows slightly when we have a projected-finish or state line.
  const hasExtraLine  = !!(projectedFinish || readState === 'paused' || readState === 'stalled');
  const cardHeight    = hasExtraLine ? 192 : 172;
  const coverWidth    = 114;
  const sageColor     = accentColor === '#ede9e4' ? '#7b9e7e' : accentColor;

  // Determine the extra-line content.
  // Priority: projected finish > stalled > paused (active shows nothing)
  const extraLine: { text: string; color: string } | null = (() => {
    if (projectedFinish) {
      // Tone varies with how confident we are in the pace estimate.
      if (pacingStrength === 'weak')     return { text: `~${projectedFinish} · early days`, color: '#b8aca0' };
      if (pacingStrength === 'strong')   return { text: `Finish ~${projectedFinish}`,       color: '#6b635c' };
      /* moderate / undefined */         return { text: `Finish ~${projectedFinish}`,       color: '#9e958d' };
    }
    if (readState === 'stalled') {
      return { text: 'Stalled — pick it back up?', color: '#b08d57' };
    }
    if (readState === 'paused') {
      return { text: 'Paused for a while', color: '#9e958d' };
    }
    return null;
  })();

  return (
    <Animated.View style={{
      opacity: cardAnim,
      transform: [{ translateY: cardAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
    }}>
      <TouchableOpacity activeOpacity={0.82} onPress={onPress}>
        <View style={{
          backgroundColor: '#fefcf9',
          borderRadius: 22,
          overflow: 'hidden',
          shadowColor: '#231f1b',
          shadowOpacity: 0.11,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 6 },
          elevation: 5,
          height: cardHeight,
        }}>
          <View style={{ flexDirection: 'row', flex: 1 }}>
            {/* Cover — flush left, full height */}
            <CoverThumb
              url={book.cover_url}
              externalId={book.external_id}
              title={book.title}
              width={coverWidth}
              height={cardHeight - 5}
              radius={0}
            />
            {/* Info column */}
            <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 10, justifyContent: 'space-between' }}>
              <View>
                <Text
                  style={{ fontSize: 16, fontWeight: '800', color: '#231f1b', letterSpacing: -0.4, lineHeight: 22, marginBottom: 5 }}
                  numberOfLines={3}
                >
                  {book.title}
                </Text>
                <Text style={{ fontSize: 12, color: '#9e958d', fontWeight: '500' }} numberOfLines={1}>
                  {book.author}
                </Text>
              </View>
              <View>
                {pct > 0 ? (
                  <Text style={{ fontSize: 30, fontWeight: '900', color: '#231f1b', letterSpacing: -1, lineHeight: 34 }}>
                    {Math.round(pct * 100)}
                    <Text style={{ fontSize: 13, fontWeight: '400', color: '#9e958d', letterSpacing: 0 }}>%</Text>
                  </Text>
                ) : null}
                <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 1, fontStyle: 'italic' }}>
                  {pct > 0
                    ? (book.page_count ? `p. ${book.current_page} of ${book.page_count}` : 'in progress')
                    : 'just started'}
                </Text>
                {extraLine && (
                  <Text style={{ fontSize: 11, color: extraLine.color, marginTop: 4, fontStyle: 'italic' }}>
                    {extraLine.text}
                  </Text>
                )}
              </View>
            </View>
          </View>
          {/* Full-width animated progress bar at base */}
          <View style={{ height: 5, backgroundColor: '#ede9e4' }}>
            <Animated.View style={{
              height: 5,
              width: barAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'], extrapolate: 'clamp' }),
              backgroundColor: sageColor,
            }} />
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

/**
 * Subtle streak + consistency surface below the Reading Now section.
 *
 * Shows up to two lines:
 *   1. Active streak  — only when ≥ 2 consecutive reading days
 *   2. Month context  — "N days this month" when ≥ 3 distinct reading days
 *
 * Tone: reflective, not gamified. No trophies, no fire emojis.
 */
function StreakPill({ days, longest, monthlyDays }: { days: number; longest: number; monthlyDays: number }) {
  const showStreak  = days >= 2;
  const showMonthly = monthlyDays >= 3;
  if (!showStreak && !showMonthly) return null;

  const streakLabel = (() => {
    if (!showStreak) return null;
    // Add "best: N" context only when longest streak is materially higher (≥ 7 days).
    const addBest = longest >= 7 && longest > days;
    return addBest ? `${days} day streak · best: ${longest}` : `${days} days reading in a row`;
  })();

  return (
    <View style={{ marginTop: 10, gap: 3 }}>
      {streakLabel && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#7b9e7e' }} />
          <Text style={{ fontSize: 12, color: '#7b9e7e', fontWeight: '600' }}>{streakLabel}</Text>
        </View>
      )}
      {showMonthly && (
        <Text style={{ fontSize: 11, color: '#9e958d', marginLeft: 11 }}>
          {monthlyDays} reading {monthlyDays === 1 ? 'day' : 'days'} this month
        </Text>
      )}
    </View>
  );
}

/**
 * Renders up to 2 calm reader insights below the streak pill.
 * Each insight is a complete sentence, displayed as a quiet bullet list.
 * Returns null when there is nothing meaningful to surface.
 */
function ReaderInsightCard({ insights }: { insights: ReaderInsight[] }) {
  if (insights.length === 0) return null;
  return (
    <View style={{ marginTop: 10, gap: 5 }}>
      {insights.map(ins => (
        <View key={ins.kind} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7 }}>
          <View style={{
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: '#c4b5a5',
            marginTop: 7,
            flexShrink: 0,
          }} />
          <Text style={{ fontSize: 12, color: '#6b635c', lineHeight: 18, flex: 1 }}>
            {ins.text}
          </Text>
        </View>
      ))}
    </View>
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
  userId:             string;
  greeting:           string;
  currentReads:       CurrentRead[];
  yearlyGoal:         number | null;
  pendingRecCount:    number;
  booksThisYear:      YearBook[];
  feed:               FeedEvent[];
  friendships:        FriendshipRow[];
  fetchedAt:          number;
  sessionsByBook:     Record<string, SessionRow[]>;
  /** Full session rows (incl. negative corrections + started_page) used by wraps. */
  allSessionsForWrap: WrapSession[];
  /** user_book_id → current_page for reconciliation cap. */
  currentPageByBook:  Record<string, number | null>;
  currentStreak:      number;
  longestStreak:      number;
  monthlyStats:       MonthlyStats | null;
};

let _homeCache: HomeSnapshot | null = null;
const HOME_STALE_MS = 60_000;
// 'bookData' tag: also cleared when Book Detail performs a status/page action
registerCacheClearer(() => { _homeCache = null; }, 'bookData');

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { newRecCount } = useContext(BadgeContext);
  const [inboxSheetOpen, setInboxSheetOpen] = useState(false);

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


  // Session data for pacing + streak
  const [sessionsByBook, setSessionsByBook] = useState<Record<string, SessionRow[]>>(() => _homeCache?.sessionsByBook ?? {});
  // Full session set (with negatives + started_page) — drives wraps + reconciled streak
  const [allSessionsForWrap, setAllSessionsForWrap] = useState<WrapSession[]>(() => _homeCache?.allSessionsForWrap ?? []);
  // current_page per user_book — used by aggregatePeriod cap so rolled-back books drop out
  const [currentPageByBook,  setCurrentPageByBook]  = useState<Record<string, number | null>>(() => _homeCache?.currentPageByBook ?? {});
  const [currentStreak,  setCurrentStreak]  = useState<number>(() => _homeCache?.currentStreak ?? 0);
  const [longestStreak,  setLongestStreak]  = useState<number>(() => _homeCache?.longestStreak ?? 0);
  const [monthlyStats,   setMonthlyStats]   = useState<MonthlyStats | null>(() => _homeCache?.monthlyStats ?? null);

  // Refs so we can write to the cache after all setters have been called
  // (state is async; refs give us the live values within the async load).
  const _crRef    = useRef<CurrentRead[]>([]);
  const _gyRef    = useRef<number | null>(null);
  const _prRef    = useRef<number>(0);
  const _byRef    = useRef<YearBook[]>([]);
  const _feedRef  = useRef<FeedEvent[]>([]);
  const _fsRef    = useRef<FriendshipRow[]>([]);
  const _sbRef    = useRef<Record<string, SessionRow[]>>({});
  const _aswRef   = useRef<WrapSession[]>([]);
  const _cpbRef   = useRef<Record<string, number | null>>({});
  const _csRef    = useRef<number>(0);
  const _lsRef    = useRef<number>(0);
  const _msRef    = useRef<MonthlyStats | null>(null);

  // ── Wrap + insights (pure derivations from already-loaded session state) ─────
  // These are fast O(n) computations over ≤90 days of session rows so they can
  // live in useMemo without performance concerns.

  /**
   * Flat session array with user_book_id, started_page, and correction rows
   * attached — required by wrap functions for the per-book reconciliation cap.
   * Sourced directly from loadSessionData (unlike sessionsByBook which is
   * positive-only and used by per-book pacing).
   */
  const allSessions = allSessionsForWrap;

  /**
   * Book reference lookup: user_book_id → { title, author }.
   * Populated from finished books (booksThisYear) + currently-reading books.
   * Enables topBook inside wrap summaries without an extra network fetch.
   */
  const bookLookup = useMemo<Record<string, WrapBookRef>>(() => {
    const lookup: Record<string, WrapBookRef> = {};
    for (const b of booksThisYear) {
      lookup[b.id] = { title: b.title, author: b.author };
    }
    for (const cr of currentReads) {
      lookup[cr.id] = { title: cr.title, author: cr.author };
    }
    return lookup;
  }, [booksThisYear, currentReads]);

  const _wrapToday        = new Date();
  const _curMonthPrefix   = `${_wrapToday.getFullYear()}-${String(_wrapToday.getMonth() + 1).padStart(2, '0')}`;
  const _prevMonthDate    = new Date(_wrapToday.getFullYear(), _wrapToday.getMonth() - 1, 1);
  const _prevMonthPrefix  = `${_prevMonthDate.getFullYear()}-${String(_prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const currentMonthWrap = useMemo(
    () => computeMonthlyWrap(allSessions, _curMonthPrefix, bookLookup, currentPageByBook),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSessions, bookLookup, currentPageByBook],
  );

  const prevMonthWrap = useMemo(
    () => computeMonthlyWrap(allSessions, _prevMonthPrefix, bookLookup, currentPageByBook),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSessions, bookLookup, currentPageByBook],
  );

  const yearlyWrap = useMemo(
    () => computeYearlyWrap(allSessions, _wrapToday.getFullYear(), booksThisYear.length, bookLookup, currentPageByBook),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSessions, booksThisYear.length, bookLookup, currentPageByBook],
  );

  const insights = useMemo(
    () => deriveInsights(currentMonthWrap, prevMonthWrap, yearlyWrap, yearlyGoal),
    [currentMonthWrap, prevMonthWrap, yearlyWrap, yearlyGoal],
  );

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
    // Now: all queries start simultaneously. Feed is kicked off once friend IDs
    // are known, but the dashboard content is unblocked from the start.
    const [friendshipRows] = await Promise.all([
      loadFriendships(user.id),
      loadCurrentRead(user.id),
      loadPendingRecs(user.id),
      loadBooksThisYear(user.id),
      loadSessionData(user.id),
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
      userId:             user.id,
      greeting:           greetingName,
      currentReads:       _crRef.current,
      yearlyGoal:         _gyRef.current,
      pendingRecCount:    _prRef.current,
      booksThisYear:      _byRef.current,
      feed:               _feedRef.current,
      friendships:        _fsRef.current,
      fetchedAt:          Date.now(),
      sessionsByBook:     _sbRef.current,
      allSessionsForWrap: _aswRef.current,
      currentPageByBook:  _cpbRef.current,
      currentStreak:      _csRef.current,
      longestStreak:      _lsRef.current,
      monthlyStats:       _msRef.current,
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
        .select('id, book_id, started_at, progress_updated_at, current_page, book:books(title, author, cover_url, external_id, page_count)')
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
        id:                   r.id,
        book_id:              r.book_id,
        started_at:           r.started_at           ?? null,
        progress_updated_at:  r.progress_updated_at  ?? null,
        current_page:         r.current_page         ?? null,
        title:                b?.title               ?? '',
        author:               b?.author              ?? '',
        cover_url:            b?.cover_url           ?? null,
        external_id:          b?.external_id         ?? null,
        page_count:           b?.page_count          ?? null,
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

  // ── Session data: reading_sessions for streak + per-book pacing ───────────────
  // Fetches the last 90 days of sessions for the current user.
  // Used for:
  //   - Reading streak computation (all books, all days)
  //   - Per-book session-based projected finish (grouped by user_book_id)

  async function loadSessionData(uid: string) {
    if (!supabase) return;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000)
      .toISOString()
      .split('T')[0];

    // ── 1. Fetch sessions (forward + corrections + started_page) ────────────
    const { data } = await supabase
      .from('reading_sessions')
      .select('user_book_id, session_date, pages_read, started_page')
      .eq('user_id', uid)
      .gte('session_date', ninetyDaysAgo)
      .order('session_date', { ascending: true });

    const rows = (data ?? []) as Array<{
      user_book_id: string;
      session_date: string;
      pages_read:   number;
      started_page: number | null;
    }>;

    // ── 2. Fetch current_page for every book that has sessions ──────────────
    // Needed for the per-book reconciliation cap: a book whose current_page
    // is below what the sessions log implies has been rolled back, and its
    // contribution to monthly/yearly totals must be capped accordingly.
    const uniqueBookIds = Array.from(new Set(rows.map(r => r.user_book_id)));
    const cpByBook: Record<string, number | null> = {};
    if (uniqueBookIds.length > 0) {
      const { data: ubData } = await supabase
        .from('user_books')
        .select('id, current_page')
        .in('id', uniqueBookIds);
      for (const ub of (ubData ?? []) as Array<{ id: string; current_page: number | null }>) {
        cpByBook[ub.id] = ub.current_page;
      }
    }

    // ── 3. Build the two derived shapes ─────────────────────────────────────
    // sessionsByBook (positive only) drives per-book velocity / projected finish.
    // wrapSessions (full set with started_page) drives wraps + streak reconciliation.
    const byBook: Record<string, SessionRow[]> = {};
    const wrapSessions: WrapSession[] = rows.map(r => ({
      session_date:  r.session_date,
      pages_read:    r.pages_read,
      started_page:  r.started_page ?? 0,
      user_book_id:  r.user_book_id,
    }));

    for (const r of rows) {
      // Per-book grouping uses forward sessions only (velocity estimation).
      if (r.pages_read > 0) {
        if (!byBook[r.user_book_id]) byBook[r.user_book_id] = [];
        byBook[r.user_book_id].push({
          session_date: r.session_date,
          pages_read:   r.pages_read,
        });
      }
    }

    // ── 4. Streak uses reconciled active reading days ───────────────────────
    // aggregatePeriod applies the same per-book cap as the wrap functions, so
    // a book rolled back to 0 (with no correction row) drops its session dates
    // from the streak.  This keeps the streak honest: a day whose pages have
    // been fully undone does not count.
    const windowAgg = aggregatePeriod(wrapSessions, cpByBook);
    const streak    = computeStreaks(windowAgg.activeReadingDates);
    const monthly   = computeMonthlyStats(wrapSessions, cpByBook);

    setSessionsByBook(byBook);
    _sbRef.current = byBook;
    setAllSessionsForWrap(wrapSessions);
    _aswRef.current = wrapSessions;
    setCurrentPageByBook(cpByBook);
    _cpbRef.current = cpByBook;
    setCurrentStreak(streak.current);
    _csRef.current = streak.current;
    setLongestStreak(streak.longest);
    _lsRef.current = streak.longest;
    setMonthlyStats(monthly);
    _msRef.current = monthly;

    if (__DEV__ && (streak.current > 0 || rows.length > 0)) {
      console.log(
        `[PACING] sessions loaded — ${rows.length} rows / ${uniqueBookIds.length} books  |  streak: ${streak.current}d current / ${streak.longest}d longest  |  month: ${monthly.readingDaysThisMonth}d / ${monthly.pagesThisMonth}pp`,
      );
    }
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
  const goalIsAhead        = goalSurplus >= 2;
  const goalIsBehind       = goalDeficit >= 2;
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
    <>
    <ScrollView
      style={{ backgroundColor: '#f5f1ec' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 16, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
      }
    >
      {/* ── Hero heading ── */}
      <View style={{ marginBottom: 34 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{
              fontSize: 10,
              fontWeight: '600',
              color: '#c4b5a5',
              letterSpacing: 1.4,
              textTransform: 'uppercase',
              marginBottom: 6,
            }}>
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
            </Text>
            <Text style={{
              fontSize: 38,
              fontWeight: '900',
              color: '#231f1b',
              letterSpacing: -1.5,
              lineHeight: 43,
            }}>
              {greeting ? `${timeGreeting()},\n${greeting}` : timeGreeting()}
            </Text>
          </View>

          {/* Inbox icon with badge */}
          <TouchableOpacity
            onPress={() => setInboxSheetOpen(true)}
            hitSlop={10}
            style={{ marginTop: 2, padding: 4 }}
          >
            <View style={{ position: 'relative' }}>
              <Ionicons name="mail-outline" size={24} color="#6b635c" />
              {newRecCount > 0 && (
                <View style={{
                  position: 'absolute',
                  top: -4,
                  right: -5,
                  backgroundColor: '#231f1b',
                  borderRadius: 8,
                  minWidth: 16,
                  height: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 3,
                }}>
                  <Text style={{ color: '#fefcf9', fontSize: 9, fontWeight: '700', lineHeight: 12 }}>
                    {newRecCount}
                  </Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>

        {currentReads.length > 0 && (
          <Text style={{ fontSize: 13, color: '#7b9e7e', fontWeight: '600', marginTop: 8, letterSpacing: 0.1 }}>
            {currentReads.length === 1
              ? 'Reading 1 book right now'
              : `Reading ${currentReads.length} books right now`}
          </Text>
        )}
      </View>

      {/* ── 1. Continue Reading ── */}
      {currentReads.length > 0 && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Reading Now</SectionLabel>

          {/* Walkthrough ref wraps only the card(s), not the section label */}
          <View ref={homeTargetRef} onLayout={measureHomeContent}>
          {currentReads.length === 1 ? (() => {
            const cr         = currentReads[0];
            const accentColor = homeCardBorderColor(cr, yearlyGoal);
            const crReadState = inferReadState({
              status:            'reading',
              progressUpdatedAt: cr.progress_updated_at,
              startedAt:         cr.started_at,
              currentPage:       cr.current_page,
            });
            const crSessions = sessionsByBook[cr.id] ?? [];
            const crPacing   = (cr.current_page && cr.page_count)
              ? computeSessionPacing(crSessions, cr.current_page, cr.page_count)
              : null;
            const crProjFinish = crPacing ? formatProjectedFinish(crPacing.estimatedFinish) : null;
            return (
              <HeroReadCard
                key={cr.id}
                book={cr}
                yearlyGoal={yearlyGoal}
                accentColor={accentColor}
                projectedFinish={crProjFinish}
                readState={crReadState}
                pacingStrength={crPacing?.strength}
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
              />
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
                const crSessions   = sessionsByBook[cr.id] ?? [];
                const crPacing     = (cr.current_page && cr.page_count)
                  ? computeSessionPacing(crSessions, cr.current_page, cr.page_count)
                  : null;
                const crProjFinish = crPacing ? formatProjectedFinish(crPacing.estimatedFinish) : null;
                const crState = inferReadState({ status: 'reading', progressUpdatedAt: cr.progress_updated_at, startedAt: cr.started_at, currentPage: cr.current_page });
                const subLine = crProjFinish ? `~${crProjFinish}` : crState === 'stalled' ? 'Stalled' : crState === 'paused' ? 'Paused' : null;
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
                          <Text style={{ fontSize: 10, color: '#9e958d', marginBottom: subLine ? 4 : 0 }}>
                            {progressLabel(cr)}
                          </Text>
                        </>
                      ) : (
                        <Text style={{ fontSize: 10, color: '#9e958d', marginBottom: subLine ? 4 : 0 }}>
                          In progress
                        </Text>
                      )}
                      {subLine && (
                        <Text style={{ fontSize: 10, color: '#9e958d', fontStyle: 'italic' }}>{subLine}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          </View>{/* close homeTargetRef wrapper */}
          <StreakPill
            days={currentStreak}
            longest={longestStreak}
            monthlyDays={monthlyStats?.readingDaysThisMonth ?? 0}
          />
          <ReaderInsightCard insights={insights} />
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
              {/* ── 1. Headline ── */}
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 }}>
                <Text style={{ fontSize: 24, fontWeight: '800', color: '#231f1b', letterSpacing: -0.6 }}>
                  {booksThisYear.length}
                  <Text style={{ fontSize: 15, fontWeight: '400', color: '#9e958d' }}> / {yearlyGoal} books</Text>
                </Text>
              </View>

              {/* ── 2. Pace status badge ── */}
              {(() => {
                const isAhead  = goalIsAhead;
                const isBehind = goalIsBehind;
                const bg     = isAhead ? '#f0fdf4' : isBehind ? '#fffbeb' : '#f5f3ef';
                const border  = isAhead ? '#bbf7d0' : isBehind ? '#fde68a' : '#e2ddd9';
                const color   = isAhead ? '#15803d' : isBehind ? '#92400e' : '#6b635c';
                const symbol  = isAhead ? '↑' : isBehind ? '↓' : '→';
                const label   = isAhead
                  ? `${goalSurplus} book${goalSurplus !== 1 ? 's' : ''} ahead`
                  : isBehind
                  ? `${goalDeficit} book${goalDeficit !== 1 ? 's' : ''} behind`
                  : goalExpectedByNow === 0 ? 'Just getting started' : 'Right on pace';
                return (
                  <View style={{
                    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
                    backgroundColor: bg, borderWidth: 1, borderColor: border,
                    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5,
                    marginBottom: 18, gap: 5,
                  }}>
                    <Text style={{ fontSize: 12, color, fontWeight: '700' }}>{symbol}</Text>
                    <Text style={{ fontSize: 12, color, fontWeight: '600' }}>{label}</Text>
                  </View>
                );
              })()}

              {/* ── 3. Vertical stacked bookshelf ── */}
              {(() => {
                const total    = yearlyGoal ?? 0;
                const read     = booksThisYear.length;
                const expected = goalExpectedByNow;

                // Deterministic width variation (% of column) — keeps stack lived-in but orderly
                const W = [98, 88, 94, 82, 100, 86, 92, 96, 84, 90, 78, 95, 89, 99, 83, 91];

                // Tonal palettes — subtle variation per book so stack reads as individual volumes
                const sageTones    = ['#7b9e7e', '#83a386', '#759a78', '#88a78b', '#7e9f81'];
                const amberTones   = ['#e8a44a', '#eaaa55', '#e6a040', '#ecae5e', '#e7a247'];
                const neutralTones = ['#cec6be', '#d3ccc4', '#c9c1b9', '#d5cec6', '#ccc4bc'];

                // Adaptive sizing so the card stays within a comfortable height
                let blockH: number;
                let gap:    number;
                if (total <= 20)       { blockH = 12; gap = 2.5; }
                else if (total <= 35)  { blockH = 10; gap = 2;   }
                else if (total <= 55)  { blockH = 8;  gap = 1.5; }
                else if (total <= 80)  { blockH = 7;  gap = 1;   }
                else                   { blockH = 6;  gap = 1;   }

                // Split into 2 balanced columns once a single stack would get too tall
                const splitColumns = total > 40;
                const colCount     = splitColumns ? 2 : 1;
                const perCol       = Math.ceil(total / colCount);

                const renderBook = (i: number) => {
                  const isRead   = i < read;
                  const isBehind = !isRead && i < expected;
                  const palette  = isRead ? sageTones : isBehind ? amberTones : neutralTones;
                  const color    = palette[i % palette.length];
                  const w        = W[i % W.length];
                  const edgeH    = Math.max(1, Math.floor(blockH * 0.2));
                  return (
                    <View
                      key={i}
                      style={{
                        width:           `${w}%`,
                        height:          blockH,
                        backgroundColor: color,
                        borderRadius:    2,
                        marginBottom:    gap,
                        alignSelf:       'center',
                        overflow:        'hidden',
                      }}
                    >
                      {/* Top page-edge highlight — suggests stacked pages */}
                      <View style={{ height: edgeH, backgroundColor: 'rgba(255,255,255,0.22)' }} />
                      {/* Bottom seam — depth between volumes */}
                      <View style={{
                        position:        'absolute',
                        left:            0,
                        right:           0,
                        bottom:          0,
                        height:          1,
                        backgroundColor: 'rgba(0,0,0,0.10)',
                      }} />
                    </View>
                  );
                };

                // Build columns. Within each column we render top→bottom but reverse the
                // index order so the lowest index (first read) ends up at the bottom of
                // the pile — books accumulate upward, the way a real stack grows.
                const columns: number[][] = [];
                for (let c = 0; c < colCount; c++) {
                  const start = c * perCol;
                  const end   = Math.min(total, start + perCol);
                  const idxs: number[] = [];
                  for (let i = start; i < end; i++) idxs.push(i);
                  columns.push(idxs.reverse());
                }

                return (
                  <View style={{ marginBottom: 18 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
                      {columns.map((col, ci) => (
                        <View key={ci} style={{ flex: 1 }}>
                          {col.map(i => renderBook(i))}
                        </View>
                      ))}
                    </View>
                    {/* Base plank — the stack rests on this */}
                    <View style={{ height: 4, backgroundColor: '#b8a898', marginTop: 3, borderRadius: 1 }} />
                    <View style={{ height: 1.5, backgroundColor: '#a3917f', opacity: 0.4, borderRadius: 1 }} />
                  </View>
                );
              })()}

              {/* ── 4. Finish projection ── */}
              {goalProjected !== null && (
                <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18, marginBottom: 10 }}>
                  {`At your current pace, you'll finish ~${goalProjected} book${goalProjected !== 1 ? 's' : ''} this year`}
                </Text>
              )}

              {/* ── 5. Footer: pace rate + expand ── */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                {yearAvgPace !== null ? (
                  <Text style={{ fontSize: 11, color: '#9e958d' }}>
                    {`~${yearAvgPace} pages/day`}
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

      {/* ── Reading Insights entry ── */}
      {(currentMonthWrap.pagesRead > 0 || currentMonthWrap.readingDays > 0 || booksThisYear.length > 0) && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Reading Insights</SectionLabel>
          <TouchableOpacity
            onPress={() => router.push('/stats')}
            activeOpacity={0.82}
          >
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 16,
              padding: 18,
              shadowColor: '#231f1b',
              shadowOpacity: 0.05,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              elevation: 2,
            }}>
              {/* Top row: month pages + year books */}
              <View style={{ flexDirection: 'row', marginBottom: 14 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{
                    fontSize: 32, fontWeight: '800', color: '#231f1b',
                    letterSpacing: -1, lineHeight: 34,
                  }}>
                    {currentMonthWrap.pagesRead}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 3 }}>
                    pages this month
                  </Text>
                </View>
                {booksThisYear.length > 0 && (
                  <View style={{ flex: 1, alignItems: 'flex-end' }}>
                    <Text style={{
                      fontSize: 32, fontWeight: '800', color: '#231f1b',
                      letterSpacing: -1, lineHeight: 34,
                    }}>
                      {booksThisYear.length}
                    </Text>
                    <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 3 }}>
                      books this year
                    </Text>
                  </View>
                )}
              </View>
              {/* Bottom row: sub-stats + arrow */}
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: '#ede9e4',
              }}>
                <Text style={{ fontSize: 12, color: '#9e958d' }}>
                  {currentMonthWrap.readingDays > 0
                    ? `${currentMonthWrap.readingDays} reading ${currentMonthWrap.readingDays === 1 ? 'day' : 'days'}`
                    : `${_wrapToday.toLocaleString('default', { month: 'long' })} · ${_wrapToday.getFullYear()}`
                  }
                  {currentMonthWrap.avgPagesPerReadingDay != null
                    ? `  ·  ${currentMonthWrap.avgPagesPerReadingDay} pp/day`
                    : ''}
                </Text>
                <Text style={{ fontSize: 13, color: '#c4b5a5' }}>→</Text>
              </View>
            </View>
          </TouchableOpacity>
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
                    paddingVertical: 14,
                    paddingLeft: 16,
                    paddingRight: 14,
                    marginBottom: 8,
                    shadowColor: '#231f1b',
                    shadowOpacity: 0.04,
                    shadowRadius: 8,
                    shadowOffset: { width: 0, height: 2 },
                    elevation: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                >
                  {/* Text on LEFT — actor name immediately visible */}
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={{ fontSize: 12, color: '#9e958d', marginBottom: 3 }}>
                      <Text style={{ fontWeight: '700', color: '#6b635c' }}>{actor}</Text>
                      {' '}{verb}
                    </Text>
                    {title ? (
                      <Text style={{ fontSize: 14, fontWeight: '700', color: '#231f1b', lineHeight: 20, letterSpacing: -0.2 }} numberOfLines={2}>
                        {title}
                      </Text>
                    ) : null}
                    {author ? (
                      <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 2 }} numberOfLines={1}>
                        {author}
                      </Text>
                    ) : null}
                    {event.rating != null ? (
                      <Text style={{ fontSize: 12, color: '#7b9e7e', marginTop: 3, fontWeight: '600' }}>
                        {'★'.repeat(event.rating)}{'☆'.repeat(5 - event.rating)}
                      </Text>
                    ) : null}
                    <Text style={{ fontSize: 10, color: '#c4b5a5', marginTop: 4 }}>
                      {relativeTime(event.created_at)}
                    </Text>
                  </View>
                  {/* Cover on RIGHT */}
                  <CoverThumb
                    url={event.book?.cover_url}
                    externalId={event.book?.external_id}
                    title={event.book?.title}
                    width={38}
                    height={54}
                  />
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

    <RecsInboxSheet visible={inboxSheetOpen} onClose={() => setInboxSheetOpen(false)} />
    </>
  );
}
