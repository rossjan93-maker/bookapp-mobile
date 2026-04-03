import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  LayoutAnimation,
  Platform,
  Text,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getPersonalizedRecsWithExpert } from '../lib/recommender';
import type { ScoredBook, QualityGate } from '../lib/recommender';
import type { TasteProfile } from '../lib/tasteProfile';
import type { RecEntitlement } from '../lib/recEntitlement';
import { loadFeedbackContext, persistFeedback } from '../lib/recFeedback';
import type { FeedbackContext } from '../lib/recFeedback';
import { getBookTraits } from '../lib/bookTraits';
import type { ReaderThesis } from '../lib/expertRec';
import { type RecSessionCache, getRecSession, setRecSession } from '../lib/recSession';
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
          feedbackCtx, undefined,
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
    return (
      <View style={{ marginBottom: 36 }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 12 }}>
          For You
        </Text>
        <View
          ref={wtRef}
          style={{
            backgroundColor: '#fff', borderRadius: 16,
            overflow: 'hidden',
            shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
          }}
        >
          {/* Header strip */}
          <View style={{ backgroundColor: '#faf9f7', borderBottomWidth: 1, borderBottomColor: '#f0ede8', padding: 20, paddingBottom: 16 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#1c1917', letterSpacing: -0.2, marginBottom: 6 }}>
              We're not guessing yet.
            </Text>
            <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
              Recommendations only unlock when we have enough signal to make picks worth trusting. Add some reading history and we'll take it from there.
            </Text>
          </View>

          <View style={{ padding: 16, gap: 10 }}>
            {/* CTA 1 — Import library (primary) */}
            <TouchableOpacity
              onPress={() => router.push('/import/goodreads' as any)}
              activeOpacity={0.82}
              style={{
                backgroundColor: '#1c1917', borderRadius: 12, paddingVertical: 14,
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

            {/* CTA 2 — Add books manually (secondary) */}
            <TouchableOpacity
              onPress={() => router.push('/add-book' as any)}
              activeOpacity={0.8}
              style={{
                borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
                flexDirection: 'row', alignItems: 'center', gap: 12,
                borderWidth: 1.5, borderColor: '#e7e5e4', backgroundColor: '#faf9f7',
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#f0ede8', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>＋</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', lineHeight: 19 }}>Add books you've read</Text>
                <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }}>Search and rate a few favourites</Text>
              </View>
              <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
            </TouchableOpacity>

            {/* CTA 3 — Answer preference questions (tertiary) */}
            <TouchableOpacity
              onPress={() => router.push('/edit-preferences' as any)}
              activeOpacity={0.8}
              style={{
                borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
                flexDirection: 'row', alignItems: 'center', gap: 12,
                borderWidth: 1.5, borderColor: '#e7e5e4', backgroundColor: '#faf9f7',
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#f0ede8', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>🎯</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', lineHeight: 19 }}>Answer a few quick questions</Text>
                <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }}>Genres, pace, style — under 90 seconds</Text>
              </View>
              <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
            </TouchableOpacity>

            {/* Supporting line */}
            <Text style={{ fontSize: 11, color: '#c4b5a5', textAlign: 'center', paddingTop: 2, paddingBottom: 4, lineHeight: 17 }}>
              Five rated books is enough to unlock your first picks.
            </Text>
          </View>
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
        {/* Background refresh: single breathing dot — nearly invisible, no disruption */}
        {displayState === 'ready_refreshing' && <RefreshingDot />}
      </View>

      {/* ── First-load: bespoke deck-assembling experience ── */}
      {displayState === 'loading_initial' && <DeckAssemblingLoader />}

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

          {/* ── Currently Reading bucket ── */}
          {visibleConts.length > 0 && (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, marginTop: 6, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: '#15803d' }}>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', letterSpacing: -0.1 }}>Currently Reading</Text>
                  <Text style={{ fontSize: 11, color: '#78716c', marginTop: 1 }}>Pick up where you left off</Text>
                </View>
              </View>
              {visibleConts.map((rec, idx) => {
                const card = (
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
                );
                return idx === 0 && wtRef
                  ? <View key={rec.id} ref={wtRef}>{card}</View>
                  : card;
              })}
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
              {visibleDiscs.map((rec, idx) => {
                const isFirstVisible = idx === 0 && visibleConts.length === 0;
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

      {/* ── Quality gate: insufficient candidate pool — full actionable CTA ── */}
      {displayState === 'quality_gated' && tier >= 1 && recsQualityGate === 'insufficient_pool' && (
        <View
          style={{
            backgroundColor: '#fff', borderRadius: 16,
            overflow: 'hidden',
            shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 }, elevation: 2,
            marginBottom: 16,
          }}
        >
          {/* Header strip */}
          <View style={{ backgroundColor: '#faf9f7', borderBottomWidth: 1, borderBottomColor: '#f0ede8', padding: 20, paddingBottom: 16 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#1c1917', letterSpacing: -0.2, marginBottom: 6 }}>
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
                backgroundColor: '#1c1917', borderRadius: 12, paddingVertical: 14,
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
                borderWidth: 1.5, borderColor: '#e7e5e4', backgroundColor: '#faf9f7',
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#f0ede8', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>＋</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', lineHeight: 19 }}>Add books you've read</Text>
                <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }}>Search and rate a few favourites</Text>
              </View>
              <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
            </TouchableOpacity>

            {/* CTA 3 — Refine preferences */}
            <TouchableOpacity
              onPress={() => router.push('/edit-preferences' as any)}
              activeOpacity={0.8}
              style={{
                borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16,
                flexDirection: 'row', alignItems: 'center', gap: 12,
                borderWidth: 1.5, borderColor: '#e7e5e4', backgroundColor: '#faf9f7',
              }}
            >
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: '#f0ede8', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 15 }}>🎯</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', lineHeight: 19 }}>Refine your preferences</Text>
                <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 1 }}>Genres, pace, style — widens the candidate pool</Text>
              </View>
              <Text style={{ fontSize: 16, color: '#d6d3d1' }}>›</Text>
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
          backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 16,
          borderWidth: 1, borderColor: '#e7e5e4',
        }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
            No close matches in the current catalog
          </Text>
          <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
            Your taste profile is strong but catalog coverage is limited right now. Try removing some filters or check back later.
          </Text>
        </View>
      )}

      {/* ── Pipeline timeout: network hung for more than 12s ── */}
      {displayState === 'pipeline_timed_out' && (
        <View style={{
          backgroundColor: '#fff', borderRadius: 14, padding: 20, marginBottom: 16,
          borderWidth: 1, borderColor: '#e7e5e4',
          shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 }, elevation: 1,
        }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
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
              backgroundColor: '#1c1917', borderRadius: 8,
              paddingVertical: 10, paddingHorizontal: 16,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Transitional hint: deck just emptied, next picks loading ── */}
      {displayState === 'transitioning' && (
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 24, alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: '#f0eeeb', shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>Selecting what's next…</Text>
          <Text style={{ fontSize: 12, color: '#a8a29e', textAlign: 'center', lineHeight: 18 }}>Noting your choices and preparing more picks</Text>
        </View>
      )}

      {/* ── Exhausted refreshing ── */}
      {displayState === 'exhausted_refreshing' && (
        <View style={{ backgroundColor: '#fff', borderRadius: 14, padding: 24, alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: '#f0eeeb', shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>Looking further for you…</Text>
          <Text style={{ fontSize: 12, color: '#a8a29e', textAlign: 'center', lineHeight: 18 }}>Exploring beyond your recent picks</Text>
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
