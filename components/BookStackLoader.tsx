/**
 * BookStackLoader
 *
 * Five flat books dropping one by one onto a growing pile.
 * Orientation: horizontal / flat — wide and thin, like books seen from the side.
 * Each book drops from slightly above its resting position, staggered bottom→top.
 *
 * Build phase:  book 0 (bottom) appears first, then 1–4 drop in, 180ms apart.
 * Idle phase:   the whole stack breathes with a very subtle scale pulse, looping.
 *
 * Props:
 *   size   'sm' | 'lg'  — sm for inline overlays, lg for the welcome screen
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

// ─── Book definitions ─────────────────────────────────────────────────────────
// Books are ordered bottom → top (index 0 = base of pile).
// nudgeX: slight horizontal offset so the pile looks hand-placed, not machine-stacked.
// rotate: very small tilt — enough to read as organic, not enough to look playful.

type BookDef = {
  color:  string;
  nudgeX: number;  // px, relative to stack center
  rotate: number;  // degrees
};

const BOOKS: BookDef[] = [
  { color: '#c9bdb0', nudgeX:  0,   rotate:  0.4 },   // warm stone   — base
  { color: '#b5c4b1', nudgeX: -3,   rotate: -0.8 },   // muted sage
  { color: '#d6d0c8', nudgeX:  2,   rotate:  0.6 },   // light linen
  { color: '#c2bab0', nudgeX: -1,   rotate: -0.5 },   // soft taupe
  { color: '#7b9e7e', nudgeX:  2,   rotate:  0.9 },   // muted sage — top
];

// ─── Sizes ────────────────────────────────────────────────────────────────────
// bookW × bookH: wide and flat  (bookW >> bookH)
// stackH:        total height of the resting pile (BOOKS.length × (bookH + gap))
// containerH:    taller than stackH to give room for the drop animation entry

const SIZES = {
  sm: { bookW: 62,  bookH: 9,  gap: 2, containerW: 84,  containerH: 72  },
  lg: { bookW: 98,  bookH: 13, gap: 3, containerW: 128, containerH: 108 },
} as const;

// ─── Single flat book ─────────────────────────────────────────────────────────

function FlatBook({
  def,
  bookW,
  bookH,
  buildAnim,
}: {
  def:       BookDef;
  bookW:     number;
  bookH:     number;
  buildAnim: Animated.Value;
}) {
  // Drops from above: starts higher (negative Y = upward offset), settles to 0.
  const DROP_DIST = bookH * 2.8;
  const translateY = buildAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [-DROP_DIST, 0],
  });
  const opacity = buildAnim.interpolate({
    inputRange:  [0, 0.25, 1],
    outputRange: [0, 0.9, 1],
  });

  return (
    <Animated.View
      style={{
        position:        'absolute',
        width:           bookW,
        height:          bookH,
        borderRadius:    3,
        backgroundColor: def.color,
        transform: [
          { translateX: def.nudgeX },
          { rotate:     `${def.rotate}deg` },
          { translateY },
        ],
        opacity,
        // Subtle shadow under each book for depth
        shadowColor:   '#231f1b',
        shadowOpacity: 0.18,
        shadowRadius:  4,
        shadowOffset:  { width: 0, height: 2 },
        elevation:     3,
      }}
    >
      {/* Thin highlight line along the top edge — simulates cover edge */}
      <View
        style={{
          position:        'absolute',
          top:             0,
          left:            bookW * 0.06,
          right:           bookW * 0.06,
          height:          1,
          borderRadius:    1,
          backgroundColor: def.color === '#7b9e7e'
            ? 'rgba(255,255,255,0.22)'
            : 'rgba(255,255,255,0.55)',
        }}
      />
    </Animated.View>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BookStackLoader({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const { bookW, bookH, gap, containerW, containerH } = SIZES[size];

  const buildAnims  = useRef(BOOKS.map(() => new Animated.Value(0))).current;
  const breatheAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const STAGGER  = 140;   // ms between each book dropping in
    const DURATION = 420;   // ms for each book to settle

    // Each book: delay + drop. Easing.out gives the natural deceleration of
    // something settling under gravity — heavier feel than a linear slide.
    const buildSeq = BOOKS.map((_, i) =>
      Animated.sequence([
        Animated.delay(i * STAGGER),
        Animated.timing(buildAnims[i], {
          toValue:         1,
          duration:        DURATION,
          easing:          Easing.out(Easing.back(1.6)),
          useNativeDriver: false,
        }),
      ])
    );

    Animated.parallel(buildSeq).start();

    // Idle: very gentle collective breathe after all books have settled
    const totalBuildTime = BOOKS.length * STAGGER + DURATION + 120;
    const idleTimer = setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(breatheAnim, {
            toValue:         1.04,
            duration:        1600,
            easing:          Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
          Animated.timing(breatheAnim, {
            toValue:         1.0,
            duration:        1600,
            easing:          Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
        ])
      ).start();
    }, totalBuildTime);

    return () => {
      clearTimeout(idleTimer);
      breatheAnim.stopAnimation();
    };
  }, []);

  // Each book's resting position (bottom edge of its slot in the pile).
  // Book 0 sits at the very bottom of the container; each successive book
  // rests on top of the one below, separated by `gap` px.
  const slotH = bookH + gap;

  return (
    <Animated.View
      style={{
        width:          containerW,
        height:         containerH,
        alignItems:     'center',
        justifyContent: 'flex-end',
        transform:      [{ scale: breatheAnim }],
      }}
    >
      {BOOKS.map((def, i) => {
        // bottomOffset: book 0 rests at the bottom, each book stacks above it
        const bottomOffset = i * slotH;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              bottom:   bottomOffset,
              width:    bookW,
              height:   bookH,
              alignItems: 'center',
            }}
          >
            <FlatBook
              def={def}
              bookW={bookW}
              bookH={bookH}
              buildAnim={buildAnims[i]}
            />
          </View>
        );
      })}
    </Animated.View>
  );
}
