// ─── Welcome screens (Phase 1 of new-user flow) ───────────────────────────────
//
// 2 slides only. Job: welcome the user and set expectation.
// Does NOT explain the app in detail — that happens via the in-app walkthrough.
//
// On completion:
//   - Sets profiles.onboarding_completed = true
//   - Writes walkthrough='home' to start the in-app tour
//   - Arms the rec-feed action banner (guidedStep=0)
//   - Navigates to '/' (home tab)

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  SafeAreaView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { writeGuidedStep } from '../components/OnboardingWalkthrough';
import { writeWtStep, wtEvt_started, wtEvt_stepViewed, wtEvt_stepCompleted, wtEvt_skipped } from '../lib/walkthroughEngine';

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG   = '#faf9f7';
const INK  = '#1c1917';
const SUB  = '#78716c';
const BORD = '#e7e5e4';

// ─── Slides ───────────────────────────────────────────────────────────────────

type Slide = {
  icon:     React.ComponentProps<typeof Ionicons>['name'];
  headline: string;
  body:     string;
};

const SLIDES: Slide[] = [
  {
    icon:     'book-outline',
    headline: 'Welcome to readstack',
    body:     "Your personal book companion. Track your reading, build your library, and get picks that actually match your taste.",
  },
  {
    icon:     'trending-up-outline',
    headline: 'It gets better as you read',
    body:     "Every book you save, rate, or dismiss teaches readstack your taste. The more you use it, the sharper your recommendations get.",
  },
];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router   = useRouter();
  const [idx,    setIdx]   = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const slide  = SLIDES[idx];
  const isLast = idx === SLIDES.length - 1;

  useEffect(() => { wtEvt_started(); }, []);
  useEffect(() => { wtEvt_stepViewed(`slide_${idx}` as any); }, [idx]);

  function goTo(next: number) {
    Animated.timing(fadeAnim, { toValue: 0, duration: 80, useNativeDriver: true }).start(() => {
      setIdx(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  }

  async function finish() {
    wtEvt_stepCompleted(`slide_${idx}` as any);
    if (supabase) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await Promise.allSettled([
          supabase.from('profiles').update({ onboarding_completed: true }).eq('id', user.id),
          writeGuidedStep(0),       // arm rec-feed action banner
          writeWtStep('home'),      // start the in-app walkthrough at Home
        ]);
      }
    }
    router.replace('/');
  }

  function handleSkip() {
    wtEvt_skipped(`slide_${idx}` as any);
    finish();
  }

  function handleNext() {
    if (isLast) {
      finish();
    } else {
      goTo(idx + 1);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" />

      {/* Top bar */}
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop:        Platform.OS === 'android' ? 16 : 8,
          paddingBottom:     12,
          flexDirection:     'row',
          alignItems:        'center',
          justifyContent:    'space-between',
        }}
      >
        {/* Progress dots */}
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {SLIDES.map((_, i) => (
            <View
              key={i}
              style={{
                width:           i === idx ? 20 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: i <= idx ? INK : BORD,
              }}
            />
          ))}
        </View>
        <TouchableOpacity onPress={handleSkip} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ fontSize: 14, color: SUB, fontWeight: '500' }}>Skip</Text>
        </TouchableOpacity>
      </View>

      {/* Slide */}
      <Animated.View
        style={{
          flex:              1,
          opacity:           fadeAnim,
          paddingHorizontal: 26,
          justifyContent:    'center',
          paddingBottom:     120,
        }}
      >
        <View
          style={{
            width:           72,
            height:          72,
            borderRadius:    36,
            backgroundColor: INK + '10',
            alignItems:      'center',
            justifyContent:  'center',
            marginBottom:    30,
          }}
        >
          <Ionicons name={slide.icon} size={34} color={INK} />
        </View>

        <Text style={{ fontSize: 30, fontWeight: '800', color: INK, lineHeight: 36, marginBottom: 14 }}>
          {slide.headline}
        </Text>

        <Text style={{ fontSize: 16, color: SUB, lineHeight: 25 }}>
          {slide.body}
        </Text>
      </Animated.View>

      {/* Bottom CTA */}
      <View
        style={{
          position:          'absolute',
          bottom: 0, left: 0, right: 0,
          backgroundColor:   BG,
          borderTopWidth:    1,
          borderTopColor:    BORD,
          paddingHorizontal: 20,
          paddingVertical:   14,
        }}
      >
        <TouchableOpacity
          onPress={handleNext}
          activeOpacity={0.8}
          style={{
            backgroundColor: INK,
            borderRadius:    14,
            paddingVertical: 15,
            alignItems:      'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
            {isLast ? 'Get started \u2192' : 'Next \u2192'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
