// =============================================================================
// scripts/validate_intent_final_gate.ts — Intent Lens Eligibility Stabilization
//
// Pins the final visible-deck safety-gate contract introduced by
// lib/intent/finalGate.ts. Exit 0 = green. Any failure prints the failing
// assertion + a short remediation hint.
//
// The product invariant under test:
//   If `evaluateBookAgainstIntentLens` returns a hardExclusion for a book
//   under the active Your-Next-Read lens, that book MUST NOT render —
//   regardless of which upstream producer path delivered it.
//
// Sections (10, per the chapter spec):
//   §1  inactive intent → input shallow-copied, removed=[], diagnostics=null
//   §2  No-dark removes all canonical dark fixtures
//   §3  Less-dark NEVER hard-removes the same fixtures
//   §4  cozy mystery + Thursday Murder Club stay eligible under No-dark
//   §5  unknown-evidence books stay eligible under No-dark
//   §6  relative order of kept books preserved (single forward filter)
//   §7  CATCH TEST — queue-boundary integration: initQueue + appendToQueue
//       drop a hard-excluded book from getVisibleStack() across all 4 sources
//   §8  cache boundary compose — lens-tagged persisted payloads do not
//       restore (cross-validator pin to validate_rec_payload_cache_lens)
//   §9  source-grep — finalGate.ts and the queue plumbing do not reference
//       RecCard / composer / explanation copy
//   §10 fixture-matrix conformance — gate survivor set matches evaluator
//       prediction across the 11-fixture matrix x 4-lens grid
// =============================================================================

import {
  applyFinalIntentEligibility,
  formatFinalGateLog,
  type FinalGateSource,
} from '../lib/intent/finalGate';
import {
  evaluateBookAgainstIntentLens,
  type NextReadIntent,
} from '../lib/nextReadIntent';
import type { MarketPosition } from '../lib/fitClassifier';
import {
  initQueue,
  appendToQueue,
  getVisibleStack,
  clearAll,
  initForUser,
  type QueueEntry,
} from '../lib/recQueue';
import * as fs from 'fs';
import * as path from 'path';

// React Native's __DEV__ global is undefined in Node — stub it so the queue
// plumbing's DEV-only diagnostics path is exercised under the validator.
(globalThis as any).__DEV__ = (globalThis as any).__DEV__ ?? true;

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}
function ok(msg: string)     { console.log(`  ✓ ${msg}`); }
function header(t: string)   { console.log(`\n${t}`); }

// ── Fixture book shape (validator-only; titles are fixtures, not product) ────
type FixtureBook = {
  id:             string;
  external_id:    string;
  title:          string;
  subjects:       string[];
  description:    string;
  marketPosition: MarketPosition;
  expect: {
    noDarkHardExclude:    boolean;
    lessDarkHardExclude:  boolean;   // must always be false (rule: less-dark never hard)
  };
};

// Mirrors the §10 fixture matrix in validate_intent_lens but with the
// market-position fixed so the gate doesn't depend on classifyMarketPosition
// drift. Titles appear here ONLY as validator fixtures — never as product
// blacklists.
const FIXTURES: FixtureBook[] = [
  {
    id: 'fx-gg', external_id: 'olid:gg', title: 'Gone Girl',
    subjects: ['Thriller', 'Mystery', 'Suspense', 'Psychological fiction', 'Crime fiction', 'Domestic suspense'],
    description: 'A wife disappears on the morning of the couple\'s fifth wedding anniversary.',
    marketPosition: 'domestic_suspense',
    expect: { noDarkHardExclude: true, lessDarkHardExclude: false },
  },
  {
    id: 'fx-sp', external_id: 'olid:sp', title: 'The Silent Patient',
    subjects: ['Fiction, psychological', 'Fiction, thrillers', 'Family violence', 'Psychotherapy patients'],
    description: 'A psychotherapist treats a famous painter who has stopped speaking after murdering her husband.',
    marketPosition: 'domestic_suspense',
    expect: { noDarkHardExclude: true, lessDarkHardExclude: false },
  },
  {
    id: 'fx-ve', external_id: 'olid:ve', title: 'Verity',
    subjects: ['Psychological fiction', 'Suspense fiction', 'Thrillers (Fiction)', 'Romance fiction', 'Romantic suspense fiction'],
    description: 'A struggling writer accepts a job to finish the remaining books in a successful series.',
    marketPosition: 'domestic_suspense',
    expect: { noDarkHardExclude: true, lessDarkHardExclude: false },
  },
  {
    id: 'fx-sh', external_id: 'olid:sh', title: 'The Secret History',
    subjects: ['Murder', 'Classical philology', 'Friendship', 'Vermont', 'College students', 'Bildungsromans', 'Literary fiction'],
    description: 'Under the influence of their charismatic classics professor, a group of clever, eccentric misfits at an elite New England college discover a way of thinking and living that is a world away from the humdrum existence of their contemporaries.',
    marketPosition: 'literary_prestige',
    expect: { noDarkHardExclude: false, lessDarkHardExclude: false },
  },
  {
    id: 'fx-tmc', external_id: 'olid:tmc', title: 'The Thursday Murder Club',
    subjects: ['mystery', 'cozy mystery', 'detective', 'crime fiction', 'mystery fiction'],
    description: 'Four unlikely friends meet weekly to investigate cold cases.',
    marketPosition: 'cozy_detective',
    expect: { noDarkHardExclude: false, lessDarkHardExclude: false },
  },
  {
    id: 'fx-ein', external_id: 'olid:ein', title: 'Everything I Never Told You',
    subjects: ['grief', 'drowning', 'literary fiction', 'psychological fiction', 'family secrets', 'mothers and daughters'],
    description: 'Lydia is dead. But they don\'t know this yet. A literary family novel about the weight of expectations.',
    marketPosition: 'literary_prestige',
    expect: { noDarkHardExclude: false, lessDarkHardExclude: false },
  },
  {
    id: 'fx-romance', external_id: 'olid:rom', title: 'Pure Romance Control',
    subjects: ['Romance', 'Romantic comedy', 'Fiction'],
    description: 'A heartwarming meet-cute that becomes a slow-burn workplace romance.',
    marketPosition: 'romance',
    expect: { noDarkHardExclude: false, lessDarkHardExclude: false },
  },
  {
    id: 'fx-cozy', external_id: 'olid:cozy', title: 'Cozy Mystery Control',
    subjects: ['cozy mystery', 'amateur detective', 'humorous fiction'],
    description: 'A village baker solves a small-town whodunit between cake orders.',
    marketPosition: 'cozy_detective',
    expect: { noDarkHardExclude: false, lessDarkHardExclude: false },
  },
  {
    id: 'fx-ds', external_id: 'olid:ds', title: 'Domestic Suspense Control',
    subjects: ['Domestic suspense', 'Psychological thriller', 'Suspense'],
    description: 'A wife begins to suspect her husband has a second life.',
    marketPosition: 'domestic_suspense',
    expect: { noDarkHardExclude: true, lessDarkHardExclude: false },
  },
  {
    id: 'fx-darklit', external_id: 'olid:dl', title: 'Dark Literary Control',
    subjects: ['Literary fiction', 'dark themes', 'family violence'],
    description: 'A spare, devastating novel about generational silence.',
    marketPosition: 'literary_prestige',
    expect: { noDarkHardExclude: true, lessDarkHardExclude: false },
  },
  {
    id: 'fx-heavy-nondark', external_id: 'olid:hnd', title: 'Emotionally Heavy Non-Dark Control',
    subjects: ['grief', 'loss', 'family', 'memoir'],
    description: 'A widow rebuilds her life one quiet observation at a time.',
    marketPosition: 'memoir_nonfiction',
    expect: { noDarkHardExclude: false, lessDarkHardExclude: false },
  },
];

// Lens fixtures
const NO_INTENT:        null            = null;
const EMPTY_INTENT:     NextReadIntent  = { hard: {}, soft: {}, exclude: {} };
const NO_DARK_LENS:     NextReadIntent  = { hard: {}, soft: {}, exclude: { avoid_dark: true } };
const LESS_DARK_LENS:   NextReadIntent  = { hard: {}, soft: { intensity: 'low' }, exclude: {} };
const UNKNOWN_LENS:     NextReadIntent  = { hard: {}, soft: {}, exclude: { avoid_classics: true } };

// Projector that pins market_position deterministically per fixture (so the
// gate's behavior is decoupled from classifyMarketPosition drift inside this
// validator). Production paths use the default classifyMarketPosition resolver.
const projectBook = (b: FixtureBook) => b;
const marketPosOf = (b: FixtureBook) => b.marketPosition;

function runGate(recs: FixtureBook[], intent: NextReadIntent | null, source: FinalGateSource = 'initQueue_fresh') {
  return applyFinalIntentEligibility({ recs, intent, source, projectBook, marketPosOf });
}

// ── §1 inactive intent → input shallow-copied, removed=[], diagnostics=null ─
header('§1 inactive intent → input shallow-copied, removed=[], diagnostics=null');
{
  // intent=null
  {
    const out = runGate(FIXTURES, NO_INTENT);
    if (out.removed.length !== 0)                  fail('§1 intent=null must return removed=[]');
    if (out.diagnostics !== null)                  fail('§1 intent=null must return diagnostics=null');
    if (out.kept.length !== FIXTURES.length)       fail('§1 intent=null must return all input items');
    if (out.kept === (FIXTURES as any))            fail('§1 intent=null must return a copy, not the input reference (mutation hazard)');
    // Mutation proof: mutating out.kept must NOT mutate FIXTURES.
    const snapshot = FIXTURES.map(f => f.id);
    out.kept.pop();
    if (FIXTURES.map(f => f.id).join('|') !== snapshot.join('|'))
      fail('§1 mutating returned kept[] mutated the input — gate must return a shallow copy');
    ok('intent=null returns shallow copy with removed=[] / diagnostics=null');
  }
  // empty intent (all branches false → isIntentActive=false)
  {
    const out = runGate(FIXTURES, EMPTY_INTENT);
    if (out.removed.length !== 0)            fail('§1 empty intent must return removed=[]');
    if (out.diagnostics !== null)            fail('§1 empty intent must return diagnostics=null');
    if (out.kept.length !== FIXTURES.length) fail('§1 empty intent must return all input items');
    ok('empty intent (no chips) treated as inactive');
  }
}

// ── §2 No-dark removes all canonical dark fixtures ───────────────────────────
header('§2 No-dark removes all canonical dark fixtures');
{
  const out = runGate(FIXTURES, NO_DARK_LENS);
  for (const fx of FIXTURES) {
    if (fx.expect.noDarkHardExclude && out.kept.includes(fx)) {
      fail(`§2 ${fx.title} must be hard-excluded under No-dark but survived final gate`);
    }
  }
  // Architect-driven cross-validation: every removed fixture must be one we
  // explicitly expected to remove. Catches over-removal.
  for (const removed of out.removed) {
    const fx = removed as FixtureBook;
    if (!fx.expect.noDarkHardExclude) {
      fail(`§2 over-removal — ${fx.title} was excluded but the fixture matrix marks it eligible under No-dark`);
    }
  }
  if (!out.diagnostics || out.diagnostics.removedCount === 0)
    fail('§2 expected diagnostics.removedCount > 0 with the dark-fixture set');
  ok(`removed ${out.removed.length} dark fixtures, kept ${out.kept.length} eligible`);
  ok('no over-removal of eligible fixtures');
}

// ── §3 Less-dark NEVER hard-removes ──────────────────────────────────────────
header('§3 Less-dark NEVER hard-removes (rule: bounded demotion, not exclusion)');
{
  const out = runGate(FIXTURES, LESS_DARK_LENS);
  if (out.removed.length !== 0) {
    const titles = out.removed.map(r => (r as FixtureBook).title).join(', ');
    fail(`§3 Less-dark must never hard-remove. Removed: ${titles}`);
  }
  if (out.kept.length !== FIXTURES.length)
    fail('§3 Less-dark kept count must equal input count');
  ok('Less-dark produced zero hard removals across the full fixture matrix');
}

// ── §4 cozy mystery + Thursday Murder Club remain eligible under No-dark ────
header('§4 cozy mystery / Thursday Murder Club remain eligible under No-dark');
{
  const out = runGate(FIXTURES, NO_DARK_LENS);
  const tmc  = FIXTURES.find(f => f.id === 'fx-tmc')!;
  const cozy = FIXTURES.find(f => f.id === 'fx-cozy')!;
  if (!out.kept.includes(tmc))  fail('§4 Thursday Murder Club must remain eligible under No-dark');
  if (!out.kept.includes(cozy)) fail('§4 Cozy Mystery Control must remain eligible under No-dark');
  ok('Thursday Murder Club + cozy control survive No-dark');
}

// ── §5 unknown-evidence books remain eligible ───────────────────────────────
header('§5 unknown-evidence books remain eligible under No-dark');
{
  // Build a synthetic unknown book — no specific dark evidence, no
  // domestic_suspense market position. Must survive No-dark.
  const unknown: FixtureBook = {
    id: 'fx-unknown', external_id: 'olid:unk', title: 'Unknown Evidence Control',
    subjects: ['fiction', 'novel'],
    description: 'A book about life.',
    marketPosition: 'mainstream_fiction' as MarketPosition,
    expect: { noDarkHardExclude: false, lessDarkHardExclude: false },
  };
  const out = runGate([unknown], NO_DARK_LENS);
  if (out.removed.length !== 0)
    fail('§5 unknown-evidence book was hard-removed — rule: do not hard-exclude on unknown');
  ok('book with no specific dark evidence remains eligible under No-dark');
}

// ── §6 relative order preserved ──────────────────────────────────────────────
header('§6 relative order of kept books preserved (single forward filter)');
{
  // Permute the fixture order; survivors must come out in the same relative order.
  const permuted = [
    FIXTURES.find(f => f.id === 'fx-cozy')!,
    FIXTURES.find(f => f.id === 'fx-gg')!,
    FIXTURES.find(f => f.id === 'fx-ein')!,
    FIXTURES.find(f => f.id === 'fx-sp')!,
    FIXTURES.find(f => f.id === 'fx-tmc')!,
    FIXTURES.find(f => f.id === 'fx-romance')!,
  ];
  const out = runGate(permuted, NO_DARK_LENS);
  const expectedSurvivors = permuted
    .filter(f => !f.expect.noDarkHardExclude)
    .map(f => f.id);
  const actualSurvivors = out.kept.map(k => (k as FixtureBook).id);
  if (actualSurvivors.join('|') !== expectedSurvivors.join('|')) {
    fail(`§6 order mismatch. expected=${expectedSurvivors.join(',')} actual=${actualSurvivors.join(',')}`);
  }
  ok('survivor order matches input order exactly');
}

// ── §7 CATCH TEST — queue-boundary integration ───────────────────────────────
header('§7 CATCH TEST — initQueue + appendToQueue drop hard-excluded books');
{
  const ALL_SOURCES: FinalGateSource[] = [
    'initQueue_cold_restore',
    'initQueue_fresh',
    'append_into_existing',
    'append_background',
    'append_exhaustion',
  ];

  // Build queue entries that mirror the QueueEntry shape recQueue expects.
  // We attach our deterministic marketPosition via a non-enumerable field —
  // the production gate uses classifyMarketPosition by default; here we
  // verify the wiring by feeding entries that ALSO trigger phrasal hits
  // (Silent Patient has 'family violence' + 'psychotherapy patients' which
  // are phrasal-specific DARK_SIGNALS hits, independent of marketPos).
  const goneGirlEntry: QueueEntry = {
    book: {
      id: 'qe-gg', external_id: 'olid:qegg', title: 'The Silent Patient',
      subjects: ['Fiction, psychological', 'Fiction, thrillers', 'Family violence', 'Psychotherapy patients'],
      description: 'A psychotherapist treats a famous painter who has stopped speaking after murdering her husband.',
    } as any,
    bucket: 'discoveries',
  };
  const cozyEntry: QueueEntry = {
    book: {
      id: 'qe-cozy', external_id: 'olid:qecozy', title: 'Cozy Mystery Control',
      subjects: ['cozy mystery', 'amateur detective', 'humorous fiction'],
      description: 'A village baker solves a small-town whodunit between cake orders.',
    } as any,
    bucket: 'discoveries',
  };

  for (const src of ALL_SOURCES) {
    // Fresh user-scope per source so each iteration starts clean.
    initForUser(`fixture-user-${src}`, []);
    clearAll();

    if (src.startsWith('initQueue')) {
      initQueue([goneGirlEntry, cozyEntry], 'cfg-test', NO_DARK_LENS, src, 'No dark');
    } else {
      // append paths require initial state — seed empty queue with init first.
      initQueue([], 'cfg-test', NO_DARK_LENS, 'initQueue_fresh', 'No dark');
      appendToQueue([goneGirlEntry, cozyEntry], NO_DARK_LENS, src, 'No dark');
    }
    const visible = getVisibleStack();
    const visibleTitles = visible.map(e => e.book.title);
    if (visibleTitles.includes('The Silent Patient')) {
      fail(`§7 (${src}) hard-excluded book leaked into getVisibleStack(): ${JSON.stringify(visibleTitles)}`);
    }
    if (!visibleTitles.includes('Cozy Mystery Control')) {
      fail(`§7 (${src}) eligible cozy was over-removed: ${JSON.stringify(visibleTitles)}`);
    }
    ok(`source=${src}: hard-excluded blocked, eligible preserved`);
  }

  // Sentinel: passing intent=null on the queue boundary must restore old
  // behavior (no gate, everything is eligible per the upstream filters).
  initForUser('fixture-user-null', []);
  clearAll();
  initQueue([goneGirlEntry, cozyEntry], 'cfg-test', null, 'initQueue_fresh', null);
  const nullVisible = getVisibleStack().map(e => e.book.title);
  if (!nullVisible.includes('The Silent Patient')) {
    fail('§7 sentinel — intent=null at queue boundary must NOT filter (legacy behavior preserved)');
  }
  ok('intent=null at queue boundary preserves legacy non-filtering behavior');
}

// ── §8 cache-boundary compose with prior batch ───────────────────────────────
header('§8 cache boundary — lens-tagged persisted payloads do not restore');
{
  // Cross-validator pin: validate_rec_payload_cache_lens already exercises
  // the reader + writer guards for lens-tagged AsyncStorage payloads. This
  // section asserts the file is present and references the lens-tag guard,
  // so a future refactor that removes the cache-boundary guard can't pass
  // the gate-only validator without also breaking the cache-lens validator.
  const cacheLensValidatorPath = path.resolve(__dirname, 'validate_rec_payload_cache_lens.ts');
  if (!fs.existsSync(cacheLensValidatorPath))
    fail('§8 expected sibling validator scripts/validate_rec_payload_cache_lens.ts to exist');
  const cacheReader = fs.readFileSync(path.resolve(__dirname, '../lib/recPayloadCache.ts'), 'utf8');
  if (!/intentTag/.test(cacheReader))
    fail('§8 lib/recPayloadCache.ts must reference intentTag (lens-discard guard)');
  ok('cache-boundary lens-discard guard present (cross-pinned to validate_rec_payload_cache_lens)');
}

// ── §9 source-grep — no RecCard / composer / explanation references ──────────
header('§9 source-grep — finalGate.ts is composer-free');
{
  const finalGateSrc = fs.readFileSync(path.resolve(__dirname, '../lib/intent/finalGate.ts'), 'utf8');
  // Strip line + block comments so the isolation-prose in the module header
  // doesn't false-positive against pattern words it explains the absence of.
  const finalGateCode = finalGateSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bRecCard\b/,                  'RecCard component'],
    [/composeRecommendation/i,       'composer entry point'],
    [/book\.reasons/,                'reasons[] mutation'],
    [/from\s+['"][^'"]*explanation/, 'explanation module import'],
    [/from\s+['"][^'"]*compose/,     'composer module import'],
  ];
  for (const [pat, label] of forbiddenPatterns) {
    if (pat.test(finalGateCode)) {
      fail(`§9 lib/intent/finalGate.ts must not reference ${label} (matched ${pat})`);
    }
  }
  // recQueue plumbing — must import the gate but must not reach into composer.
  const queueSrc = fs.readFileSync(path.resolve(__dirname, '../lib/recQueue.ts'), 'utf8');
  if (!/applyFinalIntentEligibility/.test(queueSrc))
    fail('§9 lib/recQueue.ts must import applyFinalIntentEligibility');
  if (/RecCard|composeRecommendation|book\.reasons/.test(queueSrc))
    fail('§9 lib/recQueue.ts must not touch RecCard / composer / reasons');
  ok('finalGate.ts + recQueue.ts isolated from RecCard / composer / explanation copy');
}

// ── §10 fixture-matrix conformance — gate ≡ evaluator on hardExclusion ──────
header('§10 fixture-matrix conformance — gate ≡ evaluator on hardExclusion');
{
  const LENSES: Array<{ name: string; intent: NextReadIntent }> = [
    { name: 'No-dark',      intent: NO_DARK_LENS   },
    { name: 'Less-dark',    intent: LESS_DARK_LENS },
    { name: 'No-classics',  intent: UNKNOWN_LENS   },
    { name: 'Light+NoDark', intent: { hard: {}, soft: { tone: 'light' }, exclude: { avoid_dark: true } } },
  ];
  let assertions = 0;
  for (const lens of LENSES) {
    const gateOut = runGate(FIXTURES, lens.intent);
    for (const fx of FIXTURES) {
      const verdict = evaluateBookAgainstIntentLens(
        { subjects: fx.subjects, title: fx.title, description: fx.description },
        lens.intent,
        fx.marketPosition,
      );
      const evaluatorWouldExclude = verdict.hardExclusions.length > 0;
      const gateExcluded          = !gateOut.kept.includes(fx);
      if (evaluatorWouldExclude !== gateExcluded) {
        fail(`§10 mismatch — lens=${lens.name} title=${fx.title} evaluator=${evaluatorWouldExclude ? 'exclude' : 'keep'} gate=${gateExcluded ? 'exclude' : 'keep'}`);
      }
      assertions++;
    }
  }
  ok(`gate decisions equal evaluator predictions across ${assertions} (fixture × lens) cells`);
}

// ── Diagnostic format sanity (covered while we're here) ─────────────────────
header('§11 formatFinalGateLog produces a stable single-line log');
{
  const out = runGate(FIXTURES, NO_DARK_LENS);
  if (!out.diagnostics) fail('§11 expected diagnostics from active-intent call');
  const line = formatFinalGateLog(out.diagnostics);
  if (!line.startsWith('[FINAL_GATE]')) fail('§11 log line must start with [FINAL_GATE]');
  if (!/source=/.test(line) || !/kept=/.test(line) || !/removed=/.test(line) || !/topKept=/.test(line))
    fail('§11 log line missing required fields');
  if (/\n/.test(line)) fail('§11 log line must be single-line (no embedded newlines)');
  ok('formatFinalGateLog emits a single-line log with required fields');
}

// ── §12 stale-render leak window — intent-apply UI timing ───────────────────
// Pins the architect-flagged leak vector: when the user applies a lens, the
// component sets activeIntentRef.current first and then calls clearAll().
// React state (visibleConts / visibleDiscs) is a SNAPSHOT, not a live
// selector on the queue, so without an immediate syncVisible() the
// previously rendered cards would remain on screen under an active lens
// until the async runPipeline eventually re-syncs.
//
// We can't run the React component under tsx, so this section pins the
// fix structurally: handleApplyIntent must call syncVisible() between
// clearAll() and the runPipeline launch. Symmetry: handleClearIntent
// must do the same (architect noted clear is not a leak vector, but the
// symmetric reconciliation prevents future regressions).
header('§12 stale-render leak window — intent-apply UI timing');
{
  const feedSrc = fs.readFileSync(
    path.resolve(__dirname, '../components/RecommendationsFeed.tsx'),
    'utf8',
  );
  const applyMatch = feedSrc.match(/function handleApplyIntent\(\)\s*\{[\s\S]*?\n  \}/);
  if (!applyMatch) fail('§12 could not locate handleApplyIntent in RecommendationsFeed.tsx');
  const applyBody = applyMatch![0];
  // Required ordering: activeIntentRef.current = intent → clearAll() → syncVisible() → runPipeline
  const idxSetRef    = applyBody.indexOf('activeIntentRef.current = intent');
  const idxClearAll  = applyBody.indexOf('clearAll()');
  const idxSyncVis   = applyBody.indexOf('syncVisible()');
  const idxRunPipe   = applyBody.indexOf('runPipeline(');
  if (idxSetRef    < 0) fail('§12 handleApplyIntent must assign activeIntentRef.current = intent');
  if (idxClearAll  < 0) fail('§12 handleApplyIntent must call clearAll()');
  if (idxSyncVis   < 0) fail('§12 handleApplyIntent must call syncVisible() to reconcile React state');
  if (idxRunPipe   < 0) fail('§12 handleApplyIntent must call runPipeline()');
  if (!(idxSetRef < idxClearAll && idxClearAll < idxSyncVis && idxSyncVis < idxRunPipe)) {
    fail(`§12 ordering violated — required: setRef(${idxSetRef}) < clearAll(${idxClearAll}) < syncVisible(${idxSyncVis}) < runPipeline(${idxRunPipe})`);
  }
  ok('handleApplyIntent ordering: setRef → clearAll → syncVisible → runPipeline');

  const clearMatch = feedSrc.match(/function handleClearIntent\(\)\s*\{[\s\S]*?\n  \}/);
  if (!clearMatch) fail('§12 could not locate handleClearIntent in RecommendationsFeed.tsx');
  const clearBody = clearMatch![0];
  const cIdxClear   = clearBody.indexOf('clearAll()');
  const cIdxSync    = clearBody.indexOf('syncVisible()');
  const cIdxRun     = clearBody.indexOf('runPipeline(');
  if (!(cIdxClear >= 0 && cIdxSync > cIdxClear && cIdxRun > cIdxSync)) {
    fail('§12 handleClearIntent must also call syncVisible() between clearAll() and runPipeline() (symmetry)');
  }
  ok('handleClearIntent ordering: clearAll → syncVisible → runPipeline (symmetric)');

  // Behavioral pin: after clearAll(), getVisibleStack() returns [] — so the
  // syncVisible call provably produces visibleConts/visibleDiscs = [], which
  // means even an "instant" re-render after intent apply renders no card.
  initForUser('fixture-user-stale-render', []);
  clearAll();
  const after = getVisibleStack();
  if (after.length !== 0) {
    fail(`§12 invariant — getVisibleStack() after clearAll() must be []; got length=${after.length}`);
  }
  ok('clearAll() empties getVisibleStack(); syncVisible therefore sets visible state = []');
}

console.log('\n✅ validate_intent_final_gate: all assertions green\n');
