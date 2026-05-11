import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { BackButton } from '../../components/BackButton';
import { supabase } from '../../lib/supabase';
import { parseGoodreadsCSV } from '../../lib/goodreadsParser';
import { stageGoodreadsImport, loadStageSummary } from '../../lib/goodreadsStager';
import { executeGoodreadsImport } from '../../lib/goodreadsExecutor';
import { fetchGoogleBooksCoverUrl } from '../../lib/googleBooks';
import type { StageSummary } from '../../lib/goodreadsStager';
import type { ExecutionSummary } from '../../lib/goodreadsExecutor';
import { resetGoodreadsImport } from '../../lib/goodreadsReset';
import type { GoodreadsResetResult } from '../../lib/goodreadsReset';
import { repairBooksMetadata } from '../../lib/metadataRepair';
import { writeOnboardingStage } from '../../lib/onboardingStage';

// ─── Transfer helper constants ─────────────────────────────────────────────
// Bookmarklet: reads the Goodreads export page text and copies it to clipboard.
// No apostrophes in alert strings — avoids nested quoting issues in the href.
const BOOKMARKLET_HREF = [
  "javascript:(function(){",
  "var t=(document.body.innerText||'').trim();",
  "if(t.slice(0,7)!=='Book Id'){",
  "alert('This does not look like a Goodreads export page. Make sure you have clicked Export Library first.');",
  "return;}",
  "function ok(){alert('Copied! Go back to readstack and paste it in the import box.');}",
  "function fb(){var a=document.createElement('textarea');",
  "a.value=t;a.style.cssText='position:fixed;opacity:0;top:0;left:0';",
  "document.body.appendChild(a);a.focus();a.select();",
  "var d=document.execCommand('copy');document.body.removeChild(a);",
  "if(d){ok();}else{alert('Auto-copy failed. Select all, copy, and paste in readstack.');}",
  "}",
  "if(navigator.clipboard&&window.isSecureContext){",
  "navigator.clipboard.writeText(t).then(ok).catch(fb);",
  "}else{fb();}",
  "})();",
].join('');

// Siri Shortcut — clipboard-based handoff (avoids deep-link payload size limits):
//   Action 1: Run JavaScript on Webpage → return document.body.innerText
//   Action 2: Copy to Clipboard (the result)
//   Action 3: Open URL → bookappmobile://import/goodreads?source=shortcut
// The app detects source=shortcut (in the main component), reads the clipboard,
// validates, and imports. This path remains available for existing shortcut users.

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
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f5f1ec' }}
      contentContainerStyle={{ paddingHorizontal: 24, paddingTop: insets.top + 16, paddingBottom: 60 }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}


function PageTitle({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 28,
      fontWeight: '800',
      color: '#231f1b',
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

// ─── Native document picker ───────────────────────────────────────────────────

async function pickNativeDocument(): Promise<{ name: string; text: string } | null> {
  if (Platform.OS === 'web') return null;
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['text/csv', 'text/plain', 'public.comma-separated-values-text', '*/*'],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return null;
    const asset = result.assets[0];
    const text = await FileSystem.readAsStringAsync(asset.uri);
    return { name: asset.name ?? 'goodreads_library_export.csv', text };
  } catch {
    return null;
  }
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
      borderBottomColor: '#ede9e4',
    }}>
      <Text style={{
        fontSize: 26,
        fontWeight: '800',
        color: accent ?? '#231f1b',
        minWidth: 52,
        letterSpacing: -0.5,
      }}>
        {count}
      </Text>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b' }}>{label}</Text>
        {sublabel ? (
          <Text style={{ fontSize: 12, color: '#9e958d', marginTop: 2, lineHeight: 17 }}>{sublabel}</Text>
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
      borderBottomColor: '#ede9e4',
    }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 2 }} numberOfLines={1}>
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
        borderColor: '#ede9e4',
        alignItems: 'center',
      }}
    >
      <Text style={{ fontSize: 14, color: '#78716c' }}>{label}</Text>
    </TouchableOpacity>
  );
}

const GOODREADS_EXPORT_URL = 'https://www.goodreads.com/review/import';

// ─── Step: idle ───────────────────────────────────────────────────────────────

const STORYGRAPH_EXPORT_URL = 'https://app.thestorygraph.com/profile/edit';

function IdleView({
  onPickFile,
  onPickNativeFile,
  isWeb,
  onResetRequest,
  pastedText,
  onPastedTextChange,
  onSubmitPaste,
  onOpenBrowser,
}: {
  onPickFile: () => void;
  onPickNativeFile: () => void;
  isWeb: boolean;
  onResetRequest: () => void;
  pastedText: string;
  onPastedTextChange: (text: string) => void;
  onSubmitPaste: () => void;
  onOpenBrowser?: () => void;
}) {
  const [platform, setPlatform] = useState<'goodreads' | 'storygraph'>('goodreads');

  const storygraphSteps = [
    {
      label: 'Open StoryGraph in your browser',
      sub: 'Tap the button below to open StoryGraph. Sign in if you aren\'t already.',
    },
    {
      label: 'Go to Account → Edit Profile',
      sub: 'Scroll down to the "Import/Export" section at the bottom of the page.',
    },
    {
      label: 'Tap "Export your data"',
      sub: 'StoryGraph will email you a CSV file — check your inbox. It may take a few minutes.',
    },
    {
      label: 'Save the CSV, then add books manually',
      sub: 'Use your exported CSV as a reference list. You can add books in readstack via Search → find the book → mark as read and rate it. Direct StoryGraph import is coming soon.',
    },
  ];

  // ── Shared fallback section (paste + file) ────────────────────────────────
  function renderFallbacks() {
    return (
      <View style={{ marginTop: 16 }}>
        <TextInput
          value={pastedText}
          onChangeText={onPastedTextChange}
          multiline
          placeholder="Paste your Goodreads export here…"
          placeholderTextColor="#9e958d"
          style={{
            backgroundColor: '#fff',
            borderRadius: 12,
            borderWidth: 1,
            borderColor: pastedText.trim().length > 0 ? '#d4a574' : '#ede9e4',
            padding: 14,
            fontSize: 11,
            color: '#231f1b',
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
            height: 110,
            textAlignVertical: 'top',
            marginBottom: 10,
          }}
        />
        <TouchableOpacity
          onPress={onSubmitPaste}
          disabled={pastedText.trim().length < 10}
          style={{
            backgroundColor: pastedText.trim().length >= 10 ? '#231f1b' : '#ede9e4',
            borderRadius: 12,
            paddingVertical: 14,
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <Text style={{
            color: pastedText.trim().length >= 10 ? '#fff' : '#9e958d',
            fontSize: 15,
            fontWeight: '600',
          }}>
            Import
          </Text>
        </TouchableOpacity>

        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: '#ede9e4' }} />
          <Text style={{ fontSize: 11, fontWeight: '500', color: '#9e958d', marginHorizontal: 10 }}>
            or if a file downloaded
          </Text>
          <View style={{ flex: 1, height: 1, backgroundColor: '#ede9e4' }} />
        </View>

        <TouchableOpacity
          onPress={isWeb ? onPickFile : onPickNativeFile}
          style={{
            backgroundColor: '#ede9e4',
            borderRadius: 10,
            paddingVertical: 13,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#231f1b', fontSize: 14, fontWeight: '600' }}>
            Choose CSV File
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <PageTitle>Import your library</PageTitle>
      <PageSubtitle>
        Bring your reading history into readstack. You'll see a preview before anything is saved.
      </PageSubtitle>

      {/* ── Platform picker ── */}
      <View style={{
        flexDirection: 'row',
        backgroundColor: '#ede9e4',
        borderRadius: 10,
        padding: 3,
        marginBottom: 20,
      }}>
        {(['goodreads', 'storygraph'] as const).map(p => (
          <TouchableOpacity
            key={p}
            onPress={() => setPlatform(p)}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 8,
              alignItems: 'center',
              backgroundColor: platform === p ? '#fff' : 'transparent',
              shadowColor: platform === p ? '#000' : 'transparent',
              shadowOpacity: platform === p ? 0.06 : 0,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
              elevation: platform === p ? 1 : 0,
            }}
          >
            <Text style={{
              fontSize: 13,
              fontWeight: platform === p ? '700' : '500',
              color: platform === p ? '#231f1b' : '#78716c',
            }}>
              {p === 'goodreads' ? 'Goodreads' : 'StoryGraph'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── StoryGraph ── */}
      {platform === 'storygraph' && (
        <>
          <View style={{
            backgroundColor: '#fffbeb',
            borderRadius: 12,
            padding: 14,
            borderLeftWidth: 3,
            borderLeftColor: '#f59e0b',
            marginBottom: 20,
          }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', marginBottom: 3 }}>
              Direct import coming soon
            </Text>
            <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
              StoryGraph doesn't support automatic CSV upload yet. Export your data below, then use it as a reference to add books manually in readstack.
            </Text>
          </View>
          <Card>
            <View style={{ padding: 18 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', marginBottom: 14 }}>
                How to export your library
              </Text>
              {storygraphSteps.map((step, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: i < storygraphSteps.length - 1 ? 14 : 0 }}>
                  <View style={{
                    width: 22, height: 22, borderRadius: 11,
                    backgroundColor: '#ede9e4',
                    alignItems: 'center', justifyContent: 'center',
                    marginRight: 12, marginTop: 1, flexShrink: 0,
                  }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#78716c' }}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#231f1b', lineHeight: 20 }}>
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
          <TouchableOpacity
            onPress={() => Linking.openURL(STORYGRAPH_EXPORT_URL)}
            style={{
              marginTop: 20,
              backgroundColor: '#231f1b',
              borderRadius: 12,
              paddingVertical: 15,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
              Open StoryGraph Profile
            </Text>
          </TouchableOpacity>
          <View style={{ marginTop: 12, alignItems: 'center', paddingHorizontal: 8 }}>
            <Text style={{ fontSize: 11, color: '#9e958d', marginBottom: 4, textAlign: 'center' }}>
              Or copy this link into your browser:
            </Text>
            <Text selectable style={{ fontSize: 12, color: '#57534e', textAlign: 'center' }}>
              app.thestorygraph.com/profile/edit
            </Text>
          </View>
        </>
      )}

      {/* ── Goodreads: Native (iOS + Android) — in-app browser primary path ── */}
      {platform === 'goodreads' && Platform.OS !== 'web' && (
        <>
          {/* A. Headline + supporting copy */}
          <Text style={{
            fontSize: 20,
            fontWeight: '800',
            color: '#231f1b',
            letterSpacing: -0.3,
            marginBottom: 8,
          }}>
            Import from Goodreads
          </Text>
          <Text style={{
            fontSize: 13,
            color: '#78716c',
            lineHeight: 20,
            marginBottom: 22,
          }}>
            We open Goodreads inside readstack. Sign in if needed, then tap Export Library — we capture your library automatically when possible.
          </Text>

          {/* B. One dominant CTA */}
          <TouchableOpacity
            onPress={onOpenBrowser}
            disabled={!onOpenBrowser}
            style={{
              backgroundColor: '#231f1b',
              borderRadius: 14,
              paddingVertical: 17,
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <Text style={{
              color: '#fff',
              fontSize: 16,
              fontWeight: '800',
              letterSpacing: -0.2,
            }}>
              Import from Goodreads
            </Text>
          </TouchableOpacity>

          {/* C. Browser expectation copy */}
          <Text style={{
            fontSize: 11,
            color: '#9e958d',
            textAlign: 'center',
            lineHeight: 16,
            marginBottom: 36,
          }}>
            Opens Goodreads inside readstack · sign in if prompted
          </Text>

          {/* D. Other ways to import — always visible, clearly secondary */}
          <View style={{
            borderTopWidth: 1,
            borderTopColor: '#ede9e4',
            paddingTop: 20,
          }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: '#9e958d',
              letterSpacing: 0.8,
              textTransform: 'uppercase',
              marginBottom: 14,
            }}>
              Other ways to import
            </Text>

            <TouchableOpacity
              onPress={onPickNativeFile}
              style={{
                backgroundColor: '#ede9e4',
                borderRadius: 10,
                paddingVertical: 13,
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <Text style={{ color: '#231f1b', fontSize: 14, fontWeight: '600' }}>
                Choose CSV File
              </Text>
              <Text style={{ color: '#9e958d', fontSize: 11, marginTop: 2 }}>
                If you already exported from Goodreads
              </Text>
            </TouchableOpacity>

            <TextInput
              value={pastedText}
              onChangeText={onPastedTextChange}
              multiline
              placeholder="Or paste your Goodreads export text here…"
              placeholderTextColor="#9e958d"
              style={{
                backgroundColor: '#fff',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: pastedText.trim().length > 0 ? '#d4a574' : '#ede9e4',
                padding: 14,
                fontSize: 11,
                color: '#231f1b',
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                height: 90,
                textAlignVertical: 'top',
                marginBottom: 8,
              }}
            />
            <TouchableOpacity
              onPress={onSubmitPaste}
              disabled={pastedText.trim().length < 10}
              style={{
                backgroundColor: pastedText.trim().length >= 10 ? '#231f1b' : '#ede9e4',
                borderRadius: 10,
                paddingVertical: 12,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: pastedText.trim().length >= 10 ? '#fff' : '#9e958d',
                fontSize: 14,
                fontWeight: '600',
              }}>
                Import pasted text
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* ── Goodreads: Web ── */}
      {platform === 'goodreads' && Platform.OS === 'web' && (
        <>
          <View style={{
            backgroundColor: '#fffbf5',
            borderRadius: 12,
            padding: 14,
            borderLeftWidth: 3,
            borderLeftColor: '#d4a574',
            marginBottom: 16,
          }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', marginBottom: 3 }}>
              Do this in Safari or Chrome — not the Goodreads app
            </Text>
            <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
              If the Goodreads app opens when you tap the button below, use the app menu to open the page in Safari or Chrome instead. Goodreads may download a file or open your library as text — both work fine.
            </Text>
          </View>

          {/* Bookmarklet: set up once helper */}
          <View style={{
            backgroundColor: '#fff', borderRadius: 14,
            borderWidth: 1.5, borderColor: '#231f1b', padding: 18,
            marginBottom: 16,
          }}>
            <View style={{
              alignSelf: 'flex-start',
              backgroundColor: '#f5f0eb',
              borderRadius: 6,
              paddingVertical: 3,
              paddingHorizontal: 8,
              marginBottom: 8,
            }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#92400e', letterSpacing: 0.5 }}>
                SET UP ONCE
              </Text>
            </View>
            <Text style={{ fontSize: 15, fontWeight: '800', color: '#231f1b', marginBottom: 6 }}>
              readstack browser helper
            </Text>
            <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 19, marginBottom: 14 }}>
              Drag this button to your bookmarks bar — one-time setup.{'\n'}
              On the Goodreads export page, click it and your library is copied to clipboard automatically.
            </Text>
            <View style={{ alignItems: 'center', marginBottom: 12 }}>
              {/* @ts-ignore — web-only anchor via React Native Web */}
              <Text
                href={BOOKMARKLET_HREF}
                accessibilityRole="link"
                style={{
                  backgroundColor: '#ede9e4',
                  borderRadius: 8,
                  paddingVertical: 10,
                  paddingHorizontal: 20,
                  fontSize: 13,
                  fontWeight: '700',
                  color: '#231f1b',
                  borderWidth: 1,
                  borderColor: '#ede9e4',
                  cursor: 'grab',
                } as any}
              >
                ⊕ readstack Import
              </Text>
            </View>
            <Text style={{ fontSize: 11, color: '#78716c', lineHeight: 17 }}>
              After clicking the bookmark on Goodreads, paste the copied text in the box below.
            </Text>
          </View>

          <TouchableOpacity
            onPress={() => Linking.openURL(GOODREADS_EXPORT_URL)}
            style={{
              marginTop: 16,
              backgroundColor: '#231f1b',
              borderRadius: 12,
              paddingVertical: 15,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
              Open Goodreads Export Page
            </Text>
          </TouchableOpacity>
          <View style={{ marginTop: 6, alignItems: 'center' }}>
            <Text selectable style={{ fontSize: 11, color: '#9e958d' }}>
              goodreads.com/review/import
            </Text>
          </View>

          {renderFallbacks()}
        </>
      )}

      {/* ── Reset entry point (Goodreads only) ── */}
      {platform === 'goodreads' && (
        <View style={{ marginTop: 36, alignItems: 'center' }}>
          <View style={{ height: 1, backgroundColor: '#ede9e4', width: '100%', marginBottom: 20 }} />
          <TouchableOpacity onPress={onResetRequest} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={{ fontSize: 13, color: '#9e958d' }}>
              Reset Goodreads import
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  );
}

// ─── Progress stage types + helpers ──────────────────────────────────────────

type ProgressStage = {
  label: string;
  status: 'waiting' | 'active' | 'done';
};

const PROCESSING_STAGES = ['Reading your Goodreads file', 'Matching books', 'Preparing preview'];
const EXECUTING_STAGES  = ['Adding to your library', 'Linking reading history', 'Finding covers & details', 'Finishing up'];

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
  const total      = stages.length;
  const doneCount  = stages.filter(s => s.status === 'done').length;
  const activeStage = stages.find(s => s.status === 'active');
  const pct = total === 0 ? 0 : Math.min(1, (doneCount + (activeStage ? 0.5 : 0)) / total);
  const pctInt = Math.round(pct * 100);

  return (
    <View style={{
      flex: 1,
      minHeight: 480,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 28,
      paddingVertical: 40,
    }}>
      {/* Spinner */}
      <ActivityIndicator size="large" color="#231f1b" style={{ marginBottom: 36 }} />

      {/* Current stage headline */}
      <Text style={{
        fontSize: 22,
        fontWeight: '700',
        color: '#231f1b',
        textAlign: 'center',
        marginBottom: 6,
        letterSpacing: -0.3,
      }}>
        {activeStage?.label ?? 'Working…'}
      </Text>
      <Text style={{
        fontSize: 13,
        color: '#9e958d',
        textAlign: 'center',
        marginBottom: 44,
      }}>
        {pctInt}% complete
      </Text>

      {/* Stage list */}
      <View style={{ width: '100%', maxWidth: 300 }}>
        {stages.map((stage, i) => {
          const isActive  = stage.status === 'active';
          const isDone    = stage.status === 'done';
          return (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
              {/* Circle indicator */}
              {isDone ? (
                <View style={{
                  width: 22, height: 22, borderRadius: 11,
                  backgroundColor: '#ede9e4',
                  alignItems: 'center', justifyContent: 'center',
                  marginRight: 12, flexShrink: 0,
                }}>
                  <Text style={{ fontSize: 11, color: '#78716c', lineHeight: 14 }}>✓</Text>
                </View>
              ) : isActive ? (
                <View style={{
                  width: 22, height: 22, borderRadius: 11,
                  backgroundColor: '#231f1b',
                  alignItems: 'center', justifyContent: 'center',
                  marginRight: 12, flexShrink: 0,
                }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#f5f1ec' }} />
                </View>
              ) : (
                <View style={{
                  width: 22, height: 22, borderRadius: 11,
                  borderWidth: 1.5, borderColor: '#ede9e4',
                  marginRight: 12, flexShrink: 0,
                }} />
              )}
              <Text style={{
                flex: 1,
                fontSize: 14,
                fontWeight: isActive ? '600' : '400',
                color: isDone ? '#9e958d' : isActive ? '#231f1b' : '#ede9e4',
              }}>
                {stage.label}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Progress bar */}
      <View style={{
        width: '100%',
        maxWidth: 300,
        height: 2,
        backgroundColor: '#ede9e4',
        borderRadius: 1,
        marginTop: 24,
        overflow: 'hidden',
      }}>
        <View style={{
          height: 2,
          width: `${pctInt}%` as unknown as number,
          backgroundColor: '#231f1b',
          borderRadius: 1,
        }} />
      </View>
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
          accent="#2f6f3a"
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
              <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#ede9e4' }}>
                <Text style={{ fontSize: 12, color: '#9e958d' }}>
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
            backgroundColor: '#231f1b',
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
  onGoToDiscover,
  onGoToLibrary,
}: {
  result: ExecutionSummary;
  coversEnriched: number;
  onReset: () => void;
  onGoToDiscover: () => void;
  onGoToLibrary: () => void;
}) {
  const totalImported = result.added + result.merged;
  const showQueue = result.reviewRows.length > 0;

  // Headline and subtitle vary by outcome
  const heading = totalImported > 0 ? 'Your library is in.' : 'Already up to date.';

  const subtitle = totalImported > 0
    ? `${totalImported} ${totalImported === 1 ? 'book' : 'books'} added.${coversEnriched > 0 ? ` Covers enriched for ${coversEnriched}.` : ''} Head to Discover — your recommendations are being built now.`
    : 'Nothing new to add — your library is current. Your recommendations are ready.';

  return (
    <>
      <PageTitle>{heading}</PageTitle>
      <PageSubtitle>{subtitle}</PageSubtitle>

      <SectionLabel>Results</SectionLabel>
      <Card>
        <StatRow
          count={result.added}
          label="Added to library"
          sublabel="New books added to your readstack"
          accent={result.added > 0 ? '#2f6f3a' : undefined}
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
              <View style={{ paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#ede9e4' }}>
                <Text style={{ fontSize: 12, color: '#9e958d' }}>
                  +{result.reviewRows.length - 20} more rows were skipped
                </Text>
              </View>
            )}
          </Card>
        </>
      )}

      {/* Primary CTA — send to recommendations, not library */}
      <TouchableOpacity
        onPress={onGoToDiscover}
        style={{
          marginTop: 28,
          backgroundColor: '#231f1b',
          borderRadius: 12,
          paddingVertical: 15,
          alignItems: 'center',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>
          Explore recommendations
        </Text>
      </TouchableOpacity>

      {/* Secondary: view library */}
      <TouchableOpacity
        onPress={onGoToLibrary}
        style={{
          marginTop: 14,
          paddingVertical: 10,
          alignItems: 'center',
        }}
      >
        <Text style={{ fontSize: 14, color: '#6b635c' }}>View library</Text>
      </TouchableOpacity>

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
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', marginBottom: 10 }}>
            What gets reset
          </Text>
          {[
            'Books imported from Goodreads with no in-app activity will be removed.',
            'Import history and staging data will be cleared.',
            'You can upload a fresh Goodreads CSV immediately after.',
          ].map((item, i) => (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 8 }}>
              <Text style={{ color: '#9e958d', marginRight: 8, marginTop: 1 }}>·</Text>
              <Text style={{ flex: 1, fontSize: 13, color: '#57534e', lineHeight: 20 }}>
                {item}
              </Text>
            </View>
          ))}

          <View style={{ height: 1, backgroundColor: '#ede9e4', marginVertical: 14 }} />

          <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b', marginBottom: 10 }}>
            What is preserved
          </Text>
          {[
            'Books where you logged reading progress in-app.',
            'Books linked to a recommendation from a friend.',
            'Any book with activity in your reading feed.',
            'Your ratings, notes, friendships, and yearly goal.',
          ].map((item, i) => (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 8 }}>
              <Text style={{ color: '#9e958d', marginRight: 8, marginTop: 1 }}>·</Text>
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
          backgroundColor: '#231f1b',
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
          borderColor: '#ede9e4',
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
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b' }}>{result.removed}</Text>
            </View>
          )}
          {result.preserved > 0 && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: 14, color: '#57534e' }}>Native books kept</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b' }}>{result.preserved}</Text>
            </View>
          )}
          {result.removed === 0 && result.preserved === 0 && (
            <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 20 }}>
              No Goodreads-imported books were found. Everything looks clean.
            </Text>
          )}
          <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18, marginTop: 4 }}>
            Import history and staging data cleared.
          </Text>
        </View>
      </Card>

      <TouchableOpacity
        onPress={onImportNow}
        style={{
          marginTop: 24,
          backgroundColor: '#231f1b',
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
          backgroundColor: '#231f1b',
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
  const { source, batchId } = useLocalSearchParams<{ source?: string; batchId?: string }>();
  const didHandleIncoming = useRef(false);

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
  const [pastedText, setPastedText] = useState('');

  // ── Siri Shortcut clipboard receiver ─────────────────────────────────────
  // Triggered when the app is opened via bookappmobile://import/goodreads?source=shortcut
  // The Shortcut: (1) runs JS on Goodreads page to get innerText, (2) copies
  // that text to the clipboard, (3) opens the URL above.
  // No payload in the URL — the CSV travels via clipboard, which has no size limit.

  useEffect(() => {
    const src = Array.isArray(source) ? source[0] : source;
    if (src !== 'shortcut' || didHandleIncoming.current) return;
    didHandleIncoming.current = true;

    (async () => {
      let text = '';
      try {
        text = (await Clipboard.getStringAsync()) ?? '';
      } catch {
        setErrorMsg(
          'Could not read the clipboard. Please paste your Goodreads data manually in the box below.'
        );
        setStep('error');
        return;
      }

      text = text.trim();

      if (!text) {
        setErrorMsg(
          'Nothing was found on your clipboard. Make sure you ran the readstack Shortcut on the Goodreads export page before opening the app.'
        );
        setStep('error');
        return;
      }

      if (!text.slice(0, 7).startsWith('Book Id')) {
        setErrorMsg(
          'The clipboard content doesn\u2019t look like a Goodreads export. Open the Goodreads export page in Safari, run the readstack Shortcut, then open the app again.'
        );
        setStep('error');
        return;
      }

      processCSVText(text, 'goodreads_shortcut.csv');
    })();
  // processCSVText is stable — intentional omission.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // ── In-app Goodreads browser handoff ─────────────────────────────────────
  // Triggered when the browser screen calls router.replace('/import/goodreads?batchId=...')
  // Loads the StageSummary from Supabase using the batchId and goes directly
  // to the 'staged' state — skipping idle and processing entirely.

  useEffect(() => {
    const id = Array.isArray(batchId) ? batchId[0] : batchId;
    if (!id || didHandleIncoming.current) return;
    didHandleIncoming.current = true;

    // Load the staged summary directly — do not transition through 'processing'.
    // The browser screen already performed parse+stage; we just reload the
    // StageSummary from Supabase and jump straight to 'staged'.
    (async () => {
      try {
        const summary = await loadStageSummary(id);
        const { data: { user } } = await supabase!.auth.getUser();
        setCurrentUserId(user?.id ?? null);
        setCurrentBatchId(id);
        setStageSummary(summary);
        setStep('staged');
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : 'Could not resume import.');
        setStep('error');
      }
    })();
  // loadStageSummary is stable. intentional omission.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  // ── Shared CSV processing (all acquisition paths feed here) ────────────────

  async function processCSVText(csvText: string, filename: string) {
    setProgressStages(stageList(PROCESSING_STAGES, 0));
    setStep('processing');

    try {
      const parseResult = parseGoodreadsCSV(csvText);

      if (!parseResult.isGoodreadsExport) {
        const errMsg = parseResult.parseErrors[0]?.message ?? 'This does not look like a Goodreads export CSV.';
        setErrorMsg(
          `We couldn't read this as a Goodreads export.\n\n${errMsg}\n\nMake sure you're using the file exported from Goodreads → My Books → Import and Export.`
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
      const staged = await stageGoodreadsImport(user.id, parseResult.rows, filename);

      setCurrentUserId(user.id);
      setCurrentBatchId(staged.batchId);
      setStageSummary(staged);
      setStep('staged');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setStep('error');
    }
  }

  // ── Acquisition: web file picker ───────────────────────────────────────────

  async function handlePickFile() {
    const file = await pickCSVFile();
    if (!file) return;
    await processCSVText(file.text, file.name);
  }

  // ── Acquisition: native document picker ───────────────────────────────────

  async function handlePickNativeFile() {
    const file = await pickNativeDocument();
    if (!file) return;
    await processCSVText(file.text, file.name);
  }

  // ── Acquisition: pasted CSV text ──────────────────────────────────────────

  async function handleSubmitPaste() {
    const trimmed = pastedText.trim();
    if (trimmed.length < 10) return;
    await processCSVText(trimmed, 'pasted_csv.csv');
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
      writeOnboardingStage('done'); // fire-and-forget — marks local stage done
      // Belt-and-suspenders: ensure the durable DB flag is set so future logins
      // never restart onboarding (import may be reached directly, bypassing the
      // onboarding-import.tsx action handler where the primary DB write lives).
      if (supabase) {
        supabase.auth.getSession().then(async ({ data: { session } }) => {
          if (session?.user) {
            await supabase?.from('profiles')
              .update({ onboarding_completed: true })
              .eq('id', session.user.id);
            // Force a token refresh so the JWT app_metadata claim (set by
            // the trigger in migration 20260421000000) carries the updated
            // value immediately, keeping the cold-start fast path hot.
            supabase?.auth.refreshSession().catch(() => {});
          }
        }).catch(() => {});
      }
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
    setPastedText('');
  }

  const isLocked = step === 'processing' || step === 'executing' || step === 'resetting';

  return (
    <ScreenContainer>
      <BackButton onPress={() => router.back()} disabled={isLocked} style={{ marginBottom: 28 }} />

      {step === 'idle' && (
        <IdleView
          onPickFile={handlePickFile}
          onPickNativeFile={handlePickNativeFile}
          isWeb={isWeb}
          onResetRequest={handleResetRequest}
          pastedText={pastedText}
          onPastedTextChange={setPastedText}
          onSubmitPaste={handleSubmitPaste}
          onOpenBrowser={
            Platform.OS !== 'web'
              ? () => {
                  console.log('[GoodreadsImport] opening_browser_v3 Platform.OS=' + Platform.OS);
                  router.push('/import/goodreads-browser');
                }
              : undefined
          }
        />
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
        <CompleteView
          result={executionResult}
          coversEnriched={coversEnriched}
          onReset={handleReset}
          onGoToDiscover={() => router.replace('/taste-readout' as any)}
          onGoToLibrary={() => router.push('/(tabs)/library' as any)}
        />
      )}

      {step === 'error' && (
        <ErrorView message={errorMsg ?? 'Unknown error.'} onReset={handleReset} />
      )}
    </ScreenContainer>
  );
}
