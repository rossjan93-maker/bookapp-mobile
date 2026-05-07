import { SAGE_DEEP } from '../../lib/tokens';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BackButton } from '../../components/BackButton';
import { supabase } from '../../lib/supabase';
import {
  auditFinishedDates,
  applyGoodreadsRepairs,
  clearFinishedAt,
} from '../../lib/finishedAtRepair';
import type { AuditRow, AuditReport } from '../../lib/finishedAtRepair';

// ─── Layout helpers ────────────────────────────────────────────────────────────


function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#9e958d',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 10,
      marginTop: 28,
    }}>
      {children}
    </Text>
  );
}

function StatusBadge({ text, color, bg }: { text: string; color: string; bg: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start', marginTop: 4 }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color }}>{text}</Text>
    </View>
  );
}

function BookRow({
  row,
  onClear,
  clearing,
}: {
  row: AuditRow;
  onClear?: () => void;
  clearing?: boolean;
}) {
  const isRepair = row.action === 'repair_goodreads';
  const isFlag   = row.action === 'no_source_flag';

  return (
    <View style={{
      backgroundColor: '#fff',
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
      borderLeftWidth: 3,
      borderLeftColor: isRepair ? '#b45309' : isFlag ? '#6b7280' : SAGE_DEEP,
    }}>
      <Text style={{ fontSize: 15, fontWeight: '700', color: '#231f1b', marginBottom: 2 }}>
        {row.title}
      </Text>
      <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 6 }}>{row.author}</Text>
      <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>{row.note}</Text>

      {isRepair && (
        <View style={{ marginTop: 8, flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <StatusBadge text={`Was: ${new Date(row.currentFinishedAt).toLocaleDateString()}`} color="#b91c1c" bg="#fef2f2" />
          <StatusBadge text={`Fix: ${row.importDateRead}`} color={SAGE_DEEP} bg="#eaf1ea" />
        </View>
      )}

      {isFlag && onClear && (
        <TouchableOpacity
          onPress={onClear}
          disabled={clearing}
          style={{
            marginTop: 10,
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: clearing ? '#ede9e4' : '#fef3c7',
            alignSelf: 'flex-start',
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: '600', color: clearing ? '#9e958d' : '#92400e' }}>
            {clearing ? 'Excluding…' : 'Exclude from this year (date unknown)'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────────

export default function RepairDatesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading,    setLoading]    = useState(false);
  const [report,     setReport]     = useState<AuditReport | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const [repairing,  setRepairing]  = useState(false);
  const [repairDone, setRepairDone] = useState(false);
  const [repairMsg,  setRepairMsg]  = useState<string | null>(null);

  const [clearingId, setClearingId] = useState<string | null>(null);
  const [cleared,    setCleared]    = useState<Set<string>>(new Set());

  // ── Run audit ──────────────────────────────────────────────────────────────

  async function runAudit() {
    if (!supabase) { setError('Supabase not configured.'); return; }
    setLoading(true);
    setError(null);
    setReport(null);
    setRepairDone(false);
    setRepairMsg(null);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError('Not signed in.'); setLoading(false); return; }

    const result = await auditFinishedDates(supabase, user.id);
    setReport(result);
    setLoading(false);
  }

  // Auto-run audit whenever this screen comes into focus (first mount + return)
  useFocusEffect(
    useCallback(() => {
      runAudit();
    }, []),
  );

  // ── Apply Goodreads repairs ────────────────────────────────────────────────

  async function applyFix() {
    if (!supabase || !report) return;
    setRepairing(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setRepairing(false); return; }

    const { fixed, errors } = await applyGoodreadsRepairs(supabase, user.id, report.toRepair);
    setRepairing(false);
    setRepairDone(true);

    if (errors.length > 0) {
      setRepairMsg(`Fixed ${fixed} book(s). Errors: ${errors.join('; ')}`);
    } else {
      setRepairMsg(`Fixed ${fixed} book(s). Yearly goal count is now accurate.`);
    }

    // Refresh report
    const refreshed = await auditFinishedDates(supabase, user.id);
    setReport(refreshed);
  }

  // ── Clear a single flagged row ─────────────────────────────────────────────

  async function handleClear(row: AuditRow) {
    if (!supabase) return;
    setClearingId(row.userBookId);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setClearingId(null); return; }

    const { cleared: n } = await clearFinishedAt(supabase, user.id, [row.userBookId]);
    if (n > 0) setCleared(prev => new Set([...prev, row.userBookId]));
    setClearingId(null);
  }

  // ── Summary numbers ────────────────────────────────────────────────────────

  const totalBroken  = report ? report.toRepair.length : 0;
  const totalFlagged = report ? report.toFlag.filter(r => !cleared.has(r.userBookId)).length : 0;
  const totalOk      = report ? report.alreadyOk.length : 0;
  const hasDupes     = report && report.duplicates.length > 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f5f1ec' }}
      contentContainerStyle={{ paddingHorizontal: 22, paddingTop: insets.top + 16, paddingBottom: 60 }}
    >
      <BackButton onPress={() => router.back()} style={{ marginBottom: 28 }} />

      <Text style={{
        fontSize: 26,
        fontWeight: '800',
        color: '#231f1b',
        letterSpacing: -0.4,
        marginBottom: 6,
      }}>
        Repair Reading Dates
      </Text>
      <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 22, marginBottom: 28 }}>
        Finds books currently showing as finished this year whose Goodreads import
        has an older completion date, and corrects the mismatch.
      </Text>

      {/* ── Loading spinner (auto-runs on mount) ── */}
      {!report && loading && (
        <View style={{ alignItems: 'center', paddingVertical: 40 }}>
          <ActivityIndicator color="#231f1b" size="large" />
          <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 14 }}>Scanning your library…</Text>
        </View>
      )}

      {error && (
        <Text style={{ color: '#b91c1c', fontSize: 14, marginTop: 12 }}>{error}</Text>
      )}

      {/* ── Results ── */}
      {report && (
        <>
          {/* Summary strip */}
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            marginBottom: 4,
            flexDirection: 'row',
            gap: 16,
          }}>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 26, fontWeight: '800', color: totalBroken > 0 ? '#b45309' : SAGE_DEEP }}>
                {totalBroken}
              </Text>
              <Text style={{ fontSize: 11, color: '#9e958d', textAlign: 'center', marginTop: 2 }}>needs fix</Text>
            </View>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 26, fontWeight: '800', color: totalFlagged > 0 ? '#6b7280' : SAGE_DEEP }}>
                {totalFlagged}
              </Text>
              <Text style={{ fontSize: 11, color: '#9e958d', textAlign: 'center', marginTop: 2 }}>needs review</Text>
            </View>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 26, fontWeight: '800', color: SAGE_DEEP }}>{totalOk}</Text>
              <Text style={{ fontSize: 11, color: '#9e958d', textAlign: 'center', marginTop: 2 }}>correct</Text>
            </View>
          </View>

          {/* Re-run button */}
          <TouchableOpacity
            onPress={runAudit}
            style={{ alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 4, marginBottom: 4 }}
          >
            <Text style={{ fontSize: 13, color: '#9e958d', textDecorationLine: 'underline' }}>
              Re-run audit
            </Text>
          </TouchableOpacity>

          {/* Repair success banner */}
          {repairMsg && (
            <View style={{
              backgroundColor: '#eaf1ea',
              borderRadius: 12,
              padding: 14,
              marginTop: 12,
              borderLeftWidth: 3,
              borderLeftColor: SAGE_DEEP,
            }}>
              <Text style={{ fontSize: 14, color: SAGE_DEEP, fontWeight: '600' }}>{repairMsg}</Text>
            </View>
          )}

          {/* ── Fix section ── */}
          {report.toRepair.length > 0 && (
            <>
              <SectionLabel>
                {`Incorrect dates — Goodreads source (${report.toRepair.length})`}
              </SectionLabel>
              <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20, marginBottom: 14 }}>
                These books have a Goodreads completion date from a prior year, but
                their stored date was overwritten with today. The fix below restores
                the real date.
              </Text>

              {report.toRepair.map(row => (
                <BookRow key={row.userBookId} row={row} />
              ))}

              {!repairDone && (
                <TouchableOpacity
                  onPress={applyFix}
                  disabled={repairing}
                  style={{
                    backgroundColor: repairing ? '#ede9e4' : '#231f1b',
                    borderRadius: 13,
                    paddingVertical: 15,
                    alignItems: 'center',
                    marginTop: 8,
                    marginBottom: 8,
                  }}
                >
                  {repairing
                    ? <ActivityIndicator color="#fff" />
                    : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                        Fix {report.toRepair.length} Book{report.toRepair.length !== 1 ? 's' : ''}
                      </Text>
                  }
                </TouchableOpacity>
              )}
            </>
          )}

          {/* ── Flag section ── */}
          {report.toFlag.filter(r => !cleared.has(r.userBookId)).length > 0 && (
            <>
              <SectionLabel>
                {`No source date — needs review (${report.toFlag.filter(r => !cleared.has(r.userBookId)).length})`}
              </SectionLabel>
              <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20, marginBottom: 14 }}>
                These books have no Goodreads date to verify against. They were either
                manually added or imported without a Date Read. If you didn't actually
                finish them this year, tap "Set date to Unknown" to remove them from
                the yearly goal.
              </Text>

              {report.toFlag
                .filter(r => !cleared.has(r.userBookId))
                .map(row => (
                  <BookRow
                    key={row.userBookId}
                    row={row}
                    onClear={() => handleClear(row)}
                    clearing={clearingId === row.userBookId}
                  />
                ))}
            </>
          )}

          {/* ── Already correct ── */}
          {report.alreadyOk.length > 0 && (
            <>
              <SectionLabel>
                {`Verified correct (${report.alreadyOk.length})`}
              </SectionLabel>
              {report.alreadyOk.map(row => (
                <BookRow key={row.userBookId} row={row} />
              ))}
            </>
          )}

          {/* ── Duplicates ── */}
          {hasDupes && (
            <>
              <SectionLabel>Duplicate entries found</SectionLabel>
              <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20, marginBottom: 14 }}>
                These books appear more than once in your library (unexpected — the
                database should prevent this). Contact support if you see any here.
              </Text>
              {report.duplicates.map(d => (
                <View key={d.bookId} style={{
                  backgroundColor: '#fef2f2',
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 8,
                }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#b91c1c' }}>
                    {d.title} — {d.count} rows
                  </Text>
                </View>
              ))}
            </>
          )}

          {/* All clean */}
          {totalBroken === 0 && totalFlagged === 0 && !hasDupes && (
            <View style={{
              backgroundColor: '#eaf1ea',
              borderRadius: 14,
              padding: 22,
              alignItems: 'center',
              marginTop: 24,
            }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: SAGE_DEEP, marginBottom: 6 }}>
                All dates look correct
              </Text>
              <Text style={{ fontSize: 14, color: '#78716c', textAlign: 'center' }}>
                No mismatches found. Your yearly reading goal count should be accurate.
              </Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
