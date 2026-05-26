// =============================================================================
// validate_retrieval_planner.ts — P2A deterministic validator
//
// Run: `npx tsx scripts/validate_retrieval_planner.ts` (exit 0 ok / 1 fail).
//
// Validation level: PLANNER ONLY. Tests the pure `planBranches` function and
// the underlying branch builders. Does NOT make OL queries, does NOT score,
// does NOT touch the deck. End-to-end deck shift is a runtime property that
// requires a live account walk-through; the planner-level proof here covers
// the structural correctness P2A is responsible for.
//
// Cases (mirroring the locked spec quality gates):
//   A4 — stated retrieval delta: dense user with stated History/Biography
//        produces a planner that includes statedGenres anchors for those
//        AffinityKeys.
//   A5 — explicit-edit top quota delta: BuildCause='explicit_preference_edit'
//        boosts statedGenres quota by +1, trims revealedLanes by -1, plan
//        size unchanged.
//   A6 — dense respect: dense user still runs revealedAuthors + revealedLanes
//        branches (not collapsed to stated-only).
//   A7 — soft-avoid retrieval: dense user with avoid Sci-Fi has a reduced
//        revealedLanes quota when scifi_fantasy is in their dominant lanes,
//        and statedGenres never emits anchors for a soft-avoided favorite.
//   contrast — session_open uses base quotas; explicit_preference_edit uses
//        boosted quotas.
//   degenerate — empty stated favorites disables statedGenres branch (pre-
//        P2A behavior preserved for users with no Reading Taste set).
//   plan-size — sum across all configurations stays ≤ 11 (pre-P2A maximum).
//   reason-prefix — legacy `genre:`, `lane:`, `repeated_author:`,
//        `author_anchor:`, `liked_subject:` prefixes preserved; new
//        `stated_genre:` introduced.
// =============================================================================

import { planBranches } from '../lib/retrieval/branchPlanner';
import type { BranchContext, RetrievalPlan } from '../lib/retrieval/types';
import type { RecRequest, BuildCause } from '../lib/recRequest';
import type { AffinityKey } from '../lib/taxonomy/genres';
import {
  BRANCH_QUOTAS,
  EDIT_CAUSE_BRANCH_BOOST,
  SOFT_AVOID_RETRIEVAL_MULTIPLIER,
  LIKED_SUBJECT_AVOID_GUARDS,
} from '../lib/recPolicy';
import {
  applyLocalSoftAvoidFilter,
  classifyCandidateAvoidKey,
} from '../lib/retrieval/softAvoidLocal';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}
function section(name: string): void {
  console.log(`\n— ${name} —`);
}

// ── Test fixtures ────────────────────────────────────────────────────────────

function mkReq(opts: {
  favorites?:      AffinityKey[];
  avoids?:         AffinityKey[];
  cause?:          BuildCause;
  confidenceMode?: 'cold_start' | 'thin' | 'high_signal';
}): RecRequest {
  return {
    userId:  'test',
    signals: {
      statedTaste:   {
        signalClass: 'stated_durable',
        favoriteGenres:  opts.favorites ?? [],
        readingStyles:   [],
        favoriteAuthors: [],
        updatedAt:       null,
      },
      revealedTaste: { signalClass: 'revealed_behavioral', profile: {} as never },
      softAvoids:    { signalClass: 'soft_avoid', genres: opts.avoids ?? [], updatedAt: null },
    },
    policy: {
      confidenceMode:         opts.confidenceMode ?? 'high_signal',
      statedPreferenceFloor:  0.05,
      statedPreferenceWeight: 0.12,
      softAvoidFloor:        -0.06,
      softAvoidPenalty:      -0.15,
    },
    build: { cause: opts.cause ?? 'session_open', builtAt: 0, schemaVersion: 'rrv1' },
  };
}

function mkDenseCtx(opts?: { dominantLanes?: string[]; repeatedAuthors?: string[] }): BranchContext {
  return {
    topGenres:       ['fantasy_scifi', 'literary'],
    dominantLanes:   opts?.dominantLanes   ?? ['scifi_fantasy', 'romantasy'],
    repeatedAuthors: opts?.repeatedAuthors ?? ['Brandon Sanderson', 'Sarah J. Maas', 'N.K. Jemisin'],
    likedAuthors:    ['Brandon Sanderson'],
    likedSubjects:   ['epic fantasy', 'magic systems'],
    isDense:         true,
  };
}

function mkColdCtx(): BranchContext {
  return {
    topGenres:       ['general'],
    dominantLanes:   [],
    repeatedAuthors: [],
    likedAuthors:    [],
    likedSubjects:   [],
    isDense:         false,
  };
}

// Helpers
function statedAnchors(plan: RetrievalPlan): string[] {
  return plan.fetchItems.filter(i => i.branch === 'statedGenres').map(i => i.value);
}
function revealedLaneAnchors(plan: RetrievalPlan): string[] {
  return plan.fetchItems.filter(i => i.branch === 'revealedLanes').map(i => i.value);
}
function revealedAuthorAnchors(plan: RetrievalPlan): string[] {
  return plan.fetchItems.filter(i => i.branch === 'revealedAuthors').map(i => i.value);
}

// ── Case A4: stated retrieval delta (dense user) ─────────────────────────────
section('A4 — Stated retrieval delta (dense user with History/Biography)');
{
  // Pre-P2A bug: dense user retrieval bypassed stated favorites entirely.
  // Post-P2A: statedGenres branch runs and emits History+Biography anchors.
  const req = mkReq({
    favorites: ['nonfiction', 'memoir_bio'],
    confidenceMode: 'high_signal',
  });
  const ctx = mkDenseCtx();  // user reads Brandon Sanderson sci-fi but stated History+Biography
  const plan = planBranches(req, ctx);

  check('statedGenres branch enabled', plan.branchPolicies.statedGenres.enabled);
  check('statedGenres quota matches high_signal base',
    plan.branchPolicies.statedGenres.quota === BRANCH_QUOTAS.high_signal.statedGenres,
    `got ${plan.branchPolicies.statedGenres.quota}`);

  const sa = statedAnchors(plan);
  check('statedGenres emits ≥1 anchor', sa.length >= 1, `got ${sa.length}`);
  check('statedGenres anchors mention nonfiction subject',
    sa.some(a => /nonfiction|biography|memoir|history/i.test(a)),
    `anchors: ${sa.join(', ')}`);

  // The pre-P2A bug surface: dense path's stated retrieval was zero. Verify
  // that no statedGenres anchor is also a revealedLane anchor (no overlap
  // means the planner is contributing distinct retrieval, not duplicating).
  const la = revealedLaneAnchors(plan);
  const overlap = sa.filter(a => la.includes(a));
  check('statedGenres anchors are distinct from revealedLane anchors',
    overlap.length === 0, `overlap: ${overlap.join(', ')}`);
}

// ── Case A5: explicit_preference_edit quota boost ───────────────────────────
section('A5 — explicit_preference_edit quota boost');
{
  const req = mkReq({
    favorites: ['nonfiction', 'memoir_bio'],
    cause:     'explicit_preference_edit',
    confidenceMode: 'high_signal',
  });
  const ctx = mkDenseCtx();
  const plan = planBranches(req, ctx);

  const expectedStated = BRANCH_QUOTAS.high_signal.statedGenres + EDIT_CAUSE_BRANCH_BOOST.statedGenres;
  const expectedLanes  = BRANCH_QUOTAS.high_signal.revealedLanes + EDIT_CAUSE_BRANCH_BOOST.revealedLanes;
  check('statedGenres quota boosted by +1',
    plan.branchPolicies.statedGenres.quota === expectedStated,
    `expected ${expectedStated}, got ${plan.branchPolicies.statedGenres.quota}`);
  check('revealedLanes quota trimmed by -1',
    plan.branchPolicies.revealedLanes.quota === expectedLanes,
    `expected ${expectedLanes}, got ${plan.branchPolicies.revealedLanes.quota}`);
  check('plan.buildCause === explicit_preference_edit', plan.buildCause === 'explicit_preference_edit');
}

// ── Case A6: dense respect (revealed branches still run) ────────────────────
section('A6 — dense user still runs revealed branches');
{
  const req = mkReq({ favorites: ['nonfiction'], confidenceMode: 'high_signal' });
  const ctx = mkDenseCtx();
  const plan = planBranches(req, ctx);

  check('revealedAuthors branch enabled', plan.branchPolicies.revealedAuthors.enabled);
  check('revealedLanes branch enabled', plan.branchPolicies.revealedLanes.enabled);
  check('revealedAuthors emits ≥1 anchor', revealedAuthorAnchors(plan).length >= 1);
  check('revealedLanes emits ≥1 anchor', revealedLaneAnchors(plan).length >= 1);

  // Dense lane anchors should still come from LANE_OL_SUBJECTS (psychological
  // thriller / domestic thriller / epic fantasy / etc.), NOT generic genre
  // fallback. Verifying via the `lane:` reason prefix.
  const laneItems = plan.fetchItems.filter(i => i.reason.startsWith('lane:'));
  check('dense path uses `lane:` reason prefix (preserved from pre-P2A)',
    laneItems.length >= 1, `got ${laneItems.length} lane items`);
}

// ── Case A7: soft-avoid retrieval treatment ─────────────────────────────────
section('A7 — soft-avoid retrieval');
{
  // User has dominant lane scifi_fantasy AND has stated avoid fantasy_scifi.
  // Both layers should fire: revealedLanes quota reduced AND scifi_fantasy
  // anchors filtered out.
  const req = mkReq({
    favorites: ['nonfiction', 'memoir_bio', 'fantasy_scifi'],   // fantasy_scifi is BOTH favorite and avoided
    avoids:    ['fantasy_scifi'],
    confidenceMode: 'high_signal',
  });
  // Use modern_suspense as the second lane — it maps to thriller_mystery,
  // not fantasy_scifi, so it survives the soft-avoid filter. (romantasy
  // would also map to fantasy_scifi and be filtered — which is correct.)
  const ctx = mkDenseCtx({ dominantLanes: ['scifi_fantasy', 'modern_suspense'] });
  const plan = planBranches(req, ctx);

  check('softAvoidLanesApplied includes fantasy_scifi',
    plan.softAvoidLanesApplied.includes('fantasy_scifi'),
    `got: ${plan.softAvoidLanesApplied.join(', ')}`);
  const expectedReduced = Math.max(1, Math.floor(BRANCH_QUOTAS.high_signal.revealedLanes * SOFT_AVOID_RETRIEVAL_MULTIPLIER));
  check('revealedLanes quota reduced by SOFT_AVOID_RETRIEVAL_MULTIPLIER',
    plan.branchPolicies.revealedLanes.quota === expectedReduced,
    `expected ${expectedReduced}, got ${plan.branchPolicies.revealedLanes.quota}`);

  // statedGenres should drop fantasy_scifi favorite (defense-in-depth).
  const stated = statedAnchors(plan);
  const fantasyAnchor = stated.find(a => /fantasy|sci-fi|dystopian|epic/i.test(a));
  check('statedGenres does NOT emit anchor for soft-avoided favorite',
    !fantasyAnchor, fantasyAnchor ? `leaked: ${fantasyAnchor}` : undefined);

  // revealedLanes should not include scifi_fantasy lane anchors at all.
  const laneItems = plan.fetchItems.filter(i => i.reason === 'lane:scifi_fantasy');
  check('revealedLanes filters out soft-avoided lane (scifi_fantasy)',
    laneItems.length === 0, `leaked ${laneItems.length} items`);

  // But revealedLanes should still produce the modern_suspense anchors (not avoided).
  const suspenseItems = plan.fetchItems.filter(i => i.reason === 'lane:modern_suspense');
  check('revealedLanes still emits non-avoided lane (modern_suspense)',
    suspenseItems.length >= 1, `got ${suspenseItems.length}`);
}

// ── Contrast: session_open vs explicit_preference_edit ──────────────────────
section('Contrast — session_open vs explicit_preference_edit');
{
  const baseReq = mkReq({ favorites: ['nonfiction'], cause: 'session_open',             confidenceMode: 'high_signal' });
  const editReq = mkReq({ favorites: ['nonfiction'], cause: 'explicit_preference_edit', confidenceMode: 'high_signal' });
  const ctx = mkDenseCtx();
  const basePlan = planBranches(baseReq, ctx);
  const editPlan = planBranches(editReq, ctx);

  check('session_open uses base statedGenres quota',
    basePlan.branchPolicies.statedGenres.quota === BRANCH_QUOTAS.high_signal.statedGenres);
  check('explicit_preference_edit increases statedGenres quota',
    editPlan.branchPolicies.statedGenres.quota > basePlan.branchPolicies.statedGenres.quota);
  check('explicit_preference_edit decreases revealedLanes quota',
    editPlan.branchPolicies.revealedLanes.quota < basePlan.branchPolicies.revealedLanes.quota);
}

// ── Degenerate: empty stated favorites ──────────────────────────────────────
section('Degenerate — empty stated favorites disables statedGenres');
{
  const req = mkReq({ favorites: [], confidenceMode: 'high_signal' });
  const ctx = mkDenseCtx();
  const plan = planBranches(req, ctx);

  check('statedGenres disabled when no favorites', !plan.branchPolicies.statedGenres.enabled);
  check('statedGenres emits zero items', statedAnchors(plan).length === 0);
  check('revealedAuthors still runs', revealedAuthorAnchors(plan).length >= 1);
  check('revealedLanes still runs', revealedLaneAnchors(plan).length >= 1);
}

// ── Plan-size invariant: ≤ 11 items per request ─────────────────────────────
section('Plan-size invariant');
{
  const ctx = mkDenseCtx();
  for (const mode of ['cold_start', 'thin', 'high_signal'] as const) {
    for (const cause of ['session_open', 'explicit_preference_edit'] as const) {
      const req = mkReq({
        favorites: ['nonfiction', 'memoir_bio', 'literary', 'fantasy_scifi', 'horror'],
        cause,
        confidenceMode: mode,
      });
      const plan = planBranches(req, ctx);
      check(`mode=${mode} cause=${cause}: ≤ 11 fetch items`,
        plan.fetchItems.length <= 11,
        `got ${plan.fetchItems.length}`);
    }
  }
}

// ── Reason-prefix preservation (trace extraction relies on these) ───────────
section('Reason-prefix preservation');
{
  // Dense path: should produce `lane:`, `repeated_author:`, and (new) `stated_genre:`.
  const denseReq = mkReq({ favorites: ['nonfiction'], confidenceMode: 'high_signal' });
  const denseCtx = mkDenseCtx();
  const densePlan = planBranches(denseReq, denseCtx);
  const denseReasons = new Set(densePlan.fetchItems.map(i => i.reason.split(':')[0]));
  check('dense plan emits `lane:` prefix',            denseReasons.has('lane'));
  check('dense plan emits `repeated_author:` prefix', denseReasons.has('repeated_author'));
  check('dense plan emits `stated_genre:` prefix',    denseReasons.has('stated_genre'));

  // Non-dense path: should produce `genre:`, `author_anchor:`, `liked_subject:`, `stated_genre:`.
  const sparseReq = mkReq({ favorites: ['fantasy_scifi'], confidenceMode: 'thin' });
  const sparseCtx: BranchContext = {
    topGenres:       ['fantasy_scifi'],
    dominantLanes:   [],
    repeatedAuthors: [],
    likedAuthors:    ['Ursula K. Le Guin'],
    likedSubjects:   ['epic fantasy'],
    isDense:         false,
  };
  const sparsePlan = planBranches(sparseReq, sparseCtx);
  const sparseReasons = new Set(sparsePlan.fetchItems.map(i => i.reason.split(':')[0]));
  check('non-dense plan emits `genre:` prefix',         sparseReasons.has('genre'));
  check('non-dense plan emits `author_anchor:` prefix', sparseReasons.has('author_anchor'));
  check('non-dense plan emits `stated_genre:` prefix',  sparseReasons.has('stated_genre'));
}

// ── BuildCause non-edit causes do NOT alter quotas ──────────────────────────
section('Non-edit BuildCauses leave quotas at base');
{
  const ctx = mkDenseCtx();
  for (const cause of ['session_open', 'manual_refresh', 'intent_apply', 'feedback_action'] as const) {
    const req = mkReq({ favorites: ['nonfiction'], cause: cause as BuildCause, confidenceMode: 'high_signal' });
    const plan = planBranches(req, ctx);
    check(`cause=${cause}: statedGenres at base quota`,
      plan.branchPolicies.statedGenres.quota === BRANCH_QUOTAS.high_signal.statedGenres);
  }
}

// =============================================================================
// P2C — Soft-Avoid Retrieval Deprioritization
// =============================================================================

// ── Case A7a: sparse user with topGenres ∩ softAvoids triggers reduction ────
section('A7a — sparse user topGenres ∩ softAvoids → revealedLanes quota cut');
{
  // Sparse user (thin tier, no dominant lanes) whose topGenres include a
  // soft-avoided AffinityKey. Pre-P2C the planner only checked dominantLanes,
  // so sparse users never got the branch-level quota reduction.
  const req = mkReq({
    favorites: ['nonfiction'],
    avoids:    ['fantasy_scifi'],
    confidenceMode: 'thin',
  });
  const ctx: BranchContext = {
    topGenres:       ['fantasy_scifi', 'literary'],
    dominantLanes:   [],
    repeatedAuthors: [],
    likedAuthors:    ['Ursula K. Le Guin'],
    likedSubjects:   ['epic fantasy'],
    isDense:         false,
  };
  const plan = planBranches(req, ctx);

  check('softAvoidLanesApplied populated for sparse user',
    plan.softAvoidLanesApplied.includes('fantasy_scifi'),
    `got: ${plan.softAvoidLanesApplied.join(', ')}`);
  const expectedReduced = Math.max(1, Math.floor(BRANCH_QUOTAS.thin.revealedLanes * SOFT_AVOID_RETRIEVAL_MULTIPLIER));
  check('sparse-user revealedLanes quota reduced',
    plan.branchPolicies.revealedLanes.quota === expectedReduced,
    `expected ${expectedReduced}, got ${plan.branchPolicies.revealedLanes.quota}`);

  // Per-anchor mask still fires.
  const fantasyItems = plan.fetchItems.filter(i => i.reason === 'genre:fantasy_scifi');
  check('sparse path filters out soft-avoided topGenre anchor',
    fantasyItems.length === 0, `leaked ${fantasyItems.length} items`);
}

// ── Case A7b: sparse user with NO intersection → no reduction ───────────────
section('A7b — sparse user NO topGenres ∩ softAvoids → no quota cut');
{
  const req = mkReq({
    favorites: ['literary'],
    avoids:    ['horror'],
    confidenceMode: 'thin',
  });
  const ctx: BranchContext = {
    topGenres:       ['literary', 'nonfiction'],
    dominantLanes:   [],
    repeatedAuthors: [],
    likedAuthors:    ['Marilynne Robinson'],
    likedSubjects:   ['family saga'],
    isDense:         false,
  };
  const plan = planBranches(req, ctx);

  check('softAvoidLanesApplied empty when no intersection',
    plan.softAvoidLanesApplied.length === 0,
    `got: ${plan.softAvoidLanesApplied.join(', ')}`);
  check('revealedLanes quota at base when no intersection',
    plan.branchPolicies.revealedLanes.quota === BRANCH_QUOTAS.thin.revealedLanes,
    `expected ${BRANCH_QUOTAS.thin.revealedLanes}, got ${plan.branchPolicies.revealedLanes.quota}`);
}

// ── Case A7c: liked_subject guard list filters obvious soft-avoid subjects ──
section('A7c — liked_subject guards drop soft-avoided subject anchors');
{
  // The user's revealed liked_subjects include "epic fantasy" but they have
  // soft-avoided fantasy_scifi. The guard list LIKED_SUBJECT_AVOID_GUARDS
  // should catch the substring match and skip the anchor.
  const req = mkReq({
    favorites: ['literary'],
    avoids:    ['fantasy_scifi'],
    confidenceMode: 'thin',
  });
  const ctx: BranchContext = {
    topGenres:       ['literary'],
    dominantLanes:   [],
    repeatedAuthors: [],
    likedAuthors:    [],
    likedSubjects:   ['epic fantasy', 'family saga', 'magic systems'],
    isDense:         false,
  };
  const plan = planBranches(req, ctx);

  const subjectItems = plan.fetchItems.filter(i => i.reason.startsWith('liked_subject:'));
  const leakedFantasy = subjectItems.find(i =>
    /fantasy|magic|wizard|dragon|sci-?fi|science fiction/i.test(i.value)
  );
  check('liked_subject guard skips fantasy-themed subject when fantasy_scifi avoided',
    !leakedFantasy,
    leakedFantasy ? `leaked: ${leakedFantasy.value}` : undefined);

  const survivor = subjectItems.find(i => i.value === 'family saga');
  check('non-matching liked_subject (family saga) survives',
    !!survivor, 'family saga not emitted');

  // Guard table is non-empty and includes fantasy_scifi.
  check('LIKED_SUBJECT_AVOID_GUARDS includes fantasy_scifi entry',
    Array.isArray(LIKED_SUBJECT_AVOID_GUARDS.fantasy_scifi)
      && (LIKED_SUBJECT_AVOID_GUARDS.fantasy_scifi as readonly string[]).length > 0,
    `got: ${JSON.stringify(LIKED_SUBJECT_AVOID_GUARDS.fantasy_scifi)}`);
}

// ── Case A7d: per-FetchItem softAvoidDeprioritized flag populated ───────────
section('A7d — softAvoidDeprioritized flag set on revealedLanes items under reduction');
{
  const req = mkReq({
    favorites: ['nonfiction'],
    avoids:    ['fantasy_scifi'],
    confidenceMode: 'high_signal',
  });
  // dominantLanes intersect → quota reduced AND survivor lane items flagged.
  const ctx = mkDenseCtx({ dominantLanes: ['scifi_fantasy', 'modern_suspense'] });
  const plan = planBranches(req, ctx);

  const survivors = plan.fetchItems.filter(i =>
    i.branch === 'revealedLanes' && i.reason === 'lane:modern_suspense'
  );
  check('non-avoided lane survivors get softAvoidDeprioritized=true',
    survivors.length > 0 && survivors.every(i => i.softAvoidDeprioritized === true),
    `survivors: ${JSON.stringify(survivors.map(i => ({ r: i.reason, d: i.softAvoidDeprioritized })))}`);

  // Other branches must NOT have the flag set.
  const statedItems = plan.fetchItems.filter(i => i.branch === 'statedGenres');
  check('statedGenres items do NOT carry softAvoidDeprioritized',
    statedItems.every(i => i.softAvoidDeprioritized !== true),
    `flagged: ${statedItems.filter(i => i.softAvoidDeprioritized).length}`);
}

// =============================================================================
// Cold-Start Retrieval Expansion · Phase B — planner-side no-regression
// =============================================================================
section('Phase B — coldStartAdjacent quota=3 for cold_start, 0 elsewhere');
{
  // Branch policy exists in every plan; quota is mode-specific in Phase B.
  const expected: Record<'cold_start' | 'thin' | 'high_signal', number> = {
    cold_start: 3,
    thin: 0,
    high_signal: 0,
  };
  for (const mode of ['cold_start', 'thin', 'high_signal'] as const) {
    const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: mode });
    const ctx = mode === 'high_signal' ? mkDenseCtx() : mkColdCtx();
    const plan = planBranches(req, ctx);
    check(`${mode}: plan.branchPolicies.coldStartAdjacent present`,
      plan.branchPolicies.coldStartAdjacent !== undefined);
    check(`${mode}: coldStartAdjacent.quota === ${expected[mode]}`,
      plan.branchPolicies.coldStartAdjacent.quota === expected[mode],
      `got ${plan.branchPolicies.coldStartAdjacent.quota}`);
    const adjItems = plan.fetchItems.filter(i => i.branch === 'coldStartAdjacent');
    if (mode === 'cold_start') {
      check(`${mode}: admits up to quota coldStartAdjacent fetchItems (≤3)`,
        adjItems.length <= 3 && adjItems.length > 0,
        `got ${adjItems.length}`);
    } else {
      check(`${mode}: zero coldStartAdjacent fetchItems (mature-profile / thin invariant)`,
        adjItems.length === 0,
        `leaked ${adjItems.length}`);
    }
  }

  // BRANCH_ORDER includes coldStartAdjacent at the end (so primary branches
  // win quota races; adjacency is supplemental).
  const req = mkReq({ favorites: ['thriller_mystery'], confidenceMode: 'cold_start' });
  const plan = planBranches(req, mkColdCtx());
  check('branchOrder includes coldStartAdjacent', plan.branchOrder.includes('coldStartAdjacent'));
  check('branchOrder places coldStartAdjacent last',
    plan.branchOrder[plan.branchOrder.length - 1] === 'coldStartAdjacent');
}

// ── Case A7e: classifyCandidateAvoidKey heuristic ───────────────────────────
section('A7e — classifyCandidateAvoidKey resolves subjects to soft-avoided AffinityKey');
{
  const avoids: AffinityKey[] = ['fantasy_scifi'];
  // Clear hit
  const hit = classifyCandidateAvoidKey(['epic fantasy', 'magic'], avoids);
  check('epic fantasy subject + fantasy_scifi avoid → returns fantasy_scifi',
    hit === 'fantasy_scifi', `got ${String(hit)}`);

  // No hit (subjects don't match any guard)
  const miss = classifyCandidateAvoidKey(['family saga'], avoids);
  check('non-matching subject → returns null',
    miss === null, `got ${String(miss)}`);

  // Empty subjects → null (defensive)
  const empty = classifyCandidateAvoidKey([], avoids);
  check('empty subjects → null', empty === null);
  const nullSubj = classifyCandidateAvoidKey(null, avoids);
  check('null subjects → null', nullSubj === null);

  // No avoids → null (no work to do)
  const noAvoid = classifyCandidateAvoidKey(['epic fantasy'], []);
  check('empty softAvoids → null', noAvoid === null);
}

// ── Case A7f: applyLocalSoftAvoidFilter demotes by SOFT_AVOID_RETRIEVAL_MULTIPLIER ──
section('A7f — applyLocalSoftAvoidFilter keeps multiplier-fraction of soft-avoided');
{
  type Cand = { id: string; subjects: string[] | null };
  // 6 fantasy candidates (would all be soft-avoided) + 4 non-fantasy
  const cands: Cand[] = [
    { id: 'f1', subjects: ['epic fantasy'] },
    { id: 'f2', subjects: ['fantasy fiction'] },
    { id: 'f3', subjects: ['magic systems'] },
    { id: 'f4', subjects: ['dragons'] },
    { id: 'f5', subjects: ['sci-fi'] },
    { id: 'f6', subjects: ['science fiction'] },
    { id: 'k1', subjects: ['family saga'] },
    { id: 'k2', subjects: ['literary fiction'] },
    { id: 'k3', subjects: null },
    { id: 'k4', subjects: ['historical fiction'] },
  ];
  const result = applyLocalSoftAvoidFilter(
    cands,
    ['fantasy_scifi'] as AffinityKey[],
    (b) => b.subjects,
  );

  // Half (floor(6 * 0.5) = 3) of the fantasy candidates dropped → 3 kept.
  const remainingFantasy = result.kept.filter(c => /^f/.test(c.id)).length;
  const expectedFantasyKept = Math.ceil(6 * (1 - SOFT_AVOID_RETRIEVAL_MULTIPLIER));
  check('multiplier-fraction of soft-avoided candidates kept',
    remainingFantasy === expectedFantasyKept,
    `expected ${expectedFantasyKept}, got ${remainingFantasy}`);

  // All non-soft-avoided candidates survive untouched.
  const remainingNonAvoid = result.kept.filter(c => /^k/.test(c.id)).length;
  check('non-soft-avoided candidates fully preserved',
    remainingNonAvoid === 4, `got ${remainingNonAvoid}/4`);

  // demotedCount == drops (3)
  check('demotedCount reports drops',
    result.demotedCount === 3, `got ${result.demotedCount}`);

  // Determinism — first-seen-wins ordering preserved
  const second = applyLocalSoftAvoidFilter(
    cands,
    ['fantasy_scifi'] as AffinityKey[],
    (b) => b.subjects,
  );
  check('filter is deterministic across calls',
    JSON.stringify(result.kept.map(c => c.id))
      === JSON.stringify(second.kept.map(c => c.id)),
    'order changed between identical calls');

  // Empty avoids → no-op
  const noop = applyLocalSoftAvoidFilter(cands, [] as AffinityKey[], (b) => b.subjects);
  check('empty softAvoids → kept identical to input',
    noop.kept.length === cands.length && noop.demotedCount === 0,
    `kept=${noop.kept.length} demoted=${noop.demotedCount}`);
}

// ── Case A7g: P2B.1 retrieval-provenance prefix preserved ───────────────────
section('A7g — P2B.1 stated_genre: prefix unchanged by P2C');
{
  // P2B.1 reservation gate keys off `_retrieval_reason.startsWith('stated_genre:')`.
  // P2C must NOT alter the statedGenres branch's reason emission, even when
  // soft-avoid is active.
  const req = mkReq({
    favorites: ['nonfiction', 'memoir_bio'],
    avoids:    ['fantasy_scifi'],
    confidenceMode: 'high_signal',
    cause:     'explicit_preference_edit',
  });
  const ctx = mkDenseCtx({ dominantLanes: ['scifi_fantasy', 'modern_suspense'] });
  const plan = planBranches(req, ctx);

  const statedReasons = plan.fetchItems
    .filter(i => i.branch === 'statedGenres')
    .map(i => i.reason);
  check('every statedGenres item still uses `stated_genre:` prefix',
    statedReasons.length > 0 && statedReasons.every(r => r.startsWith('stated_genre:')),
    `reasons: ${JSON.stringify(statedReasons)}`);
  check('statedGenres items NOT flagged softAvoidDeprioritized',
    plan.fetchItems
      .filter(i => i.branch === 'statedGenres')
      .every(i => i.softAvoidDeprioritized !== true));
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'OK' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
