import React, {
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Keyboard,
  Platform,
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
import { applyDiagnosisBoosts } from '../lib/tasteProfile';
import { CoverThumb } from '../components/CoverThumb';
import { writeGuidedStep } from '../components/OnboardingWalkthrough';
import {
  obStart,
  obStepView,
  obStepComplete,
  obTasteAnswer,
  obTasteSkipped,
  obAnchorBook,
  obFinishLater,
  obComplete,
  obRecSaved,
} from '../lib/onboardingAnalytics';

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG    = '#faf9f7';
const INK   = '#1c1917';
const MUTED = '#a8a29e';
const SUB   = '#78716c';
const BORD  = '#e7e5e4';
const GRN   = '#15803d';

// ─── Step type ────────────────────────────────────────────────────────────────
// 3 intake screens + 1 payoff (no progress number)

type Step = 'genres' | 'taste' | 'anchor_book' | 'payoff';

const STEP_NUM: Partial<Record<Step, number>> = {
  genres:      1,
  taste:       2,
  anchor_book: 3,
};
const TOTAL_STEPS = 3;

// ─── Intake state ─────────────────────────────────────────────────────────────

type GBResult = {
  id:       string;
  title:    string;
  author:   string;
  cover:    string | null;
  subjects: string[];
};

type IntakeState = {
  fictionSplit: 'fiction' | 'nonfiction' | 'both' | null;
  likedGenres:  string[];
  tasteAnswers: Record<string, string>;
  anchorBook:   GBResult | null;
};

const EMPTY_INTAKE: IntakeState = {
  fictionSplit: null,
  likedGenres:  [],
  tasteAnswers: {},
  anchorBook:   null,
};

// ─── Genre data ───────────────────────────────────────────────────────────────

type Genre = {
  label:       string;
  affinityKey: string;
  subjects:    string[];
};

const FICTION_GENRES: Genre[] = [
  { label: 'Literary Fiction',   affinityKey: 'literary',         subjects: ['literary fiction', 'contemporary fiction'] },
  { label: 'Fantasy',            affinityKey: 'fantasy_scifi',    subjects: ['fantasy', 'epic fantasy', 'fantasy fiction'] },
  { label: 'Sci-Fi',             affinityKey: 'fantasy_scifi',    subjects: ['science fiction', 'space opera', 'speculative fiction'] },
  { label: 'Thriller',           affinityKey: 'thriller_mystery', subjects: ['thriller', 'psychological thriller', 'suspense fiction'] },
  { label: 'Mystery',            affinityKey: 'thriller_mystery', subjects: ['mystery', 'detective fiction', 'crime fiction'] },
  { label: 'Romance',            affinityKey: 'romance',          subjects: ['romance', 'contemporary romance', 'romantic fiction'] },
  { label: 'Horror',             affinityKey: 'horror',           subjects: ['horror', 'gothic fiction', 'supernatural fiction'] },
  { label: 'Historical Fiction', affinityKey: 'literary',         subjects: ['historical fiction'] },
  { label: 'Young Adult',        affinityKey: 'literary',         subjects: ['young adult fiction'] },
  { label: 'Graphic Novel',      affinityKey: 'literary',         subjects: ['graphic novels', 'comics'] },
];

const NONFICTION_GENRES: Genre[] = [
  { label: 'Biography & Memoir', affinityKey: 'memoir_bio',       subjects: ['biography', 'memoir', 'autobiography'] },
  { label: 'History',            affinityKey: 'nonfiction',       subjects: ['history', 'world history', 'social history'] },
  { label: 'Science & Nature',   affinityKey: 'nonfiction',       subjects: ['science', 'popular science', 'natural history'] },
  { label: 'Essays & Ideas',     affinityKey: 'nonfiction',       subjects: ['essays', 'cultural criticism', 'philosophy'] },
  { label: 'Self-Help',          affinityKey: 'nonfiction',       subjects: ['self-help', 'personal development'] },
  { label: 'Business',           affinityKey: 'nonfiction',       subjects: ['business', 'economics', 'entrepreneurship'] },
  { label: 'True Crime',         affinityKey: 'thriller_mystery', subjects: ['true crime', 'crime'] },
  { label: 'Politics & Society', affinityKey: 'nonfiction',       subjects: ['politics', 'social science', 'current events'] },
];

const ALL_GENRES: Genre[] = [...FICTION_GENRES, ...NONFICTION_GENRES];

function getGenresForSplit(split: IntakeState['fictionSplit']): Genre[] {
  if (split === 'fiction')    return FICTION_GENRES;
  if (split === 'nonfiction') return NONFICTION_GENRES;
  return ALL_GENRES;
}

// ─── Taste questions (4 — the four with highest rec-signal weight) ─────────────

type TasteQuestion = {
  id:      string;
  prompt:  string;
  sub?:    string;
  optionA: { key: string; headline: string; sub: string; icon: React.ComponentProps<typeof Ionicons>['name'] };
  optionB: { key: string; headline: string; sub: string; icon: React.ComponentProps<typeof Ionicons>['name'] };
};

const TASTE_QUESTIONS: TasteQuestion[] = [
  {
    id:     'q_what_grips',
    prompt: 'When a book truly grips you...',
    sub:    "What's usually behind it?",
    optionA: { key: 'emotion_driven',  headline: 'It moves me',   sub: 'Emotional resonance, characters I love, feeling something deeply.', icon: 'heart-outline' },
    optionB: { key: 'idea_driven',     headline: 'It changes me', sub: 'A shifted perspective. I finish thinking differently.', icon: 'bulb-outline' },
  },
  {
    id:     'q_pacing',
    prompt: 'How much does pacing matter?',
    optionA: { key: 'pacing_non_negotiable', headline: 'It has to move',   sub: "If the story stalls, I lose interest. Momentum is non-negotiable.", icon: 'flash-outline' },
    optionB: { key: 'ideas_over_pacing',     headline: 'Depth over speed', sub: "I'll follow a slow burn anywhere if the substance is there.", icon: 'telescope-outline' },
  },
  {
    id:     'q_tone',
    prompt: 'In terms of tone...',
    optionA: { key: 'dark_tone',  headline: 'I can handle dark', sub: 'Heavy themes, difficult emotions, moral complexity — bring it.', icon: 'moon-outline' },
    optionB: { key: 'light_tone', headline: 'Keep it lighter',   sub: 'I prefer books that leave me feeling okay when I close them.', icon: 'sunny-outline' },
  },
  {
    id:     'q_style',
    prompt: 'Literary or accessible?',
    optionA: { key: 'literary_leaning',   headline: 'Literary',    sub: 'Ambitious, experimental, willing to be unconventional.', icon: 'library-outline' },
    optionB: { key: 'commercial_leaning', headline: 'Accessible',  sub: 'Compulsively readable, broadly appealing, page-turning.', icon: 'people-outline' },
  },
];

// ─── Google Books search ──────────────────────────────────────────────────────

const GB_KEY =
  typeof process.env?.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY === 'string' &&
  process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim().length > 0
    ? process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim()
    : null;

async function searchGoogleBooks(query: string): Promise<GBResult[]> {
  if (!query.trim() || !GB_KEY) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=8&key=${GB_KEY}`;
  try {
    const res  = await fetch(url);
    const json = await res.json();
    return (json.items ?? []).map((item: Record<string, unknown>) => {
      const info = (item.volumeInfo ?? {}) as Record<string, unknown>;
      const imgs = (info.imageLinks ?? {}) as Record<string, string>;
      const rawCover = imgs.thumbnail ?? imgs.smallThumbnail ?? null;
      return {
        id:       item.id as string,
        title:    (info.title as string) ?? 'Unknown',
        author:   ((info.authors as string[] | undefined) ?? [])[0] ?? '',
        cover:    rawCover ? rawCover.replace('http://', 'https://') : null,
        subjects: ((info.categories as string[] | undefined) ?? []).map((c: string) => c.toLowerCase()),
      } satisfies GBResult;
    });
  } catch {
    return [];
  }
}

// ─── Synthetic profile builder ────────────────────────────────────────────────

function buildSyntheticProfile(intake: IntakeState): TasteProfile {
  const liked = getGenresForSplit(intake.fictionSplit).filter(g => intake.likedGenres.includes(g.label));

  const genre_affinities: Record<string, number> = {};
  for (const g of liked) {
    genre_affinities[g.affinityKey] = Math.min(1, (genre_affinities[g.affinityKey] ?? 0) + 0.80);
  }

  const subjectSet = new Set<string>();
  for (const g of liked) for (const s of g.subjects) subjectSet.add(s);
  for (const s of (intake.anchorBook?.subjects ?? [])) subjectSet.add(s);
  const liked_subjects = [...subjectSet].slice(0, 8);

  const { preferred: preferred_traits, avoided: avoided_traits } = applyDiagnosisBoosts(
    {},
    {},
    intake.tasteAnswers,
  );

  const evidence = {
    completed_books_count:  intake.anchorBook ? 1 : 0,
    imported_books_count:   0,
    rated_books_count:      intake.anchorBook ? 1 : 0,
    taste_tag_count:        0,
    review_count:           0,
    diagnosis_answer_count: Object.keys(intake.tasteAnswers).length,
  };

  return {
    tier:              0,
    label:             'Getting started',
    confidence:        'low',
    preferred_traits,
    avoided_traits,
    genre_affinities,
    liked_subjects,
    liked_authors:     [],
    open_questions:    [],
    evidence,
    strongSignalCount: intake.anchorBook ? 1 : 0,
    nextTierAt:        5,
  };
}

// ─── "Why this fits you" summary ──────────────────────────────────────────────

function buildWhySummary(intake: IntakeState): string {
  const parts: string[] = [];

  if (intake.likedGenres.length > 0) {
    parts.push(`your taste for ${intake.likedGenres.slice(0, 2).join(' and ')}`);
  }

  const answerValues = Object.values(intake.tasteAnswers);
  if (answerValues.includes('emotion_driven'))       parts.push('emotional depth');
  else if (answerValues.includes('idea_driven'))     parts.push('ideas-driven storytelling');
  if (answerValues.includes('pacing_non_negotiable')) parts.push('strong momentum');
  if (answerValues.includes('literary_leaning'))     parts.push('literary ambition');
  else if (answerValues.includes('commercial_leaning')) parts.push('compulsive readability');

  if (parts.length === 0) return "A first pass — it gets sharper as you interact with the cards below.";
  return `Calibrated around ${parts.slice(0, 3).join(', ')}.`;
}

// ─── Book upsert ──────────────────────────────────────────────────────────────

async function upsertBook(
  client: NonNullable<typeof supabase>,
  userId: string,
  book: ScoredBook | { external_id: string; title: string; author: string; cover_url: string | null; description: null; subjects: string[] },
): Promise<void> {
  const bookData = {
    external_id: book.external_id,
    title:       book.title,
    author:      book.author,
    cover_url:   book.cover_url,
    description: book.description,
    subjects:    'subjects' in book ? (book.subjects ?? []) : [],
    source:      'onboarding',
  };

  const { data: existing } = await client.from('books').select('id').eq('external_id', book.external_id).maybeSingle();
  let bookId = existing?.id as string | undefined;
  if (!bookId) {
    const { data: inserted } = await client.from('books').insert(bookData).select('id').single();
    bookId = inserted?.id;
  }
  if (!bookId) return;

  await client.from('user_books').upsert(
    { user_id: userId, book_id: bookId, status: 'want_to_read', updated_at: new Date().toISOString() },
    { onConflict: 'user_id,book_id', ignoreDuplicates: false },
  );
}

// ─── Shared UI atoms ──────────────────────────────────────────────────────────

function Chip({
  label,
  active,
  onPress,
  accentColor = INK,
  icon,
}: {
  label:       string;
  active:      boolean;
  onPress:     () => void;
  accentColor?: string;
  icon?:       React.ComponentProps<typeof Ionicons>['name'];
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        paddingHorizontal: 14,
        paddingVertical:   9,
        borderRadius:      22,
        borderWidth:       1.5,
        borderColor:       active ? accentColor : BORD,
        backgroundColor:   active ? accentColor + '18' : '#fff',
        flexDirection:     'row',
        alignItems:        'center',
        gap:               6,
      }}
    >
      {icon && active && <Ionicons name={icon} size={12} color={accentColor} />}
      {!icon && active && <Ionicons name="checkmark" size={12} color={accentColor} />}
      <Text style={{ fontSize: 13, fontWeight: active ? '600' : '400', color: active ? accentColor : SUB }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label:     string;
  onPress:   () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      style={{
        backgroundColor: disabled ? BORD : INK,
        borderRadius:    14,
        paddingVertical: 15,
        alignItems:      'center',
      }}
    >
      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function BottomCTA({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        position:        'absolute',
        bottom: 0, left: 0, right: 0,
        backgroundColor: BG,
        borderTopWidth:  1,
        borderTopColor:  BORD,
        paddingHorizontal: 20,
        paddingVertical:   14,
      }}
    >
      {children}
    </View>
  );
}

// ─── ProgressHeader ───────────────────────────────────────────────────────────

function ProgressHeader({
  step,
  onFinishLater,
}: {
  step:          Step;
  onFinishLater: () => void;
}) {
  const stepNum = STEP_NUM[step];
  if (stepNum === undefined) return null;

  return (
    <View
      style={{
        paddingHorizontal: 20,
        paddingTop:  Platform.OS === 'android' ? 16 : 8,
        paddingBottom: 12,
        flexDirection: 'row',
        alignItems:    'center',
        justifyContent: 'space-between',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 5 }}>
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <View
              key={i}
              style={{
                width:           i + 1 === stepNum ? 22 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: i + 1 <= stepNum ? INK : BORD,
              }}
            />
          ))}
        </View>
        <Text style={{ fontSize: 12, color: MUTED, fontWeight: '500' }}>
          {stepNum} of {TOTAL_STEPS}
        </Text>
      </View>
      <TouchableOpacity onPress={onFinishLater} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500' }}>Finish later</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Step 1: Genres (with embedded fiction split) ─────────────────────────────

function StepGenres({
  intake,
  onComplete,
}: {
  intake:     IntakeState;
  onComplete: (split: IntakeState['fictionSplit'], liked: string[]) => void;
}) {
  const [split, setSplit] = useState<IntakeState['fictionSplit']>(intake.fictionSplit ?? 'both');
  const [liked, setLiked] = useState<string[]>(intake.likedGenres);

  const genres = getGenresForSplit(split);

  // When split changes, clear any genres that no longer appear in the new list
  function handleSplitChange(s: IntakeState['fictionSplit']) {
    setSplit(s);
    const next = getGenresForSplit(s);
    const nextLabels = new Set(next.map(g => g.label));
    setLiked(prev => prev.filter(l => nextLabels.has(l)));
  }

  const splitOptions: { key: NonNullable<IntakeState['fictionSplit']>; label: string }[] = [
    { key: 'fiction',    label: 'Fiction' },
    { key: 'nonfiction', label: 'Nonfiction' },
    { key: 'both',       label: 'Both' },
  ];

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
        <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
          What are you drawn to?
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginTop: 6, lineHeight: 20 }}>
          This shapes your entire recommendations feed.
        </Text>

        {/* Fiction / Nonfiction / Both tab strip */}
        <View
          style={{
            flexDirection:   'row',
            backgroundColor: '#f5f5f4',
            borderRadius:    10,
            padding:         3,
            marginTop:       20,
            marginBottom:    4,
          }}
        >
          {splitOptions.map(opt => (
            <TouchableOpacity
              key={opt.key}
              onPress={() => handleSplitChange(opt.key)}
              activeOpacity={0.75}
              style={{
                flex:            1,
                paddingVertical: 9,
                borderRadius:    8,
                alignItems:      'center',
                backgroundColor: split === opt.key ? '#fff' : 'transparent',
                shadowColor:     split === opt.key ? '#000' : 'transparent',
                shadowOpacity:   split === opt.key ? 0.06 : 0,
                shadowRadius:    4,
                shadowOffset:    { width: 0, height: 1 },
                elevation:       split === opt.key ? 1 : 0,
              }}
            >
              <Text
                style={{
                  fontSize:   13,
                  fontWeight: split === opt.key ? '700' : '500',
                  color:      split === opt.key ? INK : SUB,
                }}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {genres.map(g => (
            <Chip
              key={g.label}
              label={g.label}
              active={liked.includes(g.label)}
              onPress={() =>
                setLiked(prev =>
                  prev.includes(g.label) ? prev.filter(l => l !== g.label) : [...prev, g.label]
                )
              }
            />
          ))}
        </View>
      </ScrollView>

      <BottomCTA>
        <PrimaryButton
          label={liked.length > 0 ? 'Continue →' : 'Skip →'}
          onPress={() => onComplete(split, liked)}
        />
      </BottomCTA>
    </View>
  );
}

// ─── Step 2: Taste (4 binary questions, auto-advance) ─────────────────────────

function TasteBinaryCard({
  option,
  onSelect,
}: {
  option:   TasteQuestion['optionA'];
  onSelect: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onSelect}
      activeOpacity={0.75}
      style={{
        backgroundColor: '#fff',
        borderRadius:    16,
        borderWidth:     1.5,
        borderColor:     BORD,
        padding:         18,
        marginBottom:    12,
        flexDirection:   'row',
        alignItems:      'flex-start',
        gap:             14,
      }}
    >
      <View
        style={{
          width:           40,
          height:          40,
          borderRadius:    20,
          backgroundColor: '#f5f5f4',
          alignItems:      'center',
          justifyContent:  'center',
          marginTop:       1,
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
    </TouchableOpacity>
  );
}

function StepTaste({ onComplete }: { onComplete: (answers: Record<string, string>) => void }) {
  const [idx,     setIdx]     = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const slideAnim = useRef(new Animated.Value(0)).current;

  const q         = TASTE_QUESTIONS[idx];
  const remaining = TASTE_QUESTIONS.length - idx;

  function animateToNext(nextIdx: number) {
    Animated.sequence([
      Animated.timing(slideAnim, { toValue: -12, duration: 80,  useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0,   duration: 160, useNativeDriver: true }),
    ]).start();
    setTimeout(() => setIdx(nextIdx), 80);
  }

  function handleSelect(key: string) {
    const newAnswers = { ...answers, [q.id]: key };
    setAnswers(newAnswers);
    obTasteAnswer(q.id, key);
    if (idx + 1 < TASTE_QUESTIONS.length) {
      animateToNext(idx + 1);
    } else {
      onComplete(newAnswers);
    }
  }

  function handleSkipOne() {
    obTasteSkipped(1);
    if (idx + 1 < TASTE_QUESTIONS.length) {
      animateToNext(idx + 1);
    } else {
      onComplete(answers);
    }
  }

  function handleSkipAll() {
    obTasteSkipped(remaining);
    onComplete(answers);
  }

  return (
    <View style={{ flex: 1, paddingHorizontal: 20 }}>
      {/* Sub-progress bar */}
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 20 }}>
        {TASTE_QUESTIONS.map((_, i) => (
          <View
            key={i}
            style={{
              flex:            1,
              height:          3,
              borderRadius:    2,
              backgroundColor: i <= idx ? INK : BORD,
            }}
          />
        ))}
      </View>

      <Animated.View style={{ transform: [{ translateY: slideAnim }] }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: INK, lineHeight: 30, marginBottom: 4 }}>
          {q.prompt}
        </Text>
        {q.sub ? (
          <Text style={{ fontSize: 14, color: SUB, marginBottom: 20, lineHeight: 20 }}>{q.sub}</Text>
        ) : (
          <View style={{ marginBottom: 20 }} />
        )}

        <TasteBinaryCard option={q.optionA} onSelect={() => handleSelect(q.optionA.key)} />
        <TasteBinaryCard option={q.optionB} onSelect={() => handleSelect(q.optionB.key)} />
      </Animated.View>

      <View style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
        <TouchableOpacity onPress={handleSkipOne} hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}>
          <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500' }}>Skip this question →</Text>
        </TouchableOpacity>
        {idx < TASTE_QUESTIONS.length - 1 && (
          <TouchableOpacity onPress={handleSkipAll} hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}>
            <Text style={{ fontSize: 13, color: BORD, fontWeight: '500' }}>Skip remaining</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ─── Step 3: Anchor book ──────────────────────────────────────────────────────

function StepAnchorBook({ onComplete }: { onComplete: (book: GBResult | null) => void }) {
  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState<GBResult[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [selected, setSelected] = useState<GBResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      obAnchorBook('searched');
      const res = await searchGoogleBooks(query);
      setResults(res);
      setLoading(false);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
        <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
          One book that nailed it?
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginTop: 6, lineHeight: 20 }}>
          Optional. A book you loved becomes a benchmark — we find others with similar DNA.
        </Text>
      </View>

      {/* Search input */}
      <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
        <View
          style={{
            flexDirection:   'row',
            alignItems:      'center',
            backgroundColor: '#fff',
            borderRadius:    12,
            borderWidth:     1.5,
            borderColor:     BORD,
            paddingHorizontal: 12,
            gap:             8,
          }}
        >
          <Ionicons name="search" size={18} color={MUTED} />
          <TextInput
            value={query}
            onChangeText={q => { setQuery(q); setSelected(null); }}
            placeholder="Search by title or author..."
            placeholderTextColor={MUTED}
            style={{ flex: 1, fontSize: 14, paddingVertical: 13, color: INK }}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => { setQuery(''); setResults([]); setSelected(null); }}>
              <Ionicons name="close-circle" size={18} color={MUTED} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Selected confirmation */}
      {selected && (
        <View
          style={{
            marginHorizontal: 20,
            marginBottom:     12,
            backgroundColor:  GRN + '14',
            borderRadius:     12,
            borderWidth:      1.5,
            borderColor:      GRN + '44',
            padding:          14,
            flexDirection:    'row',
            alignItems:       'center',
            gap:              12,
          }}
        >
          {selected.cover ? (
            <Image source={{ uri: selected.cover }} style={{ width: 40, height: 60, borderRadius: 4 }} resizeMode="cover" />
          ) : (
            <View style={{ width: 40, height: 60, borderRadius: 4, backgroundColor: '#f5f5f4' }} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: INK }}>{selected.title}</Text>
            <Text style={{ fontSize: 12, color: SUB, marginTop: 2 }}>{selected.author}</Text>
          </View>
          <Ionicons name="checkmark-circle" size={22} color={GRN} />
        </View>
      )}

      {/* Results list */}
      {!selected && (
        <FlatList
          data={results}
          keyExtractor={i => i.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            loading ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={MUTED} />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => { setSelected(item); Keyboard.dismiss(); obAnchorBook('selected', item.title); }}
              style={{
                flexDirection:  'row',
                alignItems:     'center',
                paddingHorizontal: 20,
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: BORD,
                gap:            12,
              }}
            >
              {item.cover ? (
                <Image source={{ uri: item.cover }} style={{ width: 36, height: 52, borderRadius: 4 }} resizeMode="cover" />
              ) : (
                <View style={{ width: 36, height: 52, borderRadius: 4, backgroundColor: '#f5f5f4' }} />
              )}
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: INK }}>{item.title}</Text>
                <Text numberOfLines={1} style={{ fontSize: 12, color: SUB, marginTop: 2 }}>{item.author}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      <BottomCTA>
        <PrimaryButton
          label={selected ? 'Build my picks →' : 'Skip →'}
          onPress={() => {
            if (!selected) obAnchorBook('skipped');
            onComplete(selected);
          }}
        />
      </BottomCTA>
    </View>
  );
}

// ─── Payoff: skeleton card ─────────────────────────────────────────────────────

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
        borderRadius:    14,
        borderWidth:     1,
        borderColor:     BORD,
        padding:         14,
        marginBottom:    12,
        flexDirection:   'row',
        gap:             12,
      }}
    >
      <View style={{ width: 56, height: 84, borderRadius: 6, backgroundColor: '#f5f5f4' }} />
      <View style={{ flex: 1, gap: 8 }}>
        <View style={{ height: 14, width: '70%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
        <View style={{ height: 12, width: '45%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
        <View style={{ height: 10, width: '90%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
        <View style={{ height: 10, width: '60%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
      </View>
    </Animated.View>
  );
}

// ─── Payoff: rec card ─────────────────────────────────────────────────────────

function PayoffRecCard({
  book,
  saved,
  onSave,
}: {
  book:    ScoredBook;
  saved:   boolean;
  onSave:  () => void;
}) {
  return (
    <View
      style={{
        backgroundColor: '#fff',
        borderRadius:    14,
        borderWidth:     1,
        borderColor:     BORD,
        padding:         14,
        marginBottom:    12,
        flexDirection:   'row',
        gap:             12,
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
        <Text numberOfLines={2} style={{ fontSize: 15, fontWeight: '700', color: INK, lineHeight: 20 }}>
          {book.title}
        </Text>
        <Text style={{ fontSize: 12, color: SUB, marginTop: 2 }}>{book.author}</Text>
        {book.description ? (
          <Text numberOfLines={2} style={{ fontSize: 12, color: MUTED, lineHeight: 17, marginTop: 5 }}>
            {book.description}
          </Text>
        ) : null}
        <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {book.score > 0 && (
            <View
              style={{
                backgroundColor: fitColor(book.score) + '22',
                paddingHorizontal: 8,
                paddingVertical:   3,
                borderRadius:      6,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '600', color: fitColor(book.score) }}>
                {fitLabel(book.score)}
              </Text>
            </View>
          )}
          <TouchableOpacity
            onPress={onSave}
            activeOpacity={0.75}
            style={{
              flexDirection:    'row',
              alignItems:       'center',
              gap:              4,
              paddingHorizontal: 10,
              paddingVertical:   5,
              borderRadius:      8,
              backgroundColor:  saved ? GRN + '22' : INK,
            }}
          >
            <Ionicons name={saved ? 'checkmark' : 'bookmark-outline'} size={13} color={saved ? GRN : '#fff'} />
            <Text style={{ fontSize: 12, fontWeight: '600', color: saved ? GRN : '#fff' }}>
              {saved ? 'Saved' : 'Save'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── Step: Payoff ─────────────────────────────────────────────────────────────

function StepPayoff({
  intake,
  recs,
  recError,
  savedIds,
  onSave,
  onFinish,
}: {
  intake:    IntakeState;
  recs:      ScoredBook[] | null;
  recError:  boolean;
  savedIds:  Set<string>;
  onSave:    (book: ScoredBook) => void;
  onFinish:  () => void;
}) {
  const whySummary   = buildWhySummary(intake);
  const recsReady    = recs !== null && !recError;
  const recsEmpty    = recsReady && recs!.length === 0;

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
        <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
          Here's your first stack
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginTop: 6, lineHeight: 20 }}>
          {whySummary}
        </Text>
      </View>

      {/* Contextual teaching strip — visible at all times */}
      <View
        style={{
          marginHorizontal: 20,
          marginTop:        12,
          marginBottom:     4,
          backgroundColor:  '#f5f5f4',
          borderRadius:     10,
          paddingHorizontal: 14,
          paddingVertical:   10,
          flexDirection:    'row',
          alignItems:       'center',
          gap:              8,
        }}
      >
        <Ionicons name="information-circle-outline" size={15} color={MUTED} />
        <Text style={{ flex: 1, fontSize: 12, color: SUB, lineHeight: 17 }}>
          <Text style={{ fontWeight: '600' }}>Save</Text> what interests you ·{' '}
          every action sharpens the next batch
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        {!recsReady && !recError ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : recsEmpty || recError ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <View
              style={{
                backgroundColor: '#f5f5f4',
                borderRadius:    12,
                padding:         16,
                marginTop:       4,
                alignItems:      'center',
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: INK, textAlign: 'center', marginBottom: 4 }}>
                Calibrating...
              </Text>
              <Text style={{ fontSize: 13, color: SUB, textAlign: 'center', lineHeight: 19 }}>
                Your picks will appear in the Recommendations tab shortly — interact with a few cards to help the engine dial in faster.
              </Text>
            </View>
          </>
        ) : (
          recs!.map(book => (
            <PayoffRecCard
              key={book.id}
              book={book}
              saved={savedIds.has(book.id)}
              onSave={() => onSave(book)}
            />
          ))
        )}
      </ScrollView>

      <BottomCTA>
        <PrimaryButton label="Start exploring →" onPress={onFinish} />
      </BottomCTA>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router = useRouter();

  const [step,     setStep]     = useState<Step>('genres');
  const [intake,   setIntake]   = useState<IntakeState>(EMPTY_INTAKE);
  const [recs,     setRecs]     = useState<ScoredBook[] | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [recError, setRecError] = useState(false);

  const fetchStarted = useRef(false);
  const fadeAnim     = useRef(new Animated.Value(1)).current;

  useEffect(() => { obStart(); }, []);

  // ── Fade transition ─────────────────────────────────────────────────────────

  function goTo(next: Step) {
    Animated.timing(fadeAnim, { toValue: 0, duration: 100, useNativeDriver: true }).start(() => {
      setStep(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  }

  useEffect(() => {
    obStepView(step, STEP_NUM[step] ?? null);
  }, [step]);

  // ── Rec fetch — starts when anchor_book step is entered ────────────────────
  // The user spends time searching for a book here, giving the fetch ~20-60s of
  // buffer. This is better than a passive walkthrough as a loading screen.

  useEffect(() => {
    if (step === 'anchor_book' && !fetchStarted.current) {
      startRecFetch(intake);
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startRecFetch(currentIntake: IntakeState) {
    if (!supabase || fetchStarted.current) return;
    fetchStarted.current = true;

    const profile = buildSyntheticProfile(currentIntake);

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

  // ── Save preferences to Supabase ───────────────────────────────────────────

  async function savePreferences(userId: string, finalIntake: IntakeState) {
    if (!supabase) return;

    const behavioralMeta: Record<string, string> = {};
    if (finalIntake.fictionSplit) behavioralMeta.b_fiction_split = finalIntake.fictionSplit;

    const allDiagnosisAnswers = {
      ...finalIntake.tasteAnswers,
      ...behavioralMeta,
    };

    await supabase.from('reader_preferences').upsert(
      {
        user_id:           userId,
        favorite_genres:   finalIntake.likedGenres,
        avoid_genres:      [],
        diagnosis_answers: allDiagnosisAnswers,
        updated_at:        new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

    if (finalIntake.anchorBook) {
      const ab     = finalIntake.anchorBook;
      const gbBook = {
        external_id: `gb_${ab.id}`,
        title:       ab.title,
        author:      ab.author,
        cover_url:   ab.cover,
        description: null as null,
        subjects:    ab.subjects,
      };
      await upsertBook(supabase, userId, gbBook);

      const { data: bookRow } = await supabase
        .from('books')
        .select('id')
        .eq('external_id', gbBook.external_id)
        .maybeSingle();
      if (bookRow?.id) {
        await supabase.from('user_books').upsert(
          { user_id: userId, book_id: bookRow.id, status: 'finished', rating: 5 },
          { onConflict: 'user_id,book_id' },
        );
      }
    }
  }

  // ── Complete onboarding ────────────────────────────────────────────────────

  async function finishOnboarding(currentIntake = intake) {
    if (!supabase) { router.replace('/'); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.replace('/'); return; }

    obComplete(savedIds.size);

    await Promise.allSettled([
      savePreferences(user.id, currentIntake),
      supabase.from('profiles').update({ onboarding_completed: true }).eq('id', user.id),
      writeGuidedStep(0),
    ]);

    router.replace('/(tabs)/search');
  }

  // ── Finish later — navigate immediately, save in background ───────────────
  // Does NOT await the save so the user exits instantly.
  // Sets onboarding_completed = true so they enter the main app (not looped back).

  function handleFinishLater() {
    obFinishLater(step);

    // Fire-and-forget background save
    if (supabase) {
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (!user) return;
        Promise.allSettled([
          savePreferences(user.id, intake),
          supabase!.from('profiles').update({ onboarding_completed: true }).eq('id', user.id),
          writeGuidedStep(0),
        ]);
      });
    }

    // Navigate immediately — don't wait for Supabase
    router.replace('/(tabs)/search');
  }

  // ── Save a rec from payoff ─────────────────────────────────────────────────

  async function onSaveRec(book: ScoredBook) {
    setSavedIds(prev => new Set([...prev, book.id]));
    obRecSaved(book.title);
    if (!supabase) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await upsertBook(supabase, user.id, book);
  }

  // ── Step handlers ──────────────────────────────────────────────────────────

  function handleGenresComplete(split: IntakeState['fictionSplit'], liked: string[]) {
    const next = { ...intake, fictionSplit: split, likedGenres: liked };
    setIntake(next);
    obStepComplete('genres', 1, liked.length === 0);
    goTo('taste');
  }

  function handleTasteComplete(tasteAnswers: Record<string, string>) {
    const next = { ...intake, tasteAnswers };
    setIntake(next);
    obStepComplete('taste', 2, Object.keys(tasteAnswers).length === 0);
    goTo('anchor_book');
  }

  function handleAnchorBookComplete(anchorBook: GBResult | null) {
    const next = { ...intake, anchorBook };
    setIntake(next);
    obStepComplete('anchor_book', 3, anchorBook === null);
    // If anchor book was added, update the rec fetch if not yet started
    // (fetch already started via useEffect on step entry — if anchor book changes
    //  the profile slightly, accept that; don't re-fetch)
    goTo('payoff');
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" />

      <ProgressHeader step={step} onFinishLater={handleFinishLater} />

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        {step === 'genres' && (
          <StepGenres
            intake={intake}
            onComplete={handleGenresComplete}
          />
        )}

        {step === 'taste' && (
          <StepTaste onComplete={handleTasteComplete} />
        )}

        {step === 'anchor_book' && (
          <StepAnchorBook onComplete={handleAnchorBookComplete} />
        )}

        {step === 'payoff' && (
          <StepPayoff
            intake={intake}
            recs={recs}
            recError={recError}
            savedIds={savedIds}
            onSave={onSaveRec}
            onFinish={() => finishOnboarding()}
          />
        )}
      </Animated.View>
    </SafeAreaView>
  );
}
