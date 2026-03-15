import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { parseGoodreadsCSV } from '../../lib/goodreadsParser';
import { stageGoodreadsImport } from '../../lib/goodreadsStager';
import { executeGoodreadsImport } from '../../lib/goodreadsExecutor';
import type { StageSummary } from '../../lib/goodreadsStager';
import type { ExecutionSummary } from '../../lib/goodreadsExecutor';

type Step = 'idle' | 'processing' | 'staged' | 'executing' | 'complete' | 'error';

// ─── Layout primitives ───────────────────────────────────────────────────────

function ScreenContainer({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 56, paddingBottom: 60 }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

function BackButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={{ marginBottom: 28 }}>
      <Text style={{ fontSize: 14, color: disabled ? '#d6d3d1' : '#78716c' }}>← Back</Text>
    </TouchableOpacity>
  );
}

function PageTitle({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 28,
      fontWeight: '800',
      color: '#1c1917',
      letterSpacing: -0.5,
      marginBottom: 6,
    }}>
      {children}
    </Text>
  );
}

function PageSubtitle({ children }: { children: string }) {
  return (
    <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 22, marginBottom: 28 }}>
      {children}
    </Text>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#a8a29e',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 10,
      marginTop: 28,
    }}>
      {children}
    </Text>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View style={{
      backgroundColor: '#fff',
      borderRadius: 14,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }}>
      {children}
    </View>
  );
}

// ─── Web file picker ─────────────────────────────────────────────────────────

function pickCSVFile(): Promise<{ name: string; text: string } | null> {
  return new Promise(resolve => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv,text/plain';
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => {
        if (!input.files || input.files.length === 0) resolve(null);
      }, 500);
    };
    window.addEventListener('focus', onFocus);
    input.onchange = async () => {
      window.removeEventListener('focus', onFocus);
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        resolve({ name: file.name, text });
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}

// ─── Shared stat row ─────────────────────────────────────────────────────────

function StatRow({
  count,
  label,
  sublabel,
  accent,
  last,
}: {
  count: number;
  label: string;
  sublabel?: string;
  accent?: string;
  last?: boolean;
}) {
  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 18,
      paddingVertical: 15,
      borderBottomWidth: last ? 0 : 1,
      borderBottomColor: '#f5f5f4',
    }}>
      <Text style={{
        fontSize: 26,
        fontWeight: '800',
        color: accent ?? '#1c1917',
        minWidth: 52,
        letterSpacing: -0.5,
      }}>
        {count}
      </Text>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }}>{label}</Text>
        {sublabel ? (
          <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 2, lineHeight: 17 }}>{sublabel}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ─── Review queue row ────────────────────────────────────────────────────────

function ReviewRow({ title, author, reason, last }: {
  title: string;
  author: string;
  reason: string | null;
  last?: boolean;
}) {
  return (
    <View style={{
      paddingHorizontal: 18,
      paddingVertical: 13,
      borderBottomWidth: last ? 0 : 1,
      borderBottomColor: '#f5f5f4',
    }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', marginBottom: 2 }} numberOfLines={1}>
        {title}
      </Text>
      <Text style={{ fontSize: 12, color: '#78716c', marginBottom: reason ? 4 : 0 }} numberOfLines={1}>
        {author}
      </Text>
      {reason ? (
        <Text style={{ fontSize: 11, color: '#f59e0b', fontWeight: '500' }}>
          {reason}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Reset / start-over button ────────────────────────────────────────────────

function ResetButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        marginTop: 28,
        paddingVertical: 13,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#e7e5e4',
        alignItems: 'center',
      }}
    >
      <Text style={{ fontSize: 14, color: '#78716c' }}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Step: idle ───────────────────────────────────────────────────────────────

function IdleView({ onPickFile, isWeb }: { onPickFile: () => void; isWeb: boolean }) {
  return (
    <>
      <PageTitle>Import from Goodreads</PageTitle>
      <PageSubtitle>
        Bring your reading history into readstack. You'll see a preview before anything is added.
      </PageSubtitle>

      <Card>
        <View style={{ padding: 18 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginBottom: 14 }}>
            How to get your export file
          </Text>
          {[
            'Go to goodreads.com → My Books',
            'Click Import and Export in the left panel',
            'Choose Export Library and download the CSV',
            'Come back here and upload it below',
          ].map((step, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 }}>
              <View style={{
                width: 20, height: 20, borderRadius: 10,
                backgroundColor: '#f5f5f4',
                alignItems: 'center', justifyContent: 'center',
                marginRight: 10, marginTop: 1, flexShrink: 0,
              }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#78716c' }}>{i + 1}</Text>
              </View>
              <Text style={{ fontSize: 13, color: '#57534e', lineHeight: 20, flex: 1 }}>{step}</Text>
            </View>
          ))}
        </View>
      </Card>

      {isWeb ? (
        <TouchableOpacity
          onPress={onPickFile}
          style={{
            marginTop: 24,
            backgroundColor: '#1c1917',
            borderRadius: 12,
            paddingVertical: 15,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
            Choose CSV File
          </Text>
        </TouchableOpacity>
      ) : (
        <View style={{
          marginTop: 24,
          backgroundColor: '#f5f5f4',
          borderRadius: 12,
          padding: 18,
        }}>
          <Text style={{ fontSize: 14, color: '#78716c', textAlign: 'center', lineHeight: 21 }}>
            Goodreads import is available on web. Open readstack in your browser to upload your library.
          </Text>
        </View>
      )}
    </>
  );
}

// ─── Step: processing / executing ────────────────────────────────────────────

function SpinnerView({ message }: { message: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 }}>
      <ActivityIndicator color="#78716c" size="large" />
      <Text style={{ fontSize: 14, color: '#78716c', marginTop: 20, textAlign: 'center' }}>
        {message}
      </Text>
    </View>
  );
}

// ─── Step: staged — preview before import ────────────────────────────────────

function StagedView({
  summary,
  onImport,
  onReset,
}: {
  summary: StageSummary;
  onImport: () => void;
  onReset: () => void;
}) {
  const importableCount = summary.alreadyInApp + summary.readyToImport;
  const showQueue = summary.reviewRows.length > 0;

  return (
    <>
      <PageTitle>Ready to import</PageTitle>
      <PageSubtitle>
        Here's a preview of what we found. Nothing has been added to your library yet.
      </PageSubtitle>

      <SectionLabel>Preview</SectionLabel>
      <Card>
        <StatRow
          count={summary.totalRows}
          label="Books found"
          sublabel="Total rows in your Goodreads export"
        />
        <StatRow
          count={summary.alreadyInApp}
          label="Already in readstack"
          sublabel="Exact match found — will be linked to your record"
          accent="#15803d"
        />
        <StatRow
          count={summary.readyToImport}
          label="New books to add"
          sublabel="Will be created and added to your library"
        />
        <StatRow
          count={summary.needsReview}
          label="Cannot import"
          sublabel="Missing title or author — skipped automatically"
          accent={summary.needsReview > 0 ? '#d97706' : undefined}
          last
        />
      </Card>

      {showQueue && (
        <>
          <SectionLabel>Cannot import</SectionLabel>
          <Card>
            {summary.reviewRows.slice(0, 20).map((row, i) => (
              <ReviewRow
                key={i}
                title={row.title}
                author={row.author}
                reason={row.reviewReason}
                last={i === Math.min(summary.reviewRows.length, 20) - 1}
              />
            ))}
            {summary.reviewRows.length > 20 && (
              <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#f5f5f4' }}>
                <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                  +{summary.reviewRows.length - 20} more rows cannot be imported
                </Text>
              </View>
            )}
          </Card>
        </>
      )}

      {importableCount > 0 && (
        <TouchableOpacity
          onPress={onImport}
          style={{
            marginTop: 28,
            backgroundColor: '#1c1917',
            borderRadius: 12,
            paddingVertical: 15,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
            Import {importableCount} {importableCount === 1 ? 'Book' : 'Books'}
          </Text>
        </TouchableOpacity>
      )}

      <ResetButton onPress={onReset} label="Upload a different file" />
    </>
  );
}

// ─── Step: complete — execution result ───────────────────────────────────────

function CompleteView({
  result,
  onReset,
}: {
  result: ExecutionSummary;
  onReset: () => void;
}) {
  const totalImported = result.added + result.merged;
  const showQueue = result.reviewRows.length > 0;

  return (
    <>
      <PageTitle>Import complete</PageTitle>
      <PageSubtitle>
        {totalImported > 0
          ? `${totalImported} ${totalImported === 1 ? 'book has' : 'books have'} been added to your library.`
          : 'Your library is already up to date.'
        }
      </PageSubtitle>

      <SectionLabel>Results</SectionLabel>
      <Card>
        <StatRow
          count={result.added}
          label="Added to library"
          sublabel="New books added to your readstack"
          accent={result.added > 0 ? '#15803d' : undefined}
        />
        <StatRow
          count={result.merged}
          label="Merged with existing"
          sublabel="You already had these — import data filled in gaps"
        />
        <StatRow
          count={result.skipped}
          label="Already up to date"
          sublabel="Your existing data was already richer — no changes made"
        />
        <StatRow
          count={result.reviewNeeded}
          label="Could not import"
          sublabel="Missing required data — skipped"
          accent={result.reviewNeeded > 0 ? '#d97706' : undefined}
        />
        <StatRow
          count={result.failed}
          label="Failed"
          sublabel={result.failed > 0 ? 'Something went wrong for these rows' : 'None'}
          accent={result.failed > 0 ? '#b91c1c' : undefined}
          last
        />
      </Card>

      {showQueue && (
        <>
          <SectionLabel>Could not import</SectionLabel>
          <Card>
            {result.reviewRows.slice(0, 20).map((row, i) => (
              <ReviewRow
                key={i}
                title={row.title}
                author={row.author}
                reason={row.reason}
                last={i === Math.min(result.reviewRows.length, 20) - 1}
              />
            ))}
            {result.reviewRows.length > 20 && (
              <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#f5f5f4' }}>
                <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                  +{result.reviewRows.length - 20} more rows were skipped
                </Text>
              </View>
            )}
          </Card>
        </>
      )}

      <ResetButton onPress={onReset} label="Import another file" />
    </>
  );
}

// ─── Step: error ─────────────────────────────────────────────────────────────

function ErrorView({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <>
      <PageTitle>Something went wrong</PageTitle>
      <View style={{
        backgroundColor: '#fff',
        borderRadius: 14,
        padding: 18,
        marginBottom: 24,
        borderWidth: 1,
        borderColor: '#fee2e2',
      }}>
        <Text style={{ fontSize: 14, color: '#b91c1c', lineHeight: 21 }}>{message}</Text>
      </View>
      <TouchableOpacity
        onPress={onReset}
        style={{
          backgroundColor: '#1c1917',
          borderRadius: 12,
          paddingVertical: 13,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Try again</Text>
      </TouchableOpacity>
    </>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function GoodreadsImportScreen() {
  const router = useRouter();
  const [step, setStep]             = useState<Step>('idle');
  const [progress, setProgress]     = useState('');
  const [stageSummary, setStageSummary]       = useState<StageSummary | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionSummary | null>(null);
  const [currentUserId, setCurrentUserId]     = useState<string | null>(null);
  const [currentBatchId, setCurrentBatchId]   = useState<string | null>(null);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  const isWeb = Platform.OS === 'web';

  // ── Parse + stage ──────────────────────────────────────────────────────────

  async function handlePickFile() {
    const file = await pickCSVFile();
    if (!file) return;

    setStep('processing');
    setProgress('Parsing your library…');

    try {
      const parseResult = parseGoodreadsCSV(file.text);

      if (!parseResult.isGoodreadsExport) {
        const errMsg = parseResult.parseErrors[0]?.message ?? 'This does not look like a Goodreads export CSV.';
        setErrorMsg(
          `We couldn't read this file as a Goodreads export.\n\n${errMsg}\n\nMake sure you're uploading the file exported from Goodreads → My Books → Import and Export.`
        );
        setStep('error');
        return;
      }

      if (parseResult.rows.length === 0) {
        setErrorMsg('The file was recognised as a Goodreads export, but contained no readable rows. Try re-exporting from Goodreads.');
        setStep('error');
        return;
      }

      setProgress('Matching books…');
      if (!supabase) throw new Error('Supabase not configured.');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You must be signed in to import your library.');

      setProgress(`Staging ${parseResult.rows.length} books…`);
      const staged = await stageGoodreadsImport(user.id, parseResult.rows, file.name);

      setCurrentUserId(user.id);
      setCurrentBatchId(staged.batchId);
      setStageSummary(staged);
      setStep('staged');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setStep('error');
    }
  }

  // ── Execute import ─────────────────────────────────────────────────────────

  async function handleExecute() {
    if (!currentUserId || !currentBatchId) return;

    setStep('executing');
    setProgress('Importing your books…');

    try {
      const result = await executeGoodreadsImport(currentUserId, currentBatchId);
      setExecutionResult(result);
      setStep('complete');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Import failed. Please try again.');
      setStep('error');
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  function handleReset() {
    setStep('idle');
    setStageSummary(null);
    setExecutionResult(null);
    setCurrentUserId(null);
    setCurrentBatchId(null);
    setErrorMsg(null);
    setProgress('');
  }

  const isLocked = step === 'processing' || step === 'executing';

  return (
    <ScreenContainer>
      <BackButton onPress={() => router.back()} disabled={isLocked} />

      {step === 'idle' && (
        <IdleView onPickFile={handlePickFile} isWeb={isWeb} />
      )}

      {(step === 'processing' || step === 'executing') && (
        <SpinnerView message={progress} />
      )}

      {step === 'staged' && stageSummary && (
        <StagedView
          summary={stageSummary}
          onImport={handleExecute}
          onReset={handleReset}
        />
      )}

      {step === 'complete' && executionResult && (
        <CompleteView result={executionResult} onReset={handleReset} />
      )}

      {step === 'error' && (
        <ErrorView message={errorMsg ?? 'Unknown error.'} onReset={handleReset} />
      )}
    </ScreenContainer>
  );
}
