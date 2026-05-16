// =============================================================================
// validate_scoring_contributions.ts — P3A-3 deterministic validator
//
// Run: `npx tsx scripts/validate_scoring_contributions.ts` (exit 0 ok / 1 fail).
//
// Validation level: PURE DERIVATION CONTRACT. Tests
// `deriveScoringContributions` over synthetic `_score_breakdown` shapes,
// plus an end-to-end attachment check that replays the recommender's
// scored.map step on a fixture profile.
//
// Cases:
//   S1 emission         — non-zero breakdown components → contribution.
//   S2 sum-back         — Σ contribution.value === raw_score within ε.
//   S3 signed penalties — negative components emit negative-valued
//                         contributions with the right kinds.
//   S4 zero/absent      — zero or absent components emit nothing
//                         (no misleading zero contributions).
//   S5 retrieval intact — adding scoring contributions does not perturb
//                         retrieval contributions from P3A-2.
//   S6 order stability  — emitted scoring order is the documented order
//                         and is byte-stable across calls with identical
//                         input (purity proof for downstream stability).
//   S7 reservation ok   — synthetic candidate whose dominant
//                         _retrieval_reason starts with `stated_genre:`
//                         still passes the legacy reservation AND-gate
//                         predicate, untouched by attachment.
//   S8 stated evidence  — when audit_flags carries `stated_favorite:<key>`
//                         the stated_taste_fit contribution surfaces it as
//                         both source and evidence; absent flag falls back
//                         to source='stated_taste' with no evidence.
//   S9 hygiene evidence — metadata_penalty contribution captures the
//                         subset of audit_flags that drove the penalty
//                         (weak_metadata / *_drift / graphic_format /
//                         classic_signal) into evidence.audit_subflags
//                         and does NOT capture unrelated flags
//                         (e.g. stated_favorite:*).
// =============================================================================

import {
  deriveScoringContributions,
  mapRetrievalContributions,
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

const EPSILON = 1e-3;

// ── S1 — emission for non-zero components ────────────────────────────────────
section('S1 — non-zero components emit one contribution each');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment:  0.28,
    avoided_penalty: -0.12,
    genre_bonus:      0.22,
    feedback_boost:   0.07,
    enrichment_bonus: 0.08,
    metadata_penalty:-0.10,
    stated_taste:     0.15,
    raw_score:        0.58,
  };
  const cs = deriveScoringContributions(bd, []);
  check('contribution count = 7', cs.length === 7, `len=${cs.length}`);
  const kinds = cs.map(c => `${c.kind}/${c.source ?? ''}`);
  check('includes behavioral_fit/preferred_traits+liked_subjects',
    kinds.includes('behavioral_fit/preferred_traits+liked_subjects'));
  check('includes soft_avoid_penalty/avoided_traits',
    kinds.includes('soft_avoid_penalty/avoided_traits'));
  check('includes behavioral_fit/genre_affinity',
    kinds.includes('behavioral_fit/genre_affinity'));
  check('includes feedback_fit/more_like_this',
    kinds.includes('feedback_fit/more_like_this'));
  check('includes quality_reliability/enrichment_signals',
    kinds.includes('quality_reliability/enrichment_signals'));
  check('includes hygiene_floor/metadata+subtype_drift',
    kinds.includes('hygiene_floor/metadata+subtype_drift'));
  check('includes stated_taste_fit/stated_taste (no audit flag)',
    kinds.includes('stated_taste_fit/stated_taste'));
  check('every contribution.phase === scoring',
    cs.every(c => c.phase === 'scoring'));
}

// ── S2 — sum invariant ───────────────────────────────────────────────────────
section('S2 — Σ contribution.value === raw_score (within ε)');
{
  const cases: ScoreBreakdownLike[] = [
    { trait_alignment: 0.28, avoided_penalty: -0.12, genre_bonus: 0.22, feedback_boost: 0.07,
      enrichment_bonus: 0.08, metadata_penalty: -0.10, stated_taste: 0.15, raw_score: 0.58 },
    { trait_alignment: 0,    avoided_penalty: 0,     genre_bonus: 0,    feedback_boost: 0,
      enrichment_bonus: 0,   metadata_penalty: 0,    stated_taste: 0,    raw_score: 0 },
    { trait_alignment: 0.10, avoided_penalty: -0.30, genre_bonus: -0.18, feedback_boost: 0,
      enrichment_bonus: 0,   metadata_penalty: -0.25, stated_taste: 0.05, raw_score: -0.58 },
    { trait_alignment: 0.42, avoided_penalty: 0,     genre_bonus: 0.22,  feedback_boost: 0.10,
      enrichment_bonus: 0.08, metadata_penalty: 0,    stated_taste: 0.05, raw_score: 0.87 },
  ];
  for (const [i, bd] of cases.entries()) {
    const cs = deriveScoringContributions(bd, []);
    const sum = cs.reduce((a, c) => a + c.value, 0);
    check(`case ${i}: Σ=${sum.toFixed(4)} ≈ raw=${bd.raw_score.toFixed(4)}`,
      Math.abs(sum - bd.raw_score) < EPSILON,
      `Δ=${(sum - bd.raw_score).toFixed(6)}`);
  }
}

// ── S3 — signed penalties ────────────────────────────────────────────────────
section('S3 — penalties surface as negative-valued contributions');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment:  0,
    avoided_penalty: -0.25,
    genre_bonus:     -0.18,
    feedback_boost:   0,
    enrichment_bonus: 0,
    metadata_penalty:-0.22,
    stated_taste:    -0.05,
    raw_score:       -0.70,
  };
  const cs = deriveScoringContributions(bd, ['stated_softavoid:fantasy_scifi']);
  const byKind: Record<string, ScoringContribution | undefined> = {};
  for (const c of cs) byKind[`${c.kind}/${c.source ?? ''}`] = c;
  check('soft_avoid_penalty value < 0',
    (byKind['soft_avoid_penalty/avoided_traits']?.value ?? 0) < 0);
  check('behavioral_fit/genre_affinity value < 0 (negative genre affinity)',
    (byKind['behavioral_fit/genre_affinity']?.value ?? 0) < 0);
  check('hygiene_floor value < 0',
    (byKind['hygiene_floor/metadata+subtype_drift']?.value ?? 0) < 0);
  check('stated_taste_fit value < 0 + source uses softavoid key',
    (byKind['stated_taste_fit/stated_softavoid:fantasy_scifi']?.value ?? 0) < 0,
    JSON.stringify(byKind['stated_taste_fit/stated_softavoid:fantasy_scifi']));
}

// ── S4 — zero/absent components emit nothing ─────────────────────────────────
section('S4 — zero or absent components do NOT emit contributions');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment:  0.30,   // only non-zero entry
    avoided_penalty:  0,
    genre_bonus:      0,
    feedback_boost:   0,
    enrichment_bonus: 0,
    metadata_penalty: 0,
    // stated_taste absent
    raw_score:        0.30,
  };
  const cs = deriveScoringContributions(bd, []);
  check('exactly one contribution', cs.length === 1, `len=${cs.length}`);
  check('contribution.kind=behavioral_fit', cs[0].kind === 'behavioral_fit');
  check('no zero-value contributions', cs.every(c => c.value !== 0));
}

// ── S5 — retrieval contributions remain intact ───────────────────────────────
section('S5 — retrieval contributions unaffected by scoring derivation');
{
  const retrievalReasons = ['stated_genre:thriller_mystery', 'lane:modern_suspense'];
  const rc: RetrievalContribution[] = mapRetrievalContributions(retrievalReasons);
  const bd: ScoreBreakdownLike = {
    trait_alignment: 0.18, avoided_penalty: 0, genre_bonus: 0.10,
    feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
    stated_taste: 0.05, raw_score: 0.33,
  };
  const sc = deriveScoringContributions(bd, ['stated_favorite:thriller_mystery']);
  check('retrieval list length unchanged', rc.length === 2);
  check('retrieval[0].source=statedGenres', rc[0].source === 'statedGenres');
  check('retrieval[1].source=revealedLanes', rc[1].source === 'revealedLanes');
  check('all retrieval entries phase=retrieval', rc.every(c => c.phase === 'retrieval'));
  check('all scoring entries phase=scoring', sc.every(c => c.phase === 'scoring'));
  check('no cross-phase contamination',
    !(rc as unknown[]).some(c => (c as { phase?: string }).phase === 'scoring')
    && !(sc as unknown[]).some(c => (c as { phase?: string }).phase === 'retrieval'));
}

// ── S6 — order stability across calls ────────────────────────────────────────
section('S6 — emission order is deterministic + matches documented mapping');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment:  0.28,
    avoided_penalty: -0.12,
    genre_bonus:      0.22,
    feedback_boost:   0.07,
    enrichment_bonus: 0.08,
    metadata_penalty:-0.10,
    stated_taste:     0.15,
    raw_score:        0.58,
  };
  const a = deriveScoringContributions(bd, []);
  const b = deriveScoringContributions(bd, []);
  check('a !== b (fresh array)', a !== b);
  check('length identical', a.length === b.length);
  const sigA = a.map(c => `${c.kind}/${c.source}/${c.value.toFixed(4)}`).join('|');
  const sigB = b.map(c => `${c.kind}/${c.source}/${c.value.toFixed(4)}`).join('|');
  check('content byte-identical across calls', sigA === sigB);

  const expectedOrder = [
    'behavioral_fit/preferred_traits+liked_subjects',
    'soft_avoid_penalty/avoided_traits',
    'behavioral_fit/genre_affinity',
    'feedback_fit/more_like_this',
    'quality_reliability/enrichment_signals',
    'hygiene_floor/metadata+subtype_drift',
    'stated_taste_fit/stated_taste',
  ];
  const actualOrder = a.map(c => `${c.kind}/${c.source}`);
  check('order matches documented mapping',
    JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
    JSON.stringify(actualOrder));
}

// ── S7 — reservation AND-gate behaviour unchanged ────────────────────────────
section('S7 — adding scoring contributions does not break reservation predicate');
{
  // Synthetic candidate stand-in: the AND-gate is `_retrieval_reason.startsWith('stated_genre:')`.
  // Attaching scoring contributions must not require any change to that field.
  const candidate = {
    _retrieval_reason: 'stated_genre:thriller_mystery',
    _retrieval_reasons: ['stated_genre:thriller_mystery'],
    _score_breakdown: {
      trait_alignment: 0.20, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.35, final_score: 0.35,
    },
    audit_flags: ['stated_favorite:thriller_mystery'],
  };
  const sc = deriveScoringContributions(candidate._score_breakdown, candidate.audit_flags);
  // Attach (simulating the recommender's scored.map):
  const enriched = {
    ...candidate,
    _retrieval_contributions: mapRetrievalContributions(candidate._retrieval_reasons),
    _scoring_contributions: sc,
  };
  check('singular _retrieval_reason preserved',
    enriched._retrieval_reason === 'stated_genre:thriller_mystery');
  check('AND-gate predicate still passes',
    enriched._retrieval_reason.startsWith('stated_genre:'));
  check('stated_taste_fit attached with source carrying matched key',
    sc.some(c => c.kind === 'stated_taste_fit' && c.source === 'stated_favorite:thriller_mystery'));
}

// ── S8 — stated-taste evidence parsing ───────────────────────────────────────
section('S8 — stated_taste evidence parsing');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment: 0, avoided_penalty: 0, genre_bonus: 0,
    feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
    stated_taste: 0.10, raw_score: 0.10,
  };
  // (a) with audit flag → source + evidence populated
  const withFlag = deriveScoringContributions(bd, ['stated_favorite:nonfiction']);
  const sWithFlag = withFlag.find(c => c.kind === 'stated_taste_fit');
  check('with flag: source=stated_favorite:nonfiction',
    sWithFlag?.source === 'stated_favorite:nonfiction', sWithFlag?.source);
  check('with flag: evidence.matchedKind=favorite',
    (sWithFlag?.evidence as { matchedKind?: string } | undefined)?.matchedKind === 'favorite');
  check('with flag: evidence.matchedKey=nonfiction',
    (sWithFlag?.evidence as { matchedKey?: string } | undefined)?.matchedKey === 'nonfiction');

  // (b) without audit flag → fallback source, no evidence
  const noFlag = deriveScoringContributions(bd, []);
  const sNoFlag = noFlag.find(c => c.kind === 'stated_taste_fit');
  check('without flag: source=stated_taste fallback',
    sNoFlag?.source === 'stated_taste');
  check('without flag: no evidence field', sNoFlag?.evidence === undefined);

  // (c) softavoid flag → source uses softavoid key
  const softAvoid = deriveScoringContributions(
    { ...bd, stated_taste: -0.05, raw_score: -0.05 },
    ['stated_softavoid:romance']);
  const sSoft = softAvoid.find(c => c.kind === 'stated_taste_fit');
  check('softavoid: source=stated_softavoid:romance',
    sSoft?.source === 'stated_softavoid:romance');
  check('softavoid: evidence.matchedKind=softavoid',
    (sSoft?.evidence as { matchedKind?: string } | undefined)?.matchedKind === 'softavoid');
}

// ── S9 — hygiene evidence filtering ──────────────────────────────────────────
section('S9 — hygiene_floor contribution captures only the relevant audit flags');
{
  const bd: ScoreBreakdownLike = {
    trait_alignment: 0, avoided_penalty: 0, genre_bonus: 0,
    feedback_boost: 0, enrichment_bonus: 0,
    metadata_penalty: -0.22, stated_taste: 0,
    raw_score: -0.22,
  };
  const audit = [
    'weak_metadata',         // relevant
    'noir_drift',            // relevant
    'graphic_format',        // relevant
    'stated_favorite:thriller_mystery',  // NOT relevant
    'unknown_genre',         // NOT relevant (not in whitelist)
  ];
  const cs = deriveScoringContributions(bd, audit);
  const hygiene = cs.find(c => c.kind === 'hygiene_floor');
  const subflags = (hygiene?.evidence as { audit_subflags?: string[] } | undefined)?.audit_subflags ?? [];
  check('subflags includes weak_metadata', subflags.includes('weak_metadata'));
  check('subflags includes noir_drift', subflags.includes('noir_drift'));
  check('subflags includes graphic_format', subflags.includes('graphic_format'));
  check('subflags EXCLUDES stated_favorite:*',
    !subflags.some(f => f.startsWith('stated_favorite:')));
  check('subflags EXCLUDES unknown_genre',
    !subflags.includes('unknown_genre'));
}

// ── Summary ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
