import { createContext, useContext, useEffect, useRef } from 'react';
import { Animated, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

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
        opacity: fadeIn,
        marginHorizontal: 0,
        marginBottom: 12,
        marginTop: 4,
        backgroundColor: '#1c1917',
        borderRadius: 12,
        paddingVertical: 13,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <Ionicons name="information-circle-outline" size={18} color="#a8a29e" />
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#faf9f7', fontSize: 13, fontWeight: '600', lineHeight: 18 }}>
          Save, dismiss, or tap "More like this"
        </Text>
        <Text style={{ color: '#a8a29e', fontSize: 12, lineHeight: 17, marginTop: 1 }}>
          Every choice tunes your future picks
        </Text>
      </View>
      <TouchableOpacity
        onPress={() => advance(0)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
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
        position: 'absolute',
        bottom: 90,
        left: 24,
        right: 24,
        opacity,
        backgroundColor: '#15803d',
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        shadowColor: '#000',
        shadowOpacity: 0.12,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 4,
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
        position: 'absolute',
        bottom: 70,
        left: 0,
        right: 0,
        paddingHorizontal: 16,
        transform: [{ translateY: slideIn }],
        opacity,
      }}
    >
      <TouchableOpacity
        onPress={onDismiss}
        activeOpacity={0.9}
        style={{
          backgroundColor: '#1c1917',
          borderRadius: 12,
          paddingVertical: 13,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Ionicons name="library-outline" size={18} color="#a8a29e" />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#faf9f7', fontSize: 13, fontWeight: '600' }}>
            Your saved books are in Library
          </Text>
          <Text style={{ color: '#a8a29e', fontSize: 12, marginTop: 1 }}>
            Tap Library below to explore
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#78716c" />
      </TouchableOpacity>
    </Animated.View>
  );
}
