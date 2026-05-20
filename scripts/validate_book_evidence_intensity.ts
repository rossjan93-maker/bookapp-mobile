// =============================================================================
// scripts/validate_book_evidence_intensity.ts
// BookEvidence Batch C slice C0 — shadow-mode contract validator.
//
// Acceptance gate for `intensity` and `emotionalWeight` AxisMatch fields on
// BookEvidence. Exit 0 = green. Sections:
//   §1 Signal-list authoring rule — specific lists are phrasal only;
//      broad lists are single-token only (mirrors the existing Batch B
//      partitionBySpecificity-at-authoring contract).
//   §2 deriveBookEvidence shape — new fields exist, are frozen AxisMatch
//      shapes, and are observational only (no other field shape changed).
//   §3 Fixture matrix (planning §9 + C1 cold-start additions) — 21 fixtures × 2 axes verdicts.
//   §4 Bucket projection invariants — strong rule (spec≥1 || broad≥2),
//      conflicting strong → medium, empty corpus → unknown.
//   §5 Diagonal-stress fixtures — high-weight + non-dark, high-weight +
//      low-intensity (the cases Batch A/B left on the table).
//   §6 Memoir-trap — bare `memoir` does NOT trigger emotionalWeight; only
//      phrased forms ("memoir of loss") do.
//   §7 Single-broad isolation — one broad-only hit on EMOTIONAL_WEIGHT_HIGH
//      (e.g. only `grief`) registers as `unknown`, NOT `high`.
// =============================================================================

import {
  INTENSITY_HIGH, INTENSITY_LOW,
  EMOTIONAL_WEIGHT_HIGH, EMOTIONAL_WEIGHT_LOW,
  type SignalSet,
} from '../lib/evidence/signals';
import { deriveBookEvidence, type BookEvidence, type AxisMatch } from '../lib/evidence/bookEvidence';

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

// Bucket projection — local validator helper. Mirrors the inline projection
// used by the recommender DEV log so both stay in lockstep.
type Bucket = 'low' | 'medium' | 'high' | 'unknown';
type Conf   = 'specific' | 'broad' | 'unk';
function bucket(hi: AxisMatch, lo: AxisMatch): { bucket: Bucket; conf: Conf } {
  const hiStrong = hi.specificCount >= 1 || hi.broadCount >= 2;
  const loStrong = lo.specificCount >= 1 || lo.broadCount >= 2;
  if (hiStrong && loStrong) return { bucket: 'medium', conf: 'broad' };
  if (hiStrong) return { bucket: 'high',    conf: hi.specificCount >= 1 ? 'specific' : 'broad' };
  if (loStrong) return { bucket: 'low',     conf: lo.specificCount >= 1 ? 'specific' : 'broad' };
  return { bucket: 'unknown', conf: 'unk' };
}

function intensityBucket(ev: BookEvidence)       { return bucket(ev.intensityHigh,       ev.intensityLow); }
function emotionalWeightBucket(ev: BookEvidence) { return bucket(ev.emotionalWeightHigh, ev.emotionalWeightLow); }

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Signal-list authoring rule
// ─────────────────────────────────────────────────────────────────────────────
header('§1 — Signal-list authoring rule (phrasal-specific / single-token-broad)');

const NEW_SETS: Record<string, SignalSet> = {
  INTENSITY_HIGH, INTENSITY_LOW, EMOTIONAL_WEIGHT_HIGH, EMOTIONAL_WEIGHT_LOW,
};
for (const [name, set] of Object.entries(NEW_SETS)) {
  for (const phrase of set.specific) {
    // Specific entries must contain a space OR a hyphen (phrasal contextualization).
    // Pure single-token entries belong in `broad`. Exception: hyphenated compound
    // words like `non-stop`, `pulse-pounding`, `feel-good` are phrasal.
    const isPhrasal = phrase.includes(' ') || phrase.includes('-');
    assert(isPhrasal, `${name}.specific["${phrase}"] is phrasal (space or hyphen)`);
  }
  for (const tok of set.broad) {
    // Broad entries must NOT contain a space (single-token only).
    assert(!tok.includes(' '), `${name}.broad["${tok}"] is single-token (no space)`);
  }
  assert(set.specific.length >= 4, `${name}.specific has ≥4 entries (currently ${set.specific.length})`);
  assert(set.broad.length    >= 3, `${name}.broad has ≥3 entries (currently ${set.broad.length})`);
}

// Memoir-trap §6 anti-rule: bare `memoir` must not appear in EITHER tier of
// EMOTIONAL_WEIGHT_HIGH (planning §7 hard rule).
assert(!EMOTIONAL_WEIGHT_HIGH.specific.includes('memoir'),
       'EMOTIONAL_WEIGHT_HIGH.specific does NOT contain bare "memoir"');
assert(!EMOTIONAL_WEIGHT_HIGH.broad.includes('memoir'),
       'EMOTIONAL_WEIGHT_HIGH.broad does NOT contain bare "memoir"');

// ─────────────────────────────────────────────────────────────────────────────
// §2 — deriveBookEvidence shape
// ─────────────────────────────────────────────────────────────────────────────
header('§2 — deriveBookEvidence shape — new fields present, frozen, observational');

const ev0 = deriveBookEvidence({ subjects: [], title: '', description: '' });
assert('intensityHigh'       in ev0, 'BookEvidence has intensityHigh');
assert('intensityLow'        in ev0, 'BookEvidence has intensityLow');
assert('emotionalWeightHigh' in ev0, 'BookEvidence has emotionalWeightHigh');
assert('emotionalWeightLow'  in ev0, 'BookEvidence has emotionalWeightLow');

for (const k of ['intensityHigh', 'intensityLow', 'emotionalWeightHigh', 'emotionalWeightLow'] as const) {
  const m = ev0[k];
  assert(Object.isFrozen(m), `${k} AxisMatch is frozen`);
  assert(typeof m.specificCount === 'number', `${k}.specificCount is number`);
  assert(typeof m.broadCount    === 'number', `${k}.broadCount is number`);
  assert(m.firstSpecific === null || typeof m.firstSpecific === 'string',
         `${k}.firstSpecific is string|null`);
  assert(m.firstBroad    === null || typeof m.firstBroad    === 'string',
         `${k}.firstBroad is string|null`);
}

// Pure / deterministic — twice = same shape.
const evA = deriveBookEvidence({ subjects: ['propulsive thriller'], title: 'A', description: '' });
const evB = deriveBookEvidence({ subjects: ['propulsive thriller'], title: 'A', description: '' });
assertEq(evA.intensityHigh,       evB.intensityHigh,       'deriveBookEvidence(intensityHigh) deterministic');
assertEq(evA.emotionalWeightHigh, evB.emotionalWeightHigh, 'deriveBookEvidence(emotionalWeightHigh) deterministic');

// Robust to null/undefined input.
const evNull  = deriveBookEvidence(null);
const evUndef = deriveBookEvidence(undefined);
assertEq(intensityBucket(evNull),  { bucket: 'unknown', conf: 'unk' }, 'null  input → intensity unknown');
assertEq(intensityBucket(evUndef), { bucket: 'unknown', conf: 'unk' }, 'undef input → intensity unknown');

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Fixture matrix (planning §9)
// ─────────────────────────────────────────────────────────────────────────────
header('§3 — Fixture matrix (21 fixtures × 2 axes)');

type Fixture = {
  id:       string;
  subjects: string[];
  description: string;
  expectedIntensity:       Bucket;
  expectedIntensityConf:   Conf;
  expectedWeight:          Bucket;
  expectedWeightConf:      Conf;
  role: string;
};

const FIXTURES: Fixture[] = [
  {
    id: 'gone_girl',
    subjects: ['psychological thriller', 'page-turner', 'domestic suspense'],
    description: 'A propulsive thriller; an action-packed, escapist page-turner of light entertainment.',
    expectedIntensity: 'high', expectedIntensityConf: 'specific',
    expectedWeight: 'low',     expectedWeightConf: 'specific',
    role: 'dark + intense + low-weight (orthogonality)',
  },
  {
    id: 'thursday_murder_club',
    subjects: ['cozy mystery', 'humorous fiction'],
    description: 'A cozy mystery; a feel-good light entertainment, a beach read.',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'low',     expectedWeightConf: 'specific',
    role: 'the easy case',
  },
  {
    id: 'silent_patient',
    subjects: ['psychological thriller', 'page-turner'],
    description: 'A propulsive thriller; relentlessly paced and pulse-pounding.',
    expectedIntensity: 'high', expectedIntensityConf: 'specific',
    expectedWeight: 'unknown', expectedWeightConf: 'unk',
    role: 'high-intensity, weight uncertain',
  },
  {
    id: 'verity',
    subjects: ['psychological thriller'],
    description: 'A propulsive thriller, edge of your seat and taut.',
    expectedIntensity: 'high', expectedIntensityConf: 'specific',
    expectedWeight: 'unknown', expectedWeightConf: 'unk',
    role: 'high-intensity, weight uncertain',
  },
  {
    id: 'everything_i_never_told_you',
    subjects: ['literary fiction', 'family drama'],
    description: 'A quiet novel of family secrets, intergenerational trauma, and grief and loss.',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'high',    expectedWeightConf: 'specific',
    role: 'CARRY-FORWARD — non-dark + heavy + low-intensity',
  },
  {
    id: 'a_little_life',
    subjects: ['literary fiction'],
    description: 'A quiet novel; processing grief; meditation on mortality; understated prose.',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'high',    expectedWeightConf: 'specific',
    role: 'heavy + slow + low-intensity (separates intensity from weight)',
  },
  {
    id: 'project_hail_mary',
    subjects: ['science fiction', 'page-turner'],
    description: 'A propulsive thriller of non-stop action; an action-packed page-turner.',
    expectedIntensity: 'high', expectedIntensityConf: 'specific',
    expectedWeight: 'unknown', expectedWeightConf: 'unk',
    role: 'high-intensity + non-dark',
  },
  {
    id: 'house_of_leaves',
    subjects: ['experimental fiction'],
    description: 'A dense, experimental work.',
    expectedIntensity: 'unknown', expectedIntensityConf: 'unk',
    expectedWeight: 'unknown',    expectedWeightConf: 'unk',
    role: 'dense ≠ heavy/intense',
  },
  {
    id: 'beach_read_canonical',
    subjects: ['romantic comedy', 'cozy mystery'],
    description: 'A romantic comedy; a beach read; light entertainment; feel-good.',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'low',     expectedWeightConf: 'specific',
    role: 'low/low control',
  },
  {
    id: 'klara_and_the_sun',
    subjects: ['literary fiction'],
    description: 'A gentle read; quiet meditation; understated prose. Themes of loss and bereavement weigh on the narrator.',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'high',    expectedWeightConf: 'broad',
    role: 'low-intensity + heavy (inverse of Verity)',
  },
  {
    id: 'educated_memoir',
    subjects: ['memoir', 'biography'],
    description: 'A memoir of loss and intergenerational trauma; coming of age in a survivalist family.',
    expectedIntensity: 'unknown', expectedIntensityConf: 'unk',
    expectedWeight: 'high',       expectedWeightConf: 'specific',
    role: 'memoir-of-trauma — phrased entry required',
  },
  {
    id: 'empty_book',
    subjects: [],
    description: '',
    expectedIntensity: 'unknown', expectedIntensityConf: 'unk',
    expectedWeight: 'unknown',    expectedWeightConf: 'unk',
    role: 'null fixture',
  },
  // ── Batch C slice C1 (2026-05-20) — cold-start coverage fixtures.
  // These are OL-subject-only fixtures (empty descriptions) modeling the
  // capture-time thin-metadata regime that produced the 70% miss rate.
  // Together they prove the OL-canonical tag additions resolve `unknown`
  // → strong on the cold-start corpus shape.
  {
    id: 'domestic_suspense_canonical',
    subjects: ['domestic suspense', 'thriller', 'fiction'],
    description: '',
    expectedIntensity: 'high', expectedIntensityConf: 'specific',
    expectedWeight: 'unknown', expectedWeightConf: 'unk',
    role: 'C1 cold-start: OL-only domestic suspense — `domestic suspense` specific must fire',
  },
  {
    id: 'psych_thriller_canonical',
    subjects: ['psychological thriller', 'suspense'],
    description: '',
    expectedIntensity: 'high', expectedIntensityConf: 'specific',
    expectedWeight: 'unknown', expectedWeightConf: 'unk',
    role: 'C1 cold-start: OL-only psych thriller — specific + paired broad',
  },
  {
    id: 'literary_grief_canonical',
    subjects: ['literary fiction', 'family drama'],
    description: '',
    expectedIntensity: 'unknown', expectedIntensityConf: 'unk',
    expectedWeight: 'high',      expectedWeightConf: 'specific',
    role: 'C1 cold-start: OL-only literary family drama — `family drama` specific fires weight only',
  },
  {
    id: 'cozy_mystery_canonical',
    subjects: ['cozy mystery', 'humorous fiction', 'mystery'],
    description: '',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'low',     expectedWeightConf: 'specific',
    role: 'C1 cold-start: OL-only cozy mystery — `cozy mystery` fires both axes via mirroring',
  },
  {
    id: 'low_burden_fantasy_canonical',
    subjects: ['cozy fantasy', 'fantasy'],
    description: '',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'low',     expectedWeightConf: 'specific',
    role: 'C1 cold-start: OL-only cozy fantasy — low/low on both axes (subject-only)',
  },
  {
    id: 'low_burden_scifi_canonical',
    subjects: ['humorous fiction', 'science fiction'],
    description: '',
    expectedIntensity: 'low',  expectedIntensityConf: 'specific',
    expectedWeight: 'low',     expectedWeightConf: 'specific',
    role: 'C1 cold-start: OL-only humorous sci-fi — `humorous mystery` is NOT a match (only sci-fi), but `humorous fiction` is in EMOTIONAL_WEIGHT_LOW.specific',
  },
  {
    id: 'thin_metadata_control',
    subjects: ['fiction'],
    description: '',
    expectedIntensity: 'unknown', expectedIntensityConf: 'unk',
    expectedWeight: 'unknown',    expectedWeightConf: 'unk',
    role: 'C1 control: bare `fiction` tag must remain unknown (anti-overfire)',
  },
  // ── Batch C slice C1 anti-overfire fixtures.
  // The new INTENSITY_HIGH.broad tokens (`thriller`, `suspense`) carry the
  // largest single-source over-firing risk. These three fixtures explicitly
  // pin the bucket projection: one of them alone is `unknown` (≥2-broad
  // rule), both together is `high/broad` (the intended cold-start lift).
  {
    id: 'thriller_only_antioverfire',
    subjects: ['thriller'],
    description: '',
    expectedIntensity: 'unknown', expectedIntensityConf: 'unk',
    expectedWeight: 'unknown',    expectedWeightConf: 'unk',
    role: 'C1 anti-overfire: bare `thriller` (1 broad) stays unknown',
  },
  {
    id: 'suspense_only_antioverfire',
    subjects: ['suspense'],
    description: '',
    expectedIntensity: 'unknown', expectedIntensityConf: 'unk',
    expectedWeight: 'unknown',    expectedWeightConf: 'unk',
    role: 'C1 anti-overfire: bare `suspense` (1 broad) stays unknown',
  },
  {
    id: 'thriller_suspense_paired',
    subjects: ['thriller', 'suspense'],
    description: '',
    expectedIntensity: 'high',    expectedIntensityConf: 'broad',
    expectedWeight: 'unknown',    expectedWeightConf: 'unk',
    role: 'C1 anti-overfire: `thriller`+`suspense` (2 broad) → high/broad (intended cold-start lift)',
  },
];

for (const f of FIXTURES) {
  const ev = deriveBookEvidence({ subjects: f.subjects, title: f.id, description: f.description });
  const ib = intensityBucket(ev);
  const wb = emotionalWeightBucket(ev);
  assertEq(ib, { bucket: f.expectedIntensity, conf: f.expectedIntensityConf },
           `[${f.id}] intensity (${f.role})`);
  assertEq(wb, { bucket: f.expectedWeight, conf: f.expectedWeightConf },
           `[${f.id}] emotionalWeight (${f.role})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Bucket projection invariants
// ─────────────────────────────────────────────────────────────────────────────
header('§4 — Bucket projection invariants');

// Strong rule on HIGH only (1 specific hit).
const ev_h_only = deriveBookEvidence({ subjects: [], title: '', description: 'A propulsive thriller.' });
assertEq(intensityBucket(ev_h_only), { bucket: 'high', conf: 'specific' },
         'single specific HIGH hit → high/specific');

// Strong rule on LOW only (1 specific hit).
const ev_l_only = deriveBookEvidence({ subjects: ['cozy mystery'], title: '', description: '' });
assertEq(intensityBucket(ev_l_only), { bucket: 'low', conf: 'specific' },
         'single specific LOW hit → low/specific');

// Conflicting strong on both poles → medium/broad.
const ev_both = deriveBookEvidence({
  subjects: [],
  title: '',
  description: 'A propulsive thriller, yet a cozy mystery at heart.',
});
assertEq(intensityBucket(ev_both), { bucket: 'medium', conf: 'broad' },
         'conflicting strong on both poles → medium/broad');

// Single broad hit alone → unknown.
const ev_one_broad = deriveBookEvidence({ subjects: [], title: '', description: 'A taut book.' });
assertEq(intensityBucket(ev_one_broad), { bucket: 'unknown', conf: 'unk' },
         'one broad-only hit → unknown (no escalation)');

// Two broad hits → bucket via broad confidence.
const ev_two_broad = deriveBookEvidence({ subjects: [], title: '', description: 'A taut, frenetic book.' });
assertEq(intensityBucket(ev_two_broad), { bucket: 'high', conf: 'broad' },
         'two broad-only HIGH hits → high/broad');

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Diagonal-stress (Batch A/B carry-forward cases)
// ─────────────────────────────────────────────────────────────────────────────
header('§5 — Diagonal-stress fixtures (carry-forward case proof)');

// Heavy + non-dark + low-intensity — this is the case Batch A/B left on the
// table; if any of these three verdicts is wrong, Batch C provides no value.
const ev_carry = deriveBookEvidence({
  subjects: ['literary fiction'],
  title: 'carry_forward',
  description: 'A gentle read of family secrets and processing grief.',
});
assertEq(intensityBucket(ev_carry),       { bucket: 'low',  conf: 'specific' },
         'carry-forward: gentle + grief → intensity low/specific');
assertEq(emotionalWeightBucket(ev_carry), { bucket: 'high', conf: 'specific' },
         'carry-forward: gentle + grief → weight high/specific');

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Memoir-trap
// ─────────────────────────────────────────────────────────────────────────────
header('§6 — Memoir-trap (bare `memoir` does NOT trigger weight)');

const ev_bare_memoir = deriveBookEvidence({
  subjects: ['memoir', 'biography'],
  title: 'bare_memoir',
  description: 'A memoir.',
});
assertEq(emotionalWeightBucket(ev_bare_memoir), { bucket: 'unknown', conf: 'unk' },
         'bare memoir → emotionalWeight unknown');

const ev_phrased_memoir = deriveBookEvidence({
  subjects: ['memoir'],
  title: 'phrased_memoir',
  description: 'A memoir of loss.',
});
assertEq(emotionalWeightBucket(ev_phrased_memoir), { bucket: 'high', conf: 'specific' },
         'memoir of loss → emotionalWeight high/specific');

// ─────────────────────────────────────────────────────────────────────────────
// §7 — Single-broad isolation (the `grief`-class anti-escalation rule)
// ─────────────────────────────────────────────────────────────────────────────
header('§7 — Single-broad isolation (grief class)');

const ev_only_grief = deriveBookEvidence({
  subjects: ['fiction'],
  title: 'only_grief',
  description: 'A novel touched by grief.',
});
assertEq(emotionalWeightBucket(ev_only_grief), { bucket: 'unknown', conf: 'unk' },
         'only `grief` (1 broad) → emotionalWeight unknown (no escalation)');

const ev_grief_and_loss = deriveBookEvidence({
  subjects: ['fiction'],
  title: 'two_broad',
  description: 'A novel of grief and mourning.',
});
assertEq(emotionalWeightBucket(ev_grief_and_loss), { bucket: 'high', conf: 'broad' },
         'grief + mourning (2 broad) → emotionalWeight high/broad');

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${_failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${_passed} passed, ${_failed} failed`);
process.exit(_failed === 0 ? 0 : 1);
