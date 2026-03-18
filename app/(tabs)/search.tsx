import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
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
import { computeTasteProfile } from '../../lib/tasteProfile';
import type { TasteProfile } from '../../lib/tasteProfile';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'hub' | 'search' | 'friends' | 'done';

type BookResult = {
  key: string;
  title: string;
  author_name?: string[];
  cover_i?: number;
  cover_edition_key?: string;
  number_of_pages_median?: number;
};

type SelectedBook = {
  externalId: string;
  title: string;
  author: string;
  coverUrl: string | null;
  pageCount: number | null;
  editionKey: string | null;
};

type Friend = {
  id: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
};

type BookToRate = {
  id: string;
  book_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  external_id: string | null;
};

type BookToTag = {
  id: string;
  book_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  external_id: string | null;
};

type IncomingRec = {
  id: string;
  status: string;
  book_id: string;
  note: string | null;
  sender: { username: string; first_name: string | null; last_name: string | null } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

type SentRec = {
  id: string;
  status: string;
  created_at: string;
  note: string | null;
  to_user: { username: string; first_name: string | null; last_name: string | null } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function olCoverUrl(coverId?: number, size: 'S' | 'M' = 'M'): string | null {
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
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

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    sent:     { bg: '#f1f5f9', text: '#475569', label: 'New'          },
    saved:    { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read' },
    started:  { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'      },
    finished: { bg: '#dcfce7', text: '#15803d', label: 'Finished'     },
    dnf:      { bg: '#fee2e2', text: '#b91c1c', label: 'DNF'          },
  };
  const s = map[status];
  if (!s) return null;
  return (
    <View style={{ backgroundColor: s.bg, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ fontSize: 10, fontWeight: '600', color: s.text }}>{s.label}</Text>
    </View>
  );
}

// ─── Tag constants ────────────────────────────────────────────────────────────

const TASTE_TAGS = [
  'Pacing', 'Characters', 'Plot', 'Worldbuilding', 'Writing',
  'Emotional', 'Romance', 'Suspense', 'Ending', 'Originality',
] as const;

// ─── TagPanel — shared chip renderer for both groups ─────────────────────────

function TagPanel({
  likedTags,
  dislikedTags,
  onLikedChange,
  onDislikedChange,
}: {
  likedTags: string[];
  dislikedTags: string[];
  onLikedChange: (tags: string[]) => void;
  onDislikedChange: (tags: string[]) => void;
}) {
  function toggle(tag: string, group: 'liked' | 'disliked') {
    if (group === 'liked') {
      const sel = likedTags.includes(tag);
      onLikedChange(sel ? likedTags.filter(t => t !== tag) : [...likedTags, tag]);
      onDislikedChange(dislikedTags.filter(t => t !== tag));
    } else {
      const sel = dislikedTags.includes(tag);
      onDislikedChange(sel ? dislikedTags.filter(t => t !== tag) : [...dislikedTags, tag]);
      onLikedChange(likedTags.filter(t => t !== tag));
    }
  }

  return (
    <>
      {(['Loved about it', "Didn't land"] as const).map(groupLabel => {
        const isLiked  = groupLabel === 'Loved about it';
        const selected = isLiked ? likedTags : dislikedTags;
        return (
          <View key={groupLabel} style={{ marginBottom: 14 }}>
            <Text style={{
              fontSize: 11, fontWeight: '700', color: '#a8a29e',
              letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8,
            }}>
              {groupLabel}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {TASTE_TAGS.map(tag => {
                const isSel = selected.includes(tag);
                return (
                  <TouchableOpacity
                    key={tag}
                    onPress={() => toggle(tag, isLiked ? 'liked' : 'disliked')}
                    style={{
                      paddingHorizontal: 11,
                      paddingVertical: 6,
                      borderRadius: 20,
                      backgroundColor: isSel ? '#1c1917' : '#f5f5f4',
                      borderWidth: 1,
                      borderColor: isSel ? '#1c1917' : '#e7e5e4',
                    }}
                  >
                    <Text style={{ fontSize: 12, color: isSel ? '#fff' : '#57534e', fontWeight: isSel ? '600' : '400' }}>
                      {tag}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        );
      })}
    </>
  );
}

// ─── RateCard — inline star rating + tag transition ───────────────────────────

type RateCardProps = { book: BookToRate; onComplete: (id: string) => void };

function RateCard({ book, onComplete }: RateCardProps) {
  const [mode, setMode]                   = useState<'rate' | 'tagging'>('rate');
  const [pendingRating, setPendingRating] = useState(0);
  const [saving, setSaving]               = useState(false);
  const [likedTags, setLikedTags]         = useState<string[]>([]);
  const [dislikedTags, setDislikedTags]   = useState<string[]>([]);
  const [savingTags, setSavingTags]       = useState(false);

  async function handleRate(star: number) {
    if (!supabase || saving) return;
    setSaving(true);
    setPendingRating(star);
    const { error } = await supabase
      .from('user_books')
      .update({ rating: star })
      .eq('id', book.id);
    setSaving(false);
    if (!error) setMode('tagging');
  }

  async function handleSaveTags() {
    if (!supabase || savingTags) return;
    setSavingTags(true);
    if (likedTags.length > 0 || dislikedTags.length > 0) {
      await supabase
        .from('user_books')
        .update({ taste_tags: { liked: likedTags, didnt_work: dislikedTags } })
        .eq('id', book.id);
    }
    setSavingTags(false);
    onComplete(book.id);
  }

  const card = {
    backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' as const,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 }, elevation: 1,
  };

  if (mode === 'rate') {
    return (
      <View style={card}>
        <View style={{ padding: 12, flexDirection: 'row', alignItems: 'center' }}>
          <CoverThumb url={book.cover_url} externalId={book.external_id} title={book.title} width={36} height={52} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 2 }} numberOfLines={1}>
              {book.title}
            </Text>
            <Text style={{ fontSize: 12, color: '#a8a29e', marginBottom: 8 }} numberOfLines={1}>
              {book.author}
            </Text>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {[1, 2, 3, 4, 5].map(star => (
                <TouchableOpacity
                  key={star}
                  onPress={() => handleRate(star)}
                  disabled={saving}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                >
                  <Text style={{ fontSize: 24, color: star <= pendingRating ? '#f59e0b' : '#d6d3d1' }}>★</Text>
                </TouchableOpacity>
              ))}
              {saving && <ActivityIndicator size="small" color="#78716c" style={{ marginLeft: 6, alignSelf: 'center' }} />}
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={card}>
      <View style={{ padding: 12, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#f5f5f4' }}>
        <CoverThumb url={book.cover_url} externalId={book.external_id} title={book.title} width={36} height={52} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>{book.title}</Text>
          <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 2 }} numberOfLines={1}>{book.author}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 1 }}>
          {[1, 2, 3, 4, 5].map(star => (
            <Text key={star} style={{ fontSize: 14, color: star <= pendingRating ? '#f59e0b' : '#e7e5e4' }}>★</Text>
          ))}
        </View>
      </View>
      <View style={{ padding: 14 }}>
        <Text style={{ fontSize: 12, color: '#78716c', marginBottom: 12 }}>
          Any tags for this one? (optional)
        </Text>
        <TagPanel
          likedTags={likedTags}
          dislikedTags={dislikedTags}
          onLikedChange={setLikedTags}
          onDislikedChange={setDislikedTags}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <TouchableOpacity
            onPress={() => onComplete(book.id)}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#e7e5e4', alignItems: 'center' }}
          >
            <Text style={{ fontSize: 13, color: '#78716c' }}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleSaveTags}
            disabled={savingTags}
            style={{ flex: 2, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1c1917', alignItems: 'center' }}
          >
            {savingTags
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Save tags</Text>
            }
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── TagCard — expandable inline tag editor ───────────────────────────────────

type TagCardProps = { book: BookToTag; onComplete: (id: string) => void };

function TagCard({ book, onComplete }: TagCardProps) {
  const [expanded, setExpanded]         = useState(false);
  const [likedTags, setLikedTags]       = useState<string[]>([]);
  const [dislikedTags, setDislikedTags] = useState<string[]>([]);
  const [saving, setSaving]             = useState(false);

  async function handleDone() {
    if (!supabase || saving) return;
    setSaving(true);
    await supabase
      .from('user_books')
      .update({ taste_tags: { liked: likedTags, didnt_work: dislikedTags } })
      .eq('id', book.id);
    setSaving(false);
    onComplete(book.id);
  }

  const card = {
    backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' as const,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 }, elevation: 1,
  };

  return (
    <View style={card}>
      <TouchableOpacity
        onPress={() => setExpanded(e => !e)}
        activeOpacity={0.75}
        style={{ padding: 12, flexDirection: 'row', alignItems: 'center' }}
      >
        <CoverThumb url={book.cover_url} externalId={book.external_id} title={book.title} width={36} height={52} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>{book.title}</Text>
          <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 2 }} numberOfLines={1}>{book.author}</Text>
        </View>
        <Text style={{ fontSize: 13, color: '#a8a29e', marginLeft: 8 }}>
          {expanded ? '▲' : '◎ Tag'}
        </Text>
      </TouchableOpacity>

      {expanded && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: '#f5f5f4' }}>
          <View style={{ height: 12 }} />
          <TagPanel
            likedTags={likedTags}
            dislikedTags={dislikedTags}
            onLikedChange={setLikedTags}
            onDislikedChange={setDislikedTags}
          />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <TouchableOpacity
              onPress={() => setExpanded(false)}
              style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#e7e5e4', alignItems: 'center' }}
            >
              <Text style={{ fontSize: 13, color: '#78716c' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleDone}
              disabled={saving}
              style={{ flex: 2, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1c1917', alignItems: 'center' }}
            >
              {saving
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Save tags</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RecommendationsScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('hub');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // ── Hub state ──────────────────────────────────────────────────────────────
  const [hubLoading, setHubLoading]       = useState(true);
  const [booksToRate, setBooksToRate]     = useState<BookToRate[]>([]);
  const [booksToTag, setBooksToTag]       = useState<BookToTag[]>([]);
  const [incomingRecs, setIncomingRecs]   = useState<IncomingRec[]>([]);
  const [sentRecs, setSentRecs]           = useState<SentRec[]>([]);
  const [tasteProfile, setTasteProfile]   = useState<TasteProfile | null>(null);

  // ── Search/send flow state ────────────────────────────────────────────────
  const [query, setQuery]               = useState('');
  const [bookResults, setBookResults]   = useState<BookResult[]>([]);
  const [searching, setSearching]       = useState(false);
  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null);
  const [note, setNote]                 = useState('');
  const [friends, setFriends]           = useState<Friend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [sendingTo, setSendingTo]       = useState<string | null>(null);
  const [sendResult, setSendResult]     = useState<{ ok: boolean; message: string } | null>(null);

  // Reload hub whenever screen comes into focus
  useFocusEffect(useCallback(() => {
    if (step === 'hub') loadHub();
  }, [step]));

  // Book search debounce (only relevant in 'search' step)
  useEffect(() => {
    if (step !== 'search') return;
    if (query.length < 2) { setBookResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name,cover_i,cover_edition_key,number_of_pages_median&limit=10`
        );
        const json = await res.json();
        setBookResults(json.docs ?? []);
      } catch {
        setBookResults([]);
      }
      setSearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [query, step]);

  // ── Hub data loader ───────────────────────────────────────────────────────

  async function loadHub() {
    if (!supabase) { setHubLoading(false); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setHubLoading(false); return; }
    setCurrentUserId(user.id);
    setHubLoading(true);

    const [rateRes, tagRes, incomingRes, sentRes, tp] = await Promise.all([
      // Finished books with no rating (rate these)
      supabase
        .from('user_books')
        .select('id, book_id, book:books(title, author, cover_url, external_id)')
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .is('rating', null),

      // Finished books WITH rating, may still lack taste_tags (client-filtered below)
      supabase
        .from('user_books')
        .select('id, book_id, taste_tags, book:books(title, author, cover_url, external_id)')
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .not('rating', 'is', null),

      // Incoming recommendations — preview (3 most recent)
      supabase
        .from('recommendations')
        .select(
          'id, status, book_id, note, ' +
          'sender:profiles!recommendations_from_user_id_fkey(username, first_name, last_name), ' +
          'book:books(title, author, cover_url, external_id)'
        )
        .eq('to_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(3),

      // Sent recommendations — preview (3 most recent)
      supabase
        .from('recommendations')
        .select(
          'id, status, created_at, note, ' +
          'to_user:profiles!recommendations_to_user_id_fkey(username, first_name, last_name), ' +
          'book:books(title, author, cover_url, external_id)'
        )
        .eq('from_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(3),

      // Taste profile for confidence tier
      computeTasteProfile(supabase!, user.id).catch(() => null),
    ]);

    // ── Type for Supabase row with a many-to-one book join ───────────────────
    // Supabase returns FK many-to-one joins as a SINGLE OBJECT, not an array.
    // Accessing r.book?.[0] would always be undefined. Use r.book?.field instead.
    type RateRow = {
      id: string;
      book_id: string;
      book: { title: string; author: string; cover_url: string | null; external_id: string | null } | null;
    };
    type TagRow = {
      id: string;
      book_id: string;
      taste_tags: { liked?: string[]; didnt_work?: string[] } | null;
      book: { title: string; author: string; cover_url: string | null; external_id: string | null } | null;
    };

    // Books to rate: finished, no rating (server-side filter: rating IS NULL)
    const toRate: BookToRate[] = ((rateRes.data ?? []) as unknown as RateRow[]).map(r => {
      const entry: BookToRate = {
        id:          r.id,
        book_id:     r.book_id,
        title:       r.book?.title       ?? '',
        author:      r.book?.author      ?? '',
        cover_url:   r.book?.cover_url   ?? null,
        external_id: r.book?.external_id ?? null,
      };
      console.log('[rate] candidate:', entry.id, entry.title, '→ included');
      return entry;
    });

    // Books to tag: finished + rated (server-side). Client-filter: only where
    // taste_tags is null, undefined, or both liked[] and didnt_work[] are empty.
    // A book cannot appear in both lists — server filters are mutually exclusive.
    const toTag: BookToTag[] = ((tagRes.data ?? []) as unknown as TagRow[])
      .filter(r => {
        const tt = r.taste_tags;
        const liked    = (tt?.liked      ?? []) as string[];
        const disliked = (tt?.didnt_work ?? []) as string[];
        const include  = liked.length === 0 && disliked.length === 0;
        console.log(
          '[tag] candidate:', r.id, r.book?.title,
          '| taste_tags:', JSON.stringify(tt),
          '| liked:', liked.length, '| disliked:', disliked.length,
          '→', include ? 'INCLUDED' : 'EXCLUDED'
        );
        return include;
      })
      .map(r => ({
        id:          r.id,
        book_id:     r.book_id,
        title:       r.book?.title       ?? '',
        author:      r.book?.author      ?? '',
        cover_url:   r.book?.cover_url   ?? null,
        external_id: r.book?.external_id ?? null,
      }));

    setBooksToRate(toRate);
    setBooksToTag(toTag);
    setIncomingRecs((incomingRes.data as unknown as IncomingRec[]) ?? []);
    setSentRecs((sentRes.data as unknown as SentRec[]) ?? []);
    setTasteProfile(tp);
    setHubLoading(false);
  }

  // ── Hub completion handlers ───────────────────────────────────────────────

  function handleRateComplete(id: string) {
    setBooksToRate(prev => prev.filter(b => b.id !== id));
  }

  function handleTagComplete(id: string) {
    setBooksToTag(prev => prev.filter(b => b.id !== id));
  }

  // ── Send flow handlers (logic unchanged) ─────────────────────────────────

  async function handleSelectBook(book: BookResult) {
    if (!supabase || !currentUserId) return;
    const editionKey = book.cover_edition_key ?? null;
    const coverUrl = editionKey
      ? `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg`
      : olCoverUrl(book.cover_i, 'M');
    const rawPages = book.number_of_pages_median;
    const pageCount = typeof rawPages === 'number' && rawPages >= 30 ? rawPages : null;
    const selected: SelectedBook = {
      externalId: book.key,
      title: book.title,
      author: book.author_name?.[0] ?? 'Unknown author',
      coverUrl,
      pageCount,
      editionKey,
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
      .select('id, cover_url, page_count')
      .eq('external_id', selectedBook.externalId)
      .maybeSingle();

    let bookId: string;

    if (existingBook) {
      bookId = existingBook.id;
      const updates: Record<string, unknown> = {};
      if (!existingBook.cover_url && selectedBook.coverUrl) updates.cover_url = selectedBook.coverUrl;
      if (!existingBook.page_count && selectedBook.pageCount) updates.page_count = selectedBook.pageCount;
      if (Object.keys(updates).length > 0) {
        await supabase.from('books').update(updates).eq('id', existingBook.id);
      }
    } else {
      const insertData: Record<string, unknown> = {
        title:       selectedBook.title,
        author:      selectedBook.author,
        external_id: selectedBook.externalId,
        cover_url:   selectedBook.coverUrl ?? null,
      };
      if (selectedBook.pageCount) insertData.page_count = selectedBook.pageCount;
      const { data: newBook, error: bookInsertError } = await supabase
        .from('books')
        .insert(insertData)
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
        to_user_id:   friend.id,
        book_id:      bookId,
        status:       'sent',
        note:         note.trim() || null,
      })
      .select('id')
      .single();

    setSendingTo(null);
    setStep('done');

    if (recError || !newRec) {
      setSendResult({
        ok: false,
        message: recError ? `Could not send: ${recError.message}` : 'Could not send. Try again.',
      });
    } else {
      await supabase.from('activity_events').insert({
        actor_id:          currentUserId,
        event_type:        'recommendation_sent',
        book_id:           bookId,
        recommendation_id: newRec.id,
      });
      setSendResult({
        ok:      true,
        message: `"${selectedBook.title}" sent to ${getFirstName(friend)}.`,
      });
    }
  }

  function reset() {
    setStep('hub');
    setQuery('');
    setBookResults([]);
    setSelectedBook(null);
    setNote('');
    setFriends([]);
    setSendResult(null);
    setSendingTo(null);
  }

  // ── Step: hub ─────────────────────────────────────────────────────────────

  if (step === 'hub') {
    const hasRateTasks    = booksToRate.length > 0;
    const hasTagTasks     = booksToTag.length > 0;
    const hasImport       = (tasteProfile?.evidence.imported_books_count ?? 0) === 0;
    const hasAnyTask      = hasRateTasks || hasTagTasks || hasImport;

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#faf9f7' }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 48 }}
      >
        {/* ── Header ── */}
        <Text style={{
          fontSize: 28,
          fontWeight: '800',
          color: '#1c1917',
          letterSpacing: -0.5,
          lineHeight: 34,
          marginBottom: 28,
        }}>
          Recommendations
        </Text>

        {hubLoading ? (
          <ActivityIndicator color="#78716c" style={{ marginTop: 32 }} />
        ) : (
          <>
            {/* ════════════════════════════════════════════════════════
                Section 1 — For You
            ════════════════════════════════════════════════════════ */}
            <View style={{ marginBottom: 36 }}>
              <SectionLabel>For You</SectionLabel>

              {/* If we have no tasks, show clean "caught up" state */}
              {!hasAnyTask ? (
                <View style={{
                  backgroundColor: '#fff',
                  borderRadius: 14,
                  padding: 20,
                  alignItems: 'center',
                  shadowColor: '#000',
                  shadowOpacity: 0.04,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 1 },
                  elevation: 1,
                }}>
                  <Text style={{ fontSize: 22, marginBottom: 12 }}>✓</Text>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
                    You're caught up
                  </Text>
                  <Text style={{ fontSize: 13, color: '#a8a29e', textAlign: 'center', lineHeight: 20 }}>
                    We'll keep learning as you finish and rate more books.
                  </Text>
                </View>
              ) : (
                <>
                  {/* ── Rate a finished book ── */}
                  {hasRateTasks && (
                    <View style={{ marginBottom: 16 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1 }}>
                          Rate a finished book
                        </Text>
                        <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                          {booksToRate.length} book{booksToRate.length !== 1 ? 's' : ''}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 12, color: '#78716c', marginBottom: 12 }}>
                        Ratings are our strongest signal for learning your taste.
                      </Text>
                      <View style={{ gap: 8 }}>
                        {booksToRate.slice(0, 3).map(b => (
                          <RateCard key={b.id} book={b} onComplete={handleRateComplete} />
                        ))}
                        {booksToRate.length > 3 && (
                          <TouchableOpacity onPress={() => router.push('/(tabs)/library')}>
                            <Text style={{ fontSize: 13, color: '#78716c', paddingVertical: 6 }}>
                              +{booksToRate.length - 3} more in Library →
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  )}

                  {/* ── Add taste tags ── */}
                  {hasTagTasks && (
                    <View style={{ marginBottom: 16 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1 }}>
                          Add taste tags
                        </Text>
                        <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                          {booksToTag.length} book{booksToTag.length !== 1 ? 's' : ''}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 12, color: '#78716c', marginBottom: 12 }}>
                        Tag what stood out — pacing, characters, originality, and more.
                      </Text>
                      <View style={{ gap: 8 }}>
                        {booksToTag.slice(0, 3).map(b => (
                          <TagCard key={b.id} book={b} onComplete={handleTagComplete} />
                        ))}
                        {booksToTag.length > 3 && (
                          <TouchableOpacity onPress={() => router.push('/(tabs)/library')}>
                            <Text style={{ fontSize: 13, color: '#78716c', paddingVertical: 6 }}>
                              +{booksToTag.length - 3} more in Library →
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  )}

                  {/* ── Import reading history ── */}
                  {hasImport && (
                    <TouchableOpacity
                      onPress={() => router.push('/import/goodreads')}
                      style={{
                        backgroundColor: '#fff',
                        borderRadius: 12,
                        padding: 14,
                        flexDirection: 'row',
                        alignItems: 'center',
                        shadowColor: '#000',
                        shadowOpacity: 0.04,
                        shadowRadius: 4,
                        shadowOffset: { width: 0, height: 1 },
                        elevation: 1,
                        marginBottom: 8,
                      }}
                    >
                      <View style={{
                        width: 36, height: 36, borderRadius: 18,
                        backgroundColor: '#f5f5f4',
                        alignItems: 'center', justifyContent: 'center', marginRight: 12,
                      }}>
                        <Text style={{ fontSize: 18 }}>⤵</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }}>
                          Import reading history
                        </Text>
                        <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 2 }}>
                          Goodreads CSV gives us a head start
                        </Text>
                      </View>
                      <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
                    </TouchableOpacity>
                  )}

                  {/* Analyse imports — shown only if user has imports but not yet diagnosed */}
                  {!hasImport && (tasteProfile?.tier ?? 0) < 3 && (
                    <TouchableOpacity
                      onPress={() => router.push('/import/diagnosis')}
                      style={{
                        backgroundColor: '#fff',
                        borderRadius: 12,
                        padding: 14,
                        flexDirection: 'row',
                        alignItems: 'center',
                        shadowColor: '#000',
                        shadowOpacity: 0.04,
                        shadowRadius: 4,
                        shadowOffset: { width: 0, height: 1 },
                        elevation: 1,
                        marginBottom: 8,
                      }}
                    >
                      <View style={{
                        width: 36, height: 36, borderRadius: 18,
                        backgroundColor: '#f5f5f4',
                        alignItems: 'center', justifyContent: 'center', marginRight: 12,
                      }}>
                        <Text style={{ fontSize: 18 }}>⟲</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }}>
                          Analyse imported history
                        </Text>
                        <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 2 }}>
                          Answer 5 questions to sharpen your profile
                        </Text>
                      </View>
                      <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>

            {/* ════════════════════════════════════════════════════════
                Section 2 — From Friends
            ════════════════════════════════════════════════════════ */}
            <View style={{ marginBottom: 36 }}>
              <SectionLabel>From Friends</SectionLabel>

              {incomingRecs.length === 0 ? (
                <View style={{
                  backgroundColor: '#fff',
                  borderRadius: 14,
                  padding: 20,
                  alignItems: 'center',
                  shadowColor: '#000',
                  shadowOpacity: 0.04,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 1 },
                  elevation: 1,
                }}>
                  <Text style={{ fontSize: 14, color: '#a8a29e', textAlign: 'center', lineHeight: 20 }}>
                    No recommendations from friends yet.
                  </Text>
                </View>
              ) : (
                <View style={{
                  backgroundColor: '#fff',
                  borderRadius: 14,
                  overflow: 'hidden',
                  shadowColor: '#000',
                  shadowOpacity: 0.04,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 1 },
                  elevation: 1,
                }}>
                  {incomingRecs.map((rec, idx) => (
                    <TouchableOpacity
                      key={rec.id}
                      onPress={() => router.push('/(tabs)/notes')}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: 13,
                        borderBottomWidth: idx < incomingRecs.length - 1 ? 1 : 0,
                        borderBottomColor: '#f5f5f4',
                      }}
                    >
                      <CoverThumb
                        url={rec.book?.cover_url}
                        externalId={rec.book?.external_id}
                        title={rec.book?.title ?? ''}
                        width={34}
                        height={50}
                      />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>
                          {rec.book?.title ?? ''}
                        </Text>
                        <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }} numberOfLines={1}>
                          from {getFirstName(rec.sender)}
                        </Text>
                      </View>
                      <StatusPill status={rec.status} />
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    onPress={() => router.push('/(tabs)/notes')}
                    style={{ padding: 14, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#f5f5f4' }}
                  >
                    <Text style={{ fontSize: 13, color: '#78716c', fontWeight: '500' }}>
                      See all in inbox →
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* ════════════════════════════════════════════════════════
                Section 3 — Sent
            ════════════════════════════════════════════════════════ */}
            <View style={{ marginBottom: 16 }}>
              <SectionLabel>Sent</SectionLabel>

              {/* Primary CTA */}
              <TouchableOpacity
                onPress={() => setStep('search')}
                style={{
                  backgroundColor: '#1c1917',
                  borderRadius: 14,
                  paddingVertical: 15,
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>
                  Recommend a book
                </Text>
              </TouchableOpacity>

              {sentRecs.length === 0 ? (
                <Text style={{ fontSize: 13, color: '#a8a29e', textAlign: 'center', marginTop: 8 }}>
                  No recommendations sent yet.
                </Text>
              ) : (
                <View style={{
                  backgroundColor: '#fff',
                  borderRadius: 14,
                  overflow: 'hidden',
                  shadowColor: '#000',
                  shadowOpacity: 0.04,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 1 },
                  elevation: 1,
                }}>
                  {sentRecs.map((rec, idx) => (
                    <View
                      key={rec.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: 13,
                        borderBottomWidth: idx < sentRecs.length - 1 ? 1 : 0,
                        borderBottomColor: '#f5f5f4',
                      }}
                    >
                      <CoverThumb
                        url={rec.book?.cover_url}
                        externalId={rec.book?.external_id}
                        title={rec.book?.title ?? ''}
                        width={34}
                        height={50}
                      />
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>
                          {rec.book?.title ?? ''}
                        </Text>
                        <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }} numberOfLines={1}>
                          to {getFirstName(rec.to_user)}
                        </Text>
                      </View>
                      <StatusPill status={rec.status} />
                    </View>
                  ))}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    );
  }

  // ── Step: search ──────────────────────────────────────────────────────────

  if (step === 'search') {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7' }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 4 }}>
          <TouchableOpacity onPress={() => setStep('hub')} style={{ marginBottom: 16 }}>
            <Text style={{ color: '#78716c', fontSize: 14 }}>← Back</Text>
          </TouchableOpacity>
          <Text style={{
            fontSize: 22,
            fontWeight: '800',
            color: '#1c1917',
            letterSpacing: -0.5,
            marginBottom: 5,
          }}>
            Recommend a Book
          </Text>
          <Text style={{ fontSize: 14, color: '#a8a29e', marginBottom: 18 }}>
            Pick something worth sharing with a friend.
          </Text>
          <TextInput
            placeholder="Title, author, or keyword…"
            placeholderTextColor="#a8a29e"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              backgroundColor: '#fff',
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 16,
              color: '#1c1917',
              marginBottom: 4,
              shadowColor: '#000',
              shadowOpacity: 0.05,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          />
          {query.length > 0 && query.length < 2 && (
            <Text style={{ color: '#a8a29e', marginTop: 6, marginBottom: 4, fontSize: 13 }}>
              Type at least 2 characters to search.
            </Text>
          )}
        </View>

        {searching && <ActivityIndicator color="#78716c" style={{ marginVertical: 10 }} />}

        <FlatList
          data={bookResults}
          keyExtractor={item => item.key}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => handleSelectBook(item)}
              style={{
                paddingVertical: 11,
                borderBottomWidth: 1,
                borderBottomColor: '#f5f5f4',
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <CoverThumb url={olCoverUrl(item.cover_i, 'S')} title={item.title} width={34} height={50} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ fontWeight: '600', fontSize: 15, color: '#1c1917', lineHeight: 21 }}>
                  {item.title}
                </Text>
                <Text style={{ color: '#a8a29e', fontSize: 13, marginTop: 2 }}>
                  {item.author_name?.[0] ?? 'Unknown author'}
                </Text>
              </View>
              <Text style={{ fontSize: 20, color: '#d6d3d1', marginLeft: 8 }}>›</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            !searching && query.length >= 2 ? (
              <Text style={{ color: '#a8a29e', marginTop: 12, fontSize: 14 }}>
                No books found for that search.
              </Text>
            ) : query.length === 0 ? (
              <View style={{ paddingTop: 32, paddingHorizontal: 16, alignItems: 'center' }}>
                <Text style={{ fontSize: 28, marginBottom: 14 }}>📖</Text>
                <Text style={{
                  fontSize: 17,
                  fontWeight: '700',
                  color: '#1c1917',
                  textAlign: 'center',
                  letterSpacing: -0.3,
                  marginBottom: 8,
                }}>
                  Share something worth reading
                </Text>
                <Text style={{
                  fontSize: 14,
                  color: '#a8a29e',
                  textAlign: 'center',
                  lineHeight: 22,
                  maxWidth: 260,
                }}>
                  Search by title, author, or keyword.
                </Text>
              </View>
            ) : null
          }
        />
      </View>
    );
  }

  // ── Step: friends ─────────────────────────────────────────────────────────

  if (step === 'friends') {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', paddingHorizontal: 20, paddingTop: 24 }}>
        <TouchableOpacity onPress={() => setStep('search')} style={{ marginBottom: 20 }}>
          <Text style={{ color: '#78716c', fontSize: 14 }}>← Back to search</Text>
        </TouchableOpacity>

        <View style={{
          backgroundColor: '#fff',
          borderRadius: 14,
          padding: 14,
          marginBottom: 22,
          borderLeftWidth: 3,
          borderLeftColor: '#1c1917',
          shadowColor: '#000',
          shadowOpacity: 0.05,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
          flexDirection: 'row',
          alignItems: 'center',
        }}>
          <CoverThumb url={selectedBook?.coverUrl} editionKey={selectedBook?.editionKey} title={selectedBook?.title} width={48} height={70} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ fontWeight: '700', fontSize: 15, color: '#1c1917', lineHeight: 21 }}>
              {selectedBook?.title}
            </Text>
            <Text style={{ color: '#78716c', fontSize: 13, marginTop: 3 }}>
              {selectedBook?.author}
            </Text>
          </View>
        </View>

        <Text style={{ fontSize: 12, fontWeight: '600', color: '#a8a29e', letterSpacing: 0.4, marginBottom: 7 }}>
          Add a personal note (optional)
        </Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Why does this book matter to you?"
          placeholderTextColor="#c4b5a5"
          maxLength={280}
          style={{
            backgroundColor: '#fff',
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 11,
            fontSize: 14,
            color: '#1c1917',
            marginBottom: 26,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        />

        <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 10 }}>
          Send to
        </Text>

        {loadingFriends ? (
          <ActivityIndicator color="#78716c" />
        ) : friends.length === 0 ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 12,
            padding: 22,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: '#f0ede8',
          }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917', marginBottom: 6, textAlign: 'center' }}>
              No friends yet
            </Text>
            <Text style={{ color: '#a8a29e', fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
              Add friends from the Home tab to start sending recommendations.
            </Text>
          </View>
        ) : (
          <FlatList
            data={friends}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 13,
                borderBottomWidth: 1,
                borderBottomColor: '#f5f5f4',
              }}>
                <Text style={{ fontSize: 15, color: '#1c1917' }}>{getDisplayName(item)}</Text>
                <TouchableOpacity
                  onPress={() => handleSend(item)}
                  disabled={sendingTo !== null}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    backgroundColor: sendingTo !== null ? '#d6d3d1' : '#1c1917',
                    borderRadius: 8,
                  }}
                >
                  {sendingTo === item.id ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Send</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          />
        )}
      </View>
    );
  }

  // ── Step: done ────────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f7', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      {sendResult?.ok ? (
        <View style={{
          backgroundColor: '#f0fdf4',
          borderRadius: 16,
          padding: 28,
          alignItems: 'center',
          width: '100%',
          marginBottom: 24,
        }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#15803d', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
            Sent
          </Text>
          <Text style={{ fontSize: 16, color: '#1c1917', textAlign: 'center', lineHeight: 24, fontWeight: '600' }}>
            {sendResult.message}
          </Text>
          <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 6, textAlign: 'center' }}>
            They'll see it in their inbox.
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
        style={{ paddingHorizontal: 24, paddingVertical: 13, backgroundColor: '#1c1917', borderRadius: 12 }}
      >
        <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>Back to Recommendations</Text>
      </TouchableOpacity>
    </View>
  );
}
