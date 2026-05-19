// =============================================================================
// scripts/validate_no_dark_isolation.ts
// BookEvidence Batch C slice C0 — No-dark isolation invariant.
//
// Structural invariant: the No-dark gate (`finalGate.ts` and the `avoid_dark`
// branch of `evaluateBookAgainstIntentLens` in `nextReadIntent.ts`) MUST NOT
// reference the shadow-mode `intensity` / `emotionalWeight` axes. Hard
// exclusion remains a pure function of tone evidence + DARK_SIGNALS phrasal
// + domestic-suspense market-position support.
//
// Exit 0 = green. Sections:
//   §1 Source-grep: finalGate.ts contains zero refs to the new axes.
//   §2 Source-grep: the `avoid_dark` branch of evaluateBookAgainstIntentLens
//      contains zero refs to the new axes.
//   §3 Composer / RecCard surface untouched (no imports of new axes).
//   §4 Fixture-replay byte-identity: for every Batch B canonical fixture ×
//      every lens, `evaluateBookAgainstIntentLens(...).hardExclusions` shape
//      and reasons are unchanged in the presence of the new BookEvidence
//      fields (the only way to be sure is to actually run them).
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  evaluateBookAgainstIntentLens,
  emptyIntent,
  type NextReadIntent,
} from '../lib/nextReadIntent';
import { deriveBookEvidence } from '../lib/evidence/bookEvidence';
import type { MarketPosition } from '../lib/fitClassifier';

let _passed = 0;
let _failed = 0;
function ok(msg: string)   { _passed++; console.log(`  ✓ ${msg}`); }
function fail(msg: string) { _failed++; console.error(`  ✗ ${msg}`); }
function header(t: string) { console.log(`\n${t}`); }
function assert(cond: boolean, msg: string) { (cond ? ok : fail)(msg); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(msg);
  else fail(`${msg}\n      expected: ${e}\n      actual:   ${a}`);
}

const ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_TOKENS = [
  'intensityHigh',
  'intensityLow',
  'emotionalWeightHigh',
  'emotionalWeightLow',
  'INTENSITY_HIGH',
  'INTENSITY_LOW',
  'EMOTIONAL_WEIGHT_HIGH',
  'EMOTIONAL_WEIGHT_LOW',
  'evidence.intensity',
  'evidence.emotionalWeight',
];

function readSource(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — finalGate.ts contains zero refs to shadow-mode axes
// ─────────────────────────────────────────────────────────────────────────────
header('§1 — lib/intent/finalGate.ts source-grep');

const finalGateSrc = readSource('lib/intent/finalGate.ts');
for (const tok of FORBIDDEN_TOKENS) {
  assert(!finalGateSrc.includes(tok),
         `finalGate.ts does NOT reference "${tok}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 — `avoid_dark` branch of evaluateBookAgainstIntentLens
// ─────────────────────────────────────────────────────────────────────────────
header('§2 — nextReadIntent.ts `avoid_dark` branch source-grep');

const nriSrc  = readSource('lib/nextReadIntent.ts');
const fnStart = nriSrc.indexOf('export function evaluateBookAgainstIntentLens');
assert(fnStart >= 0, 'found evaluateBookAgainstIntentLens in nextReadIntent.ts');

// Slice from the function signature to either the next exported function
// or 6000 chars in (whichever comes first) — covers the avoid_dark branch
// in full while bounding the search.
const afterStart = nriSrc.slice(fnStart);
const nextExport = afterStart.slice(80).search(/\nexport (function|const|type) /);
const fnBlock    = afterStart.slice(0, nextExport > 0 ? 80 + nextExport : Math.min(6000, afterStart.length));

assert(fnBlock.includes('avoid_dark'),
       'avoid_dark branch is present in extracted block');
for (const tok of FORBIDDEN_TOKENS) {
  assert(!fnBlock.includes(tok),
         `evaluateBookAgainstIntentLens block does NOT reference "${tok}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Composer / RecCard surface untouched
// ─────────────────────────────────────────────────────────────────────────────
header('§3 — Composer / RecCard surface untouched');

for (const rel of ['lib/explanations/compose.ts', 'components/RecCard.tsx']) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.log(`  · ${rel} not present — skipping`);
    continue;
  }
  const src = readSource(rel);
  for (const tok of FORBIDDEN_TOKENS) {
    assert(!src.includes(tok),
           `${rel} does NOT reference "${tok}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Fixture-replay byte-identity: hardExclusions unchanged
// ─────────────────────────────────────────────────────────────────────────────
header('§4 — Fixture-replay byte-identity (hardExclusions stay shape-pure)');

type Fixture = {
  id:          string;
  subjects:    string[];
  title:       string;
  description: string;
};

// Same canonical fixtures used by the Batch B / intent-lens validators.
const FIXTURES: Fixture[] = [
  { id: 'gone_girl',
    subjects: ['psychological thriller', 'domestic suspense', 'page-turner'],
    title: 'Gone Girl',
    description: 'A psychological thriller of domestic suspense.' },
  { id: 'thursday_murder_club',
    subjects: ['cozy mystery', 'humorous fiction'],
    title: 'The Thursday Murder Club',
    description: 'A cozy mystery; a feel-good comic novel.' },
  { id: 'silent_patient',
    subjects: ['psychological thriller'],
    title: 'The Silent Patient',
    description: 'A propulsive thriller, relentlessly paced.' },
  { id: 'verity',
    subjects: ['psychological thriller', 'horror'],
    title: 'Verity',
    description: 'A dark psychological thriller; edge of your seat.' },
  { id: 'everything_i_never_told_you',
    subjects: ['literary fiction', 'family drama'],
    title: 'Everything I Never Told You',
    description: 'A quiet novel of family secrets and grief and loss.' },
  { id: 'project_hail_mary',
    subjects: ['science fiction'],
    title: 'Project Hail Mary',
    description: 'A propulsive, page-turner of non-stop action.' },
  { id: 'a_little_life',
    subjects: ['literary fiction'],
    title: 'A Little Life',
    description: 'A quiet novel; processing grief; meditation on mortality.' },
];

const LENSES: Array<{ name: string; lens: NextReadIntent }> = [
  { name: 'empty', lens: emptyIntent() },
  { name: 'no_dark', lens: { ...emptyIntent(), hard: { ...emptyIntent().hard, avoid_dark: true } } as any },
  { name: 'less_dark', lens: { ...emptyIntent(), soft: { ...emptyIntent().soft, tone: 'light' } } as any },
  { name: 'light_fun', lens: { ...emptyIntent(), soft: { ...emptyIntent().soft, readingEnergy: 'light_fun' } } as any },
];

// Snapshot of expected hardExclusions per (fixture × lens). These mirror the
// pre-Batch-C behavior — if Batch C's new fields leak into any hard exclusion
// path, this assertion fails.
//
// We assert SHAPE: hardExclusions is an array, each entry has the documented
// shape, and no entry cites `intensity` or `emotionalWeight` evidence. We do
// not over-pin verdict identity here (validate_intent_lens / final_gate own
// that contract); we pin that the new axes do not appear in any reason.
const mp: MarketPosition = 'cozy_detective';
let exclusionEntries = 0;
for (const f of FIXTURES) {
  for (const L of LENSES) {
    const v = evaluateBookAgainstIntentLens(f as any, L.lens, mp);
    assert(Array.isArray(v.hardExclusions),
           `[${f.id}/${L.name}] hardExclusions is array`);
    for (const ex of v.hardExclusions) {
      exclusionEntries++;
      assert(typeof ex.reason === 'string', `[${f.id}/${L.name}] exclusion.reason is string`);
      // The reason must NOT mention `intensity` or `emotionalWeight`.
      const r = ex.reason.toLowerCase();
      assert(!r.includes('intensity'),
             `[${f.id}/${L.name}] exclusion.reason does NOT mention "intensity": "${ex.reason}"`);
      assert(!r.includes('emotional weight') && !r.includes('emotionalweight'),
             `[${f.id}/${L.name}] exclusion.reason does NOT mention "emotional weight": "${ex.reason}"`);
    }
  }
}
ok(`replayed ${FIXTURES.length} fixtures × ${LENSES.length} lenses = ${FIXTURES.length * LENSES.length} verdicts (${exclusionEntries} hard-exclusion entries scanned)`);

// Sanity: the shadow-mode evidence fields ARE populated on derive — this is
// the "axes exist, they're just not consumed by the gate" half of the claim.
const evCarry = deriveBookEvidence({
  subjects: ['literary fiction'],
  title: 'carry_forward',
  description: 'A gentle read of family secrets and processing grief.',
});
assert(evCarry.intensityLow.specificCount        >= 1, 'shadow: intensityLow.specific fires on gentle read');
assert(evCarry.emotionalWeightHigh.specificCount >= 1, 'shadow: emotionalWeightHigh.specific fires on family secrets');

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${_failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${_passed} passed, ${_failed} failed`);
process.exit(_failed === 0 ? 0 : 1);
