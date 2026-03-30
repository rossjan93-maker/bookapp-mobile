import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { scoreAndFilterBooks, mergeBookResults } from '../../lib/searchRanking';
import { expandAlias } from '../../lib/searchAliases';
import {
  type BookResult,
  fetchGoogleBooks,
  resolveOLKeyFromIsbn,
  _dedupKey,
  hybridMerge,
} from '../../lib/bookSearch';
import { CoverThumb } from '../../components/CoverThumb';
import { getDisplayName, getFirstName } from '../../lib/displayName';
import { computeTasteProfile } from '../../lib/tasteProfile';
import type { TasteProfile } from '../../lib/tasteProfile';
import { loadFeedbackContext, emptyContext } from '../../lib/recFeedback';
import type { FeedbackContext } from '../../lib/recFeedback';
import { getEntitlement } from '../../lib/recEntitlement';
import type { RecEntitlement } from '../../lib/recEntitlement';
import { useGuidedTour } from '../../components/OnboardingWalkthrough';
import { useWalkthrough, registerWtTarget, wtEvt_recStepReached } from '../../lib/walkthroughEngine';
import { getRecSession, clearRecSession } from '../../lib/recSession';
import { registerCacheClearer } from '../../lib/tabCache';
import { RecommendationsFeed } from '../../components/RecommendationsFeed';
import { RecEntryScreen, hasSeenRecEntry } from '../../components/RecEntryScreen';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'hub' | 'entry' | 'search' | 'friends' | 'done';

// BookResult is imported from lib/bookSearch

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
  subjects: string[] | null;
};

type BookToTag = {
  id: string;
  book_id: string;
  title: string;
  author: string;
  cover_url: string | null;
  external_id: string | null;
  subjects: string[] | null;
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

// fetchGoogleBooks, resolveOLKeyFromIsbn, _dedupKey, hybridMerge
// are imported from lib/bookSearch (shared with add-book.tsx).

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

// ─── Card shell ───────────────────────────────────────────────────────────────

const CARD_STYLE = {
  backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' as const,
  shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6,
  shadowOffset: { width: 0, height: 2 }, elevation: 2,
};

// ─── Book-aware trait library ─────────────────────────────────────────────────

const TRAITS: Record<string, string[]> = {
  fantasy_scifi:    ['Worldbuilding', 'Characters', 'Pacing', 'Atmosphere', 'Tension', 'Ending', 'Originality', 'Scope'],
  thriller_mystery: ['Suspense', 'Pacing', 'Twists', 'Ending', 'Tension', 'Characters', 'Atmosphere', 'Plot'],
  romance:          ['Chemistry', 'Emotional payoff', 'Pacing', 'Writing', 'Characters', 'Ending', 'Tension', 'Depth'],
  horror:           ['Atmosphere', 'Tension', 'Pacing', 'Characters', 'Ending', 'Originality', 'Suspense', 'Worldbuilding'],
  memoir_bio:       ['Honesty', 'Insight', 'Perspective', 'Writing', 'Depth', 'Structure', 'Pacing', 'Ending'],
  nonfiction:       ['Insight', 'Clarity', 'Structure', 'Evidence', 'Practicality', 'Originality', 'Depth', 'Writing'],
  literary:         ['Prose', 'Characters', 'Pacing', 'Atmosphere', 'Emotional', 'Originality', 'Ending', 'Depth'],
  general:          ['Pacing', 'Characters', 'Writing', 'Atmosphere', 'Ending', 'Originality', 'Emotional', 'Suspense'],
};

// Ordered by specificity — first match wins
const GENRE_SIGNALS: Array<[string, string[]]> = [
  ['memoir_bio',       ['memoir', 'autobiography', 'biography', 'biographical']],
  ['nonfiction',       ['nonfiction', 'non-fiction', 'self-help', 'business', 'economics',
                        'psychology', 'science', 'history', 'philosophy', 'technology',
                        'politics', 'sociology', 'true crime']],
  ['horror',           ['horror', 'gothic', 'ghost story', 'supernatural', 'occult',
                        'vampire', 'zombie']],
  ['romance',          ['romance', 'romantic fiction', 'love story', "women's fiction",
                        'chick lit']],
  ['thriller_mystery', ['thriller', 'mystery', 'crime fiction', 'detective', 'suspense',
                        'noir', 'whodunit', 'spy fiction']],
  ['fantasy_scifi',    ['fantasy', 'science fiction', 'sci-fi', 'speculative fiction',
                        'dystopian', 'magical realism', 'space opera', 'epic fantasy',
                        'urban fantasy', 'alternate history']],
  ['literary',         ['literary fiction', 'literary', 'contemporary fiction']],
];

function getBookAwareTraits(book: { subjects?: string[] | null; title?: string; author?: string }): string[] {
  // Build a single corpus from all available text metadata
  const corpus = [
    ...(book.subjects ?? []),
    book.title ?? '',
    book.author ?? '',
  ].join(' ').toLowerCase();

  for (const [genre, signals] of GENRE_SIGNALS) {
    if (signals.some(s => corpus.includes(s))) return TRAITS[genre];
  }
  return TRAITS.general;
}

// ─── Skeleton loading card ────────────────────────────────────────────────────

function SkeletonCard() {
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1,    duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 900, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  return (
    <Animated.View style={[CARD_STYLE, { opacity: pulse, overflow: 'hidden' }]}>
      {/* Content row */}
      <View style={{ padding: 12, flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ width: 44, height: 64, borderRadius: 5, backgroundColor: '#e8e5e1' }} />
        <View style={{ marginLeft: 12, flex: 1, gap: 7 }}>
          <View style={{ height: 14, width: '65%', backgroundColor: '#e8e5e1', borderRadius: 6 }} />
          <View style={{ height: 11, width: '42%', backgroundColor: '#f0ede9', borderRadius: 5 }} />
          <View style={{ height: 11, width: '80%', backgroundColor: '#f0ede9', borderRadius: 5 }} />
        </View>
      </View>
      {/* Action bar — mirrors RecCard's Want to Read / Not for me / More like this structure */}
      <View style={{ borderTopWidth: 1, borderTopColor: '#f0ede9', flexDirection: 'row', alignItems: 'stretch' }}>
        <View style={{
          flex: 1, paddingVertical: 14, paddingHorizontal: 14, justifyContent: 'center',
          borderRightWidth: 1, borderRightColor: '#f0ede9',
        }}>
          <View style={{ width: '60%', height: 11, borderRadius: 5, backgroundColor: '#e8e5e1' }} />
        </View>
        <View style={{
          paddingVertical: 14, paddingHorizontal: 13, justifyContent: 'center', alignItems: 'center',
          borderRightWidth: 1, borderRightColor: '#f0ede9',
        }}>
          <View style={{ width: 56, height: 11, borderRadius: 5, backgroundColor: '#f0ede9' }} />
        </View>
        <View style={{ paddingVertical: 14, paddingHorizontal: 13, justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ width: 64, height: 11, borderRadius: 5, backgroundColor: '#f0ede9' }} />
        </View>
      </View>
    </Animated.View>
  );
}

// ─── TagPanel — shared chip renderer ─────────────────────────────────────────

function TagPanel({
  tags,
  likedTags,
  dislikedTags,
  onLikedChange,
  onDislikedChange,
}: {
  tags: string[];
  likedTags: string[];
  dislikedTags: string[];
  onLikedChange: (t: string[]) => void;
  onDislikedChange: (t: string[]) => void;
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
              {tags.map(tag => {
                const isSel = selected.includes(tag);
                return (
                  <TouchableOpacity
                    key={tag}
                    activeOpacity={0.7}
                    onPress={() => toggle(tag, isLiked ? 'liked' : 'disliked')}
                    style={{
                      paddingHorizontal: 11, paddingVertical: 6, borderRadius: 20,
                      backgroundColor: isSel ? '#1c1917' : '#f5f5f4',
                      borderWidth: 1, borderColor: isSel ? '#1c1917' : '#e7e5e4',
                    }}
                  >
                    <Text style={{
                      fontSize: 12,
                      color: isSel ? '#fff' : '#57534e',
                      fontWeight: isSel ? '600' : '400',
                    }}>
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

// ─── Shared card header row ───────────────────────────────────────────────────

function BookRow({ book, rating, small }: { book: BookToRate | BookToTag; rating?: number; small?: boolean }) {
  const cW = small ? 28 : 36;
  const cH = small ? 40 : 52;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <CoverThumb url={book.cover_url} externalId={book.external_id} title={book.title} width={cW} height={cH} />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={{ fontSize: small ? 13 : 14, fontWeight: '600', color: '#1c1917', lineHeight: small ? 18 : 20 }} numberOfLines={1}>
          {book.title}
        </Text>
        <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }} numberOfLines={1}>
          {book.author}
        </Text>
      </View>
      {rating != null && rating > 0 && (
        <View style={{ flexDirection: 'row', gap: 1 }}>
          {[1, 2, 3, 4, 5].map(s => (
            <Text key={s} style={{ fontSize: 11, color: s <= rating ? '#f59e0b' : '#e7e5e4' }}>★</Text>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Action row ───────────────────────────────────────────────────────────────

function ActionRow({
  onSecondary, secondaryLabel,
  onPrimary, primaryLabel, loading,
}: {
  onSecondary: () => void; secondaryLabel: string;
  onPrimary: () => void; primaryLabel: string; loading?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
      <TouchableOpacity
        activeOpacity={0.65}
        onPress={onSecondary}
        style={{
          flex: 1, paddingVertical: 10, borderRadius: 8,
          borderWidth: 1, borderColor: '#e7e5e4', alignItems: 'center',
        }}
      >
        <Text style={{ fontSize: 13, color: '#78716c' }}>{secondaryLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onPrimary}
        disabled={loading}
        style={{
          flex: 2, paddingVertical: 10, borderRadius: 8,
          backgroundColor: '#1c1917', alignItems: 'center',
        }}
      >
        {loading
          ? <ActivityIndicator size="small" color="#fff" />
          : <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>{primaryLabel}</Text>
        }
      </TouchableOpacity>
    </View>
  );
}

// ─── RateCard — rate → notes → reactions, with premium transitions ────────────

type RateCardProps = { book: BookToRate; onComplete: (id: string) => void };
type RateMode = 'rate' | 'notes' | 'tags';

function RateCard({ book, onComplete }: RateCardProps) {
  const [mode, setMode]             = useState<RateMode>('rate');
  const [rating, setRating]         = useState(0);
  const [pendingRating, setPending] = useState(0);
  const [saving, setSaving]         = useState(false);
  const [noteText, setNoteText]     = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [likedTags, setLiked]       = useState<string[]>([]);
  const [dislikedTags, setDisliked] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Card-level removal animation
  const cardOpacity = useRef(new Animated.Value(1)).current;
  const cardScale   = useRef(new Animated.Value(1)).current;

  // Body content crossfade: fades old content out, new content in
  const bodyOpacity   = useRef(new Animated.Value(1)).current;
  const bodyTranslate = useRef(new Animated.Value(0)).current;

  const bookTraits = getBookAwareTraits(book);

  // Crossfade body content between modes
  function transitionMode(nextMode: RateMode) {
    // 1. Fade + slide up existing content
    Animated.parallel([
      Animated.timing(bodyOpacity,   { toValue: 0, duration: 110, useNativeDriver: true }),
      Animated.timing(bodyTranslate, { toValue: -8, duration: 110, useNativeDriver: true }),
    ]).start(() => {
      // 2. Position new content below, swap mode
      bodyTranslate.setValue(10);
      setMode(nextMode);
      // 3. Fade + slide up new content
      Animated.parallel([
        Animated.timing(bodyOpacity,   { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(bodyTranslate, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    });
  }

  // Fade + scale card out before removing
  function completeCard() {
    Animated.parallel([
      Animated.timing(cardOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.spring(cardScale,   { toValue: 0.97, useNativeDriver: true, bounciness: 0, speed: 22 }),
    ]).start(() => onComplete(book.id));
  }

  async function handleRate(star: number) {
    if (!supabase || saving) return;
    setPending(star);
    setSaving(true);
    const { error } = await supabase.from('user_books').update({ rating: star }).eq('id', book.id);
    setSaving(false);
    if (!error) {
      setRating(star);
      transitionMode('notes');
    }
  }

  async function handleSaveNote() {
    if (savingNote) return;
    const trimmed = noteText.trim();
    if (trimmed && supabase) {
      setSavingNote(true);
      await supabase.from('user_books').update({ review_body: trimmed }).eq('id', book.id);
      setSavingNote(false);
    }
    transitionMode('tags');
  }

  async function handleSaveTags() {
    if (savingTags || !supabase) return;
    setSavingTags(true);
    if (likedTags.length > 0 || dislikedTags.length > 0) {
      await supabase.from('user_books').update({
        taste_tags: { liked: likedTags, didnt_work: dislikedTags },
      }).eq('id', book.id);
    }
    setSavingTags(false);
    completeCard();
  }

  return (
    <Animated.View style={[CARD_STYLE, { opacity: cardOpacity, transform: [{ scale: cardScale }] }]}>
      {/* ── Persistent header ── */}
      <View style={{
        paddingVertical: 9, paddingHorizontal: 12,
        borderBottomWidth: mode !== 'rate' ? 1 : 0,
        borderBottomColor: '#f5f5f4',
      }}>
        <BookRow book={book} rating={mode !== 'rate' ? rating : undefined} small />

        {mode === 'rate' && (
          <View style={{ flexDirection: 'row', gap: 2, marginTop: 7, paddingLeft: 38 }}>
            {[1, 2, 3, 4, 5].map(star => (
              <TouchableOpacity
                key={star}
                activeOpacity={0.7}
                onPress={() => handleRate(star)}
                disabled={saving}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              >
                <Text style={{
                  fontSize: 22,
                  color: star <= (pendingRating || rating) ? '#f59e0b' : '#d6d3d1',
                }}>★</Text>
              </TouchableOpacity>
            ))}
            {saving && (
              <ActivityIndicator
                size="small"
                color="#a8a29e"
                style={{ marginLeft: 8, alignSelf: 'center' }}
              />
            )}
          </View>
        )}
      </View>

      {/* ── Animated body (notes + tags steps) ── */}
      {mode !== 'rate' && (
        <Animated.View style={{
          opacity: bodyOpacity,
          transform: [{ translateY: bodyTranslate }],
          padding: 14,
        }}>
          {mode === 'notes' && (
            <>
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 10 }}>
                What worked or didn't?
              </Text>
              <TextInput
                value={noteText}
                onChangeText={setNoteText}
                placeholder="A sentence or two is plenty…"
                placeholderTextColor="#c4b5a5"
                multiline
                numberOfLines={3}
                style={{
                  backgroundColor: '#faf9f7', borderRadius: 10,
                  paddingHorizontal: 12, paddingVertical: 10,
                  fontSize: 14, color: '#1c1917',
                  borderWidth: 1, borderColor: '#e7e5e4',
                  marginBottom: 12, minHeight: 72, textAlignVertical: 'top',
                }}
              />
              <ActionRow
                onSecondary={() => transitionMode('tags')}
                secondaryLabel="Not now"
                onPrimary={handleSaveNote}
                primaryLabel="Save note"
                loading={savingNote}
              />
            </>
          )}

          {mode === 'tags' && (
            <>
              <Text style={{ fontSize: 12, color: '#78716c', marginBottom: 12 }}>
                Quick reactions? (optional)
              </Text>
              <TagPanel
                tags={bookTraits}
                likedTags={likedTags}
                dislikedTags={dislikedTags}
                onLikedChange={setLiked}
                onDislikedChange={setDisliked}
              />
              <ActionRow
                onSecondary={completeCard}
                secondaryLabel="Skip"
                onPrimary={handleSaveTags}
                primaryLabel="Done"
                loading={savingTags}
              />
            </>
          )}
        </Animated.View>
      )}
    </Animated.View>
  );
}

// ─── TagCard — spring expand with note + book-aware reactions ─────────────────

type TagCardProps = { book: BookToTag; onComplete: (id: string) => void };

function TagCard({ book, onComplete }: TagCardProps) {
  const [expanded, setExpanded]   = useState(false);
  const [noteText, setNoteText]   = useState('');
  const [likedTags, setLiked]     = useState<string[]>([]);
  const [dislikedTags, setDisliked] = useState<string[]>([]);
  const [saving, setSaving]       = useState(false);

  const cardOpacity     = useRef(new Animated.Value(1)).current;
  const cardScale       = useRef(new Animated.Value(1)).current;
  const expandProgress  = useRef(new Animated.Value(0)).current;
  const bodyOpacity     = useRef(new Animated.Value(0)).current;

  const bookTraits = getBookAwareTraits(book);

  // maxHeight animation: 0 → 600, driven by spring
  const expandedMaxHeight = expandProgress.interpolate({
    inputRange: [0, 1], outputRange: [0, 600], extrapolate: 'clamp',
  });

  function openCard() {
    setExpanded(true);
    Animated.parallel([
      Animated.spring(expandProgress, {
        toValue: 1, useNativeDriver: false, bounciness: 0, speed: 15,
      }),
      Animated.sequence([
        Animated.delay(80),
        Animated.timing(bodyOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]),
    ]).start();
  }

  function closeCard() {
    Animated.timing(bodyOpacity, { toValue: 0, duration: 100, useNativeDriver: true }).start(() => {
      Animated.spring(expandProgress, {
        toValue: 0, useNativeDriver: false, bounciness: 0, speed: 15,
      }).start(() => setExpanded(false));
    });
  }

  async function handleSave() {
    if (saving || !supabase) return;
    setSaving(true);
    const updates: Record<string, unknown> = {
      taste_tags: { liked: likedTags, didnt_work: dislikedTags },
    };
    const trimmed = noteText.trim();
    if (trimmed) updates.review_body = trimmed;
    await supabase.from('user_books').update(updates).eq('id', book.id);
    setSaving(false);
    Animated.parallel([
      Animated.timing(cardOpacity, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.spring(cardScale,   { toValue: 0.97, useNativeDriver: true, bounciness: 0, speed: 22 }),
    ]).start(() => onComplete(book.id));
  }

  return (
    <Animated.View style={[CARD_STYLE, { opacity: cardOpacity, transform: [{ scale: cardScale }] }]}>
      {/* Header row — always visible */}
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={expanded ? closeCard : openCard}
        style={{
          padding: 12,
          borderBottomWidth: expanded ? 1 : 0,
          borderBottomColor: '#f5f5f4',
        }}
      >
        <BookRow book={book} small />
        {!expanded && (
          <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 5, paddingLeft: 38 }}>
            Tap to add reactions ›
          </Text>
        )}
      </TouchableOpacity>

      {/* Animated expandable body */}
      <Animated.View style={{ maxHeight: expandedMaxHeight, overflow: 'hidden' }}>
        <Animated.View style={{ opacity: bodyOpacity, padding: 14 }}>
          <TextInput
            value={noteText}
            onChangeText={setNoteText}
            placeholder="What worked or didn't? (optional)"
            placeholderTextColor="#c4b5a5"
            multiline
            numberOfLines={2}
            style={{
              backgroundColor: '#faf9f7', borderRadius: 10,
              paddingHorizontal: 12, paddingVertical: 10,
              fontSize: 14, color: '#1c1917',
              borderWidth: 1, borderColor: '#e7e5e4',
              marginBottom: 16, minHeight: 60, textAlignVertical: 'top',
            }}
          />
          <TagPanel
            tags={bookTraits}
            likedTags={likedTags}
            dislikedTags={dislikedTags}
            onLikedChange={setLiked}
            onDislikedChange={setDisliked}
          />
          <ActionRow
            onSecondary={closeCard}
            secondaryLabel="Cancel"
            onPrimary={handleSave}
            primaryLabel="Save"
            loading={saving}
          />
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

// ─── Module-level hub cache ───────────────────────────────────────────────────
// Mirrors the pattern used by Home / Library / Inbox.  Stores Phase-1 data so
// the hub sections (books to rate, incoming recs, sent recs) render immediately
// on return visits instead of showing a skeleton while Phase 1 queries run.

type HubSnapshot = {
  userId:       string;
  booksToRate:  BookToRate[];
  booksToTag:   BookToTag[];
  incomingRecs: IncomingRec[];
  sentRecs:     SentRec[];
  tasteProfile: TasteProfile | null;
  fetchedAt:    number;
};

let _hubCache: HubSnapshot | null = null;

// Clear both caches on sign-out so the next user never sees previous user's data
registerCacheClearer(() => { clearRecSession(); _hubCache = null; });

// ─── Entry check helpers ───────────────────────────────────────────────────────
// Determines whether the Recommendations entry experience should be shown.
// True = show entry. False = go straight to hub.

async function hasPersonalizationSignal(userId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    // Check reader_preferences for any taste/genre signal
    const { data: prefs } = await supabase
      .from('reader_preferences')
      .select('favorite_genres, diagnosis_answers')
      .eq('user_id', userId)
      .maybeSingle();
    if (prefs) {
      const genres  = (prefs.favorite_genres as string[] | null) ?? [];
      const answers = (prefs.diagnosis_answers as Record<string, string> | null) ?? {};
      if (genres.length > 0) return true;
      // intake_completed flag or any non-behavioral key
      if (answers.intake_completed === 'true') return true;
      const tasteKeys = Object.keys(answers).filter(k => !k.startsWith('b_') && k !== 'intake_completed');
      if (tasteKeys.length > 0) return true;
    }
    // Check for any finished books (strongest signal)
    const { count } = await supabase
      .from('user_books')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'finished');
    return (count ?? 0) > 0;
  } catch {
    return false; // on error, don't show entry — assume something exists
  }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RecommendationsScreen() {
  const router = useRouter();
  const { step: guidedStep, advance: advanceGuided } = useGuidedTour();
  const { wtStep, advance: advanceWt } = useWalkthrough();
  const [step, setStep] = useState<Step>('hub');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // ── Hub state ──────────────────────────────────────────────────────────────
  // hubLoading is true only on a cold start with no rec session cache.
  // On return visits, hub sections render immediately from _hubCache.
  const [hubLoading, setHubLoading]           = useState<boolean>(() => !getRecSession());
  const [feedbackCtx, setFeedbackCtx]         = useState<FeedbackContext>(emptyContext());
  const [entitlement, setEntitlement]         = useState<RecEntitlement | null>(null);
  const [booksToRate, setBooksToRate]         = useState<BookToRate[]>(() => _hubCache?.booksToRate ?? []);
  const [booksToTag, setBooksToTag]           = useState<BookToTag[]>(() => _hubCache?.booksToTag ?? []);
  const [incomingRecs, setIncomingRecs]       = useState<IncomingRec[]>(() => _hubCache?.incomingRecs ?? []);
  const [sentRecs, setSentRecs]               = useState<SentRec[]>(() => _hubCache?.sentRecs ?? []);
  const [tasteProfile, setTasteProfile]       = useState<TasteProfile | null>(() => _hubCache?.tasteProfile ?? null);

  // ── Search/send flow state ────────────────────────────────────────────────
  const [query, setQuery]               = useState('');
  const [bookResults, setBookResults]   = useState<BookResult[]>([]);
  const [searching, setSearching]       = useState(false);
  const [searchNoResults, setSearchNoResults] = useState(false);
  // True when the query has been typed but is too weak/short to fire retrieval.
  // Distinct from searchNoResults: "weak" = we didn't even search yet;
  // "no results" = we searched and found nothing confident.
  const [searchWeakQuery, setSearchWeakQuery] = useState(false);
  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null);
  const [note, setNote]                 = useState('');
  const [friends, setFriends]           = useState<Friend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [sendingTo, setSendingTo]       = useState<string | null>(null);
  const [sendResult, setSendResult]     = useState<{ ok: boolean; message: string } | null>(null);
  const [refreshing, setRefreshing]     = useState(false);

  // ── Walkthrough target measurement ──────────────────────────────────────────
  // Register the rec feed container once loaded; overlay polls for this.

  const recommendTargetRef = useRef<any>(null);

  function measureRecommendContent() {
    // recommendTargetRef is passed as wtRef into RecommendationsFeed, which
    // places it on the exact first targetable element: the setup prompt card
    // (tier < 1) or the first real rec card (ready state). No clipping needed.
    recommendTargetRef.current?.measureInWindow((x: number, y: number, w: number, h: number) => {
      if (w > 0 && h > 0) {
        registerWtTarget('recommend_content', { x, y, width: w, height: h });
      }
    });
  }

  useEffect(() => {
    if (hubLoading || wtStep !== 'recommend' || step !== 'hub') return;
    // 1 800 ms gives RecommendationsFeed time to finish its own internal data
    // fetch and show real cards (or the setup/import prompt) instead of skeletons.
    // hubLoading=false only means hub hub-level data is ready; the rec feed still
    // needs its own async pass to hydrate from the rec session.
    const t = setTimeout(measureRecommendContent, 1800);
    return () => clearTimeout(t);
  }, [hubLoading, wtStep, step]);

  // Reload hub whenever screen comes into focus
  useFocusEffect(useCallback(() => {
    if (step === 'hub') loadHub();
  }, [step]));

  // ── Recommendations entry check ────────────────────────────────────────────
  // Shows RecEntryScreen when:
  //   (a) The walkthrough just finished ('done') — tour is complete, setup time.
  //   (b) The user has no personalization signal and hasn't made a rec-entry choice yet.
  //
  // Note: during the 'recommend' overlay tour step, the app shows the rec feed
  // with a spotlight — RecEntryScreen does NOT fire at that point.  It fires
  // only after the full tour completes (wtStep === 'done') when _layout.tsx
  // navigates here automatically.
  //
  // Waits for walkthrough state to load (wtStep === null means still loading).
  const entryChecked = useRef(false);
  useEffect(() => {
    if (wtStep === null) return;             // still loading — wait
    if (wtStep === 'home' || wtStep === 'recommend' || wtStep === 'library' || wtStep === 'inbox') return; // tour in progress
    if (entryChecked.current) return;
    entryChecked.current = true;

    async function maybeShowEntry() {
      // Walkthrough just finished — user has been shown the app; now prompt setup
      if (wtStep === 'done') {
        wtEvt_recStepReached();
        const seen = await hasSeenRecEntry();
        if (!seen) {
          setStep('entry');
          return;
        }
      }
      // Fallback for existing / non-walkthrough users
      if (!supabase) return;
      const seen = await hasSeenRecEntry();
      if (seen) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const hasSignal = await hasPersonalizationSignal(user.id);
      if (!hasSignal) setStep('entry');
    }
    maybeShowEntry();
  }, [wtStep]);

  async function handleRefresh() {
    if (step !== 'hub') return;
    setRefreshing(true);
    await loadHub();
    setRefreshing(false);
  }



  // Monotonically-increasing counter. Each search request stamps itself; only
  // the response whose stamp matches the current value may commit to state.
  // This prevents a slow earlier response from overwriting a faster later one.
  const searchSeqRef = useRef(0);

  // Book search debounce (only relevant in 'search' step)
  useEffect(() => {
    if (step !== 'search') return;
    if (query.length < 2) {
      searchSeqRef.current += 1;   // invalidate any in-flight request
      setBookResults([]);
      setSearchNoResults(false);
      setSearchWeakQuery(false);
      return;
    }

    const timer = setTimeout(async () => {
      // Stamp this request — if a newer one fires before this resolves, discard.
      searchSeqRef.current += 1;
      const mySeq = searchSeqRef.current;
      const reqId = `${Date.now()}-${mySeq}`;

      // ── Alias expansion (before quality gate and spinner) ──────────────────
      // Resolve fandom shorthand BEFORE the quality gate so that 2-char aliases
      // like "hp" (which expand to multi-word queries) are never blocked.
      const aliasExpansion = expandAlias(query);
      const searchQuery    = aliasExpansion ?? query;

      if (__DEV__ && aliasExpansion) {
        console.log('[SEARCH_ALIAS]', `reqId=${reqId}`, `"${query}" → "${aliasExpansion}"`);
      }

      const tokens = searchQuery.trim().split(/\s+/);

      // ── Quality gate (before spinner) ─────────────────────────────────────
      // Do not fire OL retrieval — and do not show a spinner or "No results" —
      // for queries that are too vague to return useful results.
      //
      // Rules:
      //   • Alias-expanded queries always pass (expansion guarantees a real title).
      //   • Multi-token (2+ words): at least one token must be ≥ 4 chars.
      //     → blocks "car i", "car in", "car in the" (max token = 3).
      //   • Single-token (no alias): require ≥ 4 chars.
      //     → blocks "car" (3), "ya" (2), "the" (3).
      //     4-char single tokens like "book", "life" can still trigger abbrev
      //     path so real standalone words like "dune" (4) work.
      const longestToken  = tokens.reduce((m, t) => Math.max(m, t.length), 0);
      const isAliasQuery  = !!aliasExpansion;
      const queryTooWeak  = !isAliasQuery && longestToken < 4;

      if (queryTooWeak) {
        // Clear any lingering spinner / results from a prior strong query that
        // got stale-cancelled but left searching=true.
        setSearching(false);
        setBookResults([]);
        setSearchNoResults(false);
        setSearchWeakQuery(true);
        return;
      }

      setSearchWeakQuery(false);
      setSearching(true);
      setBookResults([]);          // clear stale results immediately
      setSearchNoResults(false);

      const FIELDS = 'key,title,author_name,cover_i,cover_edition_key,number_of_pages_median';

      try {
        // Abbreviation path: short single-token queries NOT in the alias table
        // (e.g. "scifi", "ya") that OL's community tag index handles well.
        // Threshold is ≤ 5 chars (not 6) so that 6-char real words like "fourth"
        // use the title= confidence path instead of raw q= ordering.
        const isAbbrevQuery = !aliasExpansion && tokens.length === 1 && searchQuery.trim().length <= 5;

        if (isAbbrevQuery) {
          // ── Abbreviation path: single q= fetch, trust OL community ranking ──
          const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(searchQuery)}&fields=${FIELDS}&limit=20`;
          if (__DEV__) console.log('[SEARCH_REQ]', `reqId=${reqId}`, `query="${searchQuery}"`, 'path=abbrev', `url=${url}`);

          const res  = await fetch(url);
          const json = await res.json();
          if (searchSeqRef.current !== mySeq) {
            if (__DEV__) console.log('[SEARCH_STALE]', `reqId=${reqId}`, `discarded — newer seq=${searchSeqRef.current}`);
            return;
          }

          const raw: BookResult[] = json.docs ?? [];
          if (__DEV__) console.log('[SEARCH_ABBREV]', `reqId=${reqId}`, `count=${raw.length}`, raw.slice(0, 3).map(b => b.title));
          setBookResults(raw.slice(0, 15));
          setSearchNoResults(raw.length === 0);
        } else {
          // ── Hybrid retrieval: Google Books (primary) + OL (secondary/fallback) ─
          //
          // Google Books has a far more accurate title search index than OL,
          // which means it surfaces the right book for queries like:
          //   "the lion women of tehran", "fourth win", "burn the boa", "silent pati"
          //
          // OL is kept as a secondary source to catch books not in GB's index
          // and as the authoritative identifier source (OL work keys).
          //
          // Strategy:
          //   1. Fire Google Books + OL multi-variants simultaneously
          //   2. hybridMerge: GB results first, OL fills gaps by title+author dedup
          //   3. scoreAndFilterBooks ONCE on the merged pool
          //   4. Prefer GB results when scores are equal (they're listed first)

          // ── OL variant construction (unchanged from before) ────────────────
          const STOP = new Set(['the','a','an','of','in','to','for','and','or','but','by','at','as','on','its','is','it','be','my','we','us','if','up','so']);

          const sigTokens  = tokens.filter(t => t.length >= 3 && !STOP.has(t));
          const lastTok    = tokens[tokens.length - 1];
          // When the last typed token is short (< 4 chars) it's almost certainly
          // an incomplete partial word (e.g. "boa" for "boats"). Exclude it from
          // the reduced OL variant so we don't fire a 0-result word-indexed query
          // like title="burn boa" — OL requires exact word boundaries.
          const sigForReduced = (lastTok.length < 4 && sigTokens.length > 1)
            ? sigTokens.filter(t => t !== lastTok)
            : sigTokens;
          const reduced    = sigForReduced.join(' ');
          const coreTwo    = sigForReduced.slice(0, 2).join(' ');
          const headTokens = lastTok.length <= 4 && tokens.length >= 2
            ? tokens.slice(0, -1).join(' ')
            : null;

          type Variant = { param: 'title' | 'q'; q: string };
          const variantList: Variant[] = [];
          variantList.push({ param: 'title', q: searchQuery });
          variantList.push({ param: 'q',     q: searchQuery });
          if (reduced && reduced !== searchQuery)
            variantList.push({ param: 'title', q: reduced });
          if (coreTwo && coreTwo !== reduced && coreTwo !== searchQuery && sigTokens.length >= 2)
            variantList.push({ param: 'title', q: coreTwo });
          if (headTokens && headTokens !== reduced && headTokens !== coreTwo && headTokens !== searchQuery)
            variantList.push({ param: 'title', q: headTokens });

          const seenV = new Set<string>();
          const variants = variantList.filter(v => {
            const k = `${v.param}:${v.q}`;
            if (seenV.has(k)) return false;
            seenV.add(k);
            return true;
          });

          if (__DEV__) console.log('[SEARCH_VARIANTS]', `reqId=${reqId}`,
            `gb=1 ol=${variants.length}`,
            variants.map(v => `${v.param}="${v.q}"`).join(' | '));

          // ── Fire Google Books + all OL variants in parallel ────────────────
          const olFetches = variants.map(v => {
            const url = `https://openlibrary.org/search.json?${v.param}=${encodeURIComponent(v.q)}&fields=${FIELDS}&limit=20`;
            return fetch(url).then(r => r.json() as Promise<{ docs?: BookResult[] }>).catch(() => ({ docs: [] as BookResult[] }));
          });

          const [gbBooks, ...olResponses] = await Promise.all([
            fetchGoogleBooks(searchQuery),
            ...olFetches,
          ]);

          if (searchSeqRef.current !== mySeq) {
            if (__DEV__) console.log('[SEARCH_STALE]', `reqId=${reqId}`, `discarded — newer seq=${searchSeqRef.current}`);
            return;
          }

          if (__DEV__) console.log('[SEARCH_GB]', `reqId=${reqId}`,
            `count=${gbBooks.length}`, gbBooks.slice(0, 3).map(b => b.title));

          // Merge OL results (deduplicated by OL key within OL pool)
          let olMerged: BookResult[] = [];
          for (let vi = 0; vi < olResponses.length; vi++) {
            const raw: BookResult[] = olResponses[vi].docs ?? [];
            if (__DEV__) console.log('[SEARCH_OL]', `reqId=${reqId}`,
              `[${vi+1}/${variants.length}] ${variants[vi].param}="${variants[vi].q}"`,
              `count=${raw.length}`, raw.slice(0, 2).map(b => b.title));
            olMerged = mergeBookResults(olMerged, raw);
          }

          // hybridMerge: GB first, then OL books not already represented by GB
          const merged = hybridMerge(gbBooks, olMerged);

          if (__DEV__) console.log('[SEARCH_MERGED]', `reqId=${reqId}`,
            `gb=${gbBooks.length} ol=${olMerged.length} merged=${merged.length}`);

          // Score the merged pool once against the original query
          const scored = scoreAndFilterBooks(searchQuery, merged);

          if (__DEV__) {
            console.log('[SEARCH_SCORED]', `reqId=${reqId}`,
              `variants=${variants.length} merged=${merged.length}`,
              `hasHigh=${scored.hasHigh}`, `hasMed=${scored.hasMedium}`,
              scored.topScores.map(s => `"${s.title}" ${s.score} ${s.confidence} ${s.matchType}`));
          }

          // Commit: suppress MEDIUM when the last token is clearly incomplete
          // (≤3 chars → user is mid-word and MEDIUM candidates are noise).
          const lastTokenIncomplete = lastTok.length <= 3;

          if (scored.hasHigh || (scored.hasMedium && !lastTokenIncomplete)) {
            setBookResults(scored.results);
            setSearchNoResults(false);
          } else {
            setBookResults([]);
            // Show "No strong matches found" only when the query is complete
            // enough to be definitive. Single-token queries shorter than 8
            // chars are likely still mid-word → show neutral "keep typing"
            // instead of an alarming failure message.
            const isDefinitiveQuery =
              tokens.length >= 2 || searchQuery.trim().length >= 8;
            if (isDefinitiveQuery) {
              setSearchNoResults(true);
            } else {
              setSearchWeakQuery(true);
            }
          }
        }
      } catch (err) {
        if (searchSeqRef.current !== mySeq) return;
        if (__DEV__) console.log('[SEARCH_ERR]', `reqId=${reqId}`, String(err));
        setBookResults([]);
      }
      setSearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [query, step]);


  // ── Hub data loader ───────────────────────────────────────────────────────
  // Fetches Phase 1 hub data (tasks, incoming/sent recs, tasteProfile,
  // entitlement, feedbackCtx) concurrently. Recommendation pipeline is
  // handled entirely by RecommendationsFeed.

  async function loadHub() {
    if (!supabase) { setHubLoading(false); return; }

    if (__DEV__) console.log('[PERF] recommendations_screen_mount');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setHubLoading(false); return; }
    // Belt-and-suspenders: clear stale caches if the user switched accounts
    if (getRecSession()?.userId !== user.id) clearRecSession();
    if (_hubCache && _hubCache.userId !== user.id) _hubCache = null;
    setCurrentUserId(user.id);

    // ── Phase 1: core hub data (all DB queries run concurrently) ─────────
    // Show skeleton on cold start only; hub cache means instant render.
    if (!_hubCache) setHubLoading(true);

    const _phase1Start = Date.now();
    if (__DEV__) console.log('[PERF] phase1_start');

    const [rateRes, tagRes, incomingRes, sentRes, tp, ent, fbCtxPhase1] = await Promise.all([
      // Finished books with no rating
      supabase
        .from('user_books')
        .select('id, book_id, book:books(title, author, cover_url, external_id, subjects)')
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .is('rating', null),

      // Finished books WITH rating, may still lack taste_tags (client-filtered below)
      supabase
        .from('user_books')
        .select('id, book_id, taste_tags, book:books(title, author, cover_url, external_id, subjects)')
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

      // Taste profile — needed to know tier + genre affinities for Phase 2
      computeTasteProfile(supabase!, user.id).catch(() => null),

      // Entitlement — determines whether expert rec mode is available
      getEntitlement(supabase!, user.id).catch(() => null),

      // Feedback context — loaded in parallel to avoid a serial round-trip
      // at Phase 2 start (saves ~50–100 ms off the time-to-first-rec).
      loadFeedbackContext(supabase!, user.id).catch(() => emptyContext()),
    ]);

    if (__DEV__) console.log('[PERF] phase1_end — ms=' + (Date.now() - _phase1Start));

    // ── Supabase many-to-one join note: returns single object, not array ─────
    type BookJoin = { title: string; author: string; cover_url: string | null; external_id: string | null; subjects: string[] | null };
    type RateRow  = { id: string; book_id: string; book: BookJoin | null };
    type TagRow   = { id: string; book_id: string; taste_tags: { liked?: string[]; didnt_work?: string[] } | null; book: BookJoin | null };

    const toRate: BookToRate[] = ((rateRes.data ?? []) as unknown as RateRow[]).map(r => ({
      id:          r.id,
      book_id:     r.book_id,
      title:       r.book?.title       ?? '',
      author:      r.book?.author      ?? '',
      cover_url:   r.book?.cover_url   ?? null,
      external_id: r.book?.external_id ?? null,
      subjects:    r.book?.subjects    ?? null,
    }));

    const toTag: BookToTag[] = ((tagRes.data ?? []) as unknown as TagRow[])
      .filter(r => {
        const tt       = r.taste_tags;
        const liked    = (tt?.liked      ?? []) as string[];
        const disliked = (tt?.didnt_work ?? []) as string[];
        return liked.length === 0 && disliked.length === 0;
      })
      .map(r => ({
        id:          r.id,
        book_id:     r.book_id,
        title:       r.book?.title       ?? '',
        author:      r.book?.author      ?? '',
        cover_url:   r.book?.cover_url   ?? null,
        external_id: r.book?.external_id ?? null,
        subjects:    r.book?.subjects    ?? null,
      }));


    // Commit Phase 1 state
    const _incomingRows = (incomingRes.data as unknown as IncomingRec[]) ?? [];
    const _sentRows     = (sentRes.data    as unknown as SentRec[])     ?? [];
    setBooksToRate(toRate);
    setBooksToTag(toTag);
    setIncomingRecs(_incomingRows);
    setSentRecs(_sentRows);
    setTasteProfile(tp);
    setEntitlement(ent);
    setFeedbackCtx(fbCtxPhase1);
    setHubLoading(false);   // clear skeleton (cold path) or no-op (warm path)

    // Persist hub snapshot so next visit renders all sections at frame 0
    _hubCache = {
      userId:       user.id,
      booksToRate:  toRate,
      booksToTag:   toTag,
      incomingRecs: _incomingRows,
      sentRecs:     _sentRows,
      tasteProfile: tp,
      fetchedAt:    Date.now(),
    };
  }

  // ── Send flow handlers (logic unchanged) ─────────────────────────────────

  async function handleSelectBook(book: BookResult) {
    if (!supabase || !currentUserId) return;
    const editionKey = book.cover_edition_key ?? null;
    // For Google Books results, prefer the GB thumbnail; fall back to OL cover.
    const coverUrl = book._gbCoverUrl
      ?? (editionKey ? `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg` : olCoverUrl(book.cover_i, 'M'));
    const rawPages = book.number_of_pages_median;
    const pageCount = typeof rawPages === 'number' && rawPages >= 30 ? rawPages : null;

    // Show the friends step immediately with a tentative key.
    // For GB books, attempt OL ISBN resolution in parallel with the Supabase
    // friends query so there is zero added latency for the user.
    const tentativeSelected: SelectedBook = {
      externalId: book.key,
      title: book.title,
      author: book.author_name?.[0] ?? 'Unknown author',
      coverUrl,
      pageCount,
      editionKey,
    };
    setSelectedBook(tentativeSelected);
    setStep('friends');
    setLoadingFriends(true);

    // Fire OL key resolution + friends fetch in parallel
    const [resolvedKey, { data: friendships }] = await Promise.all([
      book._source === 'gb' ? resolveOLKeyFromIsbn(book) : Promise.resolve(book.key),
      supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${currentUserId},addressee_id.eq.${currentUserId}`),
    ]);

    // Update externalId if OL resolution succeeded
    if (resolvedKey !== tentativeSelected.externalId) {
      setSelectedBook(prev => prev ? { ...prev, externalId: resolvedKey } : prev);
    }

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

  function handleRateComplete(id: string) {
    setBooksToRate(prev => prev.filter(b => b.id !== id));
  }

  function handleTagComplete(id: string) {
    setBooksToTag(prev => prev.filter(b => b.id !== id));
  }

  function reset() {
    setStep('hub');
    setQuery('');
    setBookResults([]);
    setSearchNoResults(false);
    setSearchWeakQuery(false);
    setSelectedBook(null);
    setNote('');
    setFriends([]);
    setSendResult(null);
    setSendingTo(null);
  }

  // ── Step: entry ───────────────────────────────────────────────────────────

  if (step === 'entry') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#faf9f7' }}>
        <RecEntryScreen
          onDone={() => {
            // Tour is already 'done' when RecEntryScreen shows — no advance needed
            setStep('hub');
            loadHub();
          }}
        />
      </SafeAreaView>
    );
  }

  // ── Step: hub ─────────────────────────────────────────────────────────────

  if (step === 'hub') {
    const hasRateTasks    = booksToRate.length > 0;
    const hasTagTasks     = booksToTag.length > 0;
    const hasAnalyseTask  = (tasteProfile?.evidence.imported_books_count ?? 0) > 0 && (tasteProfile?.tier ?? 0) < 3;
    const hasAnyTask      = hasRateTasks || hasTagTasks || hasAnalyseTask;
    return (
      <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: '#faf9f7' }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 48 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
        }
      >
        {/* ── Header ── */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 28 }}>
          <TouchableOpacity
            style={{ flex: 1 }}
            activeOpacity={1}
          >
            <Text style={{
              fontSize: 28,
              fontWeight: '800',
              color: '#1c1917',
              letterSpacing: -0.5,
              lineHeight: 34,
            }}>
              Recommendations
            </Text>
          </TouchableOpacity>
          <Pressable
            onPress={() => router.push('/scan' as any)}
            hitSlop={12}
            style={{
              backgroundColor: '#f5f5f4',
              borderRadius:    22,
              padding:         10,
              marginTop:       4,
            }}
          >
            <Ionicons name="barcode-outline" size={22} color="#1c1917" />
          </Pressable>
        </View>

        {hubLoading ? (
          <View style={{ gap: 8 }}>
            <SectionLabel>For You</SectionLabel>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <View style={{ height: 28 }} />
            <SectionLabel>Incoming</SectionLabel>
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : (
          <>
            {/* ════════════════════════════════════════════════════════
                Section 1 — For You
            ════════════════════════════════════════════════════════ */}
            <RecommendationsFeed
              userId={currentUserId}
              supabase={supabase}
              tasteProfile={tasteProfile}
              entitlement={entitlement}
              feedbackCtx={feedbackCtx}
              setFeedbackCtx={setFeedbackCtx}
              guidedStep={guidedStep}
              onGuidedAdvance={advanceGuided}
              wtRef={recommendTargetRef}
            />
            {/* ════════════════════════════════════════════════════════
                Section 2 — Refine Your Taste (promoted above Social)
            ════════════════════════════════════════════════════════ */}
            {hasAnyTask && (
              <View style={{ marginBottom: 32 }}>
                {/* ── Refine your taste ── */}
                {(hasRateTasks || hasTagTasks) && (
                  <View style={{ marginBottom: 16 }}>
                    <View style={{
                      flexDirection: 'row', alignItems: 'center',
                      marginBottom: 6, paddingLeft: 10,
                      borderLeftWidth: 3, borderLeftColor: '#f59e0b',
                    }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917' }}>
                          Refine your taste
                        </Text>
                        <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>
                          Ratings are our strongest signal
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11, color: '#a8a29e' }}>
                        {booksToRate.length + booksToTag.length} book{booksToRate.length + booksToTag.length !== 1 ? 's' : ''}
                      </Text>
                    </View>
                    <View style={{ gap: 8 }}>
                      {booksToRate.slice(0, 3).map(b => (
                        <RateCard key={b.id} book={b} onComplete={handleRateComplete} />
                      ))}
                      {booksToTag.slice(0, Math.max(0, 3 - booksToRate.length)).map(b => (
                        <TagCard key={b.id} book={b} onComplete={handleTagComplete} />
                      ))}
                      {(booksToRate.length + booksToTag.length) > 6 && (
                        <TouchableOpacity onPress={() => router.push('/(tabs)/library')}>
                          <Text style={{ fontSize: 13, color: '#78716c', paddingVertical: 6 }}>
                            +{booksToRate.length + booksToTag.length - 3} more available in Library
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                )}

                {hasAnalyseTask && (
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
              </View>
            )}

            {/* ════════════════════════════════════════════════════════
                Section 3 — Shared Books (From Friends + Sent)
            ════════════════════════════════════════════════════════ */}
            <View style={{ marginBottom: 36 }}>
              <SectionLabel>Shared Books</SectionLabel>

              {/* ── Both empty: unified card with prompt + CTA ── */}
              {incomingRecs.length === 0 && sentRecs.length === 0 && (
                <View style={{
                  backgroundColor: '#fff',
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: '#e7e5e4',
                  overflow: 'hidden',
                }}>
                  <View style={{ padding: 14 }}>
                    <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 19, marginBottom: 12 }}>
                      Share a book with a friend to get started.
                    </Text>
                    <TouchableOpacity
                      onPress={() => setStep('search')}
                      style={{
                        backgroundColor: '#1c1917',
                        borderRadius: 10,
                        paddingVertical: 11,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '600', color: '#fff' }}>
                        Recommend a book
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* ── From friends ── */}
              {incomingRecs.length > 0 && (
                <>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#78716c', marginBottom: 10, letterSpacing: 0.3 }}>
                    FROM FRIENDS
                  </Text>
                  <View style={{
                    backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden',
                    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6,
                    shadowOffset: { width: 0, height: 1 }, elevation: 1, marginBottom: 20,
                  }}>
                    {incomingRecs.map((rec, idx) => (
                      <TouchableOpacity
                        key={rec.id}
                        onPress={() => {
                          if (rec.book) {
                            router.push({
                              pathname: '/book/[id]',
                              params: {
                                id:         rec.book_id,
                                title:      rec.book.title,
                                author:     rec.book.author,
                                coverUrl:   rec.book.cover_url ?? '',
                                externalId: rec.book.external_id,
                                status:     rec.status,
                                note:       rec.note ?? '',
                                fromUser:   getFirstName(rec.sender),
                              },
                            });
                          } else {
                            router.push('/(tabs)/notes');
                          }
                        }}
                        style={{
                          flexDirection: 'row', alignItems: 'center', padding: 13,
                          borderBottomWidth: idx < incomingRecs.length - 1 ? 1 : 0,
                          borderBottomColor: '#f5f5f4',
                        }}
                      >
                        <CoverThumb url={rec.book?.cover_url} externalId={rec.book?.external_id} title={rec.book?.title ?? ''} width={34} height={50} />
                        <View style={{ flex: 1, marginLeft: 12 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>{rec.book?.title ?? ''}</Text>
                          <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }} numberOfLines={1}>from {getFirstName(rec.sender)}</Text>
                        </View>
                        <StatusPill status={rec.status} />
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      onPress={() => router.push('/(tabs)/notes')}
                      style={{ padding: 13, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#f5f5f4' }}
                    >
                      <Text style={{ fontSize: 13, color: '#78716c', fontWeight: '500' }}>See all in inbox →</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {/* ── Sent ── */}
              {sentRecs.length > 0 && (
                <>
                  <Text style={{ fontSize: 12, fontWeight: '600', color: '#78716c', marginBottom: 10, letterSpacing: 0.3 }}>
                    YOU SENT
                  </Text>
                  <View style={{
                    backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden',
                    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6,
                    shadowOffset: { width: 0, height: 1 }, elevation: 1, marginBottom: 16,
                  }}>
                    {sentRecs.map((rec, idx) => (
                      <View key={rec.id} style={{ flexDirection: 'row', alignItems: 'center', padding: 13, borderBottomWidth: idx < sentRecs.length - 1 ? 1 : 0, borderBottomColor: '#f5f5f4' }}>
                        <CoverThumb url={rec.book?.cover_url} externalId={rec.book?.external_id} title={rec.book?.title ?? ''} width={34} height={50} />
                        <View style={{ flex: 1, marginLeft: 12 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>{rec.book?.title ?? ''}</Text>
                          <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }} numberOfLines={1}>to {getFirstName(rec.to_user)}</Text>
                        </View>
                        <StatusPill status={rec.status} />
                      </View>
                    ))}
                  </View>
                </>
              )}

              {/* ── CTA when content exists (not floating alone) ── */}
              {(incomingRecs.length > 0 || sentRecs.length > 0) && (
                <TouchableOpacity
                  onPress={() => setStep('search')}
                  style={{ paddingVertical: 12, alignItems: 'center' }}
                >
                  <Text style={{ fontSize: 13, color: '#78716c', fontWeight: '500' }}>
                    + Recommend a book
                  </Text>
                </TouchableOpacity>
              )}
            </View>

          </>
        )}


      </ScrollView>


      </View>
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
              <CoverThumb url={item._gbCoverUrl ?? olCoverUrl(item.cover_i, 'S')} title={item.title} width={34} height={50} />
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
            !searching && searchNoResults ? (
              // Query was strong enough to fire; retrieval found nothing confident.
              <View style={{ marginTop: 16 }}>
                <Text style={{ color: '#1c1917', fontSize: 14, fontWeight: '600' }}>
                  No strong matches found.
                </Text>
                <Text style={{ color: '#a8a29e', fontSize: 13, marginTop: 4 }}>
                  Try a more specific title or check your spelling.
                </Text>
              </View>
            ) : !searching && searchWeakQuery ? (
              // Query typed but too weak / mid-word — don't alarm the user.
              <Text style={{ color: '#a8a29e', marginTop: 12, fontSize: 14 }}>
                Keep typing…
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
