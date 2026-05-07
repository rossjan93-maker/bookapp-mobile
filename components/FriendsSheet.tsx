import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { showToast } from '../lib/toast';
import { getDisplayName } from '../lib/displayName';
import { sendFriendRequest, deleteFriendship } from '../lib/friendshipActions';

// ─── Types ────────────────────────────────────────────────────────────────────

type Profile = {
  id: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
};

export type FriendshipRow = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: string;
  requester: Profile | null;
  addressee: Profile | null;
};

type FriendsSheetProps = {
  visible:             boolean;
  onClose:             () => void;
  userId:              string | null;
  friendships:         FriendshipRow[];
  onFriendshipsChange: () => void | Promise<void>;
};

type ProfileResult = Profile;
type RelationshipState = 'none' | 'pending' | 'accepted';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRelationship(
  userId: string,
  otherId: string,
  friendships: FriendshipRow[],
): RelationshipState {
  const row = friendships.find(
    f =>
      (f.requester_id === userId && f.addressee_id === otherId) ||
      (f.addressee_id === userId && f.requester_id === otherId),
  );
  if (!row) return 'none';
  if (row.status === 'accepted') return 'accepted';
  return 'pending';
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

// ─── Sheet ────────────────────────────────────────────────────────────────────

export function FriendsSheet({
  visible,
  onClose,
  userId,
  friendships,
  onFriendshipsChange,
}: FriendsSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<ProfileResult[]>([]);
  const [searching,     setSearching]     = useState(false);
  const [searchError,   setSearchError]   = useState<string | null>(null);
  const [pendingId,     setPendingId]     = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset search when the sheet closes so reopening starts clean
  useEffect(() => {
    if (!visible) {
      setSearchQuery('');
      setSearchResults([]);
      setSearchError(null);
      setPendingId(null);
    }
  }, [visible]);

  // Debounced search
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, userId]);

  async function runSearch(query: string) {
    if (!supabase || !userId) return;
    setSearching(true);
    setSearchError(null);
    // P0 security: profiles SELECT is restricted to self + accepted friends.
    // Free-text friend discovery goes through the SECURITY DEFINER RPC
    // search_profiles (migration 20260508000000_p0_security_hardening.sql),
    // which returns only id/username/first_name/last_name capped at 20 rows.
    const { data, error } = await supabase.rpc('search_profiles', { q: query });
    if (error) {
      setSearchError('Search failed.');
    } else {
      setSearchResults((data as ProfileResult[]) ?? []);
    }
    setSearching(false);
  }

  async function handleSendRequest(otherId: string) {
    if (!supabase || !userId) return;
    setPendingId(otherId);
    const result = await sendFriendRequest(otherId);
    if (result.ok) {
      await onFriendshipsChange();
      showToast('Friend request sent');
    } else {
      showToast(result.message);
    }
    setPendingId(null);
  }

  async function handleAccept(friendshipId: string) {
    if (!supabase) return;
    setPendingId(friendshipId);
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('id', friendshipId);
    if (!error) {
      await onFriendshipsChange();
      showToast('Friend added');
    }
    setPendingId(null);
  }

  // Used for: declining a received request, cancelling an outbound request,
  // and unfriending an accepted friend.  All three DELETE the same row.
  async function handleDecline(friendshipId: string) {
    setPendingId(friendshipId);
    const result = await deleteFriendship(friendshipId);
    if (result.ok) {
      await onFriendshipsChange();
    } else if (result.message) {
      showToast(result.message);
    }
    setPendingId(null);
  }

  function handleUnfriend(friendshipId: string, friendName: string) {
    Alert.alert(
      `Unfriend ${friendName}?`,
      "You'll no longer see each other's reading activity.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unfriend', style: 'destructive', onPress: () => handleDecline(friendshipId) },
      ],
    );
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const incomingRequests = friendships.filter(
    f => f.status === 'pending' && f.addressee_id === userId,
  );

  const outgoingRequests = friendships.filter(
    f => f.status === 'pending' && f.requester_id === userId,
  );

  const acceptedFriends = friendships
    .filter(f => f.status === 'accepted')
    .map(f => {
      const other = f.requester_id === userId ? f.addressee : f.requester;
      return other ? { ...other, _friendshipId: f.id } : null;
    })
    .filter(Boolean) as (Profile & { _friendshipId: string })[];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>

        {/* Header */}
        <View style={{
          flexDirection:   'row',
          alignItems:      'center',
          justifyContent:  'space-between',
          paddingHorizontal: 20,
          paddingTop:      insets.top > 0 ? 8 : 16,
          paddingBottom:   12,
          borderBottomWidth: 1,
          borderBottomColor: '#ede9e4',
          backgroundColor: '#f5f1ec',
        }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#231f1b', letterSpacing: -0.3 }}>
            Friends
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Text style={{ fontSize: 14, color: '#78716c', fontWeight: '500' }}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 32 }}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── Search to add new friends ─────────────────────────────── */}
          <Text style={{
            fontSize: 10, fontWeight: '700', color: '#9e958d',
            letterSpacing: 1.4, textTransform: 'uppercase',
            marginBottom: 10,
          }}>
            Add friend
          </Text>

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
            <Text style={{ color: '#9e958d', marginBottom: 16, fontSize: 14 }}>
              No users found.
            </Text>
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
              marginBottom: 24,
            }}>
              {searchResults.map((result, idx) => {
                const rel      = userId ? getRelationship(userId, result.id, friendships) : 'none';
                const isAdding = pendingId === result.id;
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
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                      <InitialAvatar name={getDisplayName(result)} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, color: '#231f1b' }} numberOfLines={1}>
                          {getDisplayName(result)}
                        </Text>
                        {(result.first_name || result.last_name) && (
                          <Text style={{ fontSize: 12, color: '#9e958d' }} numberOfLines={1}>
                            @{result.username}
                          </Text>
                        )}
                      </View>
                    </View>
                    {isAdding ? (
                      <ActivityIndicator color="#78716c" size="small" />
                    ) : rel === 'none' ? (
                      <TouchableOpacity
                        onPress={() => handleSendRequest(result.id)}
                        disabled={pendingId !== null}
                        style={{
                          paddingHorizontal: 14,
                          paddingVertical: 7,
                          backgroundColor: pendingId !== null ? '#ede9e4' : '#231f1b',
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

          {/* ── Incoming requests (NEW) ──────────────────────────────── */}
          {incomingRequests.length > 0 && (
            <>
              <Text style={{
                fontSize: 10, fontWeight: '700', color: '#9e958d',
                letterSpacing: 1.4, textTransform: 'uppercase',
                marginTop: 8, marginBottom: 10,
              }}>
                Friend requests · {incomingRequests.length}
              </Text>

              <View style={{
                backgroundColor: '#fefcf9',
                borderRadius: 14,
                shadowColor: '#000',
                shadowOpacity: 0.04,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 1 },
                elevation: 1,
                overflow: 'hidden',
                marginBottom: 24,
              }}>
                {incomingRequests.map((req, idx) => {
                  const sender   = req.requester;
                  if (!sender) return null;
                  const isBusy   = pendingId === req.id;
                  const disabled = pendingId !== null;
                  return (
                    <View
                      key={req.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 12,
                        paddingHorizontal: 16,
                        borderBottomWidth: idx < incomingRequests.length - 1 ? 1 : 0,
                        borderBottomColor: '#ede9e4',
                      }}
                    >
                      <InitialAvatar name={getDisplayName(sender)} />
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={{ fontSize: 15, color: '#231f1b' }} numberOfLines={1}>
                          {getDisplayName(sender)}
                        </Text>
                        {(sender.first_name || sender.last_name) && (
                          <Text style={{ fontSize: 12, color: '#9e958d' }} numberOfLines={1}>
                            @{sender.username}
                          </Text>
                        )}
                      </View>

                      {isBusy ? (
                        <ActivityIndicator color="#78716c" size="small" />
                      ) : (
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <TouchableOpacity
                            onPress={() => handleDecline(req.id)}
                            disabled={disabled}
                            style={{
                              paddingHorizontal: 12,
                              paddingVertical: 7,
                              borderRadius: 8,
                              borderWidth: 1,
                              borderColor: '#ede9e4',
                            }}
                          >
                            <Text style={{ color: '#78716c', fontSize: 13, fontWeight: '500' }}>
                              Decline
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => handleAccept(req.id)}
                            disabled={disabled}
                            style={{
                              paddingHorizontal: 14,
                              paddingVertical: 7,
                              borderRadius: 8,
                              backgroundColor: disabled ? '#ede9e4' : '#231f1b',
                            }}
                          >
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                              Accept
                            </Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            </>
          )}

          {/* ── Outgoing pending requests ────────────────────────────── */}
          {outgoingRequests.length > 0 && (
            <>
              <Text style={{
                fontSize: 10, fontWeight: '700', color: '#9e958d',
                letterSpacing: 1.4, textTransform: 'uppercase',
                marginTop: 8, marginBottom: 10,
              }}>
                Sent · waiting
              </Text>

              <View style={{
                backgroundColor: '#fefcf9',
                borderRadius: 14,
                shadowColor: '#000',
                shadowOpacity: 0.04,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 1 },
                elevation: 1,
                overflow: 'hidden',
                marginBottom: 24,
              }}>
                {outgoingRequests.map((req, idx) => {
                  const target = req.addressee;
                  if (!target) return null;
                  const isBusy = pendingId === req.id;
                  return (
                    <View
                      key={req.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 12,
                        paddingHorizontal: 16,
                        borderBottomWidth: idx < outgoingRequests.length - 1 ? 1 : 0,
                        borderBottomColor: '#ede9e4',
                      }}
                    >
                      <InitialAvatar name={getDisplayName(target)} />
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={{ fontSize: 15, color: '#231f1b' }} numberOfLines={1}>
                          {getDisplayName(target)}
                        </Text>
                        {(target.first_name || target.last_name) && (
                          <Text style={{ fontSize: 12, color: '#9e958d' }} numberOfLines={1}>
                            @{target.username}
                          </Text>
                        )}
                      </View>
                      {isBusy ? (
                        <ActivityIndicator color="#78716c" size="small" />
                      ) : (
                        <TouchableOpacity
                          onPress={() => handleDecline(req.id)}
                          disabled={pendingId !== null}
                          style={{
                            paddingHorizontal: 12,
                            paddingVertical: 7,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: '#ede9e4',
                          }}
                        >
                          <Text style={{ color: '#78716c', fontSize: 13, fontWeight: '500' }}>
                            Cancel
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
            </>
          )}

          {/* ── Accepted friends ─────────────────────────────────────── */}
          <Text style={{
            fontSize: 10, fontWeight: '700', color: '#9e958d',
            letterSpacing: 1.4, textTransform: 'uppercase',
            marginTop: 8, marginBottom: 10,
          }}>
            Your friends · {acceptedFriends.length}
          </Text>

          {acceptedFriends.length === 0 ? (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              padding: 20,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: '#ede9e4',
            }}>
              <Ionicons name="people-outline" size={28} color="#c4b5a5" style={{ marginBottom: 8 }} />
              <Text style={{ color: '#78716c', fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
                No friends yet. Search above to add someone.
              </Text>
            </View>
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
                  onPress={() => {
                    onClose();
                    router.push({
                      pathname: '/friend/[id]',
                      params: {
                        id:        friend.id,
                        username:  friend.username,
                        firstName: friend.first_name ?? '',
                        lastName:  friend.last_name ?? '',
                      },
                    });
                  }}
                  onLongPress={() => handleUnfriend(friend._friendshipId, getDisplayName(friend))}
                  delayLongPress={400}
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
                  <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <InitialAvatar name={getDisplayName(friend)} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, color: '#231f1b' }} numberOfLines={1}>
                        {getDisplayName(friend)}
                      </Text>
                      {(friend.first_name || friend.last_name) && (
                        <Text style={{ fontSize: 12, color: '#9e958d' }} numberOfLines={1}>
                          @{friend.username}
                        </Text>
                      )}
                    </View>
                  </View>
                  <Text style={{ fontSize: 18, color: '#ede9e4', marginRight: 2 }}>›</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
