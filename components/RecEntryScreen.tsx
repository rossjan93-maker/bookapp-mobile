// ─── Recommendations entry experience ────────────────────────────────────────
//
// Shown on the FIRST visit to the Recommendations tab (before any personalization
// signal exists). Offers three paths:
//
//   A. Import (primary) — routes to /import/goodreads
//   B. Quick intake    — 3-screen inline preference setup
//   C. Explore anyway  — skip, go straight to the rec hub
//
// State stored in AsyncStorage `readstack_rec_entry_v1`:
//   '1' = user made a choice; don't re-show.
//
// Written by this component when any choice is made.
// Parent (search.tsx) reads it before mounting to decide whether to show entry.

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
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import {
  reEntryShown,
  reImportTapped,
  reIntakeStarted,
  reIntakeCompleted,
  reIntakeSkipped,
  reExploreTapped,
  riTasteAnswered,
  riTasteSkipped,
  riAnchorSearched,
  riAnchorSelected,
  riAnchorSkipped,
} from '../lib/onboardingAnalytics';

// ─── Constants ────────────────────────────────────────────────────────────────

export const REC_ENTRY_KEY = 'readstack_rec_entry_v1';

export async function hasSeenRecEntry(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(REC_ENTRY_KEY)) === '1';
  } catch {
    return false;
  }
}

async function markRecEntrySeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(REC_ENTRY_KEY, '1');
  } catch {}
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG   = '#faf9f7';
const INK  = '#1c1917';
const MUTED = '#a8a29e';
const SUB  = '#78716c';
const BORD = '#e7e5e4';
const GRN  = '#15803d';

// ─── Quick-intake types ───────────────────────────────────────────────────────

type IntakeStep = 'genres' | 'taste' | 'anchor';

type GBResult = {
  id:       string;
  title:    string;
  author:   string;
  cover:    string | null;
  subjects: string[];
};

type IntakeState = {
  fictionSplit: 'fiction' | 'nonfiction' | 'both';
  likedGenres:  string[];
  tasteAnswers: Record<string, string>;
  anchorBook:   GBResult | null;
};

// ─── Genre data ───────────────────────────────────────────────────────────────

type Genre = { label: string; affinityKey: string; subjects: string[] };

const FICTION_GENRES: Genre[] = [
  { label: 'Literary Fiction',   affinityKey: 'literary',         subjects: ['literary fiction', 'contemporary fiction'] },
  { label: 'Fantasy',            affinityKey: 'fantasy_scifi',    subjects: ['fantasy', 'epic fantasy'] },
  { label: 'Sci-Fi',             affinityKey: 'fantasy_scifi',    subjects: ['science fiction', 'space opera'] },
  { label: 'Thriller',           affinityKey: 'thriller_mystery', subjects: ['thriller', 'suspense fiction'] },
  { label: 'Mystery',            affinityKey: 'thriller_mystery', subjects: ['mystery', 'detective fiction'] },
  { label: 'Romance',            affinityKey: 'romance',          subjects: ['romance', 'contemporary romance'] },
  { label: 'Horror',             affinityKey: 'horror',           subjects: ['horror', 'gothic fiction'] },
  { label: 'Historical Fiction', affinityKey: 'literary',         subjects: ['historical fiction'] },
  { label: 'Young Adult',        affinityKey: 'literary',         subjects: ['young adult fiction'] },
];

const NONFICTION_GENRES: Genre[] = [
  { label: 'Biography & Memoir', affinityKey: 'memoir_bio',  subjects: ['biography', 'memoir'] },
  { label: 'History',            affinityKey: 'nonfiction',  subjects: ['history', 'world history'] },
  { label: 'Science & Nature',   affinityKey: 'nonfiction',  subjects: ['science', 'popular science'] },
  { label: 'Essays & Ideas',     affinityKey: 'nonfiction',  subjects: ['essays', 'philosophy'] },
  { label: 'Self-Help',          affinityKey: 'nonfiction',  subjects: ['self-help', 'personal development'] },
  { label: 'Business',           affinityKey: 'nonfiction',  subjects: ['business', 'economics'] },
  { label: 'True Crime',         affinityKey: 'thriller_mystery', subjects: ['true crime'] },
  { label: 'Politics & Society', affinityKey: 'nonfiction',  subjects: ['politics', 'social science'] },
];

function getGenres(split: IntakeState['fictionSplit']): Genre[] {
  if (split === 'fiction')    return FICTION_GENRES;
  if (split === 'nonfiction') return NONFICTION_GENRES;
  return [...FICTION_GENRES, ...NONFICTION_GENRES];
}

// ─── Taste questions (3 — minimum meaningful signal) ─────────────────────────

type TasteQ = {
  id:      string;
  prompt:  string;
  optionA: { key: string; headline: string; icon: React.ComponentProps<typeof Ionicons>['name'] };
  optionB: { key: string; headline: string; icon: React.ComponentProps<typeof Ionicons>['name'] };
};

const TASTE_QS: TasteQ[] = [
  {
    id:     'q_what_grips',
    prompt: 'What usually grips you?',
    optionA: { key: 'emotion_driven',  headline: 'Emotion & character', icon: 'heart-outline' },
    optionB: { key: 'idea_driven',     headline: 'Ideas & perspective', icon: 'bulb-outline' },
  },
  {
    id:     'q_pacing',
    prompt: 'Pacing — how important?',
    optionA: { key: 'pacing_non_negotiable', headline: 'Has to move fast',  icon: 'flash-outline' },
    optionB: { key: 'ideas_over_pacing',     headline: 'Depth over speed',  icon: 'telescope-outline' },
  },
  {
    id:     'q_style',
    prompt: 'Literary or accessible?',
    optionA: { key: 'literary_leaning',   headline: 'Literary & ambitious',    icon: 'library-outline' },
    optionB: { key: 'commercial_leaning', headline: 'Readable & page-turning', icon: 'people-outline' },
  },
];

// ─── Google Books search ──────────────────────────────────────────────────────

const GB_KEY =
  typeof process.env?.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY === 'string' &&
  process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim().length > 0
    ? process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim()
    : null;

async function searchGB(query: string): Promise<GBResult[]> {
  if (!query.trim() || !GB_KEY) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=8&key=${GB_KEY}`;
  try {
    const json = await (await fetch(url)).json();
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

// ─── Save quick intake to Supabase ────────────────────────────────────────────

async function saveQuickIntake(intake: IntakeState): Promise<void> {
  if (!supabase) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const behavioralMeta: Record<string, string> = {
    b_fiction_split:    intake.fictionSplit,
    intake_completed:   'true',
  };

  await supabase.from('reader_preferences').upsert(
    {
      user_id:           user.id,
      favorite_genres:   intake.likedGenres,
      avoid_genres:      [],
      diagnosis_answers: { ...intake.tasteAnswers, ...behavioralMeta },
      updated_at:        new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  // Save anchor book as finished + 5★ if provided
  if (intake.anchorBook) {
    const ab     = intake.anchorBook;
    const extId  = `gb_${ab.id}`;
    const bookData = {
      external_id: extId,
      title:       ab.title,
      author:      ab.author,
      cover_url:   ab.cover,
      description: null as null,
      subjects:    ab.subjects,
      source:      'intake',
    };
    const { data: existing } = await supabase.from('books').select('id').eq('external_id', extId).maybeSingle();
    let bookId = existing?.id as string | undefined;
    if (!bookId) {
      const { data: inserted } = await supabase.from('books').insert(bookData).select('id').single();
      bookId = inserted?.id;
    }
    if (bookId) {
      await supabase.from('user_books').upsert(
        { user_id: user.id, book_id: bookId, status: 'finished', rating: 5 },
        { onConflict: 'user_id,book_id' },
      );
    }
  }
}

// ─── Shared atoms ─────────────────────────────────────────────────────────────

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={{
        paddingHorizontal: 13,
        paddingVertical:   8,
        borderRadius:      20,
        borderWidth:       1.5,
        borderColor:       active ? INK : BORD,
        backgroundColor:   active ? INK + '18' : '#fff',
        flexDirection:     'row',
        alignItems:        'center',
        gap:               5,
      }}
    >
      {active && <Ionicons name="checkmark" size={11} color={INK} />}
      <Text style={{ fontSize: 13, fontWeight: active ? '600' : '400', color: active ? INK : SUB }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function BtnPrimary({ label, onPress, color = INK }: { label: string; onPress: () => void; color?: string }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        backgroundColor: color,
        borderRadius:    14,
        paddingVertical: 15,
        alignItems:      'center',
      }}
    >
      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Entry screen (3 options) ─────────────────────────────────────────────────

function EntryOptions({
  onImport,
  onIntake,
  onExplore,
}: {
  onImport:  () => void;
  onIntake:  () => void;
  onExplore: () => void;
}) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 36, paddingBottom: 48 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <Text style={{
        fontSize: 30, fontWeight: '800', color: INK,
        lineHeight: 36, letterSpacing: -0.5, marginBottom: 10,
      }}>
        Get picks worth reading.
      </Text>
      <Text style={{ fontSize: 15, color: SUB, lineHeight: 23, marginBottom: 36 }}>
        Your reading history is the fastest signal. Import it and we tune your picks from day one — or take 90 seconds to tell us your taste.
      </Text>

      {/* Option A — Import (primary) */}
      <TouchableOpacity
        onPress={onImport}
        activeOpacity={0.82}
        style={{
          backgroundColor: INK,
          borderRadius:    18,
          padding:         22,
          marginBottom:    10,
        }}
      >
        {/* Top row: icon + label + chevron */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
          <View style={{
            width: 46, height: 46, borderRadius: 23,
            backgroundColor: '#ffffff14',
            alignItems: 'center', justifyContent: 'center',
            marginTop: 1,
          }}>
            <Ionicons name="cloud-download-outline" size={22} color="#fff" />
          </View>

          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: '#fff', lineHeight: 22, marginBottom: 4 }}>
              Import my library
            </Text>
            <Text style={{ fontSize: 13, color: '#c4bfb9', lineHeight: 19 }}>
              Goodreads or StoryGraph — bring in your reading history and we'll know your taste immediately.
            </Text>
          </View>

          <Ionicons name="chevron-forward" size={18} color="#78716c" style={{ marginTop: 3 }} />
        </View>

        {/* Badge */}
        <View style={{
          marginTop: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          backgroundColor: '#ffffff0d',
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          alignSelf: 'flex-start',
        }}>
          <Ionicons name="checkmark-circle-outline" size={13} color="#86efac" />
          <Text style={{ fontSize: 12, fontWeight: '600', color: '#86efac', letterSpacing: 0.1 }}>
            Best results · no setup required
          </Text>
        </View>
      </TouchableOpacity>

      {/* Option B — Quick intake */}
      <TouchableOpacity
        onPress={onIntake}
        activeOpacity={0.8}
        style={{
          backgroundColor: '#fff',
          borderRadius:    18,
          borderWidth:     1.5,
          borderColor:     BORD,
          padding:         20,
          marginBottom:    10,
          flexDirection:   'row',
          alignItems:      'flex-start',
          gap:             14,
        }}
      >
        <View style={{
          width: 46, height: 46, borderRadius: 23,
          backgroundColor: '#f5f5f4',
          alignItems: 'center', justifyContent: 'center',
          marginTop: 1,
        }}>
          <Ionicons name="options-outline" size={20} color={INK} />
        </View>

        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: INK, lineHeight: 22, marginBottom: 4 }}>
            Answer a few questions
          </Text>
          <Text style={{ fontSize: 13, color: SUB, lineHeight: 19 }}>
            Genres, pacing, style — takes under 90 seconds.
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={18} color={MUTED} style={{ marginTop: 3 }} />
      </TouchableOpacity>

      {/* Option C — Not right now (tertiary) */}
      <TouchableOpacity
        onPress={onExplore}
        activeOpacity={0.7}
        style={{ alignItems: 'center', paddingVertical: 18 }}
      >
        <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500' }}>
          Not right now →
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── Quick intake: genres screen ─────────────────────────────────────────────

function IntakeGenres({
  intake,
  onContinue,
  onSkip,
}: {
  intake:     IntakeState;
  onContinue: (split: IntakeState['fictionSplit'], liked: string[]) => void;
  onSkip:     () => void;
}) {
  const [split, setSplit] = useState<IntakeState['fictionSplit']>(intake.fictionSplit);
  const [liked, setLiked] = useState<string[]>(intake.likedGenres);

  const genres = getGenres(split);

  function handleSplitChange(s: IntakeState['fictionSplit']) {
    setSplit(s);
    const labels = new Set(getGenres(s).map(g => g.label));
    setLiked(prev => prev.filter(l => labels.has(l)));
  }

  const splitOpts: { key: IntakeState['fictionSplit']; label: string }[] = [
    { key: 'fiction',    label: 'Fiction' },
    { key: 'nonfiction', label: 'Nonfiction' },
    { key: 'both',       label: 'Both' },
  ];

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {[1, 2, 3].map(i => (
              <View key={i} style={{ width: i === 1 ? 22 : 6, height: 6, borderRadius: 3, backgroundColor: i <= 1 ? INK : BORD }} />
            ))}
          </View>
          <TouchableOpacity onPress={onSkip}>
            <Text style={{ fontSize: 13, color: MUTED }}>Skip all →</Text>
          </TouchableOpacity>
        </View>
        <Text style={{ fontSize: 24, fontWeight: '800', color: INK, lineHeight: 30, marginTop: 8 }}>
          What are you drawn to?
        </Text>

        {/* Split tab strip */}
        <View
          style={{
            flexDirection:   'row',
            backgroundColor: '#f5f5f4',
            borderRadius:    10,
            padding:         3,
            marginTop:       16,
          }}
        >
          {splitOpts.map(opt => (
            <TouchableOpacity
              key={opt.key}
              onPress={() => handleSplitChange(opt.key)}
              activeOpacity={0.75}
              style={{
                flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center',
                backgroundColor: split === opt.key ? '#fff' : 'transparent',
                elevation: split === opt.key ? 1 : 0,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: split === opt.key ? '700' : '500', color: split === opt.key ? INK : SUB }}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
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

      <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: BG, borderTopWidth: 1, borderTopColor: BORD, padding: 16 }}>
        <BtnPrimary label={liked.length > 0 ? 'Continue →' : 'Skip →'} onPress={() => onContinue(split, liked)} />
      </View>
    </View>
  );
}

// ─── Quick intake: taste screen (3 questions, auto-advance) ───────────────────

function IntakeTaste({
  onComplete,
  onSkip,
}: {
  onComplete: (answers: Record<string, string>) => void;
  onSkip:     () => void;
}) {
  const [qIdx,    setQIdx]    = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const slideAnim = useRef(new Animated.Value(0)).current;

  const q = TASTE_QS[qIdx];

  function animNext(nextIdx: number) {
    Animated.sequence([
      Animated.timing(slideAnim, { toValue: -10, duration: 80,  useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0,   duration: 150, useNativeDriver: true }),
    ]).start();
    setTimeout(() => setQIdx(nextIdx), 80);
  }

  function handlePick(key: string) {
    const next = { ...answers, [q.id]: key };
    setAnswers(next);
    riTasteAnswered(q.id, key);
    if (qIdx + 1 < TASTE_QS.length) {
      animNext(qIdx + 1);
    } else {
      onComplete(next);
    }
  }

  function handleSkipOne() {
    riTasteSkipped();
    if (qIdx + 1 < TASTE_QS.length) {
      animNext(qIdx + 1);
    } else {
      onComplete(answers);
    }
  }

  return (
    <View style={{ flex: 1, paddingHorizontal: 20 }}>
      {/* Progress */}
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 4 }}>
        {[1, 2, 3].map(i => (
          <View key={i} style={{ width: i === 2 ? 22 : 6, height: 6, borderRadius: 3, backgroundColor: i <= 2 ? INK : BORD }} />
        ))}
      </View>

      {/* Taste sub-progress */}
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 20 }}>
        {TASTE_QS.map((_, i) => (
          <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= qIdx ? INK : BORD }} />
        ))}
      </View>

      <Animated.View style={{ transform: [{ translateY: slideAnim }] }}>
        <Text style={{ fontSize: 22, fontWeight: '800', color: INK, lineHeight: 28, marginBottom: 20 }}>
          {q.prompt}
        </Text>

        {[q.optionA, q.optionB].map(opt => (
          <TouchableOpacity
            key={opt.key}
            onPress={() => handlePick(opt.key)}
            activeOpacity={0.75}
            style={{
              backgroundColor: '#fff',
              borderRadius:    14,
              borderWidth:     1.5,
              borderColor:     BORD,
              padding:         16,
              marginBottom:    10,
              flexDirection:   'row',
              alignItems:      'center',
              gap:             12,
            }}
          >
            <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: '#f5f5f4', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={opt.icon} size={18} color={INK} />
            </View>
            <Text style={{ fontSize: 15, fontWeight: '600', color: INK, flex: 1 }}>{opt.headline}</Text>
          </TouchableOpacity>
        ))}
      </Animated.View>

      <View style={{ alignItems: 'center', marginTop: 8, gap: 10 }}>
        <TouchableOpacity onPress={handleSkipOne} hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}>
          <Text style={{ fontSize: 14, color: MUTED }}>Skip this →</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { riTasteSkipped(); onSkip(); }} hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}>
          <Text style={{ fontSize: 13, color: BORD }}>Skip remaining</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Quick intake: anchor book screen ────────────────────────────────────────

function IntakeAnchor({
  onComplete,
  onSkip,
}: {
  onComplete: (book: GBResult | null) => void;
  onSkip:     () => void;
}) {
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
      riAnchorSearched();
      setResults(await searchGB(query));
      setLoading(false);
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16 }}>
        {/* Progress */}
        <View style={{ flexDirection: 'row', gap: 4, marginBottom: 8 }}>
          {[1, 2, 3].map(i => (
            <View key={i} style={{ width: 22, height: 6, borderRadius: 3, backgroundColor: INK }} />
          ))}
        </View>
        <Text style={{ fontSize: 22, fontWeight: '800', color: INK, lineHeight: 28 }}>
          One book that nailed it?
        </Text>
        <Text style={{ fontSize: 14, color: SUB, marginTop: 6, lineHeight: 20 }}>
          Optional — a book you've loved is our strongest cold-start signal.
        </Text>
      </View>

      {/* Search input */}
      <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, borderWidth: 1.5, borderColor: BORD, paddingHorizontal: 12, gap: 8 }}>
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
        <View style={{ marginHorizontal: 20, marginBottom: 12, backgroundColor: GRN + '14', borderRadius: 12, borderWidth: 1.5, borderColor: GRN + '44', padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
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
          ListEmptyComponent={loading ? <View style={{ padding: 20, alignItems: 'center' }}><ActivityIndicator size="small" color={MUTED} /></View> : null}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => { setSelected(item); Keyboard.dismiss(); riAnchorSelected(item.title); }}
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: BORD, gap: 12 }}
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

      <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: BG, borderTopWidth: 1, borderTopColor: BORD, padding: 16, gap: 10 }}>
        <BtnPrimary
          label={selected ? 'Build my picks →' : 'Skip →'}
          onPress={() => {
            if (!selected) riAnchorSkipped();
            onComplete(selected);
          }}
        />
      </View>
    </View>
  );
}

// ─── Saving overlay ───────────────────────────────────────────────────────────

function SavingOverlay() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
      <ActivityIndicator size="large" color={INK} />
      <Text style={{ fontSize: 16, fontWeight: '600', color: INK }}>Building your picks...</Text>
      <Text style={{ fontSize: 13, color: SUB }}>This takes a moment</Text>
    </View>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

type Phase = 'options' | 'intake_genres' | 'intake_taste' | 'intake_anchor' | 'saving';

export function RecEntryScreen({
  onDone,
  initialPhase,
}: {
  onDone: () => void;
  initialPhase?: Phase;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(initialPhase ?? 'options');
  const [intake, setIntake] = useState<IntakeState>({
    fictionSplit: 'both',
    likedGenres:  [],
    tasteAnswers: {},
    anchorBook:   null,
  });

  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => { reEntryShown(); }, []);

  function goTo(next: Phase) {
    Animated.timing(fadeAnim, { toValue: 0, duration: 90, useNativeDriver: true }).start(() => {
      setPhase(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    });
  }

  async function handleImport() {
    reImportTapped();
    await markRecEntrySeen();
    router.push('/import/goodreads');
    onDone(); // transition hub behind the pushed screen
  }

  function handleStartIntake() {
    reIntakeStarted();
    goTo('intake_genres');
  }

  async function handleExplore() {
    reExploreTapped();
    await markRecEntrySeen();
    onDone();
  }

  function handleGenresContinue(split: IntakeState['fictionSplit'], liked: string[]) {
    setIntake(prev => ({ ...prev, fictionSplit: split, likedGenres: liked }));
    goTo('intake_taste');
  }

  function handleTasteComplete(tasteAnswers: Record<string, string>) {
    setIntake(prev => ({ ...prev, tasteAnswers }));
    goTo('intake_anchor');
  }

  async function handleAnchorComplete(anchorBook: GBResult | null) {
    const finalIntake = { ...intake, anchorBook };
    goTo('saving');

    await saveQuickIntake(finalIntake);
    await markRecEntrySeen();

    reIntakeCompleted(
      finalIntake.likedGenres.length,
      Object.keys(finalIntake.tasteAnswers).length,
      anchorBook !== null,
    );

    onDone();
  }

  async function handleSkipIntake(atStep: string) {
    reIntakeSkipped(atStep);
    // Save whatever has been collected so far
    if (Object.keys(intake.tasteAnswers).length > 0 || intake.likedGenres.length > 0) {
      await saveQuickIntake(intake);
    }
    await markRecEntrySeen();
    onDone();
  }

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        {phase === 'options' && (
          <EntryOptions
            onImport={handleImport}
            onIntake={handleStartIntake}
            onExplore={handleExplore}
          />
        )}
        {phase === 'intake_genres' && (
          <IntakeGenres
            intake={intake}
            onContinue={handleGenresContinue}
            onSkip={() => handleSkipIntake('genres')}
          />
        )}
        {phase === 'intake_taste' && (
          <IntakeTaste
            onComplete={handleTasteComplete}
            onSkip={() => handleSkipIntake('taste')}
          />
        )}
        {phase === 'intake_anchor' && (
          <IntakeAnchor
            onComplete={handleAnchorComplete}
            onSkip={() => handleSkipIntake('anchor')}
          />
        )}
        {phase === 'saving' && <SavingOverlay />}
      </Animated.View>
    </View>
  );
}
