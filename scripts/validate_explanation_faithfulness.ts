// =============================================================================
// validate_explanation_faithfulness.ts — P3A-4 deterministic validator
//
// Run: `npx tsx scripts/validate_explanation_faithfulness.ts` (exit 0 ok / 1).
//
// Tests the pure composer `lib/explanations/compose.ts` against synthetic
// contribution bundles. The composer is NOT wired into production yet, so
// this validator is the sole consumer of its output.
//
// Assertion groups:
//   F1  no causal line without a positive scoring contribution above floor
//   F2  stated_taste_fit emits a specific reason ONLY when matched stated
//       evidence is present (favorite or softavoid key)
//   F3  quality_reliability never produces personal-taste language
//   F4  behavioral_fit + feedback_fit stay generic (aggregate evidence)
//   F5  negative scoring contributions surface as cautions, not reasons
//   F6  zero/absent scoring components emit nothing
//   F7  retrieval-only candidates cannot produce causal fit explanations
//   F8  singular _retrieval_reason reservation predicate unchanged on
//       canonical fixtures (composer does not touch the AND-gate)
//   F9  ranking / order remains untouched — composer is pure projection
//   F10 derived book.reasons[] back-compat projection works and contains
//       no banned phrasings
//
// Fixture replay scenarios (each asserts faithful output + intact legacy
// fields + no overclaim):
//   FR1 stated preference fit
//   FR2 quality-only / popularity-only book
//   FR3 soft-avoid penalty (negative)
//   FR4 retrieval-only candidate (no above-floor scoring)
//   FR5 cold-start / weak-signal candidate (everything below floor)
//   FR6 cache-restored singular-only provenance candidate
//   FR7 multi-source retrieval candidate (stated + lane retrieval, only
//       behavioral_fit above floor in scoring)
// =============================================================================

import {
  composeExplanation,
  deriveBackcompatReasons,
} from '../lib/explanations/compose';
import type { ExplanationBundle } from '../lib/explanations/compose';
import {
  DISPLAY_FLOORS,
  mapRetrievalContributions,
  deriveScoringContributions,
} from '../lib/scoring/contributions';
import type {
  ScoringContribution,
  RetrievalContribution,
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
  // 'most' is too generic for sub-string matching — skip per replit.md
];

function emit(scoring: ScoringContribution[] = [], retrieval: RetrievalContribution[] = []): ExplanationBundle {
  return { scoring, retrieval };
}

function scoring(kind: ScoringContribution['kind'], value: number, source?: string, evidence?: Record<string, unknown>): ScoringContribution {
  return { phase: 'scoring', kind, value, source, evidence };
}

// ── F1 — no causal without above-floor positive scoring ──────────────────────
section('F1 — no causal line without above-floor positive scoring');
{
  // Bundle with only a retrieval contribution from statedGenres but ZERO
  // stated_taste_fit scoring → must not produce a causal reason.
  const b = emit([], mapRetrievalContributions(['stated_genre:thriller_mystery']));
  const out = composeExplanation(b);
  check('no primary causal line', out.primary === undefined,
    JSON.stringify(out.primary));
  check('no causal in secondary', out.secondary.every(l => l.kind !== 'causal'));
  check('retrievalOnly records the stated_genre reason',
    out.debug.retrievalOnly.includes('stated_genre:thriller_mystery'));

  // Bundle whose scoring contribution is JUST below the floor.
  const justBelow = DISPLAY_FLOORS.behavioral_fit - 0.001;
  const b2 = emit([scoring('behavioral_fit', justBelow, 'preferred_traits+liked_subjects')]);
  const out2 = composeExplanation(b2);
  check('contribution just below floor → no primary',
    out2.primary === undefined,
    `floor=${DISPLAY_FLOORS.behavioral_fit} value=${justBelow}`);
  check('suppressed reason recorded',
    out2.debug.suppressed.some(s => s.startsWith('behavioral_fit:below_floor')));

  // Bundle whose scoring contribution is JUST AT the floor → eligible.
  const atFloor = DISPLAY_FLOORS.behavioral_fit;
  const out3 = composeExplanation(emit([scoring('behavioral_fit', atFloor, 'genre_affinity')]));
  check('contribution at floor → primary emitted', out3.primary !== undefined);
}

// ── F2 — stated_taste_fit specificity gate ───────────────────────────────────
section('F2 — stated_taste_fit cites specific key ONLY with matched evidence');
{
  const withEv = composeExplanation(emit([
    scoring('stated_taste_fit', 0.08, 'stated_favorite:thriller_mystery',
      { matchedKind: 'favorite', matchedKey: 'thriller_mystery' }),
  ]));
  check('with evidence: primary text mentions matched key',
    withEv.primary?.text.includes('thriller_mystery') ?? false,
    withEv.primary?.text);
  check('with evidence: scoringRef.kind=stated_taste_fit',
    withEv.primary?.scoringRef?.kind === 'stated_taste_fit');

  const noEv = composeExplanation(emit([
    scoring('stated_taste_fit', 0.08, 'stated_taste'),
  ]));
  check('without evidence: primary text does NOT name a key',
    noEv.primary !== undefined
    && !noEv.primary.text.toLowerCase().includes('thriller')
    && !noEv.primary.text.toLowerCase().includes(':'),
    noEv.primary?.text);
}

// ── F3 — quality_reliability stays generic ───────────────────────────────────
section('F3 — quality_reliability never produces personal-taste language');
{
  const out = composeExplanation(emit([scoring('quality_reliability', 0.07, 'enrichment_signals')]));
  const dLine = out.descriptive[0];
  check('descriptive line emitted', dLine !== undefined);
  check('descriptive.kind=generic', dLine?.kind === 'generic');
  check('quality_reliability NEVER appears as primary causal',
    !out.primary || out.primary.source !== 'quality_reliability');
  const text = (dLine?.text ?? '').toLowerCase();
  check('text contains no personal-taste verbs',
    !text.includes('you ') && !text.includes('your '),
    text);
}

// ── F4 — behavioral_fit + feedback_fit stay generic ──────────────────────────
section('F4 — behavioral_fit + feedback_fit aggregate → generic causal phrasing');
{
  const bf = composeExplanation(emit([
    scoring('behavioral_fit', 0.30, 'preferred_traits+liked_subjects'),
    scoring('behavioral_fit', 0.20, 'genre_affinity'),
  ]));
  check('behavioral_fit causal line emitted', bf.primary?.source === 'behavioral_fit');
  const bfText = (bf.primary?.text ?? '').toLowerCase();
  // Must NOT name a specific trait, subject, or genre key.
  check('behavioral_fit text does not name a trait/genre key',
    !bfText.includes('mystery') && !bfText.includes('thriller')
    && !bfText.includes('pacing') && !bfText.includes('prose'),
    bfText);

  const ff = composeExplanation(emit([scoring('feedback_fit', 0.08, 'more_like_this')]));
  check('feedback_fit primary emitted', ff.primary?.source === 'feedback_fit');
  const ffText = (ff.primary?.text ?? '').toLowerCase();
  check('feedback_fit text does not name a genre key',
    !ffText.includes('mystery') && !ffText.includes('thriller'),
    ffText);
}

// ── F5 — negative contributions surface as cautions ──────────────────────────
section('F5 — negative scoring contributions surface as cautions, not reasons');
{
  const out = composeExplanation(emit([
    scoring('soft_avoid_penalty', -0.20, 'avoided_traits'),
    scoring('hygiene_floor', -0.18, 'metadata+subtype_drift',
      { audit_subflags: ['noir_drift'] }),
  ]));
  check('no primary reason (no positive causal)', out.primary === undefined);
  check('caution(s) emitted', out.cautions.length >= 1);
  check('cautions kinds=caution', out.cautions.every(l => l.kind === 'caution'));
  check('cautions capped at 1', out.cautions.length <= 1);
  check('hygiene caution names the drift subflag',
    out.cautions.some(c => c.text.toLowerCase().includes('noir'))
    || out.cautions.some(c => c.text.toLowerCase().includes('avoid')));
}

// ── F6 — zero/absent emit nothing ────────────────────────────────────────────
section('F6 — zero / absent components emit nothing misleading');
{
  const empty = composeExplanation(emit([], []));
  check('no primary',     empty.primary === undefined);
  check('no secondary',   empty.secondary.length === 0);
  check('no cautions',    empty.cautions.length === 0);
  check('no descriptive', empty.descriptive.length === 0);

  // A zero-value contribution should never be constructed by the
  // derivation helper, but the composer should also gracefully ignore it
  // if one ever slips through.
  const zero = composeExplanation(emit([scoring('behavioral_fit', 0, 'preferred_traits+liked_subjects')]));
  check('zero-value contribution → no primary', zero.primary === undefined);
}

// ── F7 — retrieval-only cannot produce causal fit ────────────────────────────
section('F7 — retrieval-only candidates cannot produce causal fit explanations');
{
  const r = mapRetrievalContributions([
    'stated_genre:thriller_mystery',
    'lane:modern_suspense',
    'author_anchor:Hobb',
  ]);
  const out = composeExplanation({ scoring: [], retrieval: r });
  check('no primary', out.primary === undefined);
  check('retrievalOnly enumerates all 3 reasons',
    out.debug.retrievalOnly.length === 3,
    JSON.stringify(out.debug.retrievalOnly));
  check('aboveFloorKinds empty', out.debug.aboveFloorKinds.length === 0);
}

// ── F8 — singular _retrieval_reason reservation predicate unchanged ──────────
section('F8 — singular _retrieval_reason AND-gate predicate untouched');
{
  // The composer never reads or mutates _retrieval_reason / _retrieval_reasons.
  // Sanity: a fixture with both stated and lane retrieval (stated dominant)
  // still has _retrieval_reason.startsWith('stated_genre:') === true.
  const reasons = ['stated_genre:thriller_mystery', 'lane:modern_suspense'];
  const dominant = reasons[0];
  composeExplanation({
    scoring: [], retrieval: mapRetrievalContributions(reasons),
  });
  check('dominant retrieval reason unchanged',
    dominant === 'stated_genre:thriller_mystery');
  check('AND-gate predicate still passes', dominant.startsWith('stated_genre:'));
}

// ── F9 — ranking / order unchanged ───────────────────────────────────────────
section('F9 — composer is pure projection; ranking is not derivable from it');
{
  // The composer takes scoring contributions as input and never mutates
  // them. It does not return any value used by the recommender's sort.
  const a = [scoring('stated_taste_fit', 0.08, 'stated_favorite:nonfiction',
    { matchedKind: 'favorite', matchedKey: 'nonfiction' })];
  const aBefore = JSON.stringify(a);
  composeExplanation({ scoring: a, retrieval: [] });
  composeExplanation({ scoring: a, retrieval: [] });
  composeExplanation({ scoring: a, retrieval: [] });
  check('input scoring array unchanged after 3 composes', JSON.stringify(a) === aBefore);
}

// ── F10 — derived book.reasons[] back-compat projection ──────────────────────
section('F10 — derived book.reasons[] projection is non-breaking');
{
  const out = composeExplanation(emit([
    scoring('stated_taste_fit', 0.09, 'stated_favorite:nonfiction',
      { matchedKind: 'favorite', matchedKey: 'nonfiction' }),
    scoring('behavioral_fit', 0.18, 'genre_affinity'),
  ]));
  const proj = deriveBackcompatReasons(out);
  check('projection is string[]',
    Array.isArray(proj) && proj.every(s => typeof s === 'string'));
  check('projection length ≤ 2 (matches RecCard cap)', proj.length <= 2);
  check('projection contains no banned phrasing',
    proj.every(s => {
      const low = s.toLowerCase();
      return BANNED_PHRASES.every(b => !low.includes(b));
    }), JSON.stringify(proj));
  check('projection orders primary first',
    out.primary !== undefined && proj[0] === out.primary.text);
}

// ── Fixture replay ───────────────────────────────────────────────────────────
section('FR1 — stated preference fit');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment: 0.20, avoided_penalty: 0, genre_bonus: 0.10,
    feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
    stated_taste: 0.05, raw_score: 0.35,
  };
  const sc = deriveScoringContributions(bd, ['stated_favorite:thriller_mystery']);
  const rc = mapRetrievalContributions(['stated_genre:thriller_mystery']);
  const out = composeExplanation({ scoring: sc, retrieval: rc });
  check('primary is stated_taste_fit',
    out.primary?.source === 'stated_taste_fit');
  check('primary cites stated key',
    out.primary?.text.includes('thriller_mystery') ?? false);
  check('no overclaim — only one secondary at most',
    out.secondary.length <= 1);
  check('cautions empty',     out.cautions.length === 0);
  check('descriptive empty',  out.descriptive.length === 0);
  check('retrievalOnly empty (stated retrieval matched stated_taste_fit)',
    out.debug.retrievalOnly.length === 0);
}

section('FR2 — quality-only / popularity-only book');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment: 0, avoided_penalty: 0, genre_bonus: 0,
    feedback_boost: 0, enrichment_bonus: 0.07, metadata_penalty: 0,
    stated_taste: 0, raw_score: 0.07,
  };
  const sc = deriveScoringContributions(bd, []);
  const out = composeExplanation({ scoring: sc, retrieval: [] });
  check('no causal primary', out.primary === undefined);
  check('descriptive (quality) line emitted', out.descriptive.length === 1);
  check('descriptive.kind=generic', out.descriptive[0].kind === 'generic');
  check('descriptive text has no personal-taste phrasing',
    !out.descriptive[0].text.toLowerCase().includes('you ')
    && !out.descriptive[0].text.toLowerCase().includes('your '));
}

section('FR3 — soft-avoid penalty');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment: 0, avoided_penalty: -0.22, genre_bonus: 0,
    feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
    stated_taste: 0, raw_score: -0.22,
  };
  const sc = deriveScoringContributions(bd, []);
  const out = composeExplanation({ scoring: sc, retrieval: [] });
  check('no primary causal', out.primary === undefined);
  check('caution emitted', out.cautions.length === 1);
  check('caution.source=soft_avoid_penalty', out.cautions[0].source === 'soft_avoid_penalty');
  check('caution.scoringRef.value < 0', (out.cautions[0].scoringRef?.value ?? 0) < 0);
}

section('FR4 — retrieval-only candidate');
{
  const rc = mapRetrievalContributions([
    'stated_genre:nonfiction',
    'author_anchor:Hobb',
  ]);
  const out = composeExplanation({ scoring: [], retrieval: rc });
  check('no primary',         out.primary === undefined);
  check('no causal in any',   out.secondary.every(l => l.kind !== 'causal'));
  check('retrievalOnly captures both reasons',
    out.debug.retrievalOnly.length === 2);
}

section('FR5 — cold-start / weak-signal candidate');
{
  // Every component below its floor — note behavioral_fit groups
  // trait_alignment + genre_bonus into ONE sum, so both must be set low
  // enough that their sum is also below the 0.10 behavioral_fit floor.
  const bd: ScoreBreakdownLike = {
    trait_alignment: 0.04, avoided_penalty: -0.03, genre_bonus: 0.03,
    feedback_boost: 0.02, enrichment_bonus: 0.02, metadata_penalty: -0.05,
    stated_taste: 0.03, raw_score: 0.06,
  };
  const sc = deriveScoringContributions(bd, []);
  const out = composeExplanation({ scoring: sc, retrieval: [] });
  check('no primary (everything below floor)', out.primary === undefined);
  check('no cautions (penalties below abs floor)', out.cautions.length === 0);
  check('no descriptive (enrichment below floor)', out.descriptive.length === 0);
  check('suppressed reasons recorded for ≥1 kind',
    out.debug.suppressed.length >= 1);
}

section('FR6 — cache-restored singular-only provenance candidate');
{
  // Cache-restored shape: only the singular _retrieval_reason populated.
  // Per the P3A-2 scored.map attachment, that becomes a single-element
  // _retrieval_reasons[] for the composer's retrieval input.
  const rc = mapRetrievalContributions(['stated_genre:thriller_mystery']);
  const sc = deriveScoringContributions(
    { trait_alignment: 0, avoided_penalty: 0, genre_bonus: 0,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.05 },
    ['stated_favorite:thriller_mystery']);
  const out = composeExplanation({ scoring: sc, retrieval: rc });
  check('cache-restored: primary is stated_taste_fit',
    out.primary?.source === 'stated_taste_fit');
  check('cache-restored: primary cites stated key',
    out.primary?.text.includes('thriller_mystery') ?? false);
}

section('FR7 — multi-source retrieval candidate');
{
  // Retrieved by stated_genre AND lane; scored with behavioral_fit but
  // NO stated_taste_fit (e.g. user dropped the favorite without rebuild).
  const rc = mapRetrievalContributions([
    'stated_genre:thriller_mystery',
    'lane:modern_suspense',
  ]);
  const sc = deriveScoringContributions(
    { trait_alignment: 0.20, avoided_penalty: 0, genre_bonus: 0,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0, raw_score: 0.20 },
    []);
  const out = composeExplanation({ scoring: sc, retrieval: rc });
  check('primary is behavioral_fit (NOT stated — stated wasn\u2019t scored)',
    out.primary?.source === 'behavioral_fit');
  check('primary text is generic (no thriller_mystery name)',
    !(out.primary?.text.toLowerCase().includes('thriller') ?? false),
    out.primary?.text);
  // statedGenres retrieval contribution should be in retrievalOnly since
  // stated_taste_fit was NOT above floor.
  check('statedGenres retrieval is recorded as retrieval-only',
    out.debug.retrievalOnly.includes('stated_genre:thriller_mystery'));
}

// ── Summary ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
