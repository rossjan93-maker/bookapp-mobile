import { SAGE_DEEP } from '../lib/tokens';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  LayoutAnimation,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getPersonalizedRecsWithExpert } from '../lib/recommender';
import type { ScoredBook, QualityGate } from '../lib/recommender';
import {
  type NextReadIntent,
  type ReadingEnergyMode,
  emptyIntent,
  isIntentActive,
  intentSummaryLabel,
} from '../lib/nextReadIntent';
import type { TasteProfile } from '../lib/tasteProfile';
import type { RecEntitlement } from '../lib/recEntitlement';
import { loadFeedbackContext, persistFeedback } from '../lib/recFeedback';
import type { FeedbackContext } from '../lib/recFeedback';
import { getBookTraits } from '../lib/bookTraits';
import type { ReaderThesis } from '../lib/expertRec';
import { type RecSessionCache, getRecSession, setRecSession, clearRecSession } from '../lib/recSession';
import { addActedOnIds, loadActedOnIds } from '../lib/recPayloadCache';
import { GuidedActionBanner } from './OnboardingWalkthrough';

import { RecCard, UndoToast, DeckAssemblingLoader, RefreshingDot } from './RecCard';
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

// Hard timeout for the full recommendation pipeline (network + scoring).
// On lossy mobile connections, the OL live-fetch can hang indefinitely.
// After this duration the race rejects, loading is cleared, and the user
// sees an honest "timed out" state with a retry CTA.
const PIPELINE_TIMEOUT_MS = 12_000; // 12 seconds

class PipelineTimeoutError extends Error {
  constructor() {
    super('pipeline_timeout');
    this.name = 'PipelineTimeoutError';
  }
}

function makePipelineTimeoutRace(): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new PipelineTimeoutError()), PIPELINE_TIMEOUT_MS),
  );
}

// Custom LayoutAnimation config that matches the motion token system (380ms, ease-in-out).
// Used for all stack reflowing — slower and softer than the 300ms preset.
const REFLOW_LAYOUT_ANIM = LayoutAnimation.create(
  380,
  LayoutAnimation.Types.easeInEaseOut,
  LayoutAnimation.Properties.opacity,
);

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
  /** Walkthrough: ref placed on the first visible targetable element (setup card or first rec card). */
  wtRef?:          React.RefObject<any>;
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
  wtRef,
}: RecommendationsFeedProps) {
  const router = useRouter();

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
  // Set true when the pipeline hits the 12s hard timeout.  Cleared at the
  // start of every new runPipeline call so a retry always starts fresh.
  const [pipelineTimedOut, setPipelineTimedOut] = useState(false);
  const hadDeckRef = useRef(false);

  // ── Pipeline metadata ──────────────────────────────────────────────────────
  const [recMode, setRecMode]             = useState<'deterministic' | 'expert' | null>(null);
  const [readerThesis, setReaderThesis]   = useState<ReaderThesis | null>(null);
  const [isFreePreview, setIsFreePreview] = useState(false);
  const [thesisOpen, setThesisOpen]       = useState(false);
  const thesisHeight = useRef(new Animated.Value(0)).current;

  // ── Your Next Read — intent chip state ───────────────────────────────────
  const [intentPanelOpen, setIntentPanelOpen]         = useState(false);
  const [moodChip, setMoodChip]                       = useState<ReadingEnergyMode | null>(null);
  const [paceChip, setPaceChip]                       = useState<'fast' | 'slow' | null>(null);
  const [toneChip, setToneChip]                       = useState<'light' | 'dark' | null>(null);
  const [intensityChip, setIntensityChip]             = useState<'high' | 'low' | null>(null);
  const [lengthChip, setLengthChip]                   = useState<'short' | 'medium' | null>(null);
  const [formatChip, setFormatChip]                   = useState<'fiction' | 'nonfiction' | null>(null);
  const [seriesChip, setSeriesChip]                   = useState<boolean>(false); // true => standalone only
  const activeIntentRef                               = useRef<NextReadIntent | null>(null);
  const [activeIntentLabel, setActiveIntentLabel]     = useState<string>('');

  // Banner shown for the duration of a filter-triggered pipeline run so the
  // user gets immediate feedback that Apply/Clear actually did something.
  // Distinct from `isInitialLoading` (which the deck-assembling skeleton
  // also reads) so we can show a chip-aware label instead of a generic
  // loader.
  const [isFilterRefreshing, setIsFilterRefreshing] = useState(false);
  const filterPulseAnim     = useRef(new Animated.Value(0.4)).current;
  // Three staggered "typing-indicator" dots inside the curating banner.
  const dotAnim0            = useRef(new Animated.Value(0)).current;
  const dotAnim1            = useRef(new Animated.Value(0)).current;
  const dotAnim2            = useRef(new Animated.Value(0)).current;
  // Shimmer bar that sweeps left → right across the banner's progress track.
  const shimmerAnim         = useRef(new Animated.Value(0)).current;
  // Dims the existing rec-card stack behind the banner so focus shifts to
  // the curating animation while the new pipeline result is computed.
  const contentDimAnim      = useRef(new Animated.Value(1)).current;
  // Monotonic counter for filter-refresh requests. Each Apply/Clear bumps it,
  // captures the value, and the `.finally` only clears the banner if its
  // captured value still matches — so a fast double-tap doesn't have run #1's
  // finally turning the banner off while run #2 is still in flight.
  const filterRefreshReqRef = useRef(0);

  // ── Dismiss/undo ──────────────────────────────────────────────────────────
  const [dismissPending, setDismissPendingUI] = useState<{ book: ScoredBook } | null>(null);
  const [saveFailure, setSaveFailure]          = useState<{ book: ScoredBook } | null>(null);

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
      if (s?.qualityGate) {
        setRecsQualityGate(s.qualityGate);
        if (__DEV__) console.log('[REC_GATE_RESTORE] gate restored from session:', s.qualityGate);
      }
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

    runPipeline({ isBgRefresh });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasteProfile?.strongSignalCount, userId, entitlement?.expert_recs_enabled]);

  // ── Tab revisit: rerun pipeline when session was wiped ───────────────────
  // Status changes on the book detail screen call clearRecSession() so
  // continuations (Currently Reading) reflect the new state. When the
  // user navigates back to the home tab, we detect the missing session
  // and force a pipeline rerun so the bucket repopulates immediately
  // instead of waiting for the 4-min TTL or a signal-count change.
  useFocusEffect(useCallback(() => {
    if (!tasteProfile || tasteProfile.tier < 1 || !userId || !supabase) return;
    if (getRecSession()) return; // session still valid — nothing to do
    if (__DEV__) console.log('[REC_REFRESH]', 'reason=session_cleared_on_focus');
    setIsInitialLoading(true);
    runPipeline({ isBgRefresh: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, tasteProfile?.tier]));

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
    runPipeline({ isBgRefresh: true, exhaustionBypass: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExhausted, tasteProfile?.tier, isReplenishing]);

  // ── Pipeline runner ───────────────────────────────────────────────────────
  async function runPipeline(
    opts?: { isBgRefresh?: boolean; exhaustionBypass?: boolean },
  ) {
    if (!supabase || !userId || !tasteProfile || tasteProfile.tier < 1) return;

    const requestId  = ++latestPipelineRef.current;
    const loadMode   = opts?.exhaustionBypass ? 'watermark' : opts?.isBgRefresh ? 'background' : 'initial';
    const hasVisible = getQueueDepth() > 0;
    if (__DEV__) console.log('[REC_LOADING]', `mode=${loadMode}`, `visible=${hasVisible}`);

    const activeEnt = entitlement ?? {
      plan: 'free' as const,
      expert_recs_enabled: false,
      expert_refreshes_remaining_this_period: 0,
      has_used_free_import_analysis: false,
    };

    try {
      // Clear any previous timeout state so the retry path starts clean.
      setPipelineTimedOut(false);

      const recResult = await Promise.race([
        getPersonalizedRecsWithExpert(
          supabase, userId, tasteProfile, activeEnt, 12,
          feedbackCtx,
          activeIntentRef.current ?? undefined,
          opts?.exhaustionBypass ? { exhaustionBypass: true, clearOLCache: true } : undefined,
        ),
        makePipelineTimeoutRace(),
      ]);

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

        LayoutAnimation.configureNext(REFLOW_LAYOUT_ANIM);
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
      if (e instanceof PipelineTimeoutError) {
        // Always log — this is a production-observable failure, not a dev-only detail.
        console.warn('[REC_PIPELINE_TIMEOUT] recommendation pipeline timed out after', PIPELINE_TIMEOUT_MS / 1000, 's — clearing loader, showing retry state');
        if (requestId === latestPipelineRef.current) {
          setPipelineTimedOut(true);
        }
      } else {
        if (__DEV__) console.warn('[REC_PIPELINE_ERROR]', e);
      }
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
      runPipeline({ isBgRefresh: true });
    }
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  function handleSave(book: ScoredBook) {
    if (!supabase || !userId) return;
    removeFromQueue(book.id);
    trackActedOn(userId, book);
    replenishIfNeeded();
    LayoutAnimation.configureNext(REFLOW_LAYOUT_ANIM);
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

    LayoutAnimation.configureNext(REFLOW_LAYOUT_ANIM);
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
    LayoutAnimation.configureNext(REFLOW_LAYOUT_ANIM);
    syncVisible();
    if (__DEV__) console.log('[REC_ACTION_STATE]', 'action=dismiss', 'status=undone', `| book_id=${rec.book.id}`);
  }

  function handleMoreLikeThis(book: ScoredBook) {
    if (!supabase || !userId) return;
    removeFromQueue(book.id);
    trackActedOn(userId, book);
    replenishIfNeeded();
    LayoutAnimation.configureNext(REFLOW_LAYOUT_ANIM);
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

  // ── Your Next Read — intent apply / clear ─────────────────────────────────

  // Drives the curating banner's full motion ensemble while
  // isFilterRefreshing is true: subtle banner-glow pulse, three staggered
  // bouncing dots (typing-indicator pattern), a continuous left→right
  // shimmer sweep on the progress track, and an opacity dim on the
  // existing card stack so focus shifts to the banner. All loops stop
  // and reset cleanly when the flag flips back to false.
  useEffect(() => {
    if (!isFilterRefreshing) {
      [filterPulseAnim, dotAnim0, dotAnim1, dotAnim2, shimmerAnim].forEach(a => a.stopAnimation());
      filterPulseAnim.setValue(0.4);
      dotAnim0.setValue(0); dotAnim1.setValue(0); dotAnim2.setValue(0);
      shimmerAnim.setValue(0);
      Animated.timing(contentDimAnim, { toValue: 1, duration: 240, useNativeDriver: true }).start();
      return;
    }
    Animated.timing(contentDimAnim, { toValue: 0.32, duration: 240, useNativeDriver: true }).start();

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(filterPulseAnim, { toValue: 1.0, duration: 700, useNativeDriver: true }),
        Animated.timing(filterPulseAnim, { toValue: 0.55, duration: 700, useNativeDriver: true }),
      ]),
    );

    const makeDotLoop = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 380, useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 380, useNativeDriver: true }),
          Animated.delay(380 - delay),
        ]),
      );
    const dot0 = makeDotLoop(dotAnim0, 0);
    const dot1 = makeDotLoop(dotAnim1, 140);
    const dot2 = makeDotLoop(dotAnim2, 280);

    const shimmer = Animated.loop(
      Animated.timing(shimmerAnim, { toValue: 1, duration: 1400, useNativeDriver: true }),
    );

    pulse.start(); dot0.start(); dot1.start(); dot2.start(); shimmer.start();
    return () => { pulse.stop(); dot0.stop(); dot1.stop(); dot2.stop(); shimmer.stop(); };
  }, [isFilterRefreshing, filterPulseAnim, dotAnim0, dotAnim1, dotAnim2, shimmerAnim, contentDimAnim]);

  function handleApplyIntent() {
    // Build the intent from chip state. Soft boosts alone (±0.05 cap) are
    // too small to visibly reorder books at typical score ranges, so we
    // ALSO derive the natural hard filters / exclusions for each chip so
    // the pool composition actually shifts when the user hits Apply.
    //
    // Mapping rationale (kept conservative — only obvious semantic
    // overlaps map to hard rules; ambiguous chips stay soft):
    //
    //   tone='light'          → exclude.avoid_dark
    //   tone='dark'           → soft only (boost dark, no exclusion)
    //   intensity='low'       → exclude.avoid_dark   (unless tone='dark')
    //   intensity='high'      → soft only
    //   pace='fast' / 'slow'  → soft only (no clean hard signal)
    //   mood='light_fun'      → exclude.avoid_dark + avoid_literary
    //                            (unless tone='dark')
    //   mood='palate_cleanser'→ exclude.avoid_dark (unless tone='dark')
    //                          + hard.max_page_count = 400
    //                          (standalone_only intentionally NOT set —
    //                           series-heavy libraries would empty the
    //                           pool; page count is enough to enforce
    //                           "quick read")
    //   mood='immersive' / 'deep_demanding' / 'emotionally_heavy'
    //                         → soft only
    //
    // A user can still pick tone='dark' WITH intensity='low' or
    // mood='light_fun' if they want — tone='dark' wins and we don't
    // exclude dark themes (otherwise the chip would silently filter
    // itself out and the list would go empty).
    const wantsDark = toneChip === 'dark';

    const exclude: NextReadIntent['exclude'] = {};
    const hard:    NextReadIntent['hard']    = {};

    if (toneChip === 'light')                 exclude.avoid_dark     = true;
    if (intensityChip === 'low' && !wantsDark) exclude.avoid_dark    = true;

    if (moodChip === 'light_fun' && !wantsDark) {
      exclude.avoid_dark     = true;
      exclude.avoid_literary = true;
    }
    if (moodChip === 'palate_cleanser') {
      if (!wantsDark) exclude.avoid_dark = true;
      hard.max_page_count = 400;
    }

    // Length chip — explicit user pick wins over palate_cleanser default.
    if (lengthChip === 'short')  hard.max_page_count = 300;
    if (lengthChip === 'medium') hard.max_page_count = 450;

    // Format chip
    if (formatChip === 'fiction')    hard.fiction_only    = true;
    if (formatChip === 'nonfiction') hard.nonfiction_only = true;

    // Series chip
    if (seriesChip) hard.standalone_only = true;

    const intent: NextReadIntent = {
      hard,
      soft: {
        readingEnergy: moodChip     || undefined,
        pace:          paceChip     || undefined,
        tone:          toneChip     || undefined,
        intensity:     intensityChip || undefined,
      },
      exclude,
    };

    if (!isIntentActive(intent)) {
      handleClearIntent();
      return;
    }
    activeIntentRef.current = intent;
    setActiveIntentLabel(intentSummaryLabel(intent));
    setIntentPanelOpen(false);
    clearAll();
    clearRecSession();
    setIsInitialLoading(true);
    setIsFilterRefreshing(true);
    const reqId = ++filterRefreshReqRef.current;
    if (__DEV__) {
      console.log('[INTENT_APPLY]', JSON.stringify({
        mood:  moodChip,    pace:   paceChip,
        tone:  toneChip,    int:    intensityChip,
        len:   lengthChip,  fmt:    formatChip,
        stand: seriesChip,
        hard, exclude,
      }));
    }
    runPipeline({ isBgRefresh: false }).finally(() => {
      if (filterRefreshReqRef.current === reqId) setIsFilterRefreshing(false);
    });
  }

  function handleClearIntent() {
    activeIntentRef.current = null;
    setActiveIntentLabel('');
    setMoodChip(null);
    setPaceChip(null);
    setToneChip(null);
    setIntensityChip(null);
    setLengthChip(null);
    setFormatChip(null);
    setSeriesChip(false);
    setIntentPanelOpen(false);
    clearAll();
    clearRecSession();
    setIsInitialLoading(true);
    setIsFilterRefreshing(true);
    const reqId = ++filterRefreshReqRef.current;
    runPipeline({ isBgRefresh: false }).finally(() => {
      if (filterRefreshReqRef.current === reqId) setIsFilterRefreshing(false);
    });
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
    | 'pipeline_timed_out'
    | 'empty';

  const displayState: DisplayState = (() => {
    // Timeout state takes precedence over loading_initial — the pipeline already
    // finished (by timing out), so showing DeckAssemblingLoader again would be
    // incorrect.  pipelineTimedOut is cleared at the start of every new
    // runPipeline call, so a retry always transitions back through loading_initial.
    if (pipelineTimedOut && !hasCards) return 'pipeline_timed_out';
    // Do NOT enter loading_initial when a quality gate is already known (restored
    // from the previous session on mount). Showing DeckAssemblingLoader over a
    // quality gate state forces the user through a false "building picks" experience
    // before landing on the same gated state every time they reload.
    if (isInitialLoading && !hasCards && !recsQualityGate) return 'loading_initial';
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

  // ── Insufficient-confidence gate ───────────────────────────────────────────
  // tier < 1 means we do NOT have enough reader signal to make picks we trust.
  // The pipeline is intentionally not running (it has its own tier < 1 guard),
  // so isInitialLoading is semantically irrelevant here — we will never finish
  // loading because we never started. Show the setup CTA immediately regardless
  // of isInitialLoading, so the user never sees skeleton cards for a state that
  // is NOT a loading state — it is an insufficient-signal state.
  if (tier < 1) {
    const hasImportedHistory = (tasteProfile?.evidence?.imported_books_count ?? 0) > 0;
    return (
      <View style={{ marginBottom: 36 }}>
        {/* No internal "For You" overline — the parent surface
            (app/(tabs)/search.tsx) already renders the hero header. A second
            heading inside this card read as a duplicated section title. */}
        <View
          ref={wtRef}
          style={{
            backgroundColor: '#fefcf9', borderRadius: 16,
            overflow: 'hidden',
            shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
          }}
        >
          {/* Hero strip — generous vertical breathing room so the empty
              state feels intentional rather than truncated. The headline
              sets the tone (we're working on it, not broken), the lede
              explains why nothing is here yet, and the supporting line
              tells the user exactly what unlocks recommendations. */}
          <View style={{ backgroundColor: '#f5f1ec', borderBottomWidth: 1, borderBottomColor: '#ede9e4', paddingHorizontal: 22, paddingTop: 28, paddingBottom: 22 }}>
            <View style={{ width: 32, height: 2.5, backgroundColor: '#7b9e7e', borderRadius: 2, marginBottom: 16 }} />
            <Text style={{ fontSize: 19, fontWeight: '800', color: '#231f1b', letterSpacing: -0.3, marginBottom: 8, lineHeight: 25 }}>
              {hasImportedHistory ? 'We\'re reading your shelves.' : 'Let\'s set up your shelf.'}
            </Text>
            <Text style={{ fontSize: 13.5, color: '#6b635c', lineHeight: 20 }}>
              {hasImportedHistory
                ? 'Your library is in. Rate a handful of books you\'ve loved (or didn\'t) and we\'ll start surfacing picks worth trusting.'
                : 'Recommendations get sharper the more we know about your reading. Pick the option below that\'s easiest for you — five books is enough to unlock your first picks.'}
            </Text>
          </View>

          <View style={{ padding: 16, gap: 10 }}>
            {/* CTA 1 — Import library (primary) */}
            <TouchableOpacity
              onPress={() => router.push('/import/goodreads' as any)}
              activeOpacity={0.82}
              style={{
                backgroundColor: '#231f1b', borderRadius: 12, paddingVertical: 14,
                paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>📚</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff', lineHeight: 19 }}>Import your library</Text>
                <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>Goodreads or StoryGraph — fastest way to unlock</Text>
              </View>
              <Text style={{ fontSize: 16, color: 'rgba(255,255,255,0.35)' }}>›</Text>
            </TouchableOpacity>

            {/* Secondary row — two compact alternatives, side by side, so the
                primary Import CTA above is unambiguously the recommended path
                instead of competing with two equally-weighted full-width rows. */}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 2 }}>
              <TouchableOpacity
                onPress={() => router.push('/add-book' as any)}
                activeOpacity={0.8}
                style={{
                  flex: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 12,
                  borderWidth: 1.5, borderColor: '#ede9e4', backgroundColor: '#f5f1ec',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#231f1b' }}>＋  Add a few</Text>
                <Text style={{ fontSize: 10.5, color: '#9e958d', marginTop: 2 }}>under a minute</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => router.push('/edit-preferences' as any)}
                activeOpacity={0.8}
                style={{
                  flex: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 12,
                  borderWidth: 1.5, borderColor: '#ede9e4', backgroundColor: '#f5f1ec',
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#231f1b' }}>🎯  Quick quiz</Text>
                <Text style={{ fontSize: 10.5, color: '#9e958d', marginTop: 2 }}>~90 seconds</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ marginBottom: 36 }}>
      {/* The parent search hub owns the "For You" hero. We only surface the
          breathing-dot here so a background refresh stays visible without
          repeating the section title. */}
      {displayState === 'ready_refreshing' && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
          <RefreshingDot />
        </View>
      )}

      {/* ── First-load: bespoke deck-assembling experience ── */}
      {displayState === 'loading_initial' && <DeckAssemblingLoader />}

      {/* ── Ready state: cards + intent panel + thesis ── */}
      {(displayState === 'ready' || displayState === 'ready_refreshing') && (
        <View style={{ marginBottom: 20 }}>

          {/* Sub-header — only the taste basis (e.g. "Based on your stated
              genres" or the user's profile label). The "FOR YOU" overline
              above already names the section, so we don't repeat it here. */}
          {(recMode === 'expert' || tasteProfile?.label || (tasteProfile?.strongSignalCount ?? 0) === 0) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ fontSize: 12, color: '#78716c', flex: 1, fontStyle: 'italic' }} numberOfLines={1}>
                {recMode === 'expert'
                  ? 'Tuned to your reading lanes'
                  : (tasteProfile?.label || 'Based on your stated genres')}
              </Text>
              {recMode === 'expert' && (
                <View style={{ backgroundColor: '#231f1b', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: '#f5f1ec', letterSpacing: 0.5 }}>EXPERT</Text>
                </View>
              )}
            </View>
          )}

          {/* Free preview moment */}
          {isFreePreview && (
            <View style={{ backgroundColor: '#eaf1ea', borderRadius: 10, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#7b9e7e' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: SAGE_DEEP, marginBottom: 4 }}>
                Your taste profile is ready
              </Text>
              <Text style={{ fontSize: 12, color: '#3d5e42', lineHeight: 18 }}>
                These picks are matched to your specific reading lanes — not just broad genres.
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
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#ede9e4', borderRadius: 8 }}
              >
                <Text style={{ fontSize: 11, color: '#57534e', flex: 1 }}>
                  {thesisOpen ? '▲' : '▼'}  Your reader profile
                </Text>
                <Text style={{ fontSize: 10, color: '#9e958d' }}>
                  {readerThesis.dominant_lanes.length} lane{readerThesis.dominant_lanes.length !== 1 ? 's' : ''}
                </Text>
              </TouchableOpacity>
              <Animated.View style={{ maxHeight: thesisHeight.interpolate({ inputRange: [0, 1], outputRange: [0, 320] }), overflow: 'hidden' }}>
                <View style={{ backgroundColor: '#f5f1ec', borderRadius: 10, padding: 12, marginTop: 4, borderWidth: 1, borderColor: '#ede9e4' }}>
                  <Text style={{ fontSize: 12, color: '#231f1b', lineHeight: 18, marginBottom: 8, fontStyle: 'italic' }}>
                    {readerThesis.center_of_gravity}
                  </Text>
                  {readerThesis.dominant_lanes.slice(0, 3).map(lane => (
                    <View key={lane.genre_key} style={{ marginBottom: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View style={{ width: Math.round(lane.strength * 48), height: 3, backgroundColor: '#231f1b', borderRadius: 2, opacity: 0.6 }} />
                        <Text style={{ fontSize: 11, fontWeight: '600', color: '#231f1b' }}>
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
                    <View style={{ marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#ede9e4' }}>
                      <Text style={{ fontSize: 10, fontWeight: '600', color: '#9e958d', marginBottom: 4 }}>TENDS TO AVOID</Text>
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

          {/* ── Your Next Read — mood / reading energy panel ──
              Sits at the top, directly above Discover Next because
              that's the bucket it actually filters. Defaults to its compact collapsed
              pill so it never crowds the recs themselves; expanding it
              reveals the chip groups and Apply/Clear actions that
              re-run the rec pipeline with an active NextReadIntent. */}
          <View style={{ marginBottom: 14 }}>
            {/* ── Collapsed trigger row ── */}
            {!intentPanelOpen && (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setIntentPanelOpen(true)}
                style={{
                  flexDirection: 'row', alignItems: 'center',
                  paddingVertical: 11, paddingHorizontal: 14,
                  backgroundColor: activeIntentLabel ? '#eaf1ea' : '#f5f1ec',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: activeIntentLabel ? '#7b9e7e' : '#ede9e4',
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#9e958d', letterSpacing: 0.6 }}>
                    {activeIntentLabel
                      ? `YOUR NEXT READ  ·  ${activeIntentLabel.toUpperCase()}`
                      : 'YOUR NEXT READ'}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 2 }}>
                    {activeIntentLabel
                      ? 'Tap to adjust or clear'
                      : 'Steer the picks below by mood, pace, or tone'}
                  </Text>
                </View>
                <Text style={{ fontSize: 13, color: '#c4b5a5' }}>›</Text>
              </TouchableOpacity>
            )}

            {/* ── Expanded panel ── */}
            {intentPanelOpen && (
              <View style={{
                backgroundColor: '#fefcf9', borderRadius: 14,
                borderWidth: 1, borderColor: '#ede9e4',
                overflow: 'hidden',
              }}>
                {/* Header */}
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => setIntentPanelOpen(false)}
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingVertical: 12, paddingHorizontal: 14,
                    borderBottomWidth: 1, borderBottomColor: '#ede9e4',
                    backgroundColor: '#f5f1ec',
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#6b635c', letterSpacing: 0.6, flex: 1 }}>
                    YOUR NEXT READ
                  </Text>
                  <Text style={{ fontSize: 13, color: '#c4b5a5' }}>✕</Text>
                </TouchableOpacity>

                <View style={{ padding: 14 }}>
                  {/* Reading energy chip row */}
                  <Text style={{
                    fontSize: 10, fontWeight: '700', color: '#9e958d',
                    letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
                  }}>
                    Reading energy
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ flexDirection: 'row', gap: 6, paddingBottom: 2 }}
                    style={{ marginBottom: 16 }}
                  >
                    {([
                      ['light_fun',         'Light & fun'],
                      ['immersive',         'Immersive'],
                      ['deep_demanding',    'Deep & demanding'],
                      ['emotionally_heavy', 'Emotionally heavy'],
                      ['palate_cleanser',   'Palate cleanser'],
                    ] as [ReadingEnergyMode, string][]).map(([mode, label]) => {
                      const active = moodChip === mode;
                      return (
                        <TouchableOpacity
                          key={mode}
                          activeOpacity={0.7}
                          onPress={() => setMoodChip(active ? null : mode)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                            backgroundColor: active ? '#231f1b' : '#f5f1ec',
                            borderWidth: 1, borderColor: active ? '#231f1b' : '#ede9e4',
                          }}
                        >
                          <Text style={{
                            fontSize: 12,
                            color: active ? '#fff' : '#6b635c',
                            fontWeight: active ? '600' : '400',
                          }}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>

                  {/* Pace chips */}
                  <Text style={{
                    fontSize: 10, fontWeight: '700', color: '#9e958d',
                    letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
                  }}>
                    Pace
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
                    {([['fast', 'Fast-paced'], ['slow', 'Slow burn']] as ['fast' | 'slow', string][]).map(([p, label]) => {
                      const active = paceChip === p;
                      return (
                        <TouchableOpacity
                          key={p}
                          activeOpacity={0.7}
                          onPress={() => setPaceChip(active ? null : p)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                            backgroundColor: active ? '#231f1b' : '#f5f1ec',
                            borderWidth: 1, borderColor: active ? '#231f1b' : '#ede9e4',
                          }}
                        >
                          <Text style={{ fontSize: 12, color: active ? '#fff' : '#6b635c', fontWeight: active ? '600' : '400' }}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Tone chips */}
                  <Text style={{
                    fontSize: 10, fontWeight: '700', color: '#9e958d',
                    letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
                  }}>
                    Tone
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
                    {([['light', 'Light / uplifting'], ['dark', 'Dark / serious']] as ['light' | 'dark', string][]).map(([t, label]) => {
                      const active = toneChip === t;
                      return (
                        <TouchableOpacity
                          key={t}
                          activeOpacity={0.7}
                          onPress={() => setToneChip(active ? null : t)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                            backgroundColor: active ? '#231f1b' : '#f5f1ec',
                            borderWidth: 1, borderColor: active ? '#231f1b' : '#ede9e4',
                          }}
                        >
                          <Text style={{ fontSize: 12, color: active ? '#fff' : '#6b635c', fontWeight: active ? '600' : '400' }}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Intensity chips */}
                  <Text style={{
                    fontSize: 10, fontWeight: '700', color: '#9e958d',
                    letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
                  }}>
                    Emotional intensity
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
                    {([['high', 'High intensity'], ['low', 'Low-key']] as ['high' | 'low', string][]).map(([iv, label]) => {
                      const active = intensityChip === iv;
                      return (
                        <TouchableOpacity
                          key={iv}
                          activeOpacity={0.7}
                          onPress={() => setIntensityChip(active ? null : iv)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                            backgroundColor: active ? '#231f1b' : '#f5f1ec',
                            borderWidth: 1, borderColor: active ? '#231f1b' : '#ede9e4',
                          }}
                        >
                          <Text style={{ fontSize: 12, color: active ? '#fff' : '#6b635c', fontWeight: active ? '600' : '400' }}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Length chips — maps to hard.max_page_count */}
                  <Text style={{
                    fontSize: 10, fontWeight: '700', color: '#9e958d',
                    letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
                  }}>
                    Length
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
                    {([['short', 'Short (<300p)'], ['medium', 'Medium (<450p)']] as ['short' | 'medium', string][]).map(([lv, label]) => {
                      const active = lengthChip === lv;
                      return (
                        <TouchableOpacity
                          key={lv}
                          activeOpacity={0.7}
                          onPress={() => setLengthChip(active ? null : lv)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                            backgroundColor: active ? '#231f1b' : '#f5f1ec',
                            borderWidth: 1, borderColor: active ? '#231f1b' : '#ede9e4',
                          }}
                        >
                          <Text style={{ fontSize: 12, color: active ? '#fff' : '#6b635c', fontWeight: active ? '600' : '400' }}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Format chips — maps to hard.fiction_only / nonfiction_only */}
                  <Text style={{
                    fontSize: 10, fontWeight: '700', color: '#9e958d',
                    letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
                  }}>
                    Format
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
                    {([['fiction', 'Fiction'], ['nonfiction', 'Nonfiction']] as ['fiction' | 'nonfiction', string][]).map(([fv, label]) => {
                      const active = formatChip === fv;
                      return (
                        <TouchableOpacity
                          key={fv}
                          activeOpacity={0.7}
                          onPress={() => setFormatChip(active ? null : fv)}
                          style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                            backgroundColor: active ? '#231f1b' : '#f5f1ec',
                            borderWidth: 1, borderColor: active ? '#231f1b' : '#ede9e4',
                          }}
                        >
                          <Text style={{ fontSize: 12, color: active ? '#fff' : '#6b635c', fontWeight: active ? '600' : '400' }}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Series chip — maps to hard.standalone_only (toggle, not a group) */}
                  <Text style={{
                    fontSize: 10, fontWeight: '700', color: '#9e958d',
                    letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
                  }}>
                    Series
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => setSeriesChip(!seriesChip)}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
                        backgroundColor: seriesChip ? '#231f1b' : '#f5f1ec',
                        borderWidth: 1, borderColor: seriesChip ? '#231f1b' : '#ede9e4',
                      }}
                    >
                      <Text style={{ fontSize: 12, color: seriesChip ? '#fff' : '#6b635c', fontWeight: seriesChip ? '600' : '400' }}>
                        Standalones only
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* Action row */}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={handleApplyIntent}
                      style={{
                        flex: 2, paddingVertical: 11, borderRadius: 10,
                        backgroundColor: '#231f1b', alignItems: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>
                        Apply
                      </Text>
                    </TouchableOpacity>
                    {activeIntentLabel ? (
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={handleClearIntent}
                        style={{
                          flex: 1, paddingVertical: 11, borderRadius: 10,
                          borderWidth: 1, borderColor: '#ede9e4', alignItems: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 13, color: '#78716c' }}>Clear</Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => setIntentPanelOpen(false)}
                        style={{
                          flex: 1, paddingVertical: 11, borderRadius: 10,
                          borderWidth: 1, borderColor: '#ede9e4', alignItems: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 13, color: '#78716c' }}>Cancel</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>
            )}
          </View>

          {/* ── Filter-refresh "curating" banner ──
              Visible only while a chip-driven runPipeline is in flight.
              Combines four motion layers (subtle card-glow pulse,
              three staggered bouncing dots, a sweeping shimmer
              progress track, and a dim of the rec stack behind it) so
              the user gets unmistakable feedback that the pipeline is
              re-curating against their new filter selection. */}
          {isFilterRefreshing && (
            <Animated.View
              style={{
                opacity: filterPulseAnim,
                backgroundColor: '#eef4ec',
                borderRadius: 14,
                paddingHorizontal: 16, paddingVertical: 14,
                marginBottom: 14,
                borderWidth: 1, borderColor: SAGE_DEEP + '33',
                shadowColor: SAGE_DEEP, shadowOpacity: 0.12,
                shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
                elevation: 2,
                overflow: 'hidden',
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                {/* Three bouncing dots */}
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 14 }}>
                  {[dotAnim0, dotAnim1, dotAnim2].map((d, i) => (
                    <Animated.View
                      key={i}
                      style={{
                        width: 7, height: 7, borderRadius: 4,
                        backgroundColor: SAGE_DEEP,
                        transform: [{
                          translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }),
                        }, {
                          scale: d.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }),
                        }],
                      }}
                    />
                  ))}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, color: SAGE_DEEP, fontWeight: '700', letterSpacing: 0.1 }}>
                    Curating your next read
                  </Text>
                  <Text style={{ fontSize: 11, color: SAGE_DEEP, opacity: 0.75, marginTop: 1 }}>
                    Re-scoring books against your filters…
                  </Text>
                </View>
              </View>
              {/* Shimmer progress track */}
              <View style={{
                height: 4, borderRadius: 2,
                backgroundColor: SAGE_DEEP + '22',
                overflow: 'hidden',
              }}>
                <Animated.View
                  style={{
                    height: '100%', width: '40%', borderRadius: 2,
                    backgroundColor: SAGE_DEEP,
                    transform: [{
                      translateX: shimmerAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-120, 320],
                      }),
                    }],
                  }}
                />
              </View>
            </Animated.View>
          )}

          {/* Animated dim wrapper around both buckets — opacity drops to
              0.32 while a chip-driven pipeline is in flight so focus
              shifts to the curating banner above. */}
          <Animated.View style={{ opacity: contentDimAnim }} pointerEvents={isFilterRefreshing ? 'none' : 'auto'}>

          {/* ── Discover Next bucket ── */}
          {visibleDiscs.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, marginTop: 0, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: '#ede9e4' }}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', letterSpacing: -0.1 }}>Discover Next</Text>
                  <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>Fresh picks based on what you've loved</Text>
                </View>
              </View>
              {visibleDiscs.map((rec, idx) => {
                const isFirstVisible = idx === 0;
                const card = (
                  <RecCard
                    key={rec.id}
                    book={rec}
                    featured={isFirstVisible}
                    isExpert={recMode === 'expert'}
                    onSave={() => handleSave(rec)}
                    onDismiss={() => handleDismiss(rec)}
                    onMoreLikeThis={() => handleMoreLikeThis(rec)}
                    onImpression={() => handleImpression(rec)}
                    onExplanationOpen={() => handleExplanationOpen(rec)}
                  />
                );
                return isFirstVisible && wtRef
                  ? <View key={rec.id} ref={wtRef}>{card}</View>
                  : card;
              })}
              {visibleConts.length > 0 && <View style={{ height: 14 }} />}
            </>
          )}

          {/* ── Currently Reading bucket ──
              Rendered BELOW the filter + Discover Next per user
              preference: discovery is the headline, in-progress series
              continuations sit at the bottom as a "and don't forget…"
              reminder. Not affected by the mood/pace/tone chips. */}
          {visibleConts.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, marginTop: 0, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: SAGE_DEEP }}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', letterSpacing: -0.1 }}>Currently Reading</Text>
                  <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>Pick up where you left off</Text>
                </View>
              </View>
              {visibleConts.map((rec) => (
                <RecCard
                  key={rec.id}
                  book={rec}
                  featured={false}
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

          </Animated.View>

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

      {/* ── Quality gate: insufficient candidate pool — full actionable CTA ── */}
      {displayState === 'quality_gated' && tier >= 1 && recsQualityGate === 'insufficient_pool' && (
        <View
          style={{
            backgroundColor: '#fefcf9', borderRadius: 16,
            overflow: 'hidden',
            shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 }, elevation: 2,
            marginBottom: 16,
          }}
        >
          {/* Header strip */}
          <View style={{ backgroundColor: '#f5f1ec', borderBottomWidth: 1, borderBottomColor: '#ede9e4', padding: 20, paddingBottom: 16 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#231f1b', letterSpacing: -0.2, marginBottom: 6 }}>
              Candidate pool too narrow.
            </Text>
            <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
              We have your taste profile, but couldn't find enough matching books in the current catalog. Adding more reading history helps us work around coverage gaps.
            </Text>
          </View>

          <View style={{ padding: 16, gap: 10 }}>
            {/* CTA 1 — Import library (primary) */}
            <TouchableOpacity
              onPress={() => router.push('/import/goodreads' as any)}
              activeOpacity={0.82}
              style={{
                backgroundColor: '#231f1b', borderRadius: 12, paddingVertical: 14,
                paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>📚</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff', lineHeight: 19 }}>Import your library</Text>
                <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>Goodreads or StoryGraph — fastest way to expand</Text>
              </View>
              <Text style={{ fontSize: 16, color: 'rgba(255,255,255,0.35)' }}>›</Text>
            </TouchableOpacity>

            {/* CTA 2 — Add books manually */}
            <TouchableOpacity
              onPress={() => router.push('/add-book' as any)}
              activeOpacity={0.8}
              style={{
                borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
                flexDirection: 'row', alignItems: 'center', gap: 12,
                borderWidth: 1.5, borderColor: '#ede9e4', backgroundColor: '#f5f1ec',
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#ede9e4', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>＋</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', lineHeight: 19 }}>Add books you've read</Text>
                <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 1 }}>Search and rate a few favourites</Text>
              </View>
              <Text style={{ fontSize: 16, color: '#ede9e4' }}>›</Text>
            </TouchableOpacity>

            {/* CTA 3 — Refine preferences */}
            <TouchableOpacity
              onPress={() => router.push('/edit-preferences' as any)}
              activeOpacity={0.8}
              style={{
                borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
                flexDirection: 'row', alignItems: 'center', gap: 12,
                borderWidth: 1.5, borderColor: '#ede9e4', backgroundColor: '#f5f1ec',
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#ede9e4', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>🎯</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', lineHeight: 19 }}>Refine your preferences</Text>
                <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 1 }}>Genres, pace, style — widens the candidate pool</Text>
              </View>
              <Text style={{ fontSize: 16, color: '#ede9e4' }}>›</Text>
            </TouchableOpacity>

            <Text style={{ fontSize: 11, color: '#c4b5a5', textAlign: 'center', paddingTop: 2, paddingBottom: 4, lineHeight: 17 }}>
              More reading history means more candidates to work with.
            </Text>
          </View>
        </View>
      )}

      {/* ── Quality gate: other (catalog coverage) ── */}
      {displayState === 'quality_gated' && tier >= 1 && recsQualityGate !== 'insufficient_pool' && (
        <View style={{
          backgroundColor: '#fefcf9', borderRadius: 16,
          overflow: 'hidden',
          shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 }, elevation: 2,
          marginBottom: 16,
        }}>
          <View style={{ backgroundColor: '#f5f1ec', borderBottomWidth: 1, borderBottomColor: '#ede9e4', padding: 20, paddingBottom: 16 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#231f1b', letterSpacing: -0.2, marginBottom: 6 }}>
              No close matches right now.
            </Text>
            <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
              Your taste profile is strong, but catalog coverage for your specific preferences is limited at the moment. Broadening your preferences or adding more reading history helps us find better candidates.
            </Text>
          </View>
          <View style={{ padding: 16, gap: 10 }}>
            <TouchableOpacity
              onPress={() => router.push('/edit-preferences' as any)}
              activeOpacity={0.82}
              style={{
                backgroundColor: '#231f1b', borderRadius: 12, paddingVertical: 14,
                paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>🎯</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: '#fff', lineHeight: 19 }}>Broaden your preferences</Text>
                <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>Genres, pace, style — widens the candidate pool</Text>
              </View>
              <Text style={{ fontSize: 16, color: 'rgba(255,255,255,0.35)' }}>›</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => router.push('/add-book' as any)}
              activeOpacity={0.8}
              style={{
                borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
                flexDirection: 'row', alignItems: 'center', gap: 12,
                borderWidth: 1.5, borderColor: '#ede9e4', backgroundColor: '#f5f1ec',
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#ede9e4', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>＋</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', lineHeight: 19 }}>Add more books you've read</Text>
                <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 1 }}>More history gives the algorithm more to work with</Text>
              </View>
              <Text style={{ fontSize: 16, color: '#ede9e4' }}>›</Text>
            </TouchableOpacity>
            <Text style={{ fontSize: 11, color: '#c4b5a5', textAlign: 'center', paddingTop: 2, paddingBottom: 4, lineHeight: 17 }}>
              Coverage improves as the catalog grows — check back soon.
            </Text>
          </View>
        </View>
      )}

      {/* ── Pipeline timeout: network hung for more than 12s ── */}
      {displayState === 'pipeline_timed_out' && (
        <View style={{
          backgroundColor: '#fefcf9', borderRadius: 14, padding: 20, marginBottom: 16,
          borderWidth: 1, borderColor: '#ede9e4',
          shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 }, elevation: 1,
        }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 6 }}>
            Connection took too long
          </Text>
          <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20, marginBottom: 16 }}>
            Could not load recommendations. Check your connection and try again.
          </Text>
          <TouchableOpacity
            onPress={() => {
              setPipelineTimedOut(false);
              setIsInitialLoading(true);
              runPipeline();
            }}
            activeOpacity={0.75}
            style={{
              alignSelf: 'flex-start',
              backgroundColor: '#231f1b', borderRadius: 8,
              paddingVertical: 10, paddingHorizontal: 16,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Transitional hint: deck just emptied, next picks loading ── */}
      {displayState === 'transitioning' && (
        <View style={{ backgroundColor: '#fefcf9', borderRadius: 14, padding: 24, alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: '#f0eeeb', shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 6 }}>Selecting what's next…</Text>
          <Text style={{ fontSize: 12, color: '#9e958d', textAlign: 'center', lineHeight: 18 }}>Noting your choices and preparing more picks</Text>
        </View>
      )}

      {/* ── Exhausted refreshing ── */}
      {displayState === 'exhausted_refreshing' && (
        <View style={{ backgroundColor: '#fefcf9', borderRadius: 14, padding: 24, alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: '#f0eeeb', shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 6 }}>Looking further for you…</Text>
          <Text style={{ fontSize: 12, color: '#9e958d', textAlign: 'center', lineHeight: 18 }}>Exploring beyond your recent picks</Text>
        </View>
      )}

      {/* ── Exhausted terminal: all picks seen ── */}
      {displayState === 'exhausted_terminal' && (
        <View style={{ backgroundColor: '#fefcf9', borderRadius: 14, padding: 20, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 22, marginBottom: 12 }}>✓</Text>
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b', marginBottom: 6 }}>You've seen everything</Text>
          <Text style={{ fontSize: 13, color: '#9e958d', textAlign: 'center', lineHeight: 20, marginBottom: 16 }}>
            You've acted on all available picks. Rating more books gives the algorithm fresh signal to work with.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/(tabs)/library' as any)}
            activeOpacity={0.8}
            style={{
              backgroundColor: '#231f1b', borderRadius: 10,
              paddingVertical: 11, paddingHorizontal: 22,
              marginBottom: 10,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#fff' }}>Rate books in your library</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/add-book' as any)}
            activeOpacity={0.75}
            style={{ paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 13, color: '#78716c' }}>Add more books you've read</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Empty (non-exhaustion) ── */}
      {displayState === 'empty' && (
        <View style={{ backgroundColor: '#fefcf9', borderRadius: 14, padding: 20, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 22, marginBottom: 12 }}>✓</Text>
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b', marginBottom: 6 }}>You're caught up</Text>
          <Text style={{ fontSize: 13, color: '#9e958d', textAlign: 'center', lineHeight: 20, marginBottom: 16 }}>
            We'll keep learning as you finish and rate more books.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/(tabs)/library' as any)}
            activeOpacity={0.8}
            style={{
              backgroundColor: '#231f1b', borderRadius: 10,
              paddingVertical: 11, paddingHorizontal: 22,
              marginBottom: 10,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#fff' }}>Go to your library</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/add-book' as any)}
            activeOpacity={0.75}
            style={{ paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 13, color: '#78716c' }}>Add books you've read</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
