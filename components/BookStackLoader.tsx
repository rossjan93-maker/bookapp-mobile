/**
 * BookStackLoader
 *
 * Five books building upward one by one into a tidy stack.
 * Premium, editorial, minimal — no cartoonish bounce.
 *
 * Build phase: each book springs up from below with a 160ms stagger.
 * Idle phase:  the whole stack breathes with a gentle scale pulse, looping.
 *
 * Props:
 *   size   'sm' | 'lg'  — sm ≈ 60% scale for inline overlays, lg for welcome screen
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

// ─── Book definitions ─────────────────────────────────────────────────────────
// Books are ordered bottom → top (index 0 = bottom of stack).
// Each has a fixed color, slight tilt, and a pixel nudge so the stack looks
// hand-placed rather than mechanically centered.

type BookDef = {
  color:   string;
  rotate:  number;  // degrees
  nudgeX:  number;  // horizontal shift for organic placement
};

const BOOKS: BookDef[] = [
  { color: '#c9bdb0', rotate:  1.5, nudgeX:  1 },   // warm stone
  { color: '#b5c4b1', rotate: -2.0, nudgeX: -2 },   // muted sage
  { color: '#d6d0c8', rotate:  0.8, nudgeX:  2 },   // light linen
  { color: '#c2bab0', rotate: -1.2, nudgeX: -1 },   // soft taupe
  { color: '#15803d', rotate:  2.0, nudgeX:  1 },   // green accent (top)
];

// ─── Sizes ────────────────────────────────────────────────────────────────────

const SIZES = {
  sm: { bookW: 34, bookH: 48, gap: 4,  containerW: 72,  containerH: 96  },
  lg: { bookW: 54, bookH: 76, gap: 6,  containerW: 110, containerH: 148 },
} as const;

// ─── Single book ──────────────────────────────────────────────────────────────

function Book({
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
  const translateY = buildAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [bookH * 0.6, 0],
  });
  const opacity = buildAnim.interpolate({
    inputRange:  [0, 0.4, 1],
    outputRange: [0, 0.85, 1],
  });

  return (
    <Animated.View
      style={{
        position:        'absolute',
        width:           bookW,
        height:          bookH,
        borderRadius:    4,
        backgroundColor: def.color,
        transform: [
          { translateX: def.nudgeX },
          { rotate:     `${def.rotate}deg` },
          { translateY },
        ],
        opacity,
        shadowColor:    '#1c1917',
        shadowOpacity:  0.13,
        shadowRadius:   8,
        shadowOffset:   { width: 0, height: 3 },
        elevation:      4,
      }}
    >
      {/* Subtle spine detail lines */}
      <View style={{ position: 'absolute', top: bookH * 0.14, left: bookW * 0.18, right: bookW * 0.18 }}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={{
              height:          1,
              borderRadius:    1,
              backgroundColor: def.color === '#15803d'
                ? 'rgba(255,255,255,0.20)'
                : 'rgba(28,25,23,0.10)',
              marginBottom:    bookH * 0.07,
              width:           i === 0 ? '80%' : i === 1 ? '55%' : '68%',
            }}
          />
        ))}
      </View>
    </Animated.View>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BookStackLoader({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const { bookW, bookH, gap, containerW, containerH } = SIZES[size];

  // One Animated.Value per book (build phase)
  const buildAnims = useRef(BOOKS.map(() => new Animated.Value(0))).current;
  // Shared value for the idle breath
  const breatheAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // ── Build: stagger each book appearing from below ──────────────────────────
    const STAGGER = 160;   // ms between each book
    const DURATION = 420;  // ms per book spring-in

    const buildSeq = BOOKS.map((_, i) =>
      Animated.sequence([
        Animated.delay(i * STAGGER),
        Animated.timing(buildAnims[i], {
          toValue:         1,
          duration:        DURATION,
          easing:          Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ])
    );

    // After all books are visible, start the idle breath loop
    const totalBuildTime = BOOKS.length * STAGGER + DURATION + 80;

    Animated.parallel(buildSeq).start();

    const idleTimer = setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(breatheAnim, {
            toValue:         1.025,
            duration:        1300,
            easing:          Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
          Animated.timing(breatheAnim, {
            toValue:         1.0,
            duration:        1300,
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

  // Stack: books are laid out bottom-to-top by stacking each book
  // at progressively higher `bottom` offsets within the container.

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
        // bottom offset: book 0 sits at bottom, each successive book stacks on top
        const bottomOffset = i * (bookH - gap);
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
            <Book
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
