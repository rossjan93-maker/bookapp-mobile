import React, { useState, useRef, useCallback, useEffect } from 'react';
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
import type { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
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

// Pattern that identifies a Goodreads CSV export URL (matches both legacy and
// current Goodreads paths). Tested against:
//   /review/export   /review/export.csv   /review/import?format=csv
//   /review_csv      /api/reviews/export  /books.csv
const CSV_URL_PATTERN = /review[/_](?:export|import|csv)|export.*\.csv|books\.csv/i;

// 30-second timeout — starts when export_page_ready fires
const CAPTURE_TIMEOUT_MS = 30_000;

// ─── Injected JavaScript ──────────────────────────────────────────────────────
//
// Comprehensive capture strategy:
//
//  LOG-1  : browser_mounted — fires on first inject (page loaded)
//  LOG-2  : nav_url — fires on every inject with current URL
//  LOG-3  : export_controls_detected — fires when any export control is found,
//            with count of links/forms/buttons discovered
//  LOG-4  : export_page_ready — fires when first interceptor is attached
//  LOG-5  : export_trigger_detected — fires when the user activates an export
//            control (click/submit)
//
// Interception strategy (broadest to narrowest):
//  A) window.fetch override — catches fetch()-initiated exports before any DOM event
//  B) window.XMLHttpRequest override — catches XHR-initiated exports
//  C) a[href*csv / href*export] — link click interception (existing)
//  D) form[action*csv / action*export] — form submit interception
//  E) buttons inside matching forms — click interception on submit buttons
//  F) Method 2 (inline) — body text contains "Book Id" = this page IS the CSV
//
// onShouldStartLoadWithRequest on the native side handles the case where
// Goodreads initiates a browser navigation / download directly (the Android
// download-manager path).

const INJECTED_JS = `
(function() {
  try {
    var _log = function(obj) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify(obj));
      } catch(_) {}
    };

    // ── LOG-1/2: mount + current URL ──────────────────────────────────────
    _log({ type: 'log', event: 'browser_mounted', url: window.location.href });

    // ── Method F (inline CSV): Check if this page IS the CSV itself ───────
    var bodyText = (document.body && document.body.innerText)
      ? document.body.innerText.trim()
      : '';
    if (bodyText.indexOf('Book Id') >= 0) {
      _log({ type: 'csv_captured', data: bodyText, source: 'inline_body' });
      return;
    }

    // ── Method A: Intercept window.fetch ──────────────────────────────────
    var _origFetch = window.fetch;
    if (_origFetch && !window.__rnFetchPatched) {
      window.__rnFetchPatched = true;
      window.fetch = function(input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        var isCsvExport = /review[\\/_](?:export|import|csv)|export.*\\.csv|books\\.csv/i.test(url);
        if (isCsvExport) {
          _log({ type: 'log', event: 'fetch_intercepted', url: url });
          return _origFetch(input, Object.assign({}, init, { credentials: 'include' }))
            .then(function(r) {
              return r.clone().text().then(function(text) {
                if (text.indexOf('Book Id') >= 0) {
                  _log({ type: 'csv_captured', data: text, source: 'fetch_intercept' });
                } else {
                  _log({ type: 'log', event: 'fetch_response_not_csv', url: url, preview: text.slice(0, 120) });
                }
                return r;
              });
            });
        }
        return _origFetch(input, init);
      };
    }

    // ── Method B: Intercept XMLHttpRequest ────────────────────────────────
    var _OrigXHR = window.XMLHttpRequest;
    if (_OrigXHR && !window.__rnXHRPatched) {
      window.__rnXHRPatched = true;
      var _XHROrig_open = _OrigXHR.prototype.open;
      var _XHROrig_send = _OrigXHR.prototype.send;
      _OrigXHR.prototype.open = function(method, url) {
        this.__rnUrl = url || '';
        return _XHROrig_open.apply(this, arguments);
      };
      _OrigXHR.prototype.send = function() {
        var isCsvExport = /review[\\/_](?:export|import|csv)|export.*\\.csv|books\\.csv/i.test(this.__rnUrl || '');
        if (isCsvExport) {
          _log({ type: 'log', event: 'xhr_intercepted', url: this.__rnUrl });
          var self = this;
          this.addEventListener('load', function() {
            var text = self.responseText || '';
            if (text.indexOf('Book Id') >= 0) {
              _log({ type: 'csv_captured', data: text, source: 'xhr_intercept' });
            }
          });
        }
        return _XHROrig_send.apply(this, arguments);
      };
    }

    // ── DOM scanning: links, forms, buttons ───────────────────────────────
    var attached = false;

    function attachInterceptors() {
      // Selector broadened: review_csv, review/export, export.csv, books.csv
      var CSV_SELECTOR = 'a[href*="review_csv"], a[href*="review/export"], a[href*="export.csv"], a[href*="books.csv"]';
      var FORM_SELECTOR = 'form[action*="review_csv"], form[action*="review/export"], form[action*="export"]';

      var links = document.querySelectorAll(CSV_SELECTOR);
      var forms = document.querySelectorAll(FORM_SELECTOR);

      var controlCount = links.length + forms.length;

      if (controlCount > 0 && !attached) {
        attached = true;
        _log({ type: 'log', event: 'export_controls_detected', links: links.length, forms: forms.length });
        _log({ type: 'export_page_ready' });
      }

      // C: anchor links
      links.forEach(function(link) {
        if (!link.dataset.rnIntercepted) {
          link.dataset.rnIntercepted = '1';
          link.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            _log({ type: 'log', event: 'export_trigger_detected', control: 'link', href: link.href });
            _log({ type: 'export_started' });
            var url = link.href;
            fetch(url, { credentials: 'include' })
              .then(function(r) { return r.text(); })
              .then(function(text) {
                _log({ type: 'csv_captured', data: text, source: 'link_click_fetch' });
              })
              .catch(function(err) {
                _log({ type: 'capture_failed', error: String(err) });
              });
          });
        }
      });

      // D/E: forms and their submit buttons
      forms.forEach(function(form) {
        if (!form.dataset.rnIntercepted) {
          form.dataset.rnIntercepted = '1';
          _log({ type: 'log', event: 'export_controls_detected', forms: 1, action: form.action });
          form.addEventListener('submit', function(e) {
            e.preventDefault();
            e.stopPropagation();
            _log({ type: 'log', event: 'export_trigger_detected', control: 'form_submit', action: form.action });
            _log({ type: 'export_started' });
            var url = form.action || window.location.href;
            fetch(url, { credentials: 'include', method: form.method || 'GET' })
              .then(function(r) { return r.text(); })
              .then(function(text) {
                _log({ type: 'csv_captured', data: text, source: 'form_submit_fetch' });
              })
              .catch(function(err) {
                _log({ type: 'capture_failed', error: String(err) });
              });
          });
          // Also intercept any submit buttons inside the form
          var submitBtns = form.querySelectorAll('button, input[type="submit"]');
          submitBtns.forEach(function(btn) {
            if (!btn.dataset.rnIntercepted) {
              btn.dataset.rnIntercepted = '1';
              btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                _log({ type: 'log', event: 'export_trigger_detected', control: 'form_button', action: form.action });
                _log({ type: 'export_started' });
                var url = form.action || window.location.href;
                fetch(url, { credentials: 'include', method: form.method || 'GET' })
                  .then(function(r) { return r.text(); })
                  .then(function(text) {
                    _log({ type: 'csv_captured', data: text, source: 'form_button_fetch' });
                  })
                  .catch(function(err) {
                    _log({ type: 'capture_failed', error: String(err) });
                  });
              });
            }
          });
        }
      });
    }

    attachInterceptors();
    var pollId = setInterval(attachInterceptors, 1000);
    window.addEventListener('beforeunload', function() { clearInterval(pollId); });
  } catch(e) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'log', event: 'injected_js_error', error: String(e) })
      );
    } catch(_) {}
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
  | { type: 'log'; event: string; [key: string]: unknown }
  | { type: 'export_page_ready' }
  | { type: 'export_started' }
  | { type: 'csv_captured'; data: string; source?: string }
  | { type: 'capture_failed'; error: string };

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function GoodreadsBrowserScreen() {
  const router = useRouter();
  const webViewRef = useRef<WebView>(null);

  const [browserState, setBrowserState] = useState<BrowserState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pastedText, setPastedText] = useState('');

  const pendingCsvRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processingRef = useRef(false);

  // ── Mount log ────────────────────────────────────────────────────────────

  useEffect(() => {
    console.log('[GoodreadsBrowser] mounted_v3 Platform.OS=' + Platform.OS);
    return () => {
      console.log('[GoodreadsBrowser] unmounted_v3');
    };
  }, []);

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

  const processCSV = useCallback(async (csvText: string, source?: string) => {
    if (processingRef.current) return;
    processingRef.current = true;
    clearTimer();

    console.log('[GoodreadsBrowser] processCSV called, source:', source ?? 'unknown', 'length:', csvText.length);

    pendingCsvRef.current = csvText;
    setBrowserState('capture-detected');

    try {
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

      setBrowserState('parsing-staging');

      if (!supabase) throw new Error('Supabase not configured.');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You must be signed in to import your library.');

      const staged = await stageGoodreadsImport(
        user.id,
        parseResult.rows,
        'goodreads_browser_transfer.csv',
      );

      console.log('[GoodreadsBrowser] staging complete, batchId:', staged.batchId);

      router.replace({
        pathname: '/import/goodreads',
        params: { batchId: staged.batchId },
      });

    } catch (err: unknown) {
      console.error('[GoodreadsBrowser] processCSV error:', err);
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setBrowserState('staging-failed');
      processingRef.current = false;
    }
  }, [clearTimer, router]);

  // ── onShouldStartLoadWithRequest ─────────────────────────────────────────
  // Android download path: Goodreads triggers a navigation / download to the
  // CSV URL instead of running through our injected click interceptor.
  // We block that navigation and re-fetch the URL from inside the WebView
  // (where the session cookie lives) by injecting a fetch() call.

  const handleShouldStartLoadWithRequest = useCallback(
    (request: WebViewNavigation): boolean => {
      const { url, navigationType } = request;
      console.log('[GoodreadsBrowser] onShouldStartLoadWithRequest', navigationType, url);

      if (CSV_URL_PATTERN.test(url)) {
        console.log('[GoodreadsBrowser] CSV URL intercepted at native layer, re-fetching in-page:', url);
        // Inject a fetch() inside the WebView so it runs with session cookies
        const escapedUrl = url.replace(/'/g, "\\'");
        webViewRef.current?.injectJavaScript(`
          (function() {
            try {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'log', event: 'native_nav_refetch', url: '${escapedUrl}'
              }));
              fetch('${escapedUrl}', { credentials: 'include' })
                .then(function(r) { return r.text(); })
                .then(function(text) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    type: 'csv_captured', data: text, source: 'native_nav_refetch'
                  }));
                })
                .catch(function(err) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    type: 'capture_failed', error: String(err)
                  }));
                });
            } catch(e) {}
          })();
          true;
        `);
        return false; // Block the native navigation / download
      }

      return true; // Allow all other navigations
    },
    [],
  );

  // ── Navigation state change ──────────────────────────────────────────────

  const handleNavigationStateChange = useCallback(
    (navState: { url?: string }) => {
      console.log('[GoodreadsBrowser] navigationStateChange url:', navState.url ?? '(none)');
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

    if (msg.type === 'log') {
      // Diagnostic instrumentation — forward to native console
      const { event: ev, ...rest } = msg;
      console.log(`[GoodreadsBrowser][webview] ${ev}`, rest);
      return;
    }

    switch (msg.type) {
      case 'export_page_ready':
        console.log('[GoodreadsBrowser] export_page_ready — starting 30s timeout');
        startTimeoutTimer();
        break;

      case 'export_started':
        console.log('[GoodreadsBrowser] export_started');
        setBrowserState(prev => prev === 'idle' ? 'capture-detected' : prev);
        break;

      case 'csv_captured':
        console.log('[GoodreadsBrowser] csv_captured, source:', (msg as { type: 'csv_captured'; data: string; source?: string }).source ?? 'unknown', 'length:', msg.data?.length);
        if (!processingRef.current) {
          processCSV(msg.data, (msg as { type: 'csv_captured'; data: string; source?: string }).source);
        }
        break;

      case 'capture_failed':
        console.warn('[GoodreadsBrowser] capture_failed:', msg.error);
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

  // ── Keep trying ──────────────────────────────────────────────────────────

  const handleKeepTrying = useCallback(() => {
    processingRef.current = false;
    setErrorMsg(null);
    setPastedText('');
    clearTimer();
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
    await processCSV(trimmed, 'paste');
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
      await processCSV(text, 'file_picker');
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

        <Text style={styles.headerTitle}>Goodreads Browser V3</Text>

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

      {/* ── DEBUG BANNER (temporary — remove after real-device verification) ── */}
      <View style={styles.debugBanner}>
        <Text style={styles.debugBannerBadge}>GR_BROWSER_V3</Text>
        <Text style={styles.debugBannerBody}>
          If you can read this, you are in the native Goodreads browser route.
        </Text>
      </View>

      {/* ── WebView — always mounted, dimmed during capture ── */}
      <View style={[styles.webViewWrap, dimWebView && styles.webViewDimmed]}>
        <WebView
          ref={webViewRef}
          source={{ uri: GOODREADS_EXPORT_URL }}
          userAgent={DESKTOP_UA}
          injectedJavaScript={INJECTED_JS}
          onMessage={handleMessage}
          onNavigationStateChange={handleNavigationStateChange}
          onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
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
          <Text style={styles.fallbackTitle}>Auto-capture didn&apos;t work</Text>
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

  // Debug banner (temporary)
  debugBanner: {
    backgroundColor: '#fef08a',
    borderBottomWidth: 1,
    borderBottomColor: '#ca8a04',
    paddingVertical: 6,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  debugBannerBadge: {
    fontSize: 11,
    fontWeight: '800',
    color: '#92400e',
    letterSpacing: 0.5,
    backgroundColor: '#fde68a',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  debugBannerBody: {
    fontSize: 11,
    color: '#78350f',
    flex: 1,
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
    minHeight: 100,
    maxHeight: 180,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  pasteInputActive: {
    borderColor: '#a8a29e',
  },
  primaryBtn: {
    backgroundColor: '#1c1917',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    width: '100%',
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryBtnDisabled: {
    opacity: 0.3,
  },
  primaryBtnText: {
    color: '#faf9f7',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  primaryBtnTextDisabled: {
    color: '#faf9f7',
  },
  ghostBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  ghostBtnText: {
    color: '#78716c',
    fontSize: 14,
    fontWeight: '500',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 12,
    width: '100%',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e7e5e4',
  },
  dividerLabel: {
    marginHorizontal: 12,
    fontSize: 12,
    color: '#a8a29e',
    fontWeight: '500',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: '#e7e5e4',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    width: '100%',
    alignItems: 'center',
    marginBottom: 10,
    backgroundColor: '#fff',
  },
  secondaryBtnText: {
    color: '#1c1917',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  keepTryingBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginTop: 4,
  },
  keepTryingText: {
    color: '#78716c',
    fontSize: 13,
    fontWeight: '500',
  },
});
