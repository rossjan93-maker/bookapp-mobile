import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import {
  computeMonthlyWrap,
  type MonthlyWrap,
  type WrapSession,
  type WrapBookRef,
} from '../../lib/readingWraps';

// ── Helpers ────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function formatMonth(m: string): string {
  const [year, mm] = m.split('-');
  return `${MONTH_NAMES[parseInt(mm, 10) - 1] ?? m} ${year}`;
}

function nextMonthPrefix(m: string): string {
  const [yr, mm] = m.split('-').map(Number);
  const ny = mm === 12 ? yr + 1 : yr;
  const nm = mm === 12 ? 1 : mm + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

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

// ── Screen ────────────────────────────────────────────────────────────────────

export default function MonthWrapScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { month } = useLocalSearchParams<{ month: string }>();

  const [loading, setLoading]   = useState(true);
  const [wrap, setWrap]         = useState<MonthlyWrap | null>(null);
  const [hasData, setHasData]   = useState(false);

  const currentYear = new Date().getFullYear();
  const targetYear  = month ? parseInt(month.split('-')[0], 10) : currentYear;

  useEffect(() => {
    if (!month) return;
    load(month);
  }, [month]);

  async function load(m: string) {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: rows } = await supabase
        .from('reading_sessions')
        .select('session_date, pages_read, user_book_id')
        .eq('user_id', user.id)
        .gte('session_date', `${m}-01`)
        .lt('session_date', nextMonthPrefix(m))
        .gt('pages_read', 0)
        .order('session_date');

      const sessions: WrapSession[] = (rows ?? []).map(r => ({
        session_date: r.session_date as string,
        pages_read:   r.pages_read   as number,
        user_book_id: r.user_book_id ?? undefined,
      }));

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

      const computed = computeMonthlyWrap(sessions, m, lookup);
      setWrap(computed);
      setHasData(computed.pagesRead > 0);
    } finally {
      setLoading(false);
    }
  }

  const label = month ? formatMonth(month) : '—';

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
          {label}
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
            Nothing logged in {label}.
          </Text>
          <Text style={{ fontSize: 13, color: '#c4b5a5', textAlign: 'center', lineHeight: 20, marginTop: 8 }}>
            Sessions will appear here once you start logging pages.
          </Text>
        </View>

      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 48 }}
          showsVerticalScrollIndicator={false}
        >

          {/* ── Hero: pages read ── */}
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
              {wrap!.pagesRead}
            </Text>
            <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 4 }}>pages read</Text>
          </View>

          {/* ── Stats card ── */}
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
            <StatRow
              label="Reading days"
              value={wrap!.readingDays === 1 ? '1 day' : `${wrap!.readingDays} days`}
            />
            {wrap!.avgPagesPerReadingDay != null && (
              <StatRow
                label="Avg pages per day"
                value={String(wrap!.avgPagesPerReadingDay)}
              />
            )}
            {wrap!.longestSessionPages != null && wrap!.sessionCount > 1 && (
              <StatRow
                label="Longest session"
                value={`${wrap!.longestSessionPages} pages`}
              />
            )}
            {wrap!.longestStreakInMonth >= 2 && (
              <StatRow
                label="Longest streak"
                value={`${wrap!.longestStreakInMonth} days in a row`}
              />
            )}
            {wrap!.sessionCount > 1 && (
              <StatRow
                label="Sessions logged"
                value={String(wrap!.sessionCount)}
              />
            )}
            {wrap!.booksActive > 0 && (
              <StatRow
                label={wrap!.booksActive === 1 ? 'Book active' : 'Books active'}
                value={String(wrap!.booksActive)}
              />
            )}
          </View>

          {/* ── Top book ── (only when multiple books active — otherwise redundant) */}
          {wrap!.topBook && wrap!.booksActive > 1 && (
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
                letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
              }}>
                Most pages this month
              </Text>
              <Text style={{
                fontSize: 16, fontWeight: '700', color: '#231f1b', marginBottom: 3, lineHeight: 21,
              }} numberOfLines={2}>
                {wrap!.topBook.title}
              </Text>
              <Text style={{ fontSize: 13, color: '#6b635c' }}>{wrap!.topBook.author}</Text>
              <Text style={{ fontSize: 12, color: '#9e958d', marginTop: 4 }}>
                {wrap!.topBook.pagesRead} pages read this month
              </Text>
            </View>
          )}

          {/* ── See full year link ── */}
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/wrap/year', params: { year: String(targetYear) } })}
            style={{ alignItems: 'center', marginTop: 8 }}
          >
            <Text style={{ fontSize: 13, color: '#9e958d' }}>
              See all of {targetYear} →
            </Text>
          </TouchableOpacity>

        </ScrollView>
      )}
    </View>
  );
}
