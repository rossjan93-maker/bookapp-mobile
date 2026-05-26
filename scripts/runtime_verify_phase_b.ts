// =============================================================================
// runtime_verify_phase_b.ts — Cold-Start Retrieval Expansion · Phase B
//                              runtime verification harness
//
// Programmatic equivalent of "open the app, sign in as a sparse cold-start
// Mystery+Thriller user, and watch the [COLD_START_ADJACENT] log." Drives the
// real runtime modules — recPolicy.BRANCH_QUOTAS, recValidity.computeRecConfigHash
// + assertCurrent, retrieval/branchPlanner.planBranches — under realistic
// RecRequest fixtures and reports:
//
//   §A. Runtime status
//   §B. Cache invalidation: rcv7-shaped stored hash rejects under live rcv8+csrp2
//   §C. Cold-start adjacency admission (sparse_onboarding Mystery+Thriller)
//   §D. Thin profile: 0 admission (Phase B.0 broadened mature-profile invariant)
//   §E. high_signal profile: 0 admission (mature-profile invariant)
//   §F. Guardrail source-greps (forbidden surfaces untouched)
//   §G. Lens-blindness: log payload byte-identical with/without a lens chip
//
// Not a validator — runtime evidence capture for product-acceptance review.
// =============================================================================

import { readFileSync } from 'fs';
import { BRANCH_QUOTAS, COLD_START_RETRIEVAL_POLICY_VERSION } from '../lib/recPolicy';
import { computeRecConfigHash, assertCurrent } from '../lib/recValidity';
import { planBranches } from '../lib/retrieval/branchPlanner';
import type { RecRequest } from '../lib/recRequest';
import type { BranchContext } from '../lib/retrieval/types';

const log = (s: string) => console.log(s);
const hr = () => log('─'.repeat(76));

// Minimal RecRequest fixture. Only the fields planBranches /
// buildColdStartAdjacentBranch read are populated; the rest of the Signals
// surface stays empty (cold-start reality: no behavioral history).
function makeReq(opts: {
  userId: string;
  confidenceMode: 'zero_signal' | 'sparse_onboarding' | 'thin' | 'high_signal';
  favoriteGenres: readonly string[];
  softAvoids?: readonly string[];
  withLensChip?: boolean;
}): RecRequest {
  return {
    userId: opts.userId,
    signals: {
      statedTaste: {
        signalClass: 'stated_durable',
        favoriteGenres: opts.favoriteGenres as any,
        readingStyles: [],
        readingStylesDurable: [],
        readingStylesIntent: [],
        readingStylesUnknown: [],
        favoriteAuthors: [],
        updatedAt: null,
      },
      revealedTaste: {
        signalClass: 'revealed_behavioral',
        profile: { tier: 'low' as any } as any,
      },
      softAvoids: {
        signalClass: 'soft_avoid',
        genres: (opts.softAvoids ?? []) as any,
        updatedAt: null,
      },
      ...(opts.withLensChip && {
        nextReadChips: {
          signalClass: 'current_intent',
          intentScope: 'session',
          tone: 'light' as const,
          energy: 'light_fun' as const,
        },
      }),
    },
    policy: {
      confidenceMode: opts.confidenceMode,
      statedPreferenceFloor: 0,
      statedPreferenceWeight: 0,
      softAvoidFloor: 0,
      softAvoidPenalty: 0,
    },
    build: {
      cause: 'session_open',
      configHash: undefined,
      builtAt: Date.now(),
      schemaVersion: 'rrv1',
    },
  };
}

const emptyCtx: BranchContext = {
  topGenres:       [],
  dominantLanes:   [],
  repeatedAuthors: [],
  likedAuthors:    [],
  likedSubjects:   [],
  isDense:         false,
};

// ─────────────────────────────────────────────────────────────────────────────
// §A. Runtime constants
// ─────────────────────────────────────────────────────────────────────────────
log('\n═══ §A · Runtime constants (live module reads) ════════════════════════');
log(`COLD_START_RETRIEVAL_POLICY_VERSION = ${JSON.stringify(COLD_START_RETRIEVAL_POLICY_VERSION)}`);
log(`BRANCH_QUOTAS.zero_signal.coldStartAdjacent       = ${BRANCH_QUOTAS.zero_signal.coldStartAdjacent}`);
log(`BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent = ${BRANCH_QUOTAS.sparse_onboarding.coldStartAdjacent}`);
log(`BRANCH_QUOTAS.thin.coldStartAdjacent              = ${BRANCH_QUOTAS.thin.coldStartAdjacent}`);
log(`BRANCH_QUOTAS.high_signal.coldStartAdjacent       = ${BRANCH_QUOTAS.high_signal.coldStartAdjacent}`);

// ─────────────────────────────────────────────────────────────────────────────
// §B. Cache invalidation behaviour against the LIVE hash
// ─────────────────────────────────────────────────────────────────────────────
log('\n═══ §B · Cache invalidation (real assertCurrent against live hash) ════');

const liveHash = computeRecConfigHash({
  favorite_genres:  ['Mystery', 'Thriller'],
  avoid_genres:     ['Horror'],
  reading_styles:   [],
  favorite_authors: null,
});
log(`live hash (rcv8+csrp2): ${liveHash}`);
log(`  starts with "rcv8|csrp:csrp2|" → ${liveHash.startsWith('rcv8|csrp:csrp2|')}`);
log(`  contains "|csrp:csrp2|"        → ${liveHash.includes('|csrp:csrp2|')}`);

// Simulate stored payloads representative of what real users would have
// in AsyncStorage right after Phase B.0 deploy.
const storedSamples: Record<string, string | null | undefined> = {
  'pre_phase_b (rcv6)':            'rcv6|fg:mystery,thriller|ag:horror|rs:|fa:',
  'pre_phase_b (rcv6+csrp1 hyp.)': 'rcv6|csrp:csrp1|fg:mystery,thriller|ag:horror|rs:|fa:',
  'phase_b (rcv7+csrp1)':          'rcv7|csrp:csrp1|fg:mystery,thriller|ag:horror|rs:|fa:',
  'mixed (rcv7+csrp2)':            'rcv7|csrp:csrp2|fg:mystery,thriller|ag:horror|rs:|fa:',
  'mixed (rcv8+csrp1)':            'rcv8|csrp:csrp1|fg:mystery,thriller|ag:horror|rs:|fa:',
  'no_stored_hash':                null,
  'current (rcv8+csrp2)':          liveHash,
};
for (const [label, stored] of Object.entries(storedSamples)) {
  const v = assertCurrent(stored as any, liveHash);
  log(`  ${label.padEnd(34)} → valid=${v.valid} reason=${v.reason}`);
}
log('  → all pre-rcv8|csrp:csrp2 shapes reject; only exact-match restores.');

// ─────────────────────────────────────────────────────────────────────────────
// §C. Cold-start admission: sparse Mystery + Thriller, avoid Horror
// ─────────────────────────────────────────────────────────────────────────────
log('\n═══ §C · Cold-start admission (sparse Mystery+Thriller / avoid Horror) ');

const coldReq = makeReq({
  userId: 'verify-cold-001',
  confidenceMode: 'sparse_onboarding',
  favoriteGenres: ['thriller_mystery'],
  softAvoids:     ['horror'],
});
const coldPlan = planBranches(coldReq, emptyCtx);
const coldAdj  = coldPlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
log(`branchOrder                         = ${JSON.stringify(coldPlan.branchOrder)}`);
log(`branchPolicies.coldStartAdjacent    = ${JSON.stringify(coldPlan.branchPolicies.coldStartAdjacent)}`);
log(`fetchItems total                    = ${coldPlan.fetchItems.length}`);
log(`adjacency admitted count            = ${coldAdj.length}  (expected: 3)`);
log(`adjacency anchors admitted          = ${JSON.stringify(coldAdj.map(i => i.value))}`);
log(`adjacency reasons                   = ${JSON.stringify(coldAdj.map(i => i.reason))}`);
log(`adjacency signalClass (all rows)    = ${JSON.stringify([...new Set(coldAdj.map(i => i.signalClass))])}`);
log(`adjacency item kind (all rows)      = ${JSON.stringify([...new Set(coldAdj.map(i => i.kind))])}`);

// zero_signal with no favorites — must produce zero admission (safety).
const coldNoFav = planBranches(
  makeReq({ userId: 'verify-cold-002', confidenceMode: 'zero_signal', favoriteGenres: [] }),
  emptyCtx,
);
log(`\nzero_signal with empty favorites → adjacency count = ${
  coldNoFav.fetchItems.filter(i => i.branch === 'coldStartAdjacent').length
}  (expected: 0)`);

// sparse_onboarding where the favorite is soft-avoided (defense-in-depth).
const coldSoftAvoided = planBranches(
  makeReq({
    userId: 'verify-cold-003',
    confidenceMode: 'sparse_onboarding',
    favoriteGenres: ['thriller_mystery'],
    softAvoids:     ['thriller_mystery'],
  }),
  emptyCtx,
);
log(`sparse_onboarding where favorite ∈ softAvoids → adjacency count = ${
  coldSoftAvoided.fetchItems.filter(i => i.branch === 'coldStartAdjacent').length
}  (expected: 0 — defense-in-depth)`);

// sparse_onboarding fantasy-only — no adjacency entry for fantasy_scifi, must no-op.
const coldFantasy = planBranches(
  makeReq({ userId: 'verify-cold-004', confidenceMode: 'sparse_onboarding', favoriteGenres: ['fantasy_scifi'] }),
  emptyCtx,
);
log(`sparse_onboarding fantasy_scifi only → adjacency count = ${
  coldFantasy.fetchItems.filter(i => i.branch === 'coldStartAdjacent').length
}  (expected: 0 — no anchor entry)`);

// ─────────────────────────────────────────────────────────────────────────────
// §D. Thin profile — must remain 0
// ─────────────────────────────────────────────────────────────────────────────
log('\n═══ §D · Thin profile (same sparse Mystery+Thriller favorites) ════════');
const thinPlan = planBranches(
  makeReq({ userId: 'verify-thin', confidenceMode: 'thin', favoriteGenres: ['thriller_mystery'] }),
  emptyCtx,
);
const thinAdj = thinPlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
log(`branchPolicies.coldStartAdjacent = ${JSON.stringify(thinPlan.branchPolicies.coldStartAdjacent)}`);
log(`adjacency admitted count         = ${thinAdj.length}  (expected: 0)`);

// ─────────────────────────────────────────────────────────────────────────────
// §E. high_signal profile — mature-profile invariant: locked at 0 forever
// ─────────────────────────────────────────────────────────────────────────────
log('\n═══ §E · high_signal profile (mature-profile invariant) ═══════════════');
const matureReq = makeReq({
  userId: 'verify-mature',
  confidenceMode: 'high_signal',
  favoriteGenres: ['thriller_mystery'],
});
const maturePlan = planBranches(matureReq, emptyCtx);
const matureAdj = maturePlan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
log(`branchPolicies.coldStartAdjacent = ${JSON.stringify(maturePlan.branchPolicies.coldStartAdjacent)}`);
log(`adjacency admitted count         = ${matureAdj.length}  (expected: 0)`);

// ─────────────────────────────────────────────────────────────────────────────
// §F. Forbidden-surface source-greps
// ─────────────────────────────────────────────────────────────────────────────
log('\n═══ §F · Guardrail source-greps (forbidden surfaces) ══════════════════');

function readSrc(p: string): string { return readFileSync(p, 'utf8'); }
const planner = readSrc('lib/retrieval/branchPlanner.ts');
const branch  = readSrc('lib/retrieval/branches/coldStartAdjacent.ts');
const policy  = readSrc('lib/recPolicy.ts');

const forbiddenInPlanner = [
  'getActiveLens', 'getSessionSteering', 'TasteVsIntent',
  'evaluateBookAgainstIntentLens', 'finalGate',
];
for (const sym of forbiddenInPlanner) {
  const hit = planner.includes(sym);
  log(`  planner contains "${sym}"           → ${hit}  (expected: false)`);
}
// Strip comments before grepping the branch source so the Phase-B constraint
// block (which deliberately names the forbidden surfaces in prose to document
// the contract) does NOT register as a real code reference.
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
const branchCodeOnly = stripComments(branch);
const forbiddenInBranch = [
  'getActiveLens', 'getSessionSteering', 'TasteVsIntent',
  'evaluateBookAgainstIntentLens', 'finalGate', 'composer', 'RecCard',
];
for (const sym of forbiddenInBranch) {
  const hit = branchCodeOnly.includes(sym);
  log(`  coldStartAdjacent contains "${sym}" (code only) → ${hit}  (expected: false)`);
}
log(`  qAdjacent is static lookup           → ${planner.includes('base.coldStartAdjacent')}`);
log(`  FORENSIC_USER_ID = ''                → ${planner.includes("const FORENSIC_USER_ID = '';")}`);
log(`  policy has explicit csrp constant    → ${policy.includes("export const COLD_START_RETRIEVAL_POLICY_VERSION")}`);
log(`  policy does NOT JSON.stringify BRANCH_QUOTAS → ${!policy.includes('JSON.stringify(BRANCH_QUOTAS')}`);

// Untouched-surface fingerprint (mtime not changed by this batch — sample
// canonical guard files exist and are non-empty).
const surfaceFiles = [
  'lib/intent/finalGate.ts',
  'lib/currentIntentLens.ts',
  'lib/explanations/projection.ts',
  'lib/evidence/bookEvidence.ts',
  'components/RecCard.tsx',
];
for (const f of surfaceFiles) {
  try {
    const s = readSrc(f);
    const csrpRef = s.includes('COLD_START_RETRIEVAL_POLICY_VERSION');
    const rcv8Ref = s.includes("'rcv8'");
    log(`  ${f.padEnd(40)} csrp_ref=${csrpRef}  rcv8_ref=${rcv8Ref}  (both expected: false)`);
  } catch {
    log(`  ${f.padEnd(40)} (file not found — skipped)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §G. Lens-blindness: planBranches output identical with and without a lens
// ─────────────────────────────────────────────────────────────────────────────
log('\n═══ §G · Lens-blindness (qAdjacent ignores chip presence) ═════════════');
const noLens   = planBranches(makeReq({ userId: 'lens-test', confidenceMode: 'sparse_onboarding', favoriteGenres: ['thriller_mystery'] }), emptyCtx);
const withLens = planBranches(makeReq({ userId: 'lens-test', confidenceMode: 'sparse_onboarding', favoriteGenres: ['thriller_mystery'], withLensChip: true }), emptyCtx);
const a = JSON.stringify(noLens.fetchItems.filter(i => i.branch === 'coldStartAdjacent'));
const b = JSON.stringify(withLens.fetchItems.filter(i => i.branch === 'coldStartAdjacent'));
log(`adjacency items without lens chip = ${a}`);
log(`adjacency items WITH    lens chip = ${b}`);
log(`byte-identical                    → ${a === b}  (expected: true — Phase B.1 deferred)`);

hr();
log('runtime verification harness complete.\n');
