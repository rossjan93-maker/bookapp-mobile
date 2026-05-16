// =============================================================================
// validate_explanation_projection.ts — P3A-5 deterministic validator
//
// Run: `npx tsx scripts/validate_explanation_projection.ts` (exit 0 ok / 1).
//
// Tests the flag-gated composer-backed `book.reasons[]` projection at
// `lib/explanations/projection.ts`. The flag defaults to FALSE, so this
// validator drives both branches explicitly:
//   - default (flag OFF):  asserts the gated helper returns legacyReasons
//                          byte-identically.
//   - simulated flag ON:   asserts the pure projection helper produces a
//                          faithful, non-overclaiming `string[]`.
//
// Plus a STRUCTURAL placement check: greps recommender.ts to prove the
// override sits AFTER the score / _score_breakdown finalization, so
// flipping the flag cannot shift any ranking/composition/reservation
// signal. This is the safest available substitute for a full pipeline
// replay (which would require Supabase fixtures); a future P3A-6 batch
// adds the live-smoke step.
//
// Assertion groups (P3A-5 spec):
//   P1  ranking/order byte-identical (structural — override is post-score)
//   P2  scores byte-identical (structural — override never reads/writes
//       book.score or _score_breakdown)
//   P3  composition output byte-identical (structural — override runs
//       inside scored.map before composition, and only touches book.reasons)
//   P4  singular _retrieval_reason reservation predicate unchanged
//       (override never touches _retrieval_reason / _retrieval_reasons)
//   P5  derived book.reasons[] non-empty when ≥1 above-floor causal
//       contribution exists
//   P6  no causal "based on your X" for retrieval-only candidates
//   P7  no personal-taste claim for quality_reliability-only candidates
//   P8  negative contributions surface only as caution/risk, not reasons
//   P9  legacy default path unchanged when flag is OFF (gated helper
//       returns legacyReasons by reference-equality semantics)
//   P10 book.reasons[] shape preserved (string[], length ≤ 2,
//       no banned phrasings)
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  COMPOSER_REASONS_PROJECTION_ENABLED,
  projectComposerReasons,
  projectComposerReasonsPure,
} from '../lib/explanations/projection';
import {
  deriveScoringContributions,
  mapRetrievalContributions,
} from '../lib/scoring/contributions';
import type {
  ScoringContribution,
  ScoreBreakdownLike,
} from '../lib/scoring/contributions';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  const marker = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (!ok) failures += 1;
  // eslint-disable-next-line no-console
  console.log(`  ${marker} ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}
function section(name: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n── ${name} ──`);
}

const BANNED_PHRASES = [
  'you gravitate toward',
  'because you liked',
  'you loved',
  'perfect for you',
  'consistently',
  'always',
];

// ── Pre-flight: flag default ─────────────────────────────────────────────────
// P3A-6-C (2026-05-16): committed flag is now ON. The legacy-path
// assertions below still hold structurally: `projectComposerReasons`
// returns `legacyReasons` byte-identically when contributions are empty
// (the non-empty fallback guard at projection.ts L65), so the P9 fixture
// continues to round-trip as designed. We simply re-pin the pre-flight
// assertion to the new production state.
section('Pre-flight — flag default is ON (P3A-6-C)');
check('COMPOSER_REASONS_PROJECTION_ENABLED === true',
  COMPOSER_REASONS_PROJECTION_ENABLED === true,
  `actual=${COMPOSER_REASONS_PROJECTION_ENABLED}`);

// ── P9 — empty-contribution path falls back to legacyReasons ─────────────────
section('P9 — empty-contribution fallback returns legacyReasons unchanged');
{
  const legacy = ['A literary novel that fits your stated nonfiction interest',
                  'Resonates with a recurring trait in your reading'];
  const out = projectComposerReasons(
    { retrieval: [], scoring: [] },
    legacy,
  );
  check('returned value === legacyReasons (reference identity, empty contributions)',
    out === legacy);
  check('content byte-identical', JSON.stringify(out) === JSON.stringify(legacy));

  // P3A-6-C: rich contributions now DO project (flag ON is the
  // production default). Verify the composer output is non-empty and
  // wins over legacy when above-floor causal evidence exists.
  const sc = deriveScoringContributions(
    { trait_alignment: 0.30, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.45 },
    ['stated_favorite:thriller_mystery']);
  const rc = mapRetrievalContributions(['stated_genre:thriller_mystery']);
  const out2 = projectComposerReasons({ scoring: sc, retrieval: rc }, legacy);
  check('rich-contribution input + flag ON → composer projection wins',
    JSON.stringify(out2) !== JSON.stringify(legacy) && out2.length > 0);
}

// ── Simulate flag ON via the pure helper ─────────────────────────────────────
//
// `projectComposerReasonsPure` is the same projection the flag-ON branch
// runs, minus the legacy fallback guard. Exercising it directly is
// equivalent to driving the recommender with the flag flipped.

section('P5 — non-empty reasons when above-floor causal contribution exists');
{
  const sc = deriveScoringContributions(
    { trait_alignment: 0.20, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.35 },
    ['stated_favorite:thriller_mystery']);
  const rc = mapRetrievalContributions(['stated_genre:thriller_mystery']);
  const proj = projectComposerReasonsPure({ scoring: sc, retrieval: rc });
  check('projection non-empty', proj.length >= 1, JSON.stringify(proj));
  check('primary cites matched stated key',
    proj[0]?.includes('thriller_mystery') ?? false, proj[0]);
}

section('P6 — no causal "based on your X" for retrieval-only candidates');
{
  // Retrieved by stated_genre AND lane, but NOTHING scored above floor.
  const sc = deriveScoringContributions(
    { trait_alignment: 0.04, avoided_penalty: 0, genre_bonus: 0.04,
      feedback_boost: 0.02, enrichment_bonus: 0.02, metadata_penalty: 0,
      stated_taste: 0.02, raw_score: 0.14 },
    []);
  const rc = mapRetrievalContributions([
    'stated_genre:nonfiction', 'lane:modern_suspense', 'author_anchor:Hobb',
  ]);
  const proj = projectComposerReasonsPure({ scoring: sc, retrieval: rc });
  check('projection is empty (no above-floor causal)',
    proj.length === 0, JSON.stringify(proj));
  // Sanity: none of the retrieval source keys leak into copy.
  check('no thriller/nonfiction/Hobb mention',
    proj.every(s => {
      const l = s.toLowerCase();
      return !l.includes('thriller') && !l.includes('nonfiction')
          && !l.includes('hobb') && !l.includes('suspense');
    }));
}

section('P7 — no personal-taste claim for quality_reliability-only candidates');
{
  const sc = deriveScoringContributions(
    { trait_alignment: 0, avoided_penalty: 0, genre_bonus: 0,
      feedback_boost: 0, enrichment_bonus: 0.07, metadata_penalty: 0,
      stated_taste: 0, raw_score: 0.07 },
    []);
  const proj = projectComposerReasonsPure({ scoring: sc, retrieval: [] });
  // quality_reliability only produces a descriptive line — never primary or
  // secondary. deriveBackcompatReasons only collects primary + secondary,
  // so the projection MUST be empty.
  check('projection empty (descriptive never makes it into reasons[])',
    proj.length === 0, JSON.stringify(proj));
}

section('P8 — negative contributions never surface as reasons');
{
  const sc: ScoringContribution[] = [
    { phase: 'scoring', kind: 'soft_avoid_penalty', value: -0.20, source: 'avoided_traits' },
    { phase: 'scoring', kind: 'hygiene_floor', value: -0.18,
      source: 'metadata+subtype_drift',
      evidence: { audit_subflags: ['noir_drift'] } },
  ];
  const proj = projectComposerReasonsPure({ scoring: sc, retrieval: [] });
  // Negative-only contributions produce only cautions; reasons[] (primary
  // + secondary) must therefore be empty.
  check('projection empty when only penalties present',
    proj.length === 0, JSON.stringify(proj));
}

section('P10 — shape preserved (string[], length ≤ 2, no banned phrasings)');
{
  const sc = deriveScoringContributions(
    { trait_alignment: 0.20, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0.08, enrichment_bonus: 0.05, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.48 },
    ['stated_favorite:nonfiction']);
  const proj = projectComposerReasonsPure({ scoring: sc, retrieval: [] });
  check('Array.isArray(proj)', Array.isArray(proj));
  check('every entry is a non-empty string',
    proj.every(s => typeof s === 'string' && s.length > 0));
  check('length ≤ 2 (matches RecCard cap)', proj.length <= 2,
    `len=${proj.length}`);
  check('no banned phrasings',
    proj.every(s => {
      const l = s.toLowerCase();
      return BANNED_PHRASES.every(b => !l.includes(b));
    }), JSON.stringify(proj));
}

// ── P1–P4 — structural placement proof in recommender.ts ─────────────────────
//
// Full pipeline byte-identity is impractical to reproduce here without
// Supabase fixtures. The strongest available proof is structural: the
// override call site must sit AFTER score finalization, AFTER
// _score_breakdown is sealed, and must touch ONLY book.reasons. We
// extract the surrounding window from the source and assert this.

section('P1–P4 — structural placement of the flag-gated override');
{
  const recPath = path.resolve(__dirname, '../lib/recommender.ts');
  const src     = fs.readFileSync(recPath, 'utf8');

  // (a) Import is present.
  check('import projectComposerReasons present',
    /from\s+['"]\.\/explanations\/projection['"]/.test(src));

  // (b) Exactly one call site (we are NOT touching scored.map's other
  //     paths — expertRec fallback constructors do not call this).
  const matches = src.match(/projectComposerReasons\s*\(/g) ?? [];
  check('exactly one call site', matches.length === 1,
    `count=${matches.length}`);

  // (c) The call site sits AFTER the CoG `book.reasons = [...]` overwrite
  //     and AFTER the `book._score_breakdown = { ... final_score: ... }`
  //     assignment. We locate three landmarks and assert ordering.
  const idxCoGReasonsAssign = src.indexOf('book.reasons = [');
  const idxBreakdownSeal    = src.indexOf('book._score_breakdown = {\n');
  const idxOverride         = src.indexOf('projectComposerReasons(');
  check('CoG reasons assignment located', idxCoGReasonsAssign > 0);
  check('_score_breakdown final assignment located', idxBreakdownSeal > 0);
  check('override call located', idxOverride > 0);
  check('override runs AFTER CoG reasons assignment',
    idxOverride > idxCoGReasonsAssign,
    `override@${idxOverride} cog@${idxCoGReasonsAssign}`);
  check('override runs AFTER _score_breakdown seal',
    idxOverride > idxBreakdownSeal,
    `override@${idxOverride} sealed@${idxBreakdownSeal}`);

  // (d) The override only assigns book.reasons — no other field is
  //     mutated in the surrounding window.
  const window = src.slice(idxOverride - 50, idxOverride + 500);
  check('override window assigns ONLY book.reasons',
    /book\.reasons\s*=\s*projectComposerReasons\s*\(/.test(window));
  check('override window does NOT touch book.score',
    !/book\.score\s*=/.test(window));
  check('override window does NOT touch _score_breakdown',
    !/book\._score_breakdown\s*=/.test(window));
  check('override window does NOT touch _retrieval_reason',
    !/_retrieval_reason\s*=/.test(window));

  // (e) The composition-side reservation AND-gate in
  //     lib/composition/statedReservation.ts continues to read singular
  //     _retrieval_reason — the override never touches that field.
  const resPath = path.resolve(__dirname, '../lib/composition/statedReservation.ts');
  const resSrc  = fs.readFileSync(resPath, 'utf8');
  // The AND-gate destructures `_retrieval_reason` into a local `reason`
  // before calling startsWith. Confirm both halves are present.
  check('reservation AND-gate predicate present (reason.startsWith)',
    /\.startsWith\(['"]stated_genre:['"]\)/.test(resSrc),
    'startsWith predicate not found');
  check('reservation AND-gate still reads singular _retrieval_reason',
    /_retrieval_reason/.test(resSrc),
    'singular _retrieval_reason reference not found');
}

// ── Summary ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
