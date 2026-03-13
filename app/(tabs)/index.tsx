import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';

type FeedEvent = {
  id: string;
  event_type: string;
  created_at: string;
  actor: { username: string } | null;
  book: { title: string; author: string } | null;
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

function eventText(event: FeedEvent): string {
  const actor = event.actor?.username ?? 'Someone';
  const title = event.book?.title ?? 'a book';
  switch (event.event_type) {
    case 'recommendation_sent':
      return `${actor} recommended "${title}"`;
    case 'recommendation_saved':
      return `${actor} saved "${title}"`;
    case 'recommendation_started':
      return `${actor} started reading "${title}"`;
    case 'recommendation_finished':
      return `${actor} finished "${title}"`;
    case 'book_finished':
      return `${actor} finished "${title}"`;
    default:
      return '';
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
      color: '#9ca3af',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      marginBottom: 10,
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
      backgroundColor: '#e5e7eb',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    }}>
      <Text style={{ fontSize: 15, fontWeight: '600', color: '#374151' }}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

export default function HomeScreen() {
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
        'id, event_type, created_at, ' +
        'actor:profiles!activity_events_actor_id_fkey(username), ' +
        'book:books!activity_events_book_id_fkey(title, author)'
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
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#111827" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32 }}>

      {/* ── Activity Feed ── */}
      <SectionLabel>Activity</SectionLabel>

      {feedError ? (
        <Text style={{ color: '#b91c1c', marginBottom: 16, fontSize: 14 }}>{feedError}</Text>
      ) : feed.length === 0 ? (
        <View style={{
          backgroundColor: '#f9fafb',
          borderRadius: 10,
          padding: 20,
          alignItems: 'center',
          marginBottom: 28,
        }}>
          <Text style={{ color: '#9ca3af', fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
            Nothing yet.{'\n'}Add friends to see their activity here.
          </Text>
        </View>
      ) : (
        <View style={{ marginBottom: 28 }}>
          {feed.map(event => {
            const text = eventText(event);
            if (!text) return null;
            return (
              <View
                key={event.id}
                style={{
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: '#f3f4f6',
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                <Text style={{ fontSize: 14, color: '#111827', lineHeight: 20, flex: 1, marginRight: 12 }}>
                  {text}
                </Text>
                <Text style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {relativeTime(event.created_at)}
                </Text>
              </View>
            );
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
        placeholderTextColor="#9ca3af"
        style={{
          backgroundColor: '#f3f4f6',
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 11,
          fontSize: 15,
          color: '#111827',
          marginBottom: 10,
        }}
      />

      {searching && <ActivityIndicator color="#111827" style={{ marginVertical: 10 }} />}

      {searchError && (
        <Text style={{ color: '#b91c1c', marginBottom: 8, fontSize: 13 }}>{searchError}</Text>
      )}

      {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
        <Text style={{ color: '#9ca3af', marginBottom: 16, fontSize: 14 }}>No users found.</Text>
      )}

      {searchResults.length > 0 && (
        <View style={{ marginBottom: 20 }}>
          {searchResults.map(result => {
            const rel = userId ? getRelationship(userId, result.id, friendships) : 'none';
            const isAdding = addingId === result.id;
            return (
              <View
                key={result.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: '#f3f4f6',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <InitialAvatar name={result.username} />
                  <Text style={{ fontSize: 15, color: '#111827' }}>{result.username}</Text>
                </View>
                {isAdding ? (
                  <ActivityIndicator color="#111827" size="small" />
                ) : rel === 'none' ? (
                  <TouchableOpacity
                    onPress={() => handleAddFriend(result.id)}
                    disabled={addingId !== null}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      backgroundColor: addingId !== null ? '#9ca3af' : '#111827',
                      borderRadius: 8,
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Add</Text>
                  </TouchableOpacity>
                ) : rel === 'pending' ? (
                  <Text style={{ color: '#9ca3af', fontSize: 13 }}>Pending</Text>
                ) : (
                  <Text style={{ color: '#6b7280', fontSize: 13 }}>Friends</Text>
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
        <Text style={{ color: '#9ca3af', fontSize: 14, marginBottom: 16 }}>No friends yet.</Text>
      ) : (
        acceptedFriends.map(friend => (
          <View
            key={friend.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: '#f3f4f6',
            }}
          >
            <InitialAvatar name={friend.username} />
            <Text style={{ fontSize: 15, color: '#111827' }}>{friend.username}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}
