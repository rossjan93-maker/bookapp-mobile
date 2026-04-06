import React, { useState, useRef, useCallback } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { parseGoodreadsCSV } from '../../lib/goodreadsParser';
import { stageGoodreadsImport } from '../../lib/goodreadsStager';

// ─── Constants ────────────────────────────────────────────────────────────────

// Desktop Chrome UA — required for Goodreads export button to appear.
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GOODREADS_EXPORT_URL = 'https://www.goodreads.com/review/import';

// 30-second timeout — starts when export_page_ready fires (Method 1 attached interceptor)
const CAPTURE_TIMEOUT_MS = 30_000;

// ─── Injected JavaScript ──────────────────────────────────────────────────────
// Runs after each page load inside the WebView.
//
// Method 1 (primary): Find a[href*="review_csv"] links, attach a click
//   interceptor that calls fetch() in-page (same-origin, carries Goodreads
//   session cookies) and postMessages the CSV text back to the native layer.
//   Re-runs every 1 second to catch dynamically rendered export buttons.
//   Signals export_page_ready when at least one interceptor is attached.
//
// Method 2 (secondary): Check if this page IS the CSV (Goodreads served it
//   inline as text). Detected via "Book Id" present anywhere in innerText.
//
// onShouldStartLoadWithRequest-based native re-fetch is NOT used — it does
// not reliably carry Goodreads session cookies.

const INJECTED_JS = `
(function() {
  try {
    // Method 2 (secondary): Check if this page IS the CSV content itself.
    // Goodreads may serve the CSV inline as plain text. Detected by checking
    // whether body text CONTAINS "Book Id" (not starts-with — the header row
    // may be preceded by a BOM or whitespace).
    var bodyText = (document.body && document.body.innerText)
      ? document.body.innerText.trim()
      : '';
    if (bodyText.indexOf('Book Id') >= 0) {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'csv_captured', data: bodyText })
      );
      return; // CSV detected — no need to attach Method 1 interceptors
    }

    // Method 1 (primary): Intercept export link clicks.
    // Re-polls every 1 second to handle dynamically rendered export buttons.
    // Signals export_page_ready when at least one interceptor is attached.
    var attached = false;

    function attachInterceptors() {
      var links = document.querySelectorAll('a[href*="review_csv"]');
      if (links.length > 0 && !attached) {
        attached = true;
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'export_page_ready' })
        );
      }
      links.forEach(function(link) {
        if (!link.dataset.rnIntercepted) {
          link.dataset.rnIntercepted = '1';
          link.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            window.ReactNativeWebView.postMessage(
              JSON.stringify({ type: 'export_started' })
            );
            var url = link.href;
            fetch(url, { credentials: 'include' })
              .then(function(r) { return r.text(); })
              .then(function(text) {
                window.ReactNativeWebView.postMessage(
                  JSON.stringify({ type: 'csv_captured', data: text })
                );
              })
              .catch(function(err) {
                window.ReactNativeWebView.postMessage(
                  JSON.stringify({ type: 'capture_failed', error: String(err) })
                );
              });
          });
        }
      });
    }

    attachInterceptors();
    var pollId = setInterval(attachInterceptors, 1000);
    window.addEventListener('beforeunload', function() { clearInterval(pollId); });
  } catch(e) {
    // Never crash the page — fail silently
  }
  true;
})();
`;

// ─── State machine ────────────────────────────────────────────────────────────

type BrowserState =
  | 'idle'               // WebView shown, status strip visible, timeout not yet started
  | 'capture-detected'   // Strip: "Library detected — capturing…", WebView dimmed
  | 'parsing-staging'    // Full overlay spinner: "Staging your library…"
  | 'staging-failed'     // Full overlay: error + "Try again" + "Other options"
  | 'auto-capture-timeout' // Fallback overlay: paste + choose file
  | 'cancelled';         // router.back() called

type WebViewMsg =
  | { type: 'export_page_ready' }
  | { type: 'export_started' }
  | { type: 'csv_captured'; data: string }
  | { type: 'capture_failed'; error: string };

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function GoodreadsBrowserScreen() {
  const router = useRouter();

  const [browserState, setBrowserState] = useState<BrowserState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState('');

  // The captured CSV is held here during retry — never written to AsyncStorage
  const pendingCsvRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against double-processing (e.g. two csv_captured messages in quick succession)
  const processingRef = useRef(false);

  // ── Timer helpers ────────────────────────────────────────────────────────

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startTimeoutTimer = useCallback(() => {
    clearTimer();
    timeoutRef.current = setTimeout(() => {
      setBrowserState(prev => prev === 'idle' ? 'auto-capture-timeout' : prev);
    }, CAPTURE_TIMEOUT_MS);
  }, [clearTimer]);

  // ── Core parse → stage → batchId → route sequence ───────────────────────
  // Called from: WebView csv_captured message, paste submit, file picker.
  // The CSV text is held in memory only during this call. Never AsyncStorage.

  const processCSV = useCallback(async (csvText: string) => {
    if (processingRef.current) return;
    processingRef.current = true;
    clearTimer();

    // Save for potential retry on staging-failed
    pendingCsvRef.current = csvText;

    // (a) Transition to capture-detected immediately
    setBrowserState('capture-detected');

    try {
      // (b) Parse — validate it's a Goodreads export with at least one row
      const parseResult = parseGoodreadsCSV(csvText);

      if (!parseResult.isGoodreadsExport) {
        const msg = parseResult.parseErrors[0]?.message
          ?? 'This does not look like a Goodreads export.';
        setErrorMsg(msg);
        setBrowserState('staging-failed');
        processingRef.current = false;
        return;
      }

      if (parseResult.rows.length === 0) {
        setErrorMsg(
          'The file was recognised as a Goodreads export, but contained no readable rows. Try re-exporting from Goodreads.'
        );
        setBrowserState('staging-failed');
        processingRef.current = false;
        return;
      }

      // (c) Transition to parsing-staging before async work
      setBrowserState('parsing-staging');

      // (d) Get authenticated user
      if (!supabase) throw new Error('Supabase not configured.');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You must be signed in to import your library.');

      // (e) Stage — writes import_batches + import_rows to Supabase
      const staged = await stageGoodreadsImport(
        user.id,
        parseResult.rows,
        'goodreads_browser_transfer.csv',
      );

      // (f) Route with batchId — browser screen replaced by import screen in staged state
      router.replace({
        pathname: '/import/goodreads',
        params: { batchId: staged.batchId },
      });
      // processingRef intentionally NOT reset — we are navigating away

    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setBrowserState('staging-failed');
      processingRef.current = false;
    }
  }, [clearTimer, router]);

  // ── Navigation state change — re-arms Method 2 per navigation ───────────
  // `injectedJavaScript` runs automatically after each page load, so Method 2
  // (inline CSV detection) already executes on every navigation via the
  // injected script. This callback provides an additional native-layer signal
  // that a navigation completed, keeping the state machine in sync (e.g.
  // resetting the strip text if the user navigates away from the export page).

  const handleNavigationStateChange = useCallback(
    (navState: { url?: string }) => {
      // If the user has navigated away from a fallback or captured state back
      // to a fresh page, let the injected JS re-evaluate Method 2 and
      // Method 1 naturally. No extra action needed here beyond logging intent.
      // The injected JS fires per-load and will postMessage csv_captured or
      // export_page_ready as appropriate.
      void navState;
    },
    [],
  );

  // ── WebView message handler ──────────────────────────────────────────────

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: WebViewMsg;
    try {
      msg = JSON.parse(event.nativeEvent.data) as WebViewMsg;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'export_page_ready':
        // Method 1 has attached at least one interceptor — start the 30s timeout
        startTimeoutTimer();
        break;

      case 'export_started':
        // User tapped the export link — give immediate feedback
        setBrowserState(prev => prev === 'idle' ? 'capture-detected' : prev);
        break;

      case 'csv_captured':
        if (!processingRef.current) {
          processCSV(msg.data);
        }
        break;

      case 'capture_failed':
        // In-page fetch failed — surface fallback overlay immediately
        clearTimer();
        setBrowserState('auto-capture-timeout');
        break;
    }
  }, [startTimeoutTimer, processCSV, clearTimer]);

  // ── Retry (staging-failed state) ─────────────────────────────────────────

  const handleRetry = useCallback(() => {
    processingRef.current = false;
    setErrorMsg(null);
    const csv = pendingCsvRef.current;
    if (csv) {
      processCSV(csv);
    } else {
      setBrowserState('idle');
    }
  }, [processCSV]);

  // ── Open other options from staging-failed ────────────────────────────────

  const handleOpenOtherOptions = useCallback(() => {
    processingRef.current = false;
    setErrorMsg(null);
    setBrowserState('auto-capture-timeout');
  }, []);

  // ── Keep trying (dismisses fallback overlay, back to idle) ───────────────
  // Clears the current timer but does NOT start a new one — the 30-second
  // timeout window only opens again when `export_page_ready` fires from the
  // injected JS (i.e. when the user lands on the Goodreads export page).

  const handleKeepTrying = useCallback(() => {
    processingRef.current = false;
    setErrorMsg(null);
    setPastedText('');
    clearTimer(); // reset timer state; startTimeoutTimer runs on next export_page_ready
    setBrowserState('idle');
  }, [clearTimer]);

  // ── Cancel ───────────────────────────────────────────────────────────────

  const handleCancel = useCallback(() => {
    clearTimer();
    setBrowserState('cancelled');
    router.back();
  }, [clearTimer, router]);

  // ── Fallback: paste submit ────────────────────────────────────────────────

  const handlePasteSubmit = useCallback(async () => {
    const trimmed = pastedText.trim();
    if (trimmed.length < 10) return;
    await processCSV(trimmed);
  }, [pastedText, processCSV]);

  // ── Fallback: native file picker ──────────────────────────────────────────

  const handleChooseFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/plain', 'public.comma-separated-values-text', '*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const text = await FileSystem.readAsStringAsync(asset.uri);
      await processCSV(text);
    } catch {
      // User cancelled or error — no-op
    }
  }, [processCSV]);

  // ── Derived display values ────────────────────────────────────────────────

  const stripLabel =
    browserState === 'capture-detected'
      ? 'Library detected \u2014 capturing\u2026'
      : 'Sign in to Goodreads, then tap Export Library';

  const showSpinnerInStrip = browserState === 'capture-detected';
  const dimWebView = browserState === 'capture-detected';
  const showStagingOverlay = browserState === 'parsing-staging';
  const showFailedOverlay = browserState === 'staging-failed';
  const showFallbackOverlay = browserState === 'auto-capture-timeout';
  const isBusy = browserState === 'parsing-staging';

  return (
    <View style={styles.container}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={handleCancel}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          disabled={isBusy}
          style={styles.headerSide}
        >
          <Text style={[styles.cancelText, isBusy && styles.cancelTextDisabled]}>
            Cancel
          </Text>
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Goodreads Import</Text>

        <View style={styles.headerSide} />
      </View>

      {/* ── Status strip ── */}
      <View style={styles.strip}>
        {showSpinnerInStrip && (
          <ActivityIndicator
            size="small"
            color="#78716c"
            style={styles.stripSpinner}
          />
        )}
        <Text style={styles.stripText} numberOfLines={1}>
          {stripLabel}
        </Text>
      </View>

      {/* ── WebView — always mounted, dimmed during capture ── */}
      <View style={[styles.webViewWrap, dimWebView && styles.webViewDimmed]}>
        <WebView
          source={{ uri: GOODREADS_EXPORT_URL }}
          userAgent={DESKTOP_UA}
          injectedJavaScript={INJECTED_JS}
          onMessage={handleMessage}
          onNavigationStateChange={handleNavigationStateChange}
          sharedCookiesEnabled={Platform.OS === 'ios'}
          domStorageEnabled
          thirdPartyCookiesEnabled
          javaScriptEnabled
          style={styles.webView}
        />
      </View>

      {/* ── Overlay: parsing-staging ── */}
      {showStagingOverlay && (
        <View style={styles.overlay}>
          <ActivityIndicator size="large" color="#1c1917" style={styles.overlaySpinner} />
          <Text style={styles.overlayTitle}>Staging your library\u2026</Text>
          <Text style={styles.overlaySubtitle}>
            Matching your books and preparing the preview
          </Text>
        </View>
      )}

      {/* ── Overlay: staging-failed ── */}
      {showFailedOverlay && (
        <View style={styles.overlay}>
          <Text style={styles.overlayTitle}>Something went wrong</Text>
          {errorMsg ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          ) : null}

          <TouchableOpacity onPress={handleRetry} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Try again</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleOpenOtherOptions} style={styles.ghostBtn}>
            <Text style={styles.ghostBtnText}>Other options \u2193</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Fallback overlay: auto-capture-timeout ── */}
      {showFallbackOverlay && (
        <View style={styles.fallbackOverlay}>
          <Text style={styles.fallbackTitle}>Auto-capture didn't work</Text>
          <Text style={styles.fallbackSubtitle}>
            Paste your Goodreads export text below, or choose the downloaded CSV file.
          </Text>

          <TextInput
            value={pastedText}
            onChangeText={setPastedText}
            multiline
            placeholder="Paste your Goodreads export here\u2026"
            placeholderTextColor="#a8a29e"
            style={[
              styles.pasteInput,
              pastedText.trim().length > 0 && styles.pasteInputActive,
            ]}
          />

          <TouchableOpacity
            onPress={handlePasteSubmit}
            disabled={pastedText.trim().length < 10}
            style={[
              styles.primaryBtn,
              pastedText.trim().length < 10 && styles.primaryBtnDisabled,
            ]}
          >
            <Text
              style={[
                styles.primaryBtnText,
                pastedText.trim().length < 10 && styles.primaryBtnTextDisabled,
              ]}
            >
              Import pasted text
            </Text>
          </TouchableOpacity>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerLabel}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity onPress={handleChooseFile} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Choose CSV File</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleKeepTrying} style={styles.keepTryingBtn}>
            <Text style={styles.keepTryingText}>Keep trying in browser \u2191</Text>
          </TouchableOpacity>
        </View>
      )}

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const HEADER_TOP = Platform.OS === 'ios' ? 56 : 16;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#faf9f7',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: HEADER_TOP,
    paddingBottom: 12,
    paddingHorizontal: 16,
    backgroundColor: '#faf9f7',
    borderBottomWidth: 1,
    borderBottomColor: '#e7e5e4',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1c1917',
    letterSpacing: -0.2,
  },
  headerSide: {
    width: 60,
  },
  cancelText: {
    fontSize: 15,
    color: '#78716c',
  },
  cancelTextDisabled: {
    opacity: 0.35,
  },

  // Status strip
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f4',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e7e5e4',
  },
  stripSpinner: {
    marginRight: 8,
  },
  stripText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
    color: '#78716c',
    textAlign: 'center',
  },

  // WebView
  webViewWrap: {
    flex: 1,
  },
  webViewDimmed: {
    opacity: 0.45,
  },
  webView: {
    flex: 1,
    backgroundColor: '#ffffff',
  },

  // Full-screen overlays (parsing-staging and staging-failed)
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(250, 249, 247, 0.96)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 40,
  },
  overlaySpinner: {
    marginBottom: 24,
  },
  overlayTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1c1917',
    textAlign: 'center',
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  overlaySubtitle: {
    fontSize: 13,
    color: '#78716c',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderRadius: 10,
    padding: 14,
    marginBottom: 24,
    width: '100%',
  },
  errorText: {
    fontSize: 13,
    color: '#b91c1c',
    lineHeight: 20,
    textAlign: 'center',
  },

  // Fallback overlay (auto-capture-timeout)
  fallbackOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#faf9f7',
    paddingTop: HEADER_TOP + 48,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  fallbackTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1c1917',
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  fallbackSubtitle: {
    fontSize: 13,
    color: '#78716c',
    lineHeight: 20,
    marginBottom: 20,
  },
  pasteInput: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e7e5e4',
    padding: 14,
    fontSize: 11,
    color: '#1c1917',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    height: 110,
    textAlignVertical: 'top',
    marginBottom: 10,
  },
  pasteInputActive: {
    borderColor: '#d4a574',
  },

  // Shared buttons
  primaryBtn: {
    backgroundColor: '#1c1917',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    width: '100%',
    marginBottom: 10,
  },
  primaryBtnDisabled: {
    backgroundColor: '#f5f5f4',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  primaryBtnTextDisabled: {
    color: '#a8a29e',
  },
  secondaryBtn: {
    backgroundColor: '#f5f5f4',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    width: '100%',
    marginBottom: 10,
  },
  secondaryBtnText: {
    color: '#1c1917',
    fontSize: 14,
    fontWeight: '600',
  },
  ghostBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  ghostBtnText: {
    fontSize: 13,
    color: '#78716c',
  },
  keepTryingBtn: {
    marginTop: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  keepTryingText: {
    fontSize: 13,
    color: '#78716c',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e7e5e4',
  },
  dividerLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: '#a8a29e',
    marginHorizontal: 10,
  },
});
