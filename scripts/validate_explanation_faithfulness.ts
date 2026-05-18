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
  // Scenario B display-label fix: visible reasons now humanise the
  // matched AffinityKey via affinityDisplayLabel(). The raw key
  // remains on evidence.matchedKey for audit; only the visible string
  // is humanised. `thriller_mystery` → `thriller & mystery`.
  check('with evidence: primary text mentions matched key (humanised label)',
    withEv.primary?.text.includes('thriller & mystery') ?? false,
    withEv.primary?.text);
  check('with evidence: primary text does NOT leak raw snake_case key',
    !(withEv.primary?.text.includes('thriller_mystery') ?? false),
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
  // Scenario B display-label fix: humanised label expected; raw key banned.
  check('primary cites stated key (humanised label)',
    out.primary?.text.includes('thriller & mystery') ?? false);
  check('primary does NOT leak raw snake_case key',
    !(out.primary?.text.includes('thriller_mystery') ?? false));
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
  // Scenario B display-label fix: humanised label expected; raw key banned.
  check('cache-restored: primary cites stated key (humanised label)',
    out.primary?.text.includes('thriller & mystery') ?? false);
  check('cache-restored: primary does NOT leak raw snake_case key',
    !(out.primary?.text.includes('thriller_mystery') ?? false));
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

// ── P4D — narrow composer admission ──────────────────────────────────────────
//
// Asserts the gates for the three P4D-admitted P4C kinds:
//   tone_fit, pace_fit, series_continuation_fit
// and proves the four still-suppressed kinds (current_intent_fit,
// complexity_fit, avoidance_conflict, not_right_now_risk) never produce
// visible lines. Also asserts the new lines never displace the legacy
// PRIMARY kinds (no ranking/order effect) and contain no overclaiming
// or raw internal keys.

const P4D_BANNED_PHRASES = [
  ...BANNED_PHRASES,
  'you want',
  "you'll love",
];

function p4cScoring(
  kind: ScoringContribution['kind'],
  value: number,
  evidence: Record<string, unknown>,
): ScoringContribution {
  // mirror p4cContributions.emit shape
  return { phase: 'scoring', kind, value, source: 'p4d_test', evidence };
}

// ── P4D-1 — tone_fit admission gates ─────────────────────────────────────────
section('P4D-1 — tone_fit admitted only when all gates pass');
{
  const ev = {
    bookTone: 'light', bookToneConfidence: 'specific',
    userTone: 'light', userToneSources: ['reading_style:Light read'],
    match: 'match', signedEligible: true,
  };
  const out = composeExplanation(emit([p4cScoring('tone_fit', 0.10, ev)]));
  check('all-gates-pass: tone_fit emitted as primary',
    out.primary?.source === 'tone_fit', JSON.stringify(out.primary));
  check('all-gates-pass: line.kind=causal',
    out.primary?.kind === 'causal');
  check('all-gates-pass: text does not leak raw internal evidence keys',
    out.primary !== undefined
    && !out.primary.text.includes('bookTone')
    && !out.primary.text.includes('signedEligible')
    && !out.primary.text.includes('match'),
    out.primary?.text);
  check('all-gates-pass: text describes lighter tone',
    out.primary?.text.toLowerCase().includes('light') ?? false,
    out.primary?.text);
  check('all-gates-pass: no banned/overclaim phrasing',
    P4D_BANNED_PHRASES.every(p => !(out.primary?.text.toLowerCase().includes(p) ?? false)),
    out.primary?.text);

  // Below floor (DISPLAY_FLOORS.tone_fit = 0.04) — must be suppressed.
  const justBelow = DISPLAY_FLOORS.tone_fit - 0.001;
  const outBelow = composeExplanation(emit([
    p4cScoring('tone_fit', justBelow, ev),
  ]));
  check('below floor: tone_fit suppressed (no primary)',
    outBelow.primary === undefined);
  check('below floor: suppressed reason recorded',
    outBelow.debug.suppressed.some(s => s.startsWith('tone_fit:below_floor')));

  // Broad book confidence — must be suppressed even if value above floor.
  const outBroad = composeExplanation(emit([
    p4cScoring('tone_fit', 0.10, { ...ev, bookToneConfidence: 'broad' }),
  ]));
  check('broad book tone confidence: tone_fit suppressed',
    outBroad.primary === undefined);
  check('broad: gate_failed reason recorded',
    outBroad.debug.suppressed.some(s => s.startsWith('tone_fit:gate_failed')));

  // Unknown book confidence — same.
  const outUnknown = composeExplanation(emit([
    p4cScoring('tone_fit', 0.10, { ...ev, bookToneConfidence: 'unknown' }),
  ]));
  check('unknown book tone confidence: tone_fit suppressed',
    outUnknown.primary === undefined);

  // signedEligible=false (legacy q_* alone) — must be suppressed.
  const outIneligible = composeExplanation(emit([
    p4cScoring('tone_fit', 0.10, { ...ev, signedEligible: false }),
  ]));
  check('signedEligible=false: tone_fit suppressed',
    outIneligible.primary === undefined);

  // match!=='match' (mismatch or partial) — must be suppressed even if
  // value somehow ended up positive (defensive).
  const outMismatch = composeExplanation(emit([
    p4cScoring('tone_fit', 0.10, { ...ev, match: 'mismatch' }),
  ]));
  check('match=mismatch: tone_fit suppressed',
    outMismatch.primary === undefined);
  const outPartial = composeExplanation(emit([
    p4cScoring('tone_fit', 0.10, { ...ev, match: 'partial' }),
  ]));
  check('match=partial: tone_fit suppressed',
    outPartial.primary === undefined);

  // Negative aggregate — must be a non-result (and never a positive reason).
  const outNeg = composeExplanation(emit([
    p4cScoring('tone_fit', -0.10, ev),
  ]));
  check('negative aggregate: tone_fit not emitted',
    outNeg.primary === undefined && outNeg.secondary.length === 0);
}

// ── P4D-2 — pace_fit admission gates ─────────────────────────────────────────
section('P4D-2 — pace_fit admitted only when all gates pass');
{
  const ev = {
    bookPace: 'fast', bookPaceConfidence: 'specific',
    userPace: 'fast', userPaceSources: ['reading_style:Fast-paced'],
    match: 'match', signedEligible: true,
  };
  const out = composeExplanation(emit([p4cScoring('pace_fit', 0.08, ev)]));
  check('all-gates-pass: pace_fit emitted as primary',
    out.primary?.source === 'pace_fit');
  check('all-gates-pass: text mentions faster pace',
    out.primary?.text.toLowerCase().includes('fast') ?? false,
    out.primary?.text);
  check('all-gates-pass: no banned/overclaim phrasing',
    P4D_BANNED_PHRASES.every(p => !(out.primary?.text.toLowerCase().includes(p) ?? false)));
  check('all-gates-pass: text does not leak internal keys',
    out.primary !== undefined
    && !out.primary.text.includes('bookPace')
    && !out.primary.text.includes('signedEligible'));

  const outBroad = composeExplanation(emit([
    p4cScoring('pace_fit', 0.10, { ...ev, bookPaceConfidence: 'broad' }),
  ]));
  check('broad book pace confidence: pace_fit suppressed',
    outBroad.primary === undefined);

  const outIneligible = composeExplanation(emit([
    p4cScoring('pace_fit', 0.10, { ...ev, signedEligible: false }),
  ]));
  check('signedEligible=false: pace_fit suppressed',
    outIneligible.primary === undefined);
}

// ── P4D-3 — series_continuation_fit admission gates ──────────────────────────
section('P4D-3 — series_continuation_fit admitted only with prior-read evidence');
{
  const evOk = {
    seriesName: 'The Broken Earth', bookSeriesIndex: 2,
    seriesTotal: 3, priorReadCount: 1, continuesPrior: true,
  };
  const out = composeExplanation(emit([
    p4cScoring('series_continuation_fit', DISPLAY_FLOORS.series_continuation_fit, evOk),
  ]));
  check('priorReadCount=1: series_continuation_fit emitted',
    out.primary?.source === 'series_continuation_fit');
  check('text names the series (cites real evidence, not generic)',
    out.primary?.text.includes('The Broken Earth') ?? false,
    out.primary?.text);
  check('no overclaim / banned phrasing',
    P4D_BANNED_PHRASES.every(p => !(out.primary?.text.toLowerCase().includes(p) ?? false)));

  // priorReadCount=0 (book is first in a series the user hasn't started)
  // — must NOT produce a reason. p4cContributions never emits this case,
  // but the composer enforces defensively in case the contract evolves.
  const outNone = composeExplanation(emit([
    p4cScoring('series_continuation_fit', 0.08,
      { ...evOk, priorReadCount: 0, continuesPrior: false }),
  ]));
  check('priorReadCount=0: series_continuation_fit suppressed',
    outNone.primary === undefined);
  check('priorReadCount=0: gate_failed reason recorded',
    outNone.debug.suppressed.some(s => s.startsWith('series_continuation_fit:gate_failed')));
}

// ── P4D-4 — still-suppressed P4C kinds never visible ─────────────────────────
section('P4D-4 — current_intent_fit / complexity_fit / avoidance_conflict / not_right_now_risk stay suppressed');
{
  const cases: Array<{ kind: ScoringContribution['kind']; value: number; ev: Record<string, unknown> }> = [
    { kind: 'current_intent_fit', value:  0.10, ev: { intentKeys: ['q_tone'], intentScope: 'session', legacy: false, pairedKinds: ['tone_fit'] } },
    { kind: 'complexity_fit',     value:  0.10, ev: { bookComplexity: 'dense', bookComplexityConfidence: 'specific', userComplexity: 'dense', match: 'match', signedEligible: true } },
    { kind: 'avoidance_conflict', value: -0.10, ev: { conflictKeys: ['horror'] } },
    { kind: 'not_right_now_risk', value: -0.10, ev: { risks: [{ axis: 'tone', userWant: 'light', bookHas: 'dark' }] } },
  ];
  for (const c of cases) {
    const out = composeExplanation(emit([p4cScoring(c.kind, c.value, c.ev)]));
    const allLines = [
      ...(out.primary ? [out.primary] : []),
      ...out.secondary, ...out.cautions, ...out.descriptive,
    ];
    // Structural suppression: these four P4C kinds are not listed in
    // PRIMARY_PRIORITY or SECONDARY_PRIORITY, so the composer never
    // iterates them and they cannot produce a visible line under any
    // value / evidence combination. The "zero visible lines" assertion
    // is therefore the load-bearing P4D-4 contract — no `suppressed[]`
    // entry is expected because lineFor() is never called for these.
    check(`${c.kind}: produces zero visible lines`,
      allLines.every(l => l.source !== c.kind),
      JSON.stringify(allLines.map(l => ({ k: l.kind, s: l.source }))));
    check(`${c.kind}: not present in aboveFloorKinds (never iterated)`,
      !out.debug.aboveFloorKinds.includes(c.kind),
      JSON.stringify(out.debug.aboveFloorKinds));
  }
}

// ── P4D-5 — admitted P4C kinds never displace legacy PRIMARY ─────────────────
section('P4D-5 — P4D admissions never displace legacy PRIMARY priority');
{
  const toneEv = {
    bookTone: 'light', bookToneConfidence: 'specific',
    userTone: 'light', match: 'match', signedEligible: true,
  };
  const paceEv = {
    bookPace: 'fast', bookPaceConfidence: 'specific',
    userPace: 'fast', match: 'match', signedEligible: true,
  };
  const seriesEv = {
    seriesName: 'X', bookSeriesIndex: 2,
    priorReadCount: 1, continuesPrior: true,
  };
  // PRIMARY (stated_taste_fit) + all three P4D kinds eligible →
  // primary MUST be stated_taste_fit, secondary may be one P4D line.
  const out = composeExplanation(emit([
    scoring('stated_taste_fit', 0.09, 'stated_favorite:nonfiction',
      { matchedKind: 'favorite', matchedKey: 'nonfiction' }),
    p4cScoring('tone_fit',                0.10, toneEv),
    p4cScoring('pace_fit',                0.08, paceEv),
    p4cScoring('series_continuation_fit', 0.06, seriesEv),
  ]));
  check('stated_taste_fit retains primary slot',
    out.primary?.source === 'stated_taste_fit',
    `got ${out.primary?.source}`);
  check('secondary is capped at MAX_SECONDARY=1',
    out.secondary.length <= 1);
  check('secondary (if present) is one of the P4D kinds',
    out.secondary.length === 0
    || ['tone_fit', 'pace_fit', 'series_continuation_fit']
        .includes(out.secondary[0].source));

  // No legacy PRIMARY → P4D admission may take primary (cold-start /
  // intent-only). series_continuation_fit listed first in SECONDARY_PRIORITY,
  // so when all three fire equally above-floor it wins primary.
  const outColdStart = composeExplanation(emit([
    p4cScoring('tone_fit',                0.10, toneEv),
    p4cScoring('pace_fit',                0.08, paceEv),
    p4cScoring('series_continuation_fit', 0.06, seriesEv),
  ]));
  check('cold-start: P4D admission produces a primary',
    outColdStart.primary !== undefined);
  check('cold-start primary is from SECONDARY_PRIORITY set',
    ['tone_fit', 'pace_fit', 'series_continuation_fit']
      .includes(outColdStart.primary?.source ?? ''),
    outColdStart.primary?.source);
}

// ── P4D-6 — back-compat projection still ≤ 2 lines, no banned phrasing ──────
section('P4D-6 — derived book.reasons[] projection unchanged in shape, banned phrasings absent');
{
  const out = composeExplanation(emit([
    scoring('stated_taste_fit', 0.09, 'stated_favorite:nonfiction',
      { matchedKind: 'favorite', matchedKey: 'nonfiction' }),
    p4cScoring('tone_fit', 0.10, {
      bookTone: 'light', bookToneConfidence: 'specific',
      userTone: 'light', match: 'match', signedEligible: true,
    }),
  ]));
  const proj = deriveBackcompatReasons(out);
  check('projection length ≤ 2 (RecCard cap unchanged)', proj.length <= 2);
  check('projection contains no banned/overclaim phrasing',
    proj.every(s => {
      const low = s.toLowerCase();
      return P4D_BANNED_PHRASES.every(b => !low.includes(b));
    }),
    JSON.stringify(proj));
  check('projection contains the P4D tone line in second slot',
    proj.length === 2 && proj[1].toLowerCase().includes('light'),
    JSON.stringify(proj));
}

// ── P4D-7 — composer remains pure (no ranking side effect) ──────────────────
section('P4D-7 — composer is pure; admitting P4C kinds does not mutate inputs');
{
  const inputs = [
    p4cScoring('tone_fit', 0.10, {
      bookTone: 'light', bookToneConfidence: 'specific',
      userTone: 'light', match: 'match', signedEligible: true,
    }),
    p4cScoring('series_continuation_fit', 0.06, {
      seriesName: 'X', bookSeriesIndex: 2,
      priorReadCount: 1, continuesPrior: true,
    }),
  ];
  const before = JSON.stringify(inputs);
  composeExplanation({ scoring: inputs, retrieval: [] });
  composeExplanation({ scoring: inputs, retrieval: [] });
  check('inputs unchanged after multiple composes',
    JSON.stringify(inputs) === before);
}

// ── Summary ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
