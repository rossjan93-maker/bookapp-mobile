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

      if (stage === 'walkthrough') {
        const sub = await readWtStep();
        const step = sub ?? 'home';
        console.log('[STAGE] walkthrough — wtStep:', step);

        // Recovery: walkthrough wrote wtStep='done' but stage='final_setup'
        // never persisted (e.g. app closed between the two writes). Recover by
        // writing final_setup and navigating to onboarding-import.
        if (step === 'done') {
          console.log('[STAGE] walkthrough+done — recovery: writing final_setup → /onboarding-import');
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
