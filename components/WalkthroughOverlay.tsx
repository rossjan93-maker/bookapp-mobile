// ─── In-app walkthrough overlay ───────────────────────────────────────────────
//
// Full-screen overlay with:
//   • 4-panel spotlight aperture — dims everything EXCEPT a rectangular window
//     on the live UI (the content area of the current step's screen)
//   • Border glow around the spotlight window
//   • Pulsing ring on the active tab-bar icon
//   • Coach-mark card above or below the spotlight
//
// Visible for WT_OVERLAY_STEPS only ('home', 'library').
// 'recommend' and 'done' show nothing.

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
  TargetRect,
  getWtTarget,
  wtEvt_stepViewed,
  wtEvt_skipped,
} from '../lib/walkthroughEngine';

// ─── Layout constants ─────────────────────────────────────────────────────────

const SCREEN_W   = Dimensions.get('window').width;
const SCREEN_H   = Dimensions.get('window').height;
const TAB_COUNT  = 5;
const TAB_BAR_H  = 62;
const RING_SIZE  = 52;
const RING_R     = RING_SIZE / 2;
const DIM_COLOR  = 'rgba(0,0,0,0.65)';
const GLOW_COLOR = 'rgba(250,249,247,0.18)';

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
          Animated.timing(scale,   { toValue: 1.7,  duration: 850, useNativeDriver: false }),
          Animated.timing(scale,   { toValue: 1.0,  duration: 500, useNativeDriver: false }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.0,  duration: 850, useNativeDriver: false }),
          Animated.timing(opacity, { toValue: 0.9,  duration: 500, useNativeDriver: false }),
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
        position:     'absolute',
        bottom:       TAB_BAR_H / 2 - RING_R + 4,
        left,
        width:        RING_SIZE,
        height:       RING_SIZE,
        borderRadius: RING_R,
        borderWidth:  2.5,
        borderColor:  '#15803d',
        transform:    [{ scale }],
        opacity,
      }}
    />
  );
}

// ─── Spotlight aperture ───────────────────────────────────────────────────────
// Simulates a transparent cutout by drawing 4 dim panels around the target rect.
// Optionally draws a glowing border frame around the cutout.

function SpotlightAperture({
  rect,
  fade,
}: {
  rect:  TargetRect;
  fade:  Animated.Value;
}) {
  const { x, y, width, height } = rect;
  const rx = x;
  const ry = y;
  const rr = SCREEN_W - (x + width);
  const rb = SCREEN_H - (y + height);

  const panelStyle = {
    position:        'absolute' as const,
    backgroundColor: DIM_COLOR,
  };

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        opacity: fade,
      }}
    >
      {/* Top panel */}
      <View style={{ ...panelStyle, top: 0, left: 0, right: 0, height: ry }} />

      {/* Left panel */}
      <View style={{ ...panelStyle, top: ry, left: 0, width: rx, height }} />

      {/* Right panel */}
      <View style={{ ...panelStyle, top: ry, right: 0, width: rr, height }} />

      {/* Bottom panel */}
      <View style={{ ...panelStyle, top: ry + height, left: 0, right: 0, bottom: 0 }} />

      {/* Glow border around the aperture */}
      <View
        style={{
          position:      'absolute',
          top:           ry - 2,
          left:          rx - 2,
          width:         width  + 4,
          height:        height + 4,
          borderRadius:  6,
          borderWidth:   2,
          borderColor:   GLOW_COLOR,
        }}
      />
    </Animated.View>
  );
}

// ─── Coach-mark card ──────────────────────────────────────────────────────────

function CoachCard({
  step,
  totalSteps,
  stepIdx,
  def,
  spotRect,
  onNext,
  onSkip,
}: {
  step:       WtStep;
  totalSteps: number;
  stepIdx:    number;
  def:        typeof WT_DEFS[keyof typeof WT_DEFS];
  spotRect:   TargetRect | null;
  onNext:     () => void;
  onSkip:     () => void;
}) {
  const slideIn = useRef(new Animated.Value(28)).current;
  const fade    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    slideIn.setValue(28);
    fade.setValue(0);
    Animated.parallel([
      Animated.timing(slideIn, { toValue: 0,   duration: 360, useNativeDriver: false }),
      Animated.timing(fade,    { toValue: 1,    duration: 300, useNativeDriver: false }),
    ]).start();
  }, [step]);

  // Position the card based on where the spotlight is
  // If spotlight rect bottom is in lower half → card goes above it
  // Otherwise card goes at bottom (above tab bar)
  const cardAtTop = spotRect
    ? (spotRect.y + spotRect.height) > SCREEN_H * 0.55
    : false;

  const cardBottom = cardAtTop
    ? undefined
    : TAB_BAR_H + 14;

  const cardTop = cardAtTop
    ? (spotRect ? Math.max(spotRect.y - 4 - 220, 60) : 80)
    : undefined;

  return (
    <Animated.View
      style={{
        position:        'absolute',
        bottom:          cardBottom,
        top:             cardTop,
        left:            14,
        right:           14,
        backgroundColor: '#faf9f7',
        borderRadius:    22,
        padding:         22,
        opacity:         fade,
        transform:       [{ translateY: slideIn }],
        shadowColor:     '#000',
        shadowOpacity:   0.22,
        shadowRadius:    20,
        shadowOffset:    { width: 0, height: 6 },
        elevation:       14,
      }}
    >
      {/* Step dots + skip */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 5 }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View
              key={i}
              style={{
                width:           i === stepIdx ? 22 : 6,
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
      <Text
        style={{
          fontSize:     23,
          fontWeight:   '800',
          color:        '#1c1917',
          lineHeight:   29,
          marginBottom: 9,
        }}
      >
        {def.title}
      </Text>

      {/* Body */}
      <Text
        style={{
          fontSize:     15,
          color:        '#78716c',
          lineHeight:   22,
          marginBottom: 22,
        }}
      >
        {def.body}
      </Text>

      {/* Next button */}
      <TouchableOpacity
        onPress={onNext}
        activeOpacity={0.82}
        style={{
          backgroundColor: '#1c1917',
          borderRadius:    14,
          paddingVertical: 15,
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

  const isVisible = wtStep !== null && (WT_OVERLAY_STEPS as string[]).includes(wtStep);

  // Fade in/out on step changes
  useEffect(() => {
    if (isVisible && prevStep.current !== wtStep) {
      overlayFade.setValue(0);
      Animated.timing(overlayFade, { toValue: 1, duration: 300, useNativeDriver: false }).start();
      if (wtStep) wtEvt_stepViewed(wtStep);
    } else if (!isVisible && prevStep.current !== null) {
      Animated.timing(overlayFade, { toValue: 0, duration: 200, useNativeDriver: false }).start();
    }
    prevStep.current = wtStep;
  }, [wtStep, isVisible]);

  if (!isVisible || !wtStep) return null;

  const def = WT_DEFS[wtStep as keyof typeof WT_DEFS];
  if (!def) return null;

  // Prefer live-registered target; fall back to fixed spotlightRect in def
  const spotRect: TargetRect | null =
    getWtTarget(`${wtStep}_content`) ?? def.spotlightRect;

  const stepIdx    = WT_OVERLAY_STEPS.indexOf(wtStep);
  const totalSteps = WT_OVERLAY_STEPS.length;

  function handleSkip() {
    wtEvt_skipped(wtStep!);
    skip();
  }

  return (
    <View
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        pointerEvents: 'box-none',
      }}
    >
      {/* Spotlight aperture (4-panel dim around cutout) */}
      {spotRect ? (
        <SpotlightAperture rect={spotRect} fade={overlayFade} />
      ) : (
        // Fallback: full-screen dim
        <Animated.View
          pointerEvents="none"
          style={{
            position:        'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: DIM_COLOR,
            opacity:         overlayFade,
          }}
        />
      )}

      {/* Transparent touch-blocker that covers everything except the coach card */}
      {/* We let pointer events through to tab bar so user can still see it */}
      <View
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          bottom: TAB_BAR_H,
        }}
        pointerEvents="box-only"
      />

      {/* Pulsing ring on the active tab icon */}
      <PulsingRing tabIdx={def.tabIdx} />

      {/* Coach card */}
      <CoachCard
        step={wtStep}
        totalSteps={totalSteps}
        stepIdx={stepIdx}
        def={def}
        spotRect={spotRect}
        onNext={advance}
        onSkip={handleSkip}
      />
    </View>
  );
}
