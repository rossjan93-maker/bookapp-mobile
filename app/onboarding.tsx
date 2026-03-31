// ─── Welcome screen ────────────────────────────────────────────────────────────
//
// Full-screen light composition matching the app's real palette.
// Job: welcome, set tone, invite the user into the live app tour.
//
// Animation approach: book spine cards spring in with individual start delays.
// Text + CTA fade in after a fixed 600ms setTimeout — NOT chained to spring
// completion.  This guarantees the CTA is always visible/touchable within ~1s
// regardless of spring behaviour on web.
//
// Handoff: completeOnboarding() updates needsOnboarding in _layout.tsx BEFORE
// router.replace('/'), preventing the routing guard from looping back here.
// All Supabase/AsyncStorage writes happen in the background after navigation.

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
  welcomeEvt_started,
  welcomeEvt_completed,
  welcomeEvt_skipped,
  welcomeEvt_handoffStarted,
} from '../lib/onboardingAnalytics';
import { useOnboardingBridge } from './_layout';

// ─── Dimensions ───────────────────────────────────────────────────────────────

const { width: SW, height: SH } = Dimensions.get('window');

// ─── Palette — matches app-wide tokens ────────────────────────────────────────

const BG    = '#faf9f7';   // warm off-white (real app background)
const INK   = '#1c1917';   // near-black ink
const SUB   = '#78716c';   // warm gray subtext
const GREEN = '#15803d';   // forest green accent

// ─── Book spine configurations ────────────────────────────────────────────────
// Displayed as stacked vertical spines — visible on the light background.

type SpineConfig = {
  w: number; h: number;
  color: string;
  rotate: string;
  offsetX: number; offsetY: number;
  startDelay: number;
};

const SPINES: SpineConfig[] = [
  { w: 54, h: 148, color: '#d6d0c8', rotate: '-7deg', offsetX: -56, offsetY: 10,  startDelay: 100 },
  { w: 48, h: 162, color: '#b5c4b1', rotate:  '3deg', offsetX: -10, offsetY:  0,  startDelay:  50 },
  { w: 58, h: 172, color: GREEN,     rotate: '-2deg', offsetX:  46, offsetY:  4,  startDelay:   0 },
  { w: 44, h: 138, color: '#c9bdb0', rotate:  '8deg', offsetX:  98, offsetY: 14,  startDelay:  70 },
];

// ─── Animated book spine ──────────────────────────────────────────────────────

function BookSpine({ cfg, anim }: { cfg: SpineConfig; anim: Animated.Value }) {
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [48, 0] });
  const scale      = anim.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] });

  return (
    <Animated.View
      style={{
        position:        'absolute',
        width:           cfg.w,
        height:          cfg.h,
        borderRadius:    6,
        backgroundColor: cfg.color,
        transform: [
          { translateX: cfg.offsetX },
          { translateY: cfg.offsetY },
          { rotate: cfg.rotate },
          { translateY },
          { scale },
        ],
        opacity: anim,
        shadowColor:     '#1c1917',
        shadowOpacity:   0.12,
        shadowRadius:    12,
        shadowOffset:    { width: 0, height: 6 },
        elevation:       8,
      }}
    >
      {/* Subtle spine detail lines */}
      <View style={{ position: 'absolute', top: 16, left: 10, right: 10 }}>
        {[0, 1, 2].map(i => (
          <View
            key={i}
            style={{
              height:          1.5,
              borderRadius:    1,
              backgroundColor: cfg.color === GREEN ? 'rgba(255,255,255,0.18)' : 'rgba(28,25,23,0.1)',
              marginBottom:    8,
              width:           i === 0 ? '80%' : i === 1 ? '55%' : '70%',
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

  const spineAnims = useRef(SPINES.map(() => new Animated.Value(0))).current;
  const textFade   = useRef(new Animated.Value(0)).current;
  const ctaFade    = useRef(new Animated.Value(0)).current;
  const ctaOffsetY = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    welcomeEvt_started();

    // ── Spine springs: fire-and-forget with individual delays ─────────────────
    SPINES.forEach((cfg, i) => {
      setTimeout(() => {
        Animated.spring(spineAnims[i], {
          toValue:         1,
          useNativeDriver: false,
          tension:         60,
          friction:        10,
        }).start();
      }, cfg.startDelay);
    });

    // ── Text + CTA: fixed delay — always visible within ~1s of mount ──────────
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.timing(textFade,   { toValue: 1, duration: 380, useNativeDriver: false }),
        Animated.timing(ctaFade,    { toValue: 1, duration: 440, useNativeDriver: false }),
        Animated.timing(ctaOffsetY, { toValue: 0, duration: 380, useNativeDriver: false }),
      ]).start();
    }, 580);

    return () => clearTimeout(t);
  }, []);

  // ── Hard fail-safe: navigate after 12s even if nothing else fired ──────────
  useEffect(() => {
    const t = setTimeout(() => finish('failsafe'), 12000);
    return () => clearTimeout(t);
  }, []);

  function finish(source: 'cta' | 'skip' | 'failsafe' = 'cta') {
    if (source === 'skip') welcomeEvt_skipped();
    else                   welcomeEvt_completed();
    welcomeEvt_handoffStarted();

    // ① Update parent state BEFORE navigating — prevents redirect loop
    completeOnboarding();

    // ② Immediate navigation
    router.replace('/');

    // ③ Background writes
    Promise.allSettled([writeGuidedStep(0), writeWtStep('home')]);
    if (supabase) {
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (user) {
          supabase?.from('profiles').update({ onboarding_completed: true }).eq('id', user.id);
        }
      }).catch(() => {});
    }
  }

  const spineAreaH = Math.min(SH * 0.30, 220);
  const topPad     = Platform.OS === 'android' ? 20 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" backgroundColor={BG} />
      <SafeAreaView style={{ flex: 1 }}>

        {/* Skip — top right */}
        <View style={{ paddingHorizontal: 24, paddingTop: topPad + 4, alignItems: 'flex-end' }}>
          <TouchableOpacity
            onPress={() => finish('skip')}
            hitSlop={{ top: 14, bottom: 14, left: 20, right: 20 }}
          >
            <Text style={{ fontSize: 14, color: SUB, fontWeight: '500', letterSpacing: 0.2 }}>
              Skip
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <View
          style={{
            flex:           1,
            alignItems:     'center',
            justifyContent: 'center',
            paddingBottom:  SH * 0.06,
          }}
        >
          {/* Book spine stack */}
          <View
            style={{
              width:          240,
              height:         spineAreaH,
              alignItems:     'center',
              justifyContent: 'center',
              marginBottom:   SH * 0.05,
            }}
          >
            {[...SPINES].reverse().map((cfg, ri) => {
              const i = SPINES.length - 1 - ri;
              return <BookSpine key={i} cfg={cfg} anim={spineAnims[i]} />;
            })}
          </View>

          {/* Wordmark */}
          <Animated.View
            style={{
              alignItems:        'center',
              opacity:           textFade,
              paddingHorizontal: 36,
            }}
          >
            {/* Logo mark */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
              <Text
                style={{
                  fontSize:      42,
                  fontWeight:    '800',
                  color:         INK,
                  letterSpacing: -1,
                }}
              >
                readstack
              </Text>
            </View>

            {/* Green rule accent */}
            <View
              style={{
                width:           44,
                height:          3,
                borderRadius:    2,
                backgroundColor: GREEN,
                marginBottom:    20,
              }}
            />

            {/* Editorial tagline — single line, confident */}
            <Text
              style={{
                fontSize:      17,
                color:         SUB,
                lineHeight:    26,
                textAlign:     'center',
                letterSpacing: 0.1,
                maxWidth:      280,
              }}
            >
              Books that are actually right for you.
            </Text>
          </Animated.View>
        </View>

        {/* ── CTA ──────────────────────────────────────────────────────────── */}
        <Animated.View
          style={{
            paddingHorizontal: 22,
            paddingBottom:     Platform.OS === 'android' ? 28 : 18,
            opacity:           ctaFade,
            transform:         [{ translateY: ctaOffsetY }],
          }}
        >
          <TouchableOpacity
            onPress={() => finish('cta')}
            activeOpacity={0.85}
            style={{
              backgroundColor: INK,
              borderRadius:    16,
              paddingVertical: 17,
              alignItems:      'center',
            }}
          >
            <Text style={{ color: BG, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 }}>
              Show me around →
            </Text>
          </TouchableOpacity>
        </Animated.View>

      </SafeAreaView>
    </View>
  );
}
