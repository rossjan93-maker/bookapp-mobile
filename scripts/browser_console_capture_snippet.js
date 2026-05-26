// =============================================================================
// browser_console_capture_snippet.js
//
// Paste-once helper for the Phase B Lens Arbitration manual capture
// (docs/operator_runbook_phase_b_capture.md). Installs a tap on console.log
// that buffers every `[LENS_ARBITRATION]`, `[COLD_START_ADJACENT]`,
// `[BOOK_EVIDENCE_C]`, and `[FINAL_GATE]` line, tags each with the active
// scenario id, and exports one combined JSON file.
//
// READ-ONLY. Wraps console.log non-destructively (original still prints).
// No network, no mutation of any app state. Survives across deck rebuilds.
//
// USAGE (in Chrome DevTools → Console, on the running `npm run web` tab):
//
//   1. Paste this entire file once. You should see:
//        [readstackCapture] installed v1
//
//   2. Before each scenario, call:
//        readstackCapture.startScenario('S0')   // baseline
//        readstackCapture.startScenario('S1')   // tone=light + light_fun
//        readstackCapture.startScenario('S2')   // palate_cleanser
//        readstackCapture.startScenario('S3')   // avoid_dark
//        readstackCapture.startScenario('S4')   // pace=fast + immersive
//
//   3. Apply the lens chip(s) per scenario, force a COLD rebuild
//      (close + reopen tab, or readstackCapture.clearCache()), wait for
//      the deck to render. The tap auto-counts emitted lines:
//        readstackCapture.status()
//      → prints how many of each log kind have landed under each scenario.
//
//   4. When all 5 scenarios are captured, download the combined file:
//        readstackCapture.export()
//      A file named `readstack_phase_b_capture_<YYYY-MM-DD>.json` will
//      download. Save it to `.local/lens_arb_logs/`.
//
//   5. (Optional safety net) If you accidentally close DevTools you can
//      still recover the buffer from the next tab open via:
//        readstackCapture.exportRaw()    → returns the JSON string.
//
// The capture window is the lifetime of the page. Hard refresh resets it
// (the wrap is reinstalled on next paste).
// =============================================================================

(function installReadstackCapture() {
  if (window.readstackCapture && window.readstackCapture.__v >= 1) {
    console.warn('[readstackCapture] already installed (v' +
      window.readstackCapture.__v + ') — re-installing');
  }

  const TAGS = ['[LENS_ARBITRATION]', '[COLD_START_ADJACENT]',
                '[BOOK_EVIDENCE_C]', '[FINAL_GATE]'];

  const state = {
    activeScenario: null,
    scenarios: {},  // { S0: { lensArb:[], coldStart:[], bookEv:[], finalGate:[], rawLines:[] }, ... }
    startedAt:  new Date().toISOString(),
  };

  function ensureBucket(id) {
    if (!state.scenarios[id]) {
      state.scenarios[id] = {
        startedAt: new Date().toISOString(),
        lensArb:   [],
        coldStart: [],
        bookEv:    [],
        finalGate: [],
        rawLines:  [],
      };
    }
    return state.scenarios[id];
  }

  // Non-destructive tap on console.log. The original is preserved and called
  // first so the operator still sees logs in the pane.
  const origLog = console.log.bind(console);
  console.log = function tappedLog(...args) {
    try {
      const first = args[0];
      if (typeof first === 'string' && TAGS.some(t => first.startsWith(t))) {
        const id = state.activeScenario;
        if (id) {
          const bucket = ensureBucket(id);
          // Reconstruct the line: tag + JSON payload (stringified).
          const tag = TAGS.find(t => first.startsWith(t));
          let payloadStr = '';
          if (args.length >= 2 && typeof args[1] === 'string') {
            // Match the recommender's `console.log('[TAG]', JSON.stringify({…}))`
            payloadStr = args[1];
          } else if (args.length === 1) {
            // branchPlanner emits as one combined string.
            payloadStr = first.slice(tag.length).trim();
          } else {
            payloadStr = args.slice(1).map(a =>
              typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
          }
          const line = `${tag} ${payloadStr}`;
          bucket.rawLines.push(line);
          if (tag === '[LENS_ARBITRATION]')   bucket.lensArb.push(line);
          if (tag === '[COLD_START_ADJACENT]') bucket.coldStart.push(line);
          if (tag === '[BOOK_EVIDENCE_C]')    bucket.bookEv.push(line);
          if (tag === '[FINAL_GATE]')         bucket.finalGate.push(line);
        }
      }
    } catch (_e) { /* never let the tap break console.log */ }
    return origLog(...args);
  };

  function startScenario(id) {
    if (!/^S[0-4]$/.test(id)) {
      origLog(`[readstackCapture] bad scenario id ${JSON.stringify(id)}; expected S0..S4`);
      return;
    }
    state.activeScenario = id;
    ensureBucket(id);
    origLog(`[readstackCapture] → active scenario: ${id} ` +
      `(buffers reset: ${state.scenarios[id].rawLines.length} prior lines preserved)`);
  }

  function status() {
    const rows = Object.keys(state.scenarios).sort().map(id => {
      const b = state.scenarios[id];
      return `  ${id}: lensArb=${b.lensArb.length}  ` +
        `coldStart=${b.coldStart.length}  bookEv=${b.bookEv.length}  ` +
        `finalGate=${b.finalGate.length}`;
    });
    origLog(
      `[readstackCapture] active=${state.activeScenario ?? '(none)'}\n` +
      (rows.length ? rows.join('\n') : '  (no scenarios captured yet)')
    );
  }

  function clearCache() {
    // Best-effort cold rebuild: clear the rec payload cache + decks from
    // AsyncStorage's web shim (localStorage). Does NOT touch reader_preferences.
    let cleared = 0;
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('@RecPayload') || k.startsWith('@RecQueue') ||
            k.startsWith('@RecDeck')    || k.includes('recPayloadCache')) {
          localStorage.removeItem(k);
          cleared++;
        }
      }
      origLog(`[readstackCapture] cleared ${cleared} cache keys; reload For You for a cold build`);
    } catch (e) {
      origLog('[readstackCapture] clearCache failed (likely RN-only build):', e);
    }
  }

  function buildExport() {
    return {
      schema:        'readstack_phase_b_capture/v1',
      capturedAt:    state.startedAt,
      exportedAt:    new Date().toISOString(),
      userAgent:     navigator.userAgent,
      activeScenario: state.activeScenario,
      scenarios:     state.scenarios,
    };
  }

  function exportRaw() { return JSON.stringify(buildExport(), null, 2); }

  function exportFile() {
    const payload = buildExport();
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(payload, null, 2)],
                          { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `readstack_phase_b_capture_${date}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    origLog(`[readstackCapture] downloaded readstack_phase_b_capture_${date}.json`);
  }

  window.readstackCapture = {
    __v: 1,
    startScenario,
    status,
    clearCache,
    export:     exportFile,
    exportRaw,
    _state:     state,  // for debugging only
  };

  origLog('[readstackCapture] installed v1 — call readstackCapture.startScenario("S0") to begin');
})();
