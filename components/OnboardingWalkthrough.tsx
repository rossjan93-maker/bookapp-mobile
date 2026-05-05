import { createContext, useContext, useEffect, useRef } from 'react';
import { Animated, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

// ─── Shared overlay positioning ───────────────────────────────────────────────
// All floating tour overlays are positioned this many px above the tab bar.
// Change once here — GuidedNotedToast and GuidedLibraryBanner both reference it.
const OVER_TAB = 76;

// Shared card style tokens used by all three tour banners for visual consistency.
const CARD = {
  borderRadius:    14,
  paddingVertical: 14,
  paddingHorizontal: 16,
  gap:             12,
} as const;

// ─── Persistent state ────────────────────────────────────────────────────────
// Written by onboarding.tsx when the flow completes.
// Values: '0' = waiting for card action | '1' = acted | '2' = library hint | '99' = done

export const GUIDED_TOUR_KEY = 'readstack_guided_v1';

export type GuidedStep = 0 | 1 | 2 | 99;

export async function readGuidedStep(): Promise<GuidedStep> {
  try {
    const val = await AsyncStorage.getItem(GUIDED_TOUR_KEY);
    if (val === null) return 99;
    const n = parseInt(val, 10);
    if (n === 0 || n === 1 || n === 2) return n;
    return 99;
  } catch {
    return 99;
  }
}

export async function writeGuidedStep(step: GuidedStep): Promise<void> {
  try {
    await AsyncStorage.setItem(GUIDED_TOUR_KEY, String(step));
  } catch {}
}

// ─── Context ─────────────────────────────────────────────────────────────────

export type GuidedTourCtx = {
  step: GuidedStep;
  advance: (fromStep: GuidedStep) => void;
};

export const GuidedTourContext = createContext<GuidedTourCtx>({
  step: 99,
  advance: () => {},
});

export function useGuidedTour(): GuidedTourCtx {
  return useContext(GuidedTourContext);
}

// ─── Step 0 — Action prompt (rendered inside the recs screen) ─────────────────
// Shows below the first card. Dismissed only by explicit "Got it" tap —
// never dismissed implicitly by a card action so it can always be read.

export function GuidedActionBanner() {
  const { advance } = useGuidedTour();
  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View
      style={{
        opacity:           fadeIn,
        marginHorizontal:  0,
        marginBottom:      16,
        marginTop:         8,
        backgroundColor:   '#231f1b',
        borderRadius:      CARD.borderRadius,
        paddingVertical:   CARD.paddingVertical,
        paddingHorizontal: CARD.paddingHorizontal,
        flexDirection:     'row',
        alignItems:        'center',
        gap:               CARD.gap,
        shadowColor:       '#000',
        shadowOpacity:     0.10,
        shadowRadius:      8,
        shadowOffset:      { width: 0, height: 2 },
        elevation:         3,
      }}
    >
      <Ionicons name="information-circle-outline" size={19} color="#9e958d" />
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#f5f1ec', fontSize: 13, fontWeight: '600', lineHeight: 18 }}>
          Save, dismiss, or tap "More like this"
        </Text>
        <Text style={{ color: '#9e958d', fontSize: 12, lineHeight: 17, marginTop: 2 }}>
          Every choice tunes your future picks
        </Text>
      </View>
      <TouchableOpacity
        onPress={() => advance(0)}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={{ paddingHorizontal: 4 }}
      >
        <Text style={{ color: '#a3e635', fontSize: 13, fontWeight: '700' }}>Got it</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Step 1 — "Noted" confirmation (rendered by layout overlay) ──────────────

export function GuidedNotedToast({ onDone }: { onDone: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(1600),
      Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start(onDone);
  }, []);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position:          'absolute',
        bottom:            OVER_TAB + 10,
        left:              16,
        right:             16,
        opacity,
        backgroundColor:   '#2f6f3a',
        borderRadius:      CARD.borderRadius,
        paddingVertical:   CARD.paddingVertical,
        paddingHorizontal: CARD.paddingHorizontal,
        flexDirection:     'row',
        alignItems:        'center',
        gap:               CARD.gap,
        shadowColor:       '#000',
        shadowOpacity:     0.12,
        shadowRadius:      8,
        shadowOffset:      { width: 0, height: 2 },
        elevation:         4,
      }}
    >
      <Ionicons name="checkmark-circle" size={20} color="#fff" />
      <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
        Noted — we're already adjusting
      </Text>
    </Animated.View>
  );
}

// ─── Step 2 — Library hint banner (rendered by layout at bottom of tabs) ──────

export function GuidedLibraryBanner({ onDismiss }: { onDismiss: () => void }) {
  const slideIn = useRef(new Animated.Value(80)).current;
  const opacity  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideIn, { toValue: 0, duration: 350, useNativeDriver: true }),
      Animated.timing(opacity,  { toValue: 1, duration: 350, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View
      style={{
        position:          'absolute',
        bottom:            OVER_TAB,
        left:              0,
        right:             0,
        paddingHorizontal: 16,
        transform: [{ translateY: slideIn }],
        opacity,
      }}
    >
      <TouchableOpacity
        onPress={onDismiss}
        activeOpacity={0.9}
        style={{
          backgroundColor:   '#231f1b',
          borderRadius:      CARD.borderRadius,
          paddingVertical:   CARD.paddingVertical,
          paddingHorizontal: CARD.paddingHorizontal,
          flexDirection:     'row',
          alignItems:        'center',
          gap:               CARD.gap,
          shadowColor:       '#000',
          shadowOpacity:     0.10,
          shadowRadius:      8,
          shadowOffset:      { width: 0, height: 2 },
          elevation:         3,
        }}
      >
        <Ionicons name="library-outline" size={18} color="#9e958d" />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#f5f1ec', fontSize: 13, fontWeight: '600' }}>
            Your saved books are in Library
          </Text>
          <Text style={{ color: '#9e958d', fontSize: 12, marginTop: 1 }}>
            Tap Library below to explore
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#78716c" />
      </TouchableOpacity>
    </Animated.View>
  );
}
