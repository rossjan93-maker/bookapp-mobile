import React, { useEffect, useRef } from 'react';
import { Animated, Text, View, ViewStyle } from 'react-native';

const FILL  = '#e8e5e1';
const FILL2 = '#ede9e4';
const BG    = '#f5f1ec';

// ── Pulse ──────────────────────────────────────────────────────────────────────
// Wraps children in a repeating opacity animation so all contained placeholder
// boxes breathe together.

function Pulse({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const anim = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1,   duration: 900, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.5, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={[{ opacity: anim }, style]}>{children}</Animated.View>;
}

// ── PlaceholderBox ─────────────────────────────────────────────────────────────

function Box({
  w = '100%' as number | string,
  h,
  r = 6,
  c = FILL,
  style,
}: {
  w?: number | string;
  h: number;
  r?: number;
  c?: string;
  style?: ViewStyle;
}) {
  return (
    <View style={[{ width: w as any, height: h, borderRadius: r, backgroundColor: c }, style]} />
  );
}

// ── SectionLabelSkeleton ───────────────────────────────────────────────────────
// Placeholder for an 11px all-caps section label.

function SectionLabelSkeleton({ label }: { label: string }) {
  return (
    <Text style={{
      fontSize: 11, fontWeight: '700', color: '#c8c4bf',
      letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 12,
    }}>
      {label}
    </Text>
  );
}

// ── RecCardSkeleton ────────────────────────────────────────────────────────────
// Matches the RecCard layout exactly:
//   cover (44×64 standard / 52×76 featured) + title/author/reason + action bar
// The action bar placeholder prevents layout shift when real cards arrive.

export function RecCardSkeleton({ featured = false }: { featured?: boolean }) {
  const coverW = featured ? 52 : 44;
  const coverH = featured ? 76 : 64;
  return (
    <Pulse style={{
      backgroundColor: '#fefcf9',
      borderRadius: 12,
      marginBottom: 8,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: '#ede9e4',
    }}>
      {featured && <Box w="100%" h={3} r={0} c={FILL} />}
      <View style={{ padding: 12, flexDirection: 'row', alignItems: 'flex-start' }}>
        <Box w={coverW} h={coverH} r={5} />
        <View style={{ flex: 1, marginLeft: 12, gap: 7 }}>
          <Box w="65%" h={14} />
          <Box w="42%" h={11} c={FILL2} />
          <Box w="80%" h={11} c={FILL2} />
        </View>
      </View>
      <View style={{
        borderTopWidth: 1, borderTopColor: '#ede9e4',
        height: 44, flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 12, gap: 16,
      }}>
        <Box w={90} h={11} />
        <Box w={60} h={11} c={FILL2} />
        <Box w={70} h={11} c={FILL2} />
      </View>
    </Pulse>
  );
}

// ── DescriptionSkeleton ────────────────────────────────────────────────────────
// Matches Book Detail "About & Subjects" card:
//   white card, 18px padding, "ABOUT" label + 4 text-line placeholders.
// Shown in place of ActivityIndicator while metaLoading is true.

export function DescriptionSkeleton() {
  return (
    <Pulse style={{
      backgroundColor: '#fefcf9',
      borderRadius: 14,
      padding: 18,
      marginBottom: 20,
      borderWidth: 1,
      borderColor: '#ede9e4',
    }}>
      <Box w={48} h={11} r={4} c={FILL2} style={{ marginBottom: 10 }} />
      <View style={{ gap: 8 }}>
        <Box w="100%" h={13} />
        <Box w="92%"  h={13} />
        <Box w="78%"  h={13} />
        <Box w="55%"  h={13} c={FILL2} />
      </View>
    </Pulse>
  );
}

// ── ProgressCardSkeleton ───────────────────────────────────────────────────────
// Matches Book Detail "Reading Progress" card content area.
// The card has a big % number (36px), progress bar (8px), and text lines.
// Shown instead of ActivityIndicator while progressLoading is true.

export function ProgressCardSkeleton() {
  return (
    <Pulse>
      {/* Big percentage placeholder (36px font, weight 800) */}
      <Box w={80} h={36} r={7} style={{ marginBottom: 8 }} />
      {/* Progress bar (8px height, full width) */}
      <Box w="100%" h={8} r={4} style={{ marginBottom: 8 }} />
      {/* "Page X of Y" caption */}
      <Box w="55%" h={13} r={5} c={FILL2} style={{ marginBottom: 14 }} />
      {/* Finish estimate line */}
      <Box w="72%" h={13} r={5} c={FILL2} style={{ marginBottom: 14 }} />
      {/* Pacing chip */}
      <Box w={88} h={28} r={14} c={FILL2} />
    </Pulse>
  );
}

// ── ReadingCardSkeleton ────────────────────────────────────────────────────────
// Matches the single-book currently-reading card on Home:
//   cover 56×82, title/author, progress bar + label.

function ReadingCardSkeleton() {
  return (
    <Pulse style={{
      backgroundColor: '#fefcf9',
      borderRadius: 16,
      padding: 16,
      flexDirection: 'row',
      alignItems: 'center',
      borderLeftWidth: 3,
      borderLeftColor: '#ede9e4',
      shadowColor: '#000',
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    }}>
      <Box w={56} h={82} r={5} />
      <View style={{ flex: 1, marginLeft: 16, gap: 7 }}>
        <Box w="65%" h={16} />
        <Box w="42%" h={13} c={FILL2} />
        <View style={{ height: 12 }} />
        <Box w="100%" h={3} r={2} />
        <Box w="35%" h={11} c={FILL2} />
      </View>
      <Box w={20} h={20} r={10} c={FILL2} style={{ marginLeft: 8 }} />
    </Pulse>
  );
}

// ── GoalCardSkeleton ───────────────────────────────────────────────────────────
// Matches the Reading Goal card on Home.

function GoalCardSkeleton() {
  return (
    <Pulse style={{
      backgroundColor: '#fefcf9',
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Box w="55%" h={13} />
          <Box w="38%" h={11} c={FILL2} />
        </View>
        <Box w={32} h={11} c={FILL2} />
      </View>
      <Box w="100%" h={7} r={4} />
    </Pulse>
  );
}

// ── ActivityRowSkeleton ────────────────────────────────────────────────────────
// Matches a social feed / timeline row on Home.

function ActivityRowSkeleton() {
  return (
    <Pulse style={{
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
    }}>
      <Box w={32} h={32} r={16} />
      <View style={{ flex: 1, marginLeft: 12, gap: 6 }}>
        <Box w="70%" h={13} />
        <Box w="45%" h={11} c={FILL2} />
      </View>
    </Pulse>
  );
}

// ── LibraryRowSkeleton ─────────────────────────────────────────────────────────
// Matches a library book row (non-reading): cover 42×62 + title/author/badge.

function LibraryRowSkeleton() {
  return (
    <Pulse style={{ paddingVertical: 12, flexDirection: 'row', alignItems: 'center' }}>
      <Box w={42} h={62} r={4} />
      <View style={{ flex: 1, marginLeft: 12, gap: 7 }}>
        <Box w="60%" h={14} />
        <Box w="38%" h={12} c={FILL2} />
        <Box w={72}  h={18} r={9} c={FILL2} />
      </View>
    </Pulse>
  );
}

// ── HomeScreenSkeleton ─────────────────────────────────────────────────────────
// Full-page Home loading state. Replaces the centered ActivityIndicator on
// cold start. Shows the structural layout with branded placeholders so the
// user sees a settled, intentional UI while data loads.

export function HomeScreenSkeleton() {
  return (
    <View style={{ flex: 1, backgroundColor: BG, paddingHorizontal: 20, paddingTop: 24 }}>
      {/* Hero heading */}
      <Pulse style={{ marginBottom: 28 }}>
        <Box w={110} h={20} r={6} c={FILL2} />
      </Pulse>

      {/* Continue Reading */}
      <SectionLabelSkeleton label="Continue Reading" />
      <ReadingCardSkeleton />
      <View style={{ height: 32 }} />

      {/* Reading Goal */}
      <SectionLabelSkeleton label="Reading Goal" />
      <GoalCardSkeleton />
      <View style={{ height: 32 }} />

      {/* Timeline */}
      <SectionLabelSkeleton label="Timeline" />
      <ActivityRowSkeleton />
      <View style={{ height: 1, backgroundColor: '#ede9e4' }} />
      <ActivityRowSkeleton />
      <View style={{ height: 1, backgroundColor: '#ede9e4' }} />
      <ActivityRowSkeleton />
    </View>
  );
}

// ── ProfileScreenSkeleton ─────────────────────────────────────────────────────
// Full-page Profile loading state. Covers the header (avatar + name + username),
// reading goal card, taste profile card, reading intelligence card, and friends
// section so the screen feels settled before data arrives.

export function ProfileScreenSkeleton() {
  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      {/* Header block */}
      <View style={{
        paddingHorizontal: 24,
        paddingTop: 48,
        paddingBottom: 28,
        borderBottomWidth: 1,
        borderBottomColor: '#ede9e4',
      }}>
        <Pulse style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          {/* Avatar circle */}
          <Box w={60} h={60} r={30} style={{ marginRight: 16, flexShrink: 0 }} />
          {/* Name + username */}
          <View style={{ flex: 1, paddingTop: 2, gap: 8 }}>
            <Box w="52%" h={22} r={6} />
            <Box w="32%" h={13} r={5} c={FILL2} />
            <Box w="42%" h={13} r={5} c={FILL2} style={{ marginTop: 4 }} />
          </View>
          {/* Settings link placeholder */}
          <Box w={52} h={13} r={5} c={FILL2} style={{ marginTop: 3 }} />
        </Pulse>
      </View>

      {/* Reading Goal card */}
      <View style={{ paddingHorizontal: 24, marginTop: 24 }}>
        <Pulse style={{
          backgroundColor: '#fefcf9',
          borderRadius: 14,
          padding: 16,
          shadowColor: '#000',
          shadowOpacity: 0.04,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box w="48%" h={13} r={5} />
            <Box w={28} h={13} r={5} c={FILL2} />
          </View>
        </Pulse>
      </View>

      {/* Taste profile card */}
      <View style={{ paddingHorizontal: 24, marginTop: 14 }}>
        <Pulse style={{
          backgroundColor: '#fefcf9',
          borderRadius: 14,
          padding: 16,
          shadowColor: '#000',
          shadowOpacity: 0.04,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
          gap: 8,
        }}>
          <Box w="38%" h={13} r={5} />
          <Box w="62%" h={12} r={5} c={FILL2} />
        </Pulse>
      </View>

      {/* Reading intelligence card */}
      <View style={{ paddingHorizontal: 24, marginTop: 14, marginBottom: 28 }}>
        <Pulse style={{
          backgroundColor: '#fefcf9',
          borderRadius: 14,
          padding: 18,
          shadowColor: '#000',
          shadowOpacity: 0.04,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
          gap: 8,
        }}>
          <Box w={80} h={18} r={6} c={FILL2} />
          <Box w="72%" h={13} r={5} />
          <Box w="58%" h={12} r={5} c={FILL2} />
        </Pulse>
      </View>

      {/* Friends section */}
      <View style={{ paddingHorizontal: 24 }}>
        <SectionLabelSkeleton label="Friends" />
        <Pulse style={{
          backgroundColor: '#fefcf9',
          borderRadius: 14,
          overflow: 'hidden',
          shadowColor: '#000',
          shadowOpacity: 0.04,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        }}>
          {[0, 1, 2].map(i => (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 13,
                paddingHorizontal: 16,
                borderTopWidth: i > 0 ? 1 : 0,
                borderTopColor: '#ede9e4',
              }}
            >
              <Box w={36} h={36} r={18} style={{ marginRight: 12 }} />
              <View style={{ flex: 1, gap: 6 }}>
                <Box w="42%" h={13} r={5} />
                <Box w="28%" h={11} r={4} c={FILL2} />
              </View>
            </View>
          ))}
        </Pulse>
      </View>
    </View>
  );
}

// ── InboxScreenSkeleton ────────────────────────────────────────────────────────
// Full-page Inbox/Notes loading state. Shows the heading, subtitle, section
// label, and 2 recommendation card stubs so the screen feels structured before
// data arrives.

export function InboxScreenSkeleton() {
  return (
    <View style={{ flex: 1, backgroundColor: BG, paddingHorizontal: 20, paddingTop: 24 }}>
      {/* "Inbox" heading */}
      <Pulse style={{ marginBottom: 22 }}>
        <Box w={80} h={28} r={6} style={{ marginBottom: 7 }} />
        <Box w="56%" h={13} r={5} c={FILL2} />
      </Pulse>

      {/* Section label "NEW" */}
      <SectionLabelSkeleton label="New" />

      {/* Recommendation card stub × 2 */}
      {[0, 1].map(i => (
        <Pulse
          key={i}
          style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            borderLeftWidth: 3,
            borderLeftColor: '#e7d5b8',
            padding: 16,
            marginBottom: 10,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        >
          {/* Sender label */}
          <Box w={90} h={10} r={4} c={FILL2} style={{ marginBottom: 10 }} />
          {/* Cover + title/author */}
          <View style={{ flexDirection: 'row', marginBottom: 14 }}>
            <Box w={48} h={70} r={4} />
            <View style={{ flex: 1, marginLeft: 14, gap: 8 }}>
              <Box w="72%" h={16} r={5} />
              <Box w="48%" h={13} r={5} c={FILL2} />
            </View>
          </View>
          {/* Action button */}
          <Box w="100%" h={38} r={9} c={FILL2} />
        </Pulse>
      ))}
    </View>
  );
}

// ── LibraryScreenSkeleton ──────────────────────────────────────────────────────
// Full-page Library loading state. Shows the header, filter chips and book
// rows as placeholders so the screen feels structured while data loads.

export function LibraryScreenSkeleton() {
  return (
    <View style={{ flex: 1, backgroundColor: BG, paddingHorizontal: 20 }}>
      {/* Header row — "Library" + action area */}
      <View style={{
        flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
        paddingTop: 24, paddingBottom: 16,
      }}>
        <Text style={{ fontSize: 28, fontWeight: '800', color: '#231f1b', letterSpacing: -0.5, lineHeight: 34 }}>
          Library
        </Text>
        <Pulse>
          <Box w={94} h={34} r={8} c={FILL2} />
        </Pulse>
      </View>

      {/* Filter chip row */}
      <Pulse style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
        {[52, 64, 72, 60].map((w, i) => (
          <Box key={i} w={w} h={30} r={15} c={FILL2} />
        ))}
      </Pulse>

      {/* Divider */}
      <View style={{ height: 1, backgroundColor: '#ede9e4' }} />

      {/* Book rows */}
      {[0, 1, 2, 3, 4].map(i => (
        <React.Fragment key={i}>
          <LibraryRowSkeleton />
          {i < 4 && <View style={{ height: 1, backgroundColor: '#ede9e4' }} />}
        </React.Fragment>
      ))}
    </View>
  );
}
