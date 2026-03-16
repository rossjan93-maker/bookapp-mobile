import { useCallback, useEffect, useRef, useState } from 'react';
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
import { getDisplayName, getFirstName } from '../../lib/displayName';
import { computePagePacing } from '../../lib/pacing';

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
  title: string;
  author: string;
  cover_url: string | null;
  external_id: string | null;
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

function isOnPace(finishedCount: number, goal: number | null): boolean {
  if (!goal || goal <= 0) return false;
  const today = new Date();
  const dayOfYear = Math.floor(
    (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / (24 * 60 * 60 * 1000)
  );
  const expectedByNow = Math.floor((dayOfYear / 365) * goal);
  return finishedCount >= expectedByNow;
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
      color: '#a8a29e',
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
      backgroundColor: '#e7e5e4',
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

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [greeting, setGreeting] = useState('');

  // Dashboard modules
  const [currentReads, setCurrentReads] = useState<CurrentRead[]>([]);
  const [yearlyGoal, setYearlyGoal]     = useState<number | null>(null);
  const [pendingRecCount, setPendingRecCount] = useState(0);
  const [booksThisYear, setBooksThisYear] = useState<YearBook[]>([]);
  const [goalExpanded, setGoalExpanded]   = useState(false);

  // Activity feed
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);

  // Friends
  const [friendships, setFriendships] = useState<FriendshipRow[]>([]);
  const [loadingFriendships, setLoadingFriendships] = useState(true);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProfileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusEffect(useCallback(() => {
    async function init() {
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
      setUserId(user.id);

      const meta = user.user_metadata as { first_name?: string } | undefined;
      if (meta?.first_name) setGreeting(meta.first_name);

      // Friendships must resolve first so we can scope the feed to accepted friends only.
      const rows = await loadFriendships(user.id);
      const acceptedFriendIds = rows
        .filter(f => f.status === 'accepted')
        .map(f => (f.requester_id === user.id ? f.addressee_id : f.requester_id));

      await Promise.all([
        loadFeed(acceptedFriendIds),
        loadCurrentRead(user.id),
        loadPendingRecs(user.id),
        loadBooksThisYear(user.id),
      ]);
      setFeedLoading(false);
      setLoadingFriendships(false);
    }
    init();
  }, []));

  // ── Data loaders ─────────────────────────────────────────────────────────────

  async function loadFeed(friendIds: string[]) {
    if (!supabase) return;
    // No friends yet — feed is empty by definition.
    if (friendIds.length === 0) {
      setFeed([]);
      return;
    }
    const { data, error } = await supabase
      .from('activity_events')
      .select(
        'id, event_type, created_at, book_id, rating, ' +
        'actor:profiles!activity_events_actor_id_fkey(username, first_name, last_name), ' +
        'book:books!activity_events_book_id_fkey(title, author, cover_url, external_id)'
      )
      .in('actor_id', friendIds)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      setFeedError('Could not load feed.');
    } else {
      setFeed((data as FeedEvent[]) ?? []);
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
    return rows;
  }

  async function loadCurrentRead(uid: string) {
    if (!supabase) return;

    // Load yearly goal for honest pacing-state card colors
    const profileRes = await supabase
      .from('profiles')
      .select('yearly_reading_goal')
      .eq('id', uid)
      .single();
    setYearlyGoal(profileRes.data?.yearly_reading_goal ?? null);

    // Load all reading books ordered by most recently progressed, then started.
    // Try with progress columns; fall back if migration not yet applied.
    let res = await supabase
      .from('user_books')
      .select('id, book_id, started_at, current_page, book:books(title, author, cover_url, external_id, page_count)')
      .eq('user_id', uid)
      .eq('status', 'reading')
      .order('progress_updated_at', { ascending: false, nullsFirst: false });

    if (res.error) {
      res = await supabase
        .from('user_books')
        .select('id, book_id, started_at, book:books(title, author, cover_url, external_id)')
        .eq('user_id', uid)
        .eq('status', 'reading')
        .order('created_at', { ascending: false });
    }

    const rows = (res.data as any[]) ?? [];
    setCurrentReads(rows.map(r => {
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
    }));
  }

  async function loadPendingRecs(uid: string) {
    if (!supabase) return;
    const { count } = await supabase
      .from('recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('to_user_id', uid)
      .eq('status', 'pending');
    setPendingRecCount(count ?? 0);
  }

  async function loadBooksThisYear(uid: string) {
    if (!supabase) return;
    const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;
    const { data } = await supabase
      .from('user_books')
      .select('id, book_id, finished_at, book:books(title, author, cover_url, external_id)')
      .eq('user_id', uid)
      .eq('status', 'finished')
      .gte('finished_at', yearStart)
      .order('finished_at', { ascending: false });
    const rows = (data as any[]) ?? [];
    setBooksThisYear(rows.map(r => {
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
    }
    setAddingId(null);
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const acceptedFriends = friendships
    .filter(f => f.status === 'accepted')
    .map(f => (f.requester_id === userId ? f.addressee : f.requester))
    .filter(Boolean) as { id: string; username: string; first_name: string | null; last_name: string | null }[];

  const acceptedUsernames = new Set(acceptedFriends.map(f => f.username));
  const friendFeedEvents = feed.filter(
    e => e.actor && acceptedUsernames.has(e.actor.username) && eventVerb(e.event_type)
  ).slice(0, 3);

  const displayedFeed = feed.filter(e => eventVerb(e.event_type)).slice(0, 6);
  const totalFeedWithVerb = feed.filter(e => eventVerb(e.event_type)).length;

  // ── Loading ───────────────────────────────────────────────────────────────────

  if (feedLoading || loadingFriendships) {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

  // ── Progress + pacing helpers ─────────────────────────────────────────────────

  function homeCardBorderColor(cr: CurrentRead, goal: number | null): string {
    const pageCount = cr.page_count;
    if (!goal || !pageCount || pageCount <= 0) return '#d6d3d1';
    const { state } = computePagePacing(cr.current_page ?? 0, pageCount, cr.started_at, goal);
    if (state === 'ahead' || state === 'on_pace') return '#86efac';
    if (state === 'behind') return '#fcd34d';
    return '#d6d3d1';
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

  return (
    <ScrollView
      style={{ backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40 }}
    >
      {/* ── Hero heading ── */}
      <View style={{ marginBottom: 28 }}>
        <Text style={{
          fontSize: 34,
          fontWeight: '800',
          color: '#1c1917',
          letterSpacing: -0.8,
          lineHeight: 40,
        }}>
          {greeting ? `Hi, ${greeting}` : 'Home'}
        </Text>
        <Text style={{ fontSize: 14, color: '#a8a29e', marginTop: 5 }}>
          {currentReads.length === 1
            ? `Currently reading · ${currentReads[0].title}`
            : currentReads.length > 1
            ? `${currentReads.length} books in progress`
            : 'Your reading world'}
        </Text>
      </View>

      {/* ── 1. Continue Reading ── */}
      {currentReads.length > 0 && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Continue Reading</SectionLabel>

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
                  backgroundColor: '#fff',
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
                      fontSize: 16, fontWeight: '700', color: '#1c1917', lineHeight: 22, marginBottom: 3,
                    }} numberOfLines={2}>{cr.title}</Text>
                    <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 12 }} numberOfLines={1}>
                      {cr.author}
                    </Text>
                    {(cr.current_page || cr.page_count) ? (
                      <>
                        <View style={{
                          height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, marginBottom: 6, overflow: 'hidden',
                        }}>
                          {progressPct(cr) > 0 && (
                            <View style={{
                              height: 3, width: `${progressPct(cr) * 100}%`, backgroundColor: '#1c1917', borderRadius: 2,
                            }} />
                          )}
                        </View>
                        <Text style={{ fontSize: 11, color: '#a8a29e' }}>{progressLabel(cr)}</Text>
                      </>
                    ) : (
                      <Text style={{ fontSize: 11, color: '#a8a29e' }}>In progress</Text>
                    )}
                  </View>
                  <Text style={{ fontSize: 20, color: '#d6d3d1', marginLeft: 8 }}>›</Text>
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
                      backgroundColor: '#fff',
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
                            fontSize: 14, fontWeight: '700', color: '#1c1917', lineHeight: 19, marginBottom: 3,
                          }}>{cr.title}</Text>
                          <Text numberOfLines={1} style={{ fontSize: 12, color: '#78716c' }}>{cr.author}</Text>
                        </View>
                      </View>
                      {hasProgress ? (
                        <>
                          <View style={{
                            height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden', marginBottom: 4,
                          }}>
                            <View style={{
                              height: 3, width: `${pct}%`, backgroundColor: '#1c1917', borderRadius: 2,
                            }} />
                          </View>
                          <Text style={{ fontSize: 10, color: '#a8a29e', marginBottom: pacingNote ? 5 : 0 }}>
                            {progressLabel(cr)}
                          </Text>
                        </>
                      ) : (
                        <Text style={{ fontSize: 10, color: '#a8a29e', marginBottom: pacingNote ? 5 : 0 }}>
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
        </View>
      )}

      {/* ── Yearly Reading Goal ── */}
      {yearlyGoal && yearlyGoal > 0 && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Reading Goal</SectionLabel>
          <TouchableOpacity activeOpacity={0.8} onPress={() => setGoalExpanded(e => !e)}>
            <View style={{
              backgroundColor: '#fff',
              borderRadius: 16,
              padding: 16,
              shadowColor: '#000',
              shadowOpacity: 0.06,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              elevation: 2,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5 }}>
                    {booksThisYear.length}
                    <Text style={{ fontSize: 15, fontWeight: '400', color: '#a8a29e' }}> of {yearlyGoal}</Text>
                  </Text>
                  <Text style={{ fontSize: 12, color: '#78716c', marginTop: 3 }}>
                    books read in {new Date().getFullYear()}
                  </Text>
                </View>
                <Text style={{ fontSize: 18, color: '#d6d3d1', marginLeft: 8, marginTop: 4 }}>
                  {goalExpanded ? '↑' : '↓'}
                </Text>
              </View>
              <View style={{ height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden', marginBottom: 6 }}>
                <View style={{
                  height: 3,
                  width: `${Math.min(100, Math.round((booksThisYear.length / yearlyGoal) * 100))}%`,
                  backgroundColor: '#1c1917',
                  borderRadius: 2,
                }} />
              </View>
              <Text style={{ fontSize: 11, color: isOnPace(booksThisYear.length, yearlyGoal) ? '#78716c' : '#d97706' }}>
                {isOnPace(booksThisYear.length, yearlyGoal) ? 'On pace ✓' : 'Behind pace'}
              </Text>
            </View>
          </TouchableOpacity>

          {goalExpanded && (
            <View style={{
              backgroundColor: '#fff',
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
                  <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20 }}>
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
                      borderTopColor: '#f5f5f4',
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
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>
                        {book.title}
                      </Text>
                      <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }} numberOfLines={1}>
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
        </View>
      )}

      {/* ── 2. New from Friends (social strip + pending recs) ── */}
      {acceptedFriends.length > 0 && (pendingRecCount > 0 || friendFeedEvents.length > 0) && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>New from Friends</SectionLabel>

          {pendingRecCount > 0 && (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => router.push('/(tabs)/notes')}
              style={{ marginBottom: friendFeedEvents.length > 0 ? 10 : 0 }}
            >
              <View style={{
                backgroundColor: '#fff',
                borderRadius: 14,
                paddingHorizontal: 16,
                paddingVertical: 16,
                flexDirection: 'row',
                alignItems: 'center',
                shadowColor: '#000',
                shadowOpacity: 0.04,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 1 },
                elevation: 1,
              }}>
                <View style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: '#f5f5f4',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 14,
                }}>
                  <Text style={{ fontSize: 20 }}>📬</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917', marginBottom: 2 }}>
                    {pendingRecCount === 1
                      ? '1 recommendation waiting'
                      : `${pendingRecCount} recommendations waiting`}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#a8a29e' }}>
                    See what your friends picked for you
                  </Text>
                </View>
                <Text style={{ fontSize: 20, color: '#d6d3d1' }}>›</Text>
              </View>
            </TouchableOpacity>
          )}

          {friendFeedEvents.length > 0 && (
            <View style={{
              backgroundColor: '#fff',
              borderRadius: 14,
              shadowColor: '#000',
              shadowOpacity: 0.04,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
              overflow: 'hidden',
            }}>
              {friendFeedEvents.map((event, idx) => {
                const name = getFirstName(event.actor);
                const verb = eventVerb(event.event_type);
                const bookTitle = event.book?.title ?? '';
                return (
                  <View
                    key={event.id}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 10,
                      paddingHorizontal: 14,
                      borderBottomWidth: idx < friendFeedEvents.length - 1 ? 1 : 0,
                      borderBottomColor: '#f5f5f4',
                    }}
                  >
                    <InitialAvatar name={name} />
                    <Text style={{ flex: 1, fontSize: 13, color: '#57534e', lineHeight: 18 }} numberOfLines={1}>
                      <Text style={{ fontWeight: '600', color: '#1c1917' }}>{name}</Text>
                      {' '}{verb}{' '}
                      <Text style={{ fontStyle: 'italic' }}>"{bookTitle}"</Text>
                    </Text>
                    <Text style={{ fontSize: 11, color: '#c4b5a5', marginLeft: 8 }}>
                      {relativeTime(event.created_at)}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      {/* ── 3. Activity Feed ── */}
      <View style={{ marginBottom: 32 }}>
        <SectionLabel>Activity</SectionLabel>

        {feedError ? (
          <Text style={{ color: '#b91c1c', marginBottom: 16, fontSize: 14 }}>{feedError}</Text>
        ) : totalFeedWithVerb === 0 ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 24,
            alignItems: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}>
            <Text style={{ color: '#a8a29e', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
              Nothing yet.{'\n'}Add friends to see their activity here.
            </Text>
          </View>
        ) : (
          <>
            {displayedFeed.map(event => {
              const verb = eventVerb(event.event_type);
              const actor = getFirstName(event.actor);
              const title = event.book?.title ?? '';
              const author = event.book?.author ?? '';
              const canTap = !!event.book_id && !!title;

              const card = (
                <View
                  style={{
                    backgroundColor: '#fff',
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
                    <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginBottom: 2 }}>
                      {actor}{' '}
                      <Text style={{ fontWeight: '400', color: '#57534e' }}>{verb}</Text>
                    </Text>
                    {title ? (
                      <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', lineHeight: 20, marginBottom: 2 }}>
                        {title}
                      </Text>
                    ) : null}
                    {author ? (
                      <Text style={{ fontSize: 12, color: '#a8a29e', marginBottom: 4 }}>
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
            {totalFeedWithVerb > 6 && (
              <Text
                onPress={() => router.push('/(tabs)/notes')}
                style={{
                  color: '#a8a29e',
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
          placeholderTextColor="#a8a29e"
          style={{
            backgroundColor: '#fff',
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 15,
            color: '#1c1917',
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
          <Text style={{ color: '#a8a29e', marginBottom: 16, fontSize: 14 }}>No users found.</Text>
        )}

        {searchResults.length > 0 && (
          <View style={{
            backgroundColor: '#fff',
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
                    borderBottomColor: '#f5f5f4',
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <InitialAvatar name={getDisplayName(result)} />
                    <View>
                      <Text style={{ fontSize: 15, color: '#1c1917' }}>{getDisplayName(result)}</Text>
                      {(result.first_name || result.last_name) && (
                        <Text style={{ fontSize: 12, color: '#a8a29e' }}>@{result.username}</Text>
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
                        backgroundColor: addingId !== null ? '#d6d3d1' : '#1c1917',
                        borderRadius: 8,
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Add</Text>
                    </TouchableOpacity>
                  ) : rel === 'pending' ? (
                    <Text style={{ color: '#a8a29e', fontSize: 13 }}>Pending</Text>
                  ) : (
                    <Text style={{ color: '#78716c', fontSize: 13 }}>Friends</Text>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {acceptedFriends.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14, marginBottom: 16 }}>No friends yet.</Text>
        ) : (
          <View style={{
            backgroundColor: '#fff',
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
                  borderBottomColor: '#f5f5f4',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <InitialAvatar name={getDisplayName(friend)} />
                  <View>
                    <Text style={{ fontSize: 15, color: '#1c1917' }}>{getDisplayName(friend)}</Text>
                    {(friend.first_name || friend.last_name) && (
                      <Text style={{ fontSize: 12, color: '#a8a29e' }}>@{friend.username}</Text>
                    )}
                  </View>
                </View>
                <Text style={{ fontSize: 18, color: '#d6d3d1', marginRight: 2 }}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
