import { SAGE_DEEP } from '../lib/tokens';
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
import { BackButton } from '../components/BackButton';
import { supabase } from '../lib/supabase';
import { CoverThumb } from '../components/CoverThumb';
import {
  type BookResult,
  searchBooks,
  resolveOLKeyFromIsbn,
} from '../lib/bookSearch';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'search' | 'confirm' | 'done';

type SelectedBook = {
  externalId: string | null;
  title: string;
  author: string;
  coverUrl: string | null;
  isManual: boolean;
  pageCount: number | null;
  editionKey: string | null;
  _source?: 'ol' | 'gb';
  _isbn13?: string;
  _isbn10?: string;
};

type BookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

// ─── Constants ────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();

const FINISH_YEAR_OPTIONS: { label: string; value: number | null }[] = [
  { label: `This year (${CURRENT_YEAR})`, value: CURRENT_YEAR },
  ...Array.from({ length: 9 }, (_, i) => ({
    label: `${CURRENT_YEAR - 1 - i}`,
    value: CURRENT_YEAR - 1 - i,
  })),
  { label: "I'm not sure", value: null },
];

const STATUS_OPTIONS: { value: BookStatus; label: string; desc: string; activeBg: string; activeText: string }[] = [
  { value: 'want_to_read', label: 'Want to Read', desc: 'Saving it for later',   activeBg: '#f1f5f9', activeText: '#475569' },
  { value: 'reading',      label: 'Reading',      desc: 'Currently in progress', activeBg: '#dbeafe', activeText: '#1d4ed8' },
  { value: 'finished',     label: 'Finished',     desc: 'Completed it',          activeBg: '#eaf1ea', activeText: SAGE_DEEP },
  { value: 'dnf',          label: 'DNF',          desc: 'Did not finish',        activeBg: '#fee2e2', activeText: '#b91c1c' },
];

function olCoverUrl(coverId?: number): string | null {
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function AddBookScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('search');

  const [query, setQuery] = useState('');
  const [bookResults, setBookResults] = useState<BookResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [weakQuery, setWeakQuery] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthor, setManualAuthor] = useState('');

  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null);
  const [chosenStatus, setChosenStatus] = useState<BookStatus>('want_to_read');

  const [finishYear, setFinishYear] = useState<number | null>(CURRENT_YEAR);

  const [saving, setSaving] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');
  const [doneIsError, setDoneIsError] = useState(false);

  // Stale-request guard: each search increments this; responses only committed
  // when the seq value at response time still matches the current value.
  const searchSeqRef = useRef(0);

  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // ── Hybrid search (debounced) ──────────────────────────────────────────────
  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      setBookResults([]);
      setNoResults(false);
      setWeakQuery(false);
      setSearching(false);
      return;
    }

    const mySeq = ++searchSeqRef.current;
    setSearching(true);
    setBookResults([]);
    setNoResults(false);
    setWeakQuery(false);

    const timer = setTimeout(async () => {
      try {
        // Stream the Google Books-only first batch into the UI as soon as it
        // arrives so the user sees results within a few hundred ms even if
        // an Open Library variant is slow. The full merged/scored result
        // overwrites this once the parallel pipeline finishes.
        const result = await searchBooks(trimmed, {
          onPartial: (partial) => {
            if (searchSeqRef.current !== mySeq) return;
            if (partial.results.length === 0) return;
            setBookResults(partial.results);
            setNoResults(false);
            setWeakQuery(false);
            // Hide the spinner the moment we have something useful to show;
            // the rest of the providers continue refining in the background.
            setSearching(false);
          },
        });

        // Discard stale response
        if (searchSeqRef.current !== mySeq) return;

        if (result.weakQuery) {
          setBookResults([]);
          setNoResults(false);
          setWeakQuery(true);
        } else if (result.noResults) {
          setBookResults([]);
          setNoResults(true);
          setWeakQuery(false);
        } else {
          setBookResults(result.results);
          setNoResults(false);
          setWeakQuery(false);
        }
      } catch {
        if (searchSeqRef.current !== mySeq) return;
        setBookResults([]);
        setNoResults(true);
      }
      setSearching(false);
    }, 400);

    return () => clearTimeout(timer);
  }, [query]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function selectBook(book: BookResult) {
    const editionKey = book.cover_edition_key ?? null;
    const coverUrl = book._gbCoverUrl
      ?? (editionKey ? `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg` : olCoverUrl(book.cover_i));
    const rawPages = book.number_of_pages_median;
    const pageCount = typeof rawPages === 'number' && rawPages >= 30 ? rawPages : null;
    setSelectedBook({
      externalId: book.key,
      title: book.title,
      author: book.author_name?.[0] ?? 'Unknown author',
      coverUrl,
      isManual: false,
      pageCount,
      editionKey,
      _source: book._source,
      _isbn13: book._isbn13,
      _isbn10: book._isbn10,
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
      pageCount: null,
      editionKey: null,
    });
    setStep('confirm');
  }

  async function handleSave() {
    if (!supabase || !userId || !selectedBook) return;
    setSaving(true);

    let bookId: string;
    let externalId = selectedBook.externalId;

    // If the book came from Google Books, attempt OL key resolution before saving.
    // This ensures the book gets a proper OL work key as its external_id.
    if (selectedBook._source === 'gb' && externalId?.startsWith('gb:')) {
      const fakeBookResult: BookResult = {
        key:     externalId,
        title:   selectedBook.title,
        _isbn13: selectedBook._isbn13,
        _isbn10: selectedBook._isbn10,
      };
      externalId = await resolveOLKeyFromIsbn(fakeBookResult);
    }

    if (externalId) {
      const { data: existing } = await supabase
        .from('books')
        .select('id, cover_url, page_count')
        .eq('external_id', externalId)
        .maybeSingle();

      if (existing) {
        bookId = existing.id;
        const updates: Record<string, unknown> = {};
        if (!existing.cover_url && selectedBook.coverUrl) updates.cover_url = selectedBook.coverUrl;
        if (!existing.page_count && selectedBook.pageCount) updates.page_count = selectedBook.pageCount;
        if (Object.keys(updates).length > 0) {
          await supabase.from('books').update(updates).eq('id', existing.id);
        }
      } else {
        const insertData: Record<string, unknown> = {
          title:       selectedBook.title,
          author:      selectedBook.author,
          external_id: externalId,
          cover_url:   selectedBook.coverUrl,
        };
        if (selectedBook.pageCount) insertData.page_count = selectedBook.pageCount;
        const { data: newBook, error } = await supabase
          .from('books')
          .insert(insertData)
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
          title:       selectedBook.title,
          author:      selectedBook.author,
          external_id: null,
          cover_url:   null,
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
      const label = STATUS_OPTIONS.find(o => o.value === existingUserBook.status)?.label ?? existingUserBook.status;
      setDoneMessage(`Already in your library — ${label}.`);
      setDoneIsError(false);
      setSaving(false);
      setStep('done');
      return;
    }

    const now = new Date().toISOString();
    const userBookData: Record<string, unknown> = { user_id: userId, book_id: bookId, status: chosenStatus };
    if (chosenStatus === 'reading') userBookData.started_at = now;
    if (chosenStatus === 'finished' || chosenStatus === 'dnf') {
      userBookData.started_at = now;
      if (chosenStatus === 'dnf') {
        userBookData.finished_at = now;
      } else {
        if (finishYear === null) {
          // No finished_at — unknown read date
        } else if (finishYear === CURRENT_YEAR) {
          userBookData.finished_at = now;
        } else {
          userBookData.finished_at = `${finishYear}-12-31T00:00:00.000Z`;
        }
      }
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
        actor_id:   userId,
        event_type: 'book_finished',
        book_id:    bookId,
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
    setBookResults([]);
    setNoResults(false);
    setWeakQuery(false);
    setShowManual(false);
    setManualTitle('');
    setManualAuthor('');
    setChosenStatus('want_to_read');
    setFinishYear(CURRENT_YEAR);
    setSelectedBook(null);
  }

  // ── Step: search ───────────────────────────────────────────────────────────

  if (step === 'search') {
    const trimmed = query.trim();
    const hasQuery = trimmed.length >= 2;

    return (
      <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
        {/* ── Header ── */}
        <View style={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 12 }}>
          <BackButton onPress={() => router.back()} style={{ marginBottom: 20 }} />
          <Text style={{
            fontSize: 28,
            fontWeight: '800',
            color: '#231f1b',
            letterSpacing: -0.5,
            marginBottom: 5,
          }}>
            Add to Library
          </Text>
          <Text style={{ fontSize: 14, color: '#9e958d', marginBottom: 14 }}>
            Find a book to track, or add one manually.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/import/goodreads')}
            style={{ marginBottom: 16 }}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 13, color: '#9e958d' }}>
              Already on Goodreads?{' '}
              <Text style={{ color: '#78716c', textDecorationLine: 'underline' }}>
                Import your whole library →
              </Text>
            </Text>
          </TouchableOpacity>
          <TextInput
            value={query}
            onChangeText={text => { setQuery(text); setShowManual(false); }}
            placeholder="Title, author, or keyword…"
            placeholderTextColor="#9e958d"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              backgroundColor: '#fefcf9',
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 15,
              color: '#231f1b',
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
          data={bookResults}
          keyExtractor={item => item.key}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const coverUrl = item._gbCoverUrl
              ?? (item.cover_edition_key
                ? `https://covers.openlibrary.org/b/olid/${item.cover_edition_key}-M.jpg`
                : olCoverUrl(item.cover_i));
            return (
              <TouchableOpacity
                onPress={() => selectBook(item)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 11,
                  borderBottomWidth: 1,
                  borderBottomColor: '#ede9e4',
                }}
              >
                <CoverThumb url={coverUrl} title={item.title} width={34} height={50} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b', lineHeight: 21 }}>
                    {item.title}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 2 }}>
                    {item.author_name?.[0] ?? 'Unknown author'}
                  </Text>
                </View>
                <Text style={{ fontSize: 20, color: '#ede9e4', marginLeft: 8 }}>›</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            !searching && hasQuery && noResults ? (
              <Text style={{ color: '#9e958d', fontSize: 14, paddingVertical: 10 }}>
                No results. Try a different title or add manually below.
              </Text>
            ) : !searching && hasQuery && weakQuery ? (
              <Text style={{ color: '#9e958d', fontSize: 14, paddingVertical: 10 }}>
                Keep typing…
              </Text>
            ) : !hasQuery && !showManual ? (
              <View style={{ paddingTop: 16 }}>
                <View style={{ alignItems: 'center', marginBottom: 20 }}>
                  <Text style={{
                    fontSize: 13,
                    color: '#9e958d',
                    lineHeight: 20,
                    textAlign: 'center',
                  }}>
                    Search millions of titles
                  </Text>
                </View>

                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: 20,
                }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: '#ede9e4' }} />
                  <Text style={{
                    fontSize: 12,
                    color: '#c4b5a5',
                    fontWeight: '500',
                    paddingHorizontal: 14,
                  }}>
                    or
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: '#ede9e4' }} />
                </View>

                <TouchableOpacity
                  onPress={() => setShowManual(true)}
                  style={{
                    backgroundColor: '#fefcf9',
                    borderRadius: 14,
                    paddingVertical: 18,
                    paddingHorizontal: 18,
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderWidth: 1,
                    borderColor: '#ede9e4',
                    shadowColor: '#000',
                    shadowOpacity: 0.03,
                    shadowRadius: 4,
                    shadowOffset: { width: 0, height: 1 },
                    elevation: 1,
                  }}
                >
                  <Text style={{ fontSize: 22, marginRight: 14 }}>✏️</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{
                      fontSize: 15,
                      fontWeight: '600',
                      color: '#231f1b',
                      marginBottom: 2,
                    }}>
                      Add manually
                    </Text>
                    <Text style={{ fontSize: 13, color: '#9e958d', lineHeight: 18 }}>
                      Enter the title and author yourself
                    </Text>
                  </View>
                  <Text style={{ fontSize: 20, color: '#ede9e4' }}>›</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
          ListFooterComponent={
            !searching && hasQuery && bookResults.length > 0 ? (
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

        {/* Manual entry form */}
        {showManual && (
          <View style={{
            marginHorizontal: 20,
            marginTop: 8,
            marginBottom: 24,
            backgroundColor: '#fefcf9',
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
              color: '#9e958d',
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
              placeholderTextColor="#9e958d"
              style={{
                borderBottomWidth: 1,
                borderBottomColor: '#ede9e4',
                paddingVertical: 10,
                fontSize: 15,
                color: '#231f1b',
                marginBottom: 12,
              }}
            />
            <TextInput
              value={manualAuthor}
              onChangeText={setManualAuthor}
              placeholder="Author (optional)"
              placeholderTextColor="#9e958d"
              style={{
                borderBottomWidth: 1,
                borderBottomColor: '#ede9e4',
                paddingVertical: 10,
                fontSize: 15,
                color: '#231f1b',
                marginBottom: 20,
              }}
            />
            <TouchableOpacity
              onPress={selectManual}
              disabled={!manualTitle.trim()}
              style={{
                backgroundColor: manualTitle.trim() ? '#231f1b' : '#ede9e4',
                borderRadius: 10,
                paddingVertical: 13,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: manualTitle.trim() ? '#fff' : '#9e958d',
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

  // ── Step: confirm ──────────────────────────────────────────────────────────

  if (step === 'confirm') {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#f5f1ec' }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <BackButton onPress={() => setStep('search')} label="Search" style={{ marginBottom: 22 }} />

        <Text style={{
          fontSize: 22,
          fontWeight: '800',
          color: '#231f1b',
          letterSpacing: -0.4,
          marginBottom: 4,
        }}>
          Add to Library
        </Text>
        <Text style={{ fontSize: 14, color: '#9e958d', marginBottom: 22 }}>
          Choose where this book fits in your reading.
        </Text>

        {/* Book preview card */}
        <View style={{
          backgroundColor: '#fefcf9',
          borderRadius: 14,
          padding: 16,
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 32,
          borderLeftWidth: 3,
          borderLeftColor: '#231f1b',
          shadowColor: '#000',
          shadowOpacity: 0.05,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        }}>
          <CoverThumb
            url={selectedBook?.coverUrl}
            externalId={selectedBook?.externalId}
            editionKey={selectedBook?.editionKey}
            title={selectedBook?.title}
            width={52}
            height={76}
          />
          <View style={{ flex: 1, marginLeft: 16 }}>
            <Text style={{
              fontSize: 16,
              fontWeight: '700',
              color: '#231f1b',
              lineHeight: 22,
              marginBottom: 4,
            }}>
              {selectedBook?.title}
            </Text>
            <Text style={{ fontSize: 14, color: '#78716c' }}>{selectedBook?.author}</Text>
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
          color: '#9e958d',
          letterSpacing: 0.9,
          textTransform: 'uppercase',
          marginBottom: 14,
        }}>
          Reading Status
        </Text>

        <View style={{ gap: 10, marginBottom: chosenStatus === 'finished' ? 24 : 40 }}>
          {STATUS_OPTIONS.map(opt => {
            const active = chosenStatus === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                onPress={() => setChosenStatus(opt.value)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: active ? opt.activeBg : '#fff',
                  borderRadius: 12,
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderWidth: 1.5,
                  borderColor: active ? opt.activeText : '#ede9e4',
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{
                    fontSize: 15,
                    fontWeight: '600',
                    color: active ? opt.activeText : '#231f1b',
                    marginBottom: 2,
                  }}>
                    {opt.label}
                  </Text>
                  <Text style={{ fontSize: 13, color: active ? opt.activeText : '#9e958d' }}>
                    {opt.desc}
                  </Text>
                </View>
                {active && (
                  <Text style={{ fontSize: 18, color: opt.activeText }}>✓</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Finish year picker (finished only) */}
        {chosenStatus === 'finished' && (
          <View style={{ marginBottom: 40 }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: '#9e958d',
              letterSpacing: 0.9,
              textTransform: 'uppercase',
              marginBottom: 14,
            }}>
              When did you finish it?
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {FINISH_YEAR_OPTIONS.map(opt => {
                  const active = finishYear === opt.value;
                  return (
                    <TouchableOpacity
                      key={String(opt.value)}
                      onPress={() => setFinishYear(opt.value)}
                      style={{
                        paddingVertical: 10,
                        paddingHorizontal: 16,
                        borderRadius: 10,
                        backgroundColor: active ? '#231f1b' : '#fff',
                        borderWidth: 1,
                        borderColor: active ? '#231f1b' : '#ede9e4',
                      }}
                    >
                      <Text style={{
                        fontSize: 14,
                        fontWeight: '500',
                        color: active ? '#fff' : '#78716c',
                      }}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}

        <TouchableOpacity
          onPress={handleSave}
          disabled={saving}
          style={{
            backgroundColor: saving ? '#ede9e4' : '#231f1b',
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: 'center',
          }}
        >
          <Text style={{
            color: saving ? '#9e958d' : '#fff',
            fontSize: 16,
            fontWeight: '700',
            letterSpacing: 0.2,
          }}>
            {saving ? 'Saving…' : 'Add to Library'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Step: done ─────────────────────────────────────────────────────────────

  return (
    <View style={{
      flex: 1,
      backgroundColor: '#f5f1ec',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    }}>
      <Text style={{
        fontSize: 48,
        marginBottom: 20,
      }}>
        {doneIsError ? '⚠️' : '📚'}
      </Text>
      <Text style={{
        fontSize: 20,
        fontWeight: '700',
        color: '#231f1b',
        textAlign: 'center',
        marginBottom: 10,
        letterSpacing: -0.3,
      }}>
        {doneIsError ? 'Something went wrong' : 'Added!'}
      </Text>
      <Text style={{
        fontSize: 15,
        color: '#78716c',
        textAlign: 'center',
        marginBottom: 36,
        lineHeight: 22,
      }}>
        {doneMessage}
      </Text>

      {!doneIsError && (
        <TouchableOpacity
          onPress={resetAndAddAnother}
          style={{
            backgroundColor: '#fefcf9',
            borderRadius: 12,
            paddingVertical: 13,
            paddingHorizontal: 28,
            borderWidth: 1,
            borderColor: '#ede9e4',
            marginBottom: 16,
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b' }}>
            Add another book
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        onPress={() => router.back()}
        style={{
          paddingVertical: 13,
          paddingHorizontal: 28,
        }}
      >
        <Text style={{ fontSize: 15, color: '#78716c' }}>
          {doneIsError ? 'Go back' : 'Done'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
