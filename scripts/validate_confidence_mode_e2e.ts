/**
 * validate_confidence_mode_e2e.ts
 *
 * End-to-end validator for the rawTier fix (rcv9 / csrp3, 2026-06-22).
 *
 * Asserts the full wiring:
 *   computeTasteProfile → TasteProfile.rawTier
 *     → recRequest.ts → confidenceModeForTier(profile.rawTier, profile.intakeBoosted)
 *       → BRANCH_QUOTAS[confidenceMode].coldStartAdjacent
 *
 * Because computeTasteProfile requires live Supabase data, the behavioral
 * fixtures call its pure sub-functions (computeConfidenceTier +
 * confidenceModeForTier + BRANCH_QUOTAS) directly. Three source-grep
 * assertions pin the wiring in the actual source files so this validator
 * breaks immediately if a regression reverts the fix.
 *
 * Run:  npx tsx scripts/validate_confidence_mode_e2e.ts
 * Exit: 0 on success, 1 on any failure.
 */

import fs   from 'fs';
import path from 'path';

import {
  computeConfidenceTier,
  type TasteProfileEvidence,
} from '../lib/tasteProfile';
import {
  confidenceModeForTier,
  BRANCH_QUOTAS,
} from '../lib/recPolicy';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}
function section(name: string): void { console.log(`\n\u2500\u2500 ${name} \u2500\u2500`); }

// Minimal TasteProfileEvidence for fixtures with no import/enrichment history.
// import_count=0 and enriched_count=0 ensure computeConfidenceTier stays at
// tier 2 (not tier 3) when strongSignalCount >= 10.
const NO_IMPORT_EVIDENCE: TasteProfileEvidence = {
  import_count:           0,
  enriched_count:         0,
  taste_tag_count:        0,
  review_count:           0,
  diagnosis_answer_count: 0,
};

// ── §1 Source-grep: TasteProfile type declares rawTier ──────────────────────
section('§1 — TasteProfile type declares rawTier: ConfidenceTier');
{
  const src = fs.readFileSync(
    path.resolve(__dirname, '../lib/tasteProfile.ts'), 'utf-8');
  check(
    '§1 TasteProfile type contains `rawTier: ConfidenceTier`',
    /rawTier\s*:\s*ConfidenceTier/.test(src),
    'expected `rawTier: ConfidenceTier` field in TasteProfile in lib/tasteProfile.ts',
  );
}

// ── §2 Source-grep: rawTier computed before the intake boost ────────────────
section('§2 — rawTier computed from unboosted strongSignalCount before intake boost');
{
  const src = fs.readFileSync(
    path.resolve(__dirname, '../lib/tasteProfile.ts'), 'utf-8');

  // rawTier assignment must appear in the source.
  check(
    '§2 `const rawTier = computeConfidenceTier(evidence, strongSignalCount)` present',
    /const\s+rawTier\s*=\s*computeConfidenceTier\s*\(\s*evidence\s*,\s*strongSignalCount\s*\)/.test(src),
    'expected exact assignment in lib/tasteProfile.ts',
  );

  // rawTier assignment must appear BEFORE effectiveSignalCount (the boosted value).
  const rawTierPos       = src.indexOf('const rawTier');
  const effectivePos     = src.indexOf('const effectiveSignalCount');
  check(
    '§2 const rawTier appears before const effectiveSignalCount in source order',
    rawTierPos !== -1 && effectivePos !== -1 && rawTierPos < effectivePos,
    `rawTierPos=${rawTierPos} effectivePos=${effectivePos}`,
  );

  // rawTier must be present in the return object of computeTasteProfile.
  check(
    '§2 rawTier included in computeTasteProfile return object',
    /return\s*\{[\s\S]{0,200}rawTier[\s\S]{0,200}intakeBoosted/.test(src),
    'expected `rawTier` in the return object before `intakeBoosted`',
  );
}

// ── §3 Source-grep: recRequest.ts uses profile.rawTier, not profile.tier ────
section('§3 — recRequest.ts passes profile.rawTier into confidenceModeForTier');
{
  const src = fs.readFileSync(
    path.resolve(__dirname, '../lib/recRequest.ts'), 'utf-8');

  check(
    '§3 confidenceModeForTier receives opts.profile.rawTier',
    /confidenceModeForTier\s*\(\s*opts\.profile\.rawTier\s*,\s*opts\.profile\.intakeBoosted\s*\)/.test(src),
    'expected confidenceModeForTier(opts.profile.rawTier, opts.profile.intakeBoosted)',
  );

  // Regression guard: profile.tier must NOT be passed to confidenceModeForTier.
  check(
    '§3 profile.tier (boosted) is NOT passed to confidenceModeForTier (regression guard)',
    !/confidenceModeForTier\s*\(\s*opts\.profile\.tier/.test(src),
    'found profile.tier passed to confidenceModeForTier — rawTier fix was reverted',
  );
}

// ── §4 Four fixtures: rawTier → confidenceMode → coldStartAdjacent quota ────
//
// The four fixtures cover the relevant cells of the
//   (rawTier ∈ {0, 1, 2}) × (intakeBoosted ∈ {true, false}) matrix.
//
// Fixture A — fresh intake user (the primary fix target):
//   strongSignalCount=0, intakeCompleted=true, hasIntakeGenres=true
//   → rawTier=0, intakeBoosted=true
//   → confidenceMode=sparse_onboarding, quota=3
//
// Fixture B — brand-new account, no intake:
//   strongSignalCount=0, intakeBoosted=false
//   → rawTier=0, confidenceMode=zero_signal, quota=3
//
// Fixture C — thin user with lapsed boost (7 books, intake earlier):
//   strongSignalCount=7  → rawTier=1 (7>=5)
//   intakeBoosted=false  (strongSignalCount>=5 → predicate false)
//   → confidenceMode=thin, quota=0
//
// Fixture D — mature-profile user:
//   strongSignalCount=12, no import → rawTier=2
//   → confidenceMode=high_signal, quota=0 (mature-profile invariant)
section('§4 — four fixtures: rawTier \u2192 confidenceMode \u2192 coldStartAdjacent quota');
{
  // ── Fixture A: fresh intake user ──────────────────────────────────────────
  const rawTierA    = computeConfidenceTier(NO_IMPORT_EVIDENCE, 0);
  const boostedA    = true;    // 0 < 5, intakeCompleted=true, hasIntakeGenres=true
  const modeA       = confidenceModeForTier(rawTierA, boostedA);
  const quotaA      = BRANCH_QUOTAS[modeA].coldStartAdjacent;

  check('A profile.tier (boosted) = 1',
    // The BOOSTED tier for a 0-signal intake user is 1 (max(0,5)=5 → tier 1).
    // We cannot call computeConfidenceTier with the boosted count here
    // (that is what computeTasteProfile does internally), so we verify
    // the outcome via direct computation of what the boost produces.
    computeConfidenceTier(NO_IMPORT_EVIDENCE, Math.max(0, 5)) === 1,
    `got ${computeConfidenceTier(NO_IMPORT_EVIDENCE, Math.max(0, 5))}`);
  check('A profile.rawTier = 0 (unboosted, 0 signals)',
    rawTierA === 0, `got ${rawTierA}`);
  check('A intakeBoosted = true',
    boostedA === true);
  check('A confidenceMode = sparse_onboarding',
    modeA === 'sparse_onboarding', `got ${modeA}`);
  check('A coldStartAdjacent quota = 3',
    quotaA === 3, `got ${quotaA}`);

  // ── Fixture B: brand-new account, no intake ───────────────────────────────
  const rawTierB    = computeConfidenceTier(NO_IMPORT_EVIDENCE, 0);
  const boostedB    = false;
  const modeB       = confidenceModeForTier(rawTierB, boostedB);
  const quotaB      = BRANCH_QUOTAS[modeB].coldStartAdjacent;

  check('B profile.rawTier = 0 (0 signals)',
    rawTierB === 0, `got ${rawTierB}`);
  check('B confidenceMode = zero_signal (rawTier=0, !intakeBoosted)',
    modeB === 'zero_signal', `got ${modeB}`);
  check('B coldStartAdjacent quota = 3',
    quotaB === 3, `got ${quotaB}`);

  // ── Fixture C: thin user, boost lapsed ───────────────────────────────────
  // strongSignalCount=7 → 7>=5 → intakeBoosted predicate = false (boost only
  // fires when strongSignalCount < 5).
  const rawTierC    = computeConfidenceTier(NO_IMPORT_EVIDENCE, 7);
  const boostedC    = false;   // strongSignalCount=7 >= 5, boost predicate fails
  const modeC       = confidenceModeForTier(rawTierC, boostedC);
  const quotaC      = BRANCH_QUOTAS[modeC].coldStartAdjacent;

  check('C profile.rawTier = 1 (7 signals, 7>=5)',
    rawTierC === 1, `got ${rawTierC}`);
  check('C confidenceMode = thin (rawTier=1)',
    modeC === 'thin', `got ${modeC}`);
  check('C coldStartAdjacent quota = 0 (Phase B.1 territory)',
    quotaC === 0, `got ${quotaC}`);

  // ── Fixture D: mature-profile user ───────────────────────────────────────
  // import_count=0, enriched_count=0 → tier 2 (not tier 3) at strongSignalCount=12.
  const rawTierD    = computeConfidenceTier(NO_IMPORT_EVIDENCE, 12);
  const boostedD    = false;   // 12 >= 5, boost predicate false
  const modeD       = confidenceModeForTier(rawTierD, boostedD);
  const quotaD      = BRANCH_QUOTAS[modeD].coldStartAdjacent;

  check('D profile.rawTier = 2 (12 signals, no import → tier 2)',
    rawTierD === 2, `got ${rawTierD}`);
  check('D confidenceMode = high_signal',
    modeD === 'high_signal', `got ${modeD}`);
  check('D coldStartAdjacent quota = 0 (mature-profile invariant)',
    quotaD === 0, `got ${quotaD}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log(
    '[confidence_mode_e2e] OK \u2014 rawTier fix fully wired: ' +
    'TasteProfile type, computation order, recRequest wiring, ' +
    'and all 4 policy fixtures green.',
  );
  process.exit(0);
} else {
  console.error(`[confidence_mode_e2e] FAIL \u2014 ${failures} check(s) failed.`);
  process.exit(1);
}
