import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import {
  computeMonthlyWrap,
  computeYearlyWrap,
  type MonthlyWrap,
  type YearlyWrap,
  type WrapSession,
  type WrapBookRef,
  type MonthBreakdown,
} from '../../lib/readingWraps';

// ── Tokens ────────────────────────────────────────────────────────────────────
const INK      = '#231f1b';
const STONE    = '#6b635c';
const DUST     = '#9e958d';
const FAINT    = '#c4b5a5';
const CREAM    = '#fefcf9';
const BG       = '#f5f1ec';
const BORDER   = '#ede9e4';
const SAGE     = '#7b9e7e';
const SAGE_BG  = '#eaf1ea';
const AMBER    = '#c4956a';
const AMBER_BG = '#f7efe7';

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_ABBREV = ['J','F','M','A','M','J','J','A','S','O','N','D'];

// ── Helpers ────────────────────────────────────────────────────────────────────
function monthLabel(prefix: string): string {
  const mm = parseInt(prefix.slice(5, 7), 10) - 1;
  return MONTH_NAMES[mm] ?? prefix;
}

// ── Reading rhythm calendar (heat-map of days in a month) ─────────────────────
function ReadingCalendar({ sessions, monthPrefix }: { sessions: WrapSession[]; monthPrefix: string }) {
  const { width } = useWindowDimensions();
  const contentW = width - 40;
  const GAP      = 3;
  const DOT      = Math.floor((contentW - 6 * GAP) / 7);

  const [yr, mm] = monthPrefix.split('-').map(Number);
  const daysInMonth = new Date(yr, mm, 0).getDate();
  const firstDow    = new Date(yr, mm - 1, 1).getDay(); // 0 = Sunday

  const pagesByDay: Record<number, number> = {};
  for (const s of sessions) {
    const day = parseInt(s.session_date.slice(8, 10), 10);
    pagesByDay[day] = (pagesByDay[day] ?? 0) + s.pages_read;
  }
  const maxPages = Math.max(...Object.values(pagesByDay), 1);

  const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

  // Split into rows of 7
  const rows: Array<Array<{ idx: number; day: number; pages: number }>> = [];
  let row: Array<{ idx: number; day: number; pages: number }> = [];
  for (let i = 0; i < totalCells; i++) {
    const day = i - firstDow + 1;
    row.push({ idx: i, day, pages: day >= 1 && day <= daysInMonth ? (pagesByDay[day] ?? 0) : -1 });
    if (row.length === 7) { rows.push(row); row = []; }
  }

  return (
    <View style={{ gap: GAP }}>
      {rows.map((r, ri) => (
        <View key={ri} style={{ flexDirection: 'row', gap: GAP }}>
          {r.map(({ idx, day, pages }) => {
            const outside = pages === -1;
            const frac    = outside ? 0 : pages > 0 ? 0.28 + 0.72 * (pages / maxPages) : 0;
            return (
              <View key={idx} style={{
                width:           DOT,
                height:          DOT,
                borderRadius:    4,
                backgroundColor: outside
                  ? 'transparent'
                  : pages > 0
                    ? `rgba(123,158,126,${frac.toFixed(2)})`
                    : BORDER,
              }} />
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ── Monthly column chart (12 bars) ────────────────────────────────────────────
function YearColumns({ months, year }: { months: MonthBreakdown[]; year: number }) {
  const { width } = useWindowDimensions();
  const availW  = width - 40;
  const colW    = availW / 12;
  const BAR_MAX = 80;
  const peak    = Math.max(...months.map(m => m.readingDays), 1);

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: BAR_MAX }}>
        {Array.from({ length: 12 }, (_, i) => {
          const prefix = `${year}-${String(i + 1).padStart(2, '0')}`;
          const md   = months.find(m => m.month === prefix);
          const days = md?.readingDays ?? 0;
          const frac = peak > 0 ? days / peak : 0;
          const barH = days > 0 ? Math.max(4, Math.round(frac * BAR_MAX)) : 0;
          const isPeak = md && md.readingDays === peak && peak > 0 && days > 0;
          return (
            <View key={i} style={{ width: colW, alignItems: 'center' }}>
              <View style={{
                width:               Math.max(6, colW - 5),
                height:              barH || 3,
                backgroundColor:     SAGE,
                borderTopLeftRadius: 3,
                borderTopRightRadius: 3,
                opacity:             days > 0 ? (0.3 + 0.7 * frac) : 0.12,
              }} />
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 6 }}>
        {MONTH_ABBREV.map((a, i) => {
          const prefix = `${year}-${String(i + 1).padStart(2, '0')}`;
          const md     = months.find(m => m.month === prefix);
          const isPeak = md && md.readingDays === peak && peak > 0;
          return (
            <View key={i} style={{ width: colW, alignItems: 'center' }}>
              <Text style={{ fontSize: 9, color: isPeak ? SAGE : FAINT, fontWeight: isPeak ? '700' : '400' }}>
                {a}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ── Stat quad — 4 small figures in a row ─────────────────────────────────────
function StatQuad({ items }: { items: Array<{ value: string; label: string }> }) {
  return (
    <View style={{
      flexDirection: 'row',
      backgroundColor: CREAM,
      borderRadius: 14,
      overflow: 'hidden',
      shadowColor: INK,
      shadowOpacity: 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }}>
      {items.map((it, i) => (
        <View key={i} style={{
          flex:            1,
          padding:         14,
          borderLeftWidth: i > 0 ? 1 : 0,
          borderLeftColor: BORDER,
          alignItems:      'center',
        }}>
          <Text style={{ fontSize: 20, fontWeight: '800', color: INK, letterSpacing: -0.5, lineHeight: 24 }}>
            {it.value}
          </Text>
          <Text style={{ fontSize: 10, color: DUST, marginTop: 3, textAlign: 'center', lineHeight: 13 }}>
            {it.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function StatsScreen() {
  const insets       = useSafeAreaInsets();
  const router       = useRouter();
  const [tab, setTab] = useState<'month' | 'year'>('month');

  const today  = useMemo(() => new Date(), []);
  const year   = today.getFullYear();
  const month  = today.getMonth() + 1; // 1-based
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const prevMonthNum  = month === 1 ? 12 : month - 1;
  const prevMonthYear = month === 1 ? year - 1 : year;
  const prevPrefix    = `${prevMonthYear}-${String(prevMonthNum).padStart(2, '0')}`;

  const [loading,       setLoading]       = useState(true);
  const [allSessions,   setAllSessions]   = useState<WrapSession[]>([]);
  const [booksFinished, setBooksFinished] = useState(0);
  const [bookLookup,    setBookLookup]    = useState<Record<string, WrapBookRef>>({});

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data: { user } } = await supabase!.auth.getUser();
      if (!user) return;

      // Sessions: previous month → end of year (covers comparison + full year)
      const fetchFrom = `${prevMonthYear}-${String(prevMonthNum).padStart(2, '0')}-01`;
      const { data: sessRows } = await supabase!
        .from('reading_sessions')
        .select('session_date, pages_read, user_book_id')
        .eq('user_id', user.id)
        .gte('session_date', fetchFrom)
        .lte('session_date', `${year}-12-31`)
        .gt('pages_read', 0)
        .order('session_date');

      const sessions: WrapSession[] = (sessRows ?? []).map(r => ({
        session_date: r.session_date as string,
        pages_read:   r.pages_read   as number,
        user_book_id: r.user_book_id ?? undefined,
      }));
      setAllSessions(sessions);

      // Books finished count for the year
      const { count } = await supabase!
        .from('user_books')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .is('deleted_at', null)
        .gte('finished_at', `${year}-01-01`)
        .lte('finished_at', `${year}-12-31`);
      setBooksFinished(count ?? 0);

      // Book titles for top-book callout
      const bookIds = [...new Set(sessions.map(s => s.user_book_id).filter(Boolean))] as string[];
      if (bookIds.length > 0) {
        const { data: ubRows } = await supabase!
          .from('user_books')
          .select('id, book:books(title, author)')
          .in('id', bookIds)
          .is('deleted_at', null);
        const lk: Record<string, WrapBookRef> = {};
        for (const row of (ubRows ?? []) as any[]) {
          if (row.book) lk[row.id] = { title: row.book.title, author: row.book.author };
        }
        setBookLookup(lk);
      }
    } finally {
      setLoading(false);
    }
  }

  // Derive wraps from fetched sessions
  const curMonthSessions  = allSessions.filter(s => s.session_date.startsWith(monthPrefix));
  const prevMonthSessions = allSessions.filter(s => s.session_date.startsWith(prevPrefix));
  const yearSessions      = allSessions.filter(s => s.session_date.startsWith(String(year)));

  const monthWrap = useMemo(
    () => computeMonthlyWrap(curMonthSessions, monthPrefix, bookLookup),
    [allSessions, bookLookup],
  );
  const prevMonthWrap = useMemo(
    () => computeMonthlyWrap(prevMonthSessions, prevPrefix, {}),
    [allSessions],
  );
  const yearWrap = useMemo(
    () => computeYearlyWrap(yearSessions, year, booksFinished, bookLookup),
    [allSessions, booksFinished, bookLookup],
  );

  const monthName = MONTH_NAMES[month - 1];
  const prevDiff  = monthWrap.pagesRead > 0 && prevMonthWrap.pagesRead > 0
    ? monthWrap.pagesRead - prevMonthWrap.pagesRead
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>

      {/* ── Header ── */}
      <View style={{
        paddingTop:        insets.top + 14,
        paddingBottom:     12,
        paddingHorizontal: 20,
        backgroundColor:   BG,
        borderBottomWidth: 1,
        borderBottomColor: BORDER,
      }}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={{ marginBottom: 14 }}
        >
          <Text style={{ fontSize: 13, color: STONE }}>← Back</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 22, fontWeight: '800', color: INK, letterSpacing: -0.5 }}>
          Reading Insights
        </Text>
      </View>

      {/* ── Tab bar ── */}
      <View style={{
        flexDirection:    'row',
        paddingHorizontal: 20,
        paddingVertical:   12,
        gap:               8,
        backgroundColor:   BG,
      }}>
        {(['month', 'year'] as const).map(t => (
          <TouchableOpacity
            key={t}
            onPress={() => setTab(t)}
            style={{
              flex:            1,
              paddingVertical: 9,
              borderRadius:    10,
              alignItems:      'center',
              backgroundColor: tab === t ? INK : CREAM,
              shadowColor:     INK,
              shadowOpacity:   tab === t ? 0 : 0.04,
              shadowRadius:    4,
              shadowOffset:    { width: 0, height: 1 },
              elevation:       tab === t ? 0 : 1,
            }}
          >
            <Text style={{
              fontSize:   13,
              fontWeight: '600',
              color:      tab === t ? CREAM : STONE,
            }}>
              {t === 'month' ? monthName : String(year)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Body ── */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={DUST} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 56 }}
          showsVerticalScrollIndicator={false}
        >
          {tab === 'month'
            ? <MonthView
                wrap={monthWrap}
                prevDiff={prevDiff}
                prevMonthName={MONTH_NAMES[prevMonthNum - 1]}
                monthPrefix={monthPrefix}
                monthName={monthName}
                year={year}
                curMonthSessions={curMonthSessions}
              />
            : <YearView
                wrap={yearWrap}
                year={year}
                booksFinished={booksFinished}
              />
          }
        </ScrollView>
      )}
    </View>
  );
}

// ── Month view ────────────────────────────────────────────────────────────────
function MonthView({
  wrap, prevDiff, prevMonthName, monthPrefix, monthName, year, curMonthSessions,
}: {
  wrap:              MonthlyWrap;
  prevDiff:          number | null;
  prevMonthName:     string;
  monthPrefix:       string;
  monthName:         string;
  year:              number;
  curMonthSessions:  WrapSession[];
}) {
  const hasData = wrap.pagesRead > 0;

  if (!hasData) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 48 }}>
        <Text style={{ fontSize: 15, color: DUST, textAlign: 'center', lineHeight: 24 }}>
          Nothing logged in {monthName} yet.
        </Text>
        <Text style={{ fontSize: 13, color: FAINT, textAlign: 'center', lineHeight: 20, marginTop: 8 }}>
          Sessions will appear here once you start logging pages.
        </Text>
      </View>
    );
  }

  // Stat quad items
  const quadItems: Array<{ value: string; label: string }> = [];
  quadItems.push({ value: String(wrap.readingDays), label: 'days read' });
  if (wrap.avgPagesPerReadingDay != null) {
    quadItems.push({ value: String(wrap.avgPagesPerReadingDay), label: 'avg pp/day' });
  }
  if (wrap.longestSessionPages != null && wrap.sessionCount > 1) {
    quadItems.push({ value: String(wrap.longestSessionPages), label: 'best session' });
  }
  if (wrap.longestStreakInMonth >= 2) {
    quadItems.push({ value: `${wrap.longestStreakInMonth}d`, label: 'streak' });
  }
  // Cap at 4
  const quad = quadItems.slice(0, 4);

  return (
    <View style={{ gap: 0 }}>

      {/* ── Hero row ── */}
      <View style={{ marginBottom: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontSize: 9, fontWeight: '700', color: DUST, letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 6 }}>
              {monthName} {year}
            </Text>
            <Text style={{ fontSize: 56, fontWeight: '800', color: INK, letterSpacing: -2, lineHeight: 56 }}>
              {wrap.pagesRead}
            </Text>
            <Text style={{ fontSize: 14, color: STONE, marginTop: 5 }}>pages read</Text>
          </View>

          {/* Comparison badge */}
          {prevDiff !== null && (
            <View style={{
              backgroundColor: prevDiff >= 0 ? SAGE_BG : '#fff7ed',
              borderRadius:    10,
              paddingHorizontal: 10,
              paddingVertical:   6,
              alignItems:      'center',
              marginBottom:    6,
            }}>
              <Text style={{
                fontSize:   13,
                fontWeight: '700',
                color:      prevDiff >= 0 ? SAGE : AMBER,
              }}>
                {prevDiff >= 0 ? '+' : ''}{prevDiff}
              </Text>
              <Text style={{ fontSize: 9, color: DUST, marginTop: 2 }}>
                vs {prevMonthName}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Reading rhythm calendar ── */}
      <View style={{
        backgroundColor: CREAM,
        borderRadius:    14,
        padding:         16,
        marginBottom:    12,
        shadowColor:     INK,
        shadowOpacity:   0.04,
        shadowRadius:    6,
        shadowOffset:    { width: 0, height: 1 },
        elevation:       1,
      }}>
        <Text style={{
          fontSize: 9, fontWeight: '700', color: DUST,
          letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 12,
        }}>
          Reading rhythm
        </Text>
        <ReadingCalendar sessions={curMonthSessions} monthPrefix={monthPrefix} />
      </View>

      {/* ── Stat quad ── */}
      {quad.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          <StatQuad items={quad} />
        </View>
      )}

      {/* ── Sessions count note (when single session) ── */}
      {wrap.sessionCount === 1 && (
        <Text style={{ fontSize: 12, color: FAINT, textAlign: 'center', marginBottom: 12 }}>
          1 session logged this month
        </Text>
      )}

      {/* ── Top book callout ── */}
      {wrap.topBook && wrap.booksActive > 1 && (
        <View style={{
          flexDirection:    'row',
          backgroundColor:  AMBER_BG,
          borderRadius:     14,
          overflow:         'hidden',
          marginBottom:     12,
          shadowColor:      INK,
          shadowOpacity:    0.04,
          shadowRadius:     6,
          shadowOffset:     { width: 0, height: 1 },
          elevation:        1,
        }}>
          <View style={{ width: 4, backgroundColor: AMBER }} />
          <View style={{ padding: 16, flex: 1 }}>
            <Text style={{
              fontSize: 9, fontWeight: '700', color: AMBER,
              letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 7,
            }}>
              Most read this month
            </Text>
            <Text style={{ fontSize: 16, fontWeight: '700', color: INK, lineHeight: 21 }} numberOfLines={2}>
              {wrap.topBook.title}
            </Text>
            <Text style={{ fontSize: 12, color: STONE, marginTop: 2 }}>{wrap.topBook.author}</Text>
            <Text style={{ fontSize: 11, color: DUST, marginTop: 5 }}>{wrap.topBook.pagesRead} pages this month</Text>
          </View>
        </View>
      )}

    </View>
  );
}

// ── Year view ─────────────────────────────────────────────────────────────────
function YearView({
  wrap, year, booksFinished,
}: {
  wrap:          YearlyWrap;
  year:          number;
  booksFinished: number;
}) {
  const hasData = booksFinished > 0 || wrap.pagesRead > 0;

  if (!hasData) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 48 }}>
        <Text style={{ fontSize: 15, color: DUST, textAlign: 'center', lineHeight: 24 }}>
          Nothing logged in {year} yet.
        </Text>
      </View>
    );
  }

  const quadItems: Array<{ value: string; label: string }> = [];
  if (wrap.readingDays > 0) quadItems.push({ value: String(wrap.readingDays), label: 'days read' });
  if (wrap.avgPagesPerReadingDay != null) quadItems.push({ value: String(wrap.avgPagesPerReadingDay), label: 'avg pp/day' });
  if (wrap.longestStreak >= 2) quadItems.push({ value: `${wrap.longestStreak}d`, label: 'streak' });
  if (wrap.pagesRead > 0) quadItems.push({ value: wrap.pagesRead.toLocaleString(), label: 'pages' });
  const quad = quadItems.slice(0, 4);

  return (
    <View style={{ gap: 0 }}>

      {/* ── Hero ── */}
      <View style={{ marginBottom: 20 }}>
        <Text style={{
          fontSize: 9, fontWeight: '700', color: DUST,
          letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 6,
        }}>
          {year}
        </Text>
        <Text style={{
          fontSize: 56, fontWeight: '800', color: INK,
          letterSpacing: -2, lineHeight: 56,
        }}>
          {booksFinished}
        </Text>
        <Text style={{ fontSize: 14, color: STONE, marginTop: 5 }}>
          {booksFinished === 1 ? 'book finished' : 'books finished'}
        </Text>
        {wrap.pagesRead > 0 && (
          <Text style={{ fontSize: 12, color: DUST, marginTop: 6 }}>
            {wrap.pagesRead.toLocaleString()} pages · {wrap.readingDays} reading {wrap.readingDays === 1 ? 'day' : 'days'}
          </Text>
        )}
      </View>

      {/* ── Monthly rhythm chart ── */}
      {wrap.monthlyBreakdown.length > 0 && (
        <View style={{
          backgroundColor: CREAM,
          borderRadius:    14,
          padding:         16,
          marginBottom:    12,
          shadowColor:     INK,
          shadowOpacity:   0.04,
          shadowRadius:    6,
          shadowOffset:    { width: 0, height: 1 },
          elevation:       1,
        }}>
          <Text style={{
            fontSize: 9, fontWeight: '700', color: DUST,
            letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 14,
          }}>
            Monthly rhythm
          </Text>
          <YearColumns months={wrap.monthlyBreakdown} year={year} />
        </View>
      )}

      {/* ── Stat quad ── */}
      {quad.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          <StatQuad items={quad} />
        </View>
      )}

      {/* ── Peak month callout ── */}
      {wrap.mostActiveMonth && wrap.monthlyBreakdown.length > 1 && (
        <View style={{
          flexDirection:   'row',
          backgroundColor: SAGE_BG,
          borderRadius:    14,
          overflow:        'hidden',
          shadowColor:     INK,
          shadowOpacity:   0.04,
          shadowRadius:    6,
          shadowOffset:    { width: 0, height: 1 },
          elevation:       1,
        }}>
          <View style={{ width: 4, backgroundColor: SAGE }} />
          <View style={{ padding: 16, flex: 1 }}>
            <Text style={{
              fontSize: 9, fontWeight: '700', color: SAGE,
              letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 7,
            }}>
              Peak month
            </Text>
            <Text style={{ fontSize: 22, fontWeight: '800', color: INK, letterSpacing: -0.5, lineHeight: 26 }}>
              {wrap.mostActiveMonth.label}
            </Text>
            <Text style={{ fontSize: 13, color: STONE, marginTop: 4 }}>
              {wrap.mostActiveMonth.readingDays} reading {wrap.mostActiveMonth.readingDays === 1 ? 'day' : 'days'}
              {wrap.mostActiveMonth.pagesRead > 0
                ? `  ·  ${wrap.mostActiveMonth.pagesRead} pages`
                : ''}
            </Text>
          </View>
        </View>
      )}

    </View>
  );
}
