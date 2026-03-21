import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  LayoutAnimation,
  Modal,
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
import { getCandidateBooks, getRankedRecs, fitLabel, fitColor, getPersonalizedRecsWithExpert } from '../../lib/recommender';
import type { ScoredBook, QualityGate, RankedRecsResult } from '../../lib/recommender';
import {
  emptyIntent as emptyNextReadIntent,
  isIntentActive,
  intentSummaryLabel,
  parseNaturalLanguageIntent,
  mergeIntents,
} from '../../lib/nextReadIntent';
import type { NextReadIntent, NextReadPace, NextReadTone, NLParseResult } from '../../lib/nextReadIntent';
import { loadFeedbackContext, persistFeedback, emptyContext } from '../../lib/recFeedback';
import type { FeedbackContext } from '../../lib/recFeedback';
import { getBookTraits, detectBookLane, detectBookMysterySubtype, isPhilosophyOrSpiritual } from '../../lib/bookTraits';
import type { DeterministicLane } from '../../lib/bookTraits';
import { getEntitlement } from '../../lib/recEntitlement';
import type { RecEntitlement } from '../../lib/recEntitlement';
import type { ReaderThesis } from '../../lib/expertRec';
import { getSeriesCatalog } from '../../lib/seriesCatalog';

// ─── Dev / internal constants ─────────────────────────────────────────────────
// Debug UI (retrieval trace, candidate audit) is only shown for this user.
// All other users — including beta testers — see a clean, production-ready screen.
const INTERNAL_DEBUG_USER = '986aece4-9461-439c-bff9-3589161b313c';

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

// ─── "Your Next Read" intent panel ───────────────────────────────────────────
// Collapsible filter/preference panel that sits above the recommendation cards.
// Drives the NextReadIntent model: hard filters, soft preferences, exclusions.
//
// Design: warm stone palette, pill/chip buttons, expandable with animation.
// Intent state is managed as a "draft" until the user taps Apply.

type NextReadPanelProps = {
  draft:         NextReadIntent;
  setDraft:      (intent: NextReadIntent) => void;
  nlInput:       string;
  setNlInput:    (s: string) => void;
  open:          boolean;
  panelHeight:   Animated.Value;
  onToggle:      () => void;
  onApply:       (mergedIntent: NextReadIntent) => void;
  onClear:       () => void;
  activeIntent:  NextReadIntent;
};

// Lane options — two chips cover scifi_fantasy (Fantasy + Sci-fi) for clarity.
// Both map to the same underlying lane; selecting either adds it.
const LANE_OPTIONS: Array<{ lane: DeterministicLane; label: string }> = [
  { lane: 'scifi_fantasy',        label: 'Fantasy'              },
  { lane: 'scifi_fantasy',        label: 'Sci-fi'               },
  { lane: 'modern_suspense',      label: 'Thriller'             },
  { lane: 'romantasy',            label: 'Romantasy'            },
  { lane: 'romance',              label: 'Romance'              },
  { lane: 'horror',               label: 'Horror'               },
  { lane: 'memoir_nonfiction',    label: 'Memoir'               },
  { lane: 'contemporary_fiction', label: 'Contemporary fiction' },
  { lane: 'literary',             label: 'Literary fiction'     },
];

function NextReadPanel({
  draft, setDraft, nlInput, setNlInput,
  open, panelHeight, onToggle, onApply, onClear, activeIntent,
}: NextReadPanelProps) {
  const isActive   = isIntentActive(activeIntent);
  const nlParsed   = nlInput.trim() ? parseNaturalLanguageIntent(nlInput) : null;
  const hasNLMatch = nlParsed?.interpreted ?? false;

  // ── Pill helpers ────────────────────────────────────────────────────────────

  function Pill({
    label, active, onPress,
  }: { label: string; active: boolean; onPress: () => void }) {
    return (
      <TouchableOpacity
        onPress={onPress}
        style={{
          backgroundColor: active ? '#1c1917' : '#f5f5f4',
          borderRadius: 20,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderWidth: 1,
          borderColor: active ? '#1c1917' : '#e7e5e4',
        }}
      >
        <Text style={{
          fontSize: 12,
          fontWeight: active ? '600' : '400',
          color: active ? '#faf9f7' : '#57534e',
        }}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  }

  function PillRow({ children }: { children: React.ReactNode }) {
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {children}
      </View>
    );
  }

  function SectionLabel({ children }: { children: string }) {
    return (
      <Text style={{
        fontSize: 10, fontWeight: '700', color: '#a8a29e',
        letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 7,
      }}>
        {children}
      </Text>
    );
  }

  // ── Lane toggle ─────────────────────────────────────────────────────────────

  function toggleLane(lane: DeterministicLane) {
    const current = draft.hard.lanes ?? [];
    const next    = current.includes(lane)
      ? current.filter(l => l !== lane)
      : [...current, lane];
    setDraft({ ...draft, hard: { ...draft.hard, lanes: next.length ? next : undefined } });
  }

  function isLaneActive(lane: DeterministicLane): boolean {
    return (draft.hard.lanes ?? []).includes(lane);
  }

  // ── Pace / tone / intensity toggles (single-select within each group) ────────

  function setPace(pace: NextReadPace) {
    setDraft({ ...draft, soft: { ...draft.soft, pace: draft.soft.pace === pace ? null : pace } });
  }

  function setTone(tone: NextReadTone) {
    setDraft({ ...draft, soft: { ...draft.soft, tone: draft.soft.tone === tone ? null : tone } });
  }

  function setIntensity(level: 'high' | 'low') {
    setDraft({ ...draft, soft: { ...draft.soft, intensity: draft.soft.intensity === level ? null : level } });
  }

  // ── Format toggles ──────────────────────────────────────────────────────────

  function toggleStandalone() {
    setDraft({ ...draft, hard: { ...draft.hard, standalone_only: !draft.hard.standalone_only } });
  }

  function toggleShort() {
    const current = draft.hard.max_page_count;
    setDraft({ ...draft, hard: { ...draft.hard, max_page_count: current ? null : 350 } });
  }

  // ── Exclusion toggles ───────────────────────────────────────────────────────

  function toggleExclude(key: keyof NextReadIntent['exclude']) {
    setDraft({ ...draft, exclude: { ...draft.exclude, [key]: !draft.exclude[key] } });
  }

  // ── Apply: merge chip draft + NL-parsed intent ───────────────────────────────

  function handleApply() {
    const nlIntent = nlParsed?.intent ?? emptyNextReadIntent();
    const merged   = mergeIntents(draft, nlIntent);
    onApply(merged);
  }

  // ── Collapsed summary ───────────────────────────────────────────────────────

  const summaryText = isActive ? intentSummaryLabel(activeIntent) : null;

  return (
    <View style={{ marginBottom: 10 }}>

      {/* ── Toggle row ── */}
      <TouchableOpacity
        onPress={onToggle}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 9,
          paddingHorizontal: 13,
          backgroundColor: isActive ? '#f5f0e8' : '#f5f5f4',
          borderRadius: 9,
          borderWidth: 1,
          borderColor: isActive ? '#d6c9b0' : '#e7e5e4',
        }}
      >
        <Text style={{ fontSize: 12, color: '#78716c', flex: 1, lineHeight: 17 }}>
          {open ? '▲' : '▼'}{'  '}
          {isActive && summaryText
            ? summaryText
            : 'Tell us what sounds good'
          }
        </Text>
        {isActive && (
          <View style={{
            backgroundColor: '#1c1917', borderRadius: 4,
            paddingHorizontal: 5, paddingVertical: 2,
          }}>
            <Text style={{ fontSize: 9, fontWeight: '700', color: '#faf9f7', letterSpacing: 0.4 }}>
              FILTERED
            </Text>
          </View>
        )}
      </TouchableOpacity>

      {/* ── Expandable body ── */}
      <Animated.View style={{
        maxHeight: panelHeight.interpolate({ inputRange: [0, 1], outputRange: [0, 720] }),
        overflow: 'hidden',
      }}>
        <View style={{
          backgroundColor: '#faf9f7',
          borderRadius: 10,
          padding: 14,
          marginTop: 4,
          borderWidth: 1,
          borderColor: '#e7e5e4',
          gap: 14,
        }}>

          {/* ── Natural-language freeform input ── */}
          <View>
            <SectionLabel>Describe what you want</SectionLabel>
            <TextInput
              value={nlInput}
              onChangeText={setNlInput}
              placeholder={'e.g. "Fast-paced thriller, standalone, not too dark"'}
              placeholderTextColor="#c4bdb7"
              multiline
              numberOfLines={2}
              style={{
                backgroundColor: '#fff',
                borderRadius: 9,
                paddingHorizontal: 11,
                paddingVertical: 9,
                fontSize: 13,
                color: '#1c1917',
                lineHeight: 19,
                borderWidth: 1,
                borderColor: '#e7e5e4',
                minHeight: 52,
                textAlignVertical: 'top',
              }}
            />
            {hasNLMatch && nlParsed && (
              <View style={{
                flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6,
                paddingHorizontal: 2,
              }}>
                <Text style={{ fontSize: 10, color: '#a8a29e', alignSelf: 'center', marginRight: 2 }}>
                  Using:
                </Text>
                {nlParsed.labels.map(label => (
                  <View key={label} style={{
                    backgroundColor: '#f0ede8', borderRadius: 10,
                    paddingHorizontal: 8, paddingVertical: 3,
                  }}>
                    <Text style={{ fontSize: 10, color: '#57534e', fontWeight: '500' }}>
                      {label}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {nlInput.trim().length > 0 && !hasNLMatch && (
              <Text style={{ fontSize: 10, color: '#a8a29e', marginTop: 5, paddingHorizontal: 2 }}>
                No signals detected — try words like "fast-paced", "thriller", or "standalone".
              </Text>
            )}
          </View>

          {/* ── Genre / Lane ── */}
          <View>
            <SectionLabel>What are you in the mood for?</SectionLabel>
            <PillRow>
              {LANE_OPTIONS.map(({ lane, label }, idx) => (
                <Pill
                  key={`${lane}-${idx}`}
                  label={label}
                  active={isLaneActive(lane)}
                  onPress={() => toggleLane(lane)}
                />
              ))}
            </PillRow>
          </View>

          {/* ── Pace + Tone + Intensity ── */}
          <View>
            <SectionLabel>How should it feel?</SectionLabel>
            <PillRow>
              <Pill label="Fast-paced"          active={draft.soft.pace === 'fast'}       onPress={() => setPace('fast')}          />
              <Pill label="Slow burn"            active={draft.soft.pace === 'slow'}       onPress={() => setPace('slow')}          />
              <Pill label="Light"                active={draft.soft.tone === 'light'}      onPress={() => setTone('light')}         />
              <Pill label="Darker"               active={draft.soft.tone === 'dark'}       onPress={() => setTone('dark')}          />
              <Pill label="Emotionally intense"  active={draft.soft.intensity === 'high'}  onPress={() => setIntensity('high')}     />
              <Pill label="Low-key"              active={draft.soft.intensity === 'low'}   onPress={() => setIntensity('low')}      />
            </PillRow>
          </View>

          {/* ── Format ── */}
          <View>
            <SectionLabel>Anything specific?</SectionLabel>
            <PillRow>
              <Pill label="Standalone"    active={!!draft.hard.standalone_only}          onPress={toggleStandalone} />
              <Pill label="Shorter read"  active={draft.hard.max_page_count === 350}    onPress={toggleShort}      />
            </PillRow>
          </View>

          {/* ── Avoid / Exclusions ── */}
          <View>
            <SectionLabel>What to avoid?</SectionLabel>
            <PillRow>
              <Pill label="No classics"      active={!!draft.exclude.avoid_classics}   onPress={() => toggleExclude('avoid_classics')}   />
              <Pill label="No dark content"  active={!!draft.exclude.avoid_dark}       onPress={() => toggleExclude('avoid_dark')}       />
              <Pill label="More accessible"  active={!!draft.exclude.avoid_literary}   onPress={() => toggleExclude('avoid_literary')}   />
              <Pill label="No romance"       active={!!draft.exclude.avoid_romance}    onPress={() => toggleExclude('avoid_romance')}    />
              <Pill label="Fiction only"     active={!!draft.exclude.avoid_nonfiction} onPress={() => toggleExclude('avoid_nonfiction')} />
              <Pill label="No series"        active={!!draft.exclude.avoid_series}     onPress={() => toggleExclude('avoid_series')}     />
            </PillRow>
          </View>

          {/* ── Action buttons ── */}
          <View style={{ flexDirection: 'row', gap: 8, paddingTop: 2 }}>
            <TouchableOpacity
              onPress={onClear}
              style={{
                flex: 1, paddingVertical: 10, borderRadius: 8,
                backgroundColor: '#f5f5f4',
                borderWidth: 1, borderColor: '#e7e5e4',
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#57534e' }}>Clear</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleApply}
              style={{
                flex: 2, paddingVertical: 10, borderRadius: 8,
                backgroundColor: '#1c1917',
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#faf9f7' }}>
                {hasNLMatch ? 'Apply' : 'Apply filters'}
              </Text>
            </TouchableOpacity>
          </View>

        </View>
      </Animated.View>
    </View>
  );
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

// Strip "By [Author], " prefix from reason text since author is already shown.
function stripAuthorPrefix(reason: string, author: string): string {
  const prefix = `By ${author}, `;
  if (reason.startsWith(prefix)) return reason.slice(prefix.length);
  if (reason.toLowerCase().startsWith(prefix.toLowerCase())) return reason.slice(prefix.length);
  return reason;
}

// Capitalise first letter after stripping prefix
function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

type SeriesCover = { olKey: string; coverId: number | null; title: string };

function RecCard({
  book,
  isExpert         = false,
  onSave           = () => {},
  onDismiss        = () => {},
  onMoreLikeThis   = () => {},
  onImpression     = () => {},
  onExplanationOpen= () => {},
}: {
  book:              ScoredBook;
  isExpert?:         boolean;
  onSave?:           () => void;
  onDismiss?:        () => void;
  onMoreLikeThis?:   () => void;
  onImpression?:     () => void;
  onExplanationOpen?:() => void;
}) {
  const router = useRouter();

  // Animation ref — card fade-out on dismiss/save
  const opacity = useRef(new Animated.Value(1)).current;

  // Local state
  const [moreDone, setMoreDone]           = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [seriesCovers, setSeriesCovers]   = useState<SeriesCover[]>([]);
  const seriesRowOpacity = useRef(new Animated.Value(0)).current;
  const impressionFired  = useRef(false);

  // Fire impression once on mount
  useEffect(() => {
    if (!impressionFired.current) {
      impressionFired.current = true;
      onImpression();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Canonical per-book cover lookup — strict series data contract.
  //
  // Series structure (name, position, total, order) comes exclusively from
  // the static seriesCatalog.  Open Library is used only to resolve a cover
  // IMAGE for each known series book — it is never used to discover series
  // membership or count.
  //
  // CONTRACT VALIDATION (all conditions must hold to render any series UI):
  //   1. series_name is present and catalogued in seriesCatalog
  //   2. series_position is present
  //   3. series_total is present (set by RIL from catalog)
  //   4. Every book in catalog.orderedBooks returns exactly one canonical
  //      single-edition cover (no collections, omnibus, boxed sets)
  //
  // If ANY condition fails → series UI is fully hidden.
  useEffect(() => {
    const sn = book._score_breakdown.series_name;
    const sp = book._score_breakdown.series_position;
    if (!sn || sp == null) return;

    const meta = getSeriesCatalog(sn);
    if (!meta) return; // Not in static catalog → no series UI

    const BAD_EDITION = /collection|omnibus|boxed|box set|complete works|anthology/i;

    // One targeted OL lookup per series book (title + author, limit 5).
    // No sort applied — default relevance ranking returns the best-indexed
    // edition first, which is far more likely to carry cover_i than the
    // oldest edition (sort=old biases toward un-scanned archival entries).
    const fetchCover = async (
      b: { title: string; author: string },
    ): Promise<SeriesCover | null> => {
      try {
        const url = [
          'https://openlibrary.org/search.json',
          `?title=${encodeURIComponent(b.title)}`,
          `&author=${encodeURIComponent(b.author)}`,
          '&fields=key,title,cover_i&limit=5',
        ].join('');
        const data: { docs?: Array<{ key: string; cover_i?: number; title?: string }> } =
          await fetch(url).then(r => r.json());
        const docs = data.docs ?? [];
        const clean = docs.find(d => d.cover_i != null && !BAD_EDITION.test(d.title ?? ''));
        if (!clean || clean.cover_i == null) return null;
        return { olKey: clean.key, coverId: clean.cover_i, title: clean.title ?? b.title };
      } catch {
        return null;
      }
    };

    let cancelled = false;
    Promise.all(meta.orderedBooks.map(fetchCover)).then(results => {
      if (cancelled) return;
      // Strict: if any book in the catalog list could not get a canonical
      // single-edition cover, the contract is violated → hide all series UI.
      if (results.some(r => r === null)) return;
      const covers = results as SeriesCover[];
      setSeriesCovers(covers);
      Animated.timing(seriesRowOpacity, {
        toValue:         1,
        duration:        420,
        delay:           80,
        useNativeDriver: false,
      }).start();
    });

    return () => { cancelled = true; };
  // Only run on mount — series name/position don't change per card
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

  const uncertainty = book.score < 0.20
    ? 'Early signal — confidence will grow as your profile develops.'
    : book.score < 0.32
    ? 'Moderate fit — a few more ratings will sharpen this pick.'
    : null;

  // Series contract — all fields must be present for any series UI to render.
  // catalogMeta is null when series_name is not in the static catalog, which
  // means series_total is also null (RIL sets it from the same catalog lookup).
  const seriesPos    = book._score_breakdown.series_position;
  const seriesTotal  = book._score_breakdown.series_total;
  const catalogMeta  = getSeriesCatalog(book._score_breakdown.series_name ?? '');
  // The cover array is populated only when ALL catalog.orderedBooks returned a
  // canonical single-edition cover (see useEffect above).  Length equality
  // with orderedBooks confirms the strict fetch succeeded end-to-end.
  const hasSeriesRow =
    catalogMeta != null &&
    seriesPos   != null &&
    seriesTotal != null &&
    seriesCovers.length === catalogMeta.orderedBooks.length;

  // Reason text for collapsed view — strip author prefix since author is shown above
  const collapsedReason = book.reasons.length > 0
    ? capitalize(stripAuthorPrefix(book.reasons[0], book.author))
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
          {/* Title */}
          <Text
            style={{ fontSize: 15, fontWeight: '700', color: '#1c1917', lineHeight: 21, marginBottom: 3 }}
            numberOfLines={2}
          >
            {book.title}
          </Text>

          {/* Author + expert badge */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6 }}>
            <Text style={{ fontSize: 12, color: '#78716c', flex: 1 }} numberOfLines={1}>
              {book.author}
            </Text>
            {isExpert && (
              <View style={{
                backgroundColor: '#1c1917', borderRadius: 4,
                paddingHorizontal: 5, paddingVertical: 2,
              }}>
                <Text style={{ fontSize: 9, fontWeight: '700', color: '#faf9f7', letterSpacing: 0.4 }}>
                  EXPERT PICK
                </Text>
              </View>
            )}
          </View>

          {/* ── Series visual row ── */}
          {hasSeriesRow && (
            <Animated.View style={{
              opacity:        seriesRowOpacity,
              flexDirection:  'row',
              alignItems:     'flex-end',
              gap:            5,
              marginBottom:   8,
            }}>
              {seriesCovers.map((sc, i) => {
                // Position is 1-indexed; orderedBooks is in series order so
                // index i corresponds to series position i+1.
                const isCurrent = (i + 1) === seriesPos;
                const coverUri  = sc.coverId
                  ? `https://covers.openlibrary.org/b/id/${sc.coverId}-S.jpg`
                  : null;
                return (
                  <View
                    key={sc.olKey}
                    style={{
                      opacity:      isCurrent ? 1 : 0.38,
                      borderWidth:  isCurrent ? 1.5 : 0,
                      borderColor:  '#1c1917',
                      borderRadius: 4,
                    }}
                  >
                    {coverUri ? (
                      <Image
                        source={{ uri: coverUri }}
                        style={{
                          width:           isCurrent ? 34 : 27,
                          height:          isCurrent ? 50 : 42,
                          borderRadius:    3,
                          backgroundColor: '#e7e5e4',
                        }}
                      />
                    ) : (
                      <View style={{
                        width:           isCurrent ? 34 : 27,
                        height:          isCurrent ? 50 : 42,
                        borderRadius:    3,
                        backgroundColor: '#ece9e4',
                        borderWidth:     1,
                        borderColor:     '#e0dbd4',
                      }} />
                    )}
                  </View>
                );
              })}
            </Animated.View>
          )}

          {/* ── Series badge ────────────────────────────────────────────────────
               Only rendered when the full series contract is valid:
               - series in static catalog
               - series_position and series_total both present
               - all catalog.orderedBooks have canonical single-edition covers
               If the contract is invalid the card renders as a standalone rec.
               Copy is intentionally minimal — richer info lives in the detail
               view. */}
          {hasSeriesRow && (
            <View style={{
              alignSelf:        'flex-start',
              flexDirection:    'row',
              alignItems:       'center',
              gap:              4,
              marginBottom:     6,
              paddingHorizontal:7,
              paddingVertical:  3,
              borderRadius:     6,
              backgroundColor:  book._score_breakdown.series_label === 'series_starter'
                ? '#fef3c7'
                : '#f0fdf4',
            }}>
              <Text style={{
                fontSize:     10,
                fontWeight:   '600',
                color:        book._score_breakdown.series_label === 'series_starter'
                  ? '#92400e'
                  : '#166534',
                letterSpacing: 0.2,
              }}>
                {book._score_breakdown.series_label === 'series_starter'
                  ? 'Start here'
                  : 'Continue the series'}
              </Text>
            </View>
          )}

          {/* Collapsed: 1 short reason (author prefix stripped) */}
          {collapsedReason && (
            <Text style={{ fontSize: 12, color: '#57534e', lineHeight: 17 }} numberOfLines={2}>
              {collapsedReason}
            </Text>
          )}

          {/* View details CTA — same navigation contract as Library/Home.
              The `id` param must be non-empty for Expo Router to match /book/[id]
              and for the detail screen's enrichment useEffect to fire.
              For recommendation cards that are not yet in the user's library,
              we have no DB UUID; pass the OL work key (sans /works/ prefix) so
              the route matches. The detail screen's DB lookups return nothing
              (graceful) while OL metadata loads via the separate `externalId` param. */}
          <TouchableOpacity
            onPress={() => router.push({
              pathname: '/book/[id]',
              params: {
                id:         book.external_id?.replace('/works/', '') ?? 'rec',
                title:      book.title,
                author:     book.author,
                coverUrl:   book.cover_url ?? '',
                externalId: book.external_id ?? '',
              },
            })}
            style={{ marginTop: 9 }}
          >
            <Text style={{ fontSize: 11, color: '#78716c', fontWeight: '500' }}>
              View details →
            </Text>
          </TouchableOpacity>
        </View>
      </View>

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

    </Animated.View>
  );
}

// ─── Forensic audit types ─────────────────────────────────────────────────────

type AuditCandidate = {
  rank: number;
  title: string;
  author: string;
  source: string;
  retrieval_reason: string;
  fit_class: string;
  trait_alignment: number;
  subject_overlap_hits: string[];
  subject_overlap_bonus: number;
  genre_bonus: number;
  penalty: number;
  final_score: number;
  flags: string[];
};

type AuditRec = {
  rank: number;
  title: string;
  author: string;
  score: number;
  fit_class: string;
  reason: string;
};

type ForensicAudit = {
  user_id: string;
  timestamp: string;
  profile: {
    imported_books_count: number;
    strongSignalCount: number;
    tier: number;
    genre_affinities: Record<string, number>;
    preferred_traits: Record<string, number>;
    dominant_lanes: string[];
    repeated_liked_authors: string[];
    liked_subjects: string[];
  };
  fresh: {
    mode: string;
    cache_hit: boolean;
    genres_used: string[];
    subjects_used: string[];
    authors_used: string[];
    ol_queries: string[];
    pool_size: number;
    catalog_count: number;
    live_ol_count: number;
    cached_external_count: number;
    hygiene_excluded: number;
    enriched_count: number;
    top20: AuditCandidate[];
    top10: AuditRec[];
  };
  cache?: {
    mode: string;
    cache_hit: boolean;
    genres_used: string[];
    subjects_used: string[];
    authors_used: string[];
    top10: AuditRec[];
    cache_built_at: string | null;
  };
};

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
  const [continuations,   setContinuations]   = useState<ScoredBook[]>([]);
  const [discoveries,     setDiscoveries]     = useState<ScoredBook[]>([]);

  // ── Entitlement + expert mode state ───────────────────────────────────────
  const [entitlement, setEntitlement]         = useState<RecEntitlement | null>(null);
  const [recMode, setRecMode]                 = useState<'deterministic' | 'expert' | null>(null);
  const [readerThesis, setReaderThesis]       = useState<ReaderThesis | null>(null);
  const [isFreePreview, setIsFreePreview]     = useState(false);
  const [thesisOpen, setThesisOpen]           = useState(false);
  const thesisHeight                          = useRef(new Animated.Value(0)).current;

  // ── In-app forensic audit state ────────────────────────────────────────────
  const [forensicModalVisible, setForensicModalVisible] = useState(false);
  const [forensicAuditData, setForensicAuditData]       = useState<ForensicAudit | null>(null);
  const [auditRunning, setAuditRunning]                 = useState(false);
  const [auditSection, setAuditSection]                 = useState<'profile' | 'retrieval' | 'candidates' | 'recs'>('profile');

  // ── "Your Next Read" intent layer state ──────────────────────────────────
  const [nextReadIntent, setNextReadIntent]   = useState<NextReadIntent>(emptyNextReadIntent());
  const [draftIntent, setDraftIntent]         = useState<NextReadIntent>(emptyNextReadIntent());
  const [nlInput, setNlInput]                 = useState('');
  const [intentPanelOpen, setIntentPanelOpen] = useState(false);
  const intentPanelHeight                     = useRef(new Animated.Value(0)).current;

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

    const [rateRes, tagRes, incomingRes, sentRes, tp, ent] = await Promise.all([
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
    setEntitlement(ent);
    setHubLoading(false);

    // ── Phase 2: recommendation retrieval (profile-guided, includes OL calls) ─
    // Runs after Phase 1 state is committed so the hub is already visible.
    // Only fires when the user has enough signal for tier-1+ recommendations.
    if (!tp || tp.tier < 1) return;

    setRecsLoading(true);
    setRecsQualityGate(null);
    setRecMode(null);
    setIsFreePreview(false);
    try {
      // Load feedback context first (fast DB query) — drives candidate exclusion + boosts
      const fbCtx = await loadFeedbackContext(supabase!, user.id);
      setFeedbackCtx(fbCtx);

      // Run the unified pipeline (deterministic + optional expert layer)
      // Uses expert layer if entitlement allows + signal is sufficient
      const activeEntitlement = ent ?? { plan: 'free' as const, expert_recs_enabled: false, expert_refreshes_remaining_this_period: 0, has_used_free_import_analysis: false, next_refresh_available_at: null, _raw: { free_expert_used: false, expert_refreshes_this_period: 0, period_start_at: new Date().toISOString(), last_expert_refresh_at: null } };

      const recResult = await getPersonalizedRecsWithExpert(
        supabase!, user.id, tp, activeEntitlement, 5, fbCtx,
        isIntentActive(nextReadIntent) ? nextReadIntent : undefined,
      );
      const { recs, meta } = recResult;

      setRecommendations(recs);
      setContinuations(recResult.continuations ?? []);
      setDiscoveries(recResult.discoveries ?? recs);
      setRecsMeta(meta);
      setRecsQualityGate(meta.quality_gate !== 'passed' ? meta.quality_gate : null);
      setRecMode(meta.mode ?? 'deterministic');
      setReaderThesis(meta.reader_thesis ?? null);
      setIsFreePreview(meta.expert_decision?.is_free_preview ?? false);

      if (__DEV__) {
        console.log('[REC TRACE] mode:', meta.mode ?? 'deterministic', '| decision:', meta.expert_decision?.reason);
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
          from_cache: meta.is_from_cache,
        });
        if (meta.mode === 'expert' && meta.reader_thesis) {
          console.log('[EXPERT THESIS]', {
            dominant_lanes:   meta.reader_thesis.dominant_lanes.map(l => `${l.label} (${l.strength.toFixed(2)})`),
            center_of_gravity: meta.reader_thesis.center_of_gravity,
            guardrails:       meta.reader_thesis.recommendation_guardrails.length,
          });
        }
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

  // ── Reload recs with a specific intent (Phase 2 only, no hub re-fetch) ──────
  // Called when the user applies or clears their "Your Next Read" intent.
  // Re-runs the recommendation pipeline using already-loaded state values.
  // OL candidates are cached, so this is fast (DB read + in-memory scoring).

  async function reloadRecs(intent: NextReadIntent) {
    if (!supabase || !currentUserId || !tasteProfile || tasteProfile.tier < 1) return;
    setNextReadIntent(intent);
    setRecsLoading(true);
    setRecsQualityGate(null);
    try {
      const activeEntitlement = entitlement ?? {
        plan: 'free' as const,
        expert_recs_enabled: false,
        expert_refreshes_remaining_this_period: 0,
        has_used_free_import_analysis: false,
        next_refresh_available_at: null,
        _raw: {
          free_expert_used: false,
          expert_refreshes_this_period: 0,
          period_start_at: new Date().toISOString(),
          last_expert_refresh_at: null,
        },
      };
      const activeIntent = isIntentActive(intent) ? intent : undefined;
      const intentResult = await getPersonalizedRecsWithExpert(
        supabase!, currentUserId, tasteProfile, activeEntitlement, 5, feedbackCtx,
        activeIntent,
      );
      const { recs, meta } = intentResult;
      setRecommendations(recs);
      setContinuations(intentResult.continuations ?? []);
      setDiscoveries(intentResult.discoveries ?? recs);
      setRecsMeta(meta);
      setRecsQualityGate(meta.quality_gate !== 'passed' ? meta.quality_gate : null);
    } catch {
      // silent — recommendations fail gracefully
    } finally {
      setRecsLoading(false);
    }
  }

  // ── In-app live forensic audit ────────────────────────────────────────────

  async function runForensicAudit() {
    if (!supabase || !tasteProfile || !entitlement) return;
    setAuditRunning(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const fbCtx = await loadFeedbackContext(supabase, user.id);
      const activeEnt = entitlement;
      const likedSubjSet = new Set((tasteProfile.liked_subjects ?? []).map(s => s.toLowerCase().trim()));

      // ── Pass A: fresh (skip cache) ──────────────────────────────────────
      const freshResult = await getPersonalizedRecsWithExpert(
        supabase, user.id, tasteProfile, activeEnt, 10, fbCtx, undefined,
        { skipCache: true },
      );
      const freshMeta = freshResult.meta;
      const freshTrace = freshMeta.retrieval_trace;

      const top20: AuditCandidate[] = (freshMeta.candidate_audit ?? []).slice(0, 20).map((b, i) => {
        const bd = b._score_breakdown;
        const bookSubjs = (b.subjects ?? []).map(s => s.toLowerCase().trim());
        const subjHits  = bookSubjs.filter(s => likedSubjSet.has(s));
        return {
          rank:                  i + 1,
          title:                 b.title,
          author:                b.author,
          source:                b._source ?? '',
          retrieval_reason:      b._retrieval_reason ?? '',
          fit_class:             bd.fit_class ?? '',
          trait_alignment:       +bd.trait_alignment.toFixed(3),
          subject_overlap_hits:  subjHits.slice(0, 4),
          subject_overlap_bonus: +Math.min(0.06, subjHits.length * 0.02).toFixed(3),
          genre_bonus:           +bd.genre_bonus.toFixed(3),
          penalty:               +bd.metadata_penalty.toFixed(3),
          final_score:           +bd.final_score.toFixed(3),
          flags:                 bd.audit_flags.slice(0, 4),
        };
      });

      const top10Fresh: AuditRec[] = freshResult.recs.slice(0, 10).map((r, i) => ({
        rank:      i + 1,
        title:     r.title,
        author:    r.author,
        score:     +r.score.toFixed(3),
        fit_class: r._score_breakdown.fit_class ?? '',
        reason:    (r.reasons ?? []).slice(0, 2).join(' · '),
      }));

      // ── Pass B: cache (allow cache) ─────────────────────────────────────
      const cacheResult = await getPersonalizedRecsWithExpert(
        supabase, user.id, tasteProfile, activeEnt, 10, fbCtx, undefined,
        { skipCache: false },
      );
      const cacheMeta  = cacheResult.meta;
      const cacheTrace = cacheMeta.retrieval_trace;

      const top10Cache: AuditRec[] = cacheResult.recs.slice(0, 10).map((r, i) => ({
        rank:      i + 1,
        title:     r.title,
        author:    r.author,
        score:     +r.score.toFixed(3),
        fit_class: r._score_breakdown.fit_class ?? '',
        reason:    (r.reasons ?? []).slice(0, 2).join(' · '),
      }));

      const det = tasteProfile.det_lanes;
      const audit: ForensicAudit = {
        user_id:   user.id,
        timestamp: new Date().toISOString(),
        profile: {
          imported_books_count:  tasteProfile.evidence.imported_books_count,
          strongSignalCount:     tasteProfile.strongSignalCount,
          tier:                  tasteProfile.tier,
          genre_affinities:      Object.fromEntries(
            Object.entries(tasteProfile.genre_affinities)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([k, v]) => [k, +v.toFixed(2)])
          ),
          preferred_traits:      Object.fromEntries(
            Object.entries(tasteProfile.preferred_traits)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([k, v]) => [k, +v.toFixed(2)])
          ),
          dominant_lanes:        det?.dominant_lanes ?? [],
          repeated_liked_authors: det?.repeated_liked_authors ?? [],
          liked_subjects:        tasteProfile.liked_subjects ?? [],
        },
        fresh: {
          mode:                 freshMeta.mode ?? 'deterministic',
          cache_hit:            freshMeta.is_from_cache ?? false,
          genres_used:          freshTrace.top_genres_used,
          subjects_used:        freshTrace.liked_subjects_used,
          authors_used:         freshTrace.liked_authors_used,
          ol_queries:           freshTrace.ol_queries,
          pool_size:            freshMeta.pool_size,
          catalog_count:        freshMeta.catalog_count,
          live_ol_count:        freshMeta.live_ol_count,
          cached_external_count: freshMeta.cached_external_count,
          hygiene_excluded:     freshMeta.hygiene_excluded,
          enriched_count:       freshMeta.enriched_count,
          top20,
          top10: top10Fresh,
        },
        cache: {
          mode:         cacheMeta.mode ?? 'deterministic',
          cache_hit:    cacheMeta.is_from_cache ?? false,
          genres_used:  cacheTrace.top_genres_used,
          subjects_used: cacheTrace.liked_subjects_used,
          authors_used: cacheTrace.liked_authors_used,
          top10:        top10Cache,
          cache_built_at: cacheMeta.cache_built_at ?? null,
        },
      };

      setForensicAuditData(audit);
      setAuditSection('profile');
      setForensicModalVisible(true);

      // ── Chunked console backup (each chunk ≤400 chars) ──────────────────
      const chunks = [
        ['[AUD_PROF]', { uid: user.id.slice(0,8), ibc: audit.profile.imported_books_count, sc: audit.profile.strongSignalCount, tier: audit.profile.tier }],
        ['[AUD_AFFIN]', audit.profile.genre_affinities],
        ['[AUD_TRAITS]', audit.profile.preferred_traits],
        ['[AUD_LANES]', { lanes: audit.profile.dominant_lanes, authors: audit.profile.repeated_liked_authors.slice(0,5) }],
        ['[AUD_SUBJ]', audit.profile.liked_subjects.slice(0,10)],
        ['[AUD_FRESH_META]', { mode: audit.fresh.mode, cache_hit: audit.fresh.cache_hit, pool: audit.fresh.pool_size, excl: audit.fresh.hygiene_excluded, enr: audit.fresh.enriched_count }],
        ['[AUD_FRESH_TRACE]', { genres: audit.fresh.genres_used, subjects: audit.fresh.subjects_used, authors: audit.fresh.authors_used }],
        ['[AUD_CACHE_META]', { mode: audit.cache?.mode, cache_hit: audit.cache?.cache_hit, built: audit.cache?.cache_built_at }],
      ] as [string, unknown][];

      for (const [tag, payload] of chunks) {
        console.log(tag, JSON.stringify(payload));
      }
      audit.fresh.top20.slice(0, 10).forEach((c, i) => {
        console.log(`[AUD_C${String(i+1).padStart(2,'0')}]`, JSON.stringify({ r: c.rank, t: c.title.slice(0,22), tr: c.trait_alignment, so: c.subject_overlap_bonus, sh: c.subject_overlap_hits, gb: c.genre_bonus, pe: c.penalty, sc: c.final_score, fc: c.fit_class }));
      });
      audit.fresh.top10.forEach((r, i) => {
        console.log(`[AUD_R${i+1}]`, JSON.stringify({ t: r.title.slice(0,25), sc: r.score, fc: r.fit_class }));
      });

    } catch (e) {
      console.error('[FORENSIC AUDIT ERROR]', e);
    } finally {
      setAuditRunning(false);
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

    // Optimistic UI: remove from all buckets
    const bookFilter = (b: ScoredBook) => b.id !== book.id;
    setRecommendations(prev => prev.filter(bookFilter));
    setContinuations(prev   => prev.filter(bookFilter));
    setDiscoveries(prev     => prev.filter(bookFilter));

    // Toast
    setSaveToast(`"${book.title}" added to your library`);
    setTimeout(() => setSaveToast(null), 2800);
  }

  async function handleRecDismiss(book: ScoredBook) {
    if (!supabase || !currentUserId) return;
    persistFeedback(supabase, currentUserId, book, 'dismissed').catch(() => {});
    // Optimistic UI: remove from all buckets
    const bookFilter = (b: ScoredBook) => b.id !== book.id;
    setRecommendations(prev => prev.filter(bookFilter));
    setContinuations(prev   => prev.filter(bookFilter));
    setDiscoveries(prev     => prev.filter(bookFilter));
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
    const hasAnalyseTask  = (tasteProfile?.evidence.imported_books_count ?? 0) > 0 && (tasteProfile?.tier ?? 0) < 3;
    const hasAnyTask      = hasRateTasks || hasTagTasks || hasAnalyseTask;
    const hasRecs         = recommendations.length > 0 || continuations.length > 0;

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
                    {recMode === 'expert' ? (
                      <View style={{
                        backgroundColor: '#1c1917', borderRadius: 6,
                        paddingHorizontal: 7, paddingVertical: 3,
                      }}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: '#faf9f7', letterSpacing: 0.5 }}>
                          EXPERT
                        </Text>
                      </View>
                    ) : (
                      <Text style={{ fontSize: 11, color: '#a8a29e' }}>
                        {tasteProfile?.label ?? ''}
                      </Text>
                    )}
                  </View>

                  {/* ── Free preview moment ── */}
                  {isFreePreview && (
                    <View style={{
                      backgroundColor: '#f0fdf4', borderRadius: 10,
                      padding: 14, marginBottom: 12,
                      borderWidth: 1, borderColor: '#bbf7d0',
                    }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#15803d', marginBottom: 4 }}>
                        Your deep taste analysis is ready
                      </Text>
                      <Text style={{ fontSize: 12, color: '#166534', lineHeight: 18 }}>
                        We've analysed your reading history and built a personalised reader profile. These picks are selected against your specific taste lanes, not just broad genre preferences.
                      </Text>
                    </View>
                  )}

                  {/* ── Expert reader thesis panel (collapsible) ── */}
                  {recMode === 'expert' && readerThesis && (
                    <View style={{ marginBottom: 10 }}>
                      <TouchableOpacity
                        onPress={() => {
                          const open = !thesisOpen;
                          setThesisOpen(open);
                          Animated.timing(thesisHeight, {
                            toValue: open ? 1 : 0,
                            duration: 220,
                            useNativeDriver: false,
                          }).start();
                        }}
                        style={{
                          flexDirection: 'row', alignItems: 'center',
                          paddingVertical: 8, paddingHorizontal: 12,
                          backgroundColor: '#f5f5f4', borderRadius: 8,
                        }}
                      >
                        <Text style={{ fontSize: 11, color: '#57534e', flex: 1 }}>
                          {thesisOpen ? '▲' : '▼'}  Your reader profile
                        </Text>
                        <Text style={{ fontSize: 10, color: '#a8a29e' }}>
                          {readerThesis.dominant_lanes.length} lane{readerThesis.dominant_lanes.length !== 1 ? 's' : ''}
                        </Text>
                      </TouchableOpacity>
                      <Animated.View style={{
                        maxHeight: thesisHeight.interpolate({ inputRange: [0, 1], outputRange: [0, 320] }),
                        overflow: 'hidden',
                      }}>
                        <View style={{
                          backgroundColor: '#faf9f7', borderRadius: 10,
                          padding: 12, marginTop: 4,
                          borderWidth: 1, borderColor: '#e7e5e4',
                        }}>
                          <Text style={{ fontSize: 12, color: '#1c1917', lineHeight: 18, marginBottom: 8, fontStyle: 'italic' }}>
                            {readerThesis.center_of_gravity}
                          </Text>
                          {readerThesis.dominant_lanes.slice(0, 3).map(lane => (
                            <View key={lane.genre_key} style={{ marginBottom: 6 }}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <View style={{ width: Math.round(lane.strength * 48), height: 3, backgroundColor: '#1c1917', borderRadius: 2, opacity: 0.6 }} />
                                <Text style={{ fontSize: 11, fontWeight: '600', color: '#1c1917' }}>
                                  {lane.label.charAt(0).toUpperCase() + lane.label.slice(1)}
                                </Text>
                              </View>
                              {lane.evidence.books.length > 0 && (
                                <Text style={{ fontSize: 10, color: '#78716c', marginTop: 2, paddingLeft: 54 }} numberOfLines={1}>
                                  e.g. {lane.evidence.books.slice(0, 2).join(', ')}
                                </Text>
                              )}
                            </View>
                          ))}
                          {readerThesis.anti_preferences.length > 0 && (
                            <View style={{ marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e7e5e4' }}>
                              <Text style={{ fontSize: 10, fontWeight: '600', color: '#a8a29e', marginBottom: 4 }}>TENDS TO AVOID</Text>
                              {readerThesis.anti_preferences.slice(0, 2).map((ap, i) => (
                                <Text key={i} style={{ fontSize: 10, color: '#78716c', lineHeight: 16 }}>· {ap}</Text>
                              ))}
                            </View>
                          )}
                        </View>
                      </Animated.View>
                    </View>
                  )}

                  {/* ── Coming soon teaser ── */}
                  <View style={{
                    backgroundColor: '#fafaf9', borderRadius: 10,
                    padding: 14, marginBottom: 12,
                    borderWidth: 1, borderColor: '#e7e5e4',
                  }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 4 }}>
                      Coming soon
                    </Text>
                    <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
                      Deeper, more personalized recommendations based on your reading patterns.
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

                  {/* ── Currently Reading bucket ── */}
                  {continuations.length > 0 ? (
                    <>
                      <View style={{ marginBottom: 10, marginTop: 6 }}>
                        <Text style={{
                          fontSize: 16, fontWeight: '700',
                          color: '#1c1917', letterSpacing: -0.2,
                        }}>
                          Currently Reading
                        </Text>
                        <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }}>
                          Pick up where you left off
                        </Text>
                      </View>

                      {continuations.map(rec => (
                        <RecCard
                          key={rec.id}
                          book={rec}
                          isExpert={recMode === 'expert'}
                          onSave={() => handleRecSave(rec)}
                          onDismiss={() => handleRecDismiss(rec)}
                          onMoreLikeThis={() => handleRecMoreLikeThis(rec)}
                          onImpression={() => handleRecImpression(rec)}
                          onExplanationOpen={() => handleRecExplanationOpen(rec)}
                        />
                      ))}

                      {discoveries.length > 0 && (
                        <View style={{
                          height: 1, backgroundColor: '#e7e5e4',
                          marginTop: 8, marginBottom: 20,
                        }} />
                      )}
                    </>
                  ) : (
                    <View style={{
                      backgroundColor: '#faf9f7',
                      borderRadius: 10,
                      paddingVertical: 16,
                      paddingHorizontal: 14,
                      marginBottom: 20,
                      borderWidth: 1,
                      borderColor: '#e7e5e4',
                    }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 3 }}>
                        Currently Reading
                      </Text>
                      <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18 }}>
                        No active series yet — start one below.
                      </Text>
                    </View>
                  )}

                  {/* ── Discover Next bucket ── */}
                  {discoveries.length > 0 && (
                    <>
                      <View style={{ marginBottom: 10, marginTop: continuations.length === 0 ? 0 : 2 }}>
                        <Text style={{
                          fontSize: 16, fontWeight: '700',
                          color: '#1c1917', letterSpacing: -0.2,
                        }}>
                          Discover Next
                        </Text>
                        <Text style={{ fontSize: 12, color: '#78716c', marginTop: 2 }}>
                          New books aligned to your taste
                        </Text>
                      </View>

                      {discoveries.map(rec => (
                        <RecCard
                          key={rec.id}
                          book={rec}
                          isExpert={recMode === 'expert'}
                          onSave={() => handleRecSave(rec)}
                          onDismiss={() => handleRecDismiss(rec)}
                          onMoreLikeThis={() => handleRecMoreLikeThis(rec)}
                          onImpression={() => handleRecImpression(rec)}
                          onExplanationOpen={() => handleRecExplanationOpen(rec)}
                        />
                      ))}
                    </>
                  )}

                  {/* ── Retrieval trace debug panel (internal only, dev builds only) ── */}
                  {recsMeta && __DEV__ && currentUserId === INTERNAL_DEBUG_USER && (
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
                          {traceOpen ? '▲' : '▼'}  Debug — {recMode ?? 'det'} · {recsMeta.is_from_cache ? 'cached' : 'fresh'}
                          {recsMeta.intent_filtered_count ? ` · intent −${recsMeta.intent_filtered_count}` : ''}
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
                          {/* Current user ID */}
                          {currentUserId && (
                            <View style={{ marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e7e5e4' }}>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e', marginBottom: 2 }}>CURRENT USER_ID</Text>
                              <Text style={{ fontSize: 10, color: '#57534e', fontFamily: 'monospace' }} selectable>{currentUserId}</Text>
                            </View>
                          )}

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
                          {recsMeta.retrieval_trace.dense_import_mode && (
                            <View style={{ marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e7e5e4' }}>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#2563eb', marginBottom: 3 }}>DENSE-IMPORT MODE</Text>
                              {(recsMeta.retrieval_trace.detected_lanes ?? []).length > 0 && (
                                <Text style={{ fontSize: 9, color: '#57534e', lineHeight: 14, marginBottom: 2 }}>
                                  lanes: {(recsMeta.retrieval_trace.detected_lanes ?? []).join('  ·  ')}
                                </Text>
                              )}
                              {(recsMeta.retrieval_trace.repeated_authors_used ?? []).length > 0 && (
                                <Text style={{ fontSize: 9, color: '#57534e', lineHeight: 14 }}>
                                  repeated authors: {(recsMeta.retrieval_trace.repeated_authors_used ?? []).join('  ·  ')}
                                </Text>
                              )}
                            </View>
                          )}
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
                          {/* Intent pool summary */}
                          {recsMeta.intent_summary && (
                            <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e7e5e4' }}>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#7c3aed', marginBottom: 4 }}>
                                INTENT POOL SUMMARY
                              </Text>
                              <Text style={{ fontSize: 9, color: '#57534e', lineHeight: 14 }}>
                                {recsMeta.intent_summary.before_intent} non-rejected
                                {' → '}after intent: {recsMeta.intent_summary.after_intent}
                                {recsMeta.intent_summary.removed_by_exclusion > 0
                                  ? `  ·  excl: −${recsMeta.intent_summary.removed_by_exclusion}`
                                  : ''}
                                {recsMeta.intent_summary.removed_by_hard_filter > 0
                                  ? `  ·  hard: −${recsMeta.intent_summary.removed_by_hard_filter}`
                                  : ''}
                                {recsMeta.intent_summary.soft_boosted > 0
                                  ? `  ·  boosted: +${recsMeta.intent_summary.soft_boosted}`
                                  : ''}
                              </Text>
                              {Object.keys(recsMeta.intent_summary.exclusion_breakdown).length > 0 && (
                                <Text style={{ fontSize: 9, color: '#a8a29e', lineHeight: 13, marginTop: 2 }}>
                                  {Object.entries(recsMeta.intent_summary.exclusion_breakdown)
                                    .map(([k, v]) => `${k.replace('avoid_', '')}: ${v}`)
                                    .join('  ·  ')}
                                </Text>
                              )}
                            </View>
                          )}

                          {/* Forensic candidate audit table */}
                          {recsMeta.candidate_audit && recsMeta.candidate_audit.length > 0 && (
                            <View style={{ marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e7e5e4' }}>
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e' }}>
                                  CANDIDATE AUDIT (all {recsMeta.candidate_audit.length}, pre-diversity-cap)
                                </Text>
                                <TouchableOpacity
                                  onPress={() => {
                                    if (!recsMeta.candidate_audit || !tasteProfile) return;
                                    const PROBLEM_TITLES = ['casino royale','the big sleep','maus','parable of the sower','v for vendetta','to kill a mockingbird','the sun also rises','anthem','genji','autobiography of a yogi'];
                                    const isProblem = (title: string) => PROBLEM_TITLES.some(p => title.toLowerCase().includes(p));
                                    const report = {
                                      user_profile: {
                                        tier: tasteProfile.tier,
                                        genre_affinities: tasteProfile.genre_affinities,
                                        preferred_traits: tasteProfile.preferred_traits,
                                        avoided_traits: tasteProfile.avoided_traits,
                                        liked_subjects: tasteProfile.liked_subjects,
                                        liked_authors: tasteProfile.liked_authors,
                                        det_lanes: tasteProfile.det_lanes,
                                        evidence: tasteProfile.evidence,
                                        strongSignalCount: tasteProfile.strongSignalCount,
                                      },
                                      retrieval_trace: recsMeta.retrieval_trace,
                                      meta: {
                                        pool_size: recsMeta.pool_size,
                                        hygiene_excluded: recsMeta.hygiene_excluded,
                                        catalog_count: recsMeta.catalog_count,
                                        live_ol_count: recsMeta.live_ol_count,
                                        cached_external_count: recsMeta.cached_external_count,
                                      },
                                      candidate_table: recsMeta.candidate_audit.map((b, i) => {
                                        const lane    = detectBookLane(b);
                                        const subtype = detectBookMysterySubtype(b);
                                        const isPhi   = isPhilosophyOrSpiritual(b);
                                        const bt      = getBookTraits(b);
                                        return {
                                          rank: i + 1,
                                          is_problem_book: isProblem(b.title),
                                          in_final_recs: recommendations.some(r => r.id === b.id || r.title === b.title),
                                          title: b.title,
                                          author: b.author,
                                          source: b._source,
                                          retrieval_reason: b._retrieval_reason,
                                          lane,
                                          subtype,
                                          is_philosophy_spiritual: isPhi,
                                          book_form: bt.bookForm,
                                          primary_genre: bt.primaryGenre,
                                          subjects: (b.subjects ?? []).slice(0, 8),
                                          score: b.score,
                                          breakdown: b._score_breakdown,
                                          reasons: b.reasons,
                                          risks: b.risks,
                                        };
                                      }),
                                      problem_books_explicit: recsMeta.candidate_audit
                                        .filter(b => isProblem(b.title))
                                        .map(b => ({
                                          title: b.title,
                                          rank: recsMeta.candidate_audit!.indexOf(b) + 1,
                                          score: b.score,
                                          source: b._source,
                                          retrieval_reason: b._retrieval_reason,
                                          lane: detectBookLane(b),
                                          subtype: detectBookMysterySubtype(b),
                                          breakdown: b._score_breakdown,
                                          audit_flags: b._score_breakdown.audit_flags,
                                          risks: b.risks,
                                          subjects: (b.subjects ?? []).slice(0, 8),
                                        })),
                                    };
                                    console.log('=== READSTACK FORENSIC AUDIT ===');
                                    console.log(JSON.stringify(report, null, 2));
                                    console.log('=== END FORENSIC AUDIT ===');
                                  }}
                                  style={{
                                    backgroundColor: '#1c1917',
                                    paddingHorizontal: 8,
                                    paddingVertical: 3,
                                    borderRadius: 4,
                                  }}
                                >
                                  <Text style={{ fontSize: 9, color: '#faf9f7', fontWeight: '600' }}>📋 LOG AUDIT</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                  onPress={runForensicAudit}
                                  disabled={auditRunning}
                                  style={{
                                    backgroundColor: auditRunning ? '#57534e' : '#15803d',
                                    paddingHorizontal: 8,
                                    paddingVertical: 3,
                                    borderRadius: 4,
                                    marginLeft: 4,
                                  }}
                                >
                                  <Text style={{ fontSize: 9, color: '#faf9f7', fontWeight: '600' }}>
                                    {auditRunning ? '⏳ RUNNING…' : '🔬 LIVE AUDIT'}
                                  </Text>
                                </TouchableOpacity>
                              </View>
                              {recsMeta.candidate_audit.slice(0, 25).map((b, i) => {
                                const lane    = detectBookLane(b);
                                const subtype = detectBookMysterySubtype(b) ?? '—';
                                const inFinal = recommendations.some(r => r.id === b.id || r.title === b.title);
                                const flags   = b._score_breakdown.audit_flags;
                                const fitClass = b._score_breakdown.fit_class ?? '';
                                const mktPos   = b._score_breakdown.market_position ?? '';
                                const cogDelta = b._score_breakdown.cog_score_delta ?? 0;
                                const isReject = fitClass === 'reject';
                                const isCore   = fitClass === 'core_fit';
                                const isStretch = fitClass === 'stretch_fit';
                                const PROBLEM_TITLES = ['casino royale','the big sleep','maus','parable of the sower','v for vendetta','to kill a mockingbird','the sun also rises','anthem','genji','autobiography of a yogi'];
                                const isProblem = PROBLEM_TITLES.some(p => b.title.toLowerCase().includes(p));
                                const rowBg = isReject ? '#fef2f2' : isCore ? '#f0fdf4' : isStretch ? '#fff7ed' : 'transparent';
                                const fitColor = isCore ? '#16a34a' : isReject ? '#dc2626' : isStretch ? '#ea580c' : '#2563eb';
                                return (
                                  <View key={b.id + i} style={{
                                    borderBottomWidth: i < 24 ? 1 : 0,
                                    borderBottomColor: '#e7e5e4',
                                    paddingVertical: 4,
                                    backgroundColor: rowBg,
                                  }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                      <Text style={{ fontSize: 8, color: '#a8a29e', width: 18 }}>#{i+1}</Text>
                                      <Text style={{ fontSize: 9, fontWeight: '600', color: isProblem ? '#c2410c' : '#1c1917', flex: 1 }} numberOfLines={1}>
                                        {inFinal ? '★ ' : ''}{isProblem ? '⚠ ' : ''}{b.title}
                                      </Text>
                                      <Text style={{ fontSize: 9, fontWeight: '700', color: b.score >= 0.5 ? '#16a34a' : b.score >= 0.35 ? '#78716c' : '#dc2626' }}>
                                        {b.score.toFixed(3)}
                                      </Text>
                                    </View>
                                    <View style={{ flexDirection: 'row', paddingLeft: 22, gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                      {fitClass ? (
                                        <Text style={{ fontSize: 8, fontWeight: '700', color: fitColor }}>
                                          {fitClass === 'core_fit' ? 'CORE' : fitClass === 'adjacent_fit' ? 'ADJ' : fitClass === 'stretch_fit' ? 'STRCH' : 'REJ'}
                                          {cogDelta !== 0 ? ` (${cogDelta > 0 ? '+' : ''}${cogDelta.toFixed(2)})` : ''}
                                        </Text>
                                      ) : null}
                                      {mktPos ? <Text style={{ fontSize: 8, color: '#78716c' }}>{mktPos.replace(/_/g, '·')}</Text> : null}
                                      <Text style={{ fontSize: 8, color: '#a8a29e' }}>tr:{b._score_breakdown.trait_alignment.toFixed(2)}</Text>
                                      <Text style={{ fontSize: 8, color: '#a8a29e' }}>gn:{b._score_breakdown.genre_bonus.toFixed(2)}</Text>
                                      <Text style={{ fontSize: 8, color: '#a8a29e' }}>pe:{b._score_breakdown.metadata_penalty.toFixed(2)}</Text>
                                      <Text style={{ fontSize: 8, color: '#a8a29e' }}>
                                        {lane ?? '—'}{subtype !== '—' ? `/${subtype.slice(0,6)}` : ''}
                                      </Text>
                                      {flags.length > 0 && (
                                        <Text style={{ fontSize: 8, color: '#ea580c' }}>⚑ {flags.join(',')}</Text>
                                      )}
                                    </View>
                                    {/* Intent trace row (shown when intent is active) */}
                                    {b._intent_trace && (
                                      <View style={{ paddingLeft: 22, marginTop: 2 }}>
                                        {b._intent_trace.excluded_by ? (
                                          <Text style={{ fontSize: 7.5, color: '#b91c1c', fontWeight: '600' }}>
                                            ✕ intent excl: {b._intent_trace.excluded_by}
                                          </Text>
                                        ) : b._intent_trace.hard_filter_fails.length > 0 ? (
                                          <Text style={{ fontSize: 7.5, color: '#c2410c', fontWeight: '600' }}>
                                            ✕ intent filter: {b._intent_trace.hard_filter_fails.join(', ')}
                                          </Text>
                                        ) : (
                                          <Text style={{ fontSize: 7.5, color: '#15803d' }}>
                                            ✓ intent pass
                                            {b._intent_trace.soft_boosts.length > 0
                                              ? `  · boost: ${b._intent_trace.soft_boosts.join(', ')} (${b._intent_trace.score_delta > 0 ? '+' : ''}${b._intent_trace.score_delta.toFixed(3)})`
                                              : ''}
                                            {b._intent_trace.hard_filter_passes.length > 0
                                              ? `  · ${b._intent_trace.hard_filter_passes.join(', ')}`
                                              : ''}
                                          </Text>
                                        )}
                                      </View>
                                    )}
                                    {/* RIL (series integrity) row */}
                                    {(b._score_breakdown.series_label || b._score_breakdown.ril_suppressed) && (
                                      <View style={{ paddingLeft: 22, marginTop: 2, flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                                        {b._score_breakdown.ril_suppressed ? (
                                          <Text style={{ fontSize: 7.5, color: '#b45309', fontWeight: '600' }}>
                                            ◆ RIL SUPPRESSED · {b._score_breakdown.ril_reason ?? ''}
                                          </Text>
                                        ) : b._score_breakdown.series_label ? (
                                          <Text style={{ fontSize: 7.5, color: '#0369a1' }}>
                                            ◆ {b._score_breakdown.series_label}
                                            {b._score_breakdown.series_name ? ` · ${b._score_breakdown.series_name}` : ''}
                                            {b._score_breakdown.series_position != null ? ` #${b._score_breakdown.series_position}` : ''}
                                            {b._score_breakdown.series_confidence ? ` [${b._score_breakdown.series_confidence}/${b._score_breakdown.series_method}]` : ''}
                                          </Text>
                                        ) : null}
                                      </View>
                                    )}
                                  </View>
                                );
                              })}
                            </View>
                          )}

                          {/* Entitlement debug */}
                          {entitlement && (
                            <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e7e5e4' }}>
                              <Text style={{ fontSize: 9, fontWeight: '600', color: '#a8a29e', marginBottom: 2 }}>ENTITLEMENT</Text>
                              <Text style={{ fontSize: 9, color: '#78716c', lineHeight: 14 }}>
                                plan: {entitlement.plan}  ·  mode: {recMode ?? '?'}  ·  decision: {recsMeta.expert_decision?.reason ?? 'n/a'}
                              </Text>
                              <Text style={{ fontSize: 9, color: '#78716c', lineHeight: 14 }}>
                                free_used: {entitlement.has_used_free_import_analysis ? 'yes' : 'no'}  ·  refreshes_left: {entitlement.expert_refreshes_remaining_this_period ?? '∞'}
                              </Text>
                              {recsMeta.cache_built_at && (
                                <Text style={{ fontSize: 9, color: '#a8a29e', lineHeight: 14 }}>
                                  cache built: {new Date(recsMeta.cache_built_at).toLocaleString()}
                                </Text>
                              )}
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
                  backgroundColor: recsQualityGate === 'intent_filtered_empty' ? '#faf9f7' : '#fff',
                  borderRadius: 14,
                  padding: 16,
                  marginBottom: 16,
                  borderWidth: 1,
                  borderColor: recsQualityGate === 'intent_filtered_empty' ? '#e7e5e4' : '#e7e5e4',
                }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
                    {recsQualityGate === 'intent_filtered_empty'
                      ? 'No matches with these filters'
                      : recsQualityGate === 'insufficient_pool'
                        ? 'Not enough books in your genres yet'
                        : "No close matches in the current catalog"}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
                    {recsQualityGate === 'intent_filtered_empty'
                      ? 'Your current filters are too narrow for the available pool. Try relaxing a filter or clearing them to see your regular picks.'
                      : recsQualityGate === 'insufficient_pool'
                        ? 'We need more books in the genres you enjoy before we can make confident picks. Rate a few more books or add taste tags to help us.'
                        : 'None of the books in our catalog scored closely enough against your profile. Keep rating books — your picks will sharpen as we learn more.'}
                  </Text>
                  {recsQualityGate === 'intent_filtered_empty' && (
                    <TouchableOpacity
                      onPress={() => {
                        const cleared = emptyNextReadIntent();
                        setDraftIntent(cleared);
                        Animated.timing(intentPanelHeight, { toValue: 0, duration: 180, useNativeDriver: false }).start();
                        setIntentPanelOpen(false);
                        reloadRecs(cleared);
                      }}
                      style={{
                        marginTop: 10,
                        alignSelf: 'flex-start',
                        backgroundColor: '#1c1917',
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: '600', color: '#faf9f7' }}>
                        Clear filters
                      </Text>
                    </TouchableOpacity>
                  )}
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

            </View>

            {/* ════════════════════════════════════════════════════════
                Section 2 — Shared Books (From Friends + Sent)
            ════════════════════════════════════════════════════════ */}
            <View style={{ marginBottom: 36 }}>
              <SectionLabel>Shared Books</SectionLabel>

              {/* ── From friends sub-section ── */}
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#78716c', marginBottom: 10, letterSpacing: 0.3 }}>
                FROM FRIENDS
              </Text>

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
                  marginBottom: 24,
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
                  marginBottom: 24,
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

              {/* ── You sent sub-section ── */}
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#78716c', marginBottom: 10, letterSpacing: 0.3 }}>
                YOU SENT
              </Text>

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

            {/* ════════════════════════════════════════════════════════
                Section 3 — Refine your taste (tasks)
            ════════════════════════════════════════════════════════ */}
            {hasAnyTask && (
              <View style={{ marginBottom: 16 }}>
                {/* ── Refine your taste ── */}
                {(hasRateTasks || hasTagTasks) && (
                  <View style={{ marginBottom: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1 }}>
                        Refine your taste
                      </Text>
                      <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                        {booksToRate.length + booksToTag.length} book{booksToRate.length + booksToTag.length !== 1 ? 's' : ''}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 12, color: '#78716c', marginBottom: 12 }}>
                      Ratings and tags are our strongest signals for learning your taste.
                    </Text>
                    <View style={{ gap: 8 }}>
                      {booksToRate.slice(0, 3).map(b => (
                        <RateCard key={b.id} book={b} onComplete={handleRateComplete} />
                      ))}
                      {booksToTag.slice(0, Math.max(0, 3 - booksToRate.length)).map(b => (
                        <TagCard key={b.id} book={b} onComplete={handleTagComplete} />
                      ))}
                      {(booksToRate.length + booksToTag.length) > 3 && (
                        <TouchableOpacity onPress={() => router.push('/(tabs)/library')}>
                          <Text style={{ fontSize: 13, color: '#78716c', paddingVertical: 6 }}>
                            +{booksToRate.length + booksToTag.length - 3} more in Library →
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                )}

                {/* Analyse imports — shown only if user has imports but not yet diagnosed */}
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
              </View>
            )}
          </>
        )}

        {/* ── In-app live forensic audit modal ── */}
        <Modal
          visible={forensicModalVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setForensicModalVisible(false)}
        >
          <View style={{ flex: 1, backgroundColor: '#faf9f7' }}>
            {/* Header */}
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: 16, paddingTop: 20, paddingBottom: 12,
              borderBottomWidth: 1, borderBottomColor: '#e7e5e4',
            }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917' }}>
                🔬 Live Rec Audit
              </Text>
              {forensicAuditData && (
                <Text style={{ fontSize: 9, color: '#a8a29e', flex: 1, marginLeft: 10 }} numberOfLines={1}>
                  {forensicAuditData.user_id.slice(0, 8)}  ·  {forensicAuditData.timestamp.slice(11, 19)}
                </Text>
              )}
              <TouchableOpacity
                onPress={() => setForensicModalVisible(false)}
                style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#e7e5e4', borderRadius: 6 }}
              >
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#1c1917' }}>Close</Text>
              </TouchableOpacity>
            </View>

            {/* Section tabs */}
            <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
              {(['profile', 'retrieval', 'candidates', 'recs'] as const).map(sec => (
                <TouchableOpacity
                  key={sec}
                  onPress={() => setAuditSection(sec)}
                  style={{
                    flex: 1, paddingVertical: 6, borderRadius: 6,
                    backgroundColor: auditSection === sec ? '#1c1917' : '#e7e5e4',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 9, fontWeight: '700', color: auditSection === sec ? '#faf9f7' : '#78716c' }}>
                    {sec === 'profile' ? 'PROFILE' : sec === 'retrieval' ? 'RETRIEVAL' : sec === 'candidates' ? 'CAND-20' : 'TOP-10'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {forensicAuditData ? (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>

                {/* ── Part A: Profile ── */}
                {auditSection === 'profile' && (
                  <View>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#a8a29e', marginBottom: 8 }}>A · LIVE PROFILE</Text>
                    {[
                      ['user_id', forensicAuditData.user_id],
                      ['imported_books_count', String(forensicAuditData.profile.imported_books_count)],
                      ['strongSignalCount', String(forensicAuditData.profile.strongSignalCount)],
                      ['tier', String(forensicAuditData.profile.tier)],
                    ].map(([label, val]) => (
                      <View key={label} style={{ marginBottom: 6 }}>
                        <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600' }}>{label}</Text>
                        <Text style={{ fontSize: 10, color: '#1c1917', fontFamily: 'monospace' }} selectable>{val}</Text>
                      </View>
                    ))}
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 4 }}>genre_affinities</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace', lineHeight: 15 }} selectable>
                      {Object.entries(forensicAuditData.profile.genre_affinities).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    </Text>
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 8 }}>preferred_traits</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace', lineHeight: 15 }} selectable>
                      {Object.entries(forensicAuditData.profile.preferred_traits).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    </Text>
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 8 }}>dominant_lanes</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>
                      {forensicAuditData.profile.dominant_lanes.join(', ')}
                    </Text>
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 8 }}>repeated_liked_authors</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>
                      {forensicAuditData.profile.repeated_liked_authors.join(', ')}
                    </Text>
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 8 }}>liked_subjects</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace', lineHeight: 15 }} selectable>
                      {forensicAuditData.profile.liked_subjects.join('\n')}
                    </Text>
                  </View>
                )}

                {/* ── Part B: Retrieval ── */}
                {auditSection === 'retrieval' && (
                  <View>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#a8a29e', marginBottom: 8 }}>B · RETRIEVAL</Text>
                    {/* Fresh pass */}
                    <Text style={{ fontSize: 9, fontWeight: '700', color: '#15803d', marginBottom: 4 }}>Pass A — Fresh (skipCache=true)</Text>
                    {[
                      ['mode', forensicAuditData.fresh.mode],
                      ['cache_hit', String(forensicAuditData.fresh.cache_hit)],
                      ['pool_size', String(forensicAuditData.fresh.pool_size)],
                      ['catalog', String(forensicAuditData.fresh.catalog_count)],
                      ['live_ol', String(forensicAuditData.fresh.live_ol_count)],
                      ['cached_ext', String(forensicAuditData.fresh.cached_external_count)],
                      ['hygiene_excluded', String(forensicAuditData.fresh.hygiene_excluded)],
                      ['enriched', String(forensicAuditData.fresh.enriched_count)],
                    ].map(([label, val]) => (
                      <Text key={label} style={{ fontSize: 9, color: '#57534e', fontFamily: 'monospace', lineHeight: 14 }}>
                        {label}: <Text style={{ color: '#1c1917' }} selectable>{val}</Text>
                      </Text>
                    ))}
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 6 }}>genres_used</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>{forensicAuditData.fresh.genres_used.join(', ') || '—'}</Text>
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 4 }}>subjects_used</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>{forensicAuditData.fresh.subjects_used.join(', ') || '—'}</Text>
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 4 }}>authors_used</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>{forensicAuditData.fresh.authors_used.join(', ') || '—'}</Text>
                    <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 4 }}>ol_queries ({forensicAuditData.fresh.ol_queries.length})</Text>
                    <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace', lineHeight: 15 }} selectable>
                      {forensicAuditData.fresh.ol_queries.map((q, i) => `${i+1}. ${q}`).join('\n')}
                    </Text>
                    {/* Cache pass */}
                    {forensicAuditData.cache && (
                      <View style={{ marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#e7e5e4' }}>
                        <Text style={{ fontSize: 9, fontWeight: '700', color: '#2563eb', marginBottom: 4 }}>Pass B — Cache (skipCache=false)</Text>
                        {[
                          ['mode', forensicAuditData.cache.mode],
                          ['cache_hit', String(forensicAuditData.cache.cache_hit)],
                          ['cache_built_at', forensicAuditData.cache.cache_built_at ?? 'n/a'],
                        ].map(([label, val]) => (
                          <Text key={label} style={{ fontSize: 9, color: '#57534e', fontFamily: 'monospace', lineHeight: 14 }}>
                            {label}: <Text style={{ color: '#1c1917' }} selectable>{val}</Text>
                          </Text>
                        ))}
                        <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 6 }}>genres_used (reconstructed)</Text>
                        <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>{forensicAuditData.cache.genres_used.join(', ') || '—'}</Text>
                        <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 4 }}>subjects_used</Text>
                        <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>{forensicAuditData.cache.subjects_used.join(', ') || '—'}</Text>
                        <Text style={{ fontSize: 8, color: '#a8a29e', fontWeight: '600', marginTop: 4 }}>authors_used</Text>
                        <Text style={{ fontSize: 9, color: '#1c1917', fontFamily: 'monospace' }} selectable>{forensicAuditData.cache.authors_used.join(', ') || '—'}</Text>
                      </View>
                    )}
                  </View>
                )}

                {/* ── Part C: Top 20 candidates ── */}
                {auditSection === 'candidates' && (
                  <View>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#a8a29e', marginBottom: 8 }}>C · TOP-20 CANDIDATES (fresh pass)</Text>
                    {/* Column header */}
                    <View style={{ flexDirection: 'row', paddingBottom: 4, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: '#e7e5e4' }}>
                      <Text style={{ fontSize: 7, color: '#a8a29e', width: 18 }}>#</Text>
                      <Text style={{ fontSize: 7, color: '#a8a29e', flex: 1 }}>title · author</Text>
                      <Text style={{ fontSize: 7, color: '#a8a29e', width: 26, textAlign: 'right' }}>tr</Text>
                      <Text style={{ fontSize: 7, color: '#a8a29e', width: 26, textAlign: 'right' }}>so</Text>
                      <Text style={{ fontSize: 7, color: '#a8a29e', width: 26, textAlign: 'right' }}>gb</Text>
                      <Text style={{ fontSize: 7, color: '#a8a29e', width: 26, textAlign: 'right' }}>pe</Text>
                      <Text style={{ fontSize: 7, color: '#a8a29e', width: 32, textAlign: 'right' }}>score</Text>
                    </View>
                    {forensicAuditData.fresh.top20.map(c => {
                      const isCore = c.fit_class === 'core_fit';
                      const isRej  = c.fit_class === 'reject';
                      return (
                        <View key={c.rank} style={{
                          paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#f5f5f4',
                          backgroundColor: isCore ? '#f0fdf4' : isRej ? '#fef2f2' : 'transparent',
                        }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={{ fontSize: 8, color: '#a8a29e', width: 18 }}>#{c.rank}</Text>
                            <Text style={{ fontSize: 8, color: '#1c1917', flex: 1 }} numberOfLines={1}>{c.title}</Text>
                            <Text style={{ fontSize: 8, color: '#57534e', width: 26, textAlign: 'right' }}>{c.trait_alignment.toFixed(2)}</Text>
                            <Text style={{ fontSize: 8, color: c.subject_overlap_bonus > 0 ? '#15803d' : '#a8a29e', width: 26, textAlign: 'right' }}>{c.subject_overlap_bonus.toFixed(2)}</Text>
                            <Text style={{ fontSize: 8, color: '#57534e', width: 26, textAlign: 'right' }}>{c.genre_bonus.toFixed(2)}</Text>
                            <Text style={{ fontSize: 8, color: c.penalty > 0 ? '#dc2626' : '#a8a29e', width: 26, textAlign: 'right' }}>{c.penalty.toFixed(2)}</Text>
                            <Text style={{ fontSize: 8, fontWeight: '700', color: c.final_score >= 0.5 ? '#15803d' : c.final_score >= 0.35 ? '#78716c' : '#dc2626', width: 32, textAlign: 'right' }}>{c.final_score.toFixed(3)}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', paddingLeft: 18, gap: 6, marginTop: 1, flexWrap: 'wrap' }}>
                            <Text style={{ fontSize: 7, color: '#78716c' }}>{c.author}</Text>
                            <Text style={{ fontSize: 7, color: isCore ? '#15803d' : isRej ? '#dc2626' : '#2563eb', fontWeight: '700' }}>
                              {c.fit_class.replace('_fit', '').toUpperCase()}
                            </Text>
                            {c.subject_overlap_hits.length > 0 && (
                              <Text style={{ fontSize: 7, color: '#15803d' }}>subj: {c.subject_overlap_hits.join(', ')}</Text>
                            )}
                            {c.flags.length > 0 && <Text style={{ fontSize: 7, color: '#ea580c' }}>⚑ {c.flags.join(',')}</Text>}
                            <Text style={{ fontSize: 7, color: '#a8a29e' }}>{c.retrieval_reason.slice(0, 22)}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}

                {/* ── Part D: Top 10 recs ── */}
                {auditSection === 'recs' && (
                  <View>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: '#a8a29e', marginBottom: 8 }}>D · TOP-10 RECS</Text>
                    <Text style={{ fontSize: 9, fontWeight: '700', color: '#15803d', marginBottom: 6 }}>Pass A — Fresh</Text>
                    {forensicAuditData.fresh.top10.map(r => (
                      <View key={r.rank} style={{ marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e7e5e4' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Text style={{ fontSize: 9, color: '#a8a29e', width: 18 }}>#{r.rank}</Text>
                          <Text style={{ fontSize: 10, fontWeight: '600', color: '#1c1917', flex: 1 }} numberOfLines={1}>{r.title}</Text>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: r.score >= 0.5 ? '#15803d' : '#78716c' }}>{r.score.toFixed(3)}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', paddingLeft: 26, gap: 8, marginTop: 2 }}>
                          <Text style={{ fontSize: 8, color: '#78716c' }}>{r.author}</Text>
                          <Text style={{ fontSize: 8, fontWeight: '700', color: r.fit_class === 'core_fit' ? '#15803d' : r.fit_class === 'reject' ? '#dc2626' : '#2563eb' }}>
                            {r.fit_class.replace('_fit','').toUpperCase()}
                          </Text>
                        </View>
                        {r.reason.length > 0 && (
                          <Text style={{ fontSize: 8, color: '#78716c', paddingLeft: 26, marginTop: 2, fontStyle: 'italic' }} numberOfLines={2}>{r.reason}</Text>
                        )}
                      </View>
                    ))}
                    {forensicAuditData.cache && (
                      <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#e7e5e4' }}>
                        <Text style={{ fontSize: 9, fontWeight: '700', color: '#2563eb', marginBottom: 6 }}>
                          Pass B — Cache ({forensicAuditData.cache.cache_hit ? 'HIT ✓' : 'MISS — fresh run'})
                        </Text>
                        {forensicAuditData.cache.top10.map(r => (
                          <View key={r.rank} style={{ marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e7e5e4' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Text style={{ fontSize: 9, color: '#a8a29e', width: 18 }}>#{r.rank}</Text>
                              <Text style={{ fontSize: 10, fontWeight: '600', color: '#1c1917', flex: 1 }} numberOfLines={1}>{r.title}</Text>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: r.score >= 0.5 ? '#15803d' : '#78716c' }}>{r.score.toFixed(3)}</Text>
                            </View>
                            <View style={{ flexDirection: 'row', paddingLeft: 26, gap: 8, marginTop: 2 }}>
                              <Text style={{ fontSize: 8, color: '#78716c' }}>{r.author}</Text>
                              <Text style={{ fontSize: 8, fontWeight: '700', color: r.fit_class === 'core_fit' ? '#15803d' : r.fit_class === 'reject' ? '#dc2626' : '#2563eb' }}>
                                {r.fit_class.replace('_fit','').toUpperCase()}
                              </Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                )}

              </ScrollView>
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="large" color="#1c1917" />
                <Text style={{ marginTop: 12, color: '#a8a29e', fontSize: 13 }}>Running pipeline…</Text>
              </View>
            )}
          </View>
        </Modal>

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
