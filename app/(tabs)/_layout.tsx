import { createContext, useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, PanResponder, View } from 'react-native';
import { Tabs, useRouter, useSegments } from 'expo-router';
import { CustomTabBar } from '../../components/CustomTabBar';
import { supabase } from '../../lib/supabase';
import { loadRecPayload } from '../../lib/recPayloadCache';
import { getRecSession, setRecSession } from '../../lib/recSession';
import {
  type GuidedStep,
  readGuidedStep,
  writeGuidedStep,
  GuidedTourContext,
} from '../../components/OnboardingWalkthrough';
import {
  type WtStep,
  WalkthroughContext,
  readWtStep,
  writeWtStep,
  nextWtStep,
  WT_DEFS,
  wtEvt_stepCompleted,
  wtEvt_skipped,
  wtEvt_finished,
} from '../../lib/walkthroughEngine';
import { WalkthroughOverlay } from '../../components/WalkthroughOverlay';
import {
  readOnboardingStage,
  writeOnboardingStage,
} from '../../lib/onboardingStage';

// ─── Badge context ────────────────────────────────────────────────────────────

type BadgeContextType = {
  newRecCount: number;
  setNewRecCount: (n: number) => void;
};

export const BadgeContext = createContext<BadgeContextType>({
  newRecCount: 0,
  setNewRecCount: () => {},
});

// ─── Tab ordering (matches Tabs.Screen declaration order) ─────────────────────

const TAB_ROUTES = ['index', 'search', 'library', 'profile'] as const;

const TAB_PATHS = {
  index:   '/'               as const,
  search:  '/(tabs)/search'  as const,
  library: '/(tabs)/library' as const,
  profile: '/(tabs)/profile' as const,
} satisfies Record<typeof TAB_ROUTES[number], string>;

// ─── Swipe tuning constants ────────────────────────────────────────────────────
//
// Tightened so inter-tab swipe never fights a horizontal carousel scroll
// (Reading Now, Library shelves, Recommendations, Insights).
//
// Heuristics for capture (all must hold):
//   1. Finger has moved ≥ GESTURE_FLOOR px in either axis (real drag, not a tap)
//   2. Horizontal motion is ≥ GESTURE_RATIO × vertical motion (clearly sideways)
//   3. Vertical motion is ≤ GESTURE_VFLOOR px (not a list/scroll-pane drag)
//
// Heuristics for commit (any one):
//   • Distance: |dx| ≥ SWIPE_DISTANCE
//   • Velocity: |vx| ≥ SWIPE_VELOCITY
//
// Children always win — onPanResponderTerminationRequest:true lets a ScrollView
// reclaim the gesture mid-swipe, snapping our content back via springBack().

const SCREEN_WIDTH     = Dimensions.get('window').width;
const SWIPE_DISTANCE   = 56;   // px to commit (was 28 — too easy to misfire)
const SWIPE_VELOCITY   = 0.45; // px/ms — fast flick bypasses distance (was 0.22)
const GESTURE_RATIO    = 2.5;  // horizontal must be ≥ 2.5× vertical (was 1.2)
const GESTURE_FLOOR    = 16;   // px minimum horizontal travel (was 6)
const GESTURE_VFLOOR   = 14;   // px maximum vertical travel before yielding
const RESISTANCE       = 0.55; // content moves at 55% of finger travel

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function TabsLayout() {
  const [newRecCount,   setNewRecCount]   = useState(0);
  const [guidedStep,    setGuidedStep]    = useState<GuidedStep>(99);
  const [wtStep,        setWtStep]        = useState<WtStep | null>(null);
  const router        = useRouter();
  const segments      = useSegments();
  const routerRef     = useRef(router);
  const segmentsRef   = useRef(segments);
  useEffect(() => { routerRef.current   = router;   }, [router]);
  useEffect(() => { segmentsRef.current = segments; }, [segments]);

  // Load the guided-tour step (rec-feed action banner)
  useEffect(() => {
    readGuidedStep().then(setGuidedStep);
  }, []);

  // Single authoritative onboarding stage read at mount.
  //
  // Stage values (readstack_onboarding_stage_v1):
  //   null          — pre-existing user; no onboarding, no walkthrough
  //   'walkthrough' — new user; read sub-step and start the overlay tour
  //   'final_setup' — walkthrough done; redirect to /onboarding-import
  //   'done'        — fully complete; normal app experience
  //
  // No multi-key inference, no safety-valve fallbacks.  advanceWt() and
  // skipWt() are the only code paths that advance the stage forward.
  useEffect(() => {
    readOnboardingStage().then(async stage => {
      console.log('[STAGE] mount_read', { stage });

      if (stage === 'final_setup') {
        console.log('[STAGE] final_setup — redirecting to /onboarding-import');
        routerRef.current.replace('/onboarding-import' as any);
        return;
      }

      // Mid-quit recovery: the user started the "Pick genres" intake but did
      // not finish (RecEntryScreen writes a per-user draft after each phase).
      // Send them back to /onboarding-questions, where the draft is rehydrated
      // and they resume from the last completed step.
      if (stage === 'intake_active') {
        console.log('[STAGE] intake_active — redirecting to /onboarding-questions');
        routerRef.current.replace('/onboarding-questions' as any);
        return;
      }

      if (stage === 'walkthrough') {
        const sub = await readWtStep();
        const step = sub ?? 'home';
        console.log('[STAGE] walkthrough — wtStep:', step);

        // Recovery cases that both advance to final_setup:
        //
        //   step='done'  — walkthrough wrote wtStep='done' but stage='final_setup'
        //                  never persisted (app closed between the two writes).
        //
        //   step='inbox' — deprecated; the notes tab is now href:null so this
        //                  step can no longer be shown. Treat as complete and
        //                  advance to the import step.
        if (step === 'done' || step === 'inbox') {
          const reason = step === 'inbox' ? 'inbox_deprecated' : 'done_recovery';
          console.log('[STAGE] walkthrough recovery —', reason, '→ writing final_setup → /onboarding-import');
          await writeOnboardingStage('final_setup');
          routerRef.current.replace('/onboarding-import' as any);
          return;
        }

        setWtStep(step);
        if (step !== 'home') {
          const def = WT_DEFS[step as keyof typeof WT_DEFS];
          if (def?.tab) {
            setTimeout(() => {
              routerRef.current.navigate({ pathname: def.tab as any });
            }, 80);
          }
        }
        return;
      }

      // null or 'done' — no walkthrough overlay, normal app.
      // Signal 'done' to consumers (e.g. search.tsx entry check) so they know
      // loading is complete and can proceed with their own checks.
      console.log('[STAGE] no onboarding action', { stage });
      setWtStep('done');
    });
  }, []);

  // Simplify the legacy advance: jump straight to 99 (overlay banners removed)
  function advanceGuided(fromStep: GuidedStep) {
    const next: GuidedStep = 99;
    setGuidedStep(next);
    writeGuidedStep(next);
  }

  // Walkthrough advance: move to next step + navigate to its tab.
  // On completion ('done'), write stage='final_setup' BEFORE updating wtStep so
  // search.tsx's entry-check effect never sees wtStep='done' while stage is still
  // 'walkthrough' (which would trigger RecEntryScreen prematurely).
  function advanceWt() {
    if (!wtStep || wtStep === 'done') return;
    wtEvt_stepCompleted(wtStep);
    const next = nextWtStep(wtStep);
    console.log('[WT_ADVANCE] step', wtStep, '→', next);
    if (next !== 'done') {
      setWtStep(next);
      writeWtStep(next);
      const def = WT_DEFS[next as keyof typeof WT_DEFS];
      if (def?.tab) {
        routerRef.current.navigate({ pathname: def.tab as any });
      }
    } else {
      wtEvt_finished();
      console.log('[STAGE] walkthrough_complete — writing final_setup → /onboarding-import');
      writeOnboardingStage('final_setup').then(() => {
        // Update state + storage only after stage is persisted, then navigate.
        // This ensures consumers never observe wtStep='done' while stage='walkthrough'.
        setWtStep('done');
        writeWtStep('done');
        routerRef.current.replace('/onboarding-import' as any);
      });
    }
  }

  // Walkthrough skip: close overlay and advance stage to final_setup.
  // Skipping the tour is not skipping onboarding — the import step still shows.
  function skipWt() {
    if (!wtStep || wtStep === 'done') return;
    wtEvt_skipped(wtStep);
    setWtStep('done');
    writeWtStep('done');
    console.log('[STAGE] walkthrough_skipped — writing final_setup → /onboarding-import');
    writeOnboardingStage('final_setup').then(() => {
      routerRef.current.replace('/onboarding-import' as any);
    });
  }

  useEffect(() => {
    async function fetchCount() {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { count } = await supabase
        .from('recommendations')
        .select('*', { count: 'exact', head: true })
        .eq('to_user_id', user.id)
        .eq('status', 'sent');
      setNewRecCount(count ?? 0);
    }
    fetchCount();
  }, []);

  // Pre-warm the rec session from AsyncStorage so the Recommend tab renders
  // instantly on cold start (app restart) without a loading flash.
  // Runs silently in the background while the user is on the Home screen.
  useEffect(() => {
    async function prewarmRecs() {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      if (getRecSession()?.userId === user.id) return; // already warm
      const persisted = await loadRecPayload(user.id);
      if (!persisted) return;
      if (persisted.recs.length === 0 && persisted.continuations.length === 0) return;
      if (getRecSession()?.userId === user.id) return; // filled by another path
      setRecSession({
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
      });
    }
    prewarmRecs();
  }, []);

  const guidedStepRef = useRef<GuidedStep>(guidedStep);
  useEffect(() => { guidedStepRef.current = guidedStep; }, [guidedStep]);

  const wtStepRef = useRef<WtStep | null>(wtStep);
  useEffect(() => { wtStepRef.current = wtStep; }, [wtStep]);

  // ── Pager-style swipe gesture ──────────────────────────────────────────────
  //
  // Architecture: Animated.Value tracks finger in real time (finger-connected).
  // On release: if distance OR velocity meets threshold → animate to edge then
  // navigate + reset; otherwise → spring back to center.
  // The Animated.View wraps just the Tabs (not the overlays), so the overlay
  // stays fixed while the content slides.

  const panX = useRef(new Animated.Value(0)).current;

  function resolveCurrentRoute(): { route: string; idx: number } {
    const segs     = segmentsRef.current;
    const lastSeg  = segs[segs.length - 1] ?? 'index';
    const route    = lastSeg === '(tabs)' ? 'index' : lastSeg;
    const idx      = TAB_ROUTES.indexOf(route as typeof TAB_ROUTES[number]);
    return { route, idx };
  }

  function springBack() {
    Animated.spring(panX, {
      toValue: 0,
      tension:  260,
      friction: 26,
      useNativeDriver: true,
    }).start();
  }

  const panResponder = useRef(
    PanResponder.create({
      // Never steal taps or capture-phase events — children always get first crack.
      onStartShouldSetPanResponder:        () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture:  () => false,

      onMoveShouldSetPanResponder: (_, { dx, dy }) => {
        // Never intercept during the legacy guided tour or the walkthrough overlay.
        // (The import onboarding step is a separate route — PanResponder is not mounted there.)
        if (guidedStepRef.current < 99) return false;
        const ws = wtStepRef.current;
        if (ws === 'home' || ws === 'recommend' || ws === 'library' || ws === 'inbox') return false;

        // Strict horizontal intent:
        //   - Past the horizontal floor (real drag, not jitter)
        //   - Vertical motion below its own floor (not a list pan)
        //   - Horizontal dominance ≥ 2.5× vertical
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx < GESTURE_FLOOR)         return false;
        if (absDy > GESTURE_VFLOOR)        return false;
        if (absDx < absDy * GESTURE_RATIO) return false;
        return true;
      },

      // Always yield to a child that requests termination (e.g. an inner
      // ScrollView whose own pan handler activated a moment later). springBack
      // resets our content cleanly so the user never sees stuck offset.
      onPanResponderTerminationRequest: () => true,

      // Content follows finger in real time — tactile connection
      onPanResponderMove: (_, { dx }) => {
        panX.setValue(dx * RESISTANCE);
      },

      onPanResponderRelease: (_, { dx, vx }) => {
        const { idx } = resolveCurrentRoute();
        if (idx === -1) { springBack(); return; }

        const goLeft  = dx < -SWIPE_DISTANCE || vx < -SWIPE_VELOCITY;
        const goRight = dx >  SWIPE_DISTANCE  || vx >  SWIPE_VELOCITY;

        if (goLeft || goRight) {
          const nextIdx = goLeft ? idx + 1 : idx - 1;
          if (nextIdx >= 0 && nextIdx < TAB_ROUTES.length) {
            // Snap confidently to edge, then switch + reset (feels decisive)
            Animated.timing(panX, {
              toValue:  goLeft ? -SCREEN_WIDTH : SCREEN_WIDTH,
              duration: 140,
              useNativeDriver: true,
            }).start(() => {
              panX.setValue(0);
              routerRef.current.navigate({ pathname: TAB_PATHS[TAB_ROUTES[nextIdx]] });
            });
            return;
          }
        }

        // Not enough — spring back to rest (bouncy, not sluggish)
        springBack();
      },

      // Gesture stolen by a child (e.g. ScrollView lock) → snap back cleanly
      onPanResponderTerminate: () => {
        springBack();
      },
    })
  ).current;

  return (
    <BadgeContext.Provider value={{ newRecCount, setNewRecCount }}>
      <GuidedTourContext.Provider value={{ step: guidedStep, advance: advanceGuided }}>
        <WalkthroughContext.Provider value={{ wtStep, advance: advanceWt, skip: skipWt }}>

          {/* Clip so the sliding content never bleeds outside the screen */}
          <View style={{ flex: 1, overflow: 'hidden' }}>

            {/* ── Tabs track the finger ── */}
            <Animated.View
              style={{ flex: 1, transform: [{ translateX: panX }] }}
              {...panResponder.panHandlers}
            >
              <Tabs
                tabBar={(props) => <CustomTabBar {...props} />}
                screenOptions={{ headerShown: false }}
              >
                <Tabs.Screen name="index"   options={{ title: 'Home'    }} />
                <Tabs.Screen name="search"  options={{ title: 'For You' }} />
                <Tabs.Screen name="library" options={{ title: 'Library' }} />
                <Tabs.Screen name="notes"   options={{ title: 'Inbox',  href: null }} />
                <Tabs.Screen name="clubs"   options={{ title: 'Clubs',  href: null }} />
                <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
              </Tabs>
            </Animated.View>

            {/* ── In-app walkthrough overlay (Home + Library steps) ── */}
            <WalkthroughOverlay />

          </View>
        </WalkthroughContext.Provider>
      </GuidedTourContext.Provider>
    </BadgeContext.Provider>
  );
}
