import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import {
  computeYearlyWrap,
  type YearlyWrap,
  type WrapSession,
  type WrapBookRef,
  type MonthBreakdown,
} from '../../lib/readingWraps';

// ── Tokens ────────────────────────────────────────────────────────────────────
const INK     = '#231f1b';
const STONE   = '#6b635c';
const DUST    = '#9e958d';
const FAINT   = '#c4b5a5';
const CREAM   = '#fefcf9';
const BG      = '#f5f1ec';
const SAGE    = '#7b9e7e';
const SAGE_BG = '#eaf1ea';
const BORDER  = '#ede9e4';

// ── Helpers ────────────────────────────────────────────────────────────────────
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const MONTH_ABBREV = ['J','F','M','A','M','J','J','A','S','O','N','D'];

function monthName(prefix: string): string {
  const mm = parseInt(prefix.slice(5, 7), 10) - 1;
  return MONTH_NAMES[mm] ?? prefix;
}

// ── StatChip ──────────────────────────────────────────────────────────────────
function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={{
      flex: 1,
      backgroundColor: CREAM,
      borderRadius: 14,
      padding: 16,
      shadowColor: INK,
      shadowOpacity: 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }}>
      <Text style={{
        fontSize: 28,
        fontWeight: '800',
        color: INK,
        letterSpacing: -0.8,
        lineHeight: 32,
      }}>
        {value}
      </Text>
      <Text style={{ fontSize: 11, color: DUST, marginTop: 5, lineHeight: 15 }}>
        {label}
      </Text>
    </View>
  );
}

// ── Thin rule ─────────────────────────────────────────────────────────────────
function Rule() {
  return <View style={{ height: 1, backgroundColor: BORDER, marginVertical: 20 }} />;
}

// ── Monthly column chart ───────────────────────────────────────────────────────
function MonthColumns({
  months,
  year,
}: {
  months: MonthBreakdown[];
  year: number;
}) {
  const { width } = useWindowDimensions();
  const availableWidth = width - 40;
  const colW = availableWidth / 12;
  const BAR_MAX = 88;

  const peak = Math.max(...months.map(m => m.readingDays), 1);

  return (
    <View>
      {/* Bars */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        height: BAR_MAX,
      }}>
        {Array.from({ length: 12 }, (_, i) => {
          const prefix = `${year}-${String(i + 1).padStart(2, '0')}`;
          const md = months.find(m => m.month === prefix);
          const days = md?.readingDays ?? 0;
          const frac = peak > 0 ? days / peak : 0;
          const barH = days > 0 ? Math.max(4, Math.round(frac * BAR_MAX)) : 0;
          const isPeak = md && md.readingDays === peak && peak > 0 && days > 0;
          return (
            <View key={i} style={{ width: colW, alignItems: 'center' }}>
              <View style={{
                width: Math.max(6, colW - 5),
                height: barH || 3,
                backgroundColor: isPeak ? SAGE : SAGE,
                borderTopLeftRadius: 3,
                borderTopRightRadius: 3,
                opacity: days > 0 ? (0.35 + 0.65 * frac) : 0.12,
              }} />
            </View>
          );
        })}
      </View>
      {/* Month labels */}
      <View style={{ flexDirection: 'row', marginTop: 7 }}>
        {MONTH_ABBREV.map((a, i) => {
          const prefix = `${year}-${String(i + 1).padStart(2, '0')}`;
          const md = months.find(m => m.month === prefix);
          const isPeak = md && md.readingDays === peak && peak > 0;
          return (
            <View key={i} style={{ width: colW, alignItems: 'center' }}>
              <Text style={{
                fontSize: 9,
                color: isPeak ? SAGE : FAINT,
                fontWeight: isPeak ? '700' : '400',
              }}>
                {a}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function YearWrapScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { year: yearParam } = useLocalSearchParams<{ year: string }>();

  const [loading, setLoading] = useState(true);
  const [wrap, setWrap]       = useState<YearlyWrap | null>(null);
  const [hasData, setHasData] = useState(false);

  const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();

  useEffect(() => {
    load(year);
  }, [year]);

  async function load(yr: number) {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const yrStr = String(yr);

      const { data: sessionRows } = await supabase
        .from('reading_sessions')
        .select('session_date, pages_read, user_book_id')
        .eq('user_id', user.id)
        .gte('session_date', `${yrStr}-01-01`)
        .lte('session_date', `${yrStr}-12-31`)
        .gt('pages_read', 0)
        .order('session_date');

      const sessions: WrapSession[] = (sessionRows ?? []).map(r => ({
        session_date: r.session_date as string,
        pages_read:   r.pages_read   as number,
        user_book_id: r.user_book_id ?? undefined,
      }));

      const { count: booksFinished } = await supabase
        .from('user_books')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .is('deleted_at', null)
        .gte('finished_at', `${yrStr}-01-01`)
        .lte('finished_at', `${yrStr}-12-31`);

      const bookIds = [...new Set(sessions.map(s => s.user_book_id).filter(Boolean))] as string[];
      const lookup: Record<string, WrapBookRef> = {};

      if (bookIds.length > 0) {
        const { data: ubRows } = await supabase
          .from('user_books')
          .select('id, book:books(title, author)')
          .in('id', bookIds)
          .is('deleted_at', null);

        for (const row of (ubRows ?? []) as any[]) {
          if (row.book) lookup[row.id] = { title: row.book.title, author: row.book.author };
        }
      }

      const computed = computeYearlyWrap(sessions, yr, booksFinished ?? 0, lookup);
      setWrap(computed);
      setHasData(computed.booksFinished > 0 || computed.pagesRead > 0);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>

      {/* ── Immersive dark header ── */}
      <View style={{
        backgroundColor: INK,
        paddingTop:       insets.top + 14,
        paddingBottom:    40,
        paddingHorizontal: 24,
      }}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={{ marginBottom: 28 }}
        >
          <Text style={{ fontSize: 13, color: '#4a4340' }}>← Back</Text>
        </TouchableOpacity>

        <Text style={{
          fontSize: 9, fontWeight: '700', color: '#4a4340',
          letterSpacing: 2, textTransform: 'uppercase', marginBottom: 12,
        }}>
          {year} in reading
        </Text>

        {!loading && hasData && (
          <>
            {/* Primary hero — books finished */}
            <Text style={{
              fontSize: 76,
              fontWeight: '800',
              color: CREAM,
              letterSpacing: -2.5,
              lineHeight: 76,
            }}>
              {wrap!.booksFinished}
            </Text>
            <Text style={{ fontSize: 15, color: STONE, marginTop: 10, lineHeight: 22 }}>
              {wrap!.booksFinished === 1 ? 'book finished' : 'books finished'}
            </Text>

            {/* Secondary: pages */}
            {wrap!.pagesRead > 0 && (
              <Text style={{ fontSize: 13, color: '#3a3330', marginTop: 12 }}>
                {wrap!.pagesRead.toLocaleString()} pages across {wrap!.readingDays} reading {wrap!.readingDays === 1 ? 'day' : 'days'}
              </Text>
            )}
          </>
        )}

        {!loading && !hasData && (
          <Text style={{
            fontSize: 28, fontWeight: '700', color: '#3a3330',
            letterSpacing: -0.5, marginTop: 4,
          }}>
            {year}
          </Text>
        )}
      </View>

      {/* ── Body ── */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={DUST} />
        </View>

      ) : !hasData ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 48 }}>
          <Text style={{ fontSize: 15, color: DUST, textAlign: 'center', lineHeight: 24 }}>
            Nothing logged in {year}.
          </Text>
          <Text style={{ fontSize: 13, color: FAINT, textAlign: 'center', lineHeight: 20, marginTop: 8 }}>
            Finished books and sessions will appear here.
          </Text>
        </View>

      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 56 }}
          showsVerticalScrollIndicator={false}
        >

          {/* ── Stat chips 2×2 ── */}
          {(wrap!.readingDays > 0 || wrap!.longestStreak >= 2) && (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {wrap!.readingDays > 0 && (
                  <StatChip
                    label="reading days"
                    value={String(wrap!.readingDays)}
                  />
                )}
                {wrap!.avgPagesPerReadingDay != null && (
                  <StatChip
                    label="avg pages / day"
                    value={String(wrap!.avgPagesPerReadingDay)}
                  />
                )}
              </View>
              {wrap!.longestStreak >= 2 && (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <StatChip
                    label="longest streak"
                    value={`${wrap!.longestStreak}d`}
                  />
                  {wrap!.pagesRead > 0 && (
                    <StatChip
                      label="pages read"
                      value={wrap!.pagesRead.toLocaleString()}
                    />
                  )}
                </View>
              )}
            </View>
          )}

          {/* ── Monthly rhythm — vertical bar chart ── */}
          {wrap!.monthlyBreakdown.length > 0 && (
            <>
              <Rule />
              <Text style={{
                fontSize: 9, fontWeight: '700', color: DUST,
                letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 18,
              }}>
                Monthly rhythm
              </Text>
              <MonthColumns months={wrap!.monthlyBreakdown} year={year} />
            </>
          )}

          {/* ── Best month callout ── */}
          {wrap!.mostActiveMonth && wrap!.monthlyBreakdown.length > 1 && (
            <>
              <Rule />
              <View style={{
                flexDirection: 'row',
                backgroundColor: SAGE_BG,
                borderRadius: 14,
                overflow: 'hidden',
                shadowColor: INK,
                shadowOpacity: 0.04,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 1 },
                elevation: 1,
              }}>
                <View style={{ width: 4, backgroundColor: SAGE }} />
                <View style={{ padding: 18, flex: 1 }}>
                  <Text style={{
                    fontSize: 9, fontWeight: '700', color: SAGE,
                    letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 7,
                  }}>
                    Peak month
                  </Text>
                  <Text style={{
                    fontSize: 24, fontWeight: '800', color: INK,
                    letterSpacing: -0.6, lineHeight: 28,
                  }}>
                    {wrap!.mostActiveMonth.label}
                  </Text>
                  <Text style={{ fontSize: 13, color: STONE, marginTop: 4 }}>
                    {wrap!.mostActiveMonth.readingDays} reading {wrap!.mostActiveMonth.readingDays === 1 ? 'day' : 'days'}
                    {wrap!.mostActiveMonth.pagesRead > 0
                      ? `  ·  ${wrap!.mostActiveMonth.pagesRead} pages`
                      : ''}
                  </Text>
                </View>
              </View>
            </>
          )}

        </ScrollView>
      )}
    </View>
  );
}
