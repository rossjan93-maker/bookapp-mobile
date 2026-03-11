import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { supabase } from '../../lib/supabase';

type Profile = {
  id: string;
  username: string;
};

type RequestStatus = 'sent' | 'duplicate' | 'error';

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [results, setResults] = useState<Profile[]>([]);
  const [searching, setSearching] = useState(false);
  const [requestStatus, setRequestStatus] = useState<Record<string, RequestStatus>>({});

  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!supabase || !currentUserId || query.length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      const { data } = await supabase
        .from('profiles')
        .select('id, username')
        .ilike('username', `%${query}%`)
        .neq('id', currentUserId)
        .limit(20);
      setResults(data ?? []);
      setSearching(false);
    }, 300);

    return () => clearTimeout(timer);
  }, [query, currentUserId]);

  async function sendRequest(addresseeId: string) {
    if (!supabase || !currentUserId) return;

    const { error } = await supabase.from('friendships').insert({
      requester_id: currentUserId,
      addressee_id: addresseeId,
      status: 'pending',
    });

    if (!error) {
      setRequestStatus(prev => ({ ...prev, [addresseeId]: 'sent' }));
    } else if (error.code === '23505') {
      setRequestStatus(prev => ({ ...prev, [addresseeId]: 'duplicate' }));
    } else {
      setRequestStatus(prev => ({ ...prev, [addresseeId]: 'error' }));
    }
  }

  function statusLabel(status: RequestStatus): string {
    if (status === 'sent') return 'Request sent';
    if (status === 'duplicate') return 'Already requested';
    return 'Error';
  }

  function statusColor(status: RequestStatus): string {
    return status === 'sent' ? '#080' : '#c00';
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <TextInput
        placeholder="Search by username"
        value={query}
        onChangeText={text => {
          setQuery(text);
          setRequestStatus({});
        }}
        autoCapitalize="none"
        style={{
          borderWidth: 1,
          borderColor: '#ccc',
          borderRadius: 6,
          padding: 10,
          marginBottom: 12,
          marginTop: 8,
        }}
      />

      {query.length > 0 && query.length < 2 && (
        <Text style={{ color: '#999', marginBottom: 8 }}>
          Type at least 2 characters to search.
        </Text>
      )}

      {searching && <ActivityIndicator style={{ marginBottom: 12 }} />}

      <FlatList
        data={results}
        keyExtractor={item => item.id}
        renderItem={({ item }) => {
          const status = requestStatus[item.id];
          return (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: '#eee',
              }}
            >
              <Text>{item.username}</Text>
              {status ? (
                <Text style={{ color: statusColor(status), fontSize: 13 }}>
                  {statusLabel(status)}
                </Text>
              ) : (
                <TouchableOpacity
                  onPress={() => sendRequest(item.id)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderWidth: 1,
                    borderColor: '#000',
                    borderRadius: 6,
                  }}
                >
                  <Text style={{ fontSize: 13 }}>Send request</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          !searching && query.length >= 2 ? (
            <Text style={{ color: '#999', marginTop: 8 }}>No users found.</Text>
          ) : null
        }
      />
    </View>
  );
}
