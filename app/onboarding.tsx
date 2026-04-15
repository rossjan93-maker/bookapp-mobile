// ─── Onboarding introduction ───────────────────────────────────────────────────
//
// Three-slide value proposition screen. This replaces the single welcome
// screen + tooltip walkthrough model.
//
// Flow:
//   Slide 0 — What readstack is
//   Slide 1 — Why the library matters / how recommendations work
//   Slide 2 — How to start (import or add books)
//   CTA      — writes stage='final_setup' → /onboarding-import
//
// The tooltip walkthrough (walkthroughEngine.ts) is preserved as an optional
// feature for users who want to replay the in-app tour, but it no longer
// auto-triggers for new users. New users go directly to the import step.
//
// State contract:
//   onboarding_completed=true is written by onboarding-import.tsx — NOT here.
//   Writing it here would cause returning users on a fresh device to skip the
//   entire sequence. Stage='final_setup' is what enables onboarding-import.tsx
//   to render; the DB flag is belt-and-suspenders for cross-device correctness.

import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Animated,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { writeOnboardingStage } from '../lib/onboardingStage';
import {
  welcomeEvt_started,
  welcomeEvt_completed,
  welcomeEvt_skipped,
  welcomeEvt_handoffStarted,
  introEvt_slideViewed,
} from '../lib/onboardingAnalytics';
import { useOnboardingBridge } from './_layout';
import { BookStackLoader } from '../components/BookStackLoader';

// ─── Palette ──────────────────────────────────────────────────────────────────
const BG   = '#f5f1ec';
const INK  = '#231f1b';
const SUB  = '#6b635c';
const SAGE = '#7b9e7e';
const DUST = '#9e958d';

// ─── Slide definitions ────────────────────────────────────────────────────────
type SlideData = {
  id:        string;
  visual:    'stack' | 'bulb' | 'download';
  title:     string;
  body:      string;
};

const SLIDES: SlideData[] = [
  {
    id:     'what',
    visual: 'stack',
    title:  'Your reading life,\norganised',
    body:   "Track what you're reading, what you've finished, and what you want to read next \u2014 all in one place.",
  },
  {
    id:     'how',
    visual: 'bulb',
    title:  'Recommendations\nthat actually fit you',
    body:   'readstack learns from the books you log, not what you say you like. The more you track, the sharper your picks.',
  },
  {
    id:     'start',
    visual: 'download',
    title:  "Start with what\nyou\u2019ve already read",
    body:   'Import your Goodreads library in one tap, or add a few books by hand. The more history you bring, the better your picks from day one.',
  },
];

// ─── Slide visual component ───────────────────────────────────────────────────
function SlideVisual({ visual }: { visual: SlideData['visual'] }) {
  if (visual === 'stack') {
    return (
      <View style={{ marginBottom: 36 }}>
        <BookStackLoader size="lg" />
      </View>
    );
  }
  const iconName: 'bulb-outline' | 'cloud-download-outline' =
    visual === 'bulb' ? 'bulb-outline' : 'cloud-download-outline';
  return (
    <View
      style={{
        width:           80,
        height:          80,
        borderRadius:    40,
        backgroundColor: SAGE + '22',
        alignItems:      'center',
        justifyContent:  'center',
        marginBottom:    36,
      }}
    >
      <Ionicons name={iconName} size={36} color={SAGE} />
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function OnboardingScreen() {
  const router              = useRouter();
  const { completeOnboarding } = useOnboardingBridge();
  const { width: W }        = useWindowDimensions();
  const scrollRef           = useRef<ScrollView>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [finishing, setFinishing]       = useState(false);
  const ctaFade             = useRef(new Animated.Value(0)).current;
  const [slideAreaHeight, setSlideAreaHeight] = useState(0);

  useEffect(() => {
    welcomeEvt_started();
    introEvt_slideViewed(0);
    Animated.timing(ctaFade, {
      toValue:         1,
      duration:        500,
      delay:           400,
      useNativeDriver: true,
    }).start();
  }, []);

  function onScrollEnd(x: number) {
    const idx = Math.round(x / W);
    if (idx !== currentSlide) {
      setCurrentSlide(idx);
      introEvt_slideViewed(idx);
    }
  }

  function goNext() {
    if (currentSlide < SLIDES.length - 1) {
      scrollRef.current?.scrollTo({ x: (currentSlide + 1) * W, animated: true });
    } else {
      finish('cta');
    }
  }

  const finish = useCallback(async (source: 'cta' | 'skip') => {
    if (finishing) return;
    setFinishing(true);

    if (source === 'skip') welcomeEvt_skipped();
    else                   welcomeEvt_completed();
    welcomeEvt_handoffStarted();

    // Update root routing guard BEFORE navigating so the guard sees
    // needsOnboarding=false and doesn't redirect back to /onboarding.
    completeOnboarding();

    // Write stage='final_setup' so onboarding-import.tsx knows to render.
    // This is awaited — never navigate before the stage is persisted, or the
    // import page's guard will redirect home.
    await writeOnboardingStage('final_setup');

    router.replace('/onboarding-import' as any);
  }, [finishing, completeOnboarding, router]);

  const isLast = currentSlide === SLIDES.length - 1;
  const topPad = Platform.OS === 'android' ? 20 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" backgroundColor={BG} />
      <SafeAreaView style={{ flex: 1 }}>

        {/* Skip */}
        <View style={{ paddingHorizontal: 24, paddingTop: topPad + 12, alignItems: 'flex-end' }}>
          <TouchableOpacity
            onPress={() => finish('skip')}
            hitSlop={{ top: 14, bottom: 14, left: 20, right: 20 }}
            disabled={finishing}
          >
            <Text style={{ fontSize: 14, color: DUST, fontWeight: '500', letterSpacing: 0.2 }}>
              Skip
            </Text>
          </TouchableOpacity>
        </View>

        {/* Slide area */}
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onMomentumScrollEnd={e => onScrollEnd(e.nativeEvent.contentOffset.x)}
          style={{ flex: 1 }}
          onLayout={e => setSlideAreaHeight(e.nativeEvent.layout.height)}
        >
          {SLIDES.map((slide, index) => (
            <View
              key={slide.id}
              style={{
                width:          W,
                height:         slideAreaHeight || undefined,
                paddingHorizontal: 36,
                alignItems:     'center',
                justifyContent: 'center',
              }}
            >
              <SlideVisual visual={slide.visual} />

              <Text
                style={{
                  fontSize:      26,
                  fontWeight:    '800',
                  color:         INK,
                  textAlign:     'center',
                  letterSpacing: -0.6,
                  lineHeight:    34,
                  marginBottom:  16,
                }}
              >
                {slide.title}
              </Text>

              <Text
                style={{
                  fontSize:  16,
                  color:     SUB,
                  textAlign: 'center',
                  lineHeight: 26,
                  maxWidth:  290,
                }}
              >
                {slide.body}
              </Text>
            </View>
          ))}
        </ScrollView>

        {/* Slide indicators */}
        <View
          style={{
            flexDirection:  'row',
            justifyContent: 'center',
            alignItems:     'center',
            marginBottom:   20,
            gap:            8,
          }}
        >
          {SLIDES.map((_, i) => (
            <View
              key={i}
              style={{
                width:           currentSlide === i ? 22 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: currentSlide === i ? INK : DUST,
                opacity:         currentSlide === i ? 1 : 0.35,
              }}
            />
          ))}
        </View>

        {/* CTA */}
        <Animated.View
          style={{
            paddingHorizontal: 22,
            paddingBottom:     Platform.OS === 'android' ? 28 : 18,
            opacity:           ctaFade,
          }}
        >
          <TouchableOpacity
            onPress={goNext}
            activeOpacity={0.85}
            disabled={finishing}
            style={{
              backgroundColor: INK,
              borderRadius:    14,
              paddingVertical: 17,
              alignItems:      'center',
            }}
          >
            <Text style={{ color: BG, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 }}>
              {isLast ? 'Get started \u2192' : 'Next \u2192'}
            </Text>
          </TouchableOpacity>
        </Animated.View>

      </SafeAreaView>
    </View>
  );
}
