// ─── Welcome screen ────────────────────────────────────────────────────────────
//
// Full-screen light composition matching the app's real palette.
// Job: welcome, set tone, invite the user into the live app tour.
//
// Animation approach: BookStackLoader builds 5 books upward, then breathes.
// Text + CTA fade in after a fixed 600ms setTimeout — NOT chained to stack
// completion.  This guarantees the CTA is always visible/touchable within ~1s
// regardless of animation behaviour.
//
// Handoff: completeOnboarding() updates needsOnboarding in _layout.tsx BEFORE
// router.replace('/'), preventing the routing guard from looping back here.
// All Supabase/AsyncStorage writes happen in the background after navigation.

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Platform,
  SafeAreaView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { writeGuidedStep } from '../components/OnboardingWalkthrough';
import { writeWtStep } from '../lib/walkthroughEngine';
import { writeOnboardingStage } from '../lib/onboardingStage';
import {
  welcomeEvt_started,
  welcomeEvt_completed,
  welcomeEvt_skipped,
  welcomeEvt_handoffStarted,
} from '../lib/onboardingAnalytics';
import { useOnboardingBridge } from './_layout';
import { BookStackLoader } from '../components/BookStackLoader';

// ─── Palette — matches app-wide tokens ────────────────────────────────────────

const BG    = '#f5f1ec';   // rich warm ivory
const INK   = '#231f1b';   // warm near-black
const SUB   = '#6b635c';   // warm stone subtext
const SAGE  = '#7b9e7e';   // muted warm sage accent

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const router             = useRouter();
  const { completeOnboarding } = useOnboardingBridge();
  const { height: SH } = useWindowDimensions();

  const textFade   = useRef(new Animated.Value(0)).current;
  const ctaFade    = useRef(new Animated.Value(0)).current;
  const ctaOffsetY = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    welcomeEvt_started();

    // Text + CTA: fixed delay — always visible within ~1s of mount
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.timing(textFade,   { toValue: 1, duration: 380, useNativeDriver: false }),
        Animated.timing(ctaFade,    { toValue: 1, duration: 440, useNativeDriver: false }),
        Animated.timing(ctaOffsetY, { toValue: 0, duration: 380, useNativeDriver: false }),
      ]).start();
    }, 580);

    return () => clearTimeout(t);
  }, []);

  // Hard fail-safe: navigate after 12s even if nothing else fired
  useEffect(() => {
    const t = setTimeout(() => finish('failsafe'), 12000);
    return () => clearTimeout(t);
  }, []);

  async function finish(source: 'cta' | 'skip' | 'failsafe' = 'cta') {
    if (source === 'skip') welcomeEvt_skipped();
    else                   welcomeEvt_completed();
    welcomeEvt_handoffStarted();

    // ① Update parent state BEFORE navigating — prevents redirect loop
    completeOnboarding();

    // ② Await both stage writes before navigating so _layout.tsx always
    //    reads 'walkthrough' on first mount, never null.
    await Promise.all([
      writeOnboardingStage('walkthrough'),
      writeWtStep('home'),
    ]);

    // ③ Navigate only after stage writes are confirmed.
    //
    // NOTE: We intentionally do NOT write onboarding_completed=true here.
    // That flag is the signal the root layout uses to detect whether the FULL
    // onboarding sequence (walkthrough + import/setup step) is done. Writing it
    // here — at the welcome screen — would cause the DB to report "complete"
    // before the user has reached onboarding-import.tsx. On a new device or
    // fresh browser session (e.g. after clicking the confirmation email link on a
    // different phone), checkOnboardingCompleted would return true and skip the
    // entire sequence. The flag is written by onboarding-import.tsx in all three
    // resolution paths (import / intake / not now).
    router.replace('/');

    // ④ Background writes (non-blocking)
    Promise.allSettled([writeGuidedStep(0)]);
  }

  const topPad = Platform.OS === 'android' ? 20 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar barStyle="dark-content" backgroundColor={BG} />
      <SafeAreaView style={{ flex: 1 }}>

        {/* Skip — top right */}
        <View style={{ paddingHorizontal: 24, paddingTop: topPad + 12, alignItems: 'flex-end' }}>
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
          {/* Book stack — builds upward then breathes */}
          <View style={{ marginBottom: SH * 0.05 }}>
            <BookStackLoader size="lg" />
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
                  fontSize:      50,
                  fontWeight:    '800',
                  color:         INK,
                  letterSpacing: -1.5,
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
                backgroundColor: SAGE,
                marginBottom:    20,
              }}
            />

            {/* Editorial tagline */}
            <Text
              style={{
                fontSize:      14,
                color:         SUB,
                lineHeight:    22,
                textAlign:     'center',
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                maxWidth:      240,
              }}
            >
              your reading, together.
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
              borderRadius:    14,
              paddingVertical: 17,
              alignItems:      'center',
            }}
          >
            <Text style={{ color: BG, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 }}>
              Let's go →
            </Text>
          </TouchableOpacity>
        </Animated.View>

      </SafeAreaView>
    </View>
  );
}
