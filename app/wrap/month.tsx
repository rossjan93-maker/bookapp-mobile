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
  computeMonthlyWrap,
  type MonthlyWrap,
  type WrapSession,
  type WrapBookRef,
} from '../../lib/readingWraps';

// ── Tokens ────────────────────────────────────────────────────────────────────
const INK      = '#231f1b';
const STONE    = '#6b635c';
const DUST     = '#9e958d';
const FAINT    = '#c4b5a5';
const CREAM    = '#fefcf9';
const BG       = '#f5f1ec';
const SAGE     = '#7b9e7e';
const SAGE_BG  = '#eaf1ea';
const AMBER    = '#c4956a';
const AMBER_BG = '#f7efe7';
const BORDER   = '#ede9e4';

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

// ── StatChip ──────────────────────────────────────────────────────────────────
function StatChip({ label, value, flex }: { label: string; value: string; flex?: number }) {
  return (
    <View style={{
      flex: flex ?? 1,
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

// ── Screen ────────────────────────────────────────────────────────────────────
export default function MonthWrapScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { month } = useLocalSearchParams<{ month: string }>();

  const [loading, setLoading] = useState(true);
  const [wrap, setWrap]       = useState<MonthlyWrap | null>(null);
  const [hasData, setHasData] = useState(false);

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
          Reading summary
        </Text>

        {/* State-based hero */}
        {!loading && hasData && (
          <>
            <Text style={{
              fontSize: 76,
              fontWeight: '800',
              color: CREAM,
              letterSpacing: -2.5,
              lineHeight: 76,
            }}>
              {wrap!.pagesRead}
            </Text>
            <Text style={{ fontSize: 15, color: STONE, marginTop: 10, lineHeight: 22 }}>
              pages read in {label}
            </Text>
          </>
        )}

        {!loading && !hasData && (
          <Text style={{
            fontSize: 28,
            fontWeight: '700',
            color: '#3a3330',
            letterSpacing: -0.5,
            marginTop: 4,
          }}>
            {label}
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
            Nothing logged in {label}.
          </Text>
          <Text style={{ fontSize: 13, color: FAINT, textAlign: 'center', lineHeight: 20, marginTop: 8 }}>
            Sessions will appear here once you start logging pages.
          </Text>
        </View>

      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 56 }}
          showsVerticalScrollIndicator={false}
        >

          {/* ── Stat chips — 2 × 2 grid ── */}
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <StatChip label="reading days" value={String(wrap!.readingDays)} />
              {wrap!.avgPagesPerReadingDay != null ? (
                <StatChip label="avg pages / day" value={String(wrap!.avgPagesPerReadingDay)} />
              ) : (
                <View style={{ flex: 1 }} />
              )}
            </View>

            {(wrap!.longestSessionPages != null || wrap!.sessionCount > 1) && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {wrap!.longestSessionPages != null && wrap!.sessionCount > 1 && (
                  <StatChip label="longest session" value={`${wrap!.longestSessionPages} pp`} />
                )}
                {wrap!.sessionCount > 1 && (
                  <StatChip label="sessions" value={String(wrap!.sessionCount)} />
                )}
              </View>
            )}
          </View>

          {/* ── Streak callout — only if ≥ 3 days ── */}
          {wrap!.longestStreakInMonth >= 3 && (
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
                    Streak
                  </Text>
                  <Text style={{
                    fontSize: 24, fontWeight: '800', color: INK,
                    letterSpacing: -0.6, lineHeight: 28,
                  }}>
                    {wrap!.longestStreakInMonth} days in a row
                  </Text>
                  <Text style={{ fontSize: 12, color: STONE, marginTop: 4 }}>
                    Longest reading streak this month
                  </Text>
                </View>
              </View>
            </>
          )}

          {/* ── Top book editorial card ── */}
          {wrap!.topBook && wrap!.booksActive > 1 && (
            <>
              <Rule />
              <View style={{
                flexDirection: 'row',
                backgroundColor: AMBER_BG,
                borderRadius: 14,
                overflow: 'hidden',
                shadowColor: INK,
                shadowOpacity: 0.04,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 1 },
                elevation: 1,
              }}>
                <View style={{ width: 4, backgroundColor: AMBER }} />
                <View style={{ padding: 18, flex: 1 }}>
                  <Text style={{
                    fontSize: 9, fontWeight: '700', color: AMBER,
                    letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 8,
                  }}>
                    Most pages this month
                  </Text>
                  <Text style={{
                    fontSize: 18, fontWeight: '700', color: INK, lineHeight: 23,
                  }} numberOfLines={2}>
                    {wrap!.topBook.title}
                  </Text>
                  <Text style={{ fontSize: 13, color: STONE, marginTop: 3 }}>
                    {wrap!.topBook.author}
                  </Text>
                  <Text style={{ fontSize: 12, color: DUST, marginTop: 6 }}>
                    {wrap!.topBook.pagesRead} pages read
                  </Text>
                </View>
              </View>
            </>
          )}

          {/* ── Year CTA ── */}
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/wrap/year', params: { year: String(targetYear) } })}
            activeOpacity={0.82}
            style={{ marginTop: 32 }}
          >
            <View style={{
              backgroundColor: INK,
              borderRadius: 14,
              paddingHorizontal: 20,
              paddingVertical: 18,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <View>
                <Text style={{
                  fontSize: 9, fontWeight: '700', color: '#4a4340',
                  letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 4,
                }}>
                  Your year
                </Text>
                <Text style={{ fontSize: 16, fontWeight: '700', color: CREAM }}>
                  See all of {targetYear}
                </Text>
              </View>
              <Text style={{ fontSize: 18, color: '#4a4340' }}>→</Text>
            </View>
          </TouchableOpacity>

        </ScrollView>
      )}
    </View>
  );
}
