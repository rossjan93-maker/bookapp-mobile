import React, {
  useEffect,
  useRef,
  useState,
} from 'react';
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
import { wtStart, wtStepView, wtComplete, wtSkip, wtImportTapped } from '../lib/onboardingAnalytics';

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG   = '#faf9f7';
const INK  = '#1c1917';
const SUB  = '#78716c';
const BORD = '#e7e5e4';
const GRN  = '#15803d';

// ─── Slide definitions ────────────────────────────────────────────────────────
//
// 4 slides: what it is → how recs work → library → import.
// No intake. No survey. Orientation only.

type Slide = {
  icon:     React.ComponentProps<typeof Ionicons>['name'];
  headline: string;
  body:     string;
  accent:   string;
};

const SLIDES: Slide[] = [
  {
    icon:     'sparkles-outline',
    headline: 'Books that actually fit you',
    body:     "readstack builds a picture of your taste from everything you read, rate, and react to \u2014 and uses it to surface books you\u2019d genuinely want to read.",
    accent:   INK,
  },
  {
    icon:     'layers-outline',
    headline: 'Picks that improve over time',
    body:     "Every book you save, dismiss, or rate teaches the engine something. Save what interests you. Dismiss what doesn\u2019t. The next batch will be sharper.",
    accent:   GRN,
  },
  {
    icon:     'library-outline',
    headline: 'Your reading life, all in one place',
    body:     "Log what you\u2019re reading now, mark what\u2019s finished, track your progress, write notes. Your library is the foundation the recommendations are built on.",
    accent:   INK,
  },
  {
    icon:     'cloud-download-outline',
    headline: 'Already reading elsewhere?',
    body:     'If you have a reading history on Goodreads or StoryGraph, import it — it\'s the fastest way to get strong recommendations from day one.',
    accent:   GRN,
  },
];

// ─── Main component ───────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router   = useRouter();
  const [idx,    setIdx]   = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const slide  = SLIDES[idx];
  const isLast = idx === SLIDES.length - 1;

  useEffect(() => { wtStart(); }, []);
  useEffect(() => { wtStepView(idx); }, [idx]);

  // ── Animate between slides ─────────────────────────────────────────────────

  function goTo(next: number) {
    Animated.timing(fadeAnim, { toValue: 0, duration: 90, useNativeDriver: true }).start(() => {
      setIdx(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    });
  }

  // ── Complete walkthrough and enter the app ─────────────────────────────────

  async function finish() {
    wtComplete();
    if (supabase) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await Promise.allSettled([
          supabase.from('profiles').update({ onboarding_completed: true }).eq('id', user.id),
          writeGuidedStep(0), // arm the in-app action-prompt banner
        ]);
      }
    }
    router.replace('/');
  }

  function handleSkip() {
    wtSkip(idx);
    finish();
  }

  function handleNext() {
    if (isLast) {
      finish();
    } else {
      goTo(idx + 1);
    }
  }

  function handleImportNow() {
    wtImportTapped();
    // Mark walkthrough done first, then push to import
    if (supabase) {
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (user) {
          supabase!.from('profiles').update({ onboarding_completed: true }).eq('id', user.id);
          writeGuidedStep(0);
        }
      });
    }
    router.replace('/import/goodreads');
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" />

      {/* Top bar — progress dots + Skip */}
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: Platform.OS === 'android' ? 16 : 8,
          paddingBottom: 12,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {SLIDES.map((_, i) => (
            <View
              key={i}
              style={{
                width:           i === idx ? 22 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: i <= idx ? INK : BORD,
              }}
            />
          ))}
        </View>
        <TouchableOpacity onPress={handleSkip} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={{ fontSize: 14, color: SUB, fontWeight: '500' }}>Skip →</Text>
        </TouchableOpacity>
      </View>

      {/* Slide content */}
      <Animated.View
        style={{
          flex: 1,
          opacity: fadeAnim,
          paddingHorizontal: 24,
          justifyContent: 'center',
          paddingBottom: 120,
        }}
      >
        {/* Icon */}
        <View
          style={{
            width:           80,
            height:          80,
            borderRadius:    40,
            backgroundColor: slide.accent + '12',
            alignItems:      'center',
            justifyContent:  'center',
            marginBottom:    32,
          }}
        >
          <Ionicons name={slide.icon} size={38} color={slide.accent} />
        </View>

        {/* Headline */}
        <Text
          style={{
            fontSize:    28,
            fontWeight:  '800',
            color:       INK,
            lineHeight:  34,
            marginBottom: 16,
          }}
        >
          {slide.headline}
        </Text>

        {/* Body */}
        <Text
          style={{
            fontSize:   16,
            color:      SUB,
            lineHeight: 24,
          }}
        >
          {slide.body}
        </Text>

        {/* Import CTA — only on last slide */}
        {isLast && (
          <TouchableOpacity
            onPress={handleImportNow}
            activeOpacity={0.8}
            style={{
              marginTop:       32,
              backgroundColor: GRN,
              borderRadius:    14,
              paddingVertical: 15,
              alignItems:      'center',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
              Import my library →
            </Text>
          </TouchableOpacity>
        )}
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
            {isLast ? 'Get started →' : 'Next →'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
