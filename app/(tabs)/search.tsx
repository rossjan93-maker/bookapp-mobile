import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  LayoutAnimation,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { getDisplayName, getFirstName } from '../../lib/displayName';
import { computeTasteProfile } from '../../lib/tasteProfile';
import type { TasteProfile } from '../../lib/tasteProfile';
import { getCandidateBooks, getRankedRecs, fitLabel, fitColor } from '../../lib/recommender';
import type { ScoredBook, QualityGate, RankedRecsResult } from '../../lib/recommender';
import { loadFeedbackContext, persistFeedback, emptyContext } from '../../lib/recFeedback';
import type { FeedbackContext } from '../../lib/recFeedback';
import { getBookTraits } from '../../lib/bookTraits';

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

function SkeletonCard({ stars = false }: { stars?: boolean }) {
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 850, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 850, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  return (
    <Animated.View style={[CARD_STYLE, { opacity: pulse, padding: 12 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 36, height: 52, borderRadius: 5, backgroundColor: '#e7e5e4' }} />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <View style={{ height: 13, width: '58%', backgroundColor: '#e7e5e4', borderRadius: 7, marginBottom: 7 }} />
          <View style={{ height: 11, width: '38%', backgroundColor: '#f0efed', borderRadius: 6, marginBottom: stars ? 10 : 0 }} />
          {stars && (
            <View style={{ flexDirection: 'row', gap: 5 }}>
              {[0, 1, 2, 3, 4].map(i => (
                <View key={i} style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#ece9e5' }} />
              ))}
            </View>
          )}
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

function BookRow({ book, rating }: { book: BookToRate | BookToTag; rating?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <CoverThumb url={book.cover_url} externalId={book.external_id} title={book.title} width={36} height={52} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }} numberOfLines={1}>
          {book.title}
        </Text>
        <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 2 }} numberOfLines={1}>
          {book.author}
        </Text>
      </View>
      {rating != null && rating > 0 && (
        <View style={{ flexDirection: 'row', gap: 1 }}>
          {[1, 2, 3, 4, 5].map(s => (
            <Text key={s} style={{ fontSize: 13, color: s <= rating ? '#f59e0b' : '#e7e5e4' }}>★</Text>
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
        padding: 12,
        borderBottomWidth: mode !== 'rate' ? 1 : 0,
        borderBottomColor: '#f5f5f4',
      }}>
        <BookRow book={book} rating={mode !== 'rate' ? rating : undefined} />

        {mode === 'rate' && (
          <View style={{ flexDirection: 'row', gap: 3, marginTop: 10, paddingLeft: 48 }}>
            {[1, 2, 3, 4, 5].map(star => (
              <TouchableOpacity
                key={star}
                activeOpacity={0.7}
                onPress={() => handleRate(star)}
                disabled={saving}
                hitSlop={{ top: 10, bottom: 10, left: 5, right: 5 }}
              >
                <Text style={{
                  fontSize: 28,
                  color: star <= (pendingRating || rating) ? '#f59e0b' : '#d6d3d1',
                }}>★</Text>
              </TouchableOpacity>
            ))}
            {saving && (
              <ActivityIndicator
                size="small"
                color="#a8a29e"
                style={{ marginLeft: 10, alignSelf: 'center' }}
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
        <BookRow book={book} />
        {!expanded && (
          <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 6, paddingLeft: 48 }}>
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

// ─── RecCard ──────────────────────────────────────────────────────────────────
// Shows a single personalised book recommendation with fit label, reasons, risk.

function RecCard({
  book,
  onSave           = () => {},
  onDismiss        = () => {},
  onMoreLikeThis   = () => {},
  onImpression     = () => {},
  onExplanationOpen= () => {},
}: {
  book:              ScoredBook;
  onSave?:           () => void;
  onDismiss?:        () => void;
  onMoreLikeThis?:   () => void;
  onImpression?:     () => void;
  onExplanationOpen?:() => void;
}) {
  const label   = fitLabel(book.score);
  const color   = fitColor(book.score);

  // Animation refs
  const opacity   = useRef(new Animated.Value(1)).current;
  const whyHeight = useRef(new Animated.Value(0)).current;

  // Local state
  const [expanded, setExpanded]         = useState(false);
  const [moreDone, setMoreDone]         = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const impressionFired = useRef(false);

  // Fire impression once on mount
  useEffect(() => {
    if (!impressionFired.current) {
      impressionFired.current = true;
      onImpression();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function animateOut(cb: () => void) {
    Animated.timing(opacity, {
      toValue:  0,
      duration: 180,
      useNativeDriver: false,
    }).start(cb);
  }

  function handleSavePress() {
    if (pendingAction) return;
    setPendingAction(true);
    animateOut(onSave);
  }

  function handleDismissPress() {
    if (pendingAction) return;
    setPendingAction(true);
    animateOut(onDismiss);
  }

  function handleMoreLikeThisPress() {
    if (pendingAction || moreDone) return;
    setMoreDone(true);
    onMoreLikeThis();
    setTimeout(() => setMoreDone(false), 2200);
  }

  function toggleWhy() {
    if (expanded) {
      Animated.timing(whyHeight, { toValue: 0, duration: 200, useNativeDriver: false }).start();
      setExpanded(false);
    } else {
      Animated.timing(whyHeight, { toValue: 330, duration: 220, useNativeDriver: false }).start();
      setExpanded(true);
      onExplanationOpen();
    }
  }

  const sourceLabel = book._source === 'catalog' ? 'Catalog' : 'Open Library';
  const uncertainty = book.score < 0.20
    ? 'Early signal — confidence will grow as your profile develops.'
    : book.score < 0.32
    ? 'Moderate fit — a few more ratings will sharpen this pick.'
    : null;

  return (
    <Animated.View style={{
      opacity,
      backgroundColor: '#fff',
      borderRadius: 14,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
      overflow: 'hidden',
    }}>
      {/* ── Main content row ── */}
      <View style={{ padding: 12, flexDirection: 'row', alignItems: 'flex-start' }}>
        <CoverThumb
          url={book.cover_url}
          externalId={book.external_id}
          title={book.title}
          width={44}
          height={64}
        />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3 }}>
            <Text
              style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1, lineHeight: 20 }}
              numberOfLines={2}
            >
              {book.title}
            </Text>
            <View style={{
              marginLeft: 8, marginTop: 2,
              paddingHorizontal: 8, paddingVertical: 3,
              borderRadius: 10,
              backgroundColor: color + '18',
            }}>
              <Text style={{ fontSize: 11, fontWeight: '600', color }}>{label}</Text>
            </View>
          </View>

          <Text style={{ fontSize: 12, color: '#a8a29e', marginBottom: 7 }} numberOfLines={1}>
            {book.author}
          </Text>

          {book.reasons.length > 0 && (
            <Text style={{ fontSize: 12, color: '#57534e', lineHeight: 17 }} numberOfLines={2}>
              {book.reasons[0]}
            </Text>
          )}
          {book.risks.length > 0 && (
            <Text style={{ fontSize: 11, color: '#b45309', marginTop: 5, lineHeight: 16 }} numberOfLines={1}>
              ⚠ {book.risks[0]}
            </Text>
          )}

          {/* Why this? toggle */}
          <TouchableOpacity onPress={toggleWhy} style={{ marginTop: 8 }}>
            <Text style={{ fontSize: 11, color: '#a8a29e' }}>
              {expanded ? '▲ Hide explanation' : '▼ Why this recommendation?'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Expandable "Why" panel ── */}
      <Animated.View style={{ maxHeight: whyHeight, overflow: 'hidden' }}>
        <View style={{
          marginHorizontal: 12,
          marginBottom: 10,
          backgroundColor: '#faf9f7',
          borderRadius: 10,
          padding: 12,
        }}>
          {book.reasons.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: '600', color: '#78716c', marginBottom: 4 }}>
                WHY IT FITS
              </Text>
              {book.reasons.map((r, i) => (
                <Text key={i} style={{ fontSize: 12, color: '#57534e', lineHeight: 18 }}>• {r}</Text>
              ))}
            </View>
          )}
          {book.risks.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: '600', color: '#78716c', marginBottom: 4 }}>
                POTENTIAL MISMATCH
              </Text>
              {book.risks.map((r, i) => (
                <Text key={i} style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>• {r}</Text>
              ))}
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <View>
              <Text style={{ fontSize: 10, fontWeight: '600', color: '#a8a29e' }}>SOURCE</Text>
              <Text style={{ fontSize: 11, color: '#57534e' }}>{sourceLabel}</Text>
            </View>
            <View>
              <Text style={{ fontSize: 10, fontWeight: '600', color: '#a8a29e' }}>SCORE</Text>
              <Text style={{ fontSize: 11, color: '#57534e' }}>{book.score.toFixed(2)} / 1.00</Text>
            </View>
            <View>
              <Text style={{ fontSize: 10, fontWeight: '600', color: '#a8a29e' }}>POOL</Text>
              <Text style={{ fontSize: 11, color: '#57534e' }}>#{book._debug.rank} of {book._debug.pool_size}</Text>
            </View>
          </View>

          {/* ── Score breakdown ── */}
          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: '#e7e5e4', paddingTop: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}>
              <Text style={{ fontSize: 10, fontWeight: '600', color: '#a8a29e', flex: 1 }}>
                SCORE BREAKDOWN
              </Text>
              {book._score_breakdown.book_form && (
                <Text style={{ fontSize: 9, color: '#78716c', backgroundColor: '#f5f5f4', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 }}>
                  {book._score_breakdown.book_form}
                </Text>
              )}
            </View>
            {[
              { label: 'Trait align', value: book._score_breakdown.trait_alignment  },
              { label: 'Avoided',     value: book._score_breakdown.avoided_penalty  },
              { label: 'Genre',       value: book._score_breakdown.genre_bonus      },
              { label: 'Feedback',    value: book._score_breakdown.feedback_boost   },
              { label: 'Enrichment',  value: book._score_breakdown.enrichment_bonus },
              { label: 'Metadata',    value: book._score_breakdown.metadata_penalty },
            ].map(({ label, value }) => {
              const isNeg  = value < 0;
              const isZero = value === 0;
              const color  = isZero ? '#d6d3d1' : isNeg ? '#ef4444' : '#16a34a';
              const prefix = value > 0 ? '+' : '';
              const barW   = Math.round(Math.min(Math.abs(value) * 280, 80));
              return (
                <View key={label} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
                  <Text style={{ fontSize: 10, color: '#78716c', width: 72 }}>{label}</Text>
                  <View style={{
                    width: Math.max(2, barW), height: 4, borderRadius: 2, marginRight: 6,
                    backgroundColor: isZero ? '#e7e5e4' : color,
                    opacity: isZero ? 0.3 : 0.72,
                  }} />
                  <Text style={{ fontSize: 10, color, fontVariant: ['tabular-nums'] }}>
                    {prefix}{value.toFixed(3)}
                  </Text>
                </View>
              );
            })}
            <View style={{ flexDirection: 'row', marginTop: 4, gap: 8 }}>
              <Text style={{ fontSize: 9, color: '#a8a29e' }}>
                raw {book._score_breakdown.raw_score.toFixed(3)} → {book._score_breakdown.final_score.toFixed(3)}
              </Text>
              {book._score_breakdown.audit_flags.length > 0 && (
                <Text style={{ fontSize: 9, color: '#ef4444' }}>
                  ⚑ {book._score_breakdown.audit_flags.join(', ')}
                </Text>
              )}
            </View>
            <Text style={{ fontSize: 9, color: '#a8a29e', marginTop: 2 }} numberOfLines={1}>
              ↵ {book._retrieval_reason}
            </Text>
          </View>

          {uncertainty && (
            <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 8, lineHeight: 16, fontStyle: 'italic' }}>
              {uncertainty}
            </Text>
          )}
        </View>
      </Animated.View>

      {/* ── Action bar ── */}
      <View style={{
        borderTopWidth: 1,
        borderTopColor: '#f5f5f4',
        flexDirection: 'row',
      }}>
        <TouchableOpacity
          onPress={handleSavePress}
          disabled={pendingAction}
          style={{
            flex: 1,
            paddingVertical: 10,
            alignItems: 'center',
            borderRightWidth: 1,
            borderRightColor: '#f5f5f4',
          }}
        >
          <Text style={{ fontSize: 12, color: '#57534e', fontWeight: '500' }}>
            🔖 Save
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleDismissPress}
          disabled={pendingAction}
          style={{
            flex: 1,
            paddingVertical: 10,
            alignItems: 'center',
            borderRightWidth: 1,
            borderRightColor: '#f5f5f4',
          }}
        >
          <Text style={{ fontSize: 12, color: '#a8a29e' }}>✕ Not for me</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleMoreLikeThisPress}
          disabled={pendingAction}
          style={{ flex: 1, paddingVertical: 10, alignItems: 'center' }}
        >
          <Text style={{ fontSize: 12, color: moreDone ? '#16a34a' : '#a8a29e' }}>
            {moreDone ? '✓ Got it' : '↑ More like this'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Source/debug strip ── */}
      <View style={{ backgroundColor: '#fafaf9', paddingHorizontal: 12, paddingVertical: 4 }}>
        <Text style={{ fontSize: 10, color: '#d6d3d1' }}>
          {book._source === 'catalog' ? '📚' : '🌐'} {sourceLabel}
          {'  ·  '}rank {book._debug.rank}/{book._debug.pool_size}
          {'  ·  '}score {book.score.toFixed(2)}
          {'  ·  '}{book._retrieval_reason}
        </Text>
      </View>
    </Animated.View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RecommendationsScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('hub');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // ── Hub state ──────────────────────────────────────────────────────────────
  const [hubLoading, setHubLoading]           = useState(true);
  const [recsLoading, setRecsLoading]         = useState(false);
  const [recsQualityGate, setRecsQualityGate] = useState<QualityGate | null>(null);
  const [recsMeta, setRecsMeta]               = useState<RankedRecsResult['meta'] | null>(null);
  const [traceOpen, setTraceOpen]             = useState(false);
  const traceHeight                           = useRef(new Animated.Value(0)).current;
  const [feedbackCtx, setFeedbackCtx]         = useState<FeedbackContext>(emptyContext());
  const [saveToast, setSaveToast]             = useState<string | null>(null);
  const [booksToRate, setBooksToRate]         = useState<BookToRate[]>([]);
  const [booksToTag, setBooksToTag]           = useState<BookToTag[]>([]);
  const [incomingRecs, setIncomingRecs]       = useState<IncomingRec[]>([]);
  const [sentRecs, setSentRecs]               = useState<SentRec[]>([]);
  const [tasteProfile, setTasteProfile]       = useState<TasteProfile | null>(null);
  const [recommendations, setRecommendations] = useState<ScoredBook[]>([]);

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
    if (!supabase) { setHubLoading(false); setRecsLoading(false); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setHubLoading(false); setRecsLoading(false); return; }
    setCurrentUserId(user.id);
    setHubLoading(true);
    setRecsLoading(false);
    setRecommendations([]);

    // ── Phase 1: core hub data (all DB queries run concurrently) ─────────────
    // Hub becomes visible as soon as this resolves, without waiting for OL API.

    const [rateRes, tagRes, incomingRes, sentRes, tp] = await Promise.all([
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
    ]);

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

    // Commit Phase 1 state — hub is now visible
    setBooksToRate(toRate);
    setBooksToTag(toTag);
    setIncomingRecs((incomingRes.data as unknown as IncomingRec[]) ?? []);
    setSentRecs((sentRes.data as unknown as SentRec[]) ?? []);
    setTasteProfile(tp);
    setHubLoading(false);

    // ── Phase 2: recommendation retrieval (profile-guided, includes OL calls) ─
    // Runs after Phase 1 state is committed so the hub is already visible.
    // Only fires when the user has enough signal for tier-1+ recommendations.
    if (!tp || tp.tier < 1) return;

    setRecsLoading(true);
    setRecsQualityGate(null);
    try {
      // Load feedback context first (fast DB query) — drives candidate exclusion + boosts
      const fbCtx = await loadFeedbackContext(supabase!, user.id);
      setFeedbackCtx(fbCtx);

      // Retrieve candidates (multi-anchor OL + catalog + cache) and enrichment
      const {
        candidates,
        enrichmentMap,
        retrieval_trace,
      } = await getCandidateBooks(supabase!, user.id, tp, fbCtx);
      const { recs, meta } = getRankedRecs(candidates, tp, 5, fbCtx, enrichmentMap, retrieval_trace);
      setRecommendations(recs);
      setRecsMeta(meta);
      setRecsQualityGate(meta.quality_gate !== 'passed' ? meta.quality_gate : null);

      if (__DEV__) {
        console.log('[REC TRACE] retrieval:', {
          pool: meta.pool_size,
          catalog: meta.catalog_count,
          cached_ext: meta.cached_external_count,
          live_ol: meta.live_ol_count,
          hygiene_excluded: meta.hygiene_excluded,
          enriched: meta.enriched_count,
          quality_gate: meta.quality_gate,
          genres_used: meta.retrieval_trace.top_genres_used,
          traits_used: meta.retrieval_trace.top_traits_used,
          subjects_used: meta.retrieval_trace.liked_subjects_used,
          authors_used: meta.retrieval_trace.liked_authors_used,
          ol_queries: meta.retrieval_trace.ol_queries,
        });
        console.log('[REC TRACE] top-10 scored:', recs.slice(0, 10).map(r => ({
          title:    r.title,
          author:   r.author,
          score:    r.score,
          source:   r._source,
          reason:   r._retrieval_reason,
          breakdown: r._score_breakdown,
          fit:      r.reasons,
          risks:    r.risks,
        })));
      }
    } catch {
      // Recommendations fail silently — hub content is already visible
    } finally {
      setRecsLoading(false);
    }
  }

  // ── Hub completion handlers ───────────────────────────────────────────────

  function handleRateComplete(id: string) {
    setBooksToRate(prev => prev.filter(b => b.id !== id));
  }

  function handleTagComplete(id: string) {
    setBooksToTag(prev => prev.filter(b => b.id !== id));
  }

  // ── Recommendation feedback handlers ─────────────────────────────────────

  async function handleRecSave(book: ScoredBook) {
    if (!supabase || !currentUserId) return;

    // For OL-sourced books: find or create the book record in the DB first
    // so we have a stable book_db_id for the user_books insert.
    let bookDbId: string | null = null;
    if (book._source === 'catalog') {
      bookDbId = book.id;
    } else if (book.external_id) {
      const { data: existing } = await supabase
        .from('books')
        .select('id')
        .eq('external_id', book.external_id)
        .maybeSingle();

      if (existing) {
        bookDbId = existing.id;
      } else {
        const { data: created } = await supabase
          .from('books')
          .insert({
            title:       book.title,
            author:      book.author,
            external_id: book.external_id,
            cover_url:   book.cover_url,
            subjects:    book.subjects,
            page_count:  book.page_count,
          })
          .select('id')
          .single();
        bookDbId = created?.id ?? null;
      }
    }

    if (bookDbId) {
      // Add to library if not already there
      await supabase
        .from('user_books')
        .upsert(
          { user_id: currentUserId, book_id: bookDbId, status: 'want_to_read' },
          { onConflict: 'user_id,book_id', ignoreDuplicates: true },
        );
    }

    // Persist feedback (best-effort)
    persistFeedback(supabase, currentUserId, book, 'saved', {
      book_db_id: bookDbId ?? undefined,
    }).catch(() => {});

    // Optimistic UI: remove from recommendations list
    setRecommendations(prev => prev.filter(b => b.id !== book.id));

    // Toast
    setSaveToast(`"${book.title}" added to your library`);
    setTimeout(() => setSaveToast(null), 2800);
  }

  async function handleRecDismiss(book: ScoredBook) {
    if (!supabase || !currentUserId) return;
    persistFeedback(supabase, currentUserId, book, 'dismissed').catch(() => {});
    // Optimistic UI: already animated out by RecCard, now remove from list
    setRecommendations(prev => prev.filter(b => b.id !== book.id));
    // Update local feedback context so dismissed book is excluded if the list reloads
    setFeedbackCtx(prev => {
      const next = new Set(prev.dismissedIds);
      if (book.external_id) next.add(book.external_id);
      if (book._source === 'catalog') next.add(book.id);
      return { ...prev, dismissedIds: next };
    });
  }

  async function handleRecMoreLikeThis(book: ScoredBook) {
    if (!supabase || !currentUserId) return;
    persistFeedback(supabase, currentUserId, book, 'more_like_this').catch(() => {});
    // Update local feedback context so subsequent scoring applies boost immediately
    const genre = getBookTraits(book).primaryGenre;
    if (!genre) return;
    setFeedbackCtx(prev => {
      const current = prev.genreBoosts[genre] ?? 0;
      const next    = Math.min(0.20, current === 0 ? 0.12 : current + 0.06);
      return { ...prev, genreBoosts: { ...prev.genreBoosts, [genre]: +next.toFixed(2) } };
    });
  }

  function handleRecImpression(book: ScoredBook) {
    if (!supabase || !currentUserId) return;
    // Fire-and-forget impression tracking
    persistFeedback(supabase, currentUserId, book, 'impression').catch(() => {});
  }

  function handleRecExplanationOpen(book: ScoredBook) {
    if (!supabase || !currentUserId) return;
    persistFeedback(supabase, currentUserId, book, 'explanation_opened').catch(() => {});
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
    const hasRecs         = recommendations.length > 0;

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
          <View style={{ gap: 8 }}>
            <SectionLabel>For You</SectionLabel>
            <SkeletonCard stars />
            <SkeletonCard stars />
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
            <View style={{ marginBottom: 36 }}>
              <SectionLabel>For You</SectionLabel>

              {/* ── Personalised picks loading skeleton ── */}
              {recsLoading && (
                <View style={{ marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1 }}>
                      Picked for you
                    </Text>
                    <ActivityIndicator size="small" color="#a8a29e" />
                  </View>
                  <SkeletonCard />
                  <SkeletonCard />
                  <SkeletonCard />
                </View>
              )}

              {/* ── Personalised picks (tier ≥ 1) ── */}
              {hasRecs && !recsLoading && (
                <View style={{ marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1 }}>
                      Picked for you
                    </Text>
                    <Text style={{ fontSize: 11, color: '#a8a29e' }}>
                      {tasteProfile?.label ?? ''}
                    </Text>
                  </View>

                  {/* Save toast */}
                  {saveToast && (
                    <View style={{
                      backgroundColor: '#f0fdf4',
                      borderRadius: 8,
                      paddingHorizontal: 12,
                      paddingVertical: 9,
                      marginBottom: 8,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                    }}>
                      <Text style={{ color: '#16a34a', fontSize: 12, flex: 1 }}>
                        ✓ {saveToast}
                      </Text>
                    </View>
                  )}

                  {recommendations.map(rec => (
                    <RecCard
                      key={rec.id}
                      book={rec}
                      onSave={() => handleRecSave(rec)}
                      onDismiss={() => handleRecDismiss(rec)}
                      onMoreLikeThis={() => handleRecMoreLikeThis(rec)}
                      onImpression={() => handleRecImpression(rec)}
                      onExplanationOpen={() => handleRecExplanationOpen(rec)}
                    />
                  ))}

                  {/* ── Retrieval trace debug panel ── */}
                  {recsMeta && (
                    <View style={{ marginTop: 4 }}>
                      <TouchableOpacity
                        onPress={() => {
                          const open = !traceOpen;
                          setTraceOpen(open);
                          Animated.timing(traceHeight, {
                            toValue: open ? 1 : 0,
                            duration: 200,
                            useNativeDriver: false,
                          }).start();
                        }}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 6,
                        }}
                      >
                        <Text style={{ fontSize: 10, color: '#a8a29e', flex: 1 }}>
                          {traceOpen ? '▲' : '▼'}  Debug — retrieval trace
                        </Text>
                        <Text style={{ fontSize: 10, color: '#d6d3d1' }}>
                          pool {recsMeta.pool_size} · excl {recsMeta.hygiene_excluded} · enr {recsMeta.enriched_count}
                        </Text>
                      </TouchableOpacity>

                      <Animated.View style={{
                        maxHeight: traceHeight.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0, 400],
                        }),
                        overflow: 'hidden',
                      }}>
                        <View style={{
                          backgroundColor: '#fafaf9',
                          borderRadius: 10,
                          padding: 10,
                          borderWidth: 1,
                          borderColor: '#e7e5e4',
                          marginBottom: 8,
                        }}>
                          {/* Sources row */}
                          <View style={{ flexDirection: 'row', gap: 16, marginBottom: 8 }}>
                            {[
                              { label: 'Catalog',    value: recsMeta.catalog_count },
                              { label: 'OL live',    value: recsMeta.live_ol_count },
                              { label: 'OL cached',  value: recsMeta.cached_external_count },
                              { label: 'Excluded',   value: recsMeta.hygiene_excluded },
                              { label: 'Enriched',   value: recsMeta.enriched_count },
                            ].map(({ label, value }) => (
                              <View key={label}>
                                <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e' }}>{label.toUpperCase()}</Text>
                                <Text style={{ fontSize: 11, color: '#57534e' }}>{value}</Text>
                              </View>
                            ))}
                          </View>

                          {/* Anchors used */}
                          {recsMeta.retrieval_trace.top_genres_used.length > 0 && (
                            <View style={{ marginBottom: 6 }}>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e', marginBottom: 2 }}>GENRE ANCHORS</Text>
                              <Text style={{ fontSize: 10, color: '#57534e', lineHeight: 16 }}>
                                {recsMeta.retrieval_trace.top_genres_used.join('  ·  ')}
                              </Text>
                            </View>
                          )}
                          {recsMeta.retrieval_trace.liked_subjects_used.length > 0 && (
                            <View style={{ marginBottom: 6 }}>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e', marginBottom: 2 }}>SUBJECT ANCHORS</Text>
                              <Text style={{ fontSize: 10, color: '#57534e', lineHeight: 16 }}>
                                {recsMeta.retrieval_trace.liked_subjects_used.join('  ·  ')}
                              </Text>
                            </View>
                          )}
                          {recsMeta.retrieval_trace.liked_authors_used.length > 0 && (
                            <View style={{ marginBottom: 6 }}>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e', marginBottom: 2 }}>AUTHOR ANCHORS</Text>
                              <Text style={{ fontSize: 10, color: '#57534e', lineHeight: 16 }}>
                                {recsMeta.retrieval_trace.liked_authors_used.join('  ·  ')}
                              </Text>
                            </View>
                          )}
                          {recsMeta.retrieval_trace.ol_queries.length > 0 && (
                            <View>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e', marginBottom: 2 }}>
                                OL QUERIES ({recsMeta.retrieval_trace.ol_queries.length})
                              </Text>
                              {recsMeta.retrieval_trace.ol_queries.slice(0, 8).map((q, i) => (
                                <Text key={i} style={{ fontSize: 9, color: '#a8a29e', lineHeight: 15 }}>
                                  {i + 1}. {q}
                                </Text>
                              ))}
                            </View>
                          )}
                        </View>
                      </Animated.View>
                    </View>
                  )}
                </View>
              )}

              {/* ── Quality gate: not enough signal or coverage ── */}
              {recsQualityGate && !recsLoading && !hasRecs && (tasteProfile?.tier ?? 0) >= 1 && (
                <View style={{
                  backgroundColor: '#fff',
                  borderRadius: 14,
                  padding: 16,
                  marginBottom: 16,
                  borderWidth: 1,
                  borderColor: '#e7e5e4',
                }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
                    {recsQualityGate === 'insufficient_pool'
                      ? 'Not enough books in your genres yet'
                      : "No close matches in the current catalog"}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
                    {recsQualityGate === 'insufficient_pool'
                      ? 'We need more books in the genres you enjoy before we can make confident picks. Rate a few more books or add taste tags to help us.'
                      : 'None of the books in our catalog scored closely enough against your profile. Keep rating books — your picks will sharpen as we learn more.'}
                  </Text>
                </View>
              )}

              {/* ── No recs + no tasks → caught up ── */}
              {!hasRecs && !recsQualityGate && !recsLoading && !hasAnyTask && (
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
              )}

              {/* ── Tasks (always shown when available, regardless of recs) ── */}
              {hasAnyTask && (
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
