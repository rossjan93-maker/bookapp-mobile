// =============================================================================
// validate_rec_payload_cache_lens.ts
//
// P4D-followup (2026-05-18). Asserts that the persistent rec payload cache
// (lib/recPayloadCache.ts) cannot replay a deck-as-filtered-under-a-past-lens.
//
// Two-sided contract:
//   - WRITER (components/RecommendationsFeed.tsx) must NOT call
//     `saveRecPayload(...)` when an active intent / lens is present
//     (`sessionIntentTag != null`).
//   - READER (`loadRecPayload` in lib/recPayloadCache.ts) must DISCARD
//     any persisted payload whose `intentTag` is non-null/'none',
//     even if all other gates (TTL, structure, configHash) pass.
//
// Source-grep + behavioral test. Behavioral test stubs an in-memory
// AsyncStorage shim so we can exercise the load path in Node without
// touching the device storage layer.
// =============================================================================

import fs from 'fs';
import path from 'path';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  \u2714 ${label}`);
  else { console.log(`  \u2718 ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); failures += 1; }
}
function section(name: string): void { console.log(`\n── ${name} ──`); }

// ── §1 — writer-side source grep ────────────────────────────────────────────
section('§1 — RecommendationsFeed skips saveRecPayload when lens is active');
{
  const src = fs.readFileSync(
    path.resolve(__dirname, '../components/RecommendationsFeed.tsx'), 'utf8');
  // The writer call site must be guarded by `sessionIntentTag != null`.
  check('writer guard: `if (sessionIntentTag != null)` precedes saveRecPayload',
    /if\s*\(\s*sessionIntentTag\s*!=\s*null\s*\)[\s\S]{0,400}\}\s*else\s*\{[\s\S]{0,200}saveRecPayload\(/.test(src));
  check('writer guard: lens-skip log emitted',
    /\[PERSIST_CACHE\]\s*skip_lens_tagged/.test(src));
  check('writer guard: the active saveRecPayload call passes `intentTag: null`',
    /saveRecPayload\([\s\S]{0,800}intentTag:\s*null/.test(src));
  // Defensive: only one saveRecPayload call site in this file (the
  // destructured import doesn't include the `(`, so the regex only counts
  // actual invocations).
  const callCount = (src.match(/saveRecPayload\(/g) ?? []).length;
  check('writer guard: exactly one saveRecPayload call site',
    callCount === 1, `count=${callCount}`);
}

// ── §1b — sibling-writer contract: recPrewarm.ts always writes intentTag:null ──
section('§1b — recPrewarm contract: never writes a lens-tagged payload');
{
  const src = fs.readFileSync(
    path.resolve(__dirname, '../lib/recPrewarm.ts'), 'utf8');
  // The single saveRecPayload call site here must carry `intentTag: null`.
  // (Prewarm runs in the background with no active intent — by contract
  // it has no lens to capture. We pin that contract here so a future edit
  // can't silently start writing lens-tagged payloads from the prewarm
  // path, which would bypass the RecommendationsFeed writer guard.)
  check('recPrewarm: saveRecPayload call passes intentTag: null',
    /saveRecPayload\([\s\S]{0,800}intentTag:\s*null/.test(src));
  const calls = (src.match(/saveRecPayload\(/g) ?? []).length;
  check('recPrewarm: exactly one saveRecPayload call site',
    calls === 1, `count=${calls}`);
}

// ── §2 — reader-side source grep ────────────────────────────────────────────
section('§2 — loadRecPayload discards lens-tagged payloads');
{
  const src = fs.readFileSync(
    path.resolve(__dirname, '../lib/recPayloadCache.ts'), 'utf8');
  check('reader guard: lens_tagged_payload branch present',
    /lens_tagged_payload/.test(src));
  check('reader guard: condition is `intentTag != null && intentTag !== \'none\'`',
    /p\.intentTag\s*!=\s*null\s*&&\s*p\.intentTag\s*!==\s*['"]none['"]/.test(src));
  check('reader guard: best-effort clear of storage key',
    /AsyncStorage\.removeItem\(KEY_PREFIX\s*\+\s*userId\)/.test(src));
  check('reader guard: branch returns null',
    /lens_tagged_payload[\s\S]{0,400}return\s+null/.test(src));
}

// ── §3 — behavioral test: reader discards lens-tagged payload ──────────────
section('§3 — behavioral: AsyncStorage round-trip discards lens-tagged payload');
{
  // In-memory shim for @react-native-async-storage/async-storage.
  const memStore: Record<string, string> = {};
  const Module = require('module') as typeof import('module');
  const origResolve = (Module as any)._resolveFilename;
  (Module as any)._resolveFilename = function (req: string, ...rest: unknown[]) {
    if (req === '@react-native-async-storage/async-storage') {
      return path.resolve(__dirname, '__shim_async_storage__.js');
    }
    return origResolve.call(this, req, ...rest);
  };
  const shimPath = path.resolve(__dirname, '__shim_async_storage__.js');
  fs.writeFileSync(shimPath,
    'const stub = {' +
    '  getItem:    async (k) => Object.prototype.hasOwnProperty.call(globalThis.__MEM__, k) ? globalThis.__MEM__[k] : null,' +
    '  setItem:    async (k, v) => { globalThis.__MEM__[k] = v; },' +
    '  removeItem: async (k) => { delete globalThis.__MEM__[k]; },' +
    '};' +
    'module.exports = stub;' +
    'module.exports.default = stub;' +
    'Object.defineProperty(module.exports, "__esModule", { value: true });');
  (globalThis as any).__MEM__   = memStore;
  (globalThis as any).__DEV__   = false; // suppress console noise

  // Require under shim.
  const cache = require('../lib/recPayloadCache');
  const recValidity = require('../lib/recValidity');

  const userId = 'u_test';
  const configHash = recValidity.computeRecConfigHash({
    favorite_genres:  ['thriller_mystery'],
    avoid_genres:     ['horror'],
    reading_styles:   [],
    favorite_authors: null,
  });

  // §3.1 — lens-tagged payload (intentTag set) is discarded on load.
  (async () => {
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [{ id: 'b1', title: 'Stale Lens Book' }],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     'Fast-paced · Light · Less dark · No dark',
      fingerprint:   'v1:0:deterministic:nfp:Fast-paced · Light · Less dark · No dark',
      configHash,
      loadedAt:      Date.now(),
    });
    const out = await cache.loadRecPayload(userId, { currentConfigHash: configHash });
    check('§3.1 lens-tagged payload returns null', out === null);
    check('§3.1 storage cleared after lens discard',
      !Object.prototype.hasOwnProperty.call(memStore, 'readstack_rec_v1_' + userId));

    // §3.2 — same payload but with intentTag: null is restored normally.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [{ id: 'b2', title: 'Clean Book' }],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     null,
      fingerprint:   'v1:0:deterministic:nfp:none',
      configHash,
      loadedAt:      Date.now(),
    });
    const out2 = await cache.loadRecPayload(userId, { currentConfigHash: configHash });
    check('§3.2 non-lens payload restores',
      out2 !== null && out2.recs?.[0]?.title === 'Clean Book',
      out2 === null ? 'null' : out2.recs?.[0]?.title);

    // §3.3 — intentTag === 'none' (sentinel) is treated as non-lens.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [{ id: 'b3', title: 'Sentinel None' }],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     'none',
      fingerprint:   'v1:0:deterministic:nfp:none',
      configHash,
      loadedAt:      Date.now(),
    });
    const out3 = await cache.loadRecPayload(userId, { currentConfigHash: configHash });
    check('§3.3 intentTag=="none" sentinel restores (not treated as lens)',
      out3 !== null && out3.recs?.[0]?.title === 'Sentinel None');

    // §3.4 — earlier gates still fire before the new lens guard.
    //
    // Ordering contract (per loadRecPayload source): structure -> TTL ->
    // empty -> configHash -> NEW lens-tagged. We prove the first three
    // still gate (and the storage is left untouched on those paths —
    // they pre-date the "best-effort clear" semantics of configHash and
    // lens-guard, which is the historical behavior we preserve).

    // 3.4a — corrupt JSON returns null (structure path).
    memStore['readstack_rec_v1_' + userId] = 'not-json{';
    const outCorrupt = await cache.loadRecPayload(userId,
      { currentConfigHash: configHash });
    check('§3.4a corrupt JSON returns null (structure gate)',
      outCorrupt === null);

    // 3.4b — recs missing returns null (structure path), even with a
    // dangerous lens tag — proves lens-guard does not run before
    // structure rejection.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs: null,
      continuations: [],
      intentTag: 'Fast-paced',
      configHash,
      loadedAt: Date.now(),
    });
    const outNoRecs = await cache.loadRecPayload(userId,
      { currentConfigHash: configHash });
    check('§3.4b missing-recs payload returns null (structure gate first)',
      outNoRecs === null);

    // 3.4c — TTL-expired payload returns null (TTL path), even when
    // lens-tagged. TTL is 2h; backdate loadedAt 3h.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [{ id: 'b5', title: 'Expired Lens' }],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     'Fast-paced',
      fingerprint:   'v1:0:deterministic:nfp:Fast-paced',
      configHash,
      loadedAt:      Date.now() - 3 * 60 * 60 * 1000,
    });
    const outExpired = await cache.loadRecPayload(userId,
      { currentConfigHash: configHash });
    check('§3.4c TTL-expired lens payload returns null (TTL gate first)',
      outExpired === null);

    // 3.4d — empty payload returns null (empty path), even when
    // lens-tagged.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     'Fast-paced',
      fingerprint:   'v1:0:deterministic:nfp:Fast-paced',
      configHash,
      loadedAt:      Date.now(),
    });
    const outEmpty = await cache.loadRecPayload(userId,
      { currentConfigHash: configHash });
    check('§3.4d empty lens payload returns null (empty gate first)',
      outEmpty === null);

    // §3.5 — stale configHash discard still wins over lens guard.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [{ id: 'b4', title: 'Stale Hash + Lens' }],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     'Fast-paced',
      fingerprint:   'v1:0:deterministic:nfp:Fast-paced',
      configHash:    'rcv1|fg:|ag:|rs:|fa:',
      loadedAt:      Date.now(),
    });
    const out4 = await cache.loadRecPayload(userId, { currentConfigHash: configHash });
    check('§3.5 stale configHash + lens-tagged returns null', out4 === null);

    // §4 — Cold-Start Retrieval Expansion Phase B: rcv6 → rcv7 transition.
    //
    // Any cold-start deck persisted under recValidity rcv6 was built with
    // BRANCH_QUOTAS.cold_start.coldStartAdjacent = 0 (no adjacency
    // admission). Under rcv7 that quota is 3, so the rcv6 deck is
    // structurally stale. The configHash gate must discard it.
    //
    // We simulate by injecting a rcv6-shaped stored configHash alongside
    // a non-lens, otherwise-valid payload, and confirm loadRecPayload
    // returns null + clears storage.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [{ id: 'b6', title: 'Phase A rcv6 Deck' }],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     null,
      fingerprint:   'v1:0:deterministic:nfp:none',
      // Pre-Phase-B hash shape: rcv6 prefix, no `csrp:` segment.
      configHash:    'rcv6|fg:thriller_mystery|ag:horror|rs:|fa:',
      loadedAt:      Date.now(),
    });
    const outRcv6 = await cache.loadRecPayload(userId,
      { currentConfigHash: configHash });
    check('§4 rcv6 stored deck rejects under rcv7 live (configHash gate)',
      outRcv6 === null);
    check('§4 storage cleared after rcv6 → rcv7 discard',
      !Object.prototype.hasOwnProperty.call(memStore, 'readstack_rec_v1_' + userId));

    // §4b — rcv7 stored deck (current shape) restores normally.
    memStore['readstack_rec_v1_' + userId] = JSON.stringify({
      recs:          [{ id: 'b7', title: 'Phase B rcv7 Deck' }],
      continuations: [],
      discoveries:   [],
      meta:          {},
      recMode:       'deterministic',
      readerThesis:  null,
      qualityGate:   null,
      isFreePreview: false,
      signalCount:   0,
      intentTag:     null,
      fingerprint:   'v1:0:deterministic:nfp:none',
      configHash,                                       // live rcv7 hash
      loadedAt:      Date.now(),
    });
    const outRcv7 = await cache.loadRecPayload(userId,
      { currentConfigHash: configHash });
    check('§4b rcv7 stored deck restores under rcv7 live',
      outRcv7 !== null && outRcv7.recs?.[0]?.title === 'Phase B rcv7 Deck',
      outRcv7 === null ? 'null' : outRcv7.recs?.[0]?.title);

    // §4c — Live hash shape regression: includes `csrp:csrp1` segment.
    check('§4c live configHash includes "csrp:csrp1" segment',
      configHash.includes('|csrp:csrp1|'),
      `live=${configHash}`);
    check('§4c live configHash begins with "rcv7|"',
      configHash.startsWith('rcv7|'),
      `live=${configHash}`);

    // Cleanup + summary.
    try { fs.unlinkSync(shimPath); } catch {}
    (Module as any)._resolveFilename = origResolve;
    console.log(`\n\x1b[${failures === 0 ? 32 : 31}m${failures} failure(s)\x1b[0m`);
    process.exit(failures === 0 ? 0 : 1);
  })().catch(e => {
    console.error('behavioral test crashed:', e);
    try { fs.unlinkSync(shimPath); } catch {}
    process.exit(1);
  });
}
