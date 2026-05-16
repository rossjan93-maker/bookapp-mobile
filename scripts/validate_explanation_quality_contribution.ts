// =============================================================================
// validate_explanation_quality_contribution.ts — P3A-6-B deterministic
// validator
//
// Run: `npx tsx scripts/validate_explanation_quality_contribution.ts`
//
// Covers ten assertion groups from the P3A-6-B spec:
//   Q1  flag-OFF behavior unchanged (recompute branch is structurally
//       gated — proven by source grep)
//   Q2  legacy classifier remains active when flag is OFF (recommender
//       L2189 call still present and uncondictioned)
//   Q3  contribution-based classifier wired only when flag is ON
//   Q4  contribution-quality tiers match the intended mapping
//   Q5  quality-only candidates do not classify as 'strong' /
//       'acceptable_specific' (descriptive-only)
//   Q6  retrieval-only candidates classify as 'weak'
//   Q7  stated_taste_fit with matched key classifies 'strong'
//   Q8  stated_taste_fit without matched key does not classify 'strong'
//   Q9  negative-only candidates classify 'weak'
//  Q10  composition sort order byte-identical pre/post flag-on on a
//       canonical 10-book fixture (no-ranking-shift proof)
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

import { classifyContributionExplanationQuality } from '../lib/explanations/contributionQuality';
import type { ExplanationQuality } from '../lib/explanations/contributionQuality';
import { COMPOSER_REASONS_PROJECTION_ENABLED } from '../lib/explanations/projection';
import {
  deriveScoringContributions,
  DISPLAY_FLOORS,
} from '../lib/scoring/contributions';
import type { ScoringContribution } from '../lib/scoring/contributions';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  const m = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (!ok) failures += 1;
  console.log(`  ${m} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}
function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ── Pre-flight ───────────────────────────────────────────────────────────────
// P3A-6-C (2026-05-16): committed flag is now ON in production. The
// classifier itself is pure and flag-agnostic, so all mapping
// assertions (Q4–Q9) hold under either flag state; the Q1/Q2/Q3 wiring
// checks below continue to verify the `if (COMPOSER_REASONS_PROJECTION_ENABLED)`
// guard is structurally present so a future flag-toggle never bypasses
// the recompute.
section('Pre-flight — committed flag is ON (P3A-6-C)');
check('COMPOSER_REASONS_PROJECTION_ENABLED === true',
  COMPOSER_REASONS_PROJECTION_ENABLED === true);

// ── Q1 / Q2 / Q3 — wiring and gating (structural source greps) ──────────────
section('Q1 / Q2 / Q3 — wiring and gating');
{
  const recPath = path.resolve(__dirname, '../lib/recommender.ts');
  const src     = fs.readFileSync(recPath, 'utf8');

  // Q2: legacy classifier is defined exactly once AND invoked at exactly
  // one production call site. We distinguish:
  //   - definition  : `function classifyExplanationQuality(`
  //   - real call   : `= classifyExplanationQuality(` (assignment-form,
  //                    excludes comments and the definition itself)
  // The bare-token grep `classifyExplanationQuality(` also matches doc
  // comments, so we use the assignment-form regex to pin down the actual
  // runtime call site without false positives.
  const legacyDefs  = src.match(/function\s+classifyExplanationQuality\s*\(/g) ?? [];
  const legacyCalls = src.match(/=\s*classifyExplanationQuality\s*\(/g) ?? [];
  check('legacy classifyExplanationQuality defined exactly once',
    legacyDefs.length === 1, `defs=${legacyDefs.length}`);
  check('legacy classifyExplanationQuality invoked at exactly one call site',
    legacyCalls.length === 1, `calls=${legacyCalls.length}`);

  // Q3: new classifier imported and called exactly once.
  const newCalls = src.match(/\bclassifyContributionExplanationQuality\s*\(/g) ?? [];
  check('classifyContributionExplanationQuality imported + called once',
    newCalls.length === 1, `count=${newCalls.length}`);
  check('import of contributionQuality present',
    /from\s+['"]\.\/explanations\/contributionQuality['"]/.test(src));

  // Q1 + Q3: call is wrapped in the flag conditional.
  const idxNew    = src.indexOf('classifyContributionExplanationQuality(');
  const idxFlagIf = src.lastIndexOf('if (COMPOSER_REASONS_PROJECTION_ENABLED)', idxNew);
  check('new classifier call is inside `if (COMPOSER_REASONS_PROJECTION_ENABLED)` block',
    idxFlagIf > 0 && idxNew - idxFlagIf < 400,
    `flagIf@${idxFlagIf} new@${idxNew}`);

  // Q1 (structural): the new branch sits AFTER the projection override,
  // which itself sits AFTER `_score_breakdown` is sealed. So flag OFF =
  // legacy classifier wrote explanation_quality and the new branch never
  // runs.
  const idxProjection = src.indexOf('projectComposerReasons(');
  check('flag-gated recompute runs AFTER projection override',
    idxNew > idxProjection,
    `proj@${idxProjection} new@${idxNew}`);

  // Q1: the new branch ONLY writes _score_breakdown.explanation_quality —
  // no other field is mutated.
  const window = src.slice(idxFlagIf, idxFlagIf + 600);
  check('flag-gated window writes ONLY explanation_quality',
    /book\._score_breakdown\.explanation_quality\s*=/.test(window));
  check('flag-gated window does NOT touch book.score',
    !/\bbook\.score\s*=/.test(window));
  check('flag-gated window does NOT touch book.reasons',
    !/\bbook\.reasons\s*=/.test(window));
  check('flag-gated window does NOT touch _retrieval_reason',
    !/\b_retrieval_reason\s*=/.test(window));
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function mkStated(value: number, key: string | null): ScoringContribution {
  return key === null
    ? { phase: 'scoring', kind: 'stated_taste_fit', value }
    : { phase: 'scoring', kind: 'stated_taste_fit', value,
        source: `stated_favorite:${key}` };
}

// ── Q4 / Q7 / Q8 — mapping ───────────────────────────────────────────────────
section('Q4 / Q7 / Q8 — mapping');
{
  // Q7 — stated_taste_fit with matched key (via source) → strong
  check('stated_taste_fit + key → strong',
    classifyContributionExplanationQuality([
      mkStated(DISPLAY_FLOORS.stated_taste_fit, 'literary_fiction'),
    ]) === 'strong');

  // Q7 — matched key via evidence.matchedKey also → strong
  check('stated_taste_fit + evidence.matchedKey → strong',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'stated_taste_fit',
        value: DISPLAY_FLOORS.stated_taste_fit,
        evidence: { matchedKey: 'thriller_mystery', matchedKind: 'favorite' } },
    ]) === 'strong');

  // Q8 — stated_taste_fit above floor, no matched key, no source →
  //      acceptable_specific (NOT strong).
  check('stated_taste_fit (no key, no source) → acceptable_specific',
    classifyContributionExplanationQuality([
      mkStated(DISPLAY_FLOORS.stated_taste_fit, null),
    ]) === 'acceptable_specific');

  // Q4 — behavioral_fit (genre_affinity) → acceptable_specific
  check('behavioral_fit/genre_affinity → acceptable_specific',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'behavioral_fit',
        value: DISPLAY_FLOORS.behavioral_fit, source: 'genre_affinity' },
    ]) === 'acceptable_specific');

  // Q4 — behavioral_fit (aggregate) → acceptable_generic
  check('behavioral_fit/aggregate → acceptable_generic',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'behavioral_fit',
        value: DISPLAY_FLOORS.behavioral_fit,
        source: 'preferred_traits+liked_subjects' },
    ]) === 'acceptable_generic');

  // Q4 — feedback_fit → acceptable_specific
  check('feedback_fit → acceptable_specific',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'feedback_fit',
        value: DISPLAY_FLOORS.feedback_fit, source: 'more_like_this' },
    ]) === 'acceptable_specific');

  // Q4 — strongest-wins: stated+key beats everything else.
  check('strongest-wins: stated+key + behavioral → strong',
    classifyContributionExplanationQuality([
      mkStated(0.08, 'literary_fiction'),
      { phase: 'scoring', kind: 'behavioral_fit',
        value: 0.15, source: 'preferred_traits+liked_subjects' },
    ]) === 'strong');

  // Q4 — below floor → ignored.
  check('below-floor contributions ignored → weak',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'behavioral_fit',
        value: 0.05, source: 'genre_affinity' },
      mkStated(0.02, 'literary_fiction'),
    ]) === 'weak');
}

// ── Q5 — quality-only candidate is descriptive (acceptable_generic max) ─────
section('Q5 — quality_reliability is descriptive-only');
{
  check('quality_reliability above floor + nothing else → acceptable_generic',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'quality_reliability',
        value: DISPLAY_FLOORS.quality_reliability, source: 'enrichment_signals' },
    ]) === 'acceptable_generic');

  // Quality + a real positive → the real positive wins, not quality.
  check('quality + stated+key → strong (not generic)',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'quality_reliability',
        value: 0.07, source: 'enrichment_signals' },
      mkStated(0.06, 'literary_fiction'),
    ]) === 'strong');

  // Quality alone below floor → weak (no descriptive surface).
  check('quality below floor + nothing else → weak',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'quality_reliability',
        value: 0.02, source: 'enrichment_signals' },
    ]) === 'weak');
}

// ── Q6 — retrieval-only candidate → weak ─────────────────────────────────────
section('Q6 — retrieval-only → weak');
{
  // No scoring contributions above floor (retrieval-only by definition of
  // this classifier: it only consumes scoring contributions, so a
  // retrieval-only candidate has nothing to feed it).
  check('empty contributions → weak',
    classifyContributionExplanationQuality([]) === 'weak');

  // All scoring contributions below floor (mirrors P3A-5 P6 fixture).
  check('all-below-floor → weak',
    classifyContributionExplanationQuality(
      deriveScoringContributions(
        { trait_alignment: 0.04, avoided_penalty: 0, genre_bonus: 0.04,
          feedback_boost: 0.02, enrichment_bonus: 0.02, metadata_penalty: 0,
          stated_taste: 0.02, raw_score: 0.14 },
        [])
    ) === 'weak');
}

// ── Q9 — negative-only → weak ────────────────────────────────────────────────
section('Q9 — negative contributions never raise the tier');
{
  check('soft_avoid_penalty only → weak',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'soft_avoid_penalty',
        value: -0.22, source: 'avoided_traits' },
    ]) === 'weak');
  check('hygiene_floor only → weak',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'hygiene_floor',
        value: -0.18, source: 'metadata+subtype_drift' },
    ]) === 'weak');
  // A real positive co-existing with negatives still classifies on its
  // own merits (negatives ignored, not subtracted).
  check('positive + negative → positive tier wins',
    classifyContributionExplanationQuality([
      { phase: 'scoring', kind: 'soft_avoid_penalty',
        value: -0.22, source: 'avoided_traits' },
      mkStated(0.08, 'literary_fiction'),
    ]) === 'strong');
}

// ── Q10 — 10-book composition sort byte-identity ─────────────────────────────
//
// Canonical 10-book fixture. For each book we carry:
//   - score          : drives the within-tier secondary sort
//   - legacyTier     : the tier the production-default classifier produces
//                      for this book's legacy reasons (hardcoded — the
//                      legacy classifier is a private function of
//                      lib/recommender.ts and isn't exported; we encode
//                      its verdict directly from the L435+ rules)
//   - contributions  : the typed contributions the new classifier reads
//
// The fixture is calibrated so legacyTier == contributionTier for every
// row. The validator computes the composition sort under both tier
// assignments and asserts the resulting id order is byte-identical.
//
// This is the strongest no-ranking-shift proof available without
// exporting the legacy classifier: any production candidate whose
// contributions agree with its legacy reasons (the common case after
// P3A-3 scoring contributions were derived directly from the same
// _score_breakdown that drives the legacy reasons builder) will produce
// no swap when the flag flips.
section('Q10 — no-ranking-shift on 10-book fixture');
{
  type Row = {
    id:            string;
    score:         number;
    legacyTier:    ExplanationQuality;
    contributions: ScoringContribution[];
  };

  const fixture: Row[] = [
    // 1) Repeated favorite author + above-floor stated match → legacy=strong
    //    via 'By {Author}' prefix OR via stated chip; contributions=strong
    //    via stated_taste_fit + matched key.
    { id: 'b1', score: 0.92, legacyTier: 'strong',
      contributions: [
        mkStated(0.08, 'literary_fiction'),
        { phase: 'scoring', kind: 'behavioral_fit', value: 0.20,
          source: 'preferred_traits+liked_subjects' },
      ] },
    // 2) Strong stated chip, lower score.
    { id: 'b2', score: 0.78, legacyTier: 'strong',
      contributions: [
        mkStated(0.10, 'thriller_mystery'),
      ] },
    // 3) acceptable_specific — feedback_fit MLT.
    { id: 'b3', score: 0.71, legacyTier: 'acceptable_specific',
      contributions: [
        { phase: 'scoring', kind: 'feedback_fit', value: 0.08,
          source: 'more_like_this' },
      ] },
    // 4) acceptable_specific — behavioral_fit/genre_affinity.
    { id: 'b4', score: 0.66, legacyTier: 'acceptable_specific',
      contributions: [
        { phase: 'scoring', kind: 'behavioral_fit', value: 0.12,
          source: 'genre_affinity' },
      ] },
    // 5) acceptable_specific — stated_taste_fit without matched key
    //    (legacy: 'Matches your appreciation for …' below SINGLE_TRAIT
    //    floor → acceptable_specific).
    { id: 'b5', score: 0.60, legacyTier: 'acceptable_specific',
      contributions: [
        mkStated(0.05, null),
      ] },
    // 6) acceptable_generic — behavioral_fit aggregate.
    { id: 'b6', score: 0.55, legacyTier: 'acceptable_generic',
      contributions: [
        { phase: 'scoring', kind: 'behavioral_fit', value: 0.13,
          source: 'preferred_traits+liked_subjects' },
      ] },
    // 7) acceptable_generic — quality_reliability only.
    { id: 'b7', score: 0.50, legacyTier: 'acceptable_generic',
      contributions: [
        { phase: 'scoring', kind: 'quality_reliability', value: 0.06,
          source: 'enrichment_signals' },
      ] },
    // 8) weak — all below floor.
    { id: 'b8', score: 0.45, legacyTier: 'weak',
      contributions: [
        { phase: 'scoring', kind: 'behavioral_fit', value: 0.05,
          source: 'preferred_traits+liked_subjects' },
      ] },
    // 9) weak — negative-only.
    { id: 'b9', score: 0.42, legacyTier: 'weak',
      contributions: [
        { phase: 'scoring', kind: 'soft_avoid_penalty', value: -0.22,
          source: 'avoided_traits' },
      ] },
    // 10) weak — empty.
    { id: 'b10', score: 0.40, legacyTier: 'weak',
      contributions: [] },
  ];

  // Per-book agreement: contribution_tier == legacyTier.
  for (const row of fixture) {
    const ct = classifyContributionExplanationQuality(row.contributions);
    check(`${row.id}: contribution tier matches legacy (${row.legacyTier})`,
      ct === row.legacyTier, `got=${ct}`);
  }

  // Composition sort: explanationTier asc, score desc (mirrors
  // lib/recommender.ts L2810-2815).
  const TIER_RANK: Record<ExplanationQuality, number> = {
    strong: 0, acceptable_specific: 1, acceptable_generic: 2, weak: 3,
  };
  const sortBy = (
    rows: readonly Row[],
    tierOf: (r: Row) => ExplanationQuality,
  ): string[] => rows.slice().sort((a, b) => {
    const ta = TIER_RANK[tierOf(a)];
    const tb = TIER_RANK[tierOf(b)];
    if (ta !== tb) return ta - tb;
    return b.score - a.score;
  }).map(r => r.id);

  const legacyOrder = sortBy(fixture, r => r.legacyTier);
  const newOrder    = sortBy(fixture,
    r => classifyContributionExplanationQuality(r.contributions));

  check('composition sort order byte-identical pre/post flag-on',
    JSON.stringify(legacyOrder) === JSON.stringify(newOrder),
    `legacy=${legacyOrder.join(',')} new=${newOrder.join(',')}`);
  console.log(`    order=${legacyOrder.join(',')}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
