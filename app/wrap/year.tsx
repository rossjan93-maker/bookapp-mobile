import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
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

// ── Helpers ────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function monthName(prefix: string): string {
  const mm = parseInt(prefix.slice(5, 7), 10) - 1;
  return MONTH_NAMES[mm] ?? prefix;
}

// ── MonthBar: a single horizontal bar for the monthly breakdown ───────────────

function MonthBar({ m, peak }: { m: MonthBreakdown; peak: number }) {
  const name  = monthName(m.month);
  const frac  = peak > 0 ? m.readingDays / peak : 0;
  const width = Math.max(4, Math.round(frac * 120));

  return (
    <View style={{
      flexDirection:  'row',
      alignItems:     'center',
      marginBottom:   10,
      gap:            10,
    }}>
      <Text style={{ fontSize: 13, color: '#6b635c', width: 80, textAlign: 'right' }}>
        {name}
      </Text>
      <View style={{
        height:          8,
        width:           width,
        backgroundColor: '#7b9e7e',
        borderRadius:    4,
        opacity:         0.7 + 0.3 * frac,
      }} />
      <Text style={{ fontSize: 12, color: '#9e958d' }}>
        {m.readingDays}{m.readingDays === 1 ? ' day' : ' days'}
      </Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function YearWrapScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { year: yearParam } = useLocalSearchParams<{ year: string }>();

  const [loading, setLoading]   = useState(true);
  const [wrap, setWrap]         = useState<YearlyWrap | null>(null);
  const [hasData, setHasData]   = useState(false);

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
    <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>

      {/* ── Header ── */}
      <View style={{
        paddingTop:         insets.top + 12,
        paddingBottom:      16,
        paddingHorizontal:  20,
        borderBottomWidth:  1,
        borderBottomColor:  '#ede9e4',
        backgroundColor:    '#f5f1ec',
      }}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={{ marginBottom: 14 }}
        >
          <Text style={{ fontSize: 14, color: '#6b635c' }}>← Back</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 10, fontWeight: '700', color: '#9e958d', letterSpacing: 1.4, textTransform: 'uppercase', marginBottom: 4 }}>
          Reading summary
        </Text>
        <Text style={{ fontSize: 24, fontWeight: '800', color: '#231f1b', letterSpacing: -0.6 }}>
          {year}
        </Text>
      </View>

      {/* ── Body ── */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color="#9e958d" />
        </View>

      ) : !hasData ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 }}>
          <Text style={{ fontSize: 15, color: '#9e958d', textAlign: 'center', lineHeight: 24 }}>
            Nothing logged in {year}.
          </Text>
          <Text style={{ fontSize: 13, color: '#c4b5a5', textAlign: 'center', lineHeight: 20, marginTop: 8 }}>
            Finished books and sessions will appear here.
          </Text>
        </View>

      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 48 }}
          showsVerticalScrollIndicator={false}
        >

          {/* ── Hero: books finished ── */}
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 16,
            padding: 22,
            marginBottom: 12,
            shadowColor: '#231f1b',
            shadowOpacity: 0.04,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 1,
          }}>
            <Text style={{
              fontSize: 52,
              fontWeight: '800',
              color: '#231f1b',
              letterSpacing: -1.5,
              lineHeight: 54,
            }}>
              {wrap!.booksFinished}
            </Text>
            <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 4 }}>
              {wrap!.booksFinished === 1 ? 'book finished' : 'books finished'}
            </Text>
          </View>

          {/* ── Summary stats ── */}
          {wrap!.pagesRead > 0 && (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 16,
              paddingHorizontal: 20,
              paddingTop: 4,
              paddingBottom: 4,
              marginBottom: 12,
              shadowColor: '#231f1b',
              shadowOpacity: 0.04,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              elevation: 1,
            }}>
              {wrap!.pagesRead > 0 && (
                <StatRow label="Pages read" value={wrap!.pagesRead.toLocaleString()} />
              )}
              {wrap!.readingDays > 0 && (
                <StatRow
                  label="Reading days"
                  value={wrap!.readingDays === 1 ? '1 day' : `${wrap!.readingDays} days`}
                />
              )}
              {wrap!.avgPagesPerReadingDay != null && (
                <StatRow label="Avg pages per day" value={String(wrap!.avgPagesPerReadingDay)} />
              )}
              {wrap!.longestStreak >= 2 && (
                <StatRow
                  label="Longest streak"
                  value={`${wrap!.longestStreak} days`}
                />
              )}
            </View>
          )}

          {/* ── Monthly rhythm ── */}
          {wrap!.monthlyBreakdown.length > 0 && (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 16,
              padding: 20,
              marginBottom: 12,
              shadowColor: '#231f1b',
              shadowOpacity: 0.04,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              elevation: 1,
            }}>
              <Text style={{
                fontSize: 10, fontWeight: '700', color: '#9e958d',
                letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 16,
              }}>
                Monthly rhythm
              </Text>
              {(() => {
                const peak = Math.max(...wrap!.monthlyBreakdown.map(m => m.readingDays), 1);
                return wrap!.monthlyBreakdown.map(m => (
                  <MonthBar key={m.month} m={m} peak={peak} />
                ));
              })()}
            </View>
          )}

          {/* ── Most active month callout ── */}
          {wrap!.mostActiveMonth && wrap!.monthlyBreakdown.length > 1 && (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 16,
              padding: 20,
              marginBottom: 12,
              shadowColor: '#231f1b',
              shadowOpacity: 0.04,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              elevation: 1,
            }}>
              <Text style={{
                fontSize: 10, fontWeight: '700', color: '#9e958d',
                letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8,
              }}>
                Most reading days
              </Text>
              <Text style={{ fontSize: 18, fontWeight: '700', color: '#231f1b', marginBottom: 2 }}>
                {wrap!.mostActiveMonth.label}
              </Text>
              <Text style={{ fontSize: 13, color: '#6b635c' }}>
                {wrap!.mostActiveMonth.readingDays} reading {wrap!.mostActiveMonth.readingDays === 1 ? 'day' : 'days'}
                {wrap!.mostActiveMonth.pagesRead > 0 ? ` · ${wrap!.mostActiveMonth.pagesRead} pages` : ''}
              </Text>
            </View>
          )}

        </ScrollView>
      )}
    </View>
  );
}

// ── StatRow (local, mirrors MonthWrap) ───────────────────────────────────────

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 13,
      borderBottomWidth: 1,
      borderBottomColor: '#ede9e4',
    }}>
      <Text style={{ fontSize: 14, color: '#6b635c' }}>{label}</Text>
      <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b' }}>{value}</Text>
    </View>
  );
}
