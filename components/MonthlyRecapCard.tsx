/**
 * MonthlyRecapCard — a self-contained, fixed-size image-ready card
 * for the monthly reading recap.
 *
 * Design: deep ink background, cream typography, sage accent.
 * Dimensions: 375 × 560 (portrait, ~4:3 when shared as an image).
 * No app chrome, no navigation, no scrolling — purely a shareable visual.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { type MonthlyWrap, type ReaderInsight } from '../lib/readingWraps';

// ── Design tokens (card-specific palette — dark editorial) ────────────────────
const CARD_BG    = '#1c1814';
const CARD_INK   = '#fefcf9';
const CARD_DIM   = '#a09890';
const CARD_RULE  = '#2e2a26';
const CARD_SAGE  = '#7b9e7e';
const CARD_AMBER = '#c4956a';
const CARD_FAINT = '#3e3a36';

export const CARD_WIDTH  = 375;
export const CARD_HEIGHT = 560;

// ── Month label helpers ────────────────────────────────────────────────────────
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function formatMonthYear(m: string): { month: string; year: string } {
  const [yr, mm] = m.split('-');
  return {
    month: MONTH_NAMES[parseInt(mm, 10) - 1] ?? m,
    year:  yr,
  };
}

// ── Thin rule ─────────────────────────────────────────────────────────────────
function Rule() {
  return <View style={{ height: 1, backgroundColor: CARD_RULE, marginVertical: 18 }} />;
}

// ── Stat block — label above, value below ─────────────────────────────────────
function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View>
      <Text style={{
        fontSize: 9,
        fontWeight: '700',
        color: accent ?? CARD_DIM,
        letterSpacing: 1.6,
        textTransform: 'uppercase',
        marginBottom: 3,
      }}>
        {label}
      </Text>
      <Text style={{
        fontSize: 24,
        fontWeight: '800',
        color: CARD_INK,
        letterSpacing: -0.5,
        lineHeight: 28,
      }}>
        {value}
      </Text>
    </View>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────
export type MonthlyRecapCardProps = {
  wrap:    MonthlyWrap;
  insight: ReaderInsight | null;
};

// ── Card ─────────────────────────────────────────────────────────────────────
const MonthlyRecapCard = React.forwardRef<View, MonthlyRecapCardProps>(
  ({ wrap, insight }, ref) => {
    const { month, year } = formatMonthYear(wrap.month);
    const insightText = insight?.text ?? 'A solid month of pages.';

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
            Reading Recap
          </Text>
          <Text style={{
            fontSize:      13,
            fontWeight:    '600',
            color:         CARD_FAINT,
            letterSpacing: 0.2,
            marginTop:     2,
          }}>
            {month} {year}
          </Text>
        </View>

        {/* ── Hero: pages read ── */}
        <View>
          <Text style={{
            fontSize:      72,
            fontWeight:    '800',
            color:         CARD_INK,
            letterSpacing: -3,
            lineHeight:    70,
          }}>
            {wrap.pagesRead}
          </Text>
          <Text style={{
            fontSize:   14,
            color:      CARD_DIM,
            marginTop:  8,
            lineHeight: 20,
          }}>
            pages read this month
          </Text>
        </View>

        <Rule />

        {/* ── Stat row ── */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat label="Reading days"  value={String(wrap.readingDays)} />
          {wrap.avgPagesPerReadingDay != null && (
            <Stat label="Avg / day" value={String(wrap.avgPagesPerReadingDay)} />
          )}
          {wrap.longestStreakInMonth >= 2 && (
            <Stat label="Best streak" value={`${wrap.longestStreakInMonth}d`} accent={CARD_SAGE} />
          )}
        </View>

        <Rule />

        {/* ── Top book (if available) ── */}
        {wrap.topBook ? (
          <View>
            <Text style={{
              fontSize:      9,
              fontWeight:    '700',
              color:         CARD_AMBER,
              letterSpacing: 1.6,
              textTransform: 'uppercase',
              marginBottom:  6,
            }}>
              Most pages
            </Text>
            <Text
              style={{
                fontSize:   18,
                fontWeight: '700',
                color:      CARD_INK,
                lineHeight: 23,
              }}
              numberOfLines={2}
            >
              {wrap.topBook.title}
            </Text>
            <Text style={{ fontSize: 12, color: CARD_DIM, marginTop: 2 }}>
              {wrap.topBook.author}
            </Text>
          </View>
        ) : (
          <View style={{ height: 52 }} />
        )}

        {/* ── Editorial insight ── */}
        <View style={{
          backgroundColor: CARD_FAINT,
          borderRadius:    10,
          paddingVertical: 14,
          paddingHorizontal: 16,
        }}>
          <Text style={{
            fontSize:   13,
            color:      CARD_INK,
            lineHeight: 20,
            opacity:    0.85,
          }}>
            {insightText}
          </Text>
        </View>

        {/* ── Footer wordmark ── */}
        <Text style={{
          fontSize:      9,
          fontWeight:    '700',
          color:         CARD_FAINT,
          letterSpacing: 2,
          textTransform: 'uppercase',
          textAlign:     'right',
          marginTop:     4,
        }}>
          Readstack
        </Text>

      </View>
    );
  },
);

MonthlyRecapCard.displayName = 'MonthlyRecapCard';
export default MonthlyRecapCard;
