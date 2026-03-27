import { createContext, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { Tabs } from 'expo-router';
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

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function TabsLayout() {
  const [newRecCount, setNewRecCount] = useState(0);
  const [guidedStep,  setGuidedStep]  = useState<GuidedStep>(99);
  const [showNoted,   setShowNoted]   = useState(false);
  const notedShown = useRef(false);

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

  return (
    <BadgeContext.Provider value={{ newRecCount, setNewRecCount }}>
      <GuidedTourContext.Provider value={{ step: guidedStep, advance: advanceGuided }}>
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
      </GuidedTourContext.Provider>
    </BadgeContext.Provider>
  );
}
