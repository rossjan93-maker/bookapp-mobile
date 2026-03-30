// ─── Cinematic intro prelude ───────────────────────────────────────────────────
//
// 1-screen, full-screen dark composition.
// Job: welcome the user, establish visual quality, hand off reliably.
//
// Handoff is IMMEDIATE — no Supabase awaiting.
// completeOnboarding() updates needsOnboarding in _layout.tsx BEFORE router.replace('/').
// This prevents the routing guard from redirecting back to onboarding.
//
// Supabase profile write and AsyncStorage writes happen in background after navigation.

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Platform,
  SafeAreaView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { writeGuidedStep } from '../components/OnboardingWalkthrough';
import { writeWtStep } from '../lib/walkthroughEngine';
import {
  introEvt_started,
  introEvt_handoffStarted,
  introEvt_completed,
  introEvt_skipped,
} from '../lib/onboardingAnalytics';
import { useOnboardingBridge } from './_layout';

// ─── Dimensions ───────────────────────────────────────────────────────────────

const { width: SW, height: SH } = Dimensions.get('window');

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG     = '#1c1917';     // deep dark warm
const CREAM  = '#faf9f7';     // text / CTA
const MUTED  = '#78716c';     // skip / subtext
const ACCENT = '#15803d';     // green card

// ─── Book-card data ───────────────────────────────────────────────────────────

type CardConfig = {
  w: number; h: number;
  color: string;
  rotate: string;
  offsetX: number; offsetY: number;
  delay: number;
};

const CARDS: CardConfig[] = [
  // back card — rotated left, peeking behind
  {
    w: 110, h: 152, color: '#292219',
    rotate: '-9deg',
    offsetX: -28, offsetY: -8,
    delay: 60,
  },
  // middle card — rotated right
  {
    w: 118, h: 162, color: '#1a2e1a',
    rotate: '7deg',
    offsetX: 26, offsetY: -4,
    delay: 30,
  },
  // front card — upright, darkened green
  {
    w: 128, h: 178, color: ACCENT,
    rotate: '-1deg',
    offsetX: 0, offsetY: 0,
    delay: 0,
  },
];

// ─── Animated book card ───────────────────────────────────────────────────────

function BookCard({ cfg, visible }: { cfg: CardConfig; visible: Animated.Value }) {
  return (
    <Animated.View
      style={{
        position:    'absolute',
        width:       cfg.w,
        height:      cfg.h,
        borderRadius: 8,
        backgroundColor: cfg.color,
        transform: [
          { translateX: cfg.offsetX },
          { translateY: cfg.offsetY },
          { rotate: cfg.rotate },
          {
            translateY: visible.interpolate({
              inputRange:  [0, 1],
              outputRange: [56, 0],
            }),
          },
          {
            scale: visible.interpolate({
              inputRange:  [0, 1],
              outputRange: [0.88, 1],
            }),
          },
        ],
        opacity: visible.interpolate({
          inputRange:  [0, 1],
          outputRange: [0, 1],
        }),
        // Subtle spine line
        borderLeftWidth:  3,
        borderLeftColor:  'rgba(255,255,255,0.08)',
        borderRightWidth: 1,
        borderRightColor: 'rgba(0,0,0,0.25)',
        // Shadow
        shadowColor:    '#000',
        shadowOpacity:  0.55,
        shadowRadius:   14,
        shadowOffset:   { width: 0, height: 8 },
        elevation:      12,
      }}
    >
      {/* Subtle texture lines inside card */}
      <View style={{ position: 'absolute', top: 20, left: 14, right: 14 }}>
        {[0, 1, 2, 3].map(i => (
          <View
            key={i}
            style={{
              height:          2,
              borderRadius:    1,
              backgroundColor: 'rgba(255,255,255,0.07)',
              marginBottom:    8,
              width:           i === 0 ? '80%' : i === 1 ? '60%' : i === 2 ? '72%' : '45%',
            }}
          />
        ))}
      </View>
    </Animated.View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router             = useRouter();
  const { completeOnboarding } = useOnboardingBridge();

  // Per-card entry animations
  const cardAnims = useRef(CARDS.map(() => new Animated.Value(0))).current;
  // Text block fade-in
  const textFade  = useRef(new Animated.Value(0)).current;
  const ctaSlide  = useRef(new Animated.Value(24)).current;
  const ctaFade   = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    introEvt_started();

    // Stagger card entries
    const cardSeqs = CARDS.map((cfg, i) =>
      Animated.sequence([
        Animated.delay(cfg.delay),
        Animated.spring(cardAnims[i], {
          toValue:        1,
          useNativeDriver: false,
          tension:         60,
          friction:        9,
        }),
      ]),
    );

    Animated.sequence([
      // All cards enter (parallel, staggered via internal delays)
      Animated.parallel(cardSeqs),
      // Text fades in
      Animated.delay(80),
      Animated.parallel([
        Animated.timing(textFade, { toValue: 1, duration: 380, useNativeDriver: false }),
        Animated.timing(ctaFade,  { toValue: 1, duration: 420, useNativeDriver: false }),
        Animated.timing(ctaSlide, { toValue: 0, duration: 380, useNativeDriver: false }),
      ]),
    ]).start();
  }, []);

  // ── Fail-safe: if somehow we're still here after 8s, navigate anyway ────────
  useEffect(() => {
    const t = setTimeout(() => finish('failsafe'), 8000);
    return () => clearTimeout(t);
  }, []);

  function finish(source: 'cta' | 'skip' | 'failsafe' = 'cta') {
    if (source === 'skip') introEvt_skipped();
    else                   introEvt_completed();

    introEvt_handoffStarted();

    // ① Update parent needsOnboarding BEFORE navigating (fixes redirect loop)
    completeOnboarding();

    // ② Navigate immediately
    router.replace('/');

    // ③ Background writes — do NOT block navigation on these
    Promise.allSettled([
      writeGuidedStep(0),
      writeWtStep('home'),
    ]);
    if (supabase) {
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (user) {
          supabase
            ?.from('profiles')
            .update({ onboarding_completed: true })
            .eq('id', user.id)
            .then(() => {})
            .catch(() => {});
        }
      }).catch(() => {});
    }
  }

  // ── Dimensions ──────────────────────────────────────────────────────────────

  const cardAreaH    = Math.min(SH * 0.34, 260);
  const topPad       = Platform.OS === 'android' ? 20 : 0;
  const bottomPad    = SH * 0.06;
  const textTopSpace = SH * 0.04;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />
      <SafeAreaView style={{ flex: 1 }}>

        {/* Skip — top right */}
        <View
          style={{
            paddingHorizontal: 22,
            paddingTop:        topPad + 4,
            alignItems:        'flex-end',
          }}
        >
          <TouchableOpacity
            onPress={() => finish('skip')}
            hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
          >
            <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500', letterSpacing: 0.3 }}>
              Skip
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Main content area ─────────────────────────────────────────────── */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: bottomPad }}>

          {/* Book card stack */}
          <View
            style={{
              width:          180,
              height:         cardAreaH,
              alignItems:     'center',
              justifyContent: 'center',
              marginBottom:   textTopSpace,
            }}
          >
            {/* Render back to front */}
            {[...CARDS].reverse().map((cfg, ri) => {
              const i = CARDS.length - 1 - ri;
              return <BookCard key={i} cfg={cfg} visible={cardAnims[i]} />;
            })}
          </View>

          {/* Wordmark + tagline */}
          <Animated.View
            style={{
              alignItems: 'center',
              opacity:    textFade,
              paddingHorizontal: 36,
            }}
          >
            <Text
              style={{
                fontSize:      38,
                fontWeight:    '800',
                color:         CREAM,
                letterSpacing: -0.5,
                textAlign:     'center',
                marginBottom:  10,
              }}
            >
              readstack
            </Text>

            <Text
              style={{
                fontSize:   16,
                color:      '#a8a29e',
                lineHeight: 24,
                textAlign:  'center',
                maxWidth:   280,
              }}
            >
              Your reading life, organized.{'\n'}
              Recommendations that get sharper{'\n'}
              every time you read.
            </Text>
          </Animated.View>
        </View>

        {/* ── Bottom CTA ─────────────────────────────────────────────────────── */}
        <Animated.View
          style={{
            paddingHorizontal: 22,
            paddingBottom:     Platform.OS === 'android' ? 24 : 16,
            opacity:           ctaFade,
            transform:         [{ translateY: ctaSlide }],
          }}
        >
          <TouchableOpacity
            onPress={() => finish('cta')}
            activeOpacity={0.85}
            style={{
              backgroundColor: CREAM,
              borderRadius:    16,
              paddingVertical: 16,
              alignItems:      'center',
            }}
          >
            <Text
              style={{
                color:       BG,
                fontSize:    16,
                fontWeight:  '800',
                letterSpacing: 0.2,
              }}
            >
              Get started →
            </Text>
          </TouchableOpacity>
        </Animated.View>

      </SafeAreaView>
    </View>
  );
}
