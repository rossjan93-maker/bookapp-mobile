import { createContext, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import { Tabs, useRouter, useSegments } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import {
  type GuidedStep,
  readGuidedStep,
  writeGuidedStep,
  GuidedNotedToast,
  GuidedLibraryBanner,
  GuidedTourContext,
} from '../../components/OnboardingWalkthrough';

// ─── Badge context ────────────────────────────────────────────────────────────

type BadgeContextType = {
  newRecCount: number;
  setNewRecCount: (n: number) => void;
};

export const BadgeContext = createContext<BadgeContextType>({
  newRecCount: 0,
  setNewRecCount: () => {},
});

// ─── Pulsing dot shown on Library tab when step === 2 ────────────────────────

function PulsingDot() {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale,   { toValue: 1.8, duration: 700, useNativeDriver: true }),
          Animated.timing(scale,   { toValue: 1.0, duration: 700, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.2, duration: 700, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1.0, duration: 700, useNativeDriver: true }),
        ]),
      ]),
    ).start();
  }, []);

  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: -3,
        right: -6,
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: '#15803d',
        transform: [{ scale }],
        opacity,
      }}
    />
  );
}

// ─── Tab ordering (matches Tabs.Screen declaration order) ─────────────────────

const TAB_ROUTES = ['index', 'search', 'library', 'notes', 'profile'] as const;

// Typed route paths for each tab.
// The index tab's canonical pathname is '/' (not '/(tabs)/index') in Expo Router.
const TAB_PATHS = {
  index:   '/'               as const,
  search:  '/(tabs)/search'  as const,
  library: '/(tabs)/library' as const,
  notes:   '/(tabs)/notes'   as const,
  profile: '/(tabs)/profile' as const,
} satisfies Record<typeof TAB_ROUTES[number], string>;

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function TabsLayout() {
  const [newRecCount, setNewRecCount] = useState(0);
  const [guidedStep,  setGuidedStep]  = useState<GuidedStep>(99);
  const [showNoted,   setShowNoted]   = useState(false);
  const notedShown = useRef(false);
  const router        = useRouter();
  const segments      = useSegments();
  const routerRef     = useRef(router);
  const segmentsRef   = useRef(segments);
  useEffect(() => { routerRef.current   = router;   }, [router]);
  useEffect(() => { segmentsRef.current = segments; }, [segments]);

  // Load guided step from storage on mount
  useEffect(() => {
    readGuidedStep().then(setGuidedStep);
  }, []);

  // When step advances to 1, show "Noted" toast
  useEffect(() => {
    if (guidedStep === 1 && !notedShown.current) {
      notedShown.current = true;
      setShowNoted(true);
    }
  }, [guidedStep]);

  function advanceGuided(fromStep: GuidedStep) {
    const next: GuidedStep =
      fromStep === 0 ? 1
      : fromStep === 1 ? 2
      : 99;
    setGuidedStep(next);
    writeGuidedStep(next);
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

  // Keep a ref to guidedStep so the panResponder closure always sees latest value
  const guidedStepRef = useRef<GuidedStep>(guidedStep);
  useEffect(() => {
    guidedStepRef.current = guidedStep;
  }, [guidedStep]);

  // ── Swipe-to-switch-tabs gesture ──────────────────────────────────────────
  // Detects a horizontal swipe (≥ 50px, horizontal-dominant) and navigates
  // to the adjacent tab. Suppressed on 'search' tab (card swipe conflicts)
  // and while any onboarding walkthrough overlay is active (guidedStep < 99).
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        const { dx, dy } = gestureState;

        // Suppress capture during any active onboarding walkthrough step
        if (guidedStepRef.current < 99) return false;

        // Determine current route (using ref to avoid stale closure)
        const segs = segmentsRef.current;
        const lastSeg = segs[segs.length - 1] ?? 'index';
        const currentRoute = lastSeg === '(tabs)' ? 'index' : lastSeg;

        // Suppress capture on search tab — card swipe interactions must take priority
        if (currentRoute === 'search') return false;

        // Only capture if the swipe is clearly horizontal-dominant
        return Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 10;
      },
      onPanResponderRelease: (_, gestureState) => {
        const { dx, dy } = gestureState;
        // Must be horizontal-dominant and exceed minimum swipe distance
        if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;

        // Determine current tab from segments (using ref to always read latest)
        const segs = segmentsRef.current;
        const lastSeg = segs[segs.length - 1] ?? 'index';
        const currentRoute = lastSeg === '(tabs)' ? 'index' : lastSeg;

        const currentIdx = TAB_ROUTES.indexOf(currentRoute as typeof TAB_ROUTES[number]);
        if (currentIdx === -1) return;

        if (dx < 0) {
          // Swipe left → navigate to next tab
          const nextIdx = currentIdx + 1;
          if (nextIdx < TAB_ROUTES.length) {
            routerRef.current.navigate({ pathname: TAB_PATHS[TAB_ROUTES[nextIdx]] });
          }
        } else {
          // Swipe right → navigate to previous tab
          const prevIdx = currentIdx - 1;
          if (prevIdx >= 0) {
            routerRef.current.navigate({ pathname: TAB_PATHS[TAB_ROUTES[prevIdx]] });
          }
        }
      },
    })
  ).current;

  return (
    <BadgeContext.Provider value={{ newRecCount, setNewRecCount }}>
      <GuidedTourContext.Provider value={{ step: guidedStep, advance: advanceGuided }}>
        <View style={{ flex: 1 }} {...panResponder.panHandlers}>
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
            listeners={{
              tabPress: () => {
                if (guidedStep === 2) advanceGuided(2);
              },
            }}
            options={{
              title: 'Library',
              tabBarIcon: ({ focused, color, size }) => (
                <>
                  <Ionicons
                    name={focused ? 'library' : 'library-outline'}
                    size={size}
                    color={color}
                  />
                  {guidedStep === 2 && <PulsingDot />}
                </>
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

        {/* Step 1 — "Noted" toast */}
        {showNoted && (
          <GuidedNotedToast
            onDone={() => {
              setShowNoted(false);
              advanceGuided(1);
            }}
          />
        )}

        {/* Step 2 — Library hint banner */}
        {guidedStep === 2 && (
          <GuidedLibraryBanner onDismiss={() => advanceGuided(2)} />
        )}
        </View>
      </GuidedTourContext.Provider>
    </BadgeContext.Provider>
  );
}
