// ─── Shared onboarding screen shell ───────────────────────────────────────────
//
// Owns the complete vertical layout contract for all onboarding question steps.
// Every screen that uses this shell gets identical spacing automatically.
// Changing a value in OB updates every screen simultaneously.
//
// Layout structure:
//
//   ┌──────────────────────────────────────┐
//   │  [OB.padTop from safe-area edge]     │
//   │  [progressSlot]  [headerRight?]      │  ← OB.progressGap below
//   │  [title?]                            │  ← OB.titleMB below (or 10 if subtitle)
//   │  [subtitle?]                         │  ← OB.subtitleMB below
//   ├──────────────────────────────────────┤
//   │                                      │
//   │   children  (flex: 1)               │
//   │                                      │
//   ├──────────────────────────────────────┤
//   │  [primaryButton?]    (full-width)    │
//   │  [onSkipThis?]       (centered)      │  ← OB.bottomGap between each
//   │  [onSkipAll?]        (centered)      │
//   │  [OB.bottomPadB]                     │
//   └──────────────────────────────────────┘
//
// Screens using this shell:
//   IntakeTaste   — taste questions (3 option cards, auto-advance on tap)
//   IntakeGenres  — genre chips with scrollable list + Continue button
//   IntakeAnchor  — anchor book search + Continue/Skip button
//
// Note: IntakeTaste does NOT use the shell's `title` prop — the question
// prompt needs to participate in the slide animation alongside the option
// cards, so it lives inside `children` wrapped in the same Animated.View.
// The shell still provides consistent progress and bottom action zone.

import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

// ─── Spacing constants — single source of truth ───────────────────────────────

export const OB = {
  padH:        20,   // horizontal padding for header and bottom zones
  padTop:      28,   // breathing room from safe-area edge to first element
  progressGap: 14,   // space below progress row before title
  titleMB:     24,   // space below title before content (when no subtitle)
  subtitleMB:  20,   // space below subtitle before content
  cardMB:      12,   // margin between option cards
  bottomGap:   16,   // gap between items in the bottom action zone
  bottomPadB:  32,   // bottom padding in the action zone
} as const;

// ─── Palette (mirrors app-wide tokens) ────────────────────────────────────────

const INK  = '#231f1b';
const MUTED = '#9e958d';
const DIM   = '#c4bfb9';
const BORD  = '#ede9e4';
const BG    = '#f5f1ec';

// ─── Step dots ────────────────────────────────────────────────────────────────
// Pill-shaped dots indicating which major step within the intake flow the
// user is on (genres → taste → anchor). The active dot is wider.

export function StepDots({
  total,
  current,
  activeDotWidth = 22,
}: {
  total:           number;
  current:         number;
  activeDotWidth?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={{
            width:           i === current ? activeDotWidth : 6,
            height:          6,
            borderRadius:    3,
            backgroundColor: i <= current ? INK : BORD,
          }}
        />
      ))}
    </View>
  );
}

// ─── Sub-progress bar ─────────────────────────────────────────────────────────
// Equal-width segments that fill left-to-right as sub-steps advance.
// Used inside IntakeTaste to show which of the 3 taste questions is active.

export function SubProgressBar({
  total,
  current,
}: {
  total:   number;
  current: number;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 4, marginTop: 8 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={{
            flex:            1,
            height:          3,
            borderRadius:    2,
            backgroundColor: i <= current ? INK : BORD,
          }}
        />
      ))}
    </View>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────

export interface OnboardingShellProps {
  /** Left side of the progress row — pass StepDots, SubProgressBar, or both */
  progressSlot: React.ReactNode;
  /** Optional element anchored to the right of the progress row ("Skip all →") */
  headerRight?: React.ReactNode;
  /** Main question/step title. Omit when title is inside animated children. */
  title?: string;
  /** Optional supporting copy rendered below the title */
  subtitle?: string;
  /** Primary content — rendered inside flex:1 container */
  children: React.ReactNode;
  /** Full-width primary CTA, rendered above skip links in the bottom zone */
  primaryButton?: React.ReactNode;
  /** "Skip this question →" handler */
  onSkipThis?: () => void;
  skipThisLabel?: string;
  /** "Skip remaining" handler */
  onSkipAll?: () => void;
  skipAllLabel?: string;
}

export function OnboardingShell({
  progressSlot,
  headerRight,
  title,
  subtitle,
  children,
  primaryButton,
  onSkipThis,
  skipThisLabel = 'Skip this question →',
  onSkipAll,
  skipAllLabel  = 'Skip remaining',
}: OnboardingShellProps) {
  const hasSkips  = onSkipThis || onSkipAll;
  const hasBottom = primaryButton || hasSkips;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>

      {/* ── Header: progress + optional title + optional subtitle ────────── */}
      <View style={{ paddingHorizontal: OB.padH, paddingTop: OB.padTop }}>

        {/* Progress row */}
        <View style={{
          flexDirection:  'row',
          alignItems:     'center',
          justifyContent: headerRight ? 'space-between' : 'flex-start',
          marginBottom:   OB.progressGap,
        }}>
          <View>{progressSlot}</View>
          {headerRight}
        </View>

        {/* Title — omitted when caller puts animated title inside children */}
        {!!title && (
          <Text style={{
            fontSize:      22,
            fontWeight:    '800',
            color:         INK,
            lineHeight:    28,
            letterSpacing: -0.3,
            marginBottom:  subtitle ? 10 : OB.titleMB,
          }}>
            {title}
          </Text>
        )}

        {/* Subtitle */}
        {!!subtitle && (
          <Text style={{
            fontSize:     14,
            color:        '#78716c',
            lineHeight:   21,
            marginBottom: OB.subtitleMB,
          }}>
            {subtitle}
          </Text>
        )}
      </View>

      {/* ── Content: fills remaining space ───────────────────────────────── */}
      <View style={{ flex: 1 }}>
        {children}
      </View>

      {/* ── Bottom action zone ───────────────────────────────────────────── */}
      {hasBottom && (
        <View style={[
          {
            paddingHorizontal: OB.padH,
            paddingBottom:     OB.bottomPadB,
            gap:               OB.bottomGap,
          },
          // When there is a primary button, add a full-width hairline separator
          // and extra top padding so the button doesn't feel flush to the content.
          primaryButton != null && {
            borderTopWidth:  1,
            borderTopColor:  BORD,
            paddingTop:      16,
          },
        ]}>
          {/* Primary button — full width (no alignItems: center on container) */}
          {primaryButton}

          {/* Skip links — centered text */}
          {hasSkips && (
            <View style={{ alignItems: 'center', gap: OB.bottomGap }}>
              {onSkipThis && (
                <TouchableOpacity
                  onPress={onSkipThis}
                  hitSlop={{ top: 10, bottom: 10, left: 20, right: 20 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '500', color: MUTED }}>
                    {skipThisLabel}
                  </Text>
                </TouchableOpacity>
              )}
              {onSkipAll && (
                <TouchableOpacity
                  onPress={onSkipAll}
                  hitSlop={{ top: 10, bottom: 10, left: 20, right: 20 }}
                >
                  <Text style={{ fontSize: 13, color: DIM }}>
                    {skipAllLabel}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      )}

    </View>
  );
}
