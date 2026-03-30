import React, {
  useCallback,
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
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
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
  obWalkthroughPanel,
  obFinishLater,
  obComplete,
  obRecSaved,
} from '../lib/onboardingAnalytics';

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG   = '#faf9f7';
const INK  = '#1c1917';
const MUTED = '#a8a29e';
const SUB  = '#78716c';
const BORD = '#e7e5e4';
const GRN  = '#15803d';

// ─── Step type ────────────────────────────────────────────────────────────────

type Step =
  | 'identity'
  | 'fiction_split'
  | 'genres'
  | 'avoid'
  | 'taste'
  | 'anchor_book'
  | 'walkthrough'
  | 'payoff';

// Progress shown during intake steps (walkthrough + payoff have their own headers)
const STEP_NUM: Partial<Record<Step, number>> = {
  identity:      1,
  fiction_split: 2,
  genres:        2,
  avoid:         2,
  taste:         3,
  anchor_book:   4,
};
const TOTAL_STEPS = 4;

// ─── Intake state ─────────────────────────────────────────────────────────────

type GBResult = {
  id: string;
  title: string;
  author: string;
  cover: string | null;
  subjects: string[];
};

type IntakeState = {
  goals:          string[];
  frequency:      string | null;
  formats:        string[];
  fictionSplit:   'fiction' | 'nonfiction' | 'both' | null;
  likedGenres:    string[];
  avoidedGenres:  string[];
  tasteAnswers:   Record<string, string>; // question-id → ANSWER_BOOSTS key
  anchorBook:     GBResult | null;
};

const EMPTY_INTAKE: IntakeState = {
  goals: [], frequency: null, formats: [],
  fictionSplit: null,
  likedGenres: [], avoidedGenres: [],
  tasteAnswers: {},
  anchorBook: null,
};

// ─── Genre data ───────────────────────────────────────────────────────────────

type Genre = {
  label: string;
  affinityKey: string;
  subjects: string[];
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
  { label: 'Biography & Memoir', affinityKey: 'memoir_bio',        subjects: ['biography', 'memoir', 'autobiography'] },
  { label: 'History',            affinityKey: 'nonfiction',        subjects: ['history', 'world history', 'social history'] },
  { label: 'Science & Nature',   affinityKey: 'nonfiction',        subjects: ['science', 'popular science', 'natural history'] },
  { label: 'Essays & Ideas',     affinityKey: 'nonfiction',        subjects: ['essays', 'cultural criticism', 'philosophy'] },
  { label: 'Self-Help',          affinityKey: 'nonfiction',        subjects: ['self-help', 'personal development'] },
  { label: 'Business',           affinityKey: 'nonfiction',        subjects: ['business', 'economics', 'entrepreneurship'] },
  { label: 'True Crime',         affinityKey: 'thriller_mystery',  subjects: ['true crime', 'crime'] },
  { label: 'Politics & Society', affinityKey: 'nonfiction',        subjects: ['politics', 'social science', 'current events'] },
];

const ALL_GENRES: Genre[] = [...FICTION_GENRES, ...NONFICTION_GENRES];

function getGenresForSplit(split: IntakeState['fictionSplit']): Genre[] {
  if (split === 'fiction')    return FICTION_GENRES;
  if (split === 'nonfiction') return NONFICTION_GENRES;
  return ALL_GENRES;
}

// ─── Taste questions ──────────────────────────────────────────────────────────

type TasteQuestion = {
  id: string;
  prompt: string;
  sub?: string;
  optionA: { key: string; headline: string; sub: string; icon: React.ComponentProps<typeof Ionicons>['name'] };
  optionB: { key: string; headline: string; sub: string; icon: React.ComponentProps<typeof Ionicons>['name'] };
};

const TASTE_QUESTIONS: TasteQuestion[] = [
  {
    id: 'q_what_grips',
    prompt: 'When a book truly grips you...',
    sub: "What's usually behind it?",
    optionA: { key: 'emotion_driven',   headline: 'It moves me',     sub: 'Emotional resonance, characters I love, feeling something deeply.', icon: 'heart-outline' },
    optionB: { key: 'idea_driven',      headline: 'It changes me',   sub: 'A shifted perspective. I finish it thinking differently.', icon: 'bulb-outline' },
  },
  {
    id: 'q_pacing',
    prompt: 'How much does pacing matter?',
    optionA: { key: 'pacing_non_negotiable', headline: 'It has to move', sub: "If the story stalls, I lose interest. Momentum is non-negotiable.", icon: 'flash-outline' },
    optionB: { key: 'ideas_over_pacing',     headline: 'Depth over speed', sub: "I'll follow a slow burn anywhere if the substance is there.", icon: 'telescope-outline' },
  },
  {
    id: 'q_craft',
    prompt: 'What do you value more in writing?',
    optionA: { key: 'originality_first', headline: 'Originality', sub: 'A voice I have never encountered before. Something genuinely new.', icon: 'sparkles-outline' },
    optionB: { key: 'craft_first',       headline: 'Craft', sub: 'A story told with real control, precision, and intentionality.', icon: 'pencil-outline' },
  },
  {
    id: 'q_difficulty',
    prompt: 'Do you want to work for it?',
    optionA: { key: 'challenging',  headline: 'Challenge me', sub: "I'll work for a great book. Dense, complex, slow — fine.", icon: 'barbell-outline' },
    optionB: { key: 'effortless',   headline: 'Carry me',     sub: 'Reading should feel effortless. I want to be swept in.', icon: 'leaf-outline' },
  },
  {
    id: 'q_tone',
    prompt: 'In terms of tone...',
    optionA: { key: 'dark_tone',   headline: 'I can handle dark', sub: 'Heavy themes, difficult emotions, moral complexity — bring it.', icon: 'moon-outline' },
    optionB: { key: 'light_tone',  headline: 'Keep it lighter',  sub: 'I prefer books that leave me feeling okay when I close them.', icon: 'sunny-outline' },
  },
  {
    id: 'q_style',
    prompt: 'Literary or accessible?',
    optionA: { key: 'literary_leaning',   headline: 'Literary', sub: 'Ambitious, experimental, willing to be unconventional.', icon: 'library-outline' },
    optionB: { key: 'commercial_leaning', headline: 'Accessible', sub: 'Compulsively readable, broadly appealing, page-turning.', icon: 'people-outline' },
  },
];

// ─── Walkthrough panels ───────────────────────────────────────────────────────

type WalkthroughPanel = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  headline: string;
  body: string;
  accent: string;
};

const WALKTHROUGH_PANELS: WalkthroughPanel[] = [
  {
    icon: 'sparkles-outline',
    headline: 'Picks tuned to you',
    body: 'A fresh deck of recommendations, calibrated to your taste. Save what interests you, dismiss what doesn\'t, or ask for more like it — every action teaches the engine.',
    accent: '#1c1917',
  },
  {
    icon: 'library-outline',
    headline: 'Your reading life, tracked',
    body: 'Log every book you\'ve read, are reading now, or want to read. Track your progress, write notes, and see your year take shape.',
    accent: '#1c1917',
  },
  {
    icon: 'people-outline',
    headline: 'See what friends are reading',
    body: 'Follow the people whose taste you trust. See what they\'re finishing, what they\'re loving, and what they\'re saving next.',
    accent: '#1c1917',
  },
  {
    icon: 'trending-up-outline',
    headline: 'It gets sharper over time',
    body: 'Rate a book, tag what worked, finish what you saved — and the picks improve. readstack learns from every signal you give it.',
    accent: GRN,
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
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&key=${GB_KEY}`;
  try {
    const res  = await fetch(url);
    const json = await res.json();
    return (json.items ?? []).map((item: Record<string, unknown>) => {
      const info = (item.volumeInfo ?? {}) as Record<string, unknown>;
      const imgs = (info.imageLinks ?? {}) as Record<string, string>;
      return {
        id:       item.id as string,
        title:    (info.title as string) ?? 'Unknown',
        author:   ((info.authors as string[] | undefined) ?? [])[0] ?? '',
        cover:    imgs.thumbnail ?? imgs.smallThumbnail ?? null,
        subjects: ((info.categories as string[] | undefined) ?? []).map((c: string) => c.toLowerCase()),
      } satisfies GBResult;
    });
  } catch {
    return [];
  }
}

// ─── Synthetic profile builder ────────────────────────────────────────────────
// Converts IntakeState → TasteProfile for cold-start rec fetch.
// Uses applyDiagnosisBoosts from tasteProfile.ts so boost logic stays in sync.

function buildSyntheticProfile(intake: IntakeState): TasteProfile {
  const liked   = getGenresForSplit(intake.fictionSplit).filter(g => intake.likedGenres.includes(g.label));
  const avoided = getGenresForSplit(intake.fictionSplit).filter(g => intake.avoidedGenres.includes(g.label));

  // Genre affinities from liked / avoided selections
  const genre_affinities: Record<string, number> = {};
  for (const g of liked) {
    genre_affinities[g.affinityKey] = Math.min(1, (genre_affinities[g.affinityKey] ?? 0) + 0.80);
  }
  for (const g of avoided) {
    genre_affinities[g.affinityKey] = Math.max(-1, (genre_affinities[g.affinityKey] ?? 0) - 0.80);
  }

  // Liked subjects: from liked genres + anchor book subjects
  const subjectSet = new Set<string>();
  for (const g of liked) for (const s of g.subjects) subjectSet.add(s);
  for (const s of (intake.anchorBook?.subjects ?? [])) subjectSet.add(s);
  const liked_subjects = [...subjectSet].slice(0, 8);

  // Trait scores via the same ANSWER_BOOSTS logic used in computeTasteProfile
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
    parts.push(`your love of ${intake.likedGenres.slice(0, 2).join(' and ')}`);
  }

  const answerValues = Object.values(intake.tasteAnswers);
  if (answerValues.includes('emotion_driven')) parts.push('your taste for emotionally resonant stories');
  else if (answerValues.includes('idea_driven')) parts.push('your appetite for ideas-driven books');
  if (answerValues.includes('pacing_non_negotiable')) parts.push('your need for strong momentum');
  if (answerValues.includes('literary_leaning')) parts.push('your preference for literary writing');
  else if (answerValues.includes('commercial_leaning')) parts.push('your taste for compulsively readable books');

  if (parts.length === 0) return "Here's a first read on your taste — it gets sharper as you interact.";
  return `Built around ${parts.slice(0, 3).join(', ')}.`;
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
  label: string;
  active: boolean;
  onPress: () => void;
  accentColor?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
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
      {icon && active && <Ionicons name={icon} size={12} color={accentColor} />}
      {!icon && active && <Ionicons name="checkmark" size={12} color={accentColor} />}
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

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      style={{
        backgroundColor: disabled ? BORD : INK,
        borderRadius: 14,
        paddingVertical: 15,
        alignItems: 'center',
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
        position: 'absolute',
        bottom: 0, left: 0, right: 0,
        backgroundColor: BG,
        borderTopWidth: 1,
        borderTopColor: BORD,
        paddingHorizontal: 20,
        paddingVertical: 14,
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
  step: Step;
  onFinishLater: () => void;
}) {
  const stepNum = STEP_NUM[step];
  if (stepNum === undefined) return null;

  return (
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 5 }}>
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <View
              key={i}
              style={{
                width: i + 1 === stepNum ? 22 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i + 1 <= stepNum ? INK : BORD,
              }}
            />
          ))}
        </View>
        <Text style={{ fontSize: 12, color: MUTED, fontWeight: '500' }}>
          {stepNum} of {TOTAL_STEPS}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onFinishLater}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500' }}>Finish later</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Step: Identity ───────────────────────────────────────────────────────────

const GOAL_OPTIONS = [
  { key: 'discover',  label: 'Discover better books', icon: 'sparkles-outline' as const },
  { key: 'track',     label: 'Track my reading',       icon: 'bookmark-outline' as const },
  { key: 'read_more', label: 'Read more often',         icon: 'time-outline' as const },
  { key: 'social',    label: 'Read with friends',       icon: 'people-outline' as const },
];

const FREQUENCY_OPTIONS = [
  { key: 'rarely',   label: 'A few times\na year' },
  { key: 'monthly',  label: 'About once\na month' },
  { key: 'weekly',   label: 'Most weeks' },
  { key: 'daily',    label: 'Almost\nevery day' },
];

const FORMAT_OPTIONS = [
  { key: 'print',     label: 'Print', icon: 'book-outline' as const },
  { key: 'ebook',     label: 'Ebook', icon: 'tablet-portrait-outline' as const },
  { key: 'audiobook', label: 'Audio', icon: 'headset-outline' as const },
];

function StepIdentity({
  onComplete,
}: {
  onComplete: (goals: string[], frequency: string | null, formats: string[]) => void;
}) {
  const [goals, setGoals]         = useState<string[]>([]);
  const [frequency, setFrequency] = useState<string | null>(null);
  const [formats, setFormats]     = useState<string[]>([]);

  function toggle<T>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32, marginBottom: 6 }}>
          Let's figure out your reading world
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginBottom: 28, lineHeight: 20 }}>
          Three quick ones — no books yet.
        </Text>

        {/* Goals */}
        <Text style={{ fontSize: 11, fontWeight: '700', color: MUTED, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 12 }}>
          What brings you here?
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
          {GOAL_OPTIONS.map(opt => (
            <Chip
              key={opt.key}
              label={opt.label}
              active={goals.includes(opt.key)}
              onPress={() => setGoals(prev => toggle(prev, opt.key))}
              icon={opt.icon}
            />
          ))}
        </View>

        {/* Frequency */}
        <Text style={{ fontSize: 11, fontWeight: '700', color: MUTED, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 12 }}>
          How often do you read?
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 28 }}>
          {FREQUENCY_OPTIONS.map(opt => {
            const active = frequency === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                onPress={() => setFrequency(opt.key)}
                activeOpacity={0.75}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  paddingHorizontal: 6,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor: active ? INK : BORD,
                  backgroundColor: active ? INK + '0e' : '#fff',
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: active ? '700' : '400',
                    color: active ? INK : SUB,
                    textAlign: 'center',
                    lineHeight: 16,
                  }}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Format */}
        <Text style={{ fontSize: 11, fontWeight: '700', color: MUTED, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 12 }}>
          How do you mostly read?
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {FORMAT_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.key}
              onPress={() => setFormats(prev => toggle(prev, opt.key))}
              activeOpacity={0.75}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 12,
                borderWidth: 1.5,
                borderColor: formats.includes(opt.key) ? INK : BORD,
                backgroundColor: formats.includes(opt.key) ? INK + '0e' : '#fff',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Ionicons name={opt.icon} size={20} color={formats.includes(opt.key) ? INK : MUTED} />
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: formats.includes(opt.key) ? '700' : '400',
                  color: formats.includes(opt.key) ? INK : SUB,
                }}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      <BottomCTA>
        <PrimaryButton
          label="Continue →"
          onPress={() => onComplete(goals, frequency, formats)}
        />
      </BottomCTA>
    </View>
  );
}

// ─── Step: Fiction split ──────────────────────────────────────────────────────

type FictionSplit = 'fiction' | 'nonfiction' | 'both';

const FICTION_SPLIT_OPTIONS: { key: FictionSplit; headline: string; sub: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { key: 'fiction',    headline: 'Fiction',    sub: 'Stories, characters, imagined worlds.', icon: 'book-outline' },
  { key: 'nonfiction', headline: 'Nonfiction', sub: 'Ideas, facts, real lives, true events.', icon: 'newspaper-outline' },
  { key: 'both',       headline: 'Both',       sub: 'No walls between them — I read widely.', icon: 'grid-outline' },
];

function StepFictionSplit({ onSelect }: { onSelect: (split: FictionSplit) => void }) {
  return (
    <View style={{ flex: 1, paddingHorizontal: 20 }}>
      <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32, marginBottom: 6 }}>
        Where do you mostly live?
      </Text>
      <Text style={{ fontSize: 14, color: SUB, marginBottom: 28, lineHeight: 20 }}>
        This shapes which genres we show you next.
      </Text>

      {FICTION_SPLIT_OPTIONS.map(opt => (
        <TouchableOpacity
          key={opt.key}
          onPress={() => onSelect(opt.key)}
          activeOpacity={0.75}
          style={{
            backgroundColor: '#fff',
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: BORD,
            padding: 20,
            marginBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: '#f5f5f4',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name={opt.icon} size={22} color={INK} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: INK, marginBottom: 3 }}>
              {opt.headline}
            </Text>
            <Text style={{ fontSize: 13, color: SUB, lineHeight: 18 }}>{opt.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={MUTED} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Step: Genres ─────────────────────────────────────────────────────────────

function StepGenres({
  fictionSplit,
  likedGenres,
  onComplete,
}: {
  fictionSplit: IntakeState['fictionSplit'];
  likedGenres: string[];
  onComplete: (liked: string[]) => void;
}) {
  const [liked, setLiked] = useState<string[]>(likedGenres);
  const genres = getGenresForSplit(fictionSplit);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
        <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
          What calls to you?
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginTop: 6 }}>
          Pick freely — the more honest, the better.
        </Text>
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
              onPress={() => setLiked(prev => prev.includes(g.label) ? prev.filter(l => l !== g.label) : [...prev, g.label])}
            />
          ))}
        </View>
      </ScrollView>

      <BottomCTA>
        <PrimaryButton
          label={liked.length > 0 ? 'Continue →' : 'Skip question →'}
          onPress={() => onComplete(liked)}
        />
      </BottomCTA>
    </View>
  );
}

// ─── Step: Avoid ──────────────────────────────────────────────────────────────

function StepAvoid({
  fictionSplit,
  likedGenres,
  avoidedGenres,
  onComplete,
}: {
  fictionSplit: IntakeState['fictionSplit'];
  likedGenres: string[];
  avoidedGenres: string[];
  onComplete: (avoided: string[]) => void;
}) {
  const [avoided, setAvoided] = useState<string[]>(avoidedGenres);
  const genres = getGenresForSplit(fictionSplit).filter(g => !likedGenres.includes(g.label));

  return (
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
          {genres.map(g => (
            <Chip
              key={g.label}
              label={g.label}
              active={avoided.includes(g.label)}
              accentColor="#dc2626"
              onPress={() => setAvoided(prev => prev.includes(g.label) ? prev.filter(l => l !== g.label) : [...prev, g.label])}
            />
          ))}
        </View>
      </ScrollView>

      <BottomCTA>
        <PrimaryButton
          label={avoided.length > 0 ? 'Continue →' : 'Skip question →'}
          onPress={() => onComplete(avoided)}
        />
      </BottomCTA>
    </View>
  );
}

// ─── Step: Taste (6 binary questions, one at a time) ──────────────────────────

function TasteBinaryCard({
  option,
  onSelect,
}: {
  option: TasteQuestion['optionA'];
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
        padding: 18,
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
          marginTop: 1,
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

function StepTaste({
  onComplete,
}: {
  onComplete: (answers: Record<string, string>) => void;
}) {
  const [idx, setIdx]         = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const slideAnim = useRef(new Animated.Value(0)).current;

  const q = TASTE_QUESTIONS[idx];
  const remaining = TASTE_QUESTIONS.length - idx;

  function animateToNext(nextIdx: number) {
    Animated.sequence([
      Animated.timing(slideAnim, { toValue: -12, duration: 80, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 160, useNativeDriver: true }),
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

  function handleSkipAll() {
    obTasteSkipped(remaining);
    onComplete(answers);
  }

  function handleSkipOne() {
    obTasteSkipped(1);
    if (idx + 1 < TASTE_QUESTIONS.length) {
      animateToNext(idx + 1);
    } else {
      onComplete(answers);
    }
  }

  return (
    <View style={{ flex: 1, paddingHorizontal: 20 }}>
      {/* Sub-progress indicator */}
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 20 }}>
        {TASTE_QUESTIONS.map((_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              backgroundColor: i <= idx ? INK : BORD,
            }}
          />
        ))}
      </View>

      <Animated.View style={{ transform: [{ translateY: slideAnim }] }}>
        <Text style={{ fontSize: 24, fontWeight: '800', color: INK, lineHeight: 30, marginBottom: 4 }}>
          {q.prompt}
        </Text>
        {q.sub && (
          <Text style={{ fontSize: 14, color: SUB, marginBottom: 20, lineHeight: 20 }}>
            {q.sub}
          </Text>
        )}
        {!q.sub && <View style={{ marginBottom: 20 }} />}

        <TasteBinaryCard option={q.optionA} onSelect={() => handleSelect(q.optionA.key)} />
        <TasteBinaryCard option={q.optionB} onSelect={() => handleSelect(q.optionB.key)} />
      </Animated.View>

      <View style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
        <TouchableOpacity
          onPress={handleSkipOne}
          hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
        >
          <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500' }}>Skip this question →</Text>
        </TouchableOpacity>
        {idx < TASTE_QUESTIONS.length - 1 && (
          <TouchableOpacity
            onPress={handleSkipAll}
            hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
          >
            <Text style={{ fontSize: 13, color: BORD, fontWeight: '500' }}>Skip remaining questions</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ─── Step: Anchor book ────────────────────────────────────────────────────────

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
          One book that nailed it for you?
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginTop: 6, lineHeight: 20 }}>
          Optional — but the single strongest cold-start signal we can get.
        </Text>
      </View>

      {/* Anchor book value explanation */}
      {!selected && (
        <View
          style={{
            marginHorizontal: 20,
            marginBottom: 14,
            backgroundColor: '#f5f5f4',
            borderRadius: 10,
            padding: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Ionicons name="information-circle-outline" size={16} color={MUTED} />
          <Text style={{ flex: 1, fontSize: 12, color: SUB, lineHeight: 17 }}>
            A book you've loved becomes your benchmark — we use it to find books with similar DNA.
          </Text>
        </View>
      )}

      {/* Search input */}
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

      {/* Selected book */}
      {selected && (
        <View
          style={{
            marginHorizontal: 20,
            marginBottom: 12,
            backgroundColor: GRN + '14',
            borderRadius: 12,
            borderWidth: 1.5,
            borderColor: GRN + '44',
            padding: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
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

      {/* Results */}
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
          label={selected ? 'Continue →' : 'Skip →'}
          onPress={() => {
            if (!selected) obAnchorBook('skipped');
            onComplete(selected);
          }}
        />
      </BottomCTA>
    </View>
  );
}

// ─── Step: Walkthrough ────────────────────────────────────────────────────────

function StepWalkthrough({ onComplete }: { onComplete: () => void }) {
  const { width } = useWindowDimensions();
  const [panelIdx, setPanelIdx] = useState(0);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    obWalkthroughPanel(0);
  }, []);

  function handleNext() {
    if (panelIdx < WALKTHROUGH_PANELS.length - 1) {
      const next = panelIdx + 1;
      listRef.current?.scrollToIndex({ index: next, animated: true });
      setPanelIdx(next);
      obWalkthroughPanel(next);
    } else {
      onComplete();
    }
  }

  const panel = WALKTHROUGH_PANELS[panelIdx];
  const isLast = panelIdx === WALKTHROUGH_PANELS.length - 1;

  return (
    <View style={{ flex: 1 }}>
      {/* Tour label */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color: MUTED, letterSpacing: 0.8, textTransform: 'uppercase' }}>
          Product Tour
        </Text>
        <TouchableOpacity onPress={onComplete} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500' }}>Skip →</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={WALKTHROUGH_PANELS}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => (
          <View style={{ width, flex: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 140, justifyContent: 'center', alignItems: 'center' }}>
            {/* Icon circle */}
            <View
              style={{
                width: 96,
                height: 96,
                borderRadius: 48,
                backgroundColor: item.accent + '12',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 32,
              }}
            >
              <Ionicons name={item.icon} size={44} color={item.accent} />
            </View>
            <Text style={{ fontSize: 24, fontWeight: '800', color: INK, textAlign: 'center', lineHeight: 30, marginBottom: 14 }}>
              {item.headline}
            </Text>
            <Text style={{ fontSize: 15, color: SUB, textAlign: 'center', lineHeight: 23, maxWidth: 300 }}>
              {item.body}
            </Text>
          </View>
        )}
      />

      <BottomCTA>
        {/* Pagination dots */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 14 }}>
          {WALKTHROUGH_PANELS.map((_, i) => (
            <View
              key={i}
              style={{
                width: i === panelIdx ? 22 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === panelIdx ? INK : BORD,
              }}
            />
          ))}
        </View>
        <PrimaryButton
          label={isLast ? 'See my picks →' : 'Next →'}
          onPress={handleNext}
        />
      </BottomCTA>
    </View>
  );
}

// ─── Step: Payoff ─────────────────────────────────────────────────────────────

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
        <View style={{ height: 10, width: '60%', borderRadius: 4, backgroundColor: '#f5f5f4' }} />
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
        <Text numberOfLines={2} style={{ fontSize: 15, fontWeight: '700', color: INK, lineHeight: 20 }}>
          {book.title}
        </Text>
        <Text style={{ fontSize: 12, color: SUB, marginTop: 2 }}>{book.author}</Text>
        {book.description ? (
          <Text numberOfLines={2} style={{ fontSize: 12, color: MUTED, lineHeight: 17, marginTop: 6 }}>
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
              <Text style={{ fontSize: 11, fontWeight: '600', color: fitColor(book.score) }}>
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
              backgroundColor: saved ? GRN + '22' : INK,
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

function StepPayoff({
  intake,
  recs,
  recError,
  savedIds,
  onSave,
  onFinish,
}: {
  intake: IntakeState;
  recs: ScoredBook[] | null;
  recError: boolean;
  savedIds: Set<string>;
  onSave: (book: ScoredBook) => void;
  onFinish: () => void;
}) {
  const whySummary = buildWhySummary(intake);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
        <Text style={{ fontSize: 26, fontWeight: '800', color: INK, lineHeight: 32 }}>
          Here's our first read on your taste
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginTop: 6, lineHeight: 20 }}>
          {whySummary}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        {!recs && !recError ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : recError || (recs && recs.length === 0) ? (
          <View style={{ paddingTop: 32, paddingHorizontal: 16, alignItems: 'center' }}>
            <Ionicons name="sparkles-outline" size={44} color="#d6d3d1" style={{ marginBottom: 16 }} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: INK, textAlign: 'center', marginBottom: 8 }}>
              We're still calibrating — here's a first pass
            </Text>
            <Text style={{ fontSize: 14, color: SUB, textAlign: 'center', lineHeight: 20 }}>
              Head to Recommendations and interact with a few cards to help the engine dial in.
            </Text>
          </View>
        ) : (
          <>
            {recs!.map(book => (
              <PayoffRecCard
                key={book.id}
                book={book}
                saved={savedIds.has(book.id)}
                onSave={() => onSave(book)}
              />
            ))}
            <View
              style={{
                backgroundColor: GRN + '10',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: GRN + '30',
                padding: 14,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                marginTop: 4,
              }}
            >
              <Ionicons name="trending-up-outline" size={18} color={GRN} />
              <Text style={{ flex: 1, fontSize: 13, color: GRN, lineHeight: 18, fontWeight: '500' }}>
                Save, dismiss, or rate books in the Recommendations tab — the picks get sharper every time.
              </Text>
            </View>
          </>
        )}
      </ScrollView>

      <BottomCTA>
        <PrimaryButton label="Take me to my picks →" onPress={onFinish} />
      </BottomCTA>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router = useRouter();

  const [step,     setStep]     = useState<Step>('identity');
  const [intake,   setIntake]   = useState<IntakeState>(EMPTY_INTAKE);
  const [recs,     setRecs]     = useState<ScoredBook[] | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [recError, setRecError] = useState(false);

  const fetchStarted = useRef(false);
  const fadeAnim     = useRef(new Animated.Value(1)).current;

  // Fire session start once
  useEffect(() => { obStart(); }, []);

  // ── Animate between steps ──────────────────────────────────────────────────

  function goTo(next: Step) {
    Animated.timing(fadeAnim, { toValue: 0, duration: 100, useNativeDriver: true }).start(() => {
      setStep(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  }

  // Track step views
  useEffect(() => {
    obStepView(step, STEP_NUM[step] ?? null);
  }, [step]);

  // ── Pre-fetch recs (called when entering walkthrough) ─────────────────────

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

  // ── Save preferences to Supabase ──────────────────────────────────────────

  async function savePreferences(userId: string, finalIntake: IntakeState) {
    if (!supabase) return;

    // Pack all answers into diagnosis_answers
    // Taste answers use ANSWER_BOOSTS keys as values (emotion_driven, etc.)
    // Behavioral metadata uses b_ prefix (ignored by ANSWER_BOOSTS, stored for future use)
    const behavioralMeta: Record<string, string> = {};
    if (finalIntake.goals.length > 0)   behavioralMeta.b_goals          = finalIntake.goals.join(',');
    if (finalIntake.frequency)          behavioralMeta.b_frequency      = finalIntake.frequency;
    if (finalIntake.formats.length > 0) behavioralMeta.b_formats        = finalIntake.formats.join(',');
    if (finalIntake.fictionSplit)       behavioralMeta.b_fiction_split  = finalIntake.fictionSplit;

    const allDiagnosisAnswers = {
      ...finalIntake.tasteAnswers,
      ...behavioralMeta,
    };

    await supabase.from('reader_preferences').upsert(
      {
        user_id:           userId,
        favorite_genres:   finalIntake.likedGenres,
        avoid_genres:      finalIntake.avoidedGenres,
        diagnosis_answers: allDiagnosisAnswers,
        updated_at:        new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

    // Save anchor book as finished + 5★ (strongest cold-start signal)
    if (finalIntake.anchorBook) {
      const ab = finalIntake.anchorBook;
      const gbBook = {
        external_id: `gb_${ab.id}`,
        title:       ab.title,
        author:      ab.author,
        cover_url:   ab.cover,
        description: null,
        subjects:    ab.subjects,
      };
      await upsertBook(supabase, userId, gbBook as Parameters<typeof upsertBook>[2]);

      // Upgrade to finished + rating 5
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

  // ── Finish onboarding ──────────────────────────────────────────────────────

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

  // ── Save a rec from payoff screen ─────────────────────────────────────────

  async function onSaveRec(book: ScoredBook) {
    setSavedIds(prev => new Set([...prev, book.id]));
    obRecSaved(book.title);
    if (!supabase) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await upsertBook(supabase, user.id, book);
  }

  // ── Step handlers ──────────────────────────────────────────────────────────

  function handleIdentityComplete(goals: string[], frequency: string | null, formats: string[]) {
    const next = { ...intake, goals, frequency, formats };
    setIntake(next);
    obStepComplete('identity', 1);
    goTo('fiction_split');
  }

  function handleFictionSplitSelect(split: FictionSplit) {
    const next = { ...intake, fictionSplit: split };
    setIntake(next);
    obStepComplete('fiction_split', 2);
    goTo('genres');
  }

  function handleGenresComplete(liked: string[]) {
    const next = { ...intake, likedGenres: liked };
    setIntake(next);
    obStepComplete('genres', 2, liked.length === 0);
    goTo('avoid');
  }

  function handleAvoidComplete(avoided: string[]) {
    const next = { ...intake, avoidedGenres: avoided };
    setIntake(next);
    obStepComplete('avoid', 2, avoided.length === 0);
    goTo('taste');
  }

  function handleTasteComplete(tasteAnswers: Record<string, string>) {
    const next = { ...intake, tasteAnswers };
    setIntake(next);
    obStepComplete('taste', 3, Object.keys(tasteAnswers).length === 0);
    goTo('anchor_book');
  }

  function handleAnchorBookComplete(anchorBook: GBResult | null) {
    const next = { ...intake, anchorBook };
    setIntake(next);
    obStepComplete('anchor_book', 4, anchorBook === null);
    // Start rec fetch now — walkthrough gives us ~15s of loading time
    startRecFetch(next);
    goTo('walkthrough');
  }

  function handleWalkthroughComplete() {
    goTo('payoff');
  }

  function handleFinishLater() {
    obFinishLater(step);
    finishOnboarding();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" />

      <ProgressHeader step={step} onFinishLater={handleFinishLater} />

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        {step === 'identity' && (
          <StepIdentity onComplete={handleIdentityComplete} />
        )}

        {step === 'fiction_split' && (
          <StepFictionSplit onSelect={handleFictionSplitSelect} />
        )}

        {step === 'genres' && (
          <StepGenres
            fictionSplit={intake.fictionSplit}
            likedGenres={intake.likedGenres}
            onComplete={handleGenresComplete}
          />
        )}

        {step === 'avoid' && (
          <StepAvoid
            fictionSplit={intake.fictionSplit}
            likedGenres={intake.likedGenres}
            avoidedGenres={intake.avoidedGenres}
            onComplete={handleAvoidComplete}
          />
        )}

        {step === 'taste' && (
          <StepTaste onComplete={handleTasteComplete} />
        )}

        {step === 'anchor_book' && (
          <StepAnchorBook onComplete={handleAnchorBookComplete} />
        )}

        {step === 'walkthrough' && (
          <StepWalkthrough onComplete={handleWalkthroughComplete} />
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
