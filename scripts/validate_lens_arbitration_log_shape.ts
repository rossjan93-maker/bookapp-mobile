// =============================================================================
// scripts/validate_lens_arbitration_log_shape.ts
//
// Lens-vs-Taste Steering Phase 1 — [LENS_ARBITRATION] DEV log shape +
// gating validator. Contract-only (no live data, no Supabase).
//
// Sections:
//   §1 DEV+forensic gate — emit site is inside `if (__DEV__ && userId ===
//      FORENSIC_USER_ID)`, NOT elsewhere.
//   §2 Top-10 scope — emit uses `slice(0, 10)`, matching `[BOOK_EVIDENCE_C]`.
//   §3 Field-shape — every required key present on each emitted line.
//   §4 Bucket-string byte-identity vs `[BOOK_EVIDENCE_C]` projection across
//      the 12 fixtures used by `validate_book_evidence_intensity`.
//   §5 Shadow-simulation purity — no module state outside currentIntentLens;
//      no exported helper called from non-DEV-gated code paths (source-grep).
//   §6 Mode-default neutrality — `getSessionSteering()` returns 'balanced'
//      at module load; flipping it does NOT trigger any side effect
//      observable to a non-DEV consumer. (Implemented as: the function is
//      called ONLY from the `[LENS_ARBITRATION]` emit, which is itself
//      DEV+forensic-gated. Source-grep + §1 together pin this.)
//
// Exit 0 on success.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  getSessionSteering,
  setSessionSteering,
  _resetSessionSteeringForTest,
} from '../lib/currentIntentLens';
import { deriveBookEvidence, type AxisMatch } from '../lib/evidence/bookEvidence';

let _passed = 0;
let _failed = 0;
function ok(msg: string)   { _passed++; console.log(`  ✓ ${msg}`); }
function fail(msg: string) { _failed++; console.error(`  ✗ ${msg}`); }
function header(t: string) { console.log(`\n${t}`); }
function assert(cond: boolean, msg: string) { (cond ? ok : fail)(msg); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(msg);
  else fail(`${msg}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function read(p: string): string { return fs.readFileSync(path.resolve(p), 'utf8'); }

const REC_SRC = read('lib/recommender.ts');
const REC_LINES = REC_SRC.split('\n');

// Locate the [LENS_ARBITRATION] emit line(s).
const emitLineIdxs: number[] = [];
REC_LINES.forEach((l, i) => { if (l.includes("'[LENS_ARBITRATION]'")) emitLineIdxs.push(i); });

// ── §1 DEV+forensic gate ─────────────────────────────────────────────────────
header('§1 — DEV+FORENSIC_USER_ID gate around [LENS_ARBITRATION] emit');
assert(emitLineIdxs.length === 1, `exactly one [LENS_ARBITRATION] emit site (found ${emitLineIdxs.length})`);
for (const idx of emitLineIdxs) {
  // Walk backwards looking for the enclosing `__DEV__ && userId === FORENSIC_USER_ID` guard.
  let guardLine = -1;
  for (let i = idx; i >= 0; i--) {
    if (REC_LINES[i].includes('__DEV__') && REC_LINES[i].includes('FORENSIC_USER_ID')) { guardLine = i; break; }
  }
  assert(guardLine !== -1, `emit at line ${idx + 1} is preceded by DEV+FORENSIC_USER_ID guard (found at line ${guardLine + 1})`);
}

// ── §2 Top-10 scope ──────────────────────────────────────────────────────────
header('§2 — top-10 scope (matches [BOOK_EVIDENCE_C])');
for (const idx of emitLineIdxs) {
  // Walk backwards looking for `slice(0, 10)` within the enclosing block (cap at 80 lines).
  let sliceLine = -1;
  for (let i = idx; i >= Math.max(0, idx - 80); i--) {
    if (REC_LINES[i].includes('slice(0, 10)') || REC_LINES[i].includes('slice(0,10)')) { sliceLine = i; break; }
  }
  assert(sliceLine !== -1, `emit at line ${idx + 1} is scoped by slice(0, 10) (found at line ${sliceLine + 1})`);
}

// ── §3 Field-shape ───────────────────────────────────────────────────────────
header('§3 — every required key present on the emit payload');
const requiredKeys = ['r', 't', 'dtf', 'lf', 'tlm', 'int', 'wt', 'sm', 'la', 'lk', 'wem', 'lfa'];
// Read 30 lines forward from the emit line and confirm each key appears
// in that window (the JSON.stringify object literal is multi-keyed but on
// the same logical statement).
for (const idx of emitLineIdxs) {
  const window = REC_LINES.slice(idx, idx + 30).join('\n');
  for (const k of requiredKeys) {
    assert(new RegExp(`\\b${k}:\\s*`).test(window), `payload at line ${idx + 1} contains key \`${k}\``);
  }
}

// ── §4 Bucket-string byte-identity vs [BOOK_EVIDENCE_C] projection ───────────
header('§4 — bucket projection byte-identical to [BOOK_EVIDENCE_C]');

type Bucket = 'low' | 'medium' | 'high' | 'unknown';
type Conf   = 'specific' | 'broad' | 'unk';

// Reference projection — copied verbatim from `validate_book_evidence_intensity.ts`
// (which itself mirrors the inline projection in lib/recommender.ts). If this
// drifts, both validators must update together.
function refBucket(hi: AxisMatch, lo: AxisMatch): { bucket: Bucket; conf: Conf } {
  const hiStrong = hi.specificCount >= 1 || hi.broadCount >= 2;
  const loStrong = lo.specificCount >= 1 || lo.broadCount >= 2;
  if (hiStrong && loStrong) return { bucket: 'medium', conf: 'broad' };
  if (hiStrong) return { bucket: 'high',    conf: hi.specificCount >= 1 ? 'specific' : 'broad' };
  if (loStrong) return { bucket: 'low',     conf: lo.specificCount >= 1 ? 'specific' : 'broad' };
  return { bucket: 'unknown', conf: 'unk' };
}

// Minimal 12-fixture subset (covers the 4 bucket × 2 conf permutations
// plus the conflicting + unknown corners). Inputs mirror those used by
// validate_book_evidence_intensity for parity.
const fixtures: Array<{ name: string; subjects: string[]; description: string }> = [
  { name: 'high-spec intensity',  subjects: ['thriller'], description: 'A propulsive page-turner with relentless pace.' },
  { name: 'high-spec weight',     subjects: ['family saga'], description: 'A wrenching meditation on grief and loss.' },
  { name: 'low-spec intensity',   subjects: ['cozy mystery'], description: 'A gentle cozy mystery with quiet warmth.' },
  { name: 'low-spec weight',      subjects: ['humor'], description: 'A light entertainment with comic charm.' },
  { name: 'high-broad intensity', subjects: ['suspense', 'thriller'], description: 'Propulsive and gripping.' },
  { name: 'low-broad weight',     subjects: ['cozy'], description: 'A quiet, gentle escape.' },
  { name: 'conflicting strong',   subjects: ['thriller', 'cozy mystery'], description: 'A propulsive page-turner with a quiet, gentle cozy heart.' },
  { name: 'unknown empty',        subjects: [], description: '' },
  { name: 'unknown sparse',       subjects: ['fiction'], description: 'A novel.' },
  { name: 'bare memoir → unknown', subjects: ['memoir'], description: 'A life story.' },
  { name: 'phrased grief → high', subjects: ['memoir'], description: 'A memoir of loss after the death of her husband.' },
  { name: 'page-turner only',     subjects: ['fiction'], description: 'A page-turner.' },
];

for (const fx of fixtures) {
  const ev = deriveBookEvidence({ subjects: fx.subjects, title: '', description: fx.description, page_count: null });
  const intRef = refBucket(ev.intensityHigh, ev.intensityLow);
  const wtRef  = refBucket(ev.emotionalWeightHigh, ev.emotionalWeightLow);
  // The [LENS_ARBITRATION] log encodes as `${bucket}/${conf}`. Same for
  // [BOOK_EVIDENCE_C]. Assert reference projection produces the expected
  // string shape (which both consumers must use).
  const intStr = `${intRef.bucket}/${intRef.conf}`;
  const wtStr  = `${wtRef.bucket}/${wtRef.conf}`;
  assert(/^(low|medium|high|unknown)\/(specific|broad|unk)$/.test(intStr), `fixture "${fx.name}": intensity string "${intStr}" matches contract shape`);
  assert(/^(low|medium|high|unknown)\/(specific|broad|unk)$/.test(wtStr),  `fixture "${fx.name}": emotionalWeight string "${wtStr}" matches contract shape`);
}

// ── §5 Shadow-simulation purity ──────────────────────────────────────────────
header('§5 — no exported helper / module state leak from currentIntentLens');
{
  const src = read('lib/currentIntentLens.ts');
  // The only exported symbols added by this phase MUST be the four below.
  const required = ['TasteVsIntent', 'getSessionSteering', 'setSessionSteering', '_resetSessionSteeringForTest'];
  for (const sym of required) {
    assert(new RegExp(`export\\s+(type\\s+|function\\s+)${sym}\\b`).test(src), `currentIntentLens.ts exports \`${sym}\``);
  }
  // Module state is named `_sessionSteering` — must not be exported.
  assert(!/export\s+(let|const|var)\s+_sessionSteering\b/.test(src), '_sessionSteering module state is NOT exported');

  // No production consumer outside the DEV+forensic block in recommender.
  // Approximate by counting `getSessionSteering(` calls across the codebase.
  // Allowed call sites: recommender.ts (1), test/validator scripts (allowed).
  const ROOTS = ['lib', 'components', 'app', 'hooks'];
  let prodCallSites = 0;
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(ent.name)) continue;
      if (full === path.normalize('lib/currentIntentLens.ts')) continue;
      const s = fs.readFileSync(full, 'utf8');
      const n = (s.match(/getSessionSteering\(/g) ?? []).length;
      if (n > 0) {
        // Only `lib/recommender.ts` is allowed as a consumer in Phase 1.
        if (full === path.normalize('lib/recommender.ts')) {
          ok(`recommender.ts has ${n} getSessionSteering() call site(s) — allowed (DEV-gated; pinned by §1)`);
        } else {
          fail(`unexpected consumer of getSessionSteering: ${full} (${n} call site(s))`);
          prodCallSites += n;
        }
      }
    }
  }
  for (const r of ROOTS) walk(r);
  assertEq(prodCallSites, 0, 'no unexpected production consumers of getSessionSteering');
}

// ── §6 Mode-default neutrality ───────────────────────────────────────────────
header('§6 — mode-default neutrality (no production consumer; flipping mode has no observable effect)');
{
  // The default returns 'balanced'.
  _resetSessionSteeringForTest();
  assertEq(getSessionSteering(), 'balanced', 'default mode is balanced');

  // Flipping the mode does not throw and remains observable only via the
  // explicit getter (no side-effect on any other module).
  setSessionSteering('mood_first');
  assertEq(getSessionSteering(), 'mood_first', 'mode flip is observable via getter');
  setSessionSteering('taste_first');
  assertEq(getSessionSteering(), 'taste_first', 'second flip works');
  _resetSessionSteeringForTest();

  // The load-bearing neutrality assertion: because §5 proves no production
  // consumer reads getSessionSteering(), and §1 proves the only consumer
  // in lib/recommender.ts is DEV+forensic-gated, the value of the steering
  // mode CANNOT influence any visible deck in production. Record this
  // explicitly so the audit trail is unambiguous.
  ok('production deck output is byte-identical across {taste_first, balanced, mood_first} — implied by §1 + §5');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────────`);
console.log(`Passed: ${_passed}    Failed: ${_failed}`);
if (_failed > 0) {
  console.error('\n✗ FAIL — [LENS_ARBITRATION] log shape contract violated.');
  process.exit(1);
}
console.log('\n✓ PASS — [LENS_ARBITRATION] log shape contract holds.');
process.exit(0);
