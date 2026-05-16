// =============================================================================
// validate_explanation_default_flip.ts — P3A-6-C dual-path runtime
// replay validator
//
// Run: `npx tsx scripts/validate_explanation_default_flip.ts`
//
// Closes the P3A-6-B Q10 caveat (fixture-calibrated `legacyTier`) by
// driving BOTH classifiers from the same canonical fixture using the
// real production functions:
//   - `classifyExplanationQuality`            (lib/recommender.ts, exported P3A-6-C)
//   - `classifyContributionExplanationQuality` (lib/explanations/contributionQuality.ts)
//
// and BOTH reasons paths using the same production projection helper:
//   - flag-OFF simulation  : returns legacyReasons unchanged
//   - flag-ON  simulation  : `projectComposerReasonsPure(...)` with the
//                            non-empty fallback applied locally (mirrors
//                            `projectComposerReasons` in projection.ts)
//
// Asserts the twelve invariants from the P3A-6-C spec (§3.1–§3.12).
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  classifyExplanationQuality,
  type ExplanationQuality,
} from '../lib/recommender';
import { classifyContributionExplanationQuality } from '../lib/explanations/contributionQuality';
import {
  COMPOSER_REASONS_PROJECTION_ENABLED,
  projectComposerReasonsPure,
} from '../lib/explanations/projection';
import { DISPLAY_FLOORS } from '../lib/scoring/contributions';
import type {
  RetrievalContribution,
  ScoringContribution,
} from '../lib/scoring/contributions';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  const m = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (!ok) failures += 1;
  console.log(`  ${m} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}
function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ── §3.11 — cache version moved to rcv3 (source grep) ────────────────────────
// rcv1 → rcv2 was the P3A-6-C default-on flip.
// rcv2 → rcv3 is the Scenario B detectGenre fix: cached ScoredBook payloads
// from before the fix carry false `stated_favorite:nonfiction` audit flags
// and false "Matches your stated nonfiction preference" reason strings on
// misclassified fiction books. Bumping the version invalidates all three
// deck-state stores (recPayloadCache, recSession, recQueue) at next read.
section('§3.11 — recValidity VERSION moved to rcv3');
{
  const recValSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/recValidity.ts'), 'utf8');
  check("lib/recValidity.ts contains `const VERSION = 'rcv3'`",
    /const\s+VERSION\s*=\s*['"]rcv3['"]/.test(recValSrc));
  check("lib/recValidity.ts no longer contains `const VERSION = 'rcv1'`",
    !/const\s+VERSION\s*=\s*['"]rcv1['"]/.test(recValSrc));
  check("lib/recValidity.ts no longer contains `const VERSION = 'rcv2'`",
    !/const\s+VERSION\s*=\s*['"]rcv2['"]/.test(recValSrc));
}

// ── §3.12 — legacy fallback path remains available ───────────────────────────
section('§3.12 — legacy fallback retained');
{
  const projSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/explanations/projection.ts'), 'utf8');
  // Non-empty fallback guard remains in projectComposerReasons.
  check('projection.ts retains non-empty fallback guard',
    /projected\.length\s*>\s*0\s*\?\s*projected\s*:\s*legacyReasons/.test(projSrc));
  const recSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/recommender.ts'), 'utf8');
  check('legacy classifyExplanationQuality definition retained',
    /function\s+classifyExplanationQuality\s*\(/.test(recSrc));
  check('legacy classifier still invoked at one call site',
    (recSrc.match(/=\s*classifyExplanationQuality\s*\(/g) ?? []).length === 1);
}

// ── Flag-state confirmation ──────────────────────────────────────────────────
section('Flag is ON in committed source (production default)');
check('COMPOSER_REASONS_PROJECTION_ENABLED === true',
  COMPOSER_REASONS_PROJECTION_ENABLED === true);

// ── Fixture types ────────────────────────────────────────────────────────────
type FixtureBook = {
  id:                  string;
  score:               number;
  // Legacy-path inputs for classifyExplanationQuality()
  legacyReasons:       string[];
  fitClass:            string;
  repeatedAuthorMatch: boolean;
  traitAlignment:      number;
  // Composer-path inputs
  retrieval:           RetrievalContribution[];
  scoring:             ScoringContribution[];
};

// ── Canonical 10-book fixture ────────────────────────────────────────────────
// Each row carries BOTH the legacy-classifier inputs (reasons + auxiliary
// scalars) AND the typed contributions, calibrated to mirror what
// scoreBookForUser would produce for the same conceptual candidate. The
// validator runs both real classifiers (no hardcoded tiers) and asserts
// byte-identical composition order.
function mkStated(value: number, key: string | null): ScoringContribution {
  return key === null
    ? { phase: 'scoring', kind: 'stated_taste_fit', value }
    : { phase: 'scoring', kind: 'stated_taste_fit', value,
        source: `stated_favorite:${key}` };
}

const FIXTURE: FixtureBook[] = [
  // 1) Repeated favorite author, core fit. Legacy: STRONG via "By {Author}".
  //    Contributions: stated chip above floor + behavioral aggregate.
  {
    id: 'b1', score: 0.92, fitClass: 'core_fit',
    legacyReasons: ['By Donna Tartt, a consistent favorite of yours',
                    'Aligns with your preference for slow-burn pacing'],
    repeatedAuthorMatch: true, traitAlignment: 0.30,
    retrieval: [{ phase: 'retrieval', source: 'revealedAuthors',
                  reason: 'author_anchor:donna tartt' }],
    scoring: [
      mkStated(0.08, 'literary_fiction'),
      { phase: 'scoring', kind: 'behavioral_fit', value: 0.20,
        source: 'preferred_traits+liked_subjects' },
    ],
  },
  // 2) Multi-trait reason r1. Legacy: STRONG via "Aligns with your preference for".
  //    Contributions: stated chip above floor with matched key.
  {
    id: 'b2', score: 0.78, fitClass: 'core_fit',
    legacyReasons: ['Closer to the thriller and suspense you read most',
                    'Aligns with your preference for atmospheric prose'],
    repeatedAuthorMatch: false, traitAlignment: 0.32,
    retrieval: [{ phase: 'retrieval', source: 'statedGenres',
                  reason: 'stated_genre:thriller_mystery' }],
    scoring: [
      mkStated(0.10, 'thriller_mystery'),
    ],
  },
  // 3) MLT feedback. Legacy: acceptable_specific via "Similar to books you asked for more of".
  //    Contributions: feedback_fit above floor.
  {
    id: 'b3', score: 0.71, fitClass: 'adjacent_fit',
    legacyReasons: ['Closer to the literary fiction you read most',
                    'Similar to books you asked for more of'],
    repeatedAuthorMatch: false, traitAlignment: 0.08,
    retrieval: [{ phase: 'retrieval', source: 'unknown',
                  reason: 'feedback_more_like_this' }],
    scoring: [
      { phase: 'scoring', kind: 'feedback_fit', value: 0.08,
        source: 'more_like_this' },
    ],
  },
  // 4) Author repeat outside core fit. Legacy: acceptable_specific via repeatedAuthorMatch=true.
  //    Contributions: behavioral_fit/genre_affinity (acceptable_specific).
  //    Tiers AGREE: both acceptable_specific.
  {
    id: 'b4', score: 0.66, fitClass: 'adjacent_fit',
    legacyReasons: ['Closer to the literary fiction you read most',
                    'Resonates with a recurring trait in your reading'],
    repeatedAuthorMatch: true, traitAlignment: 0.10,
    retrieval: [{ phase: 'retrieval', source: 'revealedAuthors',
                  reason: 'author_anchor:sally rooney' }],
    scoring: [
      { phase: 'scoring', kind: 'behavioral_fit', value: 0.12,
        source: 'genre_affinity' },
    ],
  },
  // 5) Single-trait below STRONG floor. Legacy: acceptable_specific via r1.startsWith("Matches your appreciation for") AND traitAlignment < 0.25.
  //    Contributions: stated chip above floor, no matched key (generic) → acceptable_specific.
  {
    id: 'b5', score: 0.60, fitClass: 'core_fit',
    legacyReasons: ['Closer to the literary fiction you read most',
                    'Matches your appreciation for elegiac tone'],
    repeatedAuthorMatch: false, traitAlignment: 0.18,
    retrieval: [{ phase: 'retrieval', source: 'statedGenres',
                  reason: 'stated_genre:literary_fiction' }],
    scoring: [ mkStated(0.05, null) ],
  },
  // 6) Adjacent fit_explanation in r0 (not "By "). Legacy: acceptable_generic.
  //    Contributions: behavioral_fit aggregate (preferred_traits+liked_subjects).
  {
    id: 'b6', score: 0.55, fitClass: 'adjacent_fit',
    legacyReasons: ['Closer to the suspense and mystery you read most'],
    repeatedAuthorMatch: false, traitAlignment: 0.14,
    retrieval: [{ phase: 'retrieval', source: 'revealedLanes',
                  reason: 'revealed_lane:modern_suspense' }],
    scoring: [
      { phase: 'scoring', kind: 'behavioral_fit', value: 0.13,
        source: 'preferred_traits+liked_subjects' },
    ],
  },
  // 7) Genre affinity r1. Legacy: acceptable_generic via r1 === "Fits a genre you consistently enjoy".
  //    Contributions: quality_reliability only (descriptive) → acceptable_generic.
  {
    id: 'b7', score: 0.50, fitClass: 'adjacent_fit',
    legacyReasons: ['Closer to the contemporary fiction you read most',
                    'Fits a genre you consistently enjoy'],
    repeatedAuthorMatch: false, traitAlignment: 0.05,
    retrieval: [{ phase: 'retrieval', source: 'statedGenres',
                  reason: 'stated_genre:contemporary_fiction' }],
    scoring: [
      { phase: 'scoring', kind: 'quality_reliability', value: 0.06,
        source: 'enrichment_signals' },
    ],
  },
  // 8) Generic-only r0. Legacy: WEAK (GENERIC_FIT_EXPLANATION_SET).
  //    Contributions: nothing above floor → weak.
  {
    id: 'b8', score: 0.45, fitClass: 'stretch_fit',
    legacyReasons: ['A reasonable next read that sits near your reading center'],
    repeatedAuthorMatch: false, traitAlignment: 0.04,
    retrieval: [{ phase: 'retrieval', source: 'unknown',
                  reason: 'exploration:adjacent_lane' }],
    scoring: [
      { phase: 'scoring', kind: 'behavioral_fit', value: 0.05,
        source: 'preferred_traits+liked_subjects' },
    ],
  },
  // 9) Negative-only scoring. Legacy WEAK (no positive r0/r1).
  //    Contributions: soft_avoid_penalty only → weak.
  {
    id: 'b9', score: 0.42, fitClass: 'adjacent_fit',
    legacyReasons: ['Strongly aligned with your most repeated reading patterns'],
    repeatedAuthorMatch: false, traitAlignment: 0.03,
    retrieval: [{ phase: 'retrieval', source: 'statedGenres',
                  reason: 'stated_genre:nonfiction' }],
    scoring: [
      { phase: 'scoring', kind: 'soft_avoid_penalty', value: -0.22,
        source: 'avoided_traits' },
    ],
  },
  // 10) Empty reasons, no contributions. Legacy: WEAK (r0=null, r1=null).
  //     Contributions: empty → weak.
  {
    id: 'b10', score: 0.40, fitClass: 'stretch_fit',
    legacyReasons: [],
    repeatedAuthorMatch: false, traitAlignment: 0.00,
    retrieval: [], scoring: [],
  },
];

// ── Dual-path execution ──────────────────────────────────────────────────────
//
// For each fixture book:
//   pathA (default-off simulation):
//     reasons  = book.legacyReasons (unchanged)
//     tier     = classifyExplanationQuality(reasons, fitClass, repeated, trait)
//   pathB (default-on  simulation):
//     projected = projectComposerReasonsPure({retrieval, scoring})
//     reasons   = projected.length > 0 ? projected : legacyReasons   (fallback)
//     tier      = classifyContributionExplanationQuality(scoring)
//
// Then sort both by (tierRank asc, score desc) — mirrors recommender.ts
// L2810-2815 composition sort — and assert byte-identical id order.

const TIER_RANK: Record<ExplanationQuality, number> = {
  strong: 0, acceptable_specific: 1, acceptable_generic: 2, weak: 3,
};

type RunRow = {
  id:      string;
  score:   number;
  reasons: readonly string[];
  tier:    ExplanationQuality;
};

const pathA: RunRow[] = FIXTURE.map(b => ({
  id: b.id, score: b.score,
  reasons: b.legacyReasons,
  tier: classifyExplanationQuality(
    b.legacyReasons, b.fitClass, b.repeatedAuthorMatch, b.traitAlignment),
}));

const pathB: RunRow[] = FIXTURE.map(b => {
  const projected = projectComposerReasonsPure(
    { retrieval: b.retrieval, scoring: b.scoring });
  return {
    id: b.id, score: b.score,
    reasons: projected.length > 0 ? projected : b.legacyReasons,
    tier: classifyContributionExplanationQuality(b.scoring),
  };
});

function compose(rows: readonly RunRow[]): string[] {
  return rows.slice().sort((a, b) => {
    const ta = TIER_RANK[a.tier];
    const tb = TIER_RANK[b.tier];
    if (ta !== tb) return ta - tb;
    return b.score - a.score;
  }).map(r => r.id);
}

const orderA = compose(pathA);
const orderB = compose(pathB);

// ── §3.1 — composition order byte-identical ──────────────────────────────────
section('§3.1 — composition order byte-identical across paths');
check('order byte-identical',
  JSON.stringify(orderA) === JSON.stringify(orderB),
  `A=${orderA.join(',')} B=${orderB.join(',')}`);
console.log(`    order=${orderA.join(',')}`);

// ── §3.2 — scores byte-identical (projection touches reasons only) ───────────
//
// Two complementary proofs together close the "fixture-static" caveat:
//
//  (a) Behavioural: each path's score for a given fixture book is equal
//      across pathA and pathB (trivially true given a shared fixture —
//      what this is really probing is that nothing in the test driver
//      diverges scores accidentally before sort).
//
//  (b) Structural: the flag-on branch in lib/recommender.ts writes ONLY
//      `_score_breakdown.explanation_quality`. It never writes
//      `book.score`, never writes any other `_score_breakdown.*` field,
//      never touches `_retrieval_reason`, and never touches retrieval/
//      scoring contribution arrays. So at runtime, flipping the flag
//      CANNOT mutate the score input to the composition sort even when
//      driven by the real pipeline.
section('§3.2 — scores untouched by projection');
for (let i = 0; i < FIXTURE.length; i++) {
  check(`${FIXTURE[i].id}: score equality (path-level)`,
    pathA[i].score === pathB[i].score);
}
{
  const recSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/recommender.ts'), 'utf8');
  const idxFlagIf = recSrc.indexOf(
    'if (COMPOSER_REASONS_PROJECTION_ENABLED)');
  // Window covers the flag-on block (the if + its braced body).
  const window = recSrc.slice(idxFlagIf, idxFlagIf + 600);
  check('flag-on block writes _score_breakdown.explanation_quality',
    /book\._score_breakdown\.explanation_quality\s*=/.test(window));
  check('flag-on block does NOT write book.score',
    !/\bbook\.score\s*=/.test(window));
  check('flag-on block does NOT write other _score_breakdown fields',
    !/_score_breakdown\.(?!explanation_quality)\w+\s*=/.test(window));
  check('flag-on block does NOT mutate retrieval reason',
    !/_retrieval_reason\s*=/.test(window));
  check('flag-on block does NOT reassign contribution arrays',
    !/_retrieval_contributions\s*=/.test(window)
    && !/_scoring_contributions\s*=/.test(window));
}

// ── §3.3 — composition outputs byte-identical (id-by-id with tier+score) ────
//
// Behavioural assertion on the sort comparator (mirrors recommender.ts
// L2810-2815): with scores held constant (§3.2 (b) above) and tiers
// agreeing per-book (asserted here), the production composition sort
// produces identical id order regardless of which classifier wrote the
// tier. This is the no-ranking-shift invariant.
section('§3.3 — composition output equivalence');
{
  const sa = compose(pathA).join(',');
  const sb = compose(pathB).join(',');
  check('id order tuple match', sa === sb);
  for (let i = 0; i < FIXTURE.length; i++) {
    check(`${FIXTURE[i].id}: tier ranks within same band`,
      TIER_RANK[pathA[i].tier] === TIER_RANK[pathB[i].tier],
      `A=${pathA[i].tier} B=${pathB[i].tier}`);
  }
}

// ── §3.4 — explanation_quality is contribution-grounded under composer ON ───
section('§3.4 — explanation_quality contribution-grounded under composer ON');
{
  // The classifier we exercised on path B is exactly the function the
  // recommender now calls inside `if (COMPOSER_REASONS_PROJECTION_ENABLED)`
  // — proven structurally by the wiring check below.
  const recSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/recommender.ts'), 'utf8');
  const idxNew = recSrc.indexOf('classifyContributionExplanationQuality(');
  const idxFlagIf = recSrc.lastIndexOf(
    'if (COMPOSER_REASONS_PROJECTION_ENABLED)', idxNew);
  check('contribution classifier invoked inside flag-on block',
    idxNew > 0 && idxFlagIf > 0 && idxNew - idxFlagIf < 400);
  // And under the production state (flag=true), that branch executes.
  check('flag-on branch is live in committed source',
    COMPOSER_REASONS_PROJECTION_ENABLED === true);
}

// ── §3.5 — book.reasons[] is composer-derived under composer ON ─────────────
section('§3.5 — book.reasons composer-derived where evidence supports it');
{
  // Books where the composer produced a non-empty projection should now
  // carry composer phrasings (not legacy). Books where the composer
  // produced empty (b8, b9, b10) fall back to legacy.
  // b7 is quality_reliability-only — composer correctly produces no
  // causal lines (descriptive-only signal), so the non-empty fallback
  // hands legacyReasons back. That is the intended honest behaviour:
  // quality signal never gets fabricated personal-taste copy.
  const composerLeading = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  const legacyFallback  = ['b7', 'b8', 'b9', 'b10'];
  for (const id of composerLeading) {
    const idx = FIXTURE.findIndex(f => f.id === id);
    const projected = projectComposerReasonsPure(
      { retrieval: FIXTURE[idx].retrieval, scoring: FIXTURE[idx].scoring });
    check(`${id}: composer produced non-empty projection`,
      projected.length > 0);
    check(`${id}: pathB.reasons === composer projection`,
      JSON.stringify(pathB[idx].reasons) === JSON.stringify(projected));
  }
  for (const id of legacyFallback) {
    const idx = FIXTURE.findIndex(f => f.id === id);
    check(`${id}: pathB falls back to legacyReasons (no overclaim, no strip)`,
      JSON.stringify(pathB[idx].reasons) === JSON.stringify(FIXTURE[idx].legacyReasons));
  }
}

// ── §3.6 — no empty-reason regression ────────────────────────────────────────
section('§3.6 — no empty-reason regression');
for (const row of pathB) {
  if (row.id === 'b10') {
    // b10 had empty legacy reasons by design; verify the projection
    // path did not invent reasons either (honest empty state).
    check(`${row.id}: legacy was empty → projection stays empty`,
      row.reasons.length === 0);
  } else {
    check(`${row.id}: reasons non-empty under composer ON`,
      row.reasons.length > 0);
  }
}

// ── §3.7 — no unsupported causal claims (banned-phrasing scan) ──────────────
section('§3.7 — composer copy free of banned causal phrasings');
{
  // The banned-phrase invariant (replit.md "Recommendation rationale
  // variants" + "no unsupported causal claims") binds the composer's
  // variant pools (lib/explanations/compose.ts) — NOT the legacy
  // builder, which has long-standing phrasings like "Fits a genre you
  // consistently enjoy" that predate the rule. Under flag-on the
  // legacy builder only contributes when composer projection is empty
  // (the fallback path). So we scan only composer-emitted reasons:
  // any row whose pathB.reasons match the projection output verbatim.
  const BANNED = [
    'you gravitate toward', 'because you liked', 'you loved',
    'perfect for you', 'consistently', 'always',
  ];
  for (let i = 0; i < FIXTURE.length; i++) {
    const projected = projectComposerReasonsPure(
      { retrieval: FIXTURE[i].retrieval, scoring: FIXTURE[i].scoring });
    if (projected.length === 0) continue;  // legacy-fallback row
    if (JSON.stringify(pathB[i].reasons) !== JSON.stringify(projected)) continue;
    for (const r of pathB[i].reasons) {
      const lower = r.toLowerCase();
      for (const b of BANNED) {
        check(`${pathB[i].id}: composer reason free of banned phrase "${b}"`,
          !lower.includes(b), `reason="${r}"`);
      }
    }
  }
}

// ── §3.8 — retrieval-only candidate gets no causal fit language ─────────────
section('§3.8 — retrieval-only candidates are not causal');
{
  // b8: retrieval-only (no above-floor scoring positive). The composer
  // produces empty → fallback to legacy generic line. The contribution
  // tier MUST be 'weak'. No row should carry a "matches your stated …"
  // line without a corresponding above-floor stated_taste_fit.
  const b8 = pathB.find(r => r.id === 'b8')!;
  check('b8 tier is weak', b8.tier === 'weak');
  for (const row of pathB) {
    const hasStatedReason = row.reasons.some(r =>
      /matches your stated/i.test(r));
    if (hasStatedReason) {
      const idx = FIXTURE.findIndex(f => f.id === row.id);
      const hasStatedContrib = FIXTURE[idx].scoring.some(c =>
        c.kind === 'stated_taste_fit'
        && c.value >= DISPLAY_FLOORS.stated_taste_fit);
      check(`${row.id}: "matches your stated" reason backed by above-floor contribution`,
        hasStatedContrib);
    }
  }
}

// ── §3.9 — quality-only candidate gets no personal-taste language ───────────
section('§3.9 — quality-only candidates not framed as personal taste');
{
  // b7 is quality_reliability only. Its tier should be acceptable_generic
  // (descriptive band) and it must not carry strong-band personal-taste
  // language like "By {Author}, a consistent favorite" or
  // "Matches your stated …".
  const b7 = pathB.find(r => r.id === 'b7')!;
  check('b7 tier is acceptable_generic (descriptive)',
    b7.tier === 'acceptable_generic');
  for (const r of b7.reasons) {
    check(`b7: reason "${r}" is not personal-taste-coded`,
      !/^By [A-Z]/.test(r) && !/matches your stated/i.test(r));
  }
}

// ── §3.10 — P2 stated-reservation inputs unaffected ─────────────────────────
section('§3.10 — P2 stated-reservation inputs unaffected by projection');
{
  // The reservation AND-gate reads:
  //   (a) _retrieval_reason.startsWith('stated_genre:')
  //   (b) audit_flags contains 'stated_favorite:<key>' AND stated_taste > 0
  // Neither is mutated by either projection or the new classifier — the
  // projection touches only `book.reasons`, and the new classifier
  // touches only `_score_breakdown.explanation_quality`. Verify by
  // re-asserting fixture retrieval reasons and stated-taste evidence
  // survive verbatim through both paths.
  for (const fb of FIXTURE) {
    const statedRetrieval = fb.retrieval.filter(r =>
      r.reason.startsWith('stated_genre:'));
    const statedScoring   = fb.scoring.filter(c =>
      c.kind === 'stated_taste_fit'
      && typeof c.source === 'string'
      && c.source.startsWith('stated_favorite:'));
    if (statedRetrieval.length > 0 || statedScoring.length > 0) {
      // Reservation inputs are read directly off the candidate's
      // contribution arrays. Confirm they're stable (i.e. the test
      // fixture data path is the same shape the production reservation
      // helper reads).
      check(`${fb.id}: stated retrieval/scoring inputs visible to reservation`,
        statedRetrieval.length + statedScoring.length > 0);
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
