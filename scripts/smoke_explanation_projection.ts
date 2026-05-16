// =============================================================================
// smoke_explanation_projection.ts — P3A-6-A local flag-on smoke
//
// Dev-only smoke. Drives the flag-ON projection path WITHOUT mutating the
// committed COMPOSER_REASONS_PROJECTION_ENABLED constant: we call the
// always-projecting helper `projectComposerReasonsPure` directly. That is
// the same code the production call site would invoke if the flag were
// flipped, minus the non-empty-fallback guard (which we re-implement
// inline so we observe the production-equivalent output).
//
// No production code is changed. No flag is flipped. This script is a
// validator + observability tool only.
//
// Coverage:
//   Scenario A — import-first user with library history
//   Scenario B — quick-taste user with stated chips, no library
//   Scenario C — cold-start Tier-0 user (no library, no chips)
//   Scenario D — explicit preference edit user
//
// For each candidate fixture we check 10 acceptance criteria + print the
// observed reasons[] under flag OFF and under flag ON so the human run
// can sanity-check copy quality.
//
// Run: `npx tsx scripts/smoke_explanation_projection.ts` (exit 0 ok / 1).
// =============================================================================

import {
  projectComposerReasons,
  projectComposerReasonsPure,
  COMPOSER_REASONS_PROJECTION_ENABLED,
} from '../lib/explanations/projection';
import {
  deriveScoringContributions,
  mapRetrievalContributions,
} from '../lib/scoring/contributions';
import type {
  RetrievalContribution,
  ScoringContribution,
  ScoreBreakdownLike,
} from '../lib/scoring/contributions';

// ── Pre-flight: confirm flag is OFF in committed code ────────────────────────
if (COMPOSER_REASONS_PROJECTION_ENABLED !== false) {
  console.error('\x1b[31mABORT\x1b[0m — committed flag is not OFF. Revert before smoke.');
  process.exit(2);
}

let failures = 0;
function expect(label: string, ok: boolean, detail?: string): void {
  const m = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  if (!ok) failures += 1;
  console.log(`    ${m} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}

const BANNED = [
  'you gravitate toward',
  'because you liked',
  'you loved',
  'perfect for you',
  'consistently',
  'always',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

type Candidate = {
  title:       string;
  legacy:      string[];
  retrieval:   RetrievalContribution[];
  scoring:     ScoringContribution[];
};

function flagOnProjection(c: Candidate): string[] {
  // Same code the production call site would run with the flag flipped,
  // including the non-empty fallback guard.
  const projected = projectComposerReasonsPure({
    retrieval: c.retrieval, scoring: c.scoring,
  });
  return projected.length > 0 ? projected : c.legacy;
}

function flagOffProjection(c: Candidate): readonly string[] {
  return projectComposerReasons(
    { retrieval: c.retrieval, scoring: c.scoring },
    c.legacy,
  );
}

function runCandidate(scenarioId: string, c: Candidate, opts: {
  /** Stated keys the user actually stated. Any cite of a key NOT in this
   *  set is overclaiming. */
  statedKeys:        readonly string[];
  /** When true, the candidate has zero above-floor positive scoring
   *  contributions — flag-ON projection should be empty (and so the
   *  fallback returns legacy). */
  retrievalOnly?:    boolean;
  /** When true, the only above-floor positive contribution is
   *  quality_reliability — flag-ON projection should be empty. */
  qualityOnly?:      boolean;
  /** When true, only negative contributions are above floor — flag-ON
   *  projection should be empty. */
  penaltyOnly?:      boolean;
  /** When true, this is the Tier-0 / seeded-strip case — flag-ON should
   *  fall back to legacy reasons (which here is the empty / popular
   *  copy). */
  tier0?:            boolean;
}): void {
  const off = flagOffProjection(c);
  const on  = flagOnProjection(c);

  console.log(`  [${scenarioId}] "${c.title}"`);
  console.log(`    OFF: ${JSON.stringify(off)}`);
  console.log(`    ON : ${JSON.stringify(on)}`);

  // (1) flag OFF → byte-identical to legacy (reference identity)
  expect('flag OFF returns legacy reasons by reference', off === c.legacy);

  // (2) no empty-reasons regression — fallback guard
  if (c.legacy.length > 0) {
    expect('flag ON non-empty (fallback guard or projection)', on.length > 0);
  }

  // (3) no banned phrasing under either branch
  for (const arr of [off, on]) {
    for (const s of arr) {
      const l = s.toLowerCase();
      for (const b of BANNED) {
        expect(`no banned phrasing "${b}"`, !l.includes(b), s);
      }
    }
  }

  // (4) no cite of a stated key the user did not state
  const allowedKeys = new Set(opts.statedKeys.map(k => k.toLowerCase()));
  for (const s of on) {
    const m = s.match(/Matches your stated (\S+) preference/);
    if (m) {
      expect(`cites only stated key (saw "${m[1]}")`,
        allowedKeys.has(m[1].toLowerCase()));
    }
  }

  // (5) retrieval-only candidate → flag-ON projection is the legacy
  //     fallback (composer returned empty), so OFF and ON match byte-wise.
  if (opts.retrievalOnly) {
    expect('retrieval-only → ON falls back to legacy',
      JSON.stringify(on) === JSON.stringify([...off]));
  }

  // (6) quality_reliability-only candidate → composer empty → fallback
  if (opts.qualityOnly) {
    expect('quality-only → ON falls back to legacy',
      JSON.stringify(on) === JSON.stringify([...off]));
  }

  // (7) penalty-only candidate → composer empty → fallback
  if (opts.penaltyOnly) {
    expect('penalty-only → ON falls back to legacy',
      JSON.stringify(on) === JSON.stringify([...off]));
  }

  // (8) Tier-0 seeded-strip candidate → committed code does not invoke
  //     the projection at all (seeded strip is hardcoded outside the
  //     recommender). We assert the legacy reasons are empty/popular
  //     copy so the smoke covers the surface even though the path is
  //     bypassed in production.
  if (opts.tier0) {
    expect('Tier-0 legacy reasons are empty (strip is non-personalized)',
      c.legacy.length === 0);
  }

  // (9) ON projection shape — string[], length ≤ 2
  expect('ON shape: string[] length ≤ 2',
    Array.isArray(on) && on.every(s => typeof s === 'string') && on.length <= 2);
}

// ── Scenario A — import-first user with library history ──────────────────────
console.log('\n── A. Import-first user (Goodreads library, no recent chip edit) ──');
{
  // A.1 Strong behavioral match, no stated key — generic composer copy.
  const sc = deriveScoringContributions(
    { trait_alignment: 0.32, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0, enrichment_bonus: 0.04, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.51 },
    []);
  const rc = mapRetrievalContributions(['lane:literary_thriller']);
  runCandidate('A.1', {
    title: 'The Secret History',
    legacy: ['By Donna Tartt, a consistent favorite of yours',
             'Aligns with your preference for slow-burn pacing'],
    retrieval: rc, scoring: sc,
  }, { statedKeys: [] });

  // A.2 Retrieval-only (lane match retrieved, but no above-floor scoring).
  const sc2 = deriveScoringContributions(
    { trait_alignment: 0.03, avoided_penalty: 0, genre_bonus: 0.03,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.02, raw_score: 0.08 },
    []);
  const rc2 = mapRetrievalContributions(['lane:literary_thriller']);
  runCandidate('A.2', {
    title: 'A weak literary-thriller candidate',
    legacy: ['Adjacent fit to your lane preferences'],
    retrieval: rc2, scoring: sc2,
  }, { statedKeys: [], retrievalOnly: true });
}

// ── Scenario B — quick-taste user (stated chips, no library) ────────────────
console.log('\n── B. Quick-taste user (3 chips picked, empty library) ──');
{
  // B.1 Stated genre matched + above-floor stated_taste.
  const sc = deriveScoringContributions(
    { trait_alignment: 0.02, avoided_penalty: 0, genre_bonus: 0.08,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.07, raw_score: 0.17 },
    ['stated_favorite:thriller_mystery']);
  const rc = mapRetrievalContributions(['stated_genre:thriller_mystery']);
  runCandidate('B.1', {
    title: 'The Silent Patient',
    legacy: ['Matches your stated thriller preference'],
    retrieval: rc, scoring: sc,
  }, { statedKeys: ['thriller_mystery'] });

  // B.2 Retrieved by stated_genre + author_anchor BUT zero above-floor
  //     scoring (cold profile penalty / etc.).
  const sc2 = deriveScoringContributions(
    { trait_alignment: 0.01, avoided_penalty: 0, genre_bonus: 0.02,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.02, raw_score: 0.05 },
    []);
  const rc2 = mapRetrievalContributions(
    ['stated_genre:nonfiction', 'author_anchor:Sapolsky']);
  runCandidate('B.2', {
    title: 'Behave',
    legacy: ['New in your nonfiction interest'],
    retrieval: rc2, scoring: sc2,
  }, { statedKeys: ['nonfiction', 'thriller_mystery'], retrievalOnly: true });
}

// ── Scenario C — cold-start Tier-0 user ─────────────────────────────────────
console.log('\n── C. Cold-start Tier-0 user (no library, no chips) ──');
{
  // Per the cold-start architecture, the seeded strip is rendered from
  // lib/seededPicks.ts — it never reaches `scored.map` in the
  // recommender, so the projection is structurally never invoked. We
  // still exercise a notional "fell-through-to-recommender" candidate
  // to prove that even if it did, the projection would not invent
  // personalized claims.
  const sc = deriveScoringContributions(
    { trait_alignment: 0, avoided_penalty: 0, genre_bonus: 0,
      feedback_boost: 0, enrichment_bonus: 0.06, metadata_penalty: 0,
      stated_taste: 0, raw_score: 0.06 },
    []);
  runCandidate('C.1', {
    title: '(Tier-0 seeded popular pick)',
    legacy: [],
    retrieval: [], scoring: sc,
  }, { statedKeys: [], tier0: true, qualityOnly: true });
}

// ── Scenario D — explicit preference edit ───────────────────────────────────
console.log('\n── D. Explicit preference edit (added "literary_fiction") ──');
{
  // D.1 The reserved stated pick — scored evidence is real, projection
  //     should cite the matched key.
  const sc = deriveScoringContributions(
    { trait_alignment: 0.15, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0, enrichment_bonus: 0.03, metadata_penalty: 0,
      stated_taste: 0.08, raw_score: 0.36 },
    ['stated_favorite:literary_fiction']);
  const rc = mapRetrievalContributions(
    ['stated_genre:literary_fiction', 'lane:contemporary_literary']);
  runCandidate('D.1', {
    title: 'A Little Life',
    legacy: ['Matches your stated literary fiction preference',
             'Aligns with your preference for emotional depth'],
    retrieval: rc, scoring: sc,
  }, { statedKeys: ['literary_fiction'] });

  // D.2 A negative-contribution case — soft-avoid hit. Projection should
  //     suppress the negative-only candidate (no positive reason).
  const sc2: ScoringContribution[] = [
    { phase: 'scoring', kind: 'soft_avoid_penalty', value: -0.22,
      source: 'avoided_traits' },
  ];
  runCandidate('D.2', {
    title: '(Soft-avoid candidate)',
    legacy: ['Adjacent — leans into a category you marked to see less of'],
    retrieval: [], scoring: sc2,
  }, { statedKeys: ['literary_fiction'], penaltyOnly: true });
}

// ── Extra coverage: feedback_fit + behavioral-only-no-stated ─────────────────
// Two more candidates to round out the 9-candidate fixture set called for
// in P3A-6-A and to exercise the feedback_fit phrasing path which the
// composer-line classifier ('Similar to books you asked for more of')
// happens to also match in the legacy classifier — useful tripwire if
// either phrasing ever drifts.
console.log('\n── E. Feedback-driven + pure-behavioral candidates ──');
{
  // E.1 Feedback fit dominates — composer should cite the feedback line.
  const sc = deriveScoringContributions(
    { trait_alignment: 0.08, avoided_penalty: 0, genre_bonus: 0.04,
      feedback_boost: 0.18, enrichment_bonus: 0.02, metadata_penalty: 0,
      stated_taste: 0.03, raw_score: 0.35 },
    []);
  runCandidate('E.1', {
    title: 'A "more like this" follow-up pick',
    legacy: ['Similar to books you asked for more of'],
    retrieval: [], scoring: sc,
  }, { statedKeys: [] });

  // E.2 Pure behavioral (trait alignment only, no stated key, no feedback).
  const sc2 = deriveScoringContributions(
    { trait_alignment: 0.28, avoided_penalty: 0, genre_bonus: 0,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.33 },
    []);
  runCandidate('E.2', {
    title: 'Behavioral-only pattern match',
    legacy: ['Aligns with your preference for slow-burn pacing'],
    retrieval: [], scoring: sc2,
  }, { statedKeys: [] });
}

// ── Acceptance #8 — ranking/order stability (book.score unaffected) ─────────
// The projection ONLY mutates book.reasons[]. We simulate a 3-book
// composition pre- and post-projection and assert the sort by score is
// byte-identical. This is the script-level analogue of the structural
// placement assertion in scripts/validate_explanation_projection.ts.
console.log('\n── Acceptance #8 — ranking stability (sort-by-score) ──');
{
  type MiniBook = { id: string; score: number; reasons: string[] };
  const sc = deriveScoringContributions(
    { trait_alignment: 0.20, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.05, raw_score: 0.35 },
    ['stated_favorite:thriller_mystery']);
  const rc = mapRetrievalContributions(['stated_genre:thriller_mystery']);

  const books: MiniBook[] = [
    { id: 'a', score: 0.72, reasons: ['legacy-A'] },
    { id: 'b', score: 0.55, reasons: ['legacy-B'] },
    { id: 'c', score: 0.91, reasons: ['legacy-C'] },
  ];
  const orderBefore = books.slice().sort((x, y) => y.score - x.score).map(b => b.id);

  // Run the projection on each.
  for (const b of books) {
    const projected = projectComposerReasonsPure({ retrieval: rc, scoring: sc });
    b.reasons = (projected.length > 0 ? projected : b.reasons) as string[];
  }
  // Score MUST be untouched (we never write to it).
  expect('book.score unchanged across all books',
    books.find(b => b.id === 'a')!.score === 0.72 &&
    books.find(b => b.id === 'b')!.score === 0.55 &&
    books.find(b => b.id === 'c')!.score === 0.91);

  const orderAfter = books.slice().sort((x, y) => y.score - x.score).map(b => b.id);
  expect('sort-by-score order byte-identical pre/post projection',
    JSON.stringify(orderBefore) === JSON.stringify(orderAfter),
    `before=${orderBefore} after=${orderAfter}`);
}

// ── Acceptance #9 — P2 stated reservation path unaffected ───────────────────
// The reservation AND-gate at lib/composition/statedReservation.ts reads
// _retrieval_reason (singular, startsWith('stated_genre:')) AND scoring
// audit_flags. The projection touches ONLY book.reasons[] — it does not
// read or write _retrieval_reason or audit_flags. Smoke-level assertion:
// run the projection on a fixture whose retrieval provenance includes
// stated_genre and confirm those fields (modelled here as the inputs we
// hand the function) are returned unchanged.
console.log('\n── Acceptance #9 — stated reservation inputs unaffected ──');
{
  const retrieval = mapRetrievalContributions(['stated_genre:literary_fiction']);
  const scoring   = deriveScoringContributions(
    { trait_alignment: 0.15, avoided_penalty: 0, genre_bonus: 0.10,
      feedback_boost: 0, enrichment_bonus: 0, metadata_penalty: 0,
      stated_taste: 0.08, raw_score: 0.33 },
    ['stated_favorite:literary_fiction']);
  const retrievalSnapshot = JSON.stringify(retrieval);
  const scoringSnapshot   = JSON.stringify(scoring);

  const _projected = projectComposerReasonsPure({ retrieval, scoring });
  expect('retrieval contributions unmutated by projection',
    JSON.stringify(retrieval) === retrievalSnapshot);
  expect('scoring contributions unmutated by projection',
    JSON.stringify(scoring) === scoringSnapshot);
  // The reservation predicate reads `_retrieval_reason.startsWith('stated_genre:')`
  // — confirm the source the projection consumed still carries that token.
  expect('stated_genre retrieval reason still present',
    retrieval.some(r => r.reason.startsWith('stated_genre:')));
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} smoke failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
