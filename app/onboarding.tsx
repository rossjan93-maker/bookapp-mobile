import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { computeTasteProfile } from '../lib/tasteProfile';
import {
  getCandidateBooks,
  getRankedRecs,
  fitLabel,
  fitColor,
} from '../lib/recommender';
import type { ScoredBook } from '../lib/recommender';
import { emptyContext } from '../lib/recFeedback';
import { CoverThumb } from '../components/CoverThumb';

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = 'pick' | 'rate' | 'learning' | 'payoff';

type CuratedBook = {
  slug: string;
  title: string;
  author: string;
  isbn: string;
  label: string;
  subjects: string[];
};

// ─── Curated book list ────────────────────────────────────────────────────────
// 16 popular books across major genres.  ISBNs drive OL cover images.
// Subjects are chosen to match bookTraits.ts detection keywords exactly.

const CURATED_BOOKS: CuratedBook[] = [
  {
    slug: 'gone-girl',
    title: 'Gone Girl',
    author: 'Gillian Flynn',
    isbn: '9780307588371',
    label: 'Thriller',
    subjects: ['thriller', 'mystery', 'suspense', 'psychological fiction', 'crime fiction'],
  },
  {
    slug: 'silent-patient',
    title: 'The Silent Patient',
    author: 'Alex Michaelides',
    isbn: '9781250301697',
    label: 'Thriller',
    subjects: ['thriller', 'mystery', 'psychological thriller', 'crime fiction', 'suspense'],
  },
  {
    slug: 'seven-husbands',
    title: 'The Seven Husbands of Evelyn Hugo',
    author: 'Taylor Jenkins Reid',
    isbn: '9781501156717',
    label: 'Fiction',
    subjects: ['historical fiction', 'romance', 'literary fiction', 'drama'],
  },
  {
    slug: 'crawdads-sing',
    title: 'Where the Crawdads Sing',
    author: 'Delia Owens',
    isbn: '9780735224292',
    label: 'Literary Fiction',
    subjects: ['literary fiction', 'mystery', 'coming-of-age', 'historical fiction'],
  },
  {
    slug: 'acotar',
    title: 'A Court of Thorns and Roses',
    author: 'Sarah J. Maas',
    isbn: '9781619634466',
    label: 'Fantasy',
    subjects: ['fantasy', 'romance', 'romantasy', 'magic', 'fae'],
  },
  {
    slug: 'fourth-wing',
    title: 'Fourth Wing',
    author: 'Rebecca Yarros',
    isbn: '9781649374042',
    label: 'Fantasy',
    subjects: ['fantasy', 'romance', 'dragons', 'romantasy', 'magic'],
  },
  {
    slug: 'midnight-library',
    title: 'The Midnight Library',
    author: 'Matt Haig',
    isbn: '9780525559474',
    label: 'Fiction',
    subjects: ['contemporary fiction', 'magical realism', 'philosophical fiction', 'literary fiction'],
  },
  {
    slug: 'beach-read',
    title: 'Beach Read',
    author: 'Emily Henry',
    isbn: '9780451491992',
    label: 'Romance',
    subjects: ['romance', 'contemporary romance', 'romantic fiction', 'love story'],
  },
  {
    slug: 'it-ends-with-us',
    title: 'It Ends With Us',
    author: 'Colleen Hoover',
    isbn: '9781501110368',
    label: 'Romance',
    subjects: ['romance', 'contemporary fiction', 'love story', 'drama'],
  },
  {
    slug: 'educated',
    title: 'Educated',
    author: 'Tara Westover',
    isbn: '9780399590504',
    label: 'Memoir',
    subjects: ['memoir', 'autobiography', 'biography', 'nonfiction'],
  },
  {
    slug: 'atomic-habits',
    title: 'Atomic Habits',
    author: 'James Clear',
    isbn: '9780735211292',
    label: 'Nonfiction',
    subjects: ['nonfiction', 'self-help', 'psychology', 'personal development'],
  },
  {
    slug: 'name-of-wind',
    title: 'The Name of the Wind',
    author: 'Patrick Rothfuss',
    isbn: '9780756404741',
    label: 'Fantasy',
    subjects: ['fantasy', 'epic fantasy', 'magic', 'adventure', 'high fantasy'],
  },
  {
    slug: 'daisy-jones',
    title: 'Daisy Jones & The Six',
    author: 'Taylor Jenkins Reid',
    isbn: '9781524798642',
    label: 'Fiction',
    subjects: ['historical fiction', 'drama', 'literary fiction'],
  },
  {
    slug: 'normal-people',
    title: 'Normal People',
    author: 'Sally Rooney',
    isbn: '9781984822178',
    label: 'Literary Fiction',
    subjects: ['literary fiction', 'romance', 'contemporary fiction', 'coming-of-age'],
  },
  {
    slug: 'thursday-murder-club',
    title: 'The Thursday Murder Club',
    author: 'Richard Osman',
    isbn: '9781984880963',
    label: 'Mystery',
    subjects: ['mystery', 'cozy mystery', 'detective', 'crime fiction', 'mystery fiction'],
  },
  {
    slug: 'project-hail-mary',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    isbn: '9780593135204',
    label: 'Sci-Fi',
    subjects: ['science fiction', 'sci-fi', 'space', 'adventure', 'speculative fiction'],
  },
];

const RATING_OPTIONS = [
  { label: 'Loved it', value: 5, bg: '#f0fdf4', border: '#16a34a', text: '#15803d' },
  { label: 'Liked it', value: 4, bg: '#eff6ff', border: '#3b82f6', text: '#2563eb' },
  { label: 'It was okay', value: 3, bg: '#f5f5f4', border: '#a8a29e', text: '#57534e' },
  { label: 'Not for me', value: 2, bg: '#fef2f2', border: '#fca5a5', text: '#dc2626' },
];

const LEARNING_MESSAGES = [
  'Understanding what you like\u2026',
  'Finding patterns in your reads\u2026',
  'Building your taste profile\u2026',
];

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

function coverUrl(isbn: string) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('pick');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [currentRateIdx, setCurrentRateIdx] = useState(0);
  const [recs, setRecs] = useState<ScoredBook[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [recError, setRecError] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [phaseAnim] = useState(new Animated.Value(1));

  // Learning animation
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;
  const [learningMsgIdx, setLearningMsgIdx] = useState(0);

  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, []);

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggleBook(slug: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function handleContinueFromPick() {
    if (selected.size < 3) return;
    fadeTransition(() => {
      setCurrentRateIdx(0);
      setPhase('rate');
    });
  }

  // ── Rating ─────────────────────────────────────────────────────────────────

  const selectedBooks = CURATED_BOOKS.filter(b => selected.has(b.slug));

  function handleRate(slug: string, value: number) {
    const nextRatings = { ...ratings, [slug]: value };
    setRatings(nextRatings);

    const nextIdx = currentRateIdx + 1;
    if (nextIdx < selectedBooks.length) {
      fadeTransition(() => setCurrentRateIdx(nextIdx));
    } else {
      fadeTransition(() => startLearning(nextRatings));
    }
  }

  // ── Learning ───────────────────────────────────────────────────────────────

  function startDotAnimation() {
    const pulse = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 380, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 380, useNativeDriver: true }),
        ]),
      ).start();
    pulse(dot1, 0);
    pulse(dot2, 250);
    pulse(dot3, 500);
  }

  function startLearning(finalRatings: Record<string, number>) {
    setPhase('learning');
    startDotAnimation();

    const msgTimer = setInterval(
      () => setLearningMsgIdx(i => (i + 1) % LEARNING_MESSAGES.length),
      900,
    );

    const t0 = Date.now();

    doSaveAndFetch(finalRatings)
      .catch(() => setRecError(true))
      .finally(async () => {
        clearInterval(msgTimer);
        const elapsed = Date.now() - t0;
        if (elapsed < 2300) await sleep(2300 - elapsed);
        fadeTransition(() => setPhase('payoff'));
      });
  }

  async function doSaveAndFetch(finalRatings: Record<string, number>) {
    if (!supabase || !currentUserId) return;
    await saveOnboardingBooks(currentUserId, finalRatings);
    await supabase.from('profiles').update({ onboarding_completed: true }).eq('id', currentUserId);

    const profile = await computeTasteProfile(supabase, currentUserId);
    const candidateResult = await getCandidateBooks(supabase, currentUserId, profile, emptyContext());
    const ranked = getRankedRecs(
      candidateResult.candidates,
      profile,
      5,
      emptyContext(),
      candidateResult.enrichmentMap,
      candidateResult.retrieval_trace,
      undefined,
      candidateResult.seriesReadSet,
      candidateResult.seriesProgress,
      candidateResult.authorReadCounts,
      candidateResult.seriesPositionsRead,
    );
    const pool = [...ranked.recs, ...ranked.discoveries].slice(0, 5);
    setRecs(pool);
  }

  async function saveOnboardingBooks(userId: string, finalRatings: Record<string, number>) {
    if (!supabase) return;
    const booksToSave = CURATED_BOOKS.filter(b => selected.has(b.slug));

    for (const book of booksToSave) {
      const externalId = `onboarding_isbn_${book.isbn}`;
      const url = coverUrl(book.isbn);

      const { data: bookData } = await supabase
        .from('books')
        .upsert(
          {
            title:       book.title,
            author:      book.author,
            cover_url:   url,
            external_id: externalId,
            subjects:    book.subjects,
          },
          { onConflict: 'external_id' },
        )
        .select('id')
        .single();

      if (!bookData) continue;

      await supabase.from('user_books').upsert(
        {
          user_id:     userId,
          book_id:     bookData.id,
          status:      'finished',
          rating:      finalRatings[book.slug] ?? 3,
          finished_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,book_id' },
      );
    }
  }

  // ── Payoff actions ─────────────────────────────────────────────────────────

  async function handleWantToRead(book: ScoredBook) {
    if (!supabase || !currentUserId) return;
    setSavedIds(prev => new Set([...prev, book.id]));

    (async () => {
      let bookDbId: string | null = null;

      if (book._source === 'catalog') {
        bookDbId = book.id;
      } else if (book.external_id) {
        const { data: existing } = await supabase!
          .from('books')
          .select('id')
          .eq('external_id', book.external_id)
          .maybeSingle();

        if (existing) {
          bookDbId = existing.id;
        } else {
          const { data: created } = await supabase!
            .from('books')
            .insert({
              title:       book.title,
              author:      book.author,
              external_id: book.external_id,
              cover_url:   book.cover_url,
              subjects:    book.subjects,
            })
            .select('id')
            .single();
          bookDbId = created?.id ?? null;
        }
      }

      if (bookDbId) {
        await supabase!.from('user_books').upsert(
          { user_id: currentUserId, book_id: bookDbId, status: 'want_to_read' },
          { onConflict: 'user_id,book_id', ignoreDuplicates: true },
        );
      }
    })().catch(() => {});
  }

  function handleFinish() {
    router.replace('/');
  }

  // ── Animation helpers ──────────────────────────────────────────────────────

  function fadeTransition(callback: () => void) {
    Animated.timing(phaseAnim, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
      callback();
      Animated.timing(phaseAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f7' }}>
      <StatusBar barStyle="dark-content" />
      <Animated.View style={{ flex: 1, opacity: phaseAnim }}>
        {phase === 'pick'     && <PickPhase selected={selected} onToggle={toggleBook} onContinue={handleContinueFromPick} />}
        {phase === 'rate'     && <RatePhase book={selectedBooks[currentRateIdx]} idx={currentRateIdx} total={selectedBooks.length} onRate={handleRate} />}
        {phase === 'learning' && <LearningPhase dot1={dot1} dot2={dot2} dot3={dot3} msgIdx={learningMsgIdx} />}
        {phase === 'payoff'   && <PayoffPhase recs={recs} savedIds={savedIds} recError={recError} onWantToRead={handleWantToRead} onFinish={handleFinish} />}
      </Animated.View>
    </SafeAreaView>
  );
}

// ─── Phase: Pick ──────────────────────────────────────────────────────────────

function PickPhase({
  selected,
  onToggle,
  onContinue,
}: {
  selected: Set<string>;
  onToggle: (slug: string) => void;
  onContinue: () => void;
}) {
  const canContinue = selected.size >= 3;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', color: '#1c1917', marginBottom: 4 }}>
          Pick books you've read
        </Text>
        <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 20 }}>
          Select at least 3 — we'll use these to calibrate your taste.
        </Text>
      </View>

      <FlatList
        data={CURATED_BOOKS}
        keyExtractor={b => b.slug}
        numColumns={2}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 100 }}
        columnWrapperStyle={{ gap: 10, marginBottom: 10 }}
        renderItem={({ item }) => (
          <BookPickCard
            book={item}
            selected={selected.has(item.slug)}
            onPress={() => onToggle(item.slug)}
          />
        )}
      />

      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: '#faf9f7',
          borderTopWidth: 1,
          borderTopColor: '#e7e5e4',
          paddingHorizontal: 20,
          paddingVertical: 14,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ fontSize: 13, color: '#78716c' }}>
            {selected.size === 0
              ? 'Select at least 3 books'
              : `${selected.size} selected${selected.size < 3 ? ` · ${3 - selected.size} more needed` : ''}`}
          </Text>
          {selected.size >= 3 && (
            <Text style={{ fontSize: 13, color: '#15803d', fontWeight: '600' }}>Ready ✓</Text>
          )}
        </View>
        <TouchableOpacity
          onPress={onContinue}
          disabled={!canContinue}
          activeOpacity={0.8}
          style={{
            backgroundColor: canContinue ? '#1c1917' : '#d6d3d1',
            paddingVertical: 14,
            borderRadius: 12,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Continue</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function BookPickCard({
  book,
  selected,
  onPress,
}: {
  book: CuratedBook;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 2,
        borderColor: selected ? '#1c1917' : '#e7e5e4',
        backgroundColor: '#fff',
      }}
    >
      <Image
        source={{ uri: coverUrl(book.isbn) }}
        style={{ width: '100%', aspectRatio: 2 / 3, backgroundColor: '#f5f5f4' }}
        resizeMode="cover"
      />
      <View style={{ padding: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: '600', color: '#1c1917', lineHeight: 16 }} numberOfLines={2}>
          {book.title}
        </Text>
        <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 2 }} numberOfLines={1}>
          {book.author}
        </Text>
        <View style={{
          marginTop: 5,
          alignSelf: 'flex-start',
          backgroundColor: '#f5f5f4',
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: 6,
        }}>
          <Text style={{ fontSize: 10, color: '#78716c', fontWeight: '500' }}>{book.label}</Text>
        </View>
      </View>

      {selected && (
        <View
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: '#1c1917',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="checkmark" size={13} color="#fff" />
        </View>
      )}
    </Pressable>
  );
}

// ─── Phase: Rate ──────────────────────────────────────────────────────────────

function RatePhase({
  book,
  idx,
  total,
  onRate,
}: {
  book: CuratedBook;
  idx: number;
  total: number;
  onRate: (slug: string, value: number) => void;
}) {
  if (!book) return null;

  return (
    <View style={{ flex: 1, paddingHorizontal: 20 }}>
      <View style={{ paddingTop: 24, marginBottom: 32 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', color: '#1c1917', marginBottom: 4 }}>
          How did it land?
        </Text>
        <Text style={{ fontSize: 14, color: '#78716c' }}>
          Book {idx + 1} of {total}
        </Text>
        <View style={{ flexDirection: 'row', gap: 5, marginTop: 10 }}>
          {Array.from({ length: total }).map((_, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                backgroundColor: i <= idx ? '#1c1917' : '#e7e5e4',
              }}
            />
          ))}
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 32, gap: 16 }}>
        <Image
          source={{ uri: coverUrl(book.isbn) }}
          style={{
            width: 72,
            height: 108,
            borderRadius: 6,
            backgroundColor: '#f5f5f4',
          }}
          resizeMode="cover"
        />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#1c1917', lineHeight: 24 }}>
            {book.title}
          </Text>
          <Text style={{ fontSize: 13, color: '#78716c', marginTop: 3 }}>{book.author}</Text>
          <View style={{
            marginTop: 8,
            alignSelf: 'flex-start',
            backgroundColor: '#f5f5f4',
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 6,
          }}>
            <Text style={{ fontSize: 11, color: '#57534e', fontWeight: '500' }}>{book.label}</Text>
          </View>
        </View>
      </View>

      <Text style={{ fontSize: 13, color: '#a8a29e', fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 12 }}>
        Your reaction
      </Text>

      <View style={{ gap: 10 }}>
        {RATING_OPTIONS.map(opt => (
          <TouchableOpacity
            key={opt.value}
            activeOpacity={0.75}
            onPress={() => onRate(book.slug, opt.value)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderRadius: 12,
              borderWidth: 1.5,
              borderColor: opt.border,
              backgroundColor: opt.bg,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: opt.text, flex: 1 }}>
              {opt.label}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={opt.text} />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ─── Phase: Learning ──────────────────────────────────────────────────────────

function LearningPhase({
  dot1,
  dot2,
  dot3,
  msgIdx,
}: {
  dot1: Animated.Value;
  dot2: Animated.Value;
  dot3: Animated.Value;
  msgIdx: number;
}) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
      <View style={{ marginBottom: 36 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
          {[dot1, dot2, dot3].map((dot, i) => (
            <Animated.View
              key={i}
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: '#1c1917',
                opacity: dot,
              }}
            />
          ))}
        </View>
      </View>

      <Text
        style={{
          fontSize: 20,
          fontWeight: '700',
          color: '#1c1917',
          textAlign: 'center',
          lineHeight: 28,
          marginBottom: 12,
        }}
      >
        {LEARNING_MESSAGES[msgIdx]}
      </Text>

      <Text style={{ fontSize: 14, color: '#a8a29e', textAlign: 'center', lineHeight: 20 }}>
        Finding books that match how you actually read.
      </Text>
    </View>
  );
}

// ─── Phase: Payoff ────────────────────────────────────────────────────────────

function PayoffPhase({
  recs,
  savedIds,
  recError,
  onWantToRead,
  onFinish,
}: {
  recs: ScoredBook[];
  savedIds: Set<string>;
  recError: boolean;
  onWantToRead: (book: ScoredBook) => void;
  onFinish: () => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 4 }}>
        <Text style={{ fontSize: 22, fontWeight: '700', color: '#1c1917', marginBottom: 4 }}>
          Your first picks
        </Text>
        <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 20 }}>
          Based on what you just told us.
        </Text>
      </View>

      {recError || recs.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Ionicons name="library-outline" size={40} color="#d6d3d1" style={{ marginBottom: 16 }} />
          <Text style={{ fontSize: 16, fontWeight: '600', color: '#1c1917', textAlign: 'center', marginBottom: 8 }}>
            Your picks are warming up
          </Text>
          <Text style={{ fontSize: 14, color: '#78716c', textAlign: 'center', lineHeight: 20 }}>
            Rate a few more books to get sharper recommendations.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 120 }}
          showsVerticalScrollIndicator={false}
        >
          {recs.map(book => (
            <PayoffRecCard
              key={book.id}
              book={book}
              saved={savedIds.has(book.id)}
              onWantToRead={() => onWantToRead(book)}
            />
          ))}
        </ScrollView>
      )}

      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: '#faf9f7',
          borderTopWidth: 1,
          borderTopColor: '#e7e5e4',
          paddingHorizontal: 20,
          paddingVertical: 14,
        }}
      >
        <TouchableOpacity
          onPress={onFinish}
          activeOpacity={0.8}
          style={{
            backgroundColor: '#1c1917',
            paddingVertical: 14,
            borderRadius: 12,
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Start exploring</Text>
          <Ionicons name="arrow-forward" size={16} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function PayoffRecCard({
  book,
  saved,
  onWantToRead,
}: {
  book: ScoredBook;
  saved: boolean;
  onWantToRead: () => void;
}) {
  const color = fitColor(book.score);
  const label = fitLabel(book.score);
  const reasons = book.reasons.slice(0, 2);

  return (
    <View
      style={{
        backgroundColor: '#fff',
        borderRadius: 14,
        marginBottom: 12,
        padding: 14,
        borderWidth: 1,
        borderColor: '#f0eeec',
        shadowColor: '#1c1917',
        shadowOpacity: 0.05,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
      }}
    >
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
        <CoverThumb
          url={book.cover_url}
          externalId={book.external_id}
          title={book.title}
          width={52}
          height={78}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#1c1917', lineHeight: 20 }} numberOfLines={2}>
            {book.title}
          </Text>
          <Text style={{ fontSize: 12, color: '#78716c', marginTop: 3 }} numberOfLines={1}>
            {book.author}
          </Text>
          <View
            style={{
              marginTop: 7,
              alignSelf: 'flex-start',
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 6,
              backgroundColor: color + '18',
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: '600', color }}>{label}</Text>
          </View>
        </View>
      </View>

      {reasons.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          {reasons.map((r, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 7, marginBottom: 4, alignItems: 'flex-start' }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: '#d6d3d1', marginTop: 6 }} />
              <Text style={{ flex: 1, fontSize: 13, color: '#57534e', lineHeight: 19 }}>{r}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity
          onPress={onWantToRead}
          disabled={saved}
          activeOpacity={0.75}
          style={{
            flex: 2,
            paddingVertical: 9,
            borderRadius: 8,
            backgroundColor: saved ? '#f0fdf4' : '#1c1917',
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 5,
          }}
        >
          <Ionicons name={saved ? 'checkmark-circle' : 'bookmark-outline'} size={15} color={saved ? '#16a34a' : '#fff'} />
          <Text style={{ fontSize: 13, fontWeight: '600', color: saved ? '#16a34a' : '#fff' }}>
            {saved ? 'Saved' : 'Want to read'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
