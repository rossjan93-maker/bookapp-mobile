import { createContext, useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, PanResponder, View } from 'react-native';
import { Tabs, useRouter, useSegments } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
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
  getImportObState,
  setImportObState,
} from '../../components/OnboardingImportPrompt';

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

const TAB_ROUTES = ['index', 'search', 'library', 'notes', 'profile'] as const;

const TAB_PATHS = {
  index:   '/'               as const,
  search:  '/(tabs)/search'  as const,
  library: '/(tabs)/library' as const,
  notes:   '/(tabs)/notes'   as const,
  profile: '/(tabs)/profile' as const,
} satisfies Record<typeof TAB_ROUTES[number], string>;

// ─── Swipe tuning constants ────────────────────────────────────────────────────
//
// Old values → new values:
//   Recognition ratio:   1.5 → 1.2   (horizontal intent recognized sooner)
//   Recognition floor:   10px → 6px   (less movement needed to start capture)
//   Switch distance:     50px → 28px  (much less drag needed to commit)
//   Velocity trigger:    none → 0.22  (fast flick always works, regardless of distance)
//   Resistance:          none → 0.62  (content follows finger at 62% speed, tactile feel)
//   Snap animation:      none → spring(tension:260, friction:26) on cancel
//   Commit animation:    none → 140ms timing to edge, then navigate + reset

const SCREEN_WIDTH     = Dimensions.get('window').width;
const SWIPE_DISTANCE   = 28;   // px to commit to a tab switch
const SWIPE_VELOCITY   = 0.22; // px/ms — fast flick bypasses distance check
const GESTURE_RATIO    = 1.2;  // horizontal must be this much bigger than vertical
const GESTURE_FLOOR    = 6;    // px minimum before we even evaluate the ratio
const RESISTANCE       = 0.62; // content moves at 62% of finger travel

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

  // Pre-load importObState at mount.
  // Primary purpose: redirect to /onboarding-import if state is 'pending'.
  // This covers the navigate-away-then-reload case: user goes back to the tab
  // shell (e.g. presses browser back) while still pending — we catch them here
  // and send them back to the final onboarding destination.
  //   undefined  — not yet loaded
  //   null       — default; walkthrough not yet completed (no redirect)
  //   'pending'  — walkthrough done, decision not yet made → redirect
  //   'importing' — user tapped Import (no redirect)
  //   'dismissed' — user dismissed (no redirect)
  //   'completed' — import finished (no redirect)
  const importObStateRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    console.log('[IMPORT_OB] preload_start — reading AsyncStorage key readstack_import_ob_v1');
    getImportObState().then(s => {
      importObStateRef.current = s;
      console.log('[IMPORT_OB] preload_complete', { importObState: s });
      if (s === 'pending') {
        console.log('[IMPORT_OB] preload: state is pending — calling router.replace /onboarding-import');
        routerRef.current.replace('/onboarding-import' as any);
        setTimeout(() => {
          console.log('[IMPORT_OB] preload_redirect: segments after replace:', segmentsRef.current);
        }, 150);
      }
    });
  }, []);

  // Load the walkthrough step (in-app overlay tour).
  // If resuming a mid-tour step (e.g. after a reload), navigate to that step's
  // tab so the fixture mounts and the coach card appears immediately.
  useEffect(() => {
    readWtStep().then(s => {
      const step = s ?? 'done';
      console.log('[WT_LOAD] readWtStep raw:', s, '→ resolved step:', step);
      setWtStep(step);
      if (step && step !== 'done' && step !== 'home') {
        const def = WT_DEFS[step as keyof typeof WT_DEFS];
        if (def?.tab) {
          // Short delay lets the router finish its initial render before navigating.
          setTimeout(() => {
            routerRef.current.navigate({ pathname: def.tab as any });
          }, 80);
        }
      }
    });
  }, []);

  // Safety-valve: covers paths where advanceWt() was never called:
  //   - user skipped the tour (skipWt)
  //   - cold-start with a stored 'done' step but importObState still null
  //   - the rare race where importObStateRef was undefined in advanceWt()
  //
  // The mount-redirect useEffect above already handles 'pending' on refresh.
  // Here we only need to act when wtStep arrives at 'done' via a path that
  // didn't go through advanceWt(). We use importObChecked to avoid firing twice.
  const importObChecked = useRef(false);
  useEffect(() => {
    if (wtStep !== 'done') return;
    if (importObChecked.current) return;
    importObChecked.current = true;

    async function maybeNavigateToImportStep() {
      const state = await getImportObState();
      console.log('[IMPORT_OB] safety_valve_check', { state });

      if (state === 'importing' || state === 'dismissed' || state === 'completed') {
        console.log('[IMPORT_OB] safety_valve: skip — already actioned', { state });
        return;
      }

      // null (first time via skip) or 'pending' (fallback — should have been
      // caught by mount-redirect, but navigate anyway as a belt-and-suspenders):
      if (state !== 'pending') {
        await setImportObState('pending');
      }
      console.log('[IMPORT_OB] safety_valve: navigating to /onboarding-import (state was:', state, ')');
      routerRef.current.replace('/onboarding-import' as any);
    }
    maybeNavigateToImportStep();
  }, [wtStep]);

  // Simplify the legacy advance: jump straight to 99 (overlay banners removed)
  function advanceGuided(fromStep: GuidedStep) {
    const next: GuidedStep = 99;
    setGuidedStep(next);
    writeGuidedStep(next);
  }

  // Walkthrough advance: move to next step + navigate to its tab.
  // On completion ('done'), immediately show the import prompt using the
  // pre-loaded importObStateRef — no async gap between overlay closing and
  // the import screen appearing.  The safety-valve useEffect covers edge cases.
  function advanceWt() {
    if (!wtStep || wtStep === 'done') return;
    wtEvt_stepCompleted(wtStep);
    const next = nextWtStep(wtStep);
    console.log('[WT_ADVANCE] step', wtStep, '→', next);
    setWtStep(next);
    writeWtStep(next);
    if (next !== 'done') {
      const def = WT_DEFS[next as keyof typeof WT_DEFS];
      if (def?.tab) {
        routerRef.current.navigate({ pathname: def.tab as any });
      }
    } else {
      wtEvt_finished();
      const importState = importObStateRef.current;
      console.log('[IMPORT_OB] walkthrough_finished_handler', {
        importState,
        importObStateRefValue: importObStateRef.current,
        currentSegments: segmentsRef.current,
      });

      if (importState === null) {
        // First completion: write 'pending' then navigate to the dedicated route.
        // This is the primary happy path — walkthrough just finished.
        setImportObState('pending'); // localStorage write is synchronous on web even though API is async
        importObStateRef.current = 'pending';
        importObChecked.current = true; // safety-valve not needed
        console.log('[IMPORT_OB] decision: writing pending — calling router.replace /onboarding-import');
        routerRef.current.replace('/onboarding-import' as any);
        setTimeout(() => {
          console.log('[IMPORT_OB] segments after router.replace:', segmentsRef.current);
        }, 150);
      } else if (importState === 'pending') {
        // Already pending (mount-redirect ran first, or replayed walkthrough).
        importObChecked.current = true;
        console.log('[IMPORT_OB] decision: already pending — calling router.replace /onboarding-import');
        routerRef.current.replace('/onboarding-import' as any);
        setTimeout(() => {
          console.log('[IMPORT_OB] segments after router.replace:', segmentsRef.current);
        }, 150);
      } else if (importState === undefined) {
        // Pre-load still in flight (rare race) — safety-valve handles it.
        console.log('[IMPORT_OB] decision: deferred to safety-valve — preload ref is still undefined');
      } else {
        // 'importing', 'dismissed', or 'completed' — user already decided; don't redirect.
        importObChecked.current = true;
        console.log('[IMPORT_OB] decision: NO redirect — state is already actioned:', importState,
          '— to re-test, run: localStorage.removeItem("readstack_import_ob_v1") in DevTools');
      }
    }
  }

  // Walkthrough skip: jump to done immediately
  function skipWt() {
    if (!wtStep || wtStep === 'done') return;
    wtEvt_skipped(wtStep);
    setWtStep('done');
    writeWtStep('done');
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
      // Do not steal taps — only evaluate once motion has started
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, { dx, dy }) => {
        // Never intercept during the legacy guided tour or the walkthrough overlay.
        // (The import onboarding step is a separate route — PanResponder is not mounted there.)
        if (guidedStepRef.current < 99) return false;
        const ws = wtStepRef.current;
        if (ws === 'home' || ws === 'recommend' || ws === 'library' || ws === 'inbox') return false;

        // Capture when movement is horizontal-dominant and past the noise floor
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        return absDx > GESTURE_FLOOR && absDx > absDy * GESTURE_RATIO;
      },

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
                screenOptions={{
                  tabBarActiveTintColor:   '#1c1917',
                  tabBarInactiveTintColor: '#a8a29e',
                  tabBarStyle: {
                    borderTopColor: '#e7e5e4',
                    borderTopWidth: 1,
                    paddingBottom: 8,
                    paddingTop: 4,
                    height: 62,
                  },
                  tabBarLabelStyle: {
                    fontSize: 10,
                    fontWeight: '500',
                    marginTop: 2,
                  },
                  headerShown: false,
                }}
              >
                <Tabs.Screen
                  name="index"
                  options={{
                    title: 'Home',
                    tabBarIcon: ({ focused, color }) => (
                      <Ionicons name={focused ? 'home' : 'home-outline'} size={22} color={color} />
                    ),
                  }}
                />
                <Tabs.Screen
                  name="search"
                  options={{
                    title: 'Recommend',
                    tabBarIcon: ({ focused, color }) => (
                      <Ionicons
                        name={focused ? 'paper-plane' : 'paper-plane-outline'}
                        size={22}
                        color={color}
                      />
                    ),
                  }}
                />
                <Tabs.Screen
                  name="library"
                  options={{
                    title: 'Library',
                    tabBarIcon: ({ focused, color }) => (
                      <Ionicons
                        name={focused ? 'library' : 'library-outline'}
                        size={22}
                        color={color}
                      />
                    ),
                  }}
                />
                <Tabs.Screen
                  name="notes"
                  options={{
                    title: 'Inbox',
                    tabBarBadge: newRecCount > 0 ? newRecCount : undefined,
                    tabBarBadgeStyle: { backgroundColor: '#1c1917', fontSize: 10 },
                    tabBarIcon: ({ focused, color }) => (
                      <Ionicons name={focused ? 'mail' : 'mail-outline'} size={22} color={color} />
                    ),
                  }}
                />
                <Tabs.Screen
                  name="profile"
                  options={{
                    title: 'Profile',
                    tabBarIcon: ({ focused, color }) => (
                      <Ionicons
                        name={focused ? 'person-circle' : 'person-circle-outline'}
                        size={22}
                        color={color}
                      />
                    ),
                  }}
                />
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
