import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import {
  getCandidateBooks,
  getRankedRecs,
  fitLabel,
  fitColor,
} from '../lib/recommender';
import type { ScoredBook } from '../lib/recommender';
import { emptyContext } from '../lib/recFeedback';
import type { TasteProfile } from '../lib/tasteProfile';
import { CoverThumb } from '../components/CoverThumb';
import { writeGuidedStep } from '../components/OnboardingWalkthrough';

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG   = '#faf9f7';
const INK  = '#1c1917';
const MUTED = '#a8a29e';
const SUB  = '#78716c';
const BORD = '#e7e5e4';

// ─── Genre definitions ────────────────────────────────────────────────────────

type Genre = {
  label: string;
  affinityKey: string;   // key for genre_affinities
  subjects: string[];    // OL subject anchors for retrieval
};

const GENRES: Genre[] = [
  {
    label: 'Literary Fiction',
    affinityKey: 'literary',
    subjects: ['literary fiction', 'contemporary fiction'],
  },
  {
    label: 'Fantasy',
    affinityKey: 'fantasy_scifi',
    subjects: ['fantasy', 'epic fantasy', 'fantasy fiction'],
  },
  {
    label: 'Sci-Fi',
    affinityKey: 'fantasy_scifi',
    subjects: ['science fiction', 'space opera', 'speculative fiction'],
  },
  {
    label: 'Thriller',
    affinityKey: 'thriller_mystery',
    subjects: ['thriller', 'psychological thriller', 'suspense fiction'],
  },
  {
    label: 'Mystery',
    affinityKey: 'thriller_mystery',
    subjects: ['mystery', 'detective fiction', 'crime fiction'],
  },
  {
    label: 'Romance',
    affinityKey: 'romance',
    subjects: ['romance', 'contemporary romance', 'romantic fiction'],
  },
  {
    label: 'Horror',
    affinityKey: 'horror',
    subjects: ['horror', 'supernatural fiction', 'gothic fiction'],
  },
  {
    label: 'Historical Fiction',
    affinityKey: 'literary',
    subjects: ['historical fiction'],
  },
  {
    label: 'Non-Fiction',
    affinityKey: 'nonfiction',
    subjects: ['popular nonfiction', 'popular science'],
  },
  {
    label: 'Biography & Memoir',
    affinityKey: 'memoir_bio',
    subjects: ['biography', 'autobiography', 'memoir'],
  },
  {
    label: 'Self-Help',
    affinityKey: 'nonfiction',
    subjects: ['self-help', 'personal development'],
  },
  {
    label: 'Young Adult',
    affinityKey: 'literary',
    subjects: ['young adult fiction'],
  },
  {
    label: 'Graphic Novel',
    affinityKey: 'literary',
    subjects: ['graphic novels', 'comics'],
  },
];

// ─── Preference options ───────────────────────────────────────────────────────

type BinaryOption = {
  key: string;
  headline: string;
  sub: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
};

const PACING_OPTIONS: BinaryOption[] = [
  {
    key: 'pacing_non_negotiable',
    headline: 'Momentum matters',
    sub: 'If the story stalls, I lose interest.',
    icon: 'flash-outline',
  },
  {
    key: 'ideas_over_pacing',
    headline: "I'll follow strong ideas anywhere",
    sub: 'Slow burns are fine when the substance is there.',
    icon: 'bulb-outline',
  },
];

const TONE_OPTIONS: BinaryOption[] = [
  {
    key: 'emotion_driven',
    headline: 'It moves me emotionally',
    sub: 'The best books leave me feeling something.',
    icon: 'heart-outline',
  },
  {
    key: 'idea_driven',
    headline: 'It changes how I think',
    sub: 'I want to finish with a new perspective.',
    icon: 'telescope-outline',
  },
];

// ─── Synthetic taste profile ──────────────────────────────────────────────────
// Converts intake selections into a TasteProfile the recommender can use.
// This runs entirely client-side — no history needed.

function buildSyntheticProfile(
  likedGenres: Genre[],
  avoidedGenres: Genre[],
  diagnosisAnswers: Record<string, string>,
  extraSubjects: string[],
): TasteProfile {
  // Genre affinities
  const genre_affinities: Record<string, number> = {};
  for (const g of likedGenres) {
    genre_affinities[g.affinityKey] = Math.min(
      1,
      (genre_affinities[g.affinityKey] ?? 0) + 0.80,
    );
  }
  for (const g of avoidedGenres) {
    genre_affinities[g.affinityKey] = Math.max(
      -1,
      (genre_affinities[g.affinityKey] ?? 0) - 0.80,
    );
  }

  // Liked subjects for OL retrieval
  const subjectSet = new Set<string>();
  for (const g of likedGenres) {
    for (const s of g.subjects) subjectSet.add(s);
  }
  for (const s of extraSubjects) subjectSet.add(s);
  const liked_subjects = [...subjectSet].slice(0, 8);

  // Preferred traits from diagnosis answers
  const preferred_traits: Record<string, number> = {};
  for (const answer of Object.values(diagnosisAnswers)) {
    switch (answer) {
      case 'idea_driven':
        preferred_traits.Insight   = Math.min(1, (preferred_traits.Insight   ?? 0) + 0.20);
        preferred_traits.Evidence  = Math.min(1, (preferred_traits.Evidence  ?? 0) + 0.10);
        break;
      case 'emotion_driven':
        preferred_traits.Emotional  = Math.min(1, (preferred_traits.Emotional  ?? 0) + 0.20);
        preferred_traits.Characters = Math.min(1, (preferred_traits.Characters ?? 0) + 0.10);
        break;
      case 'pacing_non_negotiable':
        preferred_traits.Pacing = Math.min(1, (preferred_traits.Pacing ?? 0) + 0.25);
        break;
      case 'ideas_over_pacing':
        preferred_traits.Pacing = Math.max(0, (preferred_traits.Pacing ?? 0.15) - 0.15);
        break;
    }
  }

  const evidence = {
    completed_books_count:  0,
    imported_books_count:   0,
    rated_books_count:      0,
    taste_tag_count:        0,
    review_count:           0,
    diagnosis_answer_count: Object.keys(diagnosisAnswers).length,
  };

  return {
    tier:              0,
    label:             'Getting started',
    confidence:        'low',
    preferred_traits,
    avoided_traits:    {},
    genre_affinities,
    liked_subjects,
    liked_authors:     [],
    open_questions:    [],
    evidence,
    strongSignalCount: 0,
    nextTierAt:        5,
  };
}

// ─── Google Books search ──────────────────────────────────────────────────────

type GBResult = {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  subjects: string[];
};

const GB_KEY =
  typeof process.env?.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY === 'string' &&
  process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim().length > 0
    ? process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim()
    : null;

async function searchGoogleBooks(query: string): Promise<GBResult[]> {
  if (!query.trim() || !GB_KEY) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&key=${GB_KEY}`;
  try {
    const res  = await fetch(url);
    const json = await res.json();
    return (json.items ?? []).map((item: Record<string, unknown>) => {
      const info = (item.volumeInfo ?? {}) as Record<string, unknown>;
      const imgs = (info.imageLinks ?? {}) as Record<string, string>;
      const authors = (info.authors as string[] | undefined) ?? [];
      const cats    = (info.categories as string[] | undefined) ?? [];
      return {
        id:       item.id as string,
        title:    (info.title as string) ?? 'Unknown',
        author:   authors[0] ?? '',
        cover:    imgs.thumbnail ?? imgs.smallThumbnail ?? null,
        subjects: cats.map((c: string) => c.toLowerCase()),
      } satisfies GBResult;
    });
  } catch {
    return [];
  }
}

// ─── Phase type ───────────────────────────────────────────────────────────────

type Phase = 'genres' | 'avoid' | 'pacing' | 'tone' | 'fav_book' | 'payoff';

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressDots({ phase }: { phase: Phase }) {
  const steps: Phase[] = ['genres', 'pacing', 'tone', 'payoff'];
  const idx = steps.indexOf(phase);
  const active = idx >= 0 ? idx : (phase === 'avoid' ? 0 : phase === 'fav_book' ? 2 : 3);
  return (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
      {steps.map((_, i) => (
        <View
          key={i}
          style={{
            width: i === active ? 20 : 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i <= active ? INK : BORD,
          }}
        />
      ))}
    </View>
  );
}

function GenreChip({
  label,
  active,
  onPress,
  accentColor = INK,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  accentColor?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: 22,
        borderWidth: 1.5,
        borderColor: active ? accentColor : BORD,
        backgroundColor: active ? accentColor + '18' : '#fff',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {active && <Ionicons name="checkmark" size={12} color={accentColor} />}
      <Text
        style={{
          fontSize: 13,
          fontWeight: active ? '600' : '400',
          color: active ? accentColor : SUB,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function BinaryOptionCard({
  option,
  onSelect,
}: {
  option: BinaryOption;
  onSelect: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onSelect}
      activeOpacity={0.75}
      style={{
        backgroundColor: '#fff',
        borderRadius: 16,
        borderWidth: 1.5,
        borderColor: BORD,
        padding: 20,
        marginBottom: 12,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: '#f5f5f4',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={option.icon} size={20} color={INK} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: INK, lineHeight: 22 }}>
          {option.headline}
        </Text>
        <Text style={{ fontSize: 13, color: SUB, lineHeight: 18, marginTop: 3 }}>
          {option.sub}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={MUTED} style={{ marginTop: 10 }} />
    </TouchableOpacity>
  );
}

function SkeletonCard() {
  const shimmer = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 800, useNativeDriver: true }),
      ]),
    ).start();
  }, []);
  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  return (
    <Animated.View
      style={{
        opacity,
        backgroundColor: '#fff',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: BORD,
        padding: 14,
        marginBottom: 12,
        flexDirection: 'row',
        gap: 12,
      }}
    >
      <View style={{ width: 56, height: 84, borderRadius: 6, backgroundColor: '#f5f5f4' }} />
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ height: 14, width: '70%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
        <View style={{ height: 12, width: '45%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
        <View style={{ height: 10, width: '90%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
        <View style={{ height: 10, width: '80%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
      </View>
    </Animated.View>
  );
}

function PayoffRecCard({
  book,
  saved,
  onSave,
}: {
  book: ScoredBook;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <View
      style={{
        backgroundColor: '#fff',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: BORD,
        padding: 14,
        marginBottom: 12,
        flexDirection: 'row',
        gap: 12,
      }}
    >
      <CoverThumb
        url={book.cover_url}
        externalId={book.external_id}
        title={book.title}
        width={56}
        height={84}
      />

      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={2}
          style={{ fontSize: 15, fontWeight: '700', color: INK, lineHeight: 20 }}
        >
          {book.title}
        </Text>
        <Text style={{ fontSize: 12, color: SUB, marginTop: 2 }}>{book.author}</Text>

        {book.description ? (
          <Text
            numberOfLines={2}
            style={{ fontSize: 12, color: MUTED, lineHeight: 17, marginTop: 6 }}
          >
            {book.description}
          </Text>
        ) : null}

        <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {book.score > 0 && (
            <View
              style={{
                backgroundColor: fitColor(book.score) + '22',
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '600',
                  color: fitColor(book.score),
                }}
              >
                {fitLabel(book.score)}
              </Text>
            </View>
          )}

          <TouchableOpacity
            onPress={onSave}
            activeOpacity={0.75}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 8,
              backgroundColor: saved ? '#15803d' + '22' : INK,
            }}
          >
            <Ionicons
              name={saved ? 'checkmark' : 'bookmark-outline'}
              size={13}
              color={saved ? '#15803d' : '#fff'}
            />
            <Text
              style={{
                fontSize: 12,
                fontWeight: '600',
                color: saved ? '#15803d' : '#fff',
              }}
            >
              {saved ? 'Saved' : 'Save'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── Book upsert helper ───────────────────────────────────────────────────────

async function upsertBook(
  client: NonNullable<typeof supabase>,
  userId: string,
  book: ScoredBook,
): Promise<void> {
  const bookData = {
    external_id:  book.external_id,
    title:        book.title,
    author:       book.author,
    cover_url:    book.cover_url,
    description:  book.description,
    subjects:     book.subjects ?? [],
    source:       'onboarding',
  };

  const { data: existing } = await client
    .from('books')
    .select('id')
    .eq('external_id', book.external_id)
    .maybeSingle();

  let bookId = existing?.id as string | undefined;

  if (!bookId) {
    const { data: inserted } = await client
      .from('books')
      .insert(bookData)
      .select('id')
      .single();
    bookId = inserted?.id;
  }

  if (!bookId) return;

  await client
    .from('user_books')
    .upsert(
      {
        user_id:    userId,
        book_id:    bookId,
        status:     'want_to_read',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,book_id', ignoreDuplicates: false },
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router = useRouter();

  const [phase,        setPhase]        = useState<Phase>('genres');
  const [likedLabels,  setLikedLabels]  = useState<string[]>([]);
  const [avoidedLabels, setAvoidedLabels] = useState<string[]>([]);
  const [pacingKey,    setPacingKey]    = useState<string | null>(null);
  const [toneKey,      setToneKey]      = useState<string | null>(null);

  // Fav book phase
  const [favQuery,     setFavQuery]     = useState('');
  const [favResults,   setFavResults]   = useState<GBResult[]>([]);
  const [favLoading,   setFavLoading]   = useState(false);
  const [favSelected,  setFavSelected]  = useState<GBResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Recs
  const [recs,         setRecs]         = useState<ScoredBook[] | null>(null);
  const [savedIds,     setSavedIds]     = useState<Set<string>>(new Set());
  const [recError,     setRecError]     = useState(false);
  const fetchStarted = useRef(false);

  const fadeAnim = useRef(new Animated.Value(1)).current;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function likedGenreObjects() {
    return GENRES.filter(g => likedLabels.includes(g.label));
  }

  function avoidedGenreObjects() {
    return GENRES.filter(g => avoidedLabels.includes(g.label));
  }

  function diagnosisAnswers(): Record<string, string> {
    const ans: Record<string, string> = {};
    if (pacingKey) ans.q_pacing = pacingKey;
    if (toneKey)   ans.q_tone   = toneKey;
    return ans;
  }

  // ── Phase transition ──────────────────────────────────────────────────────

  function goTo(next: Phase) {
    Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
      setPhase(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  }

  // ── Pre-fetch recs (starts when pacing is chosen) ─────────────────────────

  async function startRecFetch(pacing: string, tone?: string) {
    if (!supabase || fetchStarted.current) return;
    fetchStarted.current = true;

    const answers: Record<string, string> = { q_pacing: pacing };
    if (tone) answers.q_tone = tone;

    const liked   = likedGenreObjects();
    const avoided = avoidedGenreObjects();
    const extra   = favSelected?.subjects ?? [];
    const profile = buildSyntheticProfile(liked, avoided, answers, extra);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setRecError(true); return; }

      const candidateResult = await getCandidateBooks(supabase, user.id, profile, emptyContext());
      const rankedResult    = getRankedRecs(
        candidateResult.candidates,
        profile,
        5,
        emptyContext(),
        candidateResult.enrichmentMap,
        candidateResult.retrieval_trace,
      );
      // Merge all buckets into a flat list capped at 5
      const merged = [
        ...rankedResult.recs,
        ...rankedResult.continuations,
        ...rankedResult.discoveries,
      ].slice(0, 5);
      setRecs(merged);
    } catch {
      setRecError(true);
    }
  }

  // ── Handle pacing selection ───────────────────────────────────────────────

  function onPacingSelect(key: string) {
    setPacingKey(key);
    goTo('tone');
  }

  // ── Handle tone selection ─────────────────────────────────────────────────

  function onToneSelect(key: string) {
    setToneKey(key);
    goTo('fav_book');
  }

  // ── Fav book search ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!favQuery.trim()) { setFavResults([]); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setFavLoading(true);
      const results = await searchGoogleBooks(favQuery);
      setFavResults(results);
      setFavLoading(false);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [favQuery]);

  // ── Save preferences to Supabase ──────────────────────────────────────────

  async function savePreferences(userId: string) {
    if (!supabase) return;
    const answers = diagnosisAnswers();

    await supabase
      .from('reader_preferences')
      .upsert(
        {
          user_id:          userId,
          favorite_genres:  likedLabels,
          avoid_genres:     avoidedLabels,
          diagnosis_answers: answers,
          updated_at:       new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

    // Save fav book as finished + loved signal
    if (favSelected && supabase) {
      // Minimal book record from GB result
      const gbBook = {
        id:          `gb_${favSelected.id}`,
        external_id: `gb_${favSelected.id}`,
        title:       favSelected.title,
        author:      favSelected.author,
        cover_url:   favSelected.cover,
        isbn:        null,
        description: null,
        subjects:    favSelected.subjects,
        fit_class:   undefined,
      } as unknown as ScoredBook;
      await upsertBook(supabase, userId, gbBook);
      // Upgrade to finished + rating
      const { data: bookRow } = await supabase
        .from('books')
        .select('id')
        .eq('external_id', gbBook.external_id)
        .maybeSingle();
      if (bookRow?.id) {
        await supabase
          .from('user_books')
          .upsert(
            { user_id: userId, book_id: bookRow.id, status: 'finished', rating: 5 },
            { onConflict: 'user_id,book_id' },
          );
      }
    }
  }

  // ── Complete onboarding ───────────────────────────────────────────────────

  async function finishOnboarding() {
    if (!supabase) { router.replace('/'); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.replace('/'); return; }

    // Run saves in parallel with routing
    await Promise.allSettled([
      savePreferences(user.id),
      supabase.from('profiles').update({ onboarding_completed: true }).eq('id', user.id),
      writeGuidedStep(0),
    ]);

    router.replace('/(tabs)/search');
  }

  // ── Save a rec card ───────────────────────────────────────────────────────

  async function onSaveRec(book: ScoredBook) {
    setSavedIds(prev => new Set([...prev, book.id]));
    if (!supabase) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await upsertBook(supabase, user.id, book);
  }

  // ── Genres phase ──────────────────────────────────────────────────────────

  function toggleLiked(label: string) {
    setLikedLabels(prev =>
      prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label],
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: Platform.OS === 'android' ? 16 : 8,
          paddingBottom: 12,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <ProgressDots phase={phase} />

        {/* Skip label for genre/avoid/fav_book phases */}
        {(phase === 'genres' || phase === 'avoid' || phase === 'fav_book') && (
          <TouchableOpacity
            onPress={() => {
              if (phase === 'genres') goTo('avoid');
              else if (phase === 'avoid') goTo('pacing');
              else if (phase === 'fav_book') {
                startRecFetch(pacingKey!, toneKey ?? undefined);
                goTo('payoff');
              }
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500' }}>Skip</Text>
          </TouchableOpacity>
        )}
      </View>

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>

        {/* ── Phase: Genres ─────────────────────────────────────────── */}
        {phase === 'genres' && (
          <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
              <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
                What do you love to read?
              </Text>
              <Text style={{ fontSize: 14, color: SUB, marginTop: 6 }}>
                Pick as many as you'd like.
              </Text>
            </View>

            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
              showsVerticalScrollIndicator={false}
            >
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {GENRES.map(g => (
                  <GenreChip
                    key={g.label}
                    label={g.label}
                    active={likedLabels.includes(g.label)}
                    onPress={() => toggleLiked(g.label)}
                  />
                ))}
              </View>
            </ScrollView>

            <View
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                backgroundColor: BG,
                borderTopWidth: 1,
                borderTopColor: BORD,
                paddingHorizontal: 20,
                paddingVertical: 14,
              }}
            >
              <TouchableOpacity
                onPress={() => goTo('avoid')}
                activeOpacity={0.8}
                style={{
                  backgroundColor: INK,
                  borderRadius: 14,
                  paddingVertical: 15,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                  {likedLabels.length > 0 ? 'Continue →' : 'Skip for now →'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Phase: Avoid ──────────────────────────────────────────── */}
        {phase === 'avoid' && (
          <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
              <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
                Anything you'd rather skip?
              </Text>
              <Text style={{ fontSize: 14, color: SUB, marginTop: 6 }}>
                We'll keep these out of your picks.
              </Text>
            </View>

            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
              showsVerticalScrollIndicator={false}
            >
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {GENRES.filter(g => !likedLabels.includes(g.label)).map(g => (
                  <GenreChip
                    key={g.label}
                    label={g.label}
                    active={avoidedLabels.includes(g.label)}
                    onPress={() =>
                      setAvoidedLabels(prev =>
                        prev.includes(g.label) ? prev.filter(l => l !== g.label) : [...prev, g.label],
                      )
                    }
                    accentColor="#dc2626"
                  />
                ))}
              </View>
            </ScrollView>

            <View
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                backgroundColor: BG,
                borderTopWidth: 1,
                borderTopColor: BORD,
                paddingHorizontal: 20,
                paddingVertical: 14,
              }}
            >
              <TouchableOpacity
                onPress={() => goTo('pacing')}
                activeOpacity={0.8}
                style={{
                  backgroundColor: INK,
                  borderRadius: 14,
                  paddingVertical: 15,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                  Continue →
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Phase: Pacing ─────────────────────────────────────────── */}
        {phase === 'pacing' && (
          <View style={{ flex: 1, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32, marginBottom: 6 }}>
              How important is pacing?
            </Text>
            <Text style={{ fontSize: 14, color: SUB, marginBottom: 28 }}>
              Tap to pick — no right answer.
            </Text>
            {PACING_OPTIONS.map(opt => (
              <BinaryOptionCard key={opt.key} option={opt} onSelect={() => onPacingSelect(opt.key)} />
            ))}
          </View>
        )}

        {/* ── Phase: Tone ───────────────────────────────────────────── */}
        {phase === 'tone' && (
          <View style={{ flex: 1, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32, marginBottom: 6 }}>
              When a book really lands...
            </Text>
            <Text style={{ fontSize: 14, color: SUB, marginBottom: 28 }}>
              What's usually behind it?
            </Text>
            {TONE_OPTIONS.map(opt => (
              <BinaryOptionCard key={opt.key} option={opt} onSelect={() => onToneSelect(opt.key)} />
            ))}
          </View>
        )}

        {/* ── Phase: Fav Book ───────────────────────────────────────── */}
        {phase === 'fav_book' && (
          <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
              <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
                Any book that's stayed with you?
              </Text>
              <Text style={{ fontSize: 14, color: SUB, marginTop: 6 }}>
                Optional — helps us calibrate from the start.
              </Text>
            </View>

            <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: '#fff',
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor: BORD,
                  paddingHorizontal: 12,
                  gap: 8,
                }}
              >
                <Ionicons name="search" size={18} color={MUTED} />
                <TextInput
                  value={favQuery}
                  onChangeText={q => { setFavQuery(q); setFavSelected(null); }}
                  placeholder="Search by title or author..."
                  placeholderTextColor={MUTED}
                  style={{ flex: 1, fontSize: 14, paddingVertical: 13, color: INK }}
                  autoFocus
                />
                {favQuery.length > 0 && (
                  <TouchableOpacity onPress={() => { setFavQuery(''); setFavResults([]); setFavSelected(null); }}>
                    <Ionicons name="close-circle" size={18} color={MUTED} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {/* Selected book confirmation */}
            {favSelected && (
              <View
                style={{
                  marginHorizontal: 20,
                  marginBottom: 12,
                  backgroundColor: '#15803d' + '14',
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor: '#15803d' + '44',
                  padding: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                {favSelected.cover ? (
                  <Image
                    source={{ uri: favSelected.cover }}
                    style={{ width: 40, height: 60, borderRadius: 4 }}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={{ width: 40, height: 60, borderRadius: 4, backgroundColor: '#f5f5f4' }} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: INK }}>{favSelected.title}</Text>
                  <Text style={{ fontSize: 12, color: SUB, marginTop: 2 }}>{favSelected.author}</Text>
                </View>
                <Ionicons name="checkmark-circle" size={22} color="#15803d" />
              </View>
            )}

            {/* Search results */}
            {!favSelected && (
              <FlatList
                data={favResults}
                keyExtractor={i => i.id}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                  favLoading ? (
                    <View style={{ padding: 20, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color={MUTED} />
                    </View>
                  ) : null
                }
                renderItem={({ item }) => (
                  <TouchableOpacity
                    onPress={() => { setFavSelected(item); Keyboard.dismiss(); }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: BORD,
                      gap: 12,
                    }}
                  >
                    {item.cover ? (
                      <Image
                        source={{ uri: item.cover }}
                        style={{ width: 36, height: 52, borderRadius: 4 }}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={{ width: 36, height: 52, borderRadius: 4, backgroundColor: '#f5f5f4' }} />
                    )}
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: INK }}>
                        {item.title}
                      </Text>
                      <Text numberOfLines={1} style={{ fontSize: 12, color: SUB, marginTop: 2 }}>
                        {item.author}
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
              />
            )}

            {/* CTA */}
            <View
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                backgroundColor: BG,
                borderTopWidth: 1,
                borderTopColor: BORD,
                paddingHorizontal: 20,
                paddingVertical: 14,
              }}
            >
              <TouchableOpacity
                onPress={() => {
                  startRecFetch(pacingKey!, toneKey ?? undefined);
                  goTo('payoff');
                }}
                activeOpacity={0.8}
                style={{
                  backgroundColor: INK,
                  borderRadius: 14,
                  paddingVertical: 15,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                  {favSelected ? 'See my picks →' : 'Skip — show my picks →'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Phase: Payoff ─────────────────────────────────────────── */}
        {phase === 'payoff' && (
          <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
              <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
                Here's our first read on your taste
              </Text>
              <Text style={{ fontSize: 14, color: SUB, marginTop: 6 }}>
                Save any that catch your eye. Each one trains the engine.
              </Text>
            </View>

            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 120 }}
              showsVerticalScrollIndicator={false}
            >
              {!recs && !recError ? (
                // Skeleton state — never shows "warming up" text
                <>
                  <SkeletonCard />
                  <SkeletonCard />
                  <SkeletonCard />
                </>
              ) : recError || (recs && recs.length === 0) ? (
                // Graceful fallback — never empty or apologetic
                <View style={{ paddingTop: 32, paddingHorizontal: 16, alignItems: 'center' }}>
                  <Ionicons name="sparkles-outline" size={44} color="#d6d3d1" style={{ marginBottom: 16 }} />
                  <Text style={{ fontSize: 16, fontWeight: '700', color: INK, textAlign: 'center', marginBottom: 8 }}>
                    We're still learning your taste — here's a first pass
                  </Text>
                  <Text style={{ fontSize: 14, color: SUB, textAlign: 'center', lineHeight: 20 }}>
                    Head to your Recommend tab and interact with a few cards to help the engine dial in faster.
                  </Text>
                </View>
              ) : (
                <>
                  {recs!.map(book => (
                    <PayoffRecCard
                      key={book.id}
                      book={book}
                      saved={savedIds.has(book.id)}
                      onSave={() => onSaveRec(book)}
                    />
                  ))}
                  {/* Post-payoff nudge — non-blocking, improves signal */}
                  <View
                    style={{
                      backgroundColor: '#15803d' + '10',
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: '#15803d' + '30',
                      padding: 14,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      marginTop: 4,
                    }}
                  >
                    <Ionicons name="bulb-outline" size={18} color="#15803d" />
                    <Text style={{ flex: 1, fontSize: 13, color: '#15803d', lineHeight: 18, fontWeight: '500' }}>
                      Want better picks? Add a book you loved above or in the search tab.
                    </Text>
                  </View>
                </>
              )}
            </ScrollView>

            <View
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                backgroundColor: BG,
                borderTopWidth: 1,
                borderTopColor: BORD,
                paddingHorizontal: 20,
                paddingVertical: 14,
              }}
            >
              <TouchableOpacity
                onPress={finishOnboarding}
                activeOpacity={0.8}
                style={{
                  backgroundColor: INK,
                  borderRadius: 14,
                  paddingVertical: 15,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                  Take me to my picks →
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </Animated.View>
    </SafeAreaView>
  );
}
