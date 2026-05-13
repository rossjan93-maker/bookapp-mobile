// =============================================================================
// TasteReadout — "Here's what we heard" post-intake surface.
//
// Pure presentational component. Receives an already-loaded TasteProfile and
// the user's intake favorite_genres + avoid_genres. Renders a calm summary
// of what the recommender currently believes about the user, plus a single
// CTA into the For You feed.
//
// avoid_genres is intake-only signal (UX-3B); we display it as "Less of: X"
// chips but make NO claim that the recommender currently down-weights it
// (that's UX-3F, deferred). Copy stays informational, not behavioural.
//
// No data fetching here — the route wrapper (app/taste-readout.tsx) loads the
// profile and passes it in. This keeps the component cheap to render and
// trivial to snapshot/test.
// =============================================================================

import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as T from '../lib/tokens';
import type { TasteProfile } from '../lib/tasteProfile';
import {
  buildHeadline,
  buildSummary,
  buildLearningLine,
  buildChips,
  isThinReadout,
  THIN_READOUT_COPY,
  type ReadoutChip,
} from '../lib/tasteReadoutCopy';

type Props = {
  profile: TasteProfile | null;
  favoriteGenres: string[];
  /** UX-3B: intake-only avoid genres surfaced as "Less of: X" chips.
   *  Optional with [] default so older callers keep working unchanged. */
  avoidGenres?: string[];
  /** UX-3E: reader_preferences.diagnosis_answers — used to surface
   *  q_outcome ("Reading for: X") and q_tone ("Tone: X") as stated-
   *  preference chips. Optional with null default for backward-compat. */
  diagnosisAnswers?: Record<string, string> | null;
  onSeeMyPicks: () => void;
};

export function TasteReadout({
  profile,
  favoriteGenres,
  avoidGenres = [],
  diagnosisAnswers = null,
  onSeeMyPicks,
}: Props) {
  const headline = buildHeadline();
  const thin = isThinReadout(profile, favoriteGenres);
  // UX-3E thin-state decision: preserve the existing thin-state guard.
  // q_outcome / q_tone alone do not graduate a user out of thin state — in
  // practice the intake flow gates outcome/tone behind the genres step, so
  // a user reaching outcome will almost always have at least one liked or
  // avoid genre and won't be thin. Showing "Reading for: X" with no other
  // signal would over-isolate a single answer and feel unbalanced.
  const summary = thin ? THIN_READOUT_COPY : buildSummary(profile, favoriteGenres, avoidGenres, diagnosisAnswers);
  const chips: ReadoutChip[] = thin
    ? []
    : buildChips(profile, favoriteGenres, avoidGenres, diagnosisAnswers);
  const learningLine = buildLearningLine(profile);

  return (
    <View style={{ flex: 1, backgroundColor: T.BG }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: 48,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Headline ───────────────────────────────────────────────── */}
        <Text
          style={{
            fontSize: 28,
            fontWeight: '700',
            color: T.INK,
            letterSpacing: -0.4,
            lineHeight: 34,
            marginTop: 8,
          }}
        >
          {headline}
        </Text>

        {/* ── Summary sentence ───────────────────────────────────────── */}
        <Text
          style={{
            fontSize: 16,
            color: T.STONE,
            lineHeight: 24,
            marginTop: 14,
          }}
        >
          {summary}
        </Text>

        {/* ── Chips row ──────────────────────────────────────────────── */}
        {chips.length > 0 && (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              marginTop: 22,
              gap: 8,
            }}
          >
            {chips.map((chip, idx) => (
              <Chip key={`${chip.kind}-${idx}-${chip.label}`} chip={chip} />
            ))}
          </View>
        )}

        {/* ── Learning line ──────────────────────────────────────────── */}
        <View
          style={{
            marginTop: 28,
            backgroundColor: T.SAGE_BG,
            borderRadius: 12,
            padding: 14,
            flexDirection: 'row',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          <Ionicons
            name="sparkles-outline"
            size={16}
            color={T.SAGE_DEEP}
            style={{ marginTop: 2 }}
          />
          <Text
            style={{
              flex: 1,
              fontSize: 13,
              color: T.SAGE_INK,
              lineHeight: 19,
            }}
          >
            {learningLine}
          </Text>
        </View>
      </ScrollView>

      {/* ── Sticky CTA ─────────────────────────────────────────────── */}
      <View
        style={{
          paddingHorizontal: 24,
          paddingTop: 12,
          paddingBottom: 24,
          backgroundColor: T.BG,
          borderTopWidth: 1,
          borderTopColor: '#ede9e4',
        }}
      >
        <TouchableOpacity
          onPress={onSeeMyPicks}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="See my picks"
          style={{
            backgroundColor: T.SAGE_DEEP,
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 8,
          }}
        >
          <Text
            style={{
              fontSize: 16,
              fontWeight: '700',
              color: '#fefcf9',
              letterSpacing: 0.2,
            }}
          >
            See my picks
          </Text>
          <Ionicons name="arrow-forward" size={18} color="#fefcf9" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────
// Sage tint for positive signals (genre / trait / author), warm neutral for
// "less of" avoided signals so the avoidance reads as informational, not as
// the same kind of preference as the others.

function Chip({ chip }: { chip: ReadoutChip }) {
  // 'avoided' and 'stated' (UX-3E) both use the warm-neutral styling so they
  // read as informational ("you told us") rather than as derived-history
  // claims like genre/trait/author chips.
  const isNeutral = chip.kind === 'avoided' || chip.kind === 'stated';
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        backgroundColor: isNeutral ? '#f0ece7' : T.SAGE_BG,
        borderWidth: 1,
        borderColor: isNeutral ? '#e3ddd5' : '#d9e7da',
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: '600',
          color: isNeutral ? T.STONE : T.SAGE_INK,
          letterSpacing: 0.1,
        }}
      >
        {chip.label}
      </Text>
    </View>
  );
}
