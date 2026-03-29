import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
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
import { Ionicons } from '@expo/vector-icons';
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
import { getCandidateBooks, getRankedRecs, fitLabel, fitColor, getPersonalizedRecsWithExpert, __devTimingsRef } from '../../lib/recommender';
import type { ScoredBook, QualityGate, RankedRecsResult, DevTimings } from '../../lib/recommender';
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
import { useGuidedTour, GuidedActionBanner } from '../../components/OnboardingWalkthrough';
import type { ReaderThesis } from '../../lib/expertRec';
import { getSeriesCatalog } from '../../lib/seriesCatalog';
import { loadRecPayload, saveRecPayload, computeRecFingerprint, addActedOnIds, loadActedOnIds } from '../../lib/recPayloadCache';
import { triggerRecPrewarm } from '../../lib/recPrewarm';
import { registerCacheClearer } from '../../lib/tabCache';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'hub' | 'search' | 'friends' | 'done';

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

// ─── VariantBadge ─────────────────────────────────────────────────────────────
function VariantBadge({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <View style={{
      alignSelf: 'flex-start', marginBottom: 6,
      paddingHorizontal: 7, paddingVertical: 3,
      borderRadius: 6, backgroundColor: bg,
    }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color, letterSpacing: 0.3 }}>{label}</Text>
    </View>
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

// Returns a naturally articled reference to a series/saga name for inline use.
// Prevents double-articles ("the The Stormlight Archive") and awkward constructions
// ("the A Song of Ice and Fire").
//   "The Stormlight Archive" → "the Stormlight Archive"
//   "A Song of Ice and Fire" → "A Song of Ice and Fire"
//   "An Ember in the Ashes"  → "An Ember in the Ashes"
//   "Tawny Man Trilogy"      → "the Tawny Man Trilogy"
function naturalArticle(name: string): string {
  if (/^(a|an)\s+/i.test(name)) return name;
  if (/^the\s+/i.test(name))    return `the ${name.replace(/^the\s+/i, '')}`;
  return `the ${name}`;
}

// Human-readable labels for each detected reading lane — used to name the genre
// in explanation copy rather than leaving it as a vague "a genre you enjoy".
const EXPLANATION_LANE_LABELS: Record<DeterministicLane, string> = {
  romantasy:            'romantic fantasy',
  scifi_fantasy:        'fantasy and speculative fiction',
  modern_suspense:      'psychological suspense',
  romance:              'emotionally driven romance',
  contemporary_fiction: 'contemporary fiction',
  memoir_nonfiction:    'narrative nonfiction',
  literary:             'literary fiction',
  horror:               'dark atmospheric fiction',
};

// Build a single behavior-driven explanation anchored to ONE concrete user signal.
//
// Priority (highest → lowest):
//   0. Saga label    — journey-level framing for multi-series universes
//   1. Series label  — per-series framing for books not in a tracked saga
//   2. Author affinity — finished-book count ≥ 2
//   3. Named genre fit — core_fit with a known reading lane
//   4. Generic fallback — scorer reason string (with lane name substituted when available)
//
// Copy principles:
//   - Series starter: direct invitation to begin; name the series
//   - Series continuation: acknowledge what the user has read; name what's next
//   - Author affinity: peer signal framing, not a book-count recitation
//   - Taste match: name the genre or traits, not the algorithm
function buildExplanation(book: ScoredBook, _hasSeriesMeta: boolean): string | null {
  const bd = book._score_breakdown;

  // 0. Saga — highest priority.
  // saga_skip_ahead books are suppressed by RIL and never reach here, so we
  // only need to handle the three user-facing labels.
  if (bd.saga_label && bd.saga_name) {
    switch (bd.saga_label) {
      case 'saga_entry':
        return `Begin where ${naturalArticle(bd.saga_name)} saga starts.`;
      case 'saga_continuation':
        return `Continue ${naturalArticle(bd.saga_name)} saga.`;
      case 'saga_next_series':
        return `Next chapter of ${naturalArticle(bd.saga_name)} saga.`;
    }
  }

  // 1. Series (for books not in a tracked saga, or as fallback if saga label
  //    is absent for any reason).
  if (bd.series_position != null && bd.series_name) {
    const pos  = bd.series_position;
    const name = bd.series_name;

    // Starter: book is position 1 in the series
    if (pos === 1) {
      return `Start with book one of ${naturalArticle(name)}.`;
    }

    // Continuation: only make a specific claim when history is confirmed contiguous.
    // If series_is_contiguous is false (gaps detected), fall back to the neutral
    // "Continue the series" — never overstate what the user has actually read.
    const maxRead    = bd.series_max_read     ?? null;
    const contiguous = bd.series_is_contiguous ?? null;
    if (maxRead != null && maxRead > 0) {
      if (contiguous === true) {
        return `Continue ${naturalArticle(name)} series \u2014 book ${pos}`;
      }
      return `Continue ${naturalArticle(name)} series`;
    }
  }

  // 2. Author affinity — finished books only, threshold ≥ 2
  const authorCount = bd.author_books_read ?? 0;
  if (authorCount >= 2) {
    return `Another strong read from ${book.author}`;
  }

  // 3. Named genre fit — core_fit in a known reading lane gives a specific sentence
  const laneLabel = bd.book_lane
    ? (EXPLANATION_LANE_LABELS[bd.book_lane as DeterministicLane] ?? null)
    : null;
  if (bd.fit_class === 'core_fit' && laneLabel) {
    return `A strong fit for your taste in ${laneLabel}.`;
  }

  // 4. Fallback — scorer reason string.
  // Replace the generic "Fits a genre you consistently enjoy" with a named variant
  // when a reading lane is available; otherwise pass the string through as-is.
  if (book.reasons.length > 0) {
    const raw = capitalize(stripAuthorPrefix(book.reasons[0], book.author));
    if (raw === 'Fits a genre you consistently enjoy' && laneLabel) {
      return `A consistent pick for your taste in ${laneLabel}.`;
    }
    return raw;
  }

  return null;
}

type SeriesCover = { olKey: string; coverId: number | null; title: string };

function RecCard({
  book,
  isExpert          = false,
  featured          = false,
  isPendingDismiss  = false,
  onSave            = () => {},
  onDismiss         = () => {},
  onDismissUndo     = () => {},
  onMoreLikeThis    = () => {},
  onImpression      = () => {},
  onExplanationOpen = () => {},
}: {
  book:               ScoredBook;
  isExpert?:          boolean;
  featured?:          boolean;
  isPendingDismiss?:  boolean;
  onSave?:            () => void;
  onDismiss?:         () => void;
  onDismissUndo?:     () => void;
  onMoreLikeThis?:    () => void;
  onImpression?:      () => void;
  onExplanationOpen?: () => void;
}) {
  const router = useRouter();

  // Animation ref — card fade-out on dismiss/save
  const opacity = useRef(new Animated.Value(1)).current;

  // Local state
  const [moreDone, setMoreDone]           = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [confirmState, setConfirmState]   = useState<'save' | 'more' | null>(null);
  const [seriesCovers, setSeriesCovers]   = useState<SeriesCover[]>([]);
  const impressionFired  = useRef(false);

  // Fire impression once on mount
  useEffect(() => {
    if (!impressionFired.current) {
      impressionFired.current = true;
      onImpression();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cover image fetch — fires once after mount to populate cover thumbnails.
  //
  // Series STRUCTURE (name, position, total, orderedBooks) comes exclusively
  // from the static seriesCatalog and is synchronously available from
  // book._score_breakdown props.  This effect only fetches cover IMAGES so
  // they can replace the placeholder boxes that render immediately.
  //
  // Partial results are accepted: if a specific book's cover cannot be
  // resolved, that position keeps its placeholder box.  The series row
  // and badge are always rendered when series metadata is present — they
  // do not depend on this fetch completing.
  useEffect(() => {
    const sn = book._score_breakdown.series_name;
    const sp = book._score_breakdown.series_position;
    if (!sn || sp == null) return;

    const meta = getSeriesCatalog(sn);
    if (!meta) return;

    const BAD_EDITION = /collection|omnibus|boxed|box set|complete works|anthology/i;

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
      // Accept partial results — null entries keep placeholder boxes.
      const covers = results.map((r, i): SeriesCover =>
        r ?? { olKey: `placeholder-${i}`, coverId: null, title: meta.orderedBooks[i].title }
      );
      setSeriesCovers(covers);
    });

    return () => { cancelled = true; };
  // Only run on mount — series name/position don't change per card
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function animateOut(cb: () => void) {
    Animated.timing(opacity, {
      toValue:  0,
      duration: 150,
      useNativeDriver: false,
    }).start(cb);
  }

  function handleSavePress() {
    if (pendingAction) return;
    setPendingAction(true);
    setConfirmState('save');
    setTimeout(() => animateOut(onSave), 800);
  }

  function handleDismissPress() {
    if (pendingAction) return;
    setPendingAction(true);
    onDismiss();
  }

  function handleMoreLikeThisPress() {
    if (pendingAction || moreDone) return;
    setPendingAction(true);
    setMoreDone(true);
    setConfirmState('more');
    setTimeout(() => animateOut(onMoreLikeThis), 800);
  }

  function handleCardPress() {
    if (pendingAction) return;
    const sn = book._score_breakdown.series_name;
    const sp = book._score_breakdown.series_position;
    router.push({
      pathname: '/book/[id]',
      params: {
        id:         book.external_id?.replace('/works/', '') ?? 'rec',
        title:      book.title,
        author:     book.author,
        coverUrl:   book.cover_url ?? '',
        externalId: book.external_id ?? '',
        ...(sn && sp != null ? { seriesName: sn, seriesPosition: String(sp) } : {}),
      },
    });
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
  // Series metadata is fully available from props on first render.
  // Cover images are populated asynchronously (see useEffect above) but
  // do NOT gate the series row — only image content changes after load.
  const hasSeriesMeta =
    catalogMeta != null &&
    seriesPos   != null &&
    seriesTotal != null;

  // Behavior-driven explanation — series > author affinity > generic fallback
  const collapsedReason = buildExplanation(book, hasSeriesMeta);

  // ── In-card undo row — card stays in its list position during the undo window ──
  if (isPendingDismiss) {
    return (
      <View style={{
        backgroundColor: '#fafaf9',
        borderRadius: 14,
        marginBottom: 6,
        borderWidth: 1,
        borderColor: '#e7e5e4',
        paddingHorizontal: 14,
        paddingVertical: 13,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}>
        <Text style={{ flex: 1, fontSize: 13, color: '#78716c' }} numberOfLines={1}>
          Not for me — "{book.title}"
        </Text>
        <TouchableOpacity
          onPress={onDismissUndo}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917' }}>Undo</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <Animated.View style={{
      opacity,
      backgroundColor: '#fff',
      borderRadius: 14,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOpacity: featured ? 0.07 : 0.04,
      shadowRadius: featured ? 10 : 6,
      shadowOffset: { width: 0, height: featured ? 2 : 1 },
      elevation: featured ? 2 : 1,
      overflow: 'hidden',
      ...(featured ? { borderWidth: 1, borderColor: '#e7e5e4' } : {}),
    }}>
      {/* Featured top accent bar */}
      {featured && (
        <View style={{ height: 3, backgroundColor: '#1c1917' }} />
      )}
      {/* ── Main content row — full area is tappable to open Book Detail ── */}
      <TouchableOpacity
        onPress={handleCardPress}
        activeOpacity={0.75}
        style={{ padding: 12, flexDirection: 'row', alignItems: 'flex-start' }}
      >
        <CoverThumb
          url={book.cover_url}
          externalId={book.external_id}
          title={book.title}
          width={featured ? 52 : 44}
          height={featured ? 76 : 64}
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

          {/* ── Series visual row ──
               Rendered immediately on first paint using the static catalog
               structure (catalogMeta.orderedBooks).  Cover images start as
               placeholder boxes and are swapped in by the useEffect cover
               fetch without any card reshaping. */}
          {hasSeriesMeta && (
            <View style={{
              flexDirection:  'row',
              alignItems:     'flex-end',
              gap:            5,
              marginBottom:   8,
            }}>
              {catalogMeta!.orderedBooks.map((b, i) => {
                // Position is 1-indexed; orderedBooks is in series order so
                // index i corresponds to series position i+1.
                const isCurrent = (i + 1) === seriesPos;
                const cover    = seriesCovers[i];
                const coverUri = cover?.coverId
                  ? `https://covers.openlibrary.org/b/id/${cover.coverId}-S.jpg`
                  : null;
                return (
                  <View
                    key={`${b.title}-${i}`}
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
            </View>
          )}

          {/* ── Variant badge ─────────────────────────────────────────────────
               Unified: series (start/continue), saga, author affinity.
               Rendered from score_breakdown props — no async dependency. */}
          {(() => {
            const bd = book._score_breakdown;
            const isStarter = bd.series_label === 'series_starter' || bd.saga_label === 'saga_entry';
            const isContinuation =
              bd.series_label === 'series_continuation' ||
              bd.saga_label   === 'saga_continuation'   ||
              bd.saga_label   === 'saga_next_series';
            const isAuthorMatch = !isStarter && !isContinuation && (bd.author_books_read ?? 0) >= 2;
            if (isStarter)       return <VariantBadge label="Start here"       bg="#fef3c7" color="#92400e" />;
            if (isContinuation)  return <VariantBadge label="Continue series"  bg="#f0fdf4" color="#166534" />;
            if (isAuthorMatch)   return <VariantBadge label="Author match"     bg="#f5f3ff" color="#5b21b6" />;
            return null;
          })()}

          {/* Reason — prominent proof statement, not buried body copy */}
          {collapsedReason && (
            <Text
              style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', lineHeight: 18, marginBottom: 2 }}
              numberOfLines={2}
            >
              {collapsedReason}
            </Text>
          )}

        </View>
      </TouchableOpacity>

      {/* ── Action bar ── */}
      <View style={{
        borderTopWidth: 1,
        borderTopColor: '#f0eeeb',
        flexDirection: 'row',
        alignItems: 'stretch',
      }}>
        {/* Want to Read — primary save action */}
        <TouchableOpacity
          onPress={handleSavePress}
          disabled={pendingAction}
          style={{
            flex: 1,
            paddingVertical: 14,
            paddingHorizontal: 14,
            justifyContent: 'center',
            borderRightWidth: 1,
            borderRightColor: '#f0eeeb',
          }}
        >
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917' }}>
            Want to Read
          </Text>
        </TouchableOpacity>

        {/* Not for me — dismiss */}
        <TouchableOpacity
          onPress={handleDismissPress}
          disabled={pendingAction}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 13,
            justifyContent: 'center',
            alignItems: 'center',
            borderRightWidth: 1,
            borderRightColor: '#f0eeeb',
          }}
        >
          <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '500' }}>Not for me</Text>
        </TouchableOpacity>

        {/* More like this */}
        <TouchableOpacity
          onPress={handleMoreLikeThisPress}
          disabled={pendingAction}
          style={{
            paddingVertical: 14,
            paddingHorizontal: 13,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: '500', color: '#78716c' }}>
            More like this
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── In-card action confirmation overlay ──────────────────────────────── */}
      {/* Shown for 800ms on save/more-like-this before the card fades out.      */}
      {confirmState && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: confirmState === 'save' ? '#f0fdf4' : '#faf5ff',
          borderRadius: 14,
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 20,
          gap: 4,
        }}>
          {confirmState === 'save' ? (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#15803d' }}>
                ✓  Added to your list
              </Text>
              <Text style={{ fontSize: 12, color: '#166534' }}>
                Saved to Want to Read
              </Text>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#6d28d9' }}>
                Got it — tuning your picks
              </Text>
              <Text style={{ fontSize: 12, color: '#7c3aed' }}>
                Future recs will reflect this taste
              </Text>
            </>
          )}
        </View>
      )}

    </Animated.View>
  );
}

// ─── In-memory recommendation session cache ───────────────────────────────────
// Survives tab switches and React re-renders; cleared only on page reload or
// user change.  Prevents the 4–5 s OL pipeline from re-running on every focus
// event when signal has not changed since the last build.

type RecSessionCache = {
  userId:        string;
  recs:          ScoredBook[];
  continuations: ScoredBook[];
  discoveries:   ScoredBook[];
  meta:          RankedRecsResult['meta'];
  recMode:       'deterministic' | 'expert';
  readerThesis:  ReaderThesis | null;
  qualityGate:   QualityGate | null;
  isFreePreview: boolean;
  signalCount:   number;
  loadedAt:      number;
};

let _recSession: RecSessionCache | null = null;

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
const HUB_STALE_MS = 30_000; // matches inbox — incoming recs can arrive at any time

// Clear both caches on sign-out so the next user never sees previous user's data
registerCacheClearer(() => { _recSession = null; _hubCache = null; });

// ── Acted-on ID tracking ───────────────────────────────────────────────────────
//
// Two sets manage card exclusion:
//
//   _actedOnIds     — permanently acted-on (save, more-like-this, dismiss after
//                     undo window expires).  Persisted to AsyncStorage.
//   _pendingUndoIds — dismissed but undo window still live.  Never persisted —
//                     if undo fires, the entry is removed cleanly with no
//                     AsyncStorage rewrite needed.
//
// filterActedOn checks BOTH sets, so a pending-undo card is excluded from every
// commit path (cache restore, background refresh, reloadRecs) even before the
// 4-second timer fires.  This fixes the "dismiss + tab switch" regression.
//
// Cleared when user ID changes; _actedOnIds populated from AsyncStorage on
// cold start; _pendingUndoIds starts empty on each app launch (cold starts
// cannot be mid-undo-window).

let _actedOnIds:    Set<string> = new Set();
let _pendingUndoIds: Set<string> = new Set();
let _actedOnUserId: string | null = null;

// Excludes a book that has been permanently acted on OR is pending dismiss-undo.
// Module-level so it can be called from reloadRecs and background refresh
// commit paths, not only inside loadHub.
function filterActedOn(b: ScoredBook): boolean {
  return (
    !_actedOnIds.has(b.id) &&
    !(b.external_id && _actedOnIds.has(b.external_id)) &&
    !_pendingUndoIds.has(b.id) &&
    !(b.external_id && _pendingUndoIds.has(b.external_id))
  );
}

// Permanently marks a book as acted on (save / more-like-this / dismiss-commit).
function _trackActedOn(userId: string, book: ScoredBook): void {
  if (_actedOnUserId !== userId) {
    _actedOnIds    = new Set();
    _actedOnUserId = userId;
  }
  if (book.external_id) _actedOnIds.add(book.external_id);
  _actedOnIds.add(book.id);
  const ids = [book.external_id, book.id].filter(Boolean) as string[];
  addActedOnIds(userId, ids).catch(() => {});
}

// Immediately marks a dismiss as pending-undo.  Card is excluded from all
// commit paths at once, but no AsyncStorage write yet (undo is still possible).
function _trackActedOnPending(book: ScoredBook): void {
  if (book.external_id) _pendingUndoIds.add(book.external_id);
  _pendingUndoIds.add(book.id);
}

// Called when the undo window expires — promotes pending → permanent.
function _commitPendingToActedOn(userId: string, book: ScoredBook): void {
  if (book.external_id) _pendingUndoIds.delete(book.external_id);
  _pendingUndoIds.delete(book.id);
  _trackActedOn(userId, book);
}

// Called when the user taps Undo — removes from pending without any writes.
function _cancelPendingUndo(book: ScoredBook): void {
  if (book.external_id) _pendingUndoIds.delete(book.external_id);
  _pendingUndoIds.delete(book.id);
}

// ── Pending dismiss record (cross-session persistent) ─────────────────────────
//
// Module-level so it survives tab switches.  When loadHub re-runs on revisit,
// filterActedOn removes the book from inbound arrays (via _pendingUndoIds), then
// rehydratePendingDismiss re-injects it so the in-card undo row keeps rendering.
// reapplyPendingDismiss (inside the screen component) restarts the countdown timer
// for the remaining window and returns the DismissPendingState for setDismissPending.
type PendingDismissRecord = {
  book:      ScoredBook;
  bucket:    'continuations' | 'discoveries';
  expiresAt: number;   // Date.now() + DISMISS_UNDO_MS at dismiss time
  timerId:   ReturnType<typeof setTimeout> | null;
};
let _pendingDismissRecord: PendingDismissRecord | null = null;

// ── Deck paging ────────────────────────────────────────────────────────────────
//
// Each commit path shows at most DECK_PAGE_SIZE cards.  Remaining eligible
// session books are promoted one-by-one after each user action so the deck
// stays at depth without waiting for it to empty before the next pipeline run.
const DECK_PAGE_SIZE  = 4;
const DISMISS_UNDO_MS = 4000;

// Finds the next eligible book from the session cache that isn't already shown.
function nextEligibleFromSession(shown: ReadonlySet<string>): ScoredBook | null {
  if (!_recSession) return null;
  const all = [..._recSession.continuations, ..._recSession.discoveries];
  return all.find(b => {
    if (!filterActedOn(b)) return false;
    if (shown.has(b.id)) return false;
    if (b.external_id && shown.has(b.external_id)) return false;
    return true;
  }) ?? null;
}

// Whether a session book belongs to the continuations or discoveries bucket.
function bucketForBook(book: ScoredBook): 'continuations' | 'discoveries' {
  if (!_recSession) return 'discoveries';
  return _recSession.continuations.some(b => b.id === book.id)
    ? 'continuations'
    : 'discoveries';
}

// Appends one next-eligible book from session to the visible deck.
// Pure — does not mutate state; caller passes filtered arrays and calls setState.
function appendNextEligible(
  conts: ScoredBook[],
  discs: ScoredBook[],
): { conts: ScoredBook[]; discs: ScoredBook[] } {
  const shown = new Set<string>();
  for (const b of [...conts, ...discs]) {
    shown.add(b.id);
    if (b.external_id) shown.add(b.external_id);
  }
  const next = nextEligibleFromSession(shown);
  if (!next) return { conts, discs };
  return bucketForBook(next) === 'continuations'
    ? { conts: [...conts, next], discs }
    : { conts, discs: [...discs, next] };
}

// Limits the initial visible deck to DECK_PAGE_SIZE (continuations have priority).
function applyPageSize(
  conts: ScoredBook[],
  discs: ScoredBook[],
): { conts: ScoredBook[]; discs: ScoredBook[] } {
  const maxConts = Math.min(conts.length, DECK_PAGE_SIZE);
  return {
    conts: conts.slice(0, maxConts),
    discs: discs.slice(0, Math.max(0, DECK_PAGE_SIZE - maxConts)),
  };
}

// Re-injects the pending-dismiss book into arrays after filterActedOn removed it.
// Pure — caller applies page size and timer restart separately.
function rehydratePendingDismiss(
  conts: ScoredBook[],
  discs: ScoredBook[],
): { conts: ScoredBook[]; discs: ScoredBook[] } {
  if (!_pendingDismissRecord) return { conts, discs };
  if (Date.now() >= _pendingDismissRecord.expiresAt) return { conts, discs };
  const { book, bucket } = _pendingDismissRecord;
  if (conts.some(b => b.id === book.id) || discs.some(b => b.id === book.id)) {
    return { conts, discs };
  }
  return bucket === 'continuations'
    ? { conts: [book, ...conts], discs }
    : { conts, discs: [book, ...discs] };
}

// React state — which card currently shows the in-card undo row.
// Timer ownership lives in _pendingDismissRecord (persists across tab switches).
type DismissPendingState = {
  book: ScoredBook;
};

// Revisit skips Phase 2 when session is this fresh AND signal unchanged.
const REC_SESSION_TTL_MS = 4 * 60 * 1000; // 4 minutes

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RecommendationsScreen() {
  const router = useRouter();
  const { step: guidedStep, advance: advanceGuided } = useGuidedTour();
  const [step, setStep] = useState<Step>('hub');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // ── Hub state ──────────────────────────────────────────────────────────────
  // hubLoading is true only on a cold start with no rec session cache.
  // On return visits, hub sections render immediately from _hubCache.
  const [hubLoading, setHubLoading]           = useState<boolean>(() => !_recSession);
  const [recsLoading, setRecsLoading]         = useState(false);
  const [recsQualityGate, setRecsQualityGate] = useState<QualityGate | null>(null);
  const [recsMeta, setRecsMeta]               = useState<RankedRecsResult['meta'] | null>(null);
  const [feedbackCtx, setFeedbackCtx]         = useState<FeedbackContext>(emptyContext());
  const [dismissPending, setDismissPending]   = useState<DismissPendingState | null>(null);
  const [booksToRate, setBooksToRate]         = useState<BookToRate[]>(() => _hubCache?.booksToRate ?? []);
  const [booksToTag, setBooksToTag]           = useState<BookToTag[]>(() => _hubCache?.booksToTag ?? []);
  const [incomingRecs, setIncomingRecs]       = useState<IncomingRec[]>(() => _hubCache?.incomingRecs ?? []);
  const [sentRecs, setSentRecs]               = useState<SentRec[]>(() => _hubCache?.sentRecs ?? []);
  const [tasteProfile, setTasteProfile]       = useState<TasteProfile | null>(() => _hubCache?.tasteProfile ?? null);
  const [recommendations, setRecommendations] = useState<ScoredBook[]>([]);
  const [continuations,   setContinuations]   = useState<ScoredBook[]>([]);
  const [discoveries,     setDiscoveries]     = useState<ScoredBook[]>([]);

  // ── Background-refresh indicator (stale-while-revalidate) ─────────────────
  // True while Phase 2 is running with cached recs already showing.
  // Shows a subtle "Refreshing…" badge instead of the full skeleton.
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);

  // ── Deck-exhaustion transitional hint ──────────────────────────────────────
  // Tracks whether the deck has ever had cards (avoids triggering on cold load).
  // When the deck goes from non-empty → empty, shows a 2.5 s "Refreshing your
  // picks…" placeholder before the terminal caught-up state appears.
  const hadDeckRef = useRef(false);
  const [deckTransitionHint, setDeckTransitionHint] = useState(false);

  // ── Save-failure retry state ───────────────────────────────────────────────
  // Set when the background DB write in handleRecSave throws. Cleared on retry
  // or after a 6 s auto-dismiss so it never lingers.
  const [saveFailure, setSaveFailure] = useState<{ title: string; book: ScoredBook } | null>(null);

  // ── Stale-request guard ────────────────────────────────────────────────────
  // Monotonically incremented at the start of every loadHub() and reloadRecs()
  // call.  Before any setState that follows an await, the handler checks that
  // it still holds the latest request ID.  If not, a newer call has superseded
  // it and the stale result is discarded without touching state.
  const latestHubLoadRef = useRef(0);

  // ── Dev-only performance overlay state ────────────────────────────────────
  const [recTiming, setRecTiming]             = useState<DevTimings | null>(null);
  // Off by default — long-press the "Recommendations" title to toggle in dev builds
  const [showTimingOverlay, setShowTimingOverlay] = useState(false);

  // ── Entitlement + expert mode state ───────────────────────────────────────
  const [entitlement, setEntitlement]         = useState<RecEntitlement | null>(null);
  const [recMode, setRecMode]                 = useState<'deterministic' | 'expert' | null>(null);
  const [readerThesis, setReaderThesis]       = useState<ReaderThesis | null>(null);
  const [isFreePreview, setIsFreePreview]     = useState(false);
  const [thesisOpen, setThesisOpen]           = useState(false);
  const thesisHeight                          = useRef(new Animated.Value(0)).current;

  // ── "Your Next Read" intent layer state ──────────────────────────────────
  const [nextReadIntent, setNextReadIntent]   = useState<NextReadIntent>(emptyNextReadIntent());
  const [draftIntent, setDraftIntent]         = useState<NextReadIntent>(emptyNextReadIntent());
  const [nlInput, setNlInput]                 = useState('');
  const [intentPanelOpen, setIntentPanelOpen] = useState(false);
  const intentPanelHeight                     = useRef(new Animated.Value(0)).current;

  // ── Dev-only render guard observer ───────────────────────────────────────
  // Fires after every state change that affects rec visibility in the hub.
  // Logs [REC_RENDER] so you can see the exact guard values without DevTools.
  useEffect(() => {
    if (!__DEV__) return;
    const hasR = recommendations.length > 0 || continuations.length > 0;
    console.log('[REC_RENDER]',
      `loading=${recsLoading}`,
      `| recommendations_length=${recommendations.length}`,
      `| continuations_length=${continuations.length}`,
      `| discoveries_length=${discoveries.length}`,
      `| hasRecs=${hasR}`,
      `| quality_gate=${recsQualityGate ?? 'null'}`,
      `| showing_empty_state=${!hasR && !recsQualityGate && !recsLoading}`,
    );
  }, [recsLoading, recommendations.length, continuations.length, discoveries.length, recsQualityGate]);

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

  // Reload hub whenever screen comes into focus
  useFocusEffect(useCallback(() => {
    if (step === 'hub') loadHub();
  }, [step]));

  async function handleRefresh() {
    if (step !== 'hub') return;
    setRefreshing(true);
    await loadHub();
    setRefreshing(false);
  }

  // ── Deck replenishment ────────────────────────────────────────────────────
  // When the visible deck empties entirely after user actions (save/dismiss/
  // more-like-this), automatically trigger a fresh recommendation run so the
  // surface never sits permanently blank.  Fires only once per empty event
  // (guarded by loading flags) and uses the OL session cache so it's fast.
  useEffect(() => {
    const total = continuations.length + discoveries.length;
    if (
      total <= 1 &&
      !recsLoading &&
      !isBackgroundRefreshing &&
      currentUserId &&
      tasteProfile &&
      tasteProfile.tier >= 1
    ) {
      reloadRecs(nextReadIntent);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuations.length, discoveries.length]);

  // Monotonically-increasing counter. Each search request stamps itself; only
  // the response whose stamp matches the current value may commit to state.
  // This prevents a slow earlier response from overwriting a faster later one.
  const searchSeqRef = useRef(0);

  // ── Deck-exhaustion transitional hint effect ─────────────────────────────
  // When the deck transitions from having cards to empty (after user actions),
  // briefly show "Refreshing your picks…" before the caught-up state appears.
  useEffect(() => {
    const deckEmpty = continuations.length === 0 && discoveries.length === 0;
    if (!deckEmpty) {
      hadDeckRef.current = true;
      return;
    }
    if (hadDeckRef.current && !recsLoading) {
      setDeckTransitionHint(true);
      const t = setTimeout(() => setDeckTransitionHint(false), 2500);
      return () => clearTimeout(t);
    }
  }, [continuations.length, discoveries.length, recsLoading]);

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

  // ── Pending dismiss timer restart ─────────────────────────────────────────
  // Called at every load commit path (cache_restore / background_refresh /
  // reload_recs) to re-establish the dismiss countdown after a tab switch.
  // Returns the new DismissPendingState for setDismissPending(), or null when
  // the record has expired while the user was away (triggers an immediate commit).
  function reapplyPendingDismiss(uid: string): DismissPendingState | null {
    if (!_pendingDismissRecord || !supabase) return null;
    const now = Date.now();
    const { book, expiresAt } = _pendingDismissRecord;

    if (now >= expiresAt) {
      // Expired while away — commit immediately, no undo row shown
      _pendingDismissRecord = null;
      _commitPendingToActedOn(uid, book);
      setFeedbackCtx(prev => {
        const next = new Set(prev.dismissedIds);
        if (book.external_id) next.add(book.external_id);
        if (book._source === 'catalog') next.add(book.id);
        return { ...prev, dismissedIds: next };
      });
      persistFeedback(supabase, uid, book, 'dismissed').catch(() => {});
      if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=committed_on_revisit', `| book_id=${book.id}`);
      return null;
    }

    // Cancel the stale timer; start a fresh one for the remaining window
    if (_pendingDismissRecord.timerId) clearTimeout(_pendingDismissRecord.timerId);
    const remaining = expiresAt - now;
    const _sb = supabase;
    const timerId = setTimeout(() => {
      if (!_pendingDismissRecord || _pendingDismissRecord.book.id !== book.id) return;
      _pendingDismissRecord = null;
      const bookFilter = (b: ScoredBook) => b.id !== book.id;
      setRecommendations(p => p.filter(bookFilter));
      setContinuations(p   => p.filter(bookFilter));
      setDiscoveries(p     => p.filter(bookFilter));
      setDismissPending(null);
      _commitPendingToActedOn(uid, book);
      if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=committed', `| book_id=${book.id}`, `| external_id=${book.external_id ?? 'none'}`);
      setFeedbackCtx(prev => {
        const next = new Set(prev.dismissedIds);
        if (book.external_id) next.add(book.external_id);
        if (book._source === 'catalog') next.add(book.id);
        return { ...prev, dismissedIds: next };
      });
      persistFeedback(_sb, uid, book, 'dismissed').catch(() => {});
    }, remaining);
    _pendingDismissRecord.timerId = timerId;
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=pending_rehydrated', `| book_id=${book.id}`, `| remaining_ms=${remaining}`);
    return { book };
  }

  // ── Hub data loader ───────────────────────────────────────────────────────
  //
  // Fast-path (revisit with session cache):
  //   1. Restore recs from _recSession immediately — no loading flash.
  //   2. Run Phase 1 (DB queries) in background; commit task data in-place.
  //   3. After Phase 1, check signal delta.
  //      • Unchanged + session fresh → skip Phase 2 entirely (instant revisit).
  //      • Changed or stale         → run Phase 2 in background with
  //                                    isBackgroundRefreshing=true so the
  //                                    existing recs stay visible.
  //
  // Cold-path (first load or user change):
  //   Phase 1 → hubLoading skeleton → Phase 2 → recsLoading skeleton.

  async function loadHub() {
    if (!supabase) { setHubLoading(false); setRecsLoading(false); return; }

    const requestId = ++latestHubLoadRef.current;
    const _mountMs  = Date.now();
    if (__DEV__) console.log('[PERF] recommendations_screen_mount', `| requestId=${requestId}`);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setHubLoading(false); setRecsLoading(false); return; }
    // Belt-and-suspenders: clear stale caches if the user switched accounts
    if (_recSession && _recSession.userId !== user.id) _recSession = null;
    if (_hubCache   && _hubCache.userId   !== user.id) _hubCache   = null;
    setCurrentUserId(user.id);

    // ── Fast-path 1: restore from in-memory session cache (0ms) ──────────
    let cached = _recSession && _recSession.userId === user.id ? _recSession : null;

    // ── Acted-on ID sync ──────────────────────────────────────────────────
    // Ensure the module-level sets are scoped to the current user.
    // On user change, reset both sets and reload persisted IDs from
    // AsyncStorage so acted-on cards are excluded even on cold start.
    // _pendingUndoIds is always empty at this point (cold starts cannot be
    // mid-undo-window) so it only needs clearing on user switch.
    if (_actedOnUserId !== user.id) {
      const stored = await loadActedOnIds(user.id);
      _actedOnIds          = stored;
      _pendingUndoIds      = new Set();
      _pendingDismissRecord = null;  // cross-session dismiss belongs to previous user
      _actedOnUserId       = user.id;
    }

    // ── Fast-path 2: restore from persistent AsyncStorage cache (~30ms) ───
    // Only reached on cold start (app restart) when _recSession is empty.
    if (!cached) {
      const persisted = await loadRecPayload(user.id);
      if (persisted && (persisted.recs.length > 0 || persisted.continuations.length > 0)) {
        if (__DEV__) console.log('[PERF] cache_hit — restoring PERSISTED recs instantly',
          `| age_ms=${Date.now() - persisted.loadedAt}`,
          `| recs=${persisted.recs.length}`,
          `| signal=${persisted.signalCount}`,
        );
        // Promote to in-memory session so next tab revisit is instant too
        _recSession = {
          userId:        user.id,
          recs:          persisted.recs,
          continuations: persisted.continuations,
          discoveries:   persisted.discoveries,
          meta:          persisted.meta,
          recMode:       persisted.recMode,
          readerThesis:  persisted.readerThesis,
          qualityGate:   persisted.qualityGate,
          isFreePreview: persisted.isFreePreview,
          signalCount:   persisted.signalCount,
          loadedAt:      persisted.loadedAt,
        };
        cached = _recSession;
      }
    }

    if (cached) {
      if (__DEV__) console.log('[PERF] cache_hit — restoring session recs instantly',
        `| age_ms=${Date.now() - cached.loadedAt}`,
        `| recs=${cached.recs.length}`,
      );
      // Filter out any recs the user has already acted on (both permanently
      // acted-on and pending-undo dismiss) so they never reappear on revisit.
      const _crRecs   = cached.recs.filter(filterActedOn);
      const _crConts  = cached.continuations.filter(filterActedOn);
      const _crDiscs  = cached.discoveries.filter(filterActedOn);
      if (__DEV__) console.log('[REC_FILTER_APPLIED]',
        'source=cache_restore',
        `| before_count=${cached.recs.length + cached.continuations.length + cached.discoveries.length}`,
        `| after_count=${_crRecs.length + _crConts.length + _crDiscs.length}`,
        `| acted_on=${_actedOnIds.size}`,
        `| pending_undo=${_pendingUndoIds.size}`,
      );
      // Re-inject pending-dismiss book if still within undo window (Issue 1)
      const { conts: _crPDConts, discs: _crPDDiscs } = rehydratePendingDismiss(_crConts, _crDiscs);
      // Limit initial display to DECK_PAGE_SIZE (Issue 2)
      const { conts: _crPSConts, discs: _crPSDiscs } = applyPageSize(_crPDConts, _crPDDiscs);
      setRecommendations(_crRecs);
      setContinuations(_crPSConts);
      setDiscoveries(_crPSDiscs);
      setRecsMeta(cached.meta);
      setRecsQualityGate(cached.qualityGate);
      setRecMode(cached.recMode);
      setReaderThesis(cached.readerThesis);
      setIsFreePreview(cached.isFreePreview);
      setRecsLoading(false);
      setIsBackgroundRefreshing(false);
      // Restore dismiss undo row + restart timer for remaining window
      setDismissPending(reapplyPendingDismiss(user.id));
    }

    // ── Phase 1: core hub data (all DB queries run concurrently) ─────────
    // When cached recs exist: no skeleton, hub data updates in-place after load.
    // When cold start: shows skeleton until this resolves.
    if (!cached) setHubLoading(true);

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

    // Stale-request guard: a newer loadHub() superseded this one while Phase 1
    // was in flight.  Discard results — the newer call will commit its own.
    if (requestId !== latestHubLoadRef.current) {
      if (__DEV__) console.log('[PERF] phase1_stale_discarded', `| requestId=${requestId}`);
      return;
    }

    // Commit Phase 1 state
    const _incomingRows = (incomingRes.data as unknown as IncomingRec[]) ?? [];
    const _sentRows     = (sentRes.data    as unknown as SentRec[])     ?? [];
    setBooksToRate(toRate);
    setBooksToTag(toTag);
    setIncomingRecs(_incomingRows);
    setSentRecs(_sentRows);
    setTasteProfile(tp);
    setEntitlement(ent);
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

    // ── Phase 2 gate: minimum tier, and skip-if-fresh check ──────────────
    if (!tp || tp.tier < 1) return;

    const currentSignal = tp.strongSignalCount ?? 0;
    const sessionAge    = cached ? Date.now() - cached.loadedAt : Infinity;
    const signalUnchanged = cached && currentSignal === cached.signalCount;
    const sessionFresh    = sessionAge < REC_SESSION_TTL_MS;

    // ── Persisted-cache compatibility gate ────────────────────────────────
    // Now that Phase 1 has resolved, we know current signal, entitlement,
    // and active intent. Compute compatibility signals outside __DEV__ so
    // they drive the skip gate, not just the log.
    //
    // What must match to skip Phase 2:
    //   signal    — signalUnchanged (taste profile hasn't changed)
    //   mode      — deterministic vs expert (entitlement must agree with stored mode)
    //   intent    — active intent tag must match what recs were produced for
    //   freshness — payload age must be within session TTL
    //
    // isFreePreview is NOT a separate gate: if entitlement changed enough to
    // alter isFreePreview, the recMode will also differ, so modeMatch catches it.
    const expectedMode      = ent?.expert_recs_enabled ? 'expert' : 'deterministic';
    const expectedIntent    = isIntentActive(nextReadIntent) ? intentSummaryLabel(nextReadIntent) : null;
    const modeMatch         = !cached || cached.recMode    === expectedMode;
    const intentMatch       = !cached || (cached.intentTag ?? null) === expectedIntent;
    const payloadCompatible = modeMatch && intentMatch;

    if (__DEV__ && cached) {
      const signalDelta = currentSignal - (cached.signalCount ?? 0);
      if (signalDelta !== 0 || !modeMatch || !intentMatch) {
        console.log('[PERSIST_CACHE] compatibility_check',
          `| signal_delta=${signalDelta}`,
          `| mode: stored=${cached.recMode ?? '?'} expected=${expectedMode} match=${modeMatch}`,
          `| intent: stored=${cached.intentTag ?? 'none'} expected=${expectedIntent ?? 'none'} match=${intentMatch}`,
          `| action=${payloadCompatible ? 'background_refresh' : 'background_refresh_mode_drift'}`,
        );
      } else {
        console.log('[PERSIST_CACHE] compatibility_check — aligned',
          `| signal=${currentSignal}`,
          `| mode=${expectedMode}`,
        );
      }
    }

    if (cached && signalUnchanged && sessionFresh && payloadCompatible) {
      if (__DEV__) console.log('[PERF] phase2_skipped — fully_compatible',
        `| age_ms=${sessionAge}`,
        `| signal=${currentSignal}`,
        `| mode=${expectedMode}`,
        `| intent=${expectedIntent ?? 'none'}`,
        `| total_ms=${Date.now() - _mountMs}`,
      );
      return; // ← instant revisit: skip the 4–5 s pipeline entirely
    }

    // ── Phase 2: recommendation pipeline (includes OL calls, ~4–5 s) ─────
    // Use isBackgroundRefreshing (subtle badge) when cached recs are visible;
    // use recsLoading (full skeleton) only on first cold start.
    const hasCachedRecs = cached && cached.recs.length > 0;
    if (hasCachedRecs) {
      setIsBackgroundRefreshing(true);
    } else {
      setRecsLoading(true);
    }
    setRecsQualityGate(null);
    setRecMode(null);
    setIsFreePreview(false);

    try {
      const fbCtx = fbCtxPhase1;
      setFeedbackCtx(fbCtx);

      const activeEntitlement = ent ?? {
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

      const _phase2Start = Date.now();
      if (__DEV__) console.log('[PERF] phase2_start',
        `| mode=${hasCachedRecs ? 'background_refresh' : 'cold_start'}`,
        `| signal_delta=${currentSignal - (cached?.signalCount ?? 0)}`,
      );

      const recResult = await getPersonalizedRecsWithExpert(
        supabase!, user.id, tp, activeEntitlement, 5, fbCtx,
        isIntentActive(nextReadIntent) ? nextReadIntent : undefined,
      );

      const _pipelineMs = Date.now() - _phase2Start;
      if (__DEV__) {
        console.log('[PERF] phase2_end — pipeline_ms=' + _pipelineMs);
        console.log('[REC_TIMING] total_pipeline_ms=' + _pipelineMs);
        if (__devTimingsRef.current) {
          __devTimingsRef.current.total_pipeline_ms = _pipelineMs;
          setRecTiming({ ...__devTimingsRef.current });
        }
      }
      const { recs, meta } = recResult;

      if (__DEV__) {
        console.log('[REC_RESULT]',
          `recs_count=${recs.length}`,
          `| continuations_count=${(recResult.continuations ?? []).length}`,
          `| discoveries_count=${(recResult.discoveries ?? recs).length}`,
          `| quality_gate=${meta.quality_gate}`,
          `| pool_size=${meta.pool_size}`,
          `| from_cache=${meta.is_from_cache}`,
          `| decision=${meta.expert_decision?.reason ?? 'n/a'}`,
          `| mode=${meta.mode ?? 'deterministic'}`,
          `| first_titles=[${recs.slice(0, 3).map(r => `"${r.title}"`).join(', ')}]`,
        );
        console.log('[REC_STATE_COMMIT]',
          `incoming_recs=${recs.length}`,
          `| incoming_continuations=${(recResult.continuations ?? []).length}`,
          `| incoming_discoveries=${(recResult.discoveries ?? recs).length}`,
          `| loading_before=${!hasCachedRecs}`,
          `| loading_after=false`,
          `| hasRecs_after=${recs.length > 0 || (recResult.continuations ?? []).length > 0}`,
        );
      }

      // Stale-request guard: a newer loadHub() superseded this one while Phase 2
      // was in flight.  Discard results — the newer call will commit its own.
      if (requestId !== latestHubLoadRef.current) {
        if (__DEV__) console.log('[PERF] phase2_stale_discarded', `| requestId=${requestId}`);
        return;
      }

      // ── Downgrade protection ──────────────────────────────────────────────
      // If Phase 2 ran as a background refresh (cached recs were already shown)
      // and the fresh result would replace them with an empty / quality-gated
      // state, suppress the commit AND the cache writes.
      // This prevents the "cached recs disappear after 4-5s" regression AND
      // ensures the next tab open replays the last good payload, not this one.
      const _isBgRefresh   = hasCachedRecs;
      const _freshIsEmpty  = recs.length === 0 && (recResult.continuations ?? []).length === 0;
      const _freshIsGated  = meta.quality_gate != null && meta.quality_gate !== 'passed';

      // Classify the degradation reason for logging.
      // dependency_degraded: OL returned 0 AND pool is still insufficient —
      // this is an external fetch outage, not a taste-fit or data quality issue.
      const _isDependencyDegraded =
        meta.live_ol_count === 0 &&
        (_freshIsEmpty || _freshIsGated);
      const _derivedGate: string = _isDependencyDegraded
        ? 'dependency_degraded'
        : (meta.quality_gate ?? 'passed');

      if (_isBgRefresh && (_freshIsEmpty || _freshIsGated)) {
        if (__DEV__) console.log('[REC_DOWNGRADE_SUPPRESSED]',
          `prev_recs=${recommendations.length}`,
          `| next_recs=${recs.length}`,
          `| quality_gate=${_derivedGate}`,
          `| pool_size=${meta.pool_size}`,
          `| mode=${meta.mode ?? 'deterministic'}`,
          `| intent=${expectedIntent ?? 'none'}`,
          `| fingerprint=v1:${currentSignal}:${expectedMode}:nfp:${expectedIntent ?? 'none'}`,
        );
        // Explicit cache-write suppression log — both session and persisted
        // cache are left untouched so the next open restores the last good payload.
        if (__DEV__) console.log('[REC_CACHE_WRITE]',
          `allowed=false`,
          `| reason=${_isDependencyDegraded ? 'dependency_degraded' : _freshIsEmpty ? 'result_empty' : 'quality_gated'}`,
          `| prev_cached_recs=${cached?.recs.length ?? 0}`,
          `| next_recs=${recs.length}`,
          `| quality_gate=${_derivedGate}`,
          `| live_ol_candidates=${meta.live_ol_count}`,
          `| sources_used=${JSON.stringify({ catalog: meta.catalog_count, live_ol: meta.live_ol_count, cached_ext: meta.cached_external_count })}`,
        );
        // Keep current recs visible; only clear the refreshing indicator
        setIsBackgroundRefreshing(false);
        return;
      }

      // ── Commit logging ────────────────────────────────────────────────────
      const _commitType = _isBgRefresh ? 'background_refresh' : 'cold_start';
      if (__DEV__) console.log('[REC_COMMIT]',
        `commit_type=${_commitType}`,
        `| prev_visible_recs=${recommendations.length}`,
        `| next_recs=${recs.length}`,
        `| continuations=${(recResult.continuations ?? []).length}`,
        `| quality_gate=${meta.quality_gate ?? 'passed'}`,
        `| pool_size=${meta.pool_size}`,
        `| mode=${meta.mode ?? 'deterministic'}`,
        `| intent=${expectedIntent ?? 'none'}`,
      );

      if (__DEV__) console.log('[PERF] phase2_commit', `| recs=${recs.length}`);
      const _bgRecs  = recs.filter(filterActedOn);
      const _bgConts = (recResult.continuations ?? []).filter(filterActedOn);
      const _bgDiscs = (recResult.discoveries   ?? recs).filter(filterActedOn);
      if (__DEV__) console.log('[REC_FILTER_APPLIED]',
        'source=background_refresh',
        `| before_count=${recs.length + (recResult.continuations ?? []).length + (recResult.discoveries ?? recs).length}`,
        `| after_count=${_bgRecs.length + _bgConts.length + _bgDiscs.length}`,
        `| acted_on=${_actedOnIds.size}`,
        `| pending_undo=${_pendingUndoIds.size}`,
      );
      // Re-inject pending-dismiss book (Issue 1) + apply page size (Issue 2)
      const { conts: _bgPDConts, discs: _bgPDDiscs } = rehydratePendingDismiss(_bgConts, _bgDiscs);
      const { conts: _bgPSConts, discs: _bgPSDiscs } = applyPageSize(_bgPDConts, _bgPDDiscs);
      setRecommendations(_bgRecs);
      setContinuations(_bgPSConts);
      setDiscoveries(_bgPSDiscs);
      setDismissPending(reapplyPendingDismiss(user.id));
      setRecsMeta(meta);
      setRecsQualityGate(meta.quality_gate !== 'passed' ? meta.quality_gate : null);
      setRecMode(meta.mode ?? 'deterministic');
      setReaderThesis(meta.reader_thesis ?? null);
      setIsFreePreview(meta.expert_decision?.is_free_preview ?? false);

      // ── Cache write (session + persisted) ────────────────────────────────
      // Guard: only write when the result has actual recommendations.
      // Defence-in-depth against any future path that reaches here with a
      // degraded result that was not caught by the downgrade-suppression block.
      const _allowCacheWrite = recs.length > 0 || (recResult.continuations ?? []).length > 0;
      if (__DEV__) console.log('[REC_CACHE_WRITE]',
        `allowed=${_allowCacheWrite}`,
        `| reason=${_allowCacheWrite ? 'ok' : _isDependencyDegraded ? 'dependency_degraded' : 'result_empty'}`,
        `| prev_cached_recs=${cached?.recs.length ?? 0}`,
        `| next_recs=${recs.length}`,
        `| quality_gate=${_derivedGate}`,
        `| live_ol_candidates=${meta.live_ol_count}`,
        `| sources_used=${JSON.stringify({ catalog: meta.catalog_count, live_ol: meta.live_ol_count, cached_ext: meta.cached_external_count })}`,
      );
      if (_allowCacheWrite) {
        const _sessionPayload = {
          userId:        user.id,
          recs,
          continuations: recResult.continuations ?? [],
          discoveries:   recResult.discoveries   ?? recs,
          meta,
          recMode:       meta.mode ?? 'deterministic',
          readerThesis:  meta.reader_thesis ?? null,
          qualityGate:   meta.quality_gate !== 'passed' ? meta.quality_gate : null,
          isFreePreview: meta.expert_decision?.is_free_preview ?? false,
          signalCount:   currentSignal,
          loadedAt:      Date.now(),
        };
        _recSession = _sessionPayload;
        if (__DEV__) console.log('[PERF] session_cache_saved',
          `| recs=${recs.length}`,
          `| signal=${currentSignal}`,
          `| total_ms=${Date.now() - _mountMs}`,
        );
        // Persist to AsyncStorage so next cold start (app restart) is instant too
        const _persistIntentTag = isIntentActive(nextReadIntent) ? intentSummaryLabel(nextReadIntent) : null;
        saveRecPayload(user.id, {
          recs:          _sessionPayload.recs,
          continuations: _sessionPayload.continuations,
          discoveries:   _sessionPayload.discoveries,
          meta:          _sessionPayload.meta,
          recMode:       _sessionPayload.recMode,
          readerThesis:  _sessionPayload.readerThesis,
          qualityGate:   _sessionPayload.qualityGate,
          isFreePreview: _sessionPayload.isFreePreview,
          signalCount:   _sessionPayload.signalCount,
          intentTag:     _persistIntentTag,
          fingerprint:   computeRecFingerprint(
            _sessionPayload.signalCount,
            _sessionPayload.recMode,
            _sessionPayload.isFreePreview,
            _persistIntentTag,
          ),
          loadedAt:      _sessionPayload.loadedAt,
        }).catch(() => {});
      }

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
            dominant_lanes:    meta.reader_thesis.dominant_lanes.map(l => `${l.label} (${l.strength.toFixed(2)})`),
            center_of_gravity: meta.reader_thesis.center_of_gravity,
            guardrails:        meta.reader_thesis.recommendation_guardrails.length,
          });
        }
        console.log('[REC TRACE] top-10 scored:', recs.slice(0, 10).map(r => ({
          title:     r.title,
          author:    r.author,
          score:     r.score,
          source:    r._source,
          reason:    r._retrieval_reason,
          breakdown: r._score_breakdown,
          fit:       r.reasons,
          risks:     r.risks,
        })));
      }
    } catch (error) {
      // Recommendations fail silently — hub content is already visible.
      if (__DEV__) console.log('[PERF] phase2_error', error);
    } finally {
      setRecsLoading(false);
      setIsBackgroundRefreshing(false);
    }
  }

  // ── Reload recs with a specific intent (Phase 2 only, no hub re-fetch) ──────
  // Called when the user applies or clears their "Your Next Read" intent.
  // Re-runs the recommendation pipeline using already-loaded state values.
  // OL candidates are cached, so this is fast (DB read + in-memory scoring).

  async function reloadRecs(intent: NextReadIntent) {
    if (!supabase || !currentUserId || !tasteProfile || tasteProfile.tier < 1) return;
    const requestId = ++latestHubLoadRef.current;
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
      // Stale-request guard: a newer call (loadHub or reloadRecs) superseded this
      // intent reload while the pipeline was in flight.  Discard stale results.
      if (requestId !== latestHubLoadRef.current) {
        if (__DEV__) console.log('[PERF] reloadRecs_stale_discarded', `| requestId=${requestId}`);
        return;
      }
      if (__DEV__) console.log('[REC_COMMIT]',
        `commit_type=reload_recs`,
        `| prev_visible_recs=${recommendations.length}`,
        `| next_recs=${recs.length}`,
        `| continuations=${(intentResult.continuations ?? []).length}`,
        `| quality_gate=${meta.quality_gate ?? 'passed'}`,
        `| pool_size=${meta.pool_size}`,
        `| mode=${meta.mode ?? 'deterministic'}`,
        `| intent=${isIntentActive(intent) ? intent.book_title ?? 'active' : 'none'}`,
      );
      const _rrRecs  = recs.filter(filterActedOn);
      const _rrConts = (intentResult.continuations ?? []).filter(filterActedOn);
      const _rrDiscs = (intentResult.discoveries   ?? recs).filter(filterActedOn);
      if (__DEV__) console.log('[REC_FILTER_APPLIED]',
        'source=reload_recs',
        `| before_count=${recs.length + (intentResult.continuations ?? []).length + (intentResult.discoveries ?? recs).length}`,
        `| after_count=${_rrRecs.length + _rrConts.length + _rrDiscs.length}`,
        `| acted_on=${_actedOnIds.size}`,
        `| pending_undo=${_pendingUndoIds.size}`,
      );
      // Re-inject pending-dismiss book (Issue 1) + apply page size (Issue 2)
      const { conts: _rrPDConts, discs: _rrPDDiscs } = rehydratePendingDismiss(_rrConts, _rrDiscs);
      const { conts: _rrPSConts, discs: _rrPSDiscs } = applyPageSize(_rrPDConts, _rrPDDiscs);
      setRecommendations(_rrRecs);
      setContinuations(_rrPSConts);
      setDiscoveries(_rrPSDiscs);
      if (currentUserId) setDismissPending(reapplyPendingDismiss(currentUserId));
      setRecsMeta(meta);
      setRecsQualityGate(meta.quality_gate !== 'passed' ? meta.quality_gate : null);
    } catch {
      // silent — recommendations fail gracefully
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

  // Retry the DB write for a book that failed to save. Card is already removed
  // from the deck so we only redo the upsert + feedback persist — no UI change.
  async function handleRetrySave(book: ScoredBook) {
    if (!supabase || !currentUserId) return;
    setSaveFailure(null);
    try {
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
        const { error } = await supabase
          .from('user_books')
          .upsert(
            { user_id: currentUserId, book_id: bookDbId, status: 'want_to_read' },
            { onConflict: 'user_id,book_id', ignoreDuplicates: true },
          );
        if (error) throw error;
      }
      persistFeedback(supabase, currentUserId, book, 'saved', {
        book_db_id: bookDbId ?? undefined,
      }).catch(() => {});
    } catch {
      // Show failure again with fresh 6 s timer
      setSaveFailure({ title: book.title, book });
      setTimeout(() => setSaveFailure(f => f?.book.id === book.id ? null : f), 6000);
    }
  }

  // ── Recommendation feedback handlers ─────────────────────────────────────

  function handleRecSave(book: ScoredBook) {
    if (!supabase || !currentUserId) return;

    // ── Optimistic UI: remove card + backfill next eligible from session ─────
    const bookFilter    = (b: ScoredBook) => b.id !== book.id;
    const filteredConts = continuations.filter(bookFilter);
    const filteredDiscs = discoveries.filter(bookFilter);
    const { conts: newConts, discs: newDiscs } = appendNextEligible(filteredConts, filteredDiscs);
    setRecommendations(prev => prev.filter(bookFilter));
    setContinuations(newConts);
    setDiscoveries(newDiscs);

    // Track locally + persist so this card is filtered on next cache restore
    _trackActedOn(currentUserId, book);
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=save', 'status=committed', `| book_id=${book.id}`, `| external_id=${book.external_id ?? 'none'}`);
    setFeedbackCtx(prev => {
      const next = new Set(prev.savedIds);
      if (book.external_id) next.add(book.external_id);
      if (book._source === 'catalog') next.add(book.id);
      return { ...prev, savedIds: next };
    });

    // ── Background: upsert book record + add to library + persist feedback ───
    (async () => {
      let bookDbId: string | null = null;
      try {
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
                page_count:  book.page_count,
              })
              .select('id')
              .single();
            bookDbId = created?.id ?? null;
          }
        }

        if (bookDbId) {
          const { error: upsertErr } = await supabase!
            .from('user_books')
            .upsert(
              { user_id: currentUserId, book_id: bookDbId, status: 'want_to_read' },
              { onConflict: 'user_id,book_id', ignoreDuplicates: true },
            );
          if (upsertErr) throw upsertErr;
        }

        persistFeedback(supabase!, currentUserId!, book, 'saved', {
          book_db_id: bookDbId ?? undefined,
        }).catch(() => {});
      } catch {
        // Surface a lightweight retry bar — auto-dismisses after 6 s
        setSaveFailure({ title: book.title, book });
        setTimeout(() => setSaveFailure(f => f?.book.id === book.id ? null : f), 6000);
      }
    })();
  }

  function handleRecDismiss(book: ScoredBook) {
    if (!supabase || !currentUserId) return;

    // ── Commit any pre-existing pending dismiss immediately ────────────────────
    // Only one undo window open at a time; opening a new one commits the old one.
    if (_pendingDismissRecord) {
      if (_pendingDismissRecord.timerId) clearTimeout(_pendingDismissRecord.timerId);
      const prevBook   = _pendingDismissRecord.book;
      const prevFilter = (b: ScoredBook) => b.id !== prevBook.id;
      setRecommendations(p => p.filter(prevFilter));
      setContinuations(p   => p.filter(prevFilter));
      setDiscoveries(p     => p.filter(prevFilter));
      _commitPendingToActedOn(currentUserId!, prevBook);
      if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=committed', `| book_id=${prevBook.id}`, `| external_id=${prevBook.external_id ?? 'none'}`);
      setFeedbackCtx(prev => {
        const next = new Set(prev.dismissedIds);
        if (prevBook.external_id) next.add(prevBook.external_id);
        if (prevBook._source === 'catalog') next.add(prevBook.id);
        return { ...prev, dismissedIds: next };
      });
      persistFeedback(supabase!, currentUserId!, prevBook, 'dismissed').catch(() => {});
      _pendingDismissRecord = null;
    }

    // ── Determine bucket before pending state changes the arrays ─────────────
    const bucket: PendingDismissRecord['bucket'] =
      continuations.some(b => b.id === book.id) ? 'continuations' : 'discoveries';

    // ── Mark as pending-undo (immediate exclusion from inbound refresh paths) ─
    _trackActedOnPending(book);
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=pending', `| book_id=${book.id}`, `| external_id=${book.external_id ?? 'none'}`);

    // ── Create module-level record (survives tab switches) ────────────────────
    const expiresAt = Date.now() + DISMISS_UNDO_MS;
    _pendingDismissRecord = { book, bucket, expiresAt, timerId: null };

    // ── Undo window timer ─────────────────────────────────────────────────────
    // Timer fires → remove card from arrays and promote pending → committed.
    const _sb  = supabase!;
    const _uid = currentUserId!;
    const timerId = setTimeout(() => {
      if (!_pendingDismissRecord || _pendingDismissRecord.book.id !== book.id) return;
      _pendingDismissRecord = null;
      const bookFilter = (b: ScoredBook) => b.id !== book.id;
      setRecommendations(p => p.filter(bookFilter));
      setContinuations(p   => p.filter(bookFilter));
      setDiscoveries(p     => p.filter(bookFilter));
      setDismissPending(null);
      _commitPendingToActedOn(_uid, book);
      if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=committed', `| book_id=${book.id}`, `| external_id=${book.external_id ?? 'none'}`);
      setFeedbackCtx(prev => {
        const next = new Set(prev.dismissedIds);
        if (book.external_id) next.add(book.external_id);
        if (book._source === 'catalog') next.add(book.id);
        return { ...prev, dismissedIds: next };
      });
      persistFeedback(_sb, _uid, book, 'dismissed').catch(() => {});
    }, DISMISS_UNDO_MS);

    _pendingDismissRecord.timerId = timerId;

    // ── Backfill: promote one next-eligible book so deck depth is maintained ──
    // Compute shown set: all current cards except the dismissed one (which becomes
    // the undo row and shouldn't be its own replacement).
    const shown = new Set<string>();
    for (const b of continuations) {
      if (b.id !== book.id) { shown.add(b.id); if (b.external_id) shown.add(b.external_id); }
    }
    for (const b of discoveries) {
      if (b.id !== book.id) { shown.add(b.id); if (b.external_id) shown.add(b.external_id); }
    }
    shown.add(book.id);
    if (book.external_id) shown.add(book.external_id);
    const next = nextEligibleFromSession(shown);
    if (next) {
      if (bucketForBook(next) === 'continuations') setContinuations(prev => [...prev, next]);
      else                                          setDiscoveries(prev   => [...prev, next]);
    }

    setDismissPending({ book });
  }

  function handleRecDismissUndo() {
    if (!_pendingDismissRecord) return;
    if (_pendingDismissRecord.timerId) clearTimeout(_pendingDismissRecord.timerId);
    const { book } = _pendingDismissRecord;
    _pendingDismissRecord = null;
    setDismissPending(null);
    // Remove from pending-undo set so filterActedOn no longer excludes the card
    _cancelPendingUndo(book);
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=undone', `| book_id=${book.id}`, `| external_id=${book.external_id ?? 'none'}`);
    // No re-insert needed: card was never removed from its array
  }

  function handleRecMoreLikeThis(book: ScoredBook) {
    if (!supabase || !currentUserId) return;

    // ── Optimistic UI: remove card + backfill next eligible from session ─────
    const bookFilter    = (b: ScoredBook) => b.id !== book.id;
    const filteredConts = continuations.filter(bookFilter);
    const filteredDiscs = discoveries.filter(bookFilter);
    const { conts: newConts, discs: newDiscs } = appendNextEligible(filteredConts, filteredDiscs);
    setRecommendations(prev => prev.filter(bookFilter));
    setContinuations(newConts);
    setDiscoveries(newDiscs);

    // Track so card doesn't reappear on revisit
    _trackActedOn(currentUserId, book);
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=more_like_this', 'status=committed', `| book_id=${book.id}`, `| external_id=${book.external_id ?? 'none'}`);

    // Persist feedback + update genre boost for immediate scoring effect
    persistFeedback(supabase, currentUserId, book, 'more_like_this').catch(() => {});
    const genre = getBookTraits(book).primaryGenre;
    if (genre) {
      setFeedbackCtx(prev => {
        const current = prev.genreBoosts[genre] ?? 0;
        const next    = Math.min(0.20, current === 0 ? 0.12 : current + 0.06);
        return { ...prev, genreBoosts: { ...prev.genreBoosts, [genre]: +next.toFixed(2) } };
      });
    }
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

  // ── Step: hub ─────────────────────────────────────────────────────────────

  if (step === 'hub') {
    const hasRateTasks    = booksToRate.length > 0;
    const hasTagTasks     = booksToTag.length > 0;
    const hasAnalyseTask  = (tasteProfile?.evidence.imported_books_count ?? 0) > 0 && (tasteProfile?.tier ?? 0) < 3;
    const hasAnyTask      = hasRateTasks || hasTagTasks || hasAnalyseTask;
    const hasRecs         = recommendations.length > 0 || continuations.length > 0;

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
          {/* In __DEV__ builds, long-press the title to toggle the timing overlay */}
          <TouchableOpacity
            style={{ flex: 1 }}
            activeOpacity={1}
            onLongPress={__DEV__ ? () => setShowTimingOverlay(v => !v) : undefined}
            delayLongPress={600}
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
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <Text style={{
                  fontSize: 11, fontWeight: '700', color: '#a8a29e',
                  letterSpacing: 0.9, textTransform: 'uppercase',
                }}>
                  For You
                </Text>
                {isBackgroundRefreshing && (
                  <View style={{
                    flexDirection: 'row', alignItems: 'center',
                    marginLeft: 8, paddingHorizontal: 7, paddingVertical: 2,
                    backgroundColor: '#f5f5f4', borderRadius: 10,
                  }}>
                    <ActivityIndicator size={10} color="#a8a29e" style={{ marginRight: 4 }} />
                    <Text style={{ fontSize: 11, color: '#a8a29e' }}>Refreshing</Text>
                  </View>
                )}
              </View>

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

                  {/* Guided tour step 0: action prompt — shown ABOVE cards so it's
                      visible before the first interaction, without scrolling. */}
                  {guidedStep === 0 && (recommendations.length > 0 || continuations.length > 0 || discoveries.length > 0) && (
                    <GuidedActionBanner />
                  )}

                  {/* ── Currently Reading bucket ── */}
                  {/* Only rendered when there are active continuations.        */}
                  {/* Empty state removed — "no series" is not actionable here. */}
                  {continuations.length > 0 && (
                    <>
                      {/* Green-accented section header — visually distinct from Discover Next */}
                      <View style={{
                        flexDirection: 'row', alignItems: 'center',
                        marginBottom: 10, marginTop: 6,
                        paddingLeft: 10,
                        borderLeftWidth: 3, borderLeftColor: '#15803d',
                      }}>
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', letterSpacing: -0.1 }}>
                            Currently Reading
                          </Text>
                          <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>
                            Pick up where you left off
                          </Text>
                        </View>
                      </View>

                      {continuations.map((rec, idx) => (
                        <RecCard
                          key={rec.id}
                          book={rec}
                          featured={idx === 0}
                          isExpert={recMode === 'expert'}
                          isPendingDismiss={dismissPending?.book.id === rec.id}
                          onSave={() => handleRecSave(rec)}
                          onDismiss={() => handleRecDismiss(rec)}
                          onDismissUndo={dismissPending?.book.id === rec.id ? handleRecDismissUndo : undefined}
                          onMoreLikeThis={() => handleRecMoreLikeThis(rec)}
                          onImpression={() => handleRecImpression(rec)}
                          onExplanationOpen={() => handleRecExplanationOpen(rec)}
                        />
                      ))}

                      {discoveries.length > 0 && (
                        <View style={{ height: 1, backgroundColor: '#e7e5e4', marginTop: 8, marginBottom: 20 }} />
                      )}
                    </>
                  )}

                  {/* ── Discover Next bucket ── */}
                  {discoveries.length > 0 && (
                    <>
                      {/* Neutral section header — distinct from Currently Reading green accent */}
                      <View style={{
                        flexDirection: 'row', alignItems: 'center',
                        marginBottom: 10, marginTop: continuations.length === 0 ? 0 : 2,
                        paddingLeft: 10,
                        borderLeftWidth: 3, borderLeftColor: '#d6d3d1',
                      }}>
                        <View>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', letterSpacing: -0.1 }}>
                            Discover Next
                          </Text>
                          <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>
                            Books aligned to your taste
                          </Text>
                        </View>
                      </View>

                      {discoveries.map((rec, idx) => (
                        <RecCard
                          key={rec.id}
                          book={rec}
                          featured={idx === 0 && continuations.length === 0}
                          isExpert={recMode === 'expert'}
                          isPendingDismiss={dismissPending?.book.id === rec.id}
                          onSave={() => handleRecSave(rec)}
                          onDismiss={() => handleRecDismiss(rec)}
                          onDismissUndo={dismissPending?.book.id === rec.id ? handleRecDismissUndo : undefined}
                          onMoreLikeThis={() => handleRecMoreLikeThis(rec)}
                          onImpression={() => handleRecImpression(rec)}
                          onExplanationOpen={() => handleRecExplanationOpen(rec)}
                        />
                      ))}
                    </>
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

              {/* ── Deck just emptied → brief "Refreshing" transitional hint ── */}
              {deckTransitionHint && !hasRecs && !recsLoading && (
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
                  marginBottom: 12,
                }}>
                  <ActivityIndicator size="small" color="#a8a29e" style={{ marginBottom: 10 }} />
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 4 }}>
                    Refreshing your picks…
                  </Text>
                  <Text style={{ fontSize: 12, color: '#a8a29e', textAlign: 'center' }}>
                    Noting your choices and finding what's next
                  </Text>
                </View>
              )}

              {/* ── No recs + no tasks → caught up ── */}
              {!hasRecs && !recsQualityGate && !recsLoading && !hasAnyTask && !deckTransitionHint && (
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
                  <Text style={{ fontSize: 13, color: '#a8a29e', textAlign: 'center', lineHeight: 20, marginBottom: 20 }}>
                    We'll keep learning as you finish and rate more books.
                  </Text>
                  <TouchableOpacity
                    onPress={() => router.push({ pathname: '/(tabs)/library', params: { initialFilter: 'finished' } })}
                    style={{
                      width: '100%',
                      backgroundColor: '#1c1917',
                      borderRadius: 10,
                      paddingVertical: 12,
                      alignItems: 'center',
                      marginBottom: 10,
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '600', color: '#faf9f7' }}>
                      Rate a book from your library
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => router.push({ pathname: '/(tabs)/library', params: { initialFilter: 'want_to_read' } })}
                    style={{
                      width: '100%',
                      backgroundColor: '#f5f5f4',
                      borderRadius: 10,
                      paddingVertical: 12,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '600', color: '#57534e' }}>
                      See your reading list
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

            </View>

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

      {/* ── Save-failure retry bar ─────────────────────────────────────── */}
      {/* Appears when the background DB write for a saved book fails.     */}
      {/* Auto-dismisses after 6 s; tap "Retry" to reattempt the write.   */}
      {saveFailure && (
        <View style={{
          position: 'absolute',
          bottom: 16,
          left: 16,
          right: 16,
          backgroundColor: '#1c1917',
          borderRadius: 12,
          paddingVertical: 12,
          paddingHorizontal: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          shadowColor: '#000',
          shadowOpacity: 0.15,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 5,
          zIndex: 200,
        }}>
          <Ionicons name="warning-outline" size={16} color="#f87171" />
          <Text style={{ flex: 1, color: '#faf9f7', fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
            Couldn't save "{saveFailure.title.length > 32 ? saveFailure.title.slice(0, 30) + '…' : saveFailure.title}"
          </Text>
          <TouchableOpacity
            onPress={() => handleRetrySave(saveFailure.book)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ color: '#a3e635', fontSize: 13, fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setSaveFailure(null)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close" size={16} color="#78716c" />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Dev-only performance overlay ───────────────────────────────── */}
      {/* Hidden by default — long-press the screen title to toggle       */}
      {__DEV__ && showTimingOverlay && recTiming && (
        <View style={{
          position: 'absolute',
          bottom: 16,
          left: 12,
          right: 12,
          backgroundColor: 'rgba(0,0,0,0.82)',
          borderRadius: 10,
          padding: 10,
          zIndex: 9999,
        }}>
          <Text style={{ color: '#facc15', fontWeight: '700', fontSize: 11, marginBottom: 5, letterSpacing: 0.4 }}>
            ⏱ REC_TIMING ({recTiming.ol_source})
          </Text>
          {([
            ['retrieval_local', recTiming.retrieval_local_ms],
            ['cache_check',     recTiming.cache_check_ms],
            [`ol (${recTiming.ol_source})`, recTiming.ol_ms],
            ['seeds',           recTiming.seeds_ms],
            ['enrichment',      recTiming.enrichment_ms],
            ['filter_hygiene',  recTiming.filter_hygiene_ms],
            ['total_candidate', recTiming.total_candidate_ms],
            ['TOTAL_PIPELINE',  recTiming.total_pipeline_ms],
          ] as [string, number][]).map(([label, ms]) => {
            const isSlow = ms > 400;
            const isHot  = ms > 1000;
            return (
              <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                <Text style={{ color: '#d6d3d1', fontSize: 10 }}>{label}</Text>
                <Text style={{ color: isHot ? '#f87171' : isSlow ? '#fb923c' : '#86efac', fontSize: 10, fontWeight: '600' }}>
                  {ms} ms
                </Text>
              </View>
            );
          })}
        </View>
      )}

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
