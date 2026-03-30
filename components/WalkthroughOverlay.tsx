// ─── In-app walkthrough overlay ───────────────────────────────────────────────
//
// Full-screen overlay drawn inside the live app shell.
//
// For each WT_OVERLAY_STEP ('home', 'recommend', 'library', 'inbox') it renders:
//
//   1. SpotlightAperture (immediate)
//      4 dim panels leave a clear rectangular window.  A crisp border frames it
//      with a soft outer aura suggesting component elevation.
//
//   2. Readiness gate
//      The overlay polls getWtTarget(`${step}_content`) every 80ms.
//      For steps where the screen registers a real rect (home, recommend, inbox),
//      the spotlight appears as soon as the component is measured.
//      Library is frozen — it falls back to the fixed spotlightRect after minDelay.
//      Coach card, hotspot, and pulsing ring only render once stepReady=true.
//
//   3. InScreenHotspot (only when stepReady)
//      Dual-ring pulsing dot.  Position derived from the measured rect + step's
//      hotspotAnchor, so it lands on an actual product element, not a guess.
//
//   4. PulsingRing (only when stepReady)
//      Pulsing circle over the active tab icon.
//
//   5. CoachCard (only when stepReady)
//      Title, body, progress dots, skip, and Next button.

import React, { useEffect, useRef, useState } from 'react';
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
  resolveHotspot,
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
const DIM_COLOR   = 'rgba(0,0,0,0.54)';
// Warm amber glow — emanates from behind the focal card into the dim field
const GLOW_A = 'rgba(212,165,116,0.17)';
const GLOW_B = 'rgba(212,165,116,0.11)';
const GLOW_C = 'rgba(212,165,116,0.06)';
const CARD_W  = SW - 28;
// Estimated coach-card height for dynamic positioning (avoids onLayout complexity)
const COACH_H_EST = 262;

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
        borderColor:  'rgba(255,255,255,0.65)',
        transform:    [{ scale }],
        opacity,
      }}
    />
  );
}

// ─── 2. Warm glow halo ────────────────────────────────────────────────────────
//
// Three concentric rounded rects rendered above the full-screen dim, behind the
// focal card.  Creates the "warm backlight emanating from the object" effect.
// No sharp edges — purely additive warm light in the dim field.

function GlowHalo({ rect }: { rect: TargetRect }) {
  const { x, y, width, height } = rect;
  return (
    <>
      <View pointerEvents="none" style={{
        position:        'absolute',
        top:             y - 36,
        left:            x - 40,
        width:           width  + 80,
        height:          height + 72,
        borderRadius:    36,
        backgroundColor: GLOW_C,
      }} />
      <View pointerEvents="none" style={{
        position:        'absolute',
        top:             y - 19,
        left:            x - 21,
        width:           width  + 42,
        height:          height + 38,
        borderRadius:    26,
        backgroundColor: GLOW_B,
      }} />
      <View pointerEvents="none" style={{
        position:        'absolute',
        top:             y - 8,
        left:            x - 9,
        width:           width  + 18,
        height:          height + 16,
        borderRadius:    20,
        backgroundColor: GLOW_A,
      }} />
    </>
  );
}

// ─── 3. Focal card components ─────────────────────────────────────────────────
//
// Each renders the step's focal card ABOVE the full-screen dim at the exact
// measured coordinates.  The card floats visually — no surrounding lit region,
// no rectangular cutout.  Scale + stronger shadow + warm border do the lifting.
//
// These are demo-only cards. TouchableOpacity elements have no onPress so they
// give feedback on touch without navigating.

const FOCAL_CARD_SHADOW = {
  shadowColor:   '#000',
  shadowOpacity: 0.32,
  shadowRadius:  28,
  shadowOffset:  { width: 0, height: 10 } as const,
  elevation:     20,
};

function HomeFocalCard({ rect }: { rect: TargetRect }) {
  return (
    <View style={{
      position:       'absolute',
      top:            rect.y,
      left:           rect.x,
      width:          rect.width,
      backgroundColor: '#fff',
      borderRadius:   14,
      padding:        14,
      borderLeftWidth: 3,
      borderLeftColor: '#d4a574',
      borderWidth:    1.5,
      borderColor:    'rgba(212,165,116,0.48)',
      ...FOCAL_CARD_SHADOW,
      transform:      [{ scale: 1.02 }],
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
        <View style={{ width: 44, height: 64, borderRadius: 6, backgroundColor: '#ddd5c8' }} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917', lineHeight: 19, marginBottom: 3 }} numberOfLines={2}>
            The Thursday Murder Club
          </Text>
          <Text style={{ fontSize: 12, color: '#78716c' }}>Richard Osman</Text>
        </View>
      </View>
      <View style={{ height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
        <View style={{ height: 3, width: '63%', backgroundColor: '#1c1917', borderRadius: 2 }} />
      </View>
      <Text style={{ fontSize: 10, color: '#a8a29e' }}>Page 270 of 382 · 63%</Text>
    </View>
  );
}

function RecommendFocalCard({ rect }: { rect: TargetRect }) {
  return (
    <View style={{
      position:       'absolute',
      top:            rect.y,
      left:           rect.x,
      width:          rect.width,
      backgroundColor: '#fff',
      borderRadius:   14,
      overflow:       'hidden',
      ...FOCAL_CARD_SHADOW,
      transform:      [{ scale: 1.02 }],
    }}>
      <View style={{ height: 3, backgroundColor: '#1c1917' }} />
      <View style={{ padding: 12, flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ width: 52, height: 76, borderRadius: 6, backgroundColor: '#ddd5c8' }} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#1c1917', lineHeight: 21, marginBottom: 3 }} numberOfLines={2}>
            Project Hail Mary
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6 }}>
            <Text style={{ fontSize: 12, color: '#78716c', flex: 1 }} numberOfLines={1}>Andy Weir</Text>
            <View style={{ backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 }}>
              <Text style={{ fontSize: 9, fontWeight: '700', color: '#15803d', letterSpacing: 0.3 }}>TOP PICK</Text>
            </View>
          </View>
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', lineHeight: 18 }} numberOfLines={2}>
            Long-form science with immersive pacing
          </Text>
        </View>
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: '#f0eeeb', flexDirection: 'row' }}>
        <TouchableOpacity activeOpacity={0.7} style={{ flex: 1, paddingVertical: 13, paddingHorizontal: 14, justifyContent: 'center', borderRightWidth: 1, borderRightColor: '#f0eeeb' }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917' }}>Want to Read</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={{ paddingVertical: 13, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', borderRightWidth: 1, borderRightColor: '#f0eeeb' }}>
          <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '500' }}>Not for me</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} style={{ paddingVertical: 13, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '500' }}>More like this</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function LibraryFocalCard({ rect }: { rect: TargetRect }) {
  return (
    <View style={{
      position:       'absolute',
      top:            rect.y,
      left:           rect.x,
      width:          rect.width,
      backgroundColor: '#fff',
      borderRadius:   14,
      borderLeftWidth: 3,
      borderLeftColor: '#3b82f6',
      borderWidth:    1.5,
      borderColor:    'rgba(59,130,246,0.42)',
      padding:        14,
      ...FOCAL_CARD_SHADOW,
      transform:      [{ scale: 1.02 }],
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ width: 44, height: 64, borderRadius: 6, backgroundColor: '#ddd5c8' }} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917', lineHeight: 19, marginBottom: 3 }} numberOfLines={2}>
            The Midnight Library
          </Text>
          <Text style={{ fontSize: 12, color: '#78716c' }}>Matt Haig</Text>
        </View>
      </View>
      <View style={{ height: 3, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden', marginTop: 10, marginBottom: 4 }}>
        <View style={{ height: 3, width: '34%', backgroundColor: '#3b82f6', borderRadius: 2 }} />
      </View>
      <Text style={{ fontSize: 10, color: '#a8a29e' }}>Page 145 of 432 · 34%</Text>
    </View>
  );
}

function InboxFocalCard({ rect }: { rect: TargetRect }) {
  return (
    <View style={{
      position:       'absolute',
      top:            rect.y,
      left:           rect.x,
      width:          rect.width,
      backgroundColor: '#fffbf5',
      borderRadius:   14,
      borderLeftWidth: 3,
      borderLeftColor: '#d4a574',
      borderWidth:    1.5,
      borderColor:    'rgba(212,165,116,0.48)',
      padding:        16,
      ...FOCAL_CARD_SHADOW,
      transform:      [{ scale: 1.02 }],
    }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color: '#b8860b', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
        From Alex
      </Text>
      <View style={{ flexDirection: 'row', marginBottom: 12 }}>
        <View style={{ width: 48, height: 70, borderRadius: 6, backgroundColor: '#ddd5c8' }} />
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={{ fontWeight: '700', fontSize: 16, color: '#1c1917', lineHeight: 22, marginBottom: 3 }}>
            The Song of Achilles
          </Text>
          <Text style={{ color: '#78716c', fontSize: 13 }}>Madeline Miller</Text>
        </View>
      </View>
      <View style={{ backgroundColor: '#fffbf2', borderTopWidth: 1, borderTopColor: '#f0ede8', paddingTop: 10, paddingHorizontal: 10, paddingBottom: 8, borderRadius: 6, marginBottom: 14 }}>
        <Text style={{ fontSize: 13, color: '#57534e', fontStyle: 'italic', lineHeight: 20 }}>
          "You need to read this. Trust me."
        </Text>
      </View>
      <TouchableOpacity activeOpacity={0.8} style={{ alignSelf: 'flex-start', paddingHorizontal: 16, paddingVertical: 9, backgroundColor: '#1c1917', borderRadius: 8 }}>
        <Text style={{ color: '#faf9f7', fontSize: 13, fontWeight: '700' }}>Want to Read</Text>
      </TouchableOpacity>
    </View>
  );
}

function renderFocalCard(step: WtStep, rect: TargetRect): React.ReactElement | null {
  switch (step) {
    case 'home':      return <HomeFocalCard      rect={rect} />;
    case 'recommend': return <RecommendFocalCard rect={rect} />;
    case 'library':   return <LibraryFocalCard   rect={rect} />;
    case 'inbox':     return <InboxFocalCard      rect={rect} />;
    default:          return null;
  }
}

// ─── 3. In-screen hotspot ─────────────────────────────────────────────────────
//
// Dual-ring pulsing dot.  Position is derived from the measured rect + anchor,
// so it lands on a real product element (cover thumbnail left-center, or card center).
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
            Animated.timing(scale,   { toValue: 1,    duration: 0, useNativeDriver: false }),
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
      <Animated.View
        pointerEvents="none"
        style={{
          position:     'absolute',
          width:        RING,
          height:       RING,
          borderRadius: RING / 2,
          borderWidth:  1.5,
          borderColor:  '#faf9f7',
          transform:    [{ scale: ring1Scale }],
          opacity:      ring1Opacity,
        }}
      />
      <Animated.View
        pointerEvents="none"
        style={{
          position:     'absolute',
          width:        RING,
          height:       RING,
          borderRadius: RING / 2,
          borderWidth:  1.5,
          borderColor:  '#faf9f7',
          transform:    [{ scale: ring2Scale }],
          opacity:      ring2Opacity,
        }}
      />
      <View
        style={{
          width:           DOT,
          height:          DOT,
          borderRadius:    DOT / 2,
          backgroundColor: '#faf9f7',
          shadowColor:     '#faf9f7',
          shadowOpacity:   0.6,
          shadowRadius:    5,
          shadowOffset:    { width: 0, height: 0 },
        }}
      />
    </TouchableOpacity>
  );
}

// ─── 4. Coach card ────────────────────────────────────────────────────────────
//
// Dynamically positioned below (or above, if near screen bottom) the focal card.
// The connecting arrow always points toward the card, making it feel "attached"
// to the specific object being explained — not floating generically at the bottom.

function CoachCard({
  step,
  totalSteps,
  stepIdx,
  def,
  cardRect,
  onNext,
  onSkip,
}: {
  step:       WtStep;
  totalSteps: number;
  stepIdx:    number;
  def:        typeof WT_DEFS[keyof typeof WT_DEFS];
  cardRect:   TargetRect | null;
  onNext:     () => void;
  onSkip:     () => void;
}) {
  const slideIn = useRef(new Animated.Value(20)).current;
  const fade    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    slideIn.setValue(20);
    fade.setValue(0);
    Animated.parallel([
      Animated.timing(slideIn, { toValue: 0, duration: 320, useNativeDriver: false }),
      Animated.timing(fade,    { toValue: 1, duration: 260, useNativeDriver: false }),
    ]).start();
  }, [step]);

  // Compute position: prefer just below the card, fall back above if cramped.
  const GAP       = 14;
  const SIDE      = 14;
  const SAFE_BOT  = TAB_BAR_H + 8;

  let positionStyle: object;
  let arrowAbove: boolean; // true = arrow at top of coach card (pointing up to card above)

  if (cardRect) {
    const belowTop = cardRect.y + cardRect.height + GAP;
    const fitsBelow = belowTop + COACH_H_EST < SH - SAFE_BOT;

    if (fitsBelow) {
      positionStyle = { top: belowTop, left: SIDE, right: SIDE };
      arrowAbove    = true;   // coach is below the card → arrow points UP toward card
    } else {
      // Not enough room below — position coach above the card
      const aboveBottom = SH - cardRect.y + GAP;
      positionStyle = { bottom: aboveBottom, left: SIDE, right: SIDE };
      arrowAbove    = false;  // coach is above the card → arrow points DOWN toward card
    }
  } else {
    // Fallback: no rect yet — anchor at bottom
    positionStyle = { bottom: SAFE_BOT, left: SIDE, right: SIDE };
    arrowAbove    = true;
  }

  // Arrow horizontal position — aim at the card center, clamped inside coach bounds.
  const arrowLeft = cardRect
    ? Math.max(20, Math.min(CARD_W - 40, (cardRect.x + cardRect.width / 2) - SIDE - 10))
    : CARD_W / 2 - 10;

  return (
    <Animated.View
      style={{
        position:        'absolute',
        ...positionStyle,
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
      {/* Arrow connecting coach card to the focal card */}
      {arrowAbove ? (
        // Coach is BELOW the card — upward triangle at top
        <View
          style={{
            position:           'absolute',
            top:               -10,
            left:               arrowLeft,
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
      ) : (
        // Coach is ABOVE the card — downward triangle at bottom
        <View
          style={{
            position:        'absolute',
            bottom:         -10,
            left:            arrowLeft,
            width:           0,
            height:          0,
            borderLeftWidth:   10,
            borderRightWidth:  10,
            borderTopWidth:    10,
            borderLeftColor:  'transparent',
            borderRightColor: 'transparent',
            borderTopColor:   '#faf9f7',
          }}
        />
      )}

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

  const overlayFade   = useRef(new Animated.Value(0)).current;
  const prevStep      = useRef<WtStep | null>(null);
  const stepActiveAt  = useRef<number | null>(null);

  // stepReady gates the coach card, hotspot, and pulsing ring.
  // The dim aperture shows immediately; the rest waits until:
  //   (a) the screen has registered a real measured rect, OR
  //   (b) def.minDelay ms have elapsed (for frozen screens like Library).
  const [stepReady, setStepReady] = useState(false);

  const isVisible = wtStep !== null && (WT_OVERLAY_STEPS as string[]).includes(wtStep);

  // Fade the overlay in/out when step changes
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

  // Readiness polling — sets stepReady when content is measured or timeout elapses
  useEffect(() => {
    if (!isVisible || !wtStep) {
      setStepReady(false);
      stepActiveAt.current = null;
      return;
    }

    stepActiveAt.current = Date.now();
    setStepReady(false);

    const def      = WT_DEFS[wtStep as keyof typeof WT_DEFS];
    const minDelay = def?.minDelay ?? 0;

    // For steps with minDelay=0 and an already-registered rect, resolve immediately
    if (minDelay === 0 && getWtTarget(`${wtStep}_content`)) {
      setStepReady(true);
      return;
    }

    const interval = setInterval(() => {
      const hasRect  = !!getWtTarget(`${wtStep}_content`);
      const elapsed  = Date.now() - (stepActiveAt.current ?? 0);
      if (hasRect || elapsed >= minDelay) {
        setStepReady(true);
        clearInterval(interval);
      }
    }, 80);

    return () => clearInterval(interval);
  }, [wtStep, isVisible]);

  if (!isVisible || !wtStep) return null;

  const def = WT_DEFS[wtStep as keyof typeof WT_DEFS];
  if (!def) return null;

  // Use measured rect if available; fallback to static def rect
  const measuredRect = getWtTarget(`${wtStep}_content`);
  const spotRect: TargetRect | null = measuredRect ?? def.spotlightRect;

  // Hotspot position from real rect + anchor, or static fallback
  const hotspot = resolveHotspot(def, measuredRect ?? null);

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
      {/* Full-screen dim — no cutout aperture, no rectangular lit region */}
      <Animated.View
        pointerEvents="none"
        style={{
          position:        'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: DIM_COLOR,
          opacity:         overlayFade,
        }}
      />

      {/* Touch blocker — blocks all touches in the dim area, lets tab bar through */}
      <View
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: TAB_BAR_H }}
        pointerEvents="box-only"
      />

      {/* Focal content: only render once the card rect is confirmed */}
      {stepReady && measuredRect && (
        <>
          {/* Warm glow bloom — sits above the dim, behind the focal card */}
          <GlowHalo rect={measuredRect} />

          {/* The focal card — positioned at measured coordinates, floating above the dim */}
          {renderFocalCard(wtStep!, measuredRect)}

          {/* In-screen hotspot — tap target above the blocker */}
          <InScreenHotspot
            pos={hotspot}
            onPress={handleHotspotTap}
          />

          {/* Pulsing ring on the active tab icon */}
          <PulsingRing tabIdx={def.tabIdx} />

          {/* Coach card — dynamically positioned relative to the focal card */}
          <CoachCard
            step={wtStep!}
            totalSteps={totalSteps}
            stepIdx={stepIdx}
            def={def}
            cardRect={measuredRect}
            onNext={advance}
            onSkip={handleSkip}
          />
        </>
      )}
    </View>
  );
}
