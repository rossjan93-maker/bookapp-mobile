import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
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
import { fetchGoogleBooksCoverUrl } from '../../lib/googleBooks';
import type { StageSummary } from '../../lib/goodreadsStager';
import type { ExecutionSummary } from '../../lib/goodreadsExecutor';
import { resetGoodreadsImport } from '../../lib/goodreadsReset';
import type { GoodreadsResetResult } from '../../lib/goodreadsReset';
import { repairBooksMetadata } from '../../lib/metadataRepair';

type Step =
  | 'idle'
  | 'processing'
  | 'staged'
  | 'executing'
  | 'complete'
  | 'error'
  | 'confirm-reset'
  | 'resetting'
  | 'reset-done';

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

const GOODREADS_EXPORT_URL = 'https://www.goodreads.com/review/import';

// ─── Step: idle ───────────────────────────────────────────────────────────────

function IdleView({
  onPickFile,
  isWeb,
  onResetRequest,
}: {
  onPickFile: () => void;
  isWeb: boolean;
  onResetRequest: () => void;
}) {
  const steps = [
    {
      label: 'Open Goodreads in Safari or Chrome',
      sub: 'Tap the black button below. If the Goodreads app opens instead of a browser, tap "..." or the share icon inside the app and choose "Open in Safari" or "Open in Browser".',
    },
    {
      label: 'Switch to Desktop Site',
      sub: 'iPhone: tap ᴬᴬ in the address bar → "Request Desktop Website". Android: tap ⋮ → "Desktop site". The export button only appears in desktop mode.',
    },
    {
      label: 'Tap "Export Library" — watch what happens next',
      sub: 'Goodreads is subtle here. It may quietly add a new line under the button, or the CSV may open directly in a preview. Both mean it worked.',
    },
    {
      label: 'Save the file and come back',
      sub: isWeb
        ? 'If a preview opened, tap the Share icon and choose "Save to Files". Then come back here and tap "Choose CSV File" below — look for goodreads_library_export.csv.'
        : 'If a preview opened, tap the Share icon and choose "Save to Files". Then open readstack in a web browser and upload goodreads_library_export.csv.',
    },
  ];

  return (
    <>
      <PageTitle>Import from Goodreads</PageTitle>
      <PageSubtitle>
        Bring your full reading history into readstack. You'll see a preview before anything is saved.
      </PageSubtitle>

      {/* ── Browser-only warning ── */}
      <View style={{
        backgroundColor: '#fffbf5',
        borderRadius: 12,
        padding: 14,
        borderLeftWidth: 3,
        borderLeftColor: '#d4a574',
        marginBottom: 20,
      }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginBottom: 3 }}>
          Do this in Safari or Chrome — not the Goodreads app
        </Text>
        <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
          If the Goodreads app opens when you tap the button below, use the app menu to open the page in Safari or Chrome instead.
        </Text>
      </View>

      <Card>
        <View style={{ padding: 18 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginBottom: 14 }}>
            How to export your library
          </Text>
          {steps.map((step, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: i < steps.length - 1 ? 14 : 0 }}>
              <View style={{
                width: 22, height: 22, borderRadius: 11,
                backgroundColor: '#f5f5f4',
                alignItems: 'center', justifyContent: 'center',
                marginRight: 12, marginTop: 1, flexShrink: 0,
              }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#78716c' }}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', lineHeight: 20 }}>
                  {step.label}
                </Text>
                <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18, marginTop: 2 }}>
                  {step.sub}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </Card>

      {/* Open Goodreads export page in browser */}
      <TouchableOpacity
        onPress={() => Linking.openURL(GOODREADS_EXPORT_URL)}
        style={{
          marginTop: 20,
          backgroundColor: '#1c1917',
          borderRadius: 12,
          paddingVertical: 15,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
          Open Goodreads Export Page
        </Text>
      </TouchableOpacity>

      {/* Fallback: selectable URL for manual paste into Safari */}
      <View style={{ marginTop: 12, alignItems: 'center', paddingHorizontal: 8 }}>
        <Text style={{ fontSize: 11, color: '#a8a29e', marginBottom: 4, textAlign: 'center' }}>
          If the app opens instead, copy this link and paste it into Safari:
        </Text>
        <Text
          selectable
          style={{ fontSize: 12, color: '#57534e', textAlign: 'center' }}
        >
          goodreads.com/review/import
        </Text>
      </View>

      {/* Divider */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        marginVertical: 20,
      }}>
        <View style={{ flex: 1, height: 1, backgroundColor: '#e7e5e4' }} />
        <Text style={{ fontSize: 12, color: '#a8a29e', marginHorizontal: 12 }}>then</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: '#e7e5e4' }} />
      </View>

      {isWeb ? (
        /* Web: full file-picker CTA */
        <TouchableOpacity
          onPress={onPickFile}
          style={{
            backgroundColor: '#fff',
            borderRadius: 12,
            paddingVertical: 15,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: '#e7e5e4',
          }}
        >
          <Text style={{ color: '#1c1917', fontSize: 15, fontWeight: '600' }}>
            Choose CSV File
          </Text>
          <Text style={{ color: '#a8a29e', fontSize: 12, marginTop: 3 }}>
            goodreads_library_export.csv
          </Text>
        </TouchableOpacity>
      ) : (
        /* Mobile: helpful note instead of a dead end */
        <View style={{
          backgroundColor: '#fff',
          borderRadius: 12,
          padding: 18,
          borderWidth: 1,
          borderColor: '#e7e5e4',
        }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', marginBottom: 6 }}>
            Uploading the file
          </Text>
          <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
            Once the CSV is saved to Files, open readstack in a web browser and come back to this screen to upload it.
          </Text>
        </View>
      )}

      {/* ── Goodreads reset entry point ── */}
      <View style={{ marginTop: 36, alignItems: 'center' }}>
        <View style={{ height: 1, backgroundColor: '#e7e5e4', width: '100%', marginBottom: 20 }} />
        <TouchableOpacity onPress={onResetRequest} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 13, color: '#a8a29e' }}>
            Reset Goodreads import
          </Text>
        </TouchableOpacity>
      </View>
    </>
  );
}

// ─── Progress stage types + helpers ──────────────────────────────────────────

type ProgressStage = {
  label: string;
  status: 'waiting' | 'active' | 'done';
};

const PROCESSING_STAGES = ['Parsing your library', 'Matching books', 'Preparing preview'];
const EXECUTING_STAGES  = ['Adding books to your library', 'Linking your reading history', 'Fetching missing covers', 'Finalizing'];

function stageList(labels: string[], activeIdx: number): ProgressStage[] {
  return labels.map((label, i) => ({
    label,
    status: (i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'waiting') as ProgressStage['status'],
  }));
}

// ─── Cover enrichment ─────────────────────────────────────────────────────────
// Only called for books freshly created in the current pass. Fails quietly.

async function enrichMissingCovers(bookIds: string[]): Promise<number> {
  if (!supabase || bookIds.length === 0) return 0;

  const { data: books } = await supabase
    .from('books')
    .select('id, isbn13, isbn, title, author')
    .in('id', bookIds)
    .is('cover_url', null);

  let enriched = 0;
  for (const book of (books ?? [])) {
    try {
      const url = await fetchGoogleBooksCoverUrl({
        isbn13: book.isbn13,
        isbn:   book.isbn,
        title:  book.title ?? '',
        author: book.author ?? '',
      });
      if (url) {
        await supabase.from('books').update({ cover_url: url }).eq('id', book.id);
        enriched++;
      }
    } catch {
      // fail quietly — a missing cover is never a blocker
    }
  }
  return enriched;
}

// ─── Step: processing / executing ────────────────────────────────────────────

function ProgressView({ stages }: { stages: ProgressStage[] }) {
  const total = stages.length;
  const doneCount = stages.filter(s => s.status === 'done').length;
  const hasActive = stages.some(s => s.status === 'active');
  const pct = total === 0 ? 0 : Math.min(1, (doneCount + (hasActive ? 0.6 : 0)) / total);
  const pctStr = `${Math.round(pct * 100)}%`;

  return (
    <View style={{ paddingTop: 52 }}>
      {/* Progress track */}
      <View style={{
        height: 3,
        backgroundColor: '#e7e5e4',
        borderRadius: 2,
        marginBottom: 40,
        overflow: 'hidden',
      }}>
        <View style={{
          height: 3,
          width: pctStr as unknown as number,
          backgroundColor: '#1c1917',
          borderRadius: 2,
        }} />
      </View>

      {/* Stage rows */}
      {stages.map((stage, i) => {
        const isActive  = stage.status === 'active';
        const isDone    = stage.status === 'done';
        const isWaiting = stage.status === 'waiting';
        return (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            {/* Indicator dot */}
            <View style={{
              width: 8, height: 8, borderRadius: 4,
              backgroundColor: isWaiting ? 'transparent' : (isDone ? '#a8a29e' : '#1c1917'),
              borderWidth: isWaiting ? 1.5 : 0,
              borderColor: '#d6d3d1',
              marginRight: 14,
              flexShrink: 0,
            }} />
            {/* Label */}
            <Text style={{
              flex: 1,
              fontSize: 13,
              fontWeight: isActive ? '600' : '400',
              color: isWaiting ? '#a8a29e' : (isDone ? '#78716c' : '#1c1917'),
            }}>
              {stage.label}
            </Text>
            {/* Right indicator */}
            {isDone && (
              <Text style={{ fontSize: 12, color: '#a8a29e', marginLeft: 8 }}>✓</Text>
            )}
            {isActive && (
              <ActivityIndicator size="small" color="#a8a29e" style={{ marginLeft: 8 }} />
            )}
          </View>
        );
      })}
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
  coversEnriched,
  onReset,
}: {
  result: ExecutionSummary;
  coversEnriched: number;
  onReset: () => void;
}) {
  const totalImported = result.added + result.merged;
  const showQueue = result.reviewRows.length > 0;

  const subtitle = totalImported > 0
    ? `${totalImported} ${totalImported === 1 ? 'book has' : 'books have'} been added to your library.${coversEnriched > 0 ? ` Covers and metadata updated for ${coversEnriched}.` : ''}`
    : 'Your library is already up to date.';

  return (
    <>
      <PageTitle>Import complete</PageTitle>
      <PageSubtitle>{subtitle}</PageSubtitle>

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

// ─── Step: confirm-reset ─────────────────────────────────────────────────────

function ConfirmResetView({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <PageTitle>Reset Goodreads import</PageTitle>
      <PageSubtitle>
        This will start your Goodreads import over from scratch.
      </PageSubtitle>

      <Card>
        <View style={{ padding: 18 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginBottom: 10 }}>
            What gets reset
          </Text>
          {[
            'Books imported from Goodreads with no in-app activity will be removed.',
            'Import history and staging data will be cleared.',
            'You can upload a fresh Goodreads CSV immediately after.',
          ].map((item, i) => (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 8 }}>
              <Text style={{ color: '#a8a29e', marginRight: 8, marginTop: 1 }}>·</Text>
              <Text style={{ flex: 1, fontSize: 13, color: '#57534e', lineHeight: 20 }}>
                {item}
              </Text>
            </View>
          ))}

          <View style={{ height: 1, backgroundColor: '#e7e5e4', marginVertical: 14 }} />

          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917', marginBottom: 10 }}>
            What is preserved
          </Text>
          {[
            'Books where you logged reading progress in-app.',
            'Books linked to a recommendation from a friend.',
            'Any book with activity in your reading feed.',
            'Your ratings, notes, friendships, and yearly goal.',
          ].map((item, i) => (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 8 }}>
              <Text style={{ color: '#a8a29e', marginRight: 8, marginTop: 1 }}>·</Text>
              <Text style={{ flex: 1, fontSize: 13, color: '#57534e', lineHeight: 20 }}>
                {item}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      <TouchableOpacity
        onPress={onConfirm}
        style={{
          marginTop: 24,
          backgroundColor: '#1c1917',
          borderRadius: 12,
          paddingVertical: 15,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
          Reset import
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onCancel}
        style={{
          marginTop: 12,
          paddingVertical: 13,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: '#e7e5e4',
          alignItems: 'center',
        }}
      >
        <Text style={{ fontSize: 14, color: '#78716c' }}>Cancel</Text>
      </TouchableOpacity>
    </>
  );
}

// ─── Step: reset-done ─────────────────────────────────────────────────────────

function ResetDoneView({
  result,
  onImportNow,
}: {
  result: GoodreadsResetResult;
  onImportNow: () => void;
}) {
  return (
    <>
      <PageTitle>Import reset</PageTitle>
      <PageSubtitle>
        Your Goodreads import has been cleared. You can upload a fresh CSV now.
      </PageSubtitle>

      <Card>
        <View style={{ padding: 18 }}>
          {result.removed > 0 && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: 14, color: '#57534e' }}>Books removed</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }}>{result.removed}</Text>
            </View>
          )}
          {result.preserved > 0 && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: 14, color: '#57534e' }}>Native books kept</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917' }}>{result.preserved}</Text>
            </View>
          )}
          {result.removed === 0 && result.preserved === 0 && (
            <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 20 }}>
              No Goodreads-imported books were found. Everything looks clean.
            </Text>
          )}
          <Text style={{ fontSize: 12, color: '#a8a29e', lineHeight: 18, marginTop: 4 }}>
            Import history and staging data cleared.
          </Text>
        </View>
      </Card>

      <TouchableOpacity
        onPress={onImportNow}
        style={{
          marginTop: 24,
          backgroundColor: '#1c1917',
          borderRadius: 12,
          paddingVertical: 15,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
          Import from Goodreads
        </Text>
      </TouchableOpacity>
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
  const [progressStages, setProgressStages]   = useState<ProgressStage[]>([]);
  const [coversEnriched, setCoversEnriched]   = useState(0);
  const [stageSummary, setStageSummary]       = useState<StageSummary | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionSummary | null>(null);
  const [currentUserId, setCurrentUserId]     = useState<string | null>(null);
  const [currentBatchId, setCurrentBatchId]   = useState<string | null>(null);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<GoodreadsResetResult | null>(null);

  const isWeb = Platform.OS === 'web';

  // ── Parse + stage ──────────────────────────────────────────────────────────

  async function handlePickFile() {
    const file = await pickCSVFile();
    if (!file) return;

    setProgressStages(stageList(PROCESSING_STAGES, 0));
    setStep('processing');

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

      setProgressStages(stageList(PROCESSING_STAGES, 1));
      if (!supabase) throw new Error('Supabase not configured.');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You must be signed in to import your library.');

      setProgressStages(stageList(PROCESSING_STAGES, 2));
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

    const eStages = (idx: number) => stageList(EXECUTING_STAGES, idx);
    setProgressStages(eStages(0));
    setStep('executing');

    try {
      const result = await executeGoodreadsImport(
        currentUserId,
        currentBatchId,
        (phase) => {
          if (phase === 'linking')   setProgressStages(eStages(1));
          if (phase === 'finalizing') setProgressStages(eStages(3));
        },
      );

      // Cover enrichment — only for freshly created books
      setProgressStages(eStages(2));
      const repaired = await repairBooksMetadata(result.allAffectedBookIds);
      setCoversEnriched(repaired.total);

      // Brief finalizing pause so the last stage is visible
      setProgressStages(eStages(3));
      await new Promise(r => setTimeout(r, 350));

      setExecutionResult(result);
      setStep('complete');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Import failed. Please try again.');
      setStep('error');
    }
  }

  // ── Goodreads data reset ───────────────────────────────────────────────────

  function handleResetRequest() {
    setStep('confirm-reset');
  }

  async function handleConfirmReset() {
    setStep('resetting');
    setProgressStages(stageList(['Checking your library', 'Clearing imported data', 'Cleaning up import history'], 0));
    try {
      const { data: { user } } = await supabase!.auth.getUser();
      if (!user) throw new Error('Not signed in');

      setProgressStages(stageList(['Checking your library', 'Clearing imported data', 'Cleaning up import history'], 1));
      const result = await resetGoodreadsImport(user.id);

      setProgressStages(stageList(['Checking your library', 'Clearing imported data', 'Cleaning up import history'], 3));
      setResetResult(result);
      setStep('reset-done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Reset failed. Please try again.');
      setStep('error');
    }
  }

  // ── UI reset (start the import flow over from idle) ────────────────────────

  function handleReset() {
    setStep('idle');
    setStageSummary(null);
    setExecutionResult(null);
    setCurrentUserId(null);
    setCurrentBatchId(null);
    setErrorMsg(null);
    setProgressStages([]);
    setCoversEnriched(0);
  }

  const isLocked = step === 'processing' || step === 'executing' || step === 'resetting';

  return (
    <ScreenContainer>
      <BackButton onPress={() => router.back()} disabled={isLocked} />

      {step === 'idle' && (
        <IdleView onPickFile={handlePickFile} isWeb={isWeb} onResetRequest={handleResetRequest} />
      )}

      {(step === 'processing' || step === 'executing' || step === 'resetting') && (
        <ProgressView stages={progressStages} />
      )}

      {step === 'confirm-reset' && (
        <ConfirmResetView onConfirm={handleConfirmReset} onCancel={handleReset} />
      )}

      {step === 'reset-done' && resetResult && (
        <ResetDoneView result={resetResult} onImportNow={handleReset} />
      )}

      {step === 'staged' && stageSummary && (
        <StagedView
          summary={stageSummary}
          onImport={handleExecute}
          onReset={handleReset}
        />
      )}

      {step === 'complete' && executionResult && (
        <CompleteView result={executionResult} coversEnriched={coversEnriched} onReset={handleReset} />
      )}

      {step === 'error' && (
        <ErrorView message={errorMsg ?? 'Unknown error.'} onReset={handleReset} />
      )}
    </ScreenContainer>
  );
}
