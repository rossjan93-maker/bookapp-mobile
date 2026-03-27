// =============================================================================
// app/scan.tsx — Barcode scan + "Will I like this?" result screen
//
// Flow (native):
//   Camera → barcode detected → resolve ISBN → evaluate fit → show result
//
// Flow (web / permission denied):
//   Manual ISBN / title+author entry → resolve → evaluate fit → show result
//
// After seeing the result, the user can:
//   - "Want to Read" → upserts to books + user_books + persistFeedback('saved')
//   - "Not for me"   → persistFeedback('dismissed')
//   - "More like this" → persistFeedback('more_like_this')
// All actions also update the scan_history row via updateScanAction.
// =============================================================================

import {
  useState, useEffect, useRef, useCallback,
} from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, TextInput,
  ActivityIndicator, Image, Platform, KeyboardAvoidingView,
  SafeAreaView, Alert,
} from 'react-native';
import { useRouter }                from 'expo-router';
import { Ionicons }                 from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { supabase }                 from '../lib/supabase';
import { computeTasteProfile }      from '../lib/tasteProfile';
import { loadFeedbackContext, persistFeedback } from '../lib/recFeedback';
import {
  resolveISBN, searchByTitle, evaluateScanFit,
  VERDICT_LABELS, VERDICT_HEADLINES,
  type ResolvedBook, type ScanFitResult, type ScanVerdict,
} from '../lib/scanFitEval';
import { persistScan, updateScanAction } from '../lib/scanHistory';

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | 'scanning'
  | 'manual'
  | 'resolving'
  | 'evaluating'
  | 'result'
  | 'not_found'
  | 'low_signal'
  | 'error';

type ActionState = 'idle' | 'saved' | 'dismissed' | 'more_like_this';

// ── Constants ─────────────────────────────────────────────────────────────────

const VERDICT_BADGE: Record<ScanVerdict, { bg: string; text: string }> = {
  strong_fit:  { bg: '#dcfce7', text: '#15803d' },
  likely_fit:  { bg: '#f0fdf4', text: '#16a34a' },
  mixed_fit:   { bg: '#fef9c3', text: '#854d0e' },
  not_for_you: { bg: '#fee2e2', text: '#b91c1c' },
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high:   'High confidence',
  medium: 'Medium confidence',
  low:    'Low confidence — add more books for a sharper verdict',
};

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ScanScreen() {
  const router = useRouter();

  // Camera
  const [permission, requestPermission] = useCameraPermissions();
  const scanLock = useRef(false); // prevent double-scan

  // Phase state machine — all platforms start at 'scanning'.
  // On web, expo-camera uses getUserMedia + BarcodeDetector (polyfill included).
  // If the browser blocks camera (e.g. iframe without allow="camera"), the
  // permission-denied screen is shown and the user falls through to manual entry.
  const [phase, setPhase] = useState<Phase>('scanning');

  // Manual entry
  const [manualIsbn, setManualIsbn]   = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthor, setManualAuthor] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  // Results
  const [loadingText, setLoadingText]   = useState('');
  const [scannedISBN, setScannedISBN]   = useState<string | null>(null);
  const [fitResult, setFitResult]       = useState<ScanFitResult | null>(null);
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);
  const [scanHistoryId, setScanHistoryId] = useState<string | null>(null);
  const [actionState, setActionState]   = useState<ActionState>('idle');

  // ── On mount: request camera permission on all platforms ─────────────────
  // On web this triggers the browser's camera permission dialog.
  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, []);

  // ── Barcode scan handler ──────────────────────────────────────────────────
  const handleBarcodeScan = useCallback(
    async (result: { data: string }) => {
      if (scanLock.current || phase !== 'scanning') return;
      scanLock.current = true;

      const isbn = result.data.replace(/[-\s]/g, '');
      // Validate EAN-13 (ISBN-13) or ISBN-10
      const isIsbn = /^(978|979)\d{10}$/.test(isbn) || /^\d{9}[\dX]$/.test(isbn);
      if (!isIsbn) {
        scanLock.current = false;
        return;
      }

      setScannedISBN(isbn);
      await runEvaluation(isbn, null, null);
    },
    [phase],
  );

  // ── Manual submit ─────────────────────────────────────────────────────────
  async function handleManualSubmit() {
    setManualError(null);
    const isbn = manualIsbn.replace(/[-\s]/g, '');

    if (isbn.length >= 10) {
      await runEvaluation(isbn, null, null);
    } else if (manualTitle.trim().length >= 2) {
      await runEvaluation(null, manualTitle.trim(), manualAuthor.trim());
    } else {
      setManualError('Enter an ISBN or at least a title to search.');
    }
  }

  // ── Core evaluation pipeline ──────────────────────────────────────────────
  async function runEvaluation(
    isbn:   string | null,
    title:  string | null,
    author: string | null,
  ) {
    if (!supabase) return;

    try {
      // 1. Resolve book metadata
      setLoadingText(isbn ? `Looking up ${isbn}…` : `Searching for "${title}"…`);
      setPhase('resolving');

      let resolved: ResolvedBook | null = null;
      if (isbn) {
        resolved = await resolveISBN(isbn);
      } else {
        resolved = await searchByTitle(title ?? '', author ?? '');
      }

      if (!resolved) {
        setPhase('not_found');
        return;
      }

      // 2. Load taste profile + feedback context in parallel
      setLoadingText(`Calculating your fit for "${resolved.title}"…`);
      setPhase('evaluating');

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setErrorMsg('You need to be signed in.'); setPhase('error'); return; }

      const [profile, feedback] = await Promise.all([
        computeTasteProfile(supabase, user.id),
        loadFeedbackContext(supabase, user.id),
      ]);

      // 3. Evaluate fit (pure, synchronous after data is loaded)
      const result = evaluateScanFit(resolved, profile, feedback);
      setFitResult(result);
      setActionState('idle');

      // 4. Persist scan history in background
      persistScan(supabase, user.id, result)
        .then(id => { if (id) setScanHistoryId(id); })
        .catch(() => {});

      // 5. Show result (or low-signal view if tier ≤ 1)
      setPhase(result.low_signal ? 'low_signal' : 'result');

    } catch (err) {
      console.error('[SCAN] evaluation error', err);
      setErrorMsg('Something went wrong. Please try again.');
      setPhase('error');
    } finally {
      scanLock.current = false;
    }
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  async function handleSave() {
    if (!supabase || !fitResult || actionState !== 'idle') return;
    setActionState('saved');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Persist scan action in background
    if (scanHistoryId) {
      updateScanAction(supabase, scanHistoryId, 'saved').catch(() => {});
    }

    // Build a minimal ScoredBook-compatible shape for persistFeedback
    const book = fitResult.book;
    const bookLike = {
      id:          `scan:${book.isbn || book.title}`,
      title:       book.title,
      author:      book.author,
      cover_url:   book.cover_url,
      external_id: fitResult.external_id,
      subjects:    book.subjects.length > 0 ? book.subjects : null,
      page_count:  book.page_count,
      description: book.description,
      _source:     'open_library' as const,
      _retrieval_reason: 'isbn_scan',
    };

    // Upsert book record + user_books in background
    (async () => {
      let bookDbId: string | null = null;
      if (fitResult.external_id) {
        const { data: existing } = await supabase!
          .from('books')
          .select('id')
          .eq('external_id', fitResult.external_id)
          .maybeSingle();

        if (existing) {
          bookDbId = (existing as { id: string }).id;
        } else {
          const { data: created } = await supabase!
            .from('books')
            .insert({
              title:       book.title,
              author:      book.author,
              external_id: fitResult.external_id,
              cover_url:   book.cover_url,
              subjects:    book.subjects,
              page_count:  book.page_count,
            })
            .select('id')
            .single();
          bookDbId = (created as { id: string } | null)?.id ?? null;
        }
      }

      if (bookDbId) {
        await supabase!
          .from('user_books')
          .upsert(
            { user_id: user.id, book_id: bookDbId, status: 'want_to_read' },
            { onConflict: 'user_id,book_id', ignoreDuplicates: true },
          );
      }

      await persistFeedback(supabase!, user.id, bookLike as any, 'saved', {
        book_db_id: bookDbId ?? undefined,
      }).catch(() => {});
    })().catch(() => {});
  }

  async function handleDismiss() {
    if (!supabase || !fitResult || actionState !== 'idle') return;
    setActionState('dismissed');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    if (scanHistoryId) {
      updateScanAction(supabase, scanHistoryId, 'dismissed').catch(() => {});
    }
    const book = fitResult.book;
    const bookLike = {
      id: `scan:${book.isbn || book.title}`, title: book.title,
      author: book.author, cover_url: book.cover_url,
      external_id: fitResult.external_id, subjects: null,
      page_count: null, description: null,
      _source: 'open_library' as const, _retrieval_reason: 'isbn_scan',
    };
    persistFeedback(supabase, user.id, bookLike as any, 'dismissed').catch(() => {});
  }

  async function handleMoreLikeThis() {
    if (!supabase || !fitResult || actionState !== 'idle') return;
    setActionState('more_like_this');

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    if (scanHistoryId) {
      updateScanAction(supabase, scanHistoryId, 'more_like_this').catch(() => {});
    }
    const book = fitResult.book;
    const bookLike = {
      id: `scan:${book.isbn || book.title}`, title: book.title,
      author: book.author, cover_url: book.cover_url,
      external_id: fitResult.external_id, subjects: null,
      page_count: null, description: null,
      _source: 'open_library' as const, _retrieval_reason: 'isbn_scan',
    };
    persistFeedback(supabase, user.id, bookLike as any, 'more_like_this').catch(() => {});
  }

  function handleScanAnother() {
    scanLock.current = false;
    setFitResult(null);
    setScannedISBN(null);
    setScanHistoryId(null);
    setActionState('idle');
    setManualIsbn('');
    setManualTitle('');
    setManualAuthor('');
    setManualError(null);
    setErrorMsg(null);
    setPhase('scanning');
  }

  // ── Header ─────────────────────────────────────────────────────────────────
  const header = (
    <View style={s.header}>
      <Pressable onPress={() => router.back()} style={s.headerBack} hitSlop={12}>
        <Ionicons name="chevron-back" size={24} color="#1c1917" />
      </Pressable>
      <Text style={s.headerTitle}>Scan a book</Text>
      <View style={{ width: 40 }} />
    </View>
  );

  // ── Render phases ─────────────────────────────────────────────────────────

  // Scanning phase — full-screen camera
  if (phase === 'scanning') {
    if (!permission) {
      return (
        <SafeAreaView style={s.root}>
          {header}
          <View style={s.centred}>
            <ActivityIndicator size="large" color="#1c1917" />
          </View>
        </SafeAreaView>
      );
    }
    if (!permission.granted) {
      return (
        <SafeAreaView style={s.root}>
          {header}
          <View style={s.centred}>
            <Ionicons name="camera-outline" size={48} color="#a8a29e" />
            <Text style={s.emptyTitle}>Camera access needed</Text>
            <Text style={s.emptyBody}>
              Allow camera access so you can scan a book's barcode in the store.
            </Text>
            <Pressable style={s.primaryBtn} onPress={requestPermission}>
              <Text style={s.primaryBtnText}>Allow camera</Text>
            </Pressable>
            <Pressable style={s.ghostBtn} onPress={() => setPhase('manual')}>
              <Text style={s.ghostBtnText}>Enter ISBN manually instead</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          onBarcodeScanned={handleBarcodeScan}
          barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8'] }}
        />

        {/* Darkened overlay with scan window */}
        <View style={s.overlay}>
          {/* Top dark band */}
          <View style={s.overlayBand} />

          {/* Middle row: dark | window | dark */}
          <View style={s.overlayMiddle}>
            <View style={s.overlayBandH} />
            <View style={s.scanWindow}>
              {/* Corner marks */}
              <View style={[s.corner, s.cornerTL]} />
              <View style={[s.corner, s.cornerTR]} />
              <View style={[s.corner, s.cornerBL]} />
              <View style={[s.corner, s.cornerBR]} />
            </View>
            <View style={s.overlayBandH} />
          </View>

          {/* Bottom band + instructions */}
          <View style={[s.overlayBand, { paddingTop: 28 }]}>
            <Text style={s.scanHint}>Point at the book's barcode</Text>
            <Pressable style={s.manualFallback} onPress={() => setPhase('manual')}>
              <Text style={s.manualFallbackText}>Enter ISBN manually</Text>
            </Pressable>
          </View>
        </View>

        {/* Close button */}
        <SafeAreaView style={s.cameraClose}>
          <Pressable onPress={() => router.back()} hitSlop={16}
            style={{ backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 20, padding: 8 }}>
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  // Resolving / evaluating — loading screen
  if (phase === 'resolving' || phase === 'evaluating') {
    return (
      <SafeAreaView style={s.root}>
        {header}
        <View style={s.centred}>
          <ActivityIndicator size="large" color="#1c1917" style={{ marginBottom: 16 }} />
          <Text style={s.loadingText}>{loadingText}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Not found
  if (phase === 'not_found') {
    return (
      <SafeAreaView style={s.root}>
        {header}
        <View style={s.centred}>
          <Ionicons name="search-outline" size={48} color="#a8a29e" />
          <Text style={s.emptyTitle}>Book not found</Text>
          <Text style={s.emptyBody}>
            {scannedISBN
              ? `We couldn't find a book with ISBN ${scannedISBN}.`
              : "We couldn't find that book."}
            {'\n'}Try entering the title manually.
          </Text>
          <Pressable style={s.primaryBtn} onPress={() => { setManualIsbn(scannedISBN ?? ''); setPhase('manual'); }}>
            <Text style={s.primaryBtnText}>Enter details manually</Text>
          </Pressable>
          <Pressable style={s.ghostBtn} onPress={handleScanAnother}>
            <Text style={s.ghostBtnText}>Scan again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // Error
  if (phase === 'error') {
    return (
      <SafeAreaView style={s.root}>
        {header}
        <View style={s.centred}>
          <Ionicons name="warning-outline" size={48} color="#a8a29e" />
          <Text style={s.emptyTitle}>Something went wrong</Text>
          <Text style={s.emptyBody}>{errorMsg ?? 'Please try again.'}</Text>
          <Pressable style={s.primaryBtn} onPress={handleScanAnother}>
            <Text style={s.primaryBtnText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // Manual entry
  if (phase === 'manual') {
    return (
      <SafeAreaView style={s.root}>
        {header}
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={s.manualContainer}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={s.manualSectionLabel}>Search by ISBN</Text>
            <TextInput
              style={s.input}
              placeholder="e.g. 9780525559474"
              placeholderTextColor="#a8a29e"
              value={manualIsbn}
              onChangeText={setManualIsbn}
              keyboardType="numeric"
              returnKeyType="search"
              onSubmitEditing={handleManualSubmit}
              autoFocus
            />

            <View style={s.orRow}>
              <View style={s.orLine} />
              <Text style={s.orText}>or search by title</Text>
              <View style={s.orLine} />
            </View>

            <Text style={s.manualSectionLabel}>Title</Text>
            <TextInput
              style={s.input}
              placeholder="Book title"
              placeholderTextColor="#a8a29e"
              value={manualTitle}
              onChangeText={setManualTitle}
              returnKeyType="next"
            />

            <Text style={[s.manualSectionLabel, { marginTop: 10 }]}>Author (optional)</Text>
            <TextInput
              style={s.input}
              placeholder="Author name"
              placeholderTextColor="#a8a29e"
              value={manualAuthor}
              onChangeText={setManualAuthor}
              returnKeyType="search"
              onSubmitEditing={handleManualSubmit}
            />

            {manualError && (
              <Text style={s.manualError}>{manualError}</Text>
            )}

            <Pressable style={s.primaryBtn} onPress={handleManualSubmit}>
              <Text style={s.primaryBtnText}>Get fit verdict</Text>
            </Pressable>

            <Pressable
              style={s.ghostBtn}
              onPress={() => { setManualError(null); setPhase('scanning'); }}
            >
              <Ionicons name="barcode-outline" size={16} color="#78716c" style={{ marginRight: 6 }} />
              <Text style={s.ghostBtnText}>Scan barcode instead</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Result screen (and low_signal variant) ────────────────────────────────
  if ((phase === 'result' || phase === 'low_signal') && fitResult) {
    const { book, verdict, confidence, reasons, caution, score_display, low_signal } = fitResult;
    const badge    = VERDICT_BADGE[verdict];
    const headline = VERDICT_HEADLINES[verdict];

    return (
      <SafeAreaView style={s.root}>
        {header}
        <ScrollView
          contentContainerStyle={s.resultContainer}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Book card ───────────────────────────────────────────────────── */}
          <View style={s.bookCard}>
            {book.cover_url ? (
              <Image
                source={{ uri: book.cover_url }}
                style={s.cover}
                resizeMode="cover"
              />
            ) : (
              <View style={[s.cover, s.coverPlaceholder]}>
                <Ionicons name="book-outline" size={32} color="#a8a29e" />
              </View>
            )}
            <View style={s.bookMeta}>
              <Text style={s.bookTitle} numberOfLines={3}>{book.title}</Text>
              <Text style={s.bookAuthor} numberOfLines={2}>{book.author}</Text>
              {book.page_count && (
                <Text style={s.bookPages}>{book.page_count} pages</Text>
              )}
            </View>
          </View>

          {/* ── Verdict headline ─────────────────────────────────────────────── */}
          <View style={s.verdictSection}>
            <Text style={s.verdictQuestion}>Will I like this?</Text>
            <Text style={s.verdictHeadline}>{headline}</Text>

            {/* Badge + score row */}
            <View style={s.verdictRow}>
              <View style={[s.verdictBadge, { backgroundColor: badge.bg }]}>
                <Text style={[s.verdictBadgeText, { color: badge.text }]}>
                  {VERDICT_LABELS[verdict]}
                </Text>
              </View>
              {!low_signal && (
                <View style={s.scoreChip}>
                  <Text style={s.scoreNumber}>{score_display}</Text>
                  <Text style={s.scoreSlash}> / 100</Text>
                </View>
              )}
            </View>

            <Text style={s.confidenceText}>{CONFIDENCE_LABEL[confidence]}</Text>
          </View>

          <View style={s.divider} />

          {/* ── Low-signal notice ─────────────────────────────────────────────── */}
          {low_signal && (
            <View style={s.lowSignalCard}>
              <Ionicons name="information-circle-outline" size={18} color="#78716c" style={{ marginRight: 8, flexShrink: 0 }} />
              <Text style={s.lowSignalText}>
                The more books you track in your library, the more accurate this verdict becomes.
              </Text>
            </View>
          )}

          {/* ── Reasons ──────────────────────────────────────────────────────── */}
          {reasons.length > 0 && (
            <View style={s.reasonsSection}>
              {reasons.map((r, i) => (
                <View key={i} style={s.reasonRow}>
                  <View style={s.reasonDot} />
                  <Text style={s.reasonText}>{r}</Text>
                </View>
              ))}
            </View>
          )}

          {/* ── Caution ──────────────────────────────────────────────────────── */}
          {caution && (
            <View style={s.cautionCard}>
              <Ionicons name="alert-circle-outline" size={16} color="#92400e" style={{ marginRight: 8, flexShrink: 0 }} />
              <Text style={s.cautionText}>{caution}</Text>
            </View>
          )}

          <View style={s.divider} />

          {/* ── Actions ──────────────────────────────────────────────────────── */}
          <View style={s.actionsSection}>
            {actionState === 'idle' ? (
              <>
                <Pressable
                  style={[s.actionBtn, s.actionBtnPrimary]}
                  onPress={handleSave}
                >
                  <Ionicons name="bookmark-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={s.actionBtnPrimaryText}>Want to Read</Text>
                </Pressable>

                <View style={s.actionRowSecondary}>
                  <Pressable
                    style={[s.actionBtnSecondary, { flex: 1, marginRight: 8 }]}
                    onPress={handleDismiss}
                  >
                    <Text style={s.actionBtnSecondaryText}>Not for me</Text>
                  </Pressable>
                  <Pressable
                    style={[s.actionBtnSecondary, { flex: 1 }]}
                    onPress={handleMoreLikeThis}
                  >
                    <Text style={s.actionBtnSecondaryText}>More like this</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <View style={s.actionConfirm}>
                <Ionicons name="checkmark-circle" size={22} color="#15803d" style={{ marginRight: 8 }} />
                <Text style={s.actionConfirmText}>
                  {actionState === 'saved'
                    ? 'Added to your Want to Read list'
                    : actionState === 'dismissed'
                    ? "Noted — we'll recommend fewer like this"
                    : "Got it — we'll show more like this"}
                </Text>
              </View>
            )}
          </View>

          {/* ── Scan another ─────────────────────────────────────────────────── */}
          <Pressable style={s.scanAnotherBtn} onPress={handleScanAnother}>
            <Ionicons name="barcode-outline" size={16} color="#78716c" style={{ marginRight: 6 }} />
            <Text style={s.scanAnotherText}>Scan another book</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return null;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SCAN_WINDOW_W = 280;
const SCAN_WINDOW_H = 120;

const s = StyleSheet.create({
  root: {
    flex:            1,
    backgroundColor: '#faf9f7',
  },
  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical:   14,
    borderBottomWidth: 1,
    borderBottomColor: '#e7e5e4',
    backgroundColor:   '#faf9f7',
  },
  headerBack: {
    width: 40,
    alignItems: 'flex-start',
  },
  headerTitle: {
    fontSize:   17,
    fontWeight: '600',
    color:      '#1c1917',
  },
  centred: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    padding:        32,
    gap:            12,
  },
  emptyTitle: {
    fontSize:   18,
    fontWeight: '600',
    color:      '#1c1917',
    textAlign:  'center',
    marginTop:  8,
  },
  emptyBody: {
    fontSize:   15,
    color:      '#78716c',
    textAlign:  'center',
    lineHeight: 22,
  },
  loadingText: {
    fontSize:  15,
    color:     '#78716c',
    textAlign: 'center',
  },

  // ── Camera overlay ──────────────────────────────────────────────────────────
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'column',
  },
  overlayBand: {
    flex:             1,
    backgroundColor:  'rgba(0,0,0,0.62)',
    alignItems:       'center',
    justifyContent:   'flex-start',
  },
  overlayMiddle: {
    flexDirection:  'row',
    alignItems:     'center',
    height:         SCAN_WINDOW_H,
  },
  overlayBandH: {
    flex:            1,
    height:          SCAN_WINDOW_H,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  scanWindow: {
    width:  SCAN_WINDOW_W,
    height: SCAN_WINDOW_H,
  },
  corner: {
    position:    'absolute',
    width:       22,
    height:      22,
    borderColor: '#fff',
    borderWidth: 3,
  },
  cornerTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0 },
  cornerTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0 },
  cornerBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0 },
  cornerBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0 },
  scanHint: {
    color:      '#fff',
    fontSize:   15,
    fontWeight: '500',
    textAlign:  'center',
    marginTop:  2,
  },
  manualFallback: {
    marginTop:     18,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius:   24,
    borderWidth:    1,
    borderColor:    'rgba(255,255,255,0.5)',
  },
  manualFallbackText: {
    color:     '#fff',
    fontSize:  14,
    fontWeight:'500',
  },
  cameraClose: {
    position: 'absolute',
    top:      0,
    left:     16,
  },

  // ── Manual entry ────────────────────────────────────────────────────────────
  manualContainer: {
    padding: 20,
    gap:     8,
  },
  manualSectionLabel: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#78716c',
    marginBottom: 6,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  input: {
    borderWidth:     1,
    borderColor:     '#e7e5e4',
    borderRadius:    10,
    paddingHorizontal: 14,
    paddingVertical:   13,
    fontSize:        16,
    color:           '#1c1917',
    backgroundColor: '#fff',
  },
  orRow: {
    flexDirection:  'row',
    alignItems:     'center',
    marginVertical: 16,
    gap:            12,
  },
  orLine: {
    flex:            1,
    height:          1,
    backgroundColor: '#e7e5e4',
  },
  orText: {
    fontSize: 13,
    color:    '#a8a29e',
  },
  manualError: {
    color:     '#b91c1c',
    fontSize:  14,
    marginTop: 4,
  },

  // ── Buttons (shared) ────────────────────────────────────────────────────────
  primaryBtn: {
    backgroundColor: '#1c1917',
    borderRadius:    12,
    paddingVertical: 15,
    alignItems:      'center',
    marginTop:       12,
  },
  primaryBtnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '600',
  },
  ghostBtn: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    paddingVertical: 12,
    marginTop:       4,
  },
  ghostBtnText: {
    color:    '#78716c',
    fontSize: 15,
  },

  // ── Result screen ────────────────────────────────────────────────────────────
  resultContainer: {
    padding:    20,
    paddingBottom: 40,
  },
  bookCard: {
    flexDirection: 'row',
    gap:           14,
    marginBottom:  20,
    backgroundColor: '#fff',
    borderRadius:  14,
    padding:       14,
    borderWidth:   1,
    borderColor:   '#e7e5e4',
  },
  cover: {
    width:        80,
    height:       116,
    borderRadius: 6,
    flexShrink:   0,
  },
  coverPlaceholder: {
    backgroundColor: '#f5f5f4',
    alignItems:      'center',
    justifyContent:  'center',
  },
  bookMeta: {
    flex:           1,
    justifyContent: 'center',
    gap:            4,
  },
  bookTitle: {
    fontSize:   16,
    fontWeight: '700',
    color:      '#1c1917',
    lineHeight: 22,
  },
  bookAuthor: {
    fontSize:  14,
    color:     '#78716c',
    marginTop: 2,
  },
  bookPages: {
    fontSize:  13,
    color:     '#a8a29e',
    marginTop: 4,
  },
  verdictSection: {
    gap: 8,
  },
  verdictQuestion: {
    fontSize:      12,
    fontWeight:    '600',
    color:         '#a8a29e',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  verdictHeadline: {
    fontSize:   22,
    fontWeight: '700',
    color:      '#1c1917',
    lineHeight: 30,
  },
  verdictRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           10,
    marginTop:     4,
  },
  verdictBadge: {
    borderRadius:      20,
    paddingHorizontal: 12,
    paddingVertical:   5,
  },
  verdictBadgeText: {
    fontSize:   13,
    fontWeight: '600',
  },
  scoreChip: {
    flexDirection: 'row',
    alignItems:    'baseline',
  },
  scoreNumber: {
    fontSize:   22,
    fontWeight: '700',
    color:      '#1c1917',
  },
  scoreSlash: {
    fontSize: 15,
    color:    '#a8a29e',
  },
  confidenceText: {
    fontSize:  13,
    color:     '#78716c',
    marginTop: 2,
  },
  divider: {
    height:          1,
    backgroundColor: '#e7e5e4',
    marginVertical:  20,
  },
  lowSignalCard: {
    flexDirection:   'row',
    backgroundColor: '#f5f5f4',
    borderRadius:    10,
    padding:         14,
    marginBottom:    16,
    alignItems:      'flex-start',
  },
  lowSignalText: {
    flex:      1,
    fontSize:  14,
    color:     '#78716c',
    lineHeight: 20,
  },
  reasonsSection: {
    gap: 12,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    gap:           10,
  },
  reasonDot: {
    width:           7,
    height:          7,
    borderRadius:    4,
    backgroundColor: '#1c1917',
    marginTop:       7,
    flexShrink:      0,
  },
  reasonText: {
    flex:      1,
    fontSize:  15,
    color:     '#1c1917',
    lineHeight: 22,
  },
  cautionCard: {
    flexDirection:   'row',
    backgroundColor: '#fffbeb',
    borderRadius:    10,
    padding:         14,
    marginTop:       14,
    alignItems:      'flex-start',
    borderWidth:     1,
    borderColor:     '#fde68a',
  },
  cautionText: {
    flex:      1,
    fontSize:  14,
    color:     '#92400e',
    lineHeight: 20,
  },
  actionsSection: {
    gap: 10,
  },
  actionBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    borderRadius:    12,
    paddingVertical: 15,
  },
  actionBtnPrimary: {
    backgroundColor: '#1c1917',
  },
  actionBtnPrimaryText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '600',
  },
  actionRowSecondary: {
    flexDirection: 'row',
    gap:           8,
  },
  actionBtnSecondary: {
    alignItems:      'center',
    justifyContent:  'center',
    borderRadius:    12,
    paddingVertical: 13,
    borderWidth:     1,
    borderColor:     '#e7e5e4',
    backgroundColor: '#fff',
  },
  actionBtnSecondaryText: {
    fontSize:   14,
    fontWeight: '500',
    color:      '#44403c',
  },
  actionConfirm: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    backgroundColor: '#f0fdf4',
    borderRadius:    12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderWidth:     1,
    borderColor:     '#bbf7d0',
  },
  actionConfirmText: {
    fontSize:   15,
    color:      '#166534',
    fontWeight: '500',
    flex:       1,
  },
  scanAnotherBtn: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    marginTop:      24,
    paddingVertical: 10,
  },
  scanAnotherText: {
    fontSize: 15,
    color:    '#78716c',
  },
});
