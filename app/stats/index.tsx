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

// ── Design tokens ────────────────────────────────────────────────────────────
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

const MONTH_NAMES  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_ABBREV = ['J','F','M','A','M','J','J','A','S','O','N','D'];

// ── Interpretive functions (pure — derived from real session data only) ───────

interface MonthCtx { monthName: string; dayOfMonth: number; daysInMonth: number; }

// Returns a strong declarative headline that names the character of the month
function deriveMonthHeadline(wrap: MonthlyWrap, ctx: MonthCtx): string {
  const { dayOfMonth, daysInMonth, monthName } = ctx;
  if (wrap.pagesRead === 0) return 'Ready when you are';

  const progress  = dayOfMonth / daysInMonth;
  const density   = wrap.readingDays / Math.max(dayOfMonth, 1);
  const ppSess    = wrap.sessionCount > 0 ? wrap.pagesRead / wrap.sessionCount : 0;
  const isBurst   = wrap.sessionCount <= 2 && ppSess >= 70;
  const isConsist = density >= 0.38;
  const streak    = wrap.longestStreakInMonth;
  const topFrac   = wrap.topBook && wrap.pagesRead > 0 ? wrap.topBook.pagesRead / wrap.pagesRead : 0;

  if (progress <= 0.13) {
    if (wrap.pagesRead >= 90) return `A strong start to ${monthName}`;
    if (streak >= 2)          return 'A good beginning';
    return `${monthName} is just getting started`;
  }
  if (streak >= 5)                                  return 'A real reading streak is building';
  if (streak >= 3 && isConsist)                     return 'Consistent reading this month';
  if (isBurst && topFrac >= 0.85 && wrap.topBook)   return `Focused on ${wrap.topBook.title}`;
  if (isBurst)                                      return 'Reading in concentrated sessions';
  if (isConsist && wrap.pagesRead >= 200)           return `A strong ${monthName}`;
  if (isConsist)                                    return 'A steady reading rhythm';
  if (progress >= 0.5 && density < 0.14)            return 'A quieter month so far';
  if (progress >= 0.3 && density < 0.22)            return 'Momentum is still building';
  if (topFrac >= 0.85 && wrap.booksActive === 1)    return 'Deep in one book this month';
  if (wrap.pagesRead >= 200 && progress >= 0.7)     return `A productive ${monthName}`;
  return 'Your reading month is taking shape';
}

// One-sentence interpretation of the hero number — explains the "so what"
function deriveMonthSubline(
  wrap: MonthlyWrap,
  ctx: MonthCtx,
  prevDiff: number | null,
  prevMonthName: string,
): string {
  if (wrap.pagesRead === 0) return '';
  const { dayOfMonth, daysInMonth, monthName } = ctx;
  const topFrac  = wrap.topBook && wrap.pagesRead > 0 ? wrap.topBook.pagesRead / wrap.pagesRead : 0;
  const progress = dayOfMonth / daysInMonth;

  const cmp = prevDiff !== null
    ? prevDiff > 10   ? ` — ${prevDiff} more than ${prevMonthName}`
    : prevDiff < -10  ? ` — ${Math.abs(prevDiff)} fewer than ${prevMonthName}`
    : '' : '';

  if (wrap.sessionCount === 1 && wrap.topBook) {
    return `${wrap.pagesRead} pages in one session — mostly ${wrap.topBook.title}${cmp}`;
  }
  if (wrap.sessionCount === 1) {
    return `${wrap.pagesRead} pages in one session${cmp}`;
  }
  if (topFrac >= 0.78 && wrap.topBook && wrap.booksActive > 1) {
    return `${wrap.topBook.pagesRead} of those pages from ${wrap.topBook.title}${cmp}`;
  }
  if (wrap.booksActive >= 3) {
    return `Spread across ${wrap.booksActive} books${cmp}`;
  }
  if (progress <= 0.2 && wrap.pagesRead >= 60) {
    return `Early progress for ${monthName}${cmp}`;
  }
  if (cmp) {
    return `${wrap.readingDays} reading ${wrap.readingDays === 1 ? 'day' : 'days'} so far${cmp}`;
  }
  return `${wrap.readingDays} of ${dayOfMonth} ${dayOfMonth === 1 ? 'day' : 'days'} with sessions`;
}

// Short observation about session pattern — what the calendar shape means
function deriveRhythmInsight(sessions: WrapSession[], wrap: MonthlyWrap, dayOfMonth: number): string | null {
  if (sessions.length === 0 || wrap.sessionCount === 0) return null;

  const ppSess   = wrap.pagesRead / wrap.sessionCount;
  const density  = wrap.readingDays / Math.max(dayOfMonth, 1);
  const streak   = wrap.longestStreakInMonth;
  const dayNums  = sessions
    .map(s => parseInt(s.session_date.slice(8, 10), 10))
    .sort((a, b) => a - b);
  const span     = dayNums.length > 1 ? dayNums[dayNums.length - 1] - dayNums[0] : 0;
  const recent   = sessions.filter(s => parseInt(s.session_date.slice(8, 10), 10) > dayOfMonth - 5).length;
  const isClustered = dayNums.length >= 2 && span <= 6;
  const isRecent    = recent >= 2 || (recent >= 1 && dayOfMonth <= 5);

  if (streak >= 4)            return 'A consecutive run is defining the rhythm';
  if (wrap.sessionCount === 1) return 'One focused session has carried the month so far';
  if (ppSess >= 90)            return 'Sessions have been long and focused';
  if (ppSess >= 60 && density < 0.35) return 'Reading in concentrated, high-page bursts';
  if (isClustered && !isRecent) return 'Reading came in a burst — then quieter';
  if (isClustered)              return 'Reading has been coming in concentrated bursts';
  if (density >= 0.45)          return 'Reading is spread evenly through the month';
  if (isRecent && density < 0.3) return 'Reading has picked up in recent days';
  if (density < 0.18 && dayOfMonth >= 8) return 'A few key sessions have anchored the month';
  return null;
}

// Calm next-step thought — never prescriptive, no productivity guilt
function deriveNextStep(
  wrap: MonthlyWrap,
  dayOfMonth: number,
  daysInMonth: number,
  activeStreak: number,
): string | null {
  if (wrap.pagesRead === 0) return null;
  const daysLeft = daysInMonth - dayOfMonth;
  const density  = wrap.readingDays / Math.max(dayOfMonth, 1);

  if (activeStreak === 1)                return 'Read again tomorrow to start a streak';
  if (activeStreak >= 2 && activeStreak < 5) return `${activeStreak} days in a row — keep the rhythm`;
  if (activeStreak >= 5)                 return `${activeStreak}-day streak — you're in a real rhythm`;
  if (daysLeft >= 14 && density < 0.18)  return 'Plenty of month left to build on this';
  if (daysLeft >= 8 && wrap.pagesRead >= 80) return 'Good position heading into the second half';
  if (daysLeft <= 6 && wrap.pagesRead >= 100) return 'A strong close is within reach';
  return null;
}

// Compute current live streak from a session list
function computeActiveStreak(sessions: WrapSession[]): number {
  if (sessions.length === 0) return 0;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const prev = new Date(today);
  prev.setDate(today.getDate() - 1);
  const prevStr = prev.toISOString().slice(0, 10);
  const daySet = new Set(sessions.map(s => s.session_date));
  if (!daySet.has(todayStr) && !daySet.has(prevStr)) return 0;
  let streak = 0;
  const check = new Date(daySet.has(todayStr) ? todayStr : prevStr);
  for (let i = 0; i < 365; i++) {
    const s = check.toISOString().slice(0, 10);
    if (daySet.has(s)) { streak++; check.setDate(check.getDate() - 1); }
    else break;
  }
  return streak;
}

// ── Reading rhythm calendar (heat-map grid of days) ───────────────────────────
function ReadingCalendar({ sessions, monthPrefix }: { sessions: WrapSession[]; monthPrefix: string }) {
  const { width } = useWindowDimensions();
  const contentW = width - 72; // card has 16px padding each side, screen 20px each side
  const GAP      = 3;
  const DOT      = Math.floor((contentW - 6 * GAP) / 7);

  const [yr, mm] = monthPrefix.split('-').map(Number);
  const daysInMonth = new Date(yr, mm, 0).getDate();
  const firstDow    = new Date(yr, mm - 1, 1).getDay();

  const pagesByDay: Record<number, number> = {};
  for (const s of sessions) {
    const day = parseInt(s.session_date.slice(8, 10), 10);
    pagesByDay[day] = (pagesByDay[day] ?? 0) + s.pages_read;
  }
  const maxPages = Math.max(...Object.values(pagesByDay), 1);
  const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

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

// ── Year column chart (12 proportional bars) ─────────────────────────────────
function YearColumns({ months, year }: { months: MonthBreakdown[]; year: number }) {
  const { width } = useWindowDimensions();
  const availW  = width - 72;
  const colW    = availW / 12;
  const BAR_MAX = 80;
  const peak    = Math.max(...months.map(m => m.readingDays), 1);

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: BAR_MAX }}>
        {Array.from({ length: 12 }, (_, i) => {
          const prefix = `${year}-${String(i + 1).padStart(2, '0')}`;
          const md     = months.find(m => m.month === prefix);
          const days   = md?.readingDays ?? 0;
          const frac   = peak > 0 ? days / peak : 0;
          const isPeak = !!(md && md.readingDays === peak && peak > 0 && days > 0);
          return (
            <View key={i} style={{ width: colW, alignItems: 'center' }}>
              <View style={{
                width:               Math.max(6, colW - 5),
                height:              days > 0 ? Math.max(4, Math.round(frac * BAR_MAX)) : 3,
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
          const isPeak = !!(md && md.readingDays === peak && peak > 0);
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

// ── Stat row — 2–3 figures in a horizontal card ───────────────────────────────
function StatRow({ items }: { items: Array<{ value: string; label: string }> }) {
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
          paddingVertical: 14,
          paddingHorizontal: 12,
          borderLeftWidth: i > 0 ? 1 : 0,
          borderLeftColor: BORDER,
          alignItems:      'center',
        }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: INK, letterSpacing: -0.5, lineHeight: 26 }}>
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
  const insets        = useSafeAreaInsets();
  const router        = useRouter();
  const [tab, setTab] = useState<'month' | 'year'>('month');

  const today  = useMemo(() => new Date(), []);
  const year   = today.getFullYear();
  const month  = today.getMonth() + 1;
  const monthPrefix   = `${year}-${String(month).padStart(2, '0')}`;
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

      const { count } = await supabase!
        .from('user_books')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .is('deleted_at', null)
        .gte('finished_at', `${year}-01-01`)
        .lte('finished_at', `${year}-12-31`);
      setBooksFinished(count ?? 0);

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

  // Current live streak from month sessions
  const activeStreak = computeActiveStreak(curMonthSessions);

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

      {/* ── Tab switcher ── */}
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
            <Text style={{ fontSize: 13, fontWeight: '600', color: tab === t ? CREAM : STONE }}>
              {t === 'month' ? monthName : String(year)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

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
                dayOfMonth={today.getDate()}
                daysInMonth={new Date(year, month, 0).getDate()}
                curMonthSessions={curMonthSessions}
                activeStreak={activeStreak}
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
  wrap, prevDiff, prevMonthName,
  monthPrefix, monthName, year,
  dayOfMonth, daysInMonth,
  curMonthSessions, activeStreak,
}: {
  wrap:             MonthlyWrap;
  prevDiff:         number | null;
  prevMonthName:    string;
  monthPrefix:      string;
  monthName:        string;
  year:             number;
  dayOfMonth:       number;
  daysInMonth:      number;
  curMonthSessions: WrapSession[];
  activeStreak:     number;
}) {
  if (wrap.pagesRead === 0) {
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

  const ctx: MonthCtx = { monthName, dayOfMonth, daysInMonth };

  // Interpretive layer — all derived from real data
  const headline      = deriveMonthHeadline(wrap, ctx);
  const subline       = deriveMonthSubline(wrap, ctx, prevDiff, prevMonthName);
  const rhythmInsight = deriveRhythmInsight(curMonthSessions, wrap, dayOfMonth);
  const nextStep      = deriveNextStep(wrap, dayOfMonth, daysInMonth, activeStreak);

  // Stat items: only show figures that earn their place
  const statItems: Array<{ value: string; label: string }> = [];
  statItems.push({ value: String(wrap.readingDays), label: 'days read' });
  // Avg pages: only meaningful with ≥ 2 sessions
  if (wrap.avgPagesPerReadingDay != null && wrap.sessionCount >= 2) {
    statItems.push({ value: String(wrap.avgPagesPerReadingDay), label: 'avg pp/day' });
  }
  // Streak: only when it says something (≥ 3 days)
  if (wrap.longestStreakInMonth >= 3) {
    statItems.push({ value: `${wrap.longestStreakInMonth}d`, label: 'streak' });
  }
  // Best session: only when notably large (≥ 50pp) and there's more than one
  if (wrap.longestSessionPages != null && wrap.longestSessionPages >= 50 && wrap.sessionCount >= 2) {
    statItems.push({ value: `${wrap.longestSessionPages}`, label: 'best session' });
  }
  const visibleStats = statItems.slice(0, 3); // cap at 3

  // Top book: show when multiple books OR when single dominant book is significant
  const showTopBook = wrap.topBook && (
    wrap.booksActive > 1 ||
    (wrap.booksActive === 1 && wrap.topBook.pagesRead >= 40)
  );
  const topBookEyebrow = wrap.booksActive > 1 ? 'Most read this month' : 'Reading this month';

  return (
    <View>

      {/* ── Headline + Hero ── */}
      <View style={{ marginBottom: 24 }}>
        <Text style={{
          fontSize:      20,
          fontWeight:    '700',
          color:         INK,
          letterSpacing: -0.3,
          lineHeight:    26,
          marginBottom:  16,
        }}>
          {headline}
        </Text>

        <Text style={{
          fontSize:      52,
          fontWeight:    '800',
          color:         INK,
          letterSpacing: -2,
          lineHeight:    52,
        }}>
          {wrap.pagesRead}
        </Text>

        {subline.length > 0 && (
          <Text style={{
            fontSize:   14,
            color:      STONE,
            marginTop:  8,
            lineHeight: 20,
          }}>
            {subline}
          </Text>
        )}
      </View>

      {/* ── Reading rhythm calendar ── */}
      <View style={{
        backgroundColor: CREAM,
        borderRadius:    14,
        padding:         16,
        marginBottom:    rhythmInsight ? 0 : 16,
        shadowColor:     INK,
        shadowOpacity:   0.04,
        shadowRadius:    6,
        shadowOffset:    { width: 0, height: 1 },
        elevation:       1,
        borderBottomLeftRadius:  rhythmInsight ? 0 : 14,
        borderBottomRightRadius: rhythmInsight ? 0 : 14,
      }}>
        <ReadingCalendar sessions={curMonthSessions} monthPrefix={monthPrefix} />
      </View>

      {/* Rhythm insight sits just below the calendar, connected visually */}
      {rhythmInsight && (
        <View style={{
          backgroundColor: CREAM,
          borderTopWidth:  1,
          borderTopColor:  BORDER,
          paddingHorizontal: 16,
          paddingVertical:   11,
          borderBottomLeftRadius:  14,
          borderBottomRightRadius: 14,
          marginBottom:    16,
          shadowColor:     INK,
          shadowOpacity:   0.04,
          shadowRadius:    6,
          shadowOffset:    { width: 0, height: 1 },
          elevation:       1,
        }}>
          <Text style={{ fontSize: 12, color: STONE, lineHeight: 18, fontStyle: 'italic' }}>
            {rhythmInsight}
          </Text>
        </View>
      )}

      {/* ── Stat row ── */}
      {visibleStats.length > 0 && (
        <View style={{ marginBottom: 16 }}>
          <StatRow items={visibleStats} />
        </View>
      )}

      {/* ── Top book ── */}
      {showTopBook && wrap.topBook && (
        <View style={{
          flexDirection:   'row',
          backgroundColor: AMBER_BG,
          borderRadius:    14,
          overflow:        'hidden',
          marginBottom:    16,
          shadowColor:     INK,
          shadowOpacity:   0.04,
          shadowRadius:    6,
          shadowOffset:    { width: 0, height: 1 },
          elevation:       1,
        }}>
          <View style={{ width: 4, backgroundColor: AMBER }} />
          <View style={{ padding: 16, flex: 1 }}>
            <Text style={{
              fontSize: 9, fontWeight: '700', color: AMBER,
              letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 7,
            }}>
              {topBookEyebrow}
            </Text>
            <Text style={{ fontSize: 16, fontWeight: '700', color: INK, lineHeight: 21 }} numberOfLines={2}>
              {wrap.topBook.title}
            </Text>
            <Text style={{ fontSize: 12, color: STONE, marginTop: 2 }}>{wrap.topBook.author}</Text>
            <Text style={{ fontSize: 11, color: DUST, marginTop: 5 }}>
              {wrap.topBook.pagesRead} pages this month
            </Text>
          </View>
        </View>
      )}

      {/* ── Next step — calm, not prescriptive ── */}
      {nextStep && (
        <View style={{
          paddingTop:   16,
          borderTopWidth: 1,
          borderTopColor: BORDER,
        }}>
          <Text style={{
            fontSize:   13,
            color:      STONE,
            lineHeight: 20,
            fontStyle:  'italic',
          }}>
            {nextStep}
          </Text>
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
  if (booksFinished === 0 && wrap.pagesRead === 0) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 48 }}>
        <Text style={{ fontSize: 15, color: DUST, textAlign: 'center', lineHeight: 24 }}>
          Nothing logged in {year} yet.
        </Text>
      </View>
    );
  }

  // Year interpretive subline
  const activeMonths = wrap.monthlyBreakdown.length;
  const yearSubline = activeMonths >= 2
    ? `Active reading in ${activeMonths} ${activeMonths === 1 ? 'month' : 'months'} of the year`
    : wrap.pagesRead > 0
      ? `${wrap.pagesRead.toLocaleString()} pages · ${wrap.readingDays} reading ${wrap.readingDays === 1 ? 'day' : 'days'}`
      : '';

  const statItems: Array<{ value: string; label: string }> = [];
  if (wrap.readingDays > 0)            statItems.push({ value: String(wrap.readingDays), label: 'days read' });
  if (wrap.avgPagesPerReadingDay != null) statItems.push({ value: String(wrap.avgPagesPerReadingDay), label: 'avg pp/day' });
  if (wrap.longestStreak >= 3)         statItems.push({ value: `${wrap.longestStreak}d`, label: 'streak' });
  const visibleStats = statItems.slice(0, 3);

  return (
    <View>

      {/* ── Hero ── */}
      <View style={{ marginBottom: 24 }}>
        <Text style={{
          fontSize: 9, fontWeight: '700', color: DUST,
          letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 12,
        }}>
          {year}
        </Text>
        <Text style={{ fontSize: 52, fontWeight: '800', color: INK, letterSpacing: -2, lineHeight: 52 }}>
          {booksFinished}
        </Text>
        <Text style={{ fontSize: 14, color: STONE, marginTop: 8 }}>
          {booksFinished === 1 ? 'book finished' : 'books finished'}
        </Text>
        {yearSubline.length > 0 && (
          <Text style={{ fontSize: 13, color: DUST, marginTop: 6, lineHeight: 19 }}>
            {yearSubline}
          </Text>
        )}
      </View>

      {/* ── Monthly rhythm chart ── */}
      {wrap.monthlyBreakdown.length > 0 && (
        <View style={{
          backgroundColor: CREAM,
          borderRadius:    14,
          padding:         16,
          marginBottom:    16,
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

      {/* ── Stats ── */}
      {visibleStats.length > 0 && (
        <View style={{ marginBottom: 16 }}>
          <StatRow items={visibleStats} />
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
