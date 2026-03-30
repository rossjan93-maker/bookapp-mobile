// ─── Welcome screen ────────────────────────────────────────────────────────────
//
// One full-screen dark composition.
// Job: welcome, set tone, invite the user into the live app tour.
//
// Animation approach: card springs fire immediately on mount (fire-and-forget).
// Text + CTA fade in after a fixed 600ms setTimeout — NOT chained to spring
// completion.  This guarantees the CTA is always visible/touchable within ~1s
// regardless of spring behaviour on web (where springs can be slow).
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

// ─── Palette ──────────────────────────────────────────────────────────────────

const BG     = '#1c1917';
const CREAM  = '#faf9f7';
const MUTED  = '#78716c';
const GREEN  = '#15803d';

// ─── Book-card configurations ─────────────────────────────────────────────────

type CardConfig = {
  w: number; h: number;
  color: string;
  rotate: string;
  offsetX: number; offsetY: number;
  startDelay: number;
};

const CARDS: CardConfig[] = [
  { w: 108, h: 150, color: '#292219',  rotate: '-9deg', offsetX: -30, offsetY: -6,  startDelay: 80 },
  { w: 116, h: 160, color: '#1a2e1a',  rotate:  '7deg', offsetX:  28, offsetY: -3,  startDelay: 40 },
  { w: 126, h: 176, color: GREEN,      rotate: '-1deg', offsetX:   0, offsetY:  0,  startDelay:  0 },
];

// ─── Animated book card ───────────────────────────────────────────────────────

function BookCard({ cfg, anim }: { cfg: CardConfig; anim: Animated.Value }) {
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [60, 0] });
  const scale      = anim.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1] });

  return (
    <Animated.View
      style={{
        position:         'absolute',
        width:            cfg.w,
        height:           cfg.h,
        borderRadius:     8,
        backgroundColor:  cfg.color,
        transform: [
          { translateX: cfg.offsetX },
          { translateY: cfg.offsetY },
          { rotate: cfg.rotate },
          { translateY },
          { scale },
        ],
        opacity:          anim,
        borderLeftWidth:  3,
        borderLeftColor:  'rgba(255,255,255,0.07)',
        borderRightWidth: 1,
        borderRightColor: 'rgba(0,0,0,0.28)',
        shadowColor:      '#000',
        shadowOpacity:    0.52,
        shadowRadius:     14,
        shadowOffset:     { width: 0, height: 8 },
        elevation:        12,
      }}
    >
      <View style={{ position: 'absolute', top: 18, left: 14, right: 14 }}>
        {[0, 1, 2].map(i => (
          <View
            key={i}
            style={{
              height:          2,
              borderRadius:    1,
              backgroundColor: 'rgba(255,255,255,0.07)',
              marginBottom:    9,
              width:           i === 0 ? '78%' : i === 1 ? '55%' : '68%',
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

  const cardAnims  = useRef(CARDS.map(() => new Animated.Value(0))).current;
  const textFade   = useRef(new Animated.Value(0)).current;
  const ctaFade    = useRef(new Animated.Value(0)).current;
  const ctaOffsetY = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    welcomeEvt_started();

    // ── Card springs: fire-and-forget with individual start delays ────────────
    CARDS.forEach((cfg, i) => {
      setTimeout(() => {
        Animated.spring(cardAnims[i], {
          toValue:         1,
          useNativeDriver: false,
          tension:         55,
          friction:        9,
        }).start();
      }, cfg.startDelay);
    });

    // ── Text + CTA: fixed delay, NOT chained to card springs ─────────────────
    // Fires after 600ms regardless of spring state, so the button is ALWAYS
    // visible and touchable within ~1s of mount.
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.timing(textFade,   { toValue: 1, duration: 350, useNativeDriver: false }),
        Animated.timing(ctaFade,    { toValue: 1, duration: 400, useNativeDriver: false }),
        Animated.timing(ctaOffsetY, { toValue: 0, duration: 350, useNativeDriver: false }),
      ]).start();
    }, 600);

    return () => clearTimeout(t);
  }, []);

  // ── Hard fail-safe: navigate after 12s even if nothing else fired ─────────
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

  const cardAreaH    = Math.min(SH * 0.32, 240);
  const topPad       = Platform.OS === 'android' ? 20 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />
      <SafeAreaView style={{ flex: 1 }}>

        {/* Skip — top right */}
        <View style={{ paddingHorizontal: 22, paddingTop: topPad + 4, alignItems: 'flex-end' }}>
          <TouchableOpacity
            onPress={() => finish('skip')}
            hitSlop={{ top: 14, bottom: 14, left: 20, right: 20 }}
          >
            <Text style={{ fontSize: 14, color: MUTED, fontWeight: '500', letterSpacing: 0.3 }}>
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
            paddingBottom:  SH * 0.08,
          }}
        >
          {/* Book stack */}
          <View
            style={{
              width:          200,
              height:         cardAreaH,
              alignItems:     'center',
              justifyContent: 'center',
              marginBottom:   SH * 0.04,
            }}
          >
            {[...CARDS].reverse().map((cfg, ri) => {
              const i = CARDS.length - 1 - ri;
              return <BookCard key={i} cfg={cfg} anim={cardAnims[i]} />;
            })}
          </View>

          {/* Wordmark + tagline */}
          <Animated.View
            style={{
              alignItems:        'center',
              opacity:           textFade,
              paddingHorizontal: 40,
            }}
          >
            <Text
              style={{
                fontSize:      36,
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
                lineHeight: 25,
                textAlign:  'center',
                maxWidth:   270,
              }}
            >
              Track what you read.{'\n'}
              Get recommendations that fit.{'\n'}
              Better with every book.
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
              backgroundColor: CREAM,
              borderRadius:    16,
              paddingVertical: 17,
              alignItems:      'center',
            }}
          >
            <Text style={{ color: BG, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 }}>
              Let's show you around →
            </Text>
          </TouchableOpacity>
        </Animated.View>

      </SafeAreaView>
    </View>
  );
}
