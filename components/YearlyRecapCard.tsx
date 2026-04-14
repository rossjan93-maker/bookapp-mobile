/**
 * YearlyRecapCard — a self-contained, fixed-size image-ready card
 * for the yearly reading recap.
 *
 * Design: deep ink background, cream typography, sage accent.
 * Dimensions: 375 × 560 (portrait, matches MonthlyRecapCard).
 * No app chrome, no navigation, no scrolling — purely a shareable visual.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { type YearlyWrap } from '../lib/readingWraps';

// ── Design tokens (card-specific palette — dark editorial) ────────────────────
const CARD_BG    = '#1c1814';
const CARD_INK   = '#fefcf9';
const CARD_DIM   = '#a09890';
const CARD_RULE  = '#2e2a26';
const CARD_SAGE  = '#7b9e7e';
const CARD_FAINT = '#3e3a36';

export const CARD_WIDTH  = 375;
export const CARD_HEIGHT = 560;

// ── Thin rule ─────────────────────────────────────────────────────────────────
function Rule() {
  return <View style={{ height: 1, backgroundColor: CARD_RULE, marginVertical: 18 }} />;
}

// ── Stat block ────────────────────────────────────────────────────────────────
function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View>
      <Text style={{
        fontSize:      9,
        fontWeight:    '700',
        color:         accent ?? CARD_DIM,
        letterSpacing: 1.6,
        textTransform: 'uppercase',
        marginBottom:  3,
      }}>
        {label}
      </Text>
      <Text style={{
        fontSize:      24,
        fontWeight:    '800',
        color:         CARD_INK,
        letterSpacing: -0.5,
        lineHeight:    28,
      }}>
        {value}
      </Text>
    </View>
  );
}

// ── Year-in-review sentence ────────────────────────────────────────────────────
function buildYearSentence(wrap: YearlyWrap): string {
  const { year, booksFinished, pagesRead, longestStreak, mostActiveMonth } = wrap;
  const bookWord  = booksFinished === 1 ? 'book' : 'books';
  const dayWord   = longestStreak === 1 ? 'day' : 'days';

  if (booksFinished > 0 && longestStreak >= 2) {
    return `You finished ${booksFinished} ${bookWord} in ${year} — your best streak was ${longestStreak} ${dayWord}.`;
  }
  if (booksFinished > 0 && mostActiveMonth) {
    return `You finished ${booksFinished} ${bookWord} in ${year}, most actively in ${mostActiveMonth.label}.`;
  }
  if (booksFinished > 0) {
    return `${booksFinished} ${bookWord} finished in ${year}.`;
  }
  if (pagesRead > 0 && longestStreak >= 2) {
    return `${pagesRead.toLocaleString()} pages across ${wrap.readingDays} reading ${wrap.readingDays === 1 ? 'day' : 'days'} in ${year}. Best streak: ${longestStreak} ${dayWord}.`;
  }
  if (pagesRead > 0) {
    return `${pagesRead.toLocaleString()} pages read in ${year}.`;
  }
  return `${year} — your reading story continues.`;
}

// ── Props ─────────────────────────────────────────────────────────────────────
export type YearlyRecapCardProps = {
  wrap:      YearlyWrap;
  yearlyGoal?: number | null;
};

// ── Card ─────────────────────────────────────────────────────────────────────
const YearlyRecapCard = React.forwardRef<View, YearlyRecapCardProps>(
  ({ wrap, yearlyGoal }, ref) => {
    const yearSentence = buildYearSentence(wrap);

    const goalLine = yearlyGoal && yearlyGoal > 0
      ? `${wrap.booksFinished} of ${yearlyGoal} goal`
      : null;

    return (
      <View
        ref={ref}
        style={{
          width:           CARD_WIDTH,
          height:          CARD_HEIGHT,
          backgroundColor: CARD_BG,
          padding:         32,
          justifyContent:  'space-between',
        }}
        collapsable={false}
      >

        {/* ── Header ── */}
        <View>
          <Text style={{
            fontSize:      9,
            fontWeight:    '700',
            color:         CARD_DIM,
            letterSpacing: 2.2,
            textTransform: 'uppercase',
            marginBottom:  4,
          }}>
            Year in Reading
          </Text>
          <Text style={{
            fontSize:      13,
            fontWeight:    '600',
            color:         CARD_FAINT,
            letterSpacing: 0.2,
            marginTop:     2,
          }}>
            {wrap.year}
          </Text>
        </View>

        {/* ── Hero: books finished ── */}
        <View>
          <Text style={{
            fontSize:      72,
            fontWeight:    '800',
            color:         CARD_INK,
            letterSpacing: -3,
            lineHeight:    70,
          }}>
            {wrap.booksFinished}
          </Text>
          <Text style={{
            fontSize:   14,
            color:      CARD_DIM,
            marginTop:  8,
            lineHeight: 20,
          }}>
            {goalLine
              ? `${wrap.booksFinished === 1 ? 'book' : 'books'} finished  ·  ${goalLine}`
              : wrap.booksFinished === 1 ? 'book finished' : 'books finished'}
          </Text>
        </View>

        <Rule />

        {/* ── Stat row — always render all three required slots ── */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat
            label="Pages read"
            value={wrap.pagesRead > 0 ? wrap.pagesRead.toLocaleString() : '—'}
          />
          <Stat
            label="Peak month"
            value={wrap.mostActiveMonth ? wrap.mostActiveMonth.label : '—'}
          />
          <Stat
            label="Best streak"
            value={wrap.longestStreak > 0 ? `${wrap.longestStreak}d` : '—'}
            accent={wrap.longestStreak > 0 ? CARD_SAGE : undefined}
          />
        </View>

        <Rule />

        {/* ── Year-in-review sentence ── */}
        <View style={{
          backgroundColor:  CARD_FAINT,
          borderRadius:     10,
          paddingVertical:  14,
          paddingHorizontal: 16,
        }}>
          <Text style={{
            fontSize:   13,
            color:      CARD_INK,
            lineHeight: 20,
            opacity:    0.85,
          }}>
            {yearSentence}
          </Text>
        </View>

        {/* ── Month bar sparkline ── */}
        {wrap.monthlyBreakdown.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 28, gap: 2 }}>
            {Array.from({ length: 12 }, (_, i) => {
              const prefix = `${wrap.year}-${String(i + 1).padStart(2, '0')}`;
              const md     = wrap.monthlyBreakdown.find(m => m.month === prefix);
              const days   = md?.readingDays ?? 0;
              const peak   = Math.max(...wrap.monthlyBreakdown.map(m => m.readingDays), 1);
              const frac   = peak > 0 ? days / peak : 0;
              const barH   = days > 0 ? Math.max(3, Math.round(frac * 24)) : 2;
              const isPeak = !!(md && days === peak && peak > 0);
              return (
                <View
                  key={i}
                  style={{
                    flex:                1,
                    height:              barH,
                    backgroundColor:     isPeak ? CARD_SAGE : CARD_DIM,
                    borderTopLeftRadius: 2,
                    borderTopRightRadius: 2,
                    opacity:             days > 0 ? Math.max(0.25, frac) : 0.1,
                    alignSelf:           'flex-end',
                  }}
                />
              );
            })}
          </View>
        )}

        {/* ── Footer wordmark ── */}
        <Text style={{
          fontSize:      9,
          fontWeight:    '700',
          color:         CARD_FAINT,
          letterSpacing: 2,
          textTransform: 'uppercase',
          textAlign:     'right',
        }}>
          Readstack
        </Text>

      </View>
    );
  },
);

YearlyRecapCard.displayName = 'YearlyRecapCard';
export default YearlyRecapCard;
