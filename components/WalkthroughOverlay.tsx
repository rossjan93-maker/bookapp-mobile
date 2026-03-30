// ─── In-app walkthrough overlay ───────────────────────────────────────────────
//
// Renders a full-screen dimmed overlay + coach-mark card + pulsing tab ring
// for the 'home' and 'library' walkthrough steps.
//
// Mounted at the root of the tab layout (absolute-positioned, above everything).
// Invisible for 'recommend', 'done', and null.
//
// Pointer events: the overlay absorbs all touches so the user cannot interact
// with the app below until they tap Next or Skip.  The coach-mark card and its
// buttons are interactive; everything else is a visual layer only.

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  useWalkthrough,
  WT_DEFS,
  WT_OVERLAY_STEPS,
  WtStep,
  wtEvt_stepViewed,
  wtEvt_skipped,
} from '../lib/walkthroughEngine';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCREEN_W   = Dimensions.get('window').width;
const TAB_COUNT  = 5;
const TAB_BAR_H  = 62;
const RING_SIZE  = 52;
const RING_R     = RING_SIZE / 2;

// Horizontal center of a given tab icon
function tabCenterX(idx: number): number {
  return (SCREEN_W / TAB_COUNT) * idx + SCREEN_W / TAB_COUNT / 2;
}

// ─── Pulsing ring ─────────────────────────────────────────────────────────────

function PulsingRing({ tabIdx }: { tabIdx: number }) {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.9)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale,   { toValue: 1.65, duration: 800, useNativeDriver: true }),
          Animated.timing(scale,   { toValue: 1.0,  duration: 500, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.0,  duration: 800, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.9,  duration: 500, useNativeDriver: true }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const left = tabCenterX(tabIdx) - RING_R;

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position:        'absolute',
        bottom:          TAB_BAR_H / 2 - RING_R + 4,
        left,
        width:           RING_SIZE,
        height:          RING_SIZE,
        borderRadius:    RING_R,
        borderWidth:     2.5,
        borderColor:     '#15803d',
        transform:       [{ scale }],
        opacity,
      }}
    />
  );
}

// ─── Coach-mark card ──────────────────────────────────────────────────────────

function CoachCard({
  step,
  totalSteps,
  stepIdx,
  def,
  onNext,
  onSkip,
}: {
  step:       WtStep;
  totalSteps: number;
  stepIdx:    number;
  def:        typeof WT_DEFS[keyof typeof WT_DEFS];
  onNext:     () => void;
  onSkip:     () => void;
}) {
  const slideIn = useRef(new Animated.Value(32)).current;
  const fade    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    slideIn.setValue(32);
    fade.setValue(0);
    Animated.parallel([
      Animated.timing(slideIn, { toValue: 0,   duration: 340, useNativeDriver: true }),
      Animated.timing(fade,    { toValue: 1,    duration: 280, useNativeDriver: true }),
    ]).start();
  }, [step]);

  return (
    <Animated.View
      style={{
        position:         'absolute',
        bottom:           TAB_BAR_H + 14,
        left:             14,
        right:            14,
        backgroundColor:  '#faf9f7',
        borderRadius:     20,
        padding:          20,
        opacity:          fade,
        transform:        [{ translateY: slideIn }],
        shadowColor:      '#000',
        shadowOpacity:    0.18,
        shadowRadius:     16,
        shadowOffset:     { width: 0, height: 4 },
        elevation:        10,
      }}
    >
      {/* Top row: step count + skip */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 5 }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View
              key={i}
              style={{
                width:           i === stepIdx ? 20 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: i <= stepIdx ? '#1c1917' : '#e7e5e4',
              }}
            />
          ))}
        </View>
        <TouchableOpacity
          onPress={onSkip}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={{ fontSize: 13, color: '#a8a29e', fontWeight: '500' }}>
            Skip tour
          </Text>
        </TouchableOpacity>
      </View>

      {/* Title */}
      <Text style={{ fontSize: 22, fontWeight: '800', color: '#1c1917', lineHeight: 28, marginBottom: 8 }}>
        {def.title}
      </Text>

      {/* Body */}
      <Text style={{ fontSize: 15, color: '#78716c', lineHeight: 22, marginBottom: 20 }}>
        {def.body}
      </Text>

      {/* Next button */}
      <TouchableOpacity
        onPress={onNext}
        activeOpacity={0.8}
        style={{
          backgroundColor: '#1c1917',
          borderRadius:    13,
          paddingVertical: 14,
          alignItems:      'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
          {def.ctaLabel}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Main overlay ─────────────────────────────────────────────────────────────

export function WalkthroughOverlay() {
  const { wtStep, advance, skip } = useWalkthrough();

  const overlayFade = useRef(new Animated.Value(0)).current;
  const prevStep    = useRef<WtStep | null>(null);

  const isVisible = wtStep !== null && WT_OVERLAY_STEPS.includes(wtStep);

  useEffect(() => {
    if (isVisible && prevStep.current !== wtStep) {
      // Fade in when first becoming visible or step changes
      Animated.timing(overlayFade, { toValue: 1, duration: 300, useNativeDriver: true }).start();
      if (wtStep) wtEvt_stepViewed(wtStep);
    } else if (!isVisible && prevStep.current !== wtStep) {
      Animated.timing(overlayFade, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    }
    prevStep.current = wtStep;
  }, [wtStep, isVisible]);

  if (!isVisible || !wtStep) return null;

  const def = WT_DEFS[wtStep as keyof typeof WT_DEFS];
  if (!def) return null;

  const stepIdx   = WT_OVERLAY_STEPS.indexOf(wtStep);
  const totalSteps = WT_OVERLAY_STEPS.length;

  function handleSkip() {
    wtEvt_skipped(wtStep!);
    skip();
  }

  return (
    <Animated.View
      style={{
        position:        'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        opacity:         overlayFade,
      }}
    >
      {/* Dim layer — absorbs all touches */}
      <View
        style={{
          position:        'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.58)',
        }}
      />

      {/* Pulsing ring on the active tab icon */}
      <PulsingRing tabIdx={def.tabIdx} />

      {/* Coach-mark card */}
      <CoachCard
        step={wtStep}
        totalSteps={totalSteps}
        stepIdx={stepIdx}
        def={def}
        onNext={advance}
        onSkip={handleSkip}
      />
    </Animated.View>
  );
}
