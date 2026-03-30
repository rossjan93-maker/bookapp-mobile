import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  LayoutAnimation,
  Platform,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getPersonalizedRecsWithExpert } from '../lib/recommender';
import type { ScoredBook, QualityGate } from '../lib/recommender';
import type { TasteProfile } from '../lib/tasteProfile';
import type { RecEntitlement } from '../lib/recEntitlement';
import { loadFeedbackContext, persistFeedback } from '../lib/recFeedback';
import type { FeedbackContext } from '../lib/recFeedback';
import {
  emptyIntent as emptyNextReadIntent,
  isIntentActive,
  intentSummaryLabel,
  parseNaturalLanguageIntent,
  mergeIntents,
} from '../lib/nextReadIntent';
import type { NextReadIntent, NextReadPace, NextReadTone } from '../lib/nextReadIntent';
import { getBookTraits } from '../lib/bookTraits';
import type { DeterministicLane } from '../lib/bookTraits';
import type { ReaderThesis } from '../lib/expertRec';
import { type RecSessionCache, getRecSession, setRecSession } from '../lib/recSession';
import { addActedOnIds, loadActedOnIds } from '../lib/recPayloadCache';
import { GuidedActionBanner } from './OnboardingWalkthrough';

import { RecCard, UndoToast, RecSkeletonCard } from './RecCard';
import {
  VISIBLE_STACK_SIZE,
  REPLENISH_WATERMARK,
  DISMISS_UNDO_MS,
  type QueueBucket,
  type QueueEntry,
  type PendingDismissRecord,
  initForUser,
  clearAll,
  isEligible,
  initQueue,
  appendToQueue,
  removeFromQueue,
  prependToQueue,
  trackActedOnPending,
  commitActedOn,
  cancelPendingUndo,
  trackActedOn,
  getPendingDismiss,
  setPendingDismiss,
  getQueueDepth,
  getVisibleStack,
} from '../lib/recQueue';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Session freshness threshold — pipeline skipped on tab revisit when below this age
const REC_SESSION_TTL_MS = 4 * 60 * 1000; // 4 minutes

// ── Intent panel lane options ──────────────────────────────────────────────────
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

// ── Intent Panel ──────────────────────────────────────────────────────────────

type NextReadPanelProps = {
  draft:        NextReadIntent;
  setDraft:     (intent: NextReadIntent) => void;
  nlInput:      string;
  setNlInput:   (s: string) => void;
  open:         boolean;
  panelHeight:  Animated.Value;
  onToggle:     () => void;
  onApply:      (mergedIntent: NextReadIntent) => void;
  onClear:      () => void;
  activeIntent: NextReadIntent;
};

function NextReadPanel({
  draft, setDraft, nlInput, setNlInput,
  open, panelHeight, onToggle, onApply, onClear, activeIntent,
}: NextReadPanelProps) {
  const isActive = isIntentActive(activeIntent);
  const nlParsed = nlInput.trim() ? parseNaturalLanguageIntent(nlInput) : null;
  const hasNLMatch = nlParsed?.interpreted ?? false;

  function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
    return (
      <TouchableOpacity
        onPress={onPress}
        style={{
          backgroundColor: active ? '#1c1917' : '#f5f5f4',
          borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6,
          borderWidth: 1, borderColor: active ? '#1c1917' : '#e7e5e4',
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: active ? '600' : '400', color: active ? '#faf9f7' : '#57534e' }}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  }

  function PillRow({ children }: { children: React.ReactNode }) {
    return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{children}</View>;
  }

  function PanelSectionLabel({ children }: { children: string }) {
    return (
      <Text style={{ fontSize: 10, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 7 }}>
        {children}
      </Text>
    );
  }

  function toggleLane(lane: DeterministicLane) {
    const current = draft.hard.lanes ?? [];
    const next = current.includes(lane) ? current.filter(l => l !== lane) : [...current, lane];
    setDraft({ ...draft, hard: { ...draft.hard, lanes: next.length ? next : undefined } });
  }

  function isLaneActive(lane: DeterministicLane) { return (draft.hard.lanes ?? []).includes(lane); }
  function setPace(pace: NextReadPace) { setDraft({ ...draft, soft: { ...draft.soft, pace: draft.soft.pace === pace ? null : pace } }); }
  function setTone(tone: NextReadTone) { setDraft({ ...draft, soft: { ...draft.soft, tone: draft.soft.tone === tone ? null : tone } }); }
  function setIntensity(level: 'high' | 'low') { setDraft({ ...draft, soft: { ...draft.soft, intensity: draft.soft.intensity === level ? null : level } }); }
  function toggleStandalone() { setDraft({ ...draft, hard: { ...draft.hard, standalone_only: !draft.hard.standalone_only } }); }
  function toggleShort() { const c = draft.hard.max_page_count; setDraft({ ...draft, hard: { ...draft.hard, max_page_count: c ? null : 350 } }); }
  function toggleExclude(key: keyof NextReadIntent['exclude']) { setDraft({ ...draft, exclude: { ...draft.exclude, [key]: !draft.exclude[key] } }); }
  function handleApply() { const nlIntent = nlParsed?.intent ?? emptyNextReadIntent(); onApply(mergeIntents(draft, nlIntent)); }

  const summaryText = isActive ? intentSummaryLabel(activeIntent) : null;

  return (
    <View style={{ marginBottom: 10 }}>
      <TouchableOpacity
        onPress={onToggle}
        style={{
          flexDirection: 'row', alignItems: 'center',
          paddingVertical: 9, paddingHorizontal: 13,
          backgroundColor: isActive ? '#f5f0e8' : '#f5f5f4',
          borderRadius: 9, borderWidth: 1,
          borderColor: isActive ? '#d6c9b0' : '#e7e5e4',
        }}
      >
        <Text style={{ fontSize: 12, color: '#78716c', flex: 1, lineHeight: 17 }}>
          {open ? '▲' : '▼'}{'  '}
          {isActive && summaryText ? summaryText : 'Tell us what sounds good'}
        </Text>
        {isActive && (
          <View style={{ backgroundColor: '#1c1917', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
            <Text style={{ fontSize: 9, fontWeight: '700', color: '#faf9f7', letterSpacing: 0.4 }}>FILTERED</Text>
          </View>
        )}
      </TouchableOpacity>

      <Animated.View style={{ maxHeight: panelHeight.interpolate({ inputRange: [0, 1], outputRange: [0, 720] }), overflow: 'hidden' }}>
        <View style={{
          backgroundColor: '#faf9f7', borderRadius: 10, padding: 14, marginTop: 4,
          borderWidth: 1, borderColor: '#e7e5e4', gap: 14,
        }}>
          {/* Natural language input */}
          <View>
            <PanelSectionLabel>Describe what you want</PanelSectionLabel>
            <TextInput
              value={nlInput}
              onChangeText={setNlInput}
              placeholder={'e.g. "Fast-paced thriller, standalone, not too dark"'}
              placeholderTextColor="#c4bdb7"
              multiline
              numberOfLines={2}
              style={{
                backgroundColor: '#fff', borderRadius: 9,
                paddingHorizontal: 11, paddingVertical: 9,
                fontSize: 13, color: '#1c1917', lineHeight: 19,
                borderWidth: 1, borderColor: '#e7e5e4',
                minHeight: 52, textAlignVertical: 'top',
              }}
            />
            {hasNLMatch && nlParsed && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6, paddingHorizontal: 2 }}>
                <Text style={{ fontSize: 10, color: '#a8a29e', alignSelf: 'center', marginRight: 2 }}>Using:</Text>
                {nlParsed.labels.map(label => (
                  <View key={label} style={{ backgroundColor: '#f0ede8', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ fontSize: 10, color: '#57534e', fontWeight: '500' }}>{label}</Text>
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

          {/* Genre / Lane */}
          <View>
            <PanelSectionLabel>What are you in the mood for?</PanelSectionLabel>
            <PillRow>
              {LANE_OPTIONS.map(({ lane, label }, idx) => (
                <Pill key={`${lane}-${idx}`} label={label} active={isLaneActive(lane)} onPress={() => toggleLane(lane)} />
              ))}
            </PillRow>
          </View>

          {/* Pace */}
          <View>
            <PanelSectionLabel>Pace</PanelSectionLabel>
            <PillRow>
              <Pill label="Page-turner" active={draft.soft.pace === 'fast'} onPress={() => setPace('fast')} />
              <Pill label="Steady build" active={draft.soft.pace === 'moderate'} onPress={() => setPace('moderate')} />
              <Pill label="Slow & immersive" active={draft.soft.pace === 'slow'} onPress={() => setPace('slow')} />
            </PillRow>
          </View>

          {/* Tone */}
          <View>
            <PanelSectionLabel>Tone</PanelSectionLabel>
            <PillRow>
              <Pill label="Light / fun" active={draft.soft.tone === 'light'} onPress={() => setTone('light')} />
              <Pill label="Balanced" active={draft.soft.tone === 'balanced'} onPress={() => setTone('balanced')} />
              <Pill label="Dark / gritty" active={draft.soft.tone === 'dark'} onPress={() => setTone('dark')} />
            </PillRow>
          </View>

          {/* Emotional intensity */}
          <View>
            <PanelSectionLabel>Emotional intensity</PanelSectionLabel>
            <PillRow>
              <Pill label="High stakes" active={draft.soft.intensity === 'high'} onPress={() => setIntensity('high')} />
              <Pill label="Low key" active={draft.soft.intensity === 'low'} onPress={() => setIntensity('low')} />
            </PillRow>
          </View>

          {/* Format */}
          <View>
            <PanelSectionLabel>Format</PanelSectionLabel>
            <PillRow>
              <Pill label="Standalone only" active={!!draft.hard.standalone_only} onPress={toggleStandalone} />
              <Pill label="Short read (≤350 pages)" active={!!draft.hard.max_page_count} onPress={toggleShort} />
            </PillRow>
          </View>

          {/* Exclude */}
          <View>
            <PanelSectionLabel>Exclude</PanelSectionLabel>
            <PillRow>
              <Pill label="Series books" active={!!draft.exclude.series} onPress={() => toggleExclude('series')} />
              <Pill label="Books I've seen before" active={!!draft.exclude.seen} onPress={() => toggleExclude('seen')} />
            </PillRow>
          </View>

          {/* Actions */}
          <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
            <TouchableOpacity
              onPress={handleApply}
              style={{ flex: 1, backgroundColor: '#1c1917', borderRadius: 9, paddingVertical: 11, alignItems: 'center' }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#faf9f7' }}>Apply</Text>
            </TouchableOpacity>
            {isActive && (
              <TouchableOpacity
                onPress={onClear}
                style={{ paddingHorizontal: 16, backgroundColor: '#f5f5f4', borderRadius: 9, paddingVertical: 11, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 13, fontWeight: '500', color: '#57534e' }}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

// ── RecommendationsFeed ───────────────────────────────────────────────────────

export type RecommendationsFeedProps = {
  userId:          string | null;
  supabase:        SupabaseClient | null;
  tasteProfile:    TasteProfile | null;
  entitlement:     RecEntitlement | null;
  feedbackCtx:     FeedbackContext;
  setFeedbackCtx:  React.Dispatch<React.SetStateAction<FeedbackContext>>;
  guidedStep:      number;
  onGuidedAdvance: () => void;
};

export function RecommendationsFeed({
  userId,
  supabase,
  tasteProfile,
  entitlement,
  feedbackCtx,
  setFeedbackCtx,
  guidedStep,
  onGuidedAdvance: _onGuidedAdvance,
}: RecommendationsFeedProps) {

  // ── Queue-synced React state ───────────────────────────────────────────────
  // The authoritative queue lives in lib/recQueue (module-level).
  // These two arrays are React state derived from the queue's visible head.
  const [visibleConts, setVisibleConts] = useState<ScoredBook[]>(() => {
    if (!userId) return [];
    const s = getRecSession();
    if (!s || s.userId !== userId) return [];
    return s.continuations.filter(b => isEligible(b)).slice(0, VISIBLE_STACK_SIZE);
  });
  const [visibleDiscs, setVisibleDiscs] = useState<ScoredBook[]>(() => {
    if (!userId) return [];
    const s = getRecSession();
    if (!s || s.userId !== userId) return [];
    const conts = s.continuations.filter(b => isEligible(b));
    const remaining = VISIBLE_STACK_SIZE - Math.min(conts.length, VISIBLE_STACK_SIZE);
    return s.discoveries.filter(b => isEligible(b)).slice(0, remaining);
  });

  // ── Pipeline loading state ─────────────────────────────────────────────────
  const [isInitialLoading, setIsInitialLoading] = useState(() => {
    const s = getRecSession();
    return !s || s.userId !== userId;
  });
  const [isReplenishing, setIsReplenishing]     = useState(false);
  const [recsQualityGate, setRecsQualityGate]   = useState<QualityGate | null>(null);
  const [isExhausted, setIsExhausted]           = useState(false);
  const [deckTransitionHint, setDeckTransitionHint] = useState(false);
  const hadDeckRef = useRef(false);

  // ── Pipeline metadata ──────────────────────────────────────────────────────
  const [recMode, setRecMode]             = useState<'deterministic' | 'expert' | null>(null);
  const [readerThesis, setReaderThesis]   = useState<ReaderThesis | null>(null);
  const [isFreePreview, setIsFreePreview] = useState(false);
  const [thesisOpen, setThesisOpen]       = useState(false);
  const thesisHeight = useRef(new Animated.Value(0)).current;

  // ── Dismiss/undo ──────────────────────────────────────────────────────────
  const [dismissPending, setDismissPendingUI] = useState<{ book: ScoredBook } | null>(null);
  const [saveFailure, setSaveFailure]          = useState<{ book: ScoredBook } | null>(null);

  // ── Intent panel ──────────────────────────────────────────────────────────
  const [nextReadIntent, setNextReadIntent]   = useState<NextReadIntent>(emptyNextReadIntent());
  const [draftIntent, setDraftIntent]         = useState<NextReadIntent>(emptyNextReadIntent());
  const [nlInput, setNlInput]                 = useState('');
  const [intentPanelOpen, setIntentPanelOpen] = useState(false);
  const intentPanelHeight = useRef(new Animated.Value(0)).current;

  // ── Pipeline guards ───────────────────────────────────────────────────────
  const latestPipelineRef    = useRef(0);
  const exhaustionAttemptRef = useRef(0);
  const isReplenishingRef    = useRef(false); // synchronous guard between renders

  // ── syncVisible: derive React state from module-level queue ───────────────
  function syncVisible() {
    const visible = getVisibleStack();
    setVisibleConts(visible.filter(e => e.bucket === 'continuations').map(e => e.book));
    setVisibleDiscs(visible.filter(e => e.bucket === 'discoveries').map(e => e.book));
  }

  // ── Bootstrap: initialize queue from user's acted-on ids on mount ─────────
  useEffect(() => {
    if (!userId) return;
    loadActedOnIds(userId).then(ids => {
      initForUser(userId, ids);
      // Re-seed queue from session if queue is currently empty
      const s = getRecSession();
      if (s && s.userId === userId && getQueueDepth() === 0) {
        const entries: QueueEntry[] = [
          ...s.continuations.map(b => ({ book: b, bucket: 'continuations' as QueueBucket })),
          ...s.discoveries.map(b => ({ book: b, bucket: 'discoveries' as QueueBucket })),
        ];
        initQueue(entries);
        syncVisible();
      }
      if (s?.recMode)      setRecMode(s.recMode);
      if (s?.readerThesis) setReaderThesis(s.readerThesis);
      if (s?.qualityGate)  setRecsQualityGate(s.qualityGate);
      setIsFreePreview(s?.isFreePreview ?? false);
    }).catch(() => {
      initForUser(userId, []);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ── Pipeline trigger: fires when profile or entitlement changes ───────────
  useEffect(() => {
    if (!tasteProfile || tasteProfile.tier < 1 || !userId || !supabase) return;

    const s             = getRecSession();
    const sessionAge    = s ? Date.now() - s.loadedAt : Infinity;
    const signalSame    = !!s && s.signalCount === (tasteProfile.strongSignalCount ?? 0);
    const sessionFresh  = sessionAge < REC_SESSION_TTL_MS;
    const isBgRefresh   = !!s && getQueueDepth() > 0;

    if (s && sessionFresh && signalSame && getQueueDepth() > 0) {
      if (__DEV__) console.log('[REC_REFRESH]', 'reason=session_fresh', 'visible_disruption=false');
      setIsInitialLoading(false);
      return;
    }

    if (__DEV__) console.log('[REC_REFRESH]',
      `reason=${!s ? 'cold_start' : (!signalSame ? 'signal_change' : 'stale_session')}`,
      `| visible_disruption=${!isBgRefresh}`,
    );

    if (isBgRefresh) setIsReplenishing(true);
    else             setIsInitialLoading(true);

    runPipeline(nextReadIntent, { isBgRefresh });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasteProfile?.strongSignalCount, userId, entitlement?.expert_recs_enabled]);

  // ── Tab revisit: restore pending dismiss toast ────────────────────────────
  useFocusEffect(useCallback(() => {
    const rec = getPendingDismiss();
    if (!rec) return;
    const remaining = rec.expiresAt - Date.now();
    if (remaining <= 0) {
      if (userId) commitActedOn(userId, rec.book);
      setPendingDismiss(null);
      setDismissPendingUI(null);
      syncVisible();
      return;
    }
    setDismissPendingUI({ book: rec.book });
    if (rec.timerId) clearTimeout(rec.timerId);
    const _sb  = supabase!;
    const _uid = userId!;
    const newTimerId = setTimeout(() => {
      const cur = getPendingDismiss();
      if (!cur || cur.book.id !== rec.book.id) return;
      setPendingDismiss(null);
      setDismissPendingUI(null);
      commitActedOn(_uid, cur.book);
      setFeedbackCtx(fc => {
        const next = new Set(fc.dismissedIds);
        if (cur.book.external_id) next.add(cur.book.external_id);
        if (cur.book._source === 'catalog') next.add(cur.book.id);
        return { ...fc, dismissedIds: next };
      });
      persistFeedback(_sb, _uid, cur.book, 'dismissed').catch(() => {});
    }, remaining);
    setPendingDismiss({ ...rec, timerId: newTimerId });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]));

  // ── Deck-empty transitional hint ──────────────────────────────────────────
  useEffect(() => {
    const deckEmpty = visibleConts.length === 0 && visibleDiscs.length === 0;
    if (!deckEmpty) { hadDeckRef.current = true; return; }
    if (hadDeckRef.current && !isInitialLoading) {
      setDeckTransitionHint(true);
      const t = setTimeout(() => setDeckTransitionHint(false), 2500);
      return () => clearTimeout(t);
    }
  }, [visibleConts.length, visibleDiscs.length, isInitialLoading]);

  // ── Exhaustion-triggered replenishment ────────────────────────────────────
  useEffect(() => {
    if (!isExhausted || isReplenishing || isInitialLoading) return;
    if (!userId || !tasteProfile || tasteProfile.tier < 1) return;
    if (exhaustionAttemptRef.current >= 1) {
      if (__DEV__) console.log('[REC_EXHAUSTED_TERMINAL]',
        'reason=all_acted_on_after_reload',
        `| attempt=${exhaustionAttemptRef.current}`,
      );
      return;
    }
    exhaustionAttemptRef.current += 1;
    if (__DEV__) console.log('[REC_EXHAUSTED_RELOAD]', `attempt=${exhaustionAttemptRef.current}`, '| exhaustion_bypass=true');
    setIsReplenishing(true);
    runPipeline(nextReadIntent, { isBgRefresh: true, exhaustionBypass: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExhausted, tasteProfile?.tier, isReplenishing]);

  // ── Pipeline runner ───────────────────────────────────────────────────────
  async function runPipeline(
    intent: NextReadIntent,
    opts?: { isBgRefresh?: boolean; exhaustionBypass?: boolean },
  ) {
    if (!supabase || !userId || !tasteProfile || tasteProfile.tier < 1) return;

    const requestId = ++latestPipelineRef.current;
    const activeEnt = entitlement ?? {
      plan: 'free' as const,
      expert_recs_enabled: false,
      expert_refreshes_remaining_this_period: 0,
      has_used_free_import_analysis: false,
    };

    try {
      const recResult = await getPersonalizedRecsWithExpert(
        supabase, userId, tasteProfile, activeEnt, 12,
        feedbackCtx, intent,
        opts?.exhaustionBypass ? { exhaustionBypass: true, clearOLCache: true } : undefined,
      );

      if (requestId !== latestPipelineRef.current) return;

      const { recs, meta } = recResult;
      const continuationsRaw = (recResult as any).continuations ?? [];
      const discoveriesRaw   = (recResult as any).discoveries   ?? recs;

      setRecMode(meta.mode ?? 'deterministic');
      setReaderThesis(meta.reader_thesis ?? null);
      setIsFreePreview((meta as any).expert_decision?.is_free_preview ?? false);

      const gate = meta.quality_gate !== 'passed' ? (meta.quality_gate as QualityGate) : null;
      setRecsQualityGate(gate ?? null);

      if (!gate) {
        const newEntries: QueueEntry[] = [
          ...continuationsRaw.map((b: ScoredBook) => ({ book: b, bucket: 'continuations' as QueueBucket })),
          ...discoveriesRaw.map((b: ScoredBook) => ({ book: b, bucket: 'discoveries' as QueueBucket })),
        ];

        if (opts?.isBgRefresh || opts?.exhaustionBypass) {
          const appended = appendToQueue(newEntries);
          if (__DEV__) console.log('[REC_REFRESH]',
            `reason=${opts.exhaustionBypass ? 'exhaustion_bypass' : 'background_refresh'}`,
            `| visible_disruption=false`,
            `| appended=${appended}`,
            `| queue_depth=${getQueueDepth()}`,
          );
        } else {
          if (getQueueDepth() === 0) initQueue(newEntries);
          else appendToQueue(newEntries);
        }

        const totalFiltered = getQueueDepth();
        if (totalFiltered === 0 && newEntries.length > 0) {
          setIsExhausted(true);
        } else if (totalFiltered > 0) {
          setIsExhausted(false);
          exhaustionAttemptRef.current = 0;
        }

        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        syncVisible();

        const newSession: RecSessionCache = {
          userId,
          recs,
          continuations: continuationsRaw,
          discoveries:   discoveriesRaw,
          meta,
          recMode:       meta.mode ?? 'deterministic',
          readerThesis:  meta.reader_thesis ?? null,
          qualityGate:   gate ?? null,
          isFreePreview: (meta as any).expert_decision?.is_free_preview ?? false,
          signalCount:   tasteProfile.strongSignalCount ?? 0,
          loadedAt:      Date.now(),
        };
        setRecSession(newSession);
      } else {
        if (__DEV__) console.log('[REC_REFRESH]', `quality_gate=${gate}`, 'commit=skipped');
      }
    } catch (e) {
      if (__DEV__) console.warn('[REC_PIPELINE_ERROR]', e);
    } finally {
      if (requestId === latestPipelineRef.current) {
        setIsInitialLoading(false);
        setIsReplenishing(false);
        isReplenishingRef.current = false;
      }
    }
  }

  // ── Replenishment check ───────────────────────────────────────────────────
  function replenishIfNeeded() {
    if (isReplenishingRef.current || isReplenishing || isInitialLoading) return;
    if (!tasteProfile || tasteProfile.tier < 1 || !userId || !supabase) return;
    const depth = getQueueDepth();
    if (depth < REPLENISH_WATERMARK) {
      if (__DEV__) console.log('[REC_REFRESH]', 'reason=watermark', `| queue_depth=${depth}`, '| visible_disruption=false');
      isReplenishingRef.current = true;
      setIsReplenishing(true);
      runPipeline(nextReadIntent, { isBgRefresh: true });
    }
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  function handleSave(book: ScoredBook) {
    if (!supabase || !userId) return;
    removeFromQueue(book.id);
    trackActedOn(userId, book);
    replenishIfNeeded();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    syncVisible();

    setFeedbackCtx(prev => {
      const next = new Set(prev.savedIds);
      if (book.external_id) next.add(book.external_id);
      if (book._source === 'catalog') next.add(book.id);
      return { ...prev, savedIds: next };
    });

    const _sb  = supabase!;
    const _uid = userId!;
    (async () => {
      let bookDbId: string | null = null;
      try {
        if (book._source === 'catalog') {
          bookDbId = book.id;
        } else if (book.external_id) {
          const { data: existing } = await _sb.from('books').select('id').eq('external_id', book.external_id).maybeSingle();
          if (existing) {
            bookDbId = existing.id;
          } else {
            const { data: created } = await _sb.from('books').insert({
              title:       book.title,
              author:      book.author,
              external_id: book.external_id,
              cover_url:   book.cover_url,
              subjects:    book.subjects,
              page_count:  book.page_count,
            }).select('id').single();
            bookDbId = created?.id ?? null;
          }
        }
        if (bookDbId) {
          const { error } = await _sb.from('user_books').upsert(
            { user_id: _uid, book_id: bookDbId, status: 'want_to_read' },
            { onConflict: 'user_id,book_id', ignoreDuplicates: true },
          );
          if (error) throw error;
        }
        persistFeedback(_sb, _uid, book, 'saved', { book_db_id: bookDbId ?? undefined }).catch(() => {});
      } catch {
        setSaveFailure({ book });
        setTimeout(() => setSaveFailure(f => f?.book.id === book.id ? null : f), 6000);
      }
    })();
  }

  function handleDismiss(book: ScoredBook) {
    if (!supabase || !userId) return;

    // Commit any existing pending dismiss immediately (only one undo at a time)
    const prev = getPendingDismiss();
    if (prev) {
      if (prev.timerId) clearTimeout(prev.timerId);
      commitActedOn(userId, prev.book);
      setPendingDismiss(null);
      setDismissPendingUI(null);
      setFeedbackCtx(fc => {
        const next = new Set(fc.dismissedIds);
        if (prev.book.external_id) next.add(prev.book.external_id);
        if (prev.book._source === 'catalog') next.add(prev.book.id);
        return { ...fc, dismissedIds: next };
      });
      persistFeedback(supabase, userId, prev.book, 'dismissed').catch(() => {});
    }

    const bucket: QueueBucket = visibleConts.some(b => b.id === book.id) ? 'continuations' : 'discoveries';
    trackActedOnPending(book);
    removeFromQueue(book.id);
    replenishIfNeeded();

    const _sb  = supabase!;
    const _uid = userId!;
    const expiresAt = Date.now() + DISMISS_UNDO_MS;
    const timerId = setTimeout(() => {
      const cur = getPendingDismiss();
      if (!cur || cur.book.id !== book.id) return;
      setPendingDismiss(null);
      setDismissPendingUI(null);
      commitActedOn(_uid, book);
      setFeedbackCtx(fc => {
        const next = new Set(fc.dismissedIds);
        if (book.external_id) next.add(book.external_id);
        if (book._source === 'catalog') next.add(book.id);
        return { ...fc, dismissedIds: next };
      });
      persistFeedback(_sb, _uid, book, 'dismissed').catch(() => {});
    }, DISMISS_UNDO_MS);

    const rec: PendingDismissRecord = { book, bucket, expiresAt, timerId };
    setPendingDismiss(rec);
    setDismissPendingUI({ book });

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    syncVisible();

    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=pending_undo', `| book_id=${book.id}`);
  }

  function handleDismissUndo() {
    const rec = getPendingDismiss();
    if (!rec) return;
    if (rec.timerId) clearTimeout(rec.timerId);
    cancelPendingUndo(rec.book);
    setPendingDismiss(null);
    setDismissPendingUI(null);
    prependToQueue({ book: rec.book, bucket: rec.bucket });
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    syncVisible();
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=undone', `| book_id=${rec.book.id}`);
  }

  function handleMoreLikeThis(book: ScoredBook) {
    if (!supabase || !userId) return;
    removeFromQueue(book.id);
    trackActedOn(userId, book);
    replenishIfNeeded();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    syncVisible();
    persistFeedback(supabase, userId, book, 'more_like_this').catch(() => {});
    const genre = getBookTraits(book).primaryGenre;
    if (genre) {
      setFeedbackCtx(prev => {
        const current = prev.genreBoosts[genre] ?? 0;
        const next    = Math.min(0.20, current === 0 ? 0.12 : current + 0.06);
        return { ...prev, genreBoosts: { ...prev.genreBoosts, [genre]: +next.toFixed(2) } };
      });
    }
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=more_like_this', `| book_id=${book.id}`);
  }

  function handleImpression(book: ScoredBook) {
    if (!supabase || !userId) return;
    persistFeedback(supabase, userId, book, 'impression').catch(() => {});
  }

  function handleExplanationOpen(book: ScoredBook) {
    if (!supabase || !userId) return;
    persistFeedback(supabase, userId, book, 'explanation_opened').catch(() => {});
  }

  // ── Intent apply / clear ──────────────────────────────────────────────────
  function handleApplyIntent(merged: NextReadIntent) {
    setNextReadIntent(merged);
    setIntentPanelOpen(false);
    Animated.timing(intentPanelHeight, { toValue: 0, duration: 180, useNativeDriver: false }).start();
    setRecsQualityGate(null);
    const hasCards = getQueueDepth() > 0;
    if (hasCards) setIsReplenishing(true);
    else          setIsInitialLoading(true);
    runPipeline(merged, { isBgRefresh: hasCards });
  }

  function handleClearIntent() {
    const empty = emptyNextReadIntent();
    setNextReadIntent(empty);
    setDraftIntent(empty);
    setNlInput('');
    setIntentPanelOpen(false);
    Animated.timing(intentPanelHeight, { toValue: 0, duration: 180, useNativeDriver: false }).start();
    const hasCards = getQueueDepth() > 0;
    if (hasCards) setIsReplenishing(true);
    else          setIsInitialLoading(true);
    runPipeline(empty, { isBgRefresh: hasCards });
  }

  function toggleIntentPanel() {
    const next = !intentPanelOpen;
    setIntentPanelOpen(next);
    Animated.timing(intentPanelHeight, { toValue: next ? 1 : 0, duration: 220, useNativeDriver: false }).start();
    if (!next) setDraftIntent(nextReadIntent);
  }

  // ── Display state machine ─────────────────────────────────────────────────
  const hasCards = visibleConts.length > 0 || visibleDiscs.length > 0;

  type DisplayState =
    | 'loading_initial'
    | 'ready'
    | 'ready_refreshing'
    | 'quality_gated'
    | 'exhausted_refreshing'
    | 'exhausted_terminal'
    | 'transitioning'
    | 'empty';

  const displayState: DisplayState = (() => {
    if (isInitialLoading && !hasCards) return 'loading_initial';
    if (hasCards)                      return isReplenishing ? 'ready_refreshing' : 'ready';
    if (deckTransitionHint)            return 'transitioning';
    if (recsQualityGate)               return 'quality_gated';
    if (isExhausted)                   return isReplenishing ? 'exhausted_refreshing' : 'exhausted_terminal';
    return 'empty';
  })();

  // ── Render ────────────────────────────────────────────────────────────────

  // Tier check — if profile not loaded or below tier 1, show minimal state
  const tier = tasteProfile?.tier ?? 0;

  if (!userId) return null;
  if (tier < 1 && !isInitialLoading) {
    return (
      <View style={{ marginBottom: 36 }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 12 }}>
          For You
        </Text>
        <View style={{
          backgroundColor: '#fff', borderRadius: 14, padding: 20, alignItems: 'center',
          shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1,
        }}>
          <Text style={{ fontSize: 22, marginBottom: 12 }}>✦</Text>
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
            Rate a few books to unlock picks
          </Text>
          <Text style={{ fontSize: 13, color: '#a8a29e', textAlign: 'center', lineHeight: 20 }}>
            We need a bit more signal before we can personalise your recommendations.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ marginBottom: 36 }}>
      {/* Section header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.9, textTransform: 'uppercase' }}>
          For You
        </Text>
        {displayState === 'ready_refreshing' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: '#f5f5f4', borderRadius: 10 }}>
            <ActivityIndicator size={10} color="#a8a29e" style={{ marginRight: 4 }} />
            <Text style={{ fontSize: 11, color: '#a8a29e' }}>Refreshing</Text>
          </View>
        )}
      </View>

      {/* ── Loading skeleton (initial, no cached cards) ── */}
      {displayState === 'loading_initial' && (
        <View style={{ marginBottom: 20 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 10 }}>
            Building your picks…
          </Text>
          <RecSkeletonCard />
          <RecSkeletonCard />
          <RecSkeletonCard />
        </View>
      )}

      {/* ── Ready state: cards + intent panel + thesis ── */}
      {(displayState === 'ready' || displayState === 'ready_refreshing') && (
        <View style={{ marginBottom: 20 }}>

          {/* Picked for you header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1 }}>Picked for you</Text>
            {recMode === 'expert' ? (
              <View style={{ backgroundColor: '#1c1917', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: '#faf9f7', letterSpacing: 0.5 }}>EXPERT</Text>
              </View>
            ) : (
              <Text style={{ fontSize: 11, color: '#a8a29e' }}>{tasteProfile?.label ?? ''}</Text>
            )}
          </View>

          {/* Free preview moment */}
          {isFreePreview && (
            <View style={{ backgroundColor: '#f0fdf4', borderRadius: 10, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#bbf7d0' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#15803d', marginBottom: 4 }}>
                Your deep taste analysis is ready
              </Text>
              <Text style={{ fontSize: 12, color: '#166534', lineHeight: 18 }}>
                We've analysed your reading history and built a personalised reader profile. These picks are selected against your specific taste lanes, not just broad genre preferences.
              </Text>
            </View>
          )}

          {/* Expert reader thesis (collapsible) */}
          {recMode === 'expert' && readerThesis && (
            <View style={{ marginBottom: 10 }}>
              <TouchableOpacity
                onPress={() => {
                  const next = !thesisOpen;
                  setThesisOpen(next);
                  Animated.timing(thesisHeight, { toValue: next ? 1 : 0, duration: 220, useNativeDriver: false }).start();
                }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f5f5f4', borderRadius: 8 }}
              >
                <Text style={{ fontSize: 11, color: '#57534e', flex: 1 }}>
                  {thesisOpen ? '▲' : '▼'}  Your reader profile
                </Text>
                <Text style={{ fontSize: 10, color: '#a8a29e' }}>
                  {readerThesis.dominant_lanes.length} lane{readerThesis.dominant_lanes.length !== 1 ? 's' : ''}
                </Text>
              </TouchableOpacity>
              <Animated.View style={{ maxHeight: thesisHeight.interpolate({ inputRange: [0, 1], outputRange: [0, 320] }), overflow: 'hidden' }}>
                <View style={{ backgroundColor: '#faf9f7', borderRadius: 10, padding: 12, marginTop: 4, borderWidth: 1, borderColor: '#e7e5e4' }}>
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

          {/* Guided tour step 0 */}
          {guidedStep === 0 && hasCards && <GuidedActionBanner />}

          {/* ── Intent panel ── */}
          <NextReadPanel
            draft={draftIntent}
            setDraft={setDraftIntent}
            nlInput={nlInput}
            setNlInput={setNlInput}
            open={intentPanelOpen}
            panelHeight={intentPanelHeight}
            onToggle={toggleIntentPanel}
            onApply={handleApplyIntent}
            onClear={handleClearIntent}
            activeIntent={nextReadIntent}
          />

          {/* ── Currently Reading bucket ── */}
          {visibleConts.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, marginTop: 6, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: '#15803d' }}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', letterSpacing: -0.1 }}>Currently Reading</Text>
                  <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>Pick up where you left off</Text>
                </View>
              </View>
              {visibleConts.map((rec, idx) => (
                <RecCard
                  key={rec.id}
                  book={rec}
                  featured={idx === 0}
                  isExpert={recMode === 'expert'}
                  onSave={() => handleSave(rec)}
                  onDismiss={() => handleDismiss(rec)}
                  onMoreLikeThis={() => handleMoreLikeThis(rec)}
                  onImpression={() => handleImpression(rec)}
                  onExplanationOpen={() => handleExplanationOpen(rec)}
                />
              ))}
              {visibleDiscs.length > 0 && <View style={{ height: 6 }} />}
            </>
          )}

          {/* ── Discover Next bucket ── */}
          {visibleDiscs.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, marginTop: visibleConts.length === 0 ? 0 : 2, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: '#d6d3d1' }}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', letterSpacing: -0.1 }}>Discover Next</Text>
                  <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>Books aligned to your taste</Text>
                </View>
              </View>
              {visibleDiscs.map((rec, idx) => (
                <RecCard
                  key={rec.id}
                  book={rec}
                  featured={idx === 0 && visibleConts.length === 0}
                  isExpert={recMode === 'expert'}
                  onSave={() => handleSave(rec)}
                  onDismiss={() => handleDismiss(rec)}
                  onMoreLikeThis={() => handleMoreLikeThis(rec)}
                  onImpression={() => handleImpression(rec)}
                  onExplanationOpen={() => handleExplanationOpen(rec)}
                />
              ))}
            </>
          )}

          {/* Undo toast */}
          {dismissPending && (
            <UndoToast book={dismissPending.book} onUndo={handleDismissUndo} />
          )}

          {/* Save failure toast */}
          {saveFailure && (
            <View style={{ backgroundColor: '#fef2f2', borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#fecaca' }}>
              <Text style={{ fontSize: 13, color: '#dc2626', fontWeight: '600' }}>
                Couldn't save "{saveFailure.book.title}"
              </Text>
              <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 3 }}>
                Check your connection and try again.
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ── Quality gate: not enough signal or intent too narrow ── */}
      {displayState === 'quality_gated' && tier >= 1 && (
        <View style={{
          backgroundColor: recsQualityGate === 'intent_filtered_empty' ? '#faf9f7' : '#fff',
          borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#e7e5e4',
        }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
            {recsQualityGate === 'intent_filtered_empty'
              ? 'No matches with these filters'
              : recsQualityGate === 'insufficient_pool'
                ? 'Not enough books in your genres yet'
                : 'No close matches in the current catalog'}
          </Text>
          <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
            {recsQualityGate === 'intent_filtered_empty'
              ? 'Your current filters are too narrow for the available pool. Try relaxing a filter or clearing them to see your regular picks.'
              : recsQualityGate === 'insufficient_pool'
                ? 'Rate a few more books in your favourite genres. Each rating sharpens the pool significantly.'
                : 'Your taste profile is strong but the catalog coverage is limited right now. Try removing some filters.'}
          </Text>
          {recsQualityGate === 'intent_filtered_empty' && isIntentActive(nextReadIntent) && (
            <TouchableOpacity
              onPress={handleClearIntent}
              style={{ marginTop: 12, backgroundColor: '#1c1917', borderRadius: 9, paddingVertical: 10, alignItems: 'center' }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#faf9f7' }}>Clear filters</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Transitional hint: deck just emptied, refreshing ── */}
      {displayState === 'transitioning' && (
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 24, alignItems: 'center', marginBottom: 16, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <ActivityIndicator color="#a8a29e" style={{ marginBottom: 12 }} />
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 4 }}>Refreshing your picks…</Text>
          <Text style={{ fontSize: 12, color: '#a8a29e', textAlign: 'center' }}>Noting your choices and finding what's next</Text>
        </View>
      )}

      {/* ── Exhausted refreshing ── */}
      {displayState === 'exhausted_refreshing' && (
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 24, alignItems: 'center', marginBottom: 16, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <ActivityIndicator color="#a8a29e" style={{ marginBottom: 12 }} />
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 4 }}>Finding more picks…</Text>
          <Text style={{ fontSize: 12, color: '#a8a29e', textAlign: 'center' }}>Exploring beyond your acted-on titles</Text>
        </View>
      )}

      {/* ── Exhausted terminal: all picks seen ── */}
      {displayState === 'exhausted_terminal' && (
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 20, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 22, marginBottom: 12 }}>✓</Text>
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>You've seen everything</Text>
          <Text style={{ fontSize: 13, color: '#a8a29e', textAlign: 'center', lineHeight: 20 }}>
            You've acted on all available picks. Rate more books to unlock fresh recommendations.
          </Text>
        </View>
      )}

      {/* ── Empty (non-exhaustion) ── */}
      {displayState === 'empty' && (
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 20, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 22, marginBottom: 12 }}>✓</Text>
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>You're caught up</Text>
          <Text style={{ fontSize: 13, color: '#a8a29e', textAlign: 'center', lineHeight: 20, marginBottom: 8 }}>
            We'll keep learning as you finish and rate more books.
          </Text>
        </View>
      )}
    </View>
  );
}
