// ─── In-app walkthrough overlay ───────────────────────────────────────────────
//
// Full-screen overlay drawn inside the live app shell.
//
// For each WT_OVERLAY_STEP ('home', 'library') it renders:
//
//   1. SpotlightAperture
//      4 dim panels leave a clear rectangular window on the inset spotlight
//      rect (horizontal margins, not wall-to-wall).  A glow border frames it.
//
//   2. InScreenHotspot
//      A dual-ring pulsing dot placed at the inScreenHotspot coordinate within
//      the lit area.  Acts as a visual "look here" indicator AND a tap target
//      that advances the walkthrough (same as pressing Next).
//
//   3. PulsingRing
//      Pulsing circle over the active tab icon in the tab bar.
//
//   4. CoachCard
//      Translucent white card below the spotlight with step dots, title, body,
//      and a Next button.  An upward-pointing arrow at the card's top edge
//      creates a visual connection to the spotlight above.

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
  wtEvt_hotspotTapped,
} from '../lib/walkthroughEngine';

// ─── Layout constants ─────────────────────────────────────────────────────────

const SW         = Dimensions.get('window').width;
const SH         = Dimensions.get('window').height;
const TAB_COUNT  = 5;
const TAB_BAR_H  = 62;
const RING_SIZE  = 52;
const RING_R     = RING_SIZE / 2;
const DIM_COLOR  = 'rgba(0,0,0,0.62)';
const GLOW_COLOR = 'rgba(250,249,247,0.22)';
const CARD_W     = SW - 28;  // card spans left:14, right:14

function tabCenterX(idx: number): number {
  return (SW / TAB_COUNT) * idx + SW / TAB_COUNT / 2;
}

// ─── 1. Pulsing ring on tab icon ──────────────────────────────────────────────

function PulsingRing({ tabIdx }: { tabIdx: number }) {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.9)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale,   { toValue: 1.75, duration: 850, useNativeDriver: false }),
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

// ─── 2. Spotlight aperture ────────────────────────────────────────────────────
// 4 dim panels leave a clear rectangular window.  A glow border frames it.

function SpotlightAperture({ rect, fade }: { rect: TargetRect; fade: Animated.Value }) {
  const { x, y, width, height } = rect;
  const rr = SW - (x + width);
  const rb = SH - (y + height);

  const panel = {
    position:        'absolute' as const,
    backgroundColor: DIM_COLOR,
  };

  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: fade }}
    >
      <View style={{ ...panel, top: 0,          left: 0, right: 0,  height: y          }} />
      <View style={{ ...panel, top: y,          left: 0, width:  x, height             }} />
      <View style={{ ...panel, top: y,          right: 0, width: rr, height            }} />
      <View style={{ ...panel, top: y + height, left: 0, right: 0,  bottom: 0          }} />

      {/* Glow border */}
      <View
        style={{
          position:      'absolute',
          top:           y - 2,
          left:          x - 2,
          width:         width  + 4,
          height:        height + 4,
          borderRadius:  10,
          borderWidth:   2,
          borderColor:   GLOW_COLOR,
        }}
      />
    </Animated.View>
  );
}

// ─── 3. In-screen hotspot ─────────────────────────────────────────────────────
// Dual-ring pulsing dot at a specific point within the spotlight.
// Rings animate with a 420ms stagger so they pulse in sequence.
// Tapping advances the walkthrough — same as pressing Next.

function InScreenHotspot({
  pos,
  onPress,
}: {
  pos:     { x: number; y: number };
  onPress: () => void;
}) {
  const ring1Scale   = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0.85)).current;
  const ring2Scale   = useRef(new Animated.Value(1)).current;
  const ring2Opacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const makeRingLoop = (
      scale:   Animated.Value,
      opacity: Animated.Value,
      delay:   number,
    ) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(scale,   { toValue: 2.4,  duration: 900, useNativeDriver: false }),
            Animated.timing(opacity, { toValue: 0,    duration: 900, useNativeDriver: false }),
          ]),
          Animated.parallel([
            Animated.timing(scale,   { toValue: 1,    duration: 0,   useNativeDriver: false }),
            Animated.timing(opacity, { toValue: delay === 0 ? 0.85 : 0.45, duration: 0, useNativeDriver: false }),
          ]),
          Animated.delay(900 - delay),
        ]),
      );

    const l1 = makeRingLoop(ring1Scale, ring1Opacity, 0);
    const l2 = makeRingLoop(ring2Scale, ring2Opacity, 420);
    l1.start();
    l2.start();
    return () => { l1.stop(); l2.stop(); };
  }, []);

  const TOUCH = 52;
  const RING  = 40;
  const DOT   = 11;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        position:       'absolute',
        top:            pos.y - TOUCH / 2,
        left:           pos.x - TOUCH / 2,
        width:          TOUCH,
        height:         TOUCH,
        alignItems:     'center',
        justifyContent: 'center',
      }}
    >
      {/* Outer ring */}
      <Animated.View
        pointerEvents="none"
        style={{
          position:     'absolute',
          width:        RING,
          height:       RING,
          borderRadius: RING / 2,
          borderWidth:  1.5,
          borderColor:  '#fff',
          transform:    [{ scale: ring1Scale }],
          opacity:      ring1Opacity,
        }}
      />
      {/* Inner ring (staggered) */}
      <Animated.View
        pointerEvents="none"
        style={{
          position:     'absolute',
          width:        RING,
          height:       RING,
          borderRadius: RING / 2,
          borderWidth:  1.5,
          borderColor:  '#fff',
          transform:    [{ scale: ring2Scale }],
          opacity:      ring2Opacity,
        }}
      />
      {/* Solid centre dot */}
      <View
        style={{
          width:           DOT,
          height:          DOT,
          borderRadius:    DOT / 2,
          backgroundColor: '#fff',
          shadowColor:     '#fff',
          shadowOpacity:   0.6,
          shadowRadius:    5,
          shadowOffset:    { width: 0, height: 0 },
        }}
      />
    </TouchableOpacity>
  );
}

// ─── 4. Coach card ────────────────────────────────────────────────────────────
// Slides up from below the spotlight.
// An upward-pointing triangle at the top edge points toward the lit area.

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
  const slideIn = useRef(new Animated.Value(30)).current;
  const fade    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    slideIn.setValue(30);
    fade.setValue(0);
    Animated.parallel([
      Animated.timing(slideIn, { toValue: 0, duration: 340, useNativeDriver: false }),
      Animated.timing(fade,    { toValue: 1, duration: 280, useNativeDriver: false }),
    ]).start();
  }, [step]);

  return (
    <Animated.View
      style={{
        position:        'absolute',
        bottom:          TAB_BAR_H + 12,
        left:            14,
        right:           14,
        backgroundColor: '#faf9f7',
        borderRadius:    22,
        padding:         22,
        opacity:         fade,
        transform:       [{ translateY: slideIn }],
        shadowColor:     '#000',
        shadowOpacity:   0.20,
        shadowRadius:    24,
        shadowOffset:    { width: 0, height: 6 },
        elevation:       16,
      }}
    >
      {/* Upward-pointing arrow — visual connector to spotlight above */}
      <View
        style={{
          position:           'absolute',
          top:               -10,
          left:              CARD_W / 2 - 10,  // centered on card
          width:              0,
          height:             0,
          borderLeftWidth:    10,
          borderRightWidth:   10,
          borderBottomWidth:  10,
          borderLeftColor:   'transparent',
          borderRightColor:  'transparent',
          borderBottomColor: '#faf9f7',
        }}
      />

      {/* Step progress dots + skip */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 5 }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View
              key={i}
              style={{
                width:           i === stepIdx ? 24 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: i <= stepIdx ? '#1c1917' : '#e7e5e4',
              }}
            />
          ))}
        </View>
        <TouchableOpacity
          onPress={onSkip}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={{ fontSize: 13, color: '#a8a29e', fontWeight: '500' }}>
            Skip tour
          </Text>
        </TouchableOpacity>
      </View>

      {/* Title */}
      <Text
        style={{
          fontSize:     22,
          fontWeight:   '800',
          color:        '#1c1917',
          lineHeight:   28,
          marginBottom: 8,
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

  const spotRect: TargetRect | null =
    getWtTarget(`${wtStep}_content`) ?? def.spotlightRect;

  const stepIdx    = WT_OVERLAY_STEPS.indexOf(wtStep);
  const totalSteps = WT_OVERLAY_STEPS.length;

  function handleSkip() {
    wtEvt_skipped(wtStep!);
    skip();
  }

  function handleHotspotTap() {
    wtEvt_hotspotTapped(wtStep!);
    advance();
  }

  return (
    <View
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        pointerEvents: 'box-none',
      }}
    >
      {/* Spotlight aperture */}
      {spotRect ? (
        <SpotlightAperture rect={spotRect} fade={overlayFade} />
      ) : (
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

      {/* Touch blocker — blocks touches on dim area, lets tab bar through */}
      <View
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          bottom: TAB_BAR_H,
        }}
        pointerEvents="box-only"
      />

      {/* In-screen hotspot — rendered ABOVE the blocker so it receives touches */}
      {def.inScreenHotspot && (
        <InScreenHotspot
          pos={def.inScreenHotspot}
          onPress={handleHotspotTap}
        />
      )}

      {/* Pulsing ring on tab icon */}
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
