import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { BackButton } from '../components/BackButton';
import { supabase } from '../lib/supabase';
import { clearRecSession } from '../lib/recSession';
import { clearRecPayload } from '../lib/recPayloadCache';
import { clearAll as clearRecQueue } from '../lib/recQueue';
import { setPendingBuildCause } from '../lib/recRequest';
import { invalidateTasteCaches } from '../lib/tabCache';
import { EDIT_GENRE_IDS, editLabel } from '../lib/taxonomy/genres';

// P0A: chip labels are derived from the canonical taxonomy. Order is
// preserved by EDIT_GENRE_IDS in lib/taxonomy/genres.ts.
const GENRES: string[] = EDIT_GENRE_IDS.map(editLabel);

const STYLES = [
  'Fast-paced', 'Slow-burn', 'Character-driven', 'Plot-driven',
  'Dense prose', 'Light read', 'Dark themes', 'Funny / Witty',
  'Reflective', 'Action-packed',
];

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#9e958d',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 12,
    }}>
      {children}
    </Text>
  );
}

function ChipGroup({
  options,
  selected,
  onToggle,
  activeColor,
}: {
  options: string[];
  selected: string[];
  onToggle: (val: string) => void;
  activeColor: string;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
      {options.map(opt => {
        const active = selected.includes(opt);
        return (
          <TouchableOpacity
            key={opt}
            onPress={() => onToggle(opt)}
            style={{
              paddingHorizontal: 13,
              paddingVertical: 8,
              borderRadius: 20,
              borderWidth: 1.5,
              borderColor: active ? activeColor : '#ede9e4',
              backgroundColor: active ? activeColor + '22' : '#fff',
            }}
          >
            <Text style={{
              fontSize: 13,
              fontWeight: active ? '600' : '400',
              color: active ? activeColor : '#78716c',
            }}>
              {opt}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function toggle(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];
}

export default function EditPreferencesScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [favoriteGenres, setFavoriteGenres] = useState<string[]>([]);
  const [avoidGenres, setAvoidGenres] = useState<string[]>([]);
  const [readingStyles, setReadingStyles] = useState<string[]>([]);
  const [favoriteAuthors, setFavoriteAuthors] = useState('');

  useEffect(() => {
    async function load() {
      if (!supabase) { setLoading(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      setUserId(user.id);

      const { data } = await supabase
        .from('reader_preferences')
        .select('favorite_genres, avoid_genres, reading_styles, favorite_authors')
        .eq('user_id', user.id)
        .maybeSingle();

      if (data) {
        setFavoriteGenres(data.favorite_genres ?? []);
        setAvoidGenres(data.avoid_genres ?? []);
        setReadingStyles(data.reading_styles ?? []);
        setFavoriteAuthors(data.favorite_authors ?? '');
      }
      setLoading(false);
    }
    load();
  }, []);

  async function handleSave() {
    if (!supabase || !userId) return;
    setSaving(true);
    setSaveSuccess(false);

    const payload = {
      user_id: userId,
      favorite_genres: favoriteGenres,
      avoid_genres: avoidGenres,
      reading_styles: readingStyles,
      favorite_authors: favoriteAuthors.trim() || null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('reader_preferences')
      .upsert(payload, { onConflict: 'user_id' });

    setSaving(false);
    if (!error) {
      // Reading Taste edits change reader_preferences (favorite/avoid genres,
      // reading styles, favorite authors) which feeds into TasteProfile and
      // the recommender pipeline. The For You gate is keyed on
      // strongSignalCount (rated-finished count) and won't re-fire on a
      // pref-only change, so we must explicitly invalidate three separate
      // pieces of stale state:
      //   1. clearRecSession()  — in-memory session cache (recSession.ts)
      //   2. clearRecQueue()    — module-level visible-card queue (recQueue.ts).
      //                           CRITICAL: recQueue is independent of recSession.
      //                           Without this, RecommendationsFeed's runPipeline
      //                           sees getQueueDepth() > 0 and APPENDS the fresh
      //                           pref-aware books to the tail of the queue, so
      //                           getVisibleStack().slice(0, 4) still returns the
      //                           pre-save head and the user sees identical stale
      //                           cards even though the pipeline ran correctly.
      //   3. clearRecPayload()  — persisted AsyncStorage payload (so a future
      //                           cold start cannot restore the pre-save deck).
      // RecommendationsFeed's useFocusEffect detects the missing session on
      // next tab visit and triggers runPipeline() — with an empty queue,
      // runPipeline now hits the `initQueue(newEntries)` branch and fully
      // replaces the visible stack with fresh-pref recs.
      // Fire-and-forget the AsyncStorage clear so we don't delay the back-nav
      // on slow storage; both in-memory clears are synchronous so they take
      // effect before router.back() fires.
      clearRecSession();
      clearRecQueue();
      void clearRecPayload(userId);
      // Responsiveness polish: also drop the UI-layer snapshots that
      // staleness-cache the previous favorite/avoid genres.
      //   • Profile `_profileCache` (60 s staleness guard) — without this
      //     drop, the Profile pills would not update until the cache window
      //     expired or the user pull-to-refreshed.
      //   • Search/For-You `_hubCache.tasteProfile` — without this drop, the
      //     next focus would re-seed tasteProfile from the pre-edit snapshot
      //     and RecommendationsFeed could rebuild against stale genres.
      // Both clearers live in their tab modules (registered with the 'taste'
      // tag on lib/tabCache), so this is a single coordinated invalidation.
      invalidateTasteCaches();
      // P1: tag the next runPipeline() as caused by an explicit preference
      // edit so RecRequest.build.cause = 'explicit_preference_edit'. Module
      // state self-clears on first consume — no leakage into subsequent runs.
      setPendingBuildCause('explicit_preference_edit');
      if (__DEV__) console.log('[P2DEBUG/save]',
        `cause=explicit_preference_edit`,
        `genres=${JSON.stringify(favoriteGenres)}`,
        `styles=${JSON.stringify(readingStyles)}`,
        `avoid=${JSON.stringify(avoidGenres)}`,
      );
      setSaveSuccess(true);
      setTimeout(() => router.back(), 700);
    }
  }

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f5f1ec' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f5f1ec' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 56 }}
      keyboardShouldPersistTaps="handled"
    >
      <BackButton onPress={() => router.back()} style={{ marginBottom: 20 }} />

      <Text style={{
        fontSize: 28,
        fontWeight: '800',
        color: '#231f1b',
        letterSpacing: -0.5,
        marginBottom: 6,
      }}>
        Reading Taste
      </Text>
      <Text style={{ fontSize: 14, color: '#9e958d', marginBottom: 32, lineHeight: 21 }}>
        Tell us what you enjoy. This helps us understand your taste — and will power fit insights for books you're considering.
      </Text>

      {/* ── Genres I enjoy ── */}
      <SectionLabel>Genres I tend to enjoy</SectionLabel>
      <ChipGroup
        options={GENRES}
        selected={favoriteGenres}
        onToggle={val => setFavoriteGenres(prev => toggle(prev, val))}
        activeColor="#231f1b"
      />

      {/* ── Genres I skip ── */}
      <SectionLabel>Genres I usually skip</SectionLabel>
      <ChipGroup
        options={GENRES}
        selected={avoidGenres}
        onToggle={val => setAvoidGenres(prev => toggle(prev, val))}
        activeColor="#b91c1c"
      />

      {/* ── Reading style ── */}
      <SectionLabel>Reading style I prefer</SectionLabel>
      <ChipGroup
        options={STYLES}
        selected={readingStyles}
        onToggle={val => setReadingStyles(prev => toggle(prev, val))}
        activeColor="#1d4ed8"
      />

      {/* ── Favorite authors ── */}
      <SectionLabel>Authors I love</SectionLabel>
      <View style={{
        backgroundColor: '#fff',
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 10,
        marginBottom: 36,
        shadowColor: '#000',
        shadowOpacity: 0.04,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 1 },
        elevation: 1,
      }}>
        <TextInput
          value={favoriteAuthors}
          onChangeText={setFavoriteAuthors}
          placeholder="e.g. Kazuo Ishiguro, Toni Morrison, Elena Ferrante"
          placeholderTextColor="#9e958d"
          multiline
          style={{ fontSize: 14, color: '#231f1b', lineHeight: 22, minHeight: 56 }}
        />
      </View>

      {/* ── Save ── */}
      <TouchableOpacity
        onPress={handleSave}
        disabled={saving || saveSuccess}
        style={{
          backgroundColor: saveSuccess ? '#2f6f3a' : saving ? '#ede9e4' : '#231f1b',
          borderRadius: 13,
          paddingVertical: 16,
          alignItems: 'center',
        }}
      >
        {saving ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
            {saveSuccess ? 'Saved ✓' : 'Save Preferences'}
          </Text>
        )}
      </TouchableOpacity>

      {favoriteGenres.length === 0 && avoidGenres.length === 0 && readingStyles.length === 0 && !favoriteAuthors && (
        <Text style={{ fontSize: 12, color: '#9e958d', textAlign: 'center', marginTop: 16, lineHeight: 18 }}>
          No selections yet — tap any chip above to start building your taste profile.
        </Text>
      )}
    </ScrollView>
  );
}
