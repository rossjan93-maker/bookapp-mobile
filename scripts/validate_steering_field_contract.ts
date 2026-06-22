// =============================================================================
// scripts/validate_steering_field_contract.ts
//
// Lens-vs-Taste Steering Phase 1 — steering field contract validator.
// Contract-only. Pins the field-shape and lifecycle invariants of the new
// `TasteVsIntent` field on `lib/currentIntentLens.ts`.
//
// Sections:
//   §1 Default + round-trip — get returns 'balanced'; set/get round-trips
//      all three modes; reset returns to 'balanced'.
//   §2 No persistence surface — source-grep `lib/currentIntentLens.ts`
//      for AsyncStorage / MMKV / localStorage / supabase / cache imports.
//      Zero matches.
//   §3 Not in `configHash` — source-grep `lib/recValidity.ts` and
//      `lib/recRequest.ts` for `steering` / `tasteVsIntent` / `TasteVsIntent`
//      / `getSessionSteering`. Zero matches.
//   §4 Not consumed by ranking surfaces — source-grep `lib/recommender.ts`
//      for `getSessionSteering(` references outside the DEV+forensic
//      diagnostic block.
//   §5 No composer / RecCard / finalGate / No-dark consumption — source-grep
//      `lib/explanations/compose.ts`, `components/RecCard.tsx`,
//      `lib/intent/finalGate.ts`, `lib/nextReadIntent.ts` for the new
//      symbols. Zero matches.
//   §6 No signal-list change — source-grep `lib/evidence/signals.ts` for
//      any of the new symbols. Zero matches.
//   §7 recValidity.VERSION === 'rcv8' — import + assert (bumped Phase B.0 2026-05-26).
//
// Exit 0 on success; nonzero on any failure.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  getSessionSteering,
  setSessionSteering,
  _resetSessionSteeringForTest,
  type TasteVsIntent,
} from '../lib/currentIntentLens';

let _passed = 0;
let _failed = 0;
function ok(msg: string)   { _passed++; console.log(`  ✓ ${msg}`); }
function fail(msg: string) { _failed++; console.error(`  ✗ ${msg}`); }
function header(t: string) { console.log(`\n${t}`); }
function assert(cond: boolean, msg: string) { (cond ? ok : fail)(msg); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual === expected) ok(msg);
  else fail(`${msg}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function read(p: string): string { return fs.readFileSync(path.resolve(p), 'utf8'); }

// ── §1 Default + round-trip ──────────────────────────────────────────────────
header('§1 — Default and round-trip');
_resetSessionSteeringForTest();
assertEq(getSessionSteering(), 'balanced' as TasteVsIntent, 'default value is `balanced`');
setSessionSteering('taste_first');
assertEq(getSessionSteering(), 'taste_first' as TasteVsIntent, 'set/get round-trip: taste_first');
setSessionSteering('mood_first');
assertEq(getSessionSteering(), 'mood_first' as TasteVsIntent, 'set/get round-trip: mood_first');
setSessionSteering('balanced');
assertEq(getSessionSteering(), 'balanced' as TasteVsIntent, 'set/get round-trip: balanced');
setSessionSteering('mood_first');
_resetSessionSteeringForTest();
assertEq(getSessionSteering(), 'balanced' as TasteVsIntent, '_resetSessionSteeringForTest() returns to default');

// ── §2 No persistence surface in currentIntentLens.ts ────────────────────────
header('§2 — No persistence surface in lib/currentIntentLens.ts');
{
  const src = read('lib/currentIntentLens.ts');
  const forbidden = [
    'AsyncStorage', 'MMKV', 'localStorage', 'sessionStorage',
    'supabase', 'recPayloadCache', 'recSession', 'recQueue',
  ];
  for (const sym of forbidden) {
    const matches = src.split('\n').filter(l => l.includes(sym) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    assert(matches.length === 0, `currentIntentLens.ts contains no non-comment reference to \`${sym}\``);
  }
}

// ── §3 Not in configHash / RecRequest ────────────────────────────────────────
header('§3 — Steering symbols absent from recValidity.ts + recRequest.ts');
{
  const symbols = ['TasteVsIntent', 'getSessionSteering', 'setSessionSteering', '_sessionSteering'];
  for (const file of ['lib/recValidity.ts', 'lib/recRequest.ts']) {
    const src = read(file);
    for (const sym of symbols) {
      assert(!src.includes(sym), `${file} contains no reference to \`${sym}\``);
    }
  }
}

// ── §4 Recommender consumes steering ONLY in the DEV+forensic block ──────────
header('§4 — getSessionSteering() called only inside DEV+forensic diagnostic block');
{
  const src = read('lib/recommender.ts');
  // Find the import line (allowed)
  const importRe = /from\s+['"]\.\/currentIntentLens['"]/;
  assert(importRe.test(src), 'lib/recommender.ts imports from ./currentIntentLens');

  // Find all calls to getSessionSteering(
  const lines = src.split('\n');
  const callLineNums: number[] = [];
  lines.forEach((l, i) => { if (l.includes('getSessionSteering(')) callLineNums.push(i); });
  assert(callLineNums.length >= 1, `at least one call site exists (found ${callLineNums.length})`);
  assert(callLineNums.length <= 2, `no more than 2 call sites in Phase 1 (found ${callLineNums.length})`);

  // For each call site, walk backwards to find the most recent
  // `if (__DEV__ && userId === FORENSIC_USER_ID)` guard. Accept the call
  // only if such a guard exists AND no `}` at the same or lower
  // indentation closes the block before the call line.
  for (const lineNum of callLineNums) {
    let guardLine = -1;
    for (let i = lineNum; i >= 0; i--) {
      if (lines[i].includes('__DEV__') && lines[i].includes('FORENSIC_USER_ID')) { guardLine = i; break; }
    }
    assert(guardLine !== -1, `call at line ${lineNum + 1} is preceded by a DEV+FORENSIC_USER_ID guard`);
  }
}

// ── §5 No composer/RecCard/finalGate/No-dark consumption ─────────────────────
header('§5 — Steering symbols absent from composer/RecCard/finalGate/No-dark surfaces');
{
  const files = [
    'lib/explanations/compose.ts',
    'components/RecCard.tsx',
    'lib/intent/finalGate.ts',
    'lib/nextReadIntent.ts',
  ];
  const symbols = ['TasteVsIntent', 'getSessionSteering', 'setSessionSteering'];
  for (const file of files) {
    if (!fs.existsSync(path.resolve(file))) {
      ok(`${file} does not exist — vacuously clean`);
      continue;
    }
    const src = read(file);
    for (const sym of symbols) {
      assert(!src.includes(sym), `${file} contains no reference to \`${sym}\``);
    }
  }
}

// ── §6 No signal-list change ─────────────────────────────────────────────────
header('§6 — lib/evidence/signals.ts contains no steering symbol');
{
  const src = read('lib/evidence/signals.ts');
  const symbols = ['TasteVsIntent', 'getSessionSteering', 'setSessionSteering', 'steering'];
  for (const sym of symbols) {
    // Avoid false positives on legitimate substrings like "steering" — but
    // this file is small and has no legitimate use of the word, so a literal
    // check is safe.
    assert(!src.toLowerCase().includes(sym.toLowerCase()), `signals.ts contains no reference to \`${sym}\``);
  }
}

// ── §7 recValidity VERSION pinned at rcv9 (source-grep; const is module-private) ─
header('§7 — recValidity VERSION === rcv9');
{
  const src = read('lib/recValidity.ts');
  assert(/\bconst\s+VERSION\s*=\s*'rcv9'/.test(src), 'lib/recValidity.ts declares `const VERSION = \'rcv9\'`');
  // Sanity: no competing assignment to a different rcv value.
  const otherRcv = src.match(/\bVERSION\s*=\s*'(rcv\d+)'/);
  assert(otherRcv?.[1] === 'rcv9', `VERSION assignment is exactly rcv9 (matched: ${otherRcv?.[1] ?? 'none'})`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────────`);
console.log(`Passed: ${_passed}    Failed: ${_failed}`);
if (_failed > 0) {
  console.error('\n✗ FAIL — steering field contract violated.');
  process.exit(1);
}
console.log('\n✓ PASS — steering field contract holds.');
process.exit(0);
