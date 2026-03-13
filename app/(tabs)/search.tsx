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

type Step = 'search' | 'friends' | 'done';

type BookResult = {
  key: string;
  title: string;
  author_name?: string[];
};

type SelectedBook = {
  externalId: string;
  title: string;
  author: string;
};

type Friend = {
  id: string;
  username: string;
};

export default function SearchScreen() {
  const [step, setStep] = useState<Step>('search');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [bookResults, setBookResults] = useState<BookResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null);

  const [friends, setFriends] = useState<Friend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [sendingTo, setSendingTo] = useState<string | null>(null);

  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (query.length < 2) {
      setBookResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name&limit=10`
        );
        const json = await res.json();
        setBookResults(json.docs ?? []);
      } catch {
        setBookResults([]);
      }
      setSearching(false);
    }, 400);

    return () => clearTimeout(timer);
  }, [query]);

  async function handleSelectBook(book: BookResult) {
    if (!supabase || !currentUserId) return;

    const selected: SelectedBook = {
      externalId: book.key,
      title: book.title,
      author: book.author_name?.[0] ?? 'Unknown author',
    };
    setSelectedBook(selected);
    setStep('friends');
    setLoadingFriends(true);

    const { data: friendships } = await supabase
      .from('friendships')
      .select('requester_id, addressee_id')
      .eq('status', 'accepted')
      .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`);

    if (!friendships || friendships.length === 0) {
      setFriends([]);
      setLoadingFriends(false);
      return;
    }

    const friendIds = friendships.map(f =>
      f.requester_id === currentUserId ? f.addressee_id : f.requester_id
    );

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username')
      .in('id', friendIds);

    setFriends((profiles as Friend[]) ?? []);
    setLoadingFriends(false);
  }

  async function handleSend(friend: Friend) {
    if (!supabase || !currentUserId || !selectedBook) return;

    setSendingTo(friend.id);

    const { data: existingBook } = await supabase
      .from('books')
      .select('id')
      .eq('external_id', selectedBook.externalId)
      .maybeSingle();

    let bookId: string;

    if (existingBook) {
      bookId = existingBook.id;
    } else {
      const { data: newBook, error: bookInsertError } = await supabase
        .from('books')
        .insert({
          title: selectedBook.title,
          author: selectedBook.author,
          external_id: selectedBook.externalId,
        })
        .select('id')
        .single();

      if (bookInsertError || !newBook) {
        setSendingTo(null);
        setStep('done');
        setSendResult({ ok: false, message: 'Could not save book. Try again.' });
        return;
      }

      bookId = newBook.id;
    }

    const { data: newRec, error: recError } = await supabase
      .from('recommendations')
      .insert({
        from_user_id: currentUserId,
        to_user_id: friend.id,
        book_id: bookId,
        status: 'sent',
      })
      .select('id')
      .single();

    setSendingTo(null);
    setStep('done');

    if (recError || !newRec) {
      setSendResult({ ok: false, message: recError ? `Could not send: ${recError.message}` : 'Could not send. Try again.' });
    } else {
      await supabase.from('activity_events').insert({
        actor_id: currentUserId,
        event_type: 'recommendation_sent',
        book_id: bookId,
        recommendation_id: newRec.id,
      });
      setSendResult({
        ok: true,
        message: `Sent "${selectedBook.title}" to ${friend.username}.`,
      });
    }
  }

  function reset() {
    setStep('search');
    setQuery('');
    setBookResults([]);
    setSelectedBook(null);
    setFriends([]);
    setSendResult(null);
    setSendingTo(null);
  }

  if (step === 'search') {
    return (
      <View style={{ flex: 1, padding: 16 }}>
        <TextInput
          placeholder="Search for a book"
          value={query}
          onChangeText={setQuery}
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
          data={bookResults}
          keyExtractor={item => item.key}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => handleSelectBook(item)}
              style={{
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: '#eee',
              }}
            >
              <Text style={{ fontWeight: '500' }}>{item.title}</Text>
              <Text style={{ color: '#666', fontSize: 13, marginTop: 2 }}>
                {item.author_name?.[0] ?? 'Unknown author'}
              </Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            !searching && query.length >= 2 ? (
              <Text style={{ color: '#999', marginTop: 8 }}>No books found.</Text>
            ) : null
          }
        />
      </View>
    );
  }

  if (step === 'friends') {
    return (
      <View style={{ flex: 1, padding: 16 }}>
        <TouchableOpacity onPress={() => setStep('search')} style={{ marginBottom: 16, marginTop: 8 }}>
          <Text style={{ color: '#555' }}>← Back to search</Text>
        </TouchableOpacity>

        <View
          style={{
            padding: 12,
            backgroundColor: '#f5f5f5',
            borderRadius: 6,
            marginBottom: 20,
          }}
        >
          <Text style={{ fontWeight: '600' }}>{selectedBook?.title}</Text>
          <Text style={{ color: '#666', fontSize: 13, marginTop: 2 }}>
            {selectedBook?.author}
          </Text>
        </View>

        <Text style={{ fontWeight: '600', marginBottom: 12 }}>Send to a friend</Text>

        {loadingFriends ? (
          <ActivityIndicator />
        ) : friends.length === 0 ? (
          <Text style={{ color: '#999' }}>No accepted friends yet.</Text>
        ) : (
          <FlatList
            data={friends}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
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
                <TouchableOpacity
                  onPress={() => handleSend(item)}
                  disabled={sendingTo !== null}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    backgroundColor: sendingTo === item.id ? '#999' : '#000',
                    borderRadius: 6,
                  }}
                >
                  {sendingTo === item.id ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 13 }}>Send</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          />
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text
        style={{
          fontSize: 16,
          color: sendResult?.ok ? '#080' : '#c00',
          marginBottom: 24,
          textAlign: 'center',
        }}
      >
        {sendResult?.message ?? ''}
      </Text>
      <TouchableOpacity
        onPress={reset}
        style={{
          padding: 12,
          borderWidth: 1,
          borderColor: '#000',
          borderRadius: 6,
        }}
      >
        <Text>Send another recommendation</Text>
      </TouchableOpacity>
    </View>
  );
}
