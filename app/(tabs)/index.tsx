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

type FeedEvent = {
  id: string;
  event_type: string;
  created_at: string;
  book_id: string | null;
  actor: { username: string } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

type ProfileResult = {
  id: string;
  username: string;
};

type FriendshipRow = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  requester: { id: string; username: string } | null;
  addressee: { id: string; username: string } | null;
};

type RelationshipState = 'none' | 'pending' | 'accepted';

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

export default function HomeScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);

  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);

  const [friendships, setFriendships] = useState<FriendshipRow[]>([]);
  const [loadingFriendships, setLoadingFriendships] = useState(true);

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
      await Promise.all([loadFeed(), loadFriendships(user.id)]);
      setFeedLoading(false);
      setLoadingFriendships(false);
    }
    init();
  }, []));

  async function loadFeed() {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('activity_events')
      .select(
        'id, event_type, created_at, book_id, ' +
        'actor:profiles!activity_events_actor_id_fkey(username), ' +
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
        'requester:profiles!friendships_requester_id_fkey(id, username), ' +
        'addressee:profiles!friendships_addressee_id_fkey(id, username)'
      )
      .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
    setFriendships((data as FriendshipRow[]) ?? []);
  }

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
      .select('id, username')
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

  const acceptedFriends = friendships
    .filter(f => f.status === 'accepted')
    .map(f => (f.requester_id === userId ? f.addressee : f.requester))
    .filter(Boolean) as { id: string; username: string }[];

  if (feedLoading || loadingFriendships) {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

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
          Friends' Activity
        </Text>
        <Text style={{ fontSize: 14, color: '#a8a29e', marginTop: 5 }}>
          What everyone is reading
        </Text>
      </View>

      {/* ── Activity Feed ── */}
      <SectionLabel>Activity</SectionLabel>

      {feedError ? (
        <Text style={{ color: '#b91c1c', marginBottom: 16, fontSize: 14 }}>{feedError}</Text>
      ) : feed.length === 0 ? (
        <View style={{
          backgroundColor: '#fff',
          borderRadius: 14,
          padding: 24,
          alignItems: 'center',
          marginBottom: 32,
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
        <View style={{ marginBottom: 32 }}>
          {feed.map(event => {
            const verb = eventVerb(event.event_type);
            if (!verb) return null;
            const actor = event.actor?.username ?? 'Someone';
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
        </View>
      )}

      {/* ── Find Friends ── */}
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
          marginBottom: 20,
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
                  <InitialAvatar name={result.username} />
                  <Text style={{ fontSize: 15, color: '#1c1917' }}>{result.username}</Text>
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

      {/* ── Friends ── */}
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
              onPress={() => router.push({ pathname: '/friend/[id]', params: { id: friend.id, username: friend.username } })}
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
                <InitialAvatar name={friend.username} />
                <Text style={{ fontSize: 15, color: '#1c1917' }}>{friend.username}</Text>
              </View>
              <Text style={{ fontSize: 18, color: '#d6d3d1', marginRight: 2 }}>›</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
