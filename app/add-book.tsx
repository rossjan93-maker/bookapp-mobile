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
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { CoverThumb } from '../components/CoverThumb';

type Step = 'search' | 'confirm' | 'done';

type OLBook = {
  key: string;
  title: string;
  author_name?: string[];
  cover_i?: number;
};

type SelectedBook = {
  externalId: string | null;
  title: string;
  author: string;
  coverUrl: string | null;
  isManual: boolean;
};

type BookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

const STATUS_OPTIONS: { value: BookStatus; label: string; activeBg: string; activeText: string }[] = [
  { value: 'want_to_read', label: 'Want to Read', activeBg: '#f1f5f9', activeText: '#475569' },
  { value: 'reading',      label: 'Reading',      activeBg: '#dbeafe', activeText: '#1d4ed8' },
  { value: 'finished',     label: 'Finished',     activeBg: '#dcfce7', activeText: '#15803d' },
  { value: 'dnf',          label: 'DNF',          activeBg: '#fee2e2', activeText: '#b91c1c' },
];

function olCoverUrl(coverId?: number): string | null {
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
}

export default function AddBookScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('search');

  const [query, setQuery] = useState('');
  const [olResults, setOlResults] = useState<OLBook[]>([]);
  const [searching, setSearching] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthor, setManualAuthor] = useState('');

  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null);
  const [chosenStatus, setChosenStatus] = useState<BookStatus>('want_to_read');

  const [saving, setSaving] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');
  const [doneIsError, setDoneIsError] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setOlResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `https://openlibrary.org/search.json?q=${encodeURIComponent(trimmed)}&fields=key,title,author_name,cover_i&limit=15`
        );
        const json = await res.json();
        setOlResults(json.docs ?? []);
      } catch {
        setOlResults([]);
      }
      setSearching(false);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function selectOLBook(book: OLBook) {
    setSelectedBook({
      externalId: book.key,
      title: book.title,
      author: book.author_name?.[0] ?? 'Unknown author',
      coverUrl: olCoverUrl(book.cover_i),
      isManual: false,
    });
    setStep('confirm');
  }

  function selectManual() {
    if (!manualTitle.trim()) return;
    setSelectedBook({
      externalId: null,
      title: manualTitle.trim(),
      author: manualAuthor.trim() || 'Unknown author',
      coverUrl: null,
      isManual: true,
    });
    setStep('confirm');
  }

  async function handleSave() {
    if (!supabase || !userId || !selectedBook) return;
    setSaving(true);

    let bookId: string;

    if (selectedBook.externalId) {
      const { data: existing } = await supabase
        .from('books')
        .select('id, cover_url')
        .eq('external_id', selectedBook.externalId)
        .maybeSingle();

      if (existing) {
        bookId = existing.id;
        if (!existing.cover_url && selectedBook.coverUrl) {
          await supabase
            .from('books')
            .update({ cover_url: selectedBook.coverUrl })
            .eq('id', existing.id);
        }
      } else {
        const { data: newBook, error } = await supabase
          .from('books')
          .insert({
            title: selectedBook.title,
            author: selectedBook.author,
            external_id: selectedBook.externalId,
            cover_url: selectedBook.coverUrl,
          })
          .select('id')
          .single();

        if (error || !newBook) {
          setDoneMessage('Could not save book. Please try again.');
          setDoneIsError(true);
          setSaving(false);
          setStep('done');
          return;
        }
        bookId = newBook.id;
      }
    } else {
      const { data: newBook, error } = await supabase
        .from('books')
        .insert({
          title: selectedBook.title,
          author: selectedBook.author,
          external_id: null,
          cover_url: null,
        })
        .select('id')
        .single();

      if (error || !newBook) {
        setDoneMessage('Could not save book. Please try again.');
        setDoneIsError(true);
        setSaving(false);
        setStep('done');
        return;
      }
      bookId = newBook.id;
    }

    const { data: existingUserBook } = await supabase
      .from('user_books')
      .select('id, status')
      .eq('user_id', userId)
      .eq('book_id', bookId)
      .maybeSingle();

    if (existingUserBook) {
      const label = STATUS_OPTIONS.find(o => o.value === existingUserBook.status)?.label
        ?? existingUserBook.status;
      setDoneMessage(`Already in your library — ${label}.`);
      setDoneIsError(false);
      setSaving(false);
      setStep('done');
      return;
    }

    const now = new Date().toISOString();
    const userBookData: Record<string, unknown> = {
      user_id: userId,
      book_id: bookId,
      status: chosenStatus,
    };
    if (chosenStatus === 'reading') {
      userBookData.started_at = now;
    }
    if (chosenStatus === 'finished' || chosenStatus === 'dnf') {
      userBookData.started_at = now;
      userBookData.finished_at = now;
    }

    const { error: ubError } = await supabase.from('user_books').insert(userBookData);
    if (ubError) {
      setDoneMessage('Could not add to library. Please try again.');
      setDoneIsError(true);
      setSaving(false);
      setStep('done');
      return;
    }

    if (chosenStatus === 'finished') {
      await supabase.from('activity_events').insert({
        actor_id: userId,
        event_type: 'book_finished',
        book_id: bookId,
      });
    }

    setDoneMessage(`"${selectedBook.title}" added to your library.`);
    setDoneIsError(false);
    setSaving(false);
    setStep('done');
  }

  function resetAndAddAnother() {
    setStep('search');
    setQuery('');
    setOlResults([]);
    setShowManual(false);
    setManualTitle('');
    setManualAuthor('');
    setChosenStatus('want_to_read');
    setSelectedBook(null);
  }

  if (step === 'search') {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7' }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16 }}>
          <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 20 }}>
            <Text style={{ fontSize: 14, color: '#78716c' }}>← Back</Text>
          </TouchableOpacity>
          <Text style={{
            fontSize: 28,
            fontWeight: '800',
            color: '#1c1917',
            letterSpacing: -0.5,
            marginBottom: 4,
          }}>
            Add to Library
          </Text>
          <Text style={{ fontSize: 14, color: '#a8a29e', marginBottom: 20 }}>
            Search for a book, or add it manually.
          </Text>
          <TextInput
            value={query}
            onChangeText={text => { setQuery(text); setShowManual(false); }}
            placeholder="Title, author, or keyword…"
            placeholderTextColor="#a8a29e"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              backgroundColor: '#fff',
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 15,
              color: '#1c1917',
              shadowColor: '#000',
              shadowOpacity: 0.05,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          />
        </View>

        {searching && (
          <ActivityIndicator color="#78716c" style={{ marginTop: 4, marginBottom: 4 }} />
        )}

        <FlatList
          data={olResults}
          keyExtractor={item => item.key}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => selectOLBook(item)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 11,
                borderBottomWidth: 1,
                borderBottomColor: '#f5f5f4',
              }}
            >
              <CoverThumb url={olCoverUrl(item.cover_i)} width={34} height={50} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917', lineHeight: 21 }}>
                  {item.title}
                </Text>
                <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 2 }}>
                  {item.author_name?.[0] ?? 'Unknown author'}
                </Text>
              </View>
              <Text style={{ fontSize: 20, color: '#d6d3d1', marginLeft: 8 }}>›</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            !searching && query.trim().length >= 2 ? (
              <Text style={{ color: '#a8a29e', fontSize: 14, paddingVertical: 10 }}>
                No results. Try a different title or add manually.
              </Text>
            ) : null
          }
          ListFooterComponent={
            !searching && query.trim().length >= 2 && olResults.length > 0 ? (
              <TouchableOpacity
                onPress={() => setShowManual(v => !v)}
                style={{ paddingVertical: 16, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 14, color: '#78716c', textDecorationLine: 'underline' }}>
                  {showManual ? 'Hide manual entry' : "Can't find it? Add manually"}
                </Text>
              </TouchableOpacity>
            ) : null
          }
        />

        {/* Manual entry CTA when no query */}
        {query.trim().length < 2 && !showManual && (
          <View style={{ paddingHorizontal: 20 }}>
            <TouchableOpacity
              onPress={() => setShowManual(true)}
              style={{
                borderWidth: 1.5,
                borderColor: '#e7e5e4',
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: 'center',
                backgroundColor: '#fff',
              }}
            >
              <Text style={{ fontSize: 14, color: '#57534e', fontWeight: '500' }}>
                Add a book manually
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Manual entry form */}
        {showManual && (
          <View style={{
            marginHorizontal: 20,
            marginTop: 8,
            marginBottom: 24,
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: '#a8a29e',
              letterSpacing: 0.9,
              textTransform: 'uppercase',
              marginBottom: 16,
            }}>
              Manual Entry
            </Text>
            <TextInput
              value={manualTitle}
              onChangeText={setManualTitle}
              placeholder="Book title *"
              placeholderTextColor="#a8a29e"
              style={{
                borderBottomWidth: 1,
                borderBottomColor: '#f5f5f4',
                paddingVertical: 10,
                fontSize: 15,
                color: '#1c1917',
                marginBottom: 12,
              }}
            />
            <TextInput
              value={manualAuthor}
              onChangeText={setManualAuthor}
              placeholder="Author (optional)"
              placeholderTextColor="#a8a29e"
              style={{
                borderBottomWidth: 1,
                borderBottomColor: '#f5f5f4',
                paddingVertical: 10,
                fontSize: 15,
                color: '#1c1917',
                marginBottom: 20,
              }}
            />
            <TouchableOpacity
              onPress={selectManual}
              disabled={!manualTitle.trim()}
              style={{
                backgroundColor: manualTitle.trim() ? '#1c1917' : '#e7e5e4',
                borderRadius: 10,
                paddingVertical: 13,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: manualTitle.trim() ? '#fff' : '#a8a29e',
                fontSize: 14,
                fontWeight: '600',
              }}>
                Continue
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  if (step === 'confirm') {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#faf9f7' }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <TouchableOpacity onPress={() => setStep('search')} style={{ marginBottom: 24 }}>
          <Text style={{ fontSize: 14, color: '#78716c' }}>← Back to search</Text>
        </TouchableOpacity>

        {/* Book preview card */}
        <View style={{
          backgroundColor: '#fff',
          borderRadius: 14,
          padding: 16,
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 36,
          shadowColor: '#000',
          shadowOpacity: 0.05,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        }}>
          <CoverThumb
            url={selectedBook?.coverUrl}
            externalId={selectedBook?.externalId}
            width={52}
            height={76}
          />
          <View style={{ flex: 1, marginLeft: 16 }}>
            <Text style={{
              fontSize: 16,
              fontWeight: '700',
              color: '#1c1917',
              lineHeight: 22,
              marginBottom: 4,
            }}>
              {selectedBook?.title}
            </Text>
            <Text style={{ fontSize: 14, color: '#9ca3af' }}>{selectedBook?.author}</Text>
            {selectedBook?.isManual && (
              <View style={{
                backgroundColor: '#fef3c7',
                borderRadius: 5,
                paddingHorizontal: 7,
                paddingVertical: 2,
                alignSelf: 'flex-start',
                marginTop: 7,
              }}>
                <Text style={{ fontSize: 11, color: '#92400e', fontWeight: '500' }}>Manual entry</Text>
              </View>
            )}
          </View>
        </View>

        {/* Status picker */}
        <Text style={{
          fontSize: 11,
          fontWeight: '700',
          color: '#9ca3af',
          letterSpacing: 0.9,
          textTransform: 'uppercase',
          marginBottom: 14,
        }}>
          Reading Status
        </Text>

        <View style={{ gap: 10, marginBottom: 40 }}>
          {STATUS_OPTIONS.map(opt => {
            const active = chosenStatus === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                onPress={() => setChosenStatus(opt.value)}
                style={{
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: active ? opt.activeBg : '#fff',
                  borderWidth: active ? 1.5 : 1,
                  borderColor: active ? opt.activeText : '#e7e5e4',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text style={{
                  fontSize: 15,
                  fontWeight: active ? '700' : '400',
                  color: active ? opt.activeText : '#78716c',
                }}>
                  {opt.label}
                </Text>
                {active && (
                  <View style={{
                    width: 18,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: opt.activeText,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>✓</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          onPress={handleSave}
          disabled={saving}
          style={{
            backgroundColor: saving ? '#d6d3d1' : '#1c1917',
            borderRadius: 13,
            paddingVertical: 16,
            alignItems: 'center',
          }}
        >
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Add to Library</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <View style={{
      flex: 1,
      backgroundColor: '#faf9f7',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
    }}>
      <View style={{
        backgroundColor: doneIsError ? '#fef2f2' : '#f0fdf4',
        borderRadius: 16,
        padding: 28,
        alignItems: 'center',
        width: '100%',
        marginBottom: 24,
      }}>
        <Text style={{
          fontSize: 15,
          color: doneIsError ? '#b91c1c' : '#15803d',
          textAlign: 'center',
          lineHeight: 24,
          fontWeight: '500',
        }}>
          {doneMessage}
        </Text>
      </View>

      <TouchableOpacity
        onPress={() => router.back()}
        style={{
          backgroundColor: '#1c1917',
          borderRadius: 12,
          paddingVertical: 14,
          paddingHorizontal: 30,
          marginBottom: 14,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Back to Library</Text>
      </TouchableOpacity>

      {!doneIsError && (
        <TouchableOpacity onPress={resetAndAddAnother}>
          <Text style={{ fontSize: 14, color: '#78716c', textDecorationLine: 'underline' }}>
            Add another book
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
