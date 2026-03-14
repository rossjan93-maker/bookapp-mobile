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
import { CoverThumb } from '../../components/CoverThumb';
import { getDisplayName, getFirstName } from '../../lib/displayName';

type Step = 'search' | 'friends' | 'done';

type BookResult = {
  key: string;
  title: string;
  author_name?: string[];
  cover_i?: number;
};

type SelectedBook = {
  externalId: string;
  title: string;
  author: string;
  coverUrl: string | null;
};

type Friend = {
  id: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
};

function olCoverUrl(coverId?: number, size: 'S' | 'M' = 'M'): string | null {
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}

export default function SearchScreen() {
  const [step, setStep] = useState<Step>('search');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [bookResults, setBookResults] = useState<BookResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null);

  const [note, setNote] = useState('');

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
          `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name,cover_i&limit=10`
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
      coverUrl: olCoverUrl(book.cover_i, 'M'),
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
      .select('id, username, first_name, last_name')
      .in('id', friendIds);

    setFriends((profiles as Friend[]) ?? []);
    setLoadingFriends(false);
  }

  async function handleSend(friend: Friend) {
    if (!supabase || !currentUserId || !selectedBook) return;

    setSendingTo(friend.id);

    const { data: existingBook } = await supabase
      .from('books')
      .select('id, cover_url')
      .eq('external_id', selectedBook.externalId)
      .maybeSingle();

    let bookId: string;

    if (existingBook) {
      bookId = existingBook.id;
      if (!existingBook.cover_url && selectedBook.coverUrl) {
        await supabase
          .from('books')
          .update({ cover_url: selectedBook.coverUrl })
          .eq('id', existingBook.id);
      }
    } else {
      const { data: newBook, error: bookInsertError } = await supabase
        .from('books')
        .insert({
          title: selectedBook.title,
          author: selectedBook.author,
          external_id: selectedBook.externalId,
          cover_url: selectedBook.coverUrl ?? null,
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
        note: note.trim() || null,
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
        message: `Sent "${selectedBook.title}" to ${getFirstName(friend)}.`,
      });
    }
  }

  function reset() {
    setStep('search');
    setQuery('');
    setBookResults([]);
    setSelectedBook(null);
    setNote('');
    setFriends([]);
    setSendResult(null);
    setSendingTo(null);
  }

  if (step === 'search') {
    return (
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 16 }}>
        <TextInput
          placeholder="Search for a book…"
          placeholderTextColor="#a8a29e"
          value={query}
          onChangeText={setQuery}
          style={{
            backgroundColor: '#fff',
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 16,
            color: '#1c1917',
            marginBottom: 12,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        />

        {query.length > 0 && query.length < 2 && (
          <Text style={{ color: '#a8a29e', marginBottom: 8, fontSize: 13 }}>
            Type at least 2 characters to search.
          </Text>
        )}

        {searching && <ActivityIndicator color="#78716c" style={{ marginBottom: 12 }} />}

        <FlatList
          data={bookResults}
          keyExtractor={item => item.key}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => handleSelectBook(item)}
              style={{
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: '#f5f5f4',
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <CoverThumb url={olCoverUrl(item.cover_i, 'S')} width={34} height={50} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ fontWeight: '600', fontSize: 15, color: '#1c1917' }}>
                  {item.title}
                </Text>
                <Text style={{ color: '#a8a29e', fontSize: 13, marginTop: 2 }}>
                  {item.author_name?.[0] ?? 'Unknown author'}
                </Text>
              </View>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            !searching && query.length >= 2 ? (
              <Text style={{ color: '#a8a29e', marginTop: 12, fontSize: 14 }}>No books found.</Text>
            ) : query.length === 0 ? (
              <View style={{
                alignItems: 'center',
                marginTop: 60,
                paddingHorizontal: 24,
              }}>
                <Text style={{ color: '#a8a29e', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                  Search for a book to recommend{'\n'}to a friend.
                </Text>
              </View>
            ) : null
          }
        />
      </View>
    );
  }

  if (step === 'friends') {
    return (
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 16 }}>
        <TouchableOpacity
          onPress={() => setStep('search')}
          style={{ marginBottom: 16 }}
        >
          <Text style={{ color: '#78716c', fontSize: 14 }}>← Back to search</Text>
        </TouchableOpacity>

        <View
          style={{
            backgroundColor: '#faf9f7',
            borderRadius: 14,
            padding: 14,
            marginBottom: 24,
            borderWidth: 1,
            borderColor: '#e7e5e4',
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <CoverThumb url={selectedBook?.coverUrl} width={48} height={70} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ fontWeight: '600', fontSize: 15, color: '#1c1917' }}>
              {selectedBook?.title}
            </Text>
            <Text style={{ color: '#78716c', fontSize: 13, marginTop: 4 }}>
              {selectedBook?.author}
            </Text>
          </View>
        </View>

        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Add a note (optional)…"
          placeholderTextColor="#a8a29e"
          maxLength={280}
          style={{
            backgroundColor: '#fff',
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 11,
            fontSize: 14,
            color: '#1c1917',
            marginBottom: 24,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        />

        <Text style={{
          fontSize: 11,
          fontWeight: '700',
          color: '#a8a29e',
          letterSpacing: 0.9,
          textTransform: 'uppercase',
          marginBottom: 10,
        }}>
          Send to a friend
        </Text>

        {loadingFriends ? (
          <ActivityIndicator color="#78716c" />
        ) : friends.length === 0 ? (
          <View style={{
            backgroundColor: '#faf9f7',
            borderRadius: 12,
            padding: 20,
            alignItems: 'center',
          }}>
            <Text style={{ color: '#a8a29e', fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
              No friends yet.{'\n'}Add friends from the Home tab first.
            </Text>
          </View>
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
                  borderBottomColor: '#f5f5f4',
                }}
              >
                <Text style={{ fontSize: 15, color: '#1c1917' }}>{getDisplayName(item)}</Text>
                <TouchableOpacity
                  onPress={() => handleSend(item)}
                  disabled={sendingTo !== null}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    backgroundColor: sendingTo !== null ? '#a8a29e' : '#1c1917',
                    borderRadius: 8,
                  }}
                >
                  {sendingTo === item.id ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Send</Text>
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
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      {sendResult?.ok ? (
        <View style={{
          backgroundColor: '#f0fdf4',
          borderRadius: 14,
          padding: 24,
          alignItems: 'center',
          width: '100%',
          marginBottom: 24,
        }}>
          <Text style={{ fontSize: 15, color: '#15803d', textAlign: 'center', lineHeight: 22 }}>
            {sendResult.message}
          </Text>
        </View>
      ) : (
        <View style={{
          backgroundColor: '#fef2f2',
          borderRadius: 14,
          padding: 24,
          alignItems: 'center',
          width: '100%',
          marginBottom: 24,
        }}>
          <Text style={{ fontSize: 15, color: '#b91c1c', textAlign: 'center', lineHeight: 22 }}>
            {sendResult?.message ?? ''}
          </Text>
        </View>
      )}
      <TouchableOpacity
        onPress={reset}
        style={{
          paddingHorizontal: 24,
          paddingVertical: 12,
          backgroundColor: '#1c1917',
          borderRadius: 12,
        }}
      >
        <Text style={{ color: '#fff', fontWeight: '500', fontSize: 14 }}>
          Send another recommendation
        </Text>
      </TouchableOpacity>
    </View>
  );
}
