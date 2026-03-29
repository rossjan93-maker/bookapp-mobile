import React, { useEffect, useRef } from 'react';
import { Animated, Text, View, ViewStyle } from 'react-native';

const FILL  = '#e8e5e1';
const FILL2 = '#f0ede9';
const BG    = '#faf9f7';

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
      backgroundColor: '#fff',
      borderRadius: 12,
      marginBottom: 8,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: '#f0ede9',
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
        borderTopWidth: 1, borderTopColor: '#f0ede9',
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
      backgroundColor: '#fff',
      borderRadius: 14,
      padding: 18,
      marginBottom: 20,
      borderWidth: 1,
      borderColor: '#f0ede8',
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

// ── ReadingCardSkeleton ────────────────────────────────────────────────────────
// Matches the single-book currently-reading card on Home:
//   cover 56×82, title/author, progress bar + label.

function ReadingCardSkeleton() {
  return (
    <Pulse style={{
      backgroundColor: '#fff',
      borderRadius: 16,
      padding: 16,
      flexDirection: 'row',
      alignItems: 'center',
      borderLeftWidth: 3,
      borderLeftColor: '#e7e5e4',
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
      backgroundColor: '#fff',
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
      <Box w="100%" h={3} r={2} />
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
      <Pulse style={{ marginBottom: 28, gap: 8 }}>
        <Box w={190} h={34} r={8} />
        <Box w={130} h={14} r={6} c={FILL2} />
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
      <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />
      <ActivityRowSkeleton />
      <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />
      <ActivityRowSkeleton />
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
        <Text style={{ fontSize: 28, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, lineHeight: 34 }}>
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
      <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />

      {/* Book rows */}
      {[0, 1, 2, 3, 4].map(i => (
        <React.Fragment key={i}>
          <LibraryRowSkeleton />
          {i < 4 && <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />}
        </React.Fragment>
      ))}
    </View>
  );
}
