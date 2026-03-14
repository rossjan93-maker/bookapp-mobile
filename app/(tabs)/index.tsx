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

// ─── Types ────────────────────────────────────────────────────────────────────

type CurrentRead = {
  id: string;
  book_id: string;
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
  const [currentRead, setCurrentRead] = useState<CurrentRead | null>(null);
  const [pendingRecCount, setPendingRecCount] = useState(0);

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

      await Promise.all([
        loadFeed(),
        loadFriendships(user.id),
        loadCurrentRead(user.id),
        loadPendingRecs(user.id),
      ]);
      setFeedLoading(false);
      setLoadingFriendships(false);
    }
    init();
  }, []));

  // ── Data loaders ─────────────────────────────────────────────────────────────

  async function loadFeed() {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('activity_events')
      .select(
        'id, event_type, created_at, book_id, ' +
        'actor:profiles!activity_events_actor_id_fkey(username, first_name, last_name), ' +
        'book:books!activity_events_book_id_fkey(title, author, cover_url, external_id)'
      )
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      setFeedError('Could not load feed.');
    } else {
      setFeed((data as FeedEvent[]) ?? []);
    }
  }

  async function loadFriendships(uid: string) {
    if (!supabase) return;
    const { data } = await supabase
      .from('friendships')
      .select(
        'id, requester_id, addressee_id, status, ' +
        'requester:profiles!friendships_requester_id_fkey(id, username, first_name, last_name), ' +
        'addressee:profiles!friendships_addressee_id_fkey(id, username, first_name, last_name)'
      )
      .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
    setFriendships((data as FriendshipRow[]) ?? []);
  }

  async function loadCurrentRead(uid: string) {
    if (!supabase) return;
    // Try with progress columns; fall back if migration not yet applied.
    let res = await supabase
      .from('user_books')
      .select('id, book_id, current_page, book:books(title, author, cover_url, external_id, page_count)')
      .eq('user_id', uid)
      .eq('status', 'reading')
      .order('progress_updated_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (res.error) {
      res = await supabase
        .from('user_books')
        .select('id, book_id, book:books(title, author, cover_url, external_id)')
        .eq('user_id', uid)
        .eq('status', 'reading')
        .limit(1)
        .maybeSingle();
    }

    if (res.data) {
      const b = res.data.book as any;
      setCurrentRead({
        id: res.data.id,
        book_id: res.data.book_id,
        current_page: res.data.current_page ?? null,
        title: b?.title ?? '',
        author: b?.author ?? '',
        cover_url: b?.cover_url ?? null,
        external_id: b?.external_id ?? null,
        page_count: b?.page_count ?? null,
      });
    } else {
      setCurrentRead(null);
    }
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

  // ── Loading ───────────────────────────────────────────────────────────────────

  if (feedLoading || loadingFriendships) {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

  // ── Progress helpers ─────────────────────────────────────────────────────────

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
          {currentRead ? `Currently reading · ${currentRead.title}` : 'Your reading world'}
        </Text>
      </View>

      {/* ── 1. Continue Reading ── */}
      {currentRead && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>Continue Reading</SectionLabel>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push({
              pathname: '/book/[id]',
              params: {
                id: currentRead.book_id,
                title: currentRead.title,
                author: currentRead.author,
                coverUrl: currentRead.cover_url ?? '',
                externalId: currentRead.external_id ?? '',
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
              borderLeftColor: '#1c1917',
            }}>
              <CoverThumb
                url={currentRead.cover_url}
                externalId={currentRead.external_id}
                width={56}
                height={82}
              />
              <View style={{ flex: 1, marginLeft: 16 }}>
                <Text style={{
                  fontSize: 16,
                  fontWeight: '700',
                  color: '#1c1917',
                  lineHeight: 22,
                  marginBottom: 3,
                }} numberOfLines={2}>
                  {currentRead.title}
                </Text>
                <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 12 }} numberOfLines={1}>
                  {currentRead.author}
                </Text>
                {/* Progress bar */}
                {(currentRead.current_page || currentRead.page_count) ? (
                  <>
                    <View style={{
                      height: 3,
                      backgroundColor: '#e7e5e4',
                      borderRadius: 2,
                      marginBottom: 6,
                      overflow: 'hidden',
                    }}>
                      {progressPct(currentRead) > 0 && (
                        <View style={{
                          height: 3,
                          width: `${progressPct(currentRead) * 100}%`,
                          backgroundColor: '#1c1917',
                          borderRadius: 2,
                        }} />
                      )}
                    </View>
                    <Text style={{ fontSize: 11, color: '#a8a29e' }}>
                      {progressLabel(currentRead)}
                    </Text>
                  </>
                ) : (
                  <Text style={{ fontSize: 11, color: '#a8a29e' }}>In progress</Text>
                )}
              </View>
              <Text style={{ fontSize: 20, color: '#d6d3d1', marginLeft: 8 }}>›</Text>
            </View>
          </TouchableOpacity>
        </View>
      )}

      {/* ── 2. New from Friends (pending recommendations) ── */}
      {pendingRecCount > 0 && (
        <View style={{ marginBottom: 32 }}>
          <SectionLabel>New from Friends</SectionLabel>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push('/(tabs)/notes')}
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
        </View>
      )}

      {/* ── 3. Activity Feed ── */}
      <View style={{ marginBottom: 32 }}>
        <SectionLabel>Activity</SectionLabel>

        {feedError ? (
          <Text style={{ color: '#b91c1c', marginBottom: 16, fontSize: 14 }}>{feedError}</Text>
        ) : feed.length === 0 ? (
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
            {feed.map(event => {
              const verb = eventVerb(event.event_type);
              if (!verb) return null;
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
          </>
        )}
      </View>

      {/* ── 4. Find Friends ── */}
      <View style={{ marginBottom: 32 }}>
        <SectionLabel>Find Friends</SectionLabel>

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
      </View>

      {/* ── 5. Friends ── */}
      <View>
        <SectionLabel>
          {acceptedFriends.length > 0 ? `Friends (${acceptedFriends.length})` : 'Friends'}
        </SectionLabel>

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
