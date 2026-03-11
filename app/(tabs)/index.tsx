import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase } from '../../lib/supabase';

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

export default function FindFriendsScreen() {
  const [userId, setUserId] = useState<string | null>(null);
  const [friendships, setFriendships] = useState<FriendshipRow[]>([]);
  const [loadingFriendships, setLoadingFriendships] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ProfileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [addingId, setAddingId] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function init() {
      if (!supabase) {
        setLoadingFriendships(false);
        return;
      }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setLoadingFriendships(false);
        return;
      }
      setUserId(user.id);
      await loadFriendships(user.id);
      setLoadingFriendships(false);
    }
    init();
  }, []);

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
    .map(f => {
      const other = f.requester_id === userId ? f.addressee : f.requester;
      return other;
    })
    .filter(Boolean) as { id: string; username: string }[];

  if (loadingFriendships) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 20 }}>
      <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 20, marginTop: 8 }}>
        Find Friends
      </Text>

      <View style={{ marginBottom: 8 }}>
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search by username…"
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            borderWidth: 1,
            borderColor: '#ccc',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: 15,
          }}
        />
      </View>

      {searching && (
        <ActivityIndicator style={{ marginVertical: 12 }} />
      )}

      {searchError && (
        <Text style={{ color: '#c00', marginBottom: 8 }}>{searchError}</Text>
      )}

      {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
        <Text style={{ color: '#999', marginBottom: 16 }}>No users found.</Text>
      )}

      {searchResults.length > 0 && (
        <View style={{ marginBottom: 32 }}>
          {searchResults.map(result => {
            const rel = userId
              ? getRelationship(userId, result.id, friendships)
              : 'none';
            const isAdding = addingId === result.id;

            return (
              <View
                key={result.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: '#eee',
                }}
              >
                <Text style={{ fontSize: 15 }}>{result.username}</Text>

                {isAdding ? (
                  <ActivityIndicator />
                ) : rel === 'none' ? (
                  <TouchableOpacity
                    onPress={() => handleAddFriend(result.id)}
                    disabled={addingId !== null}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      backgroundColor: addingId !== null ? '#ccc' : '#000',
                      borderRadius: 6,
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 13 }}>Add Friend</Text>
                  </TouchableOpacity>
                ) : rel === 'pending' ? (
                  <Text style={{ color: '#999', fontSize: 13 }}>Pending</Text>
                ) : (
                  <Text style={{ color: '#555', fontSize: 13 }}>Friends</Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      <Text style={{ fontWeight: '600', marginBottom: 12 }}>
        Friends{acceptedFriends.length > 0 ? ` (${acceptedFriends.length})` : ''}
      </Text>

      {acceptedFriends.length === 0 ? (
        <Text style={{ color: '#999' }}>No friends yet.</Text>
      ) : (
        acceptedFriends.map(friend => (
          <View
            key={friend.id}
            style={{
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: '#eee',
            }}
          >
            <Text style={{ fontSize: 15 }}>{friend.username}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}
