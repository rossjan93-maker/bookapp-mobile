// =============================================================================
// validate_stated_reservation.ts — P2B deterministic validator
//
// Run: `npx tsx scripts/validate_stated_reservation.ts` (exit 0 ok / 1 fail).
//
// Validation level: COMPOSITION HELPER ONLY. Tests the pure
// `pickStatedReservation` function. Does NOT touch retrieval, scoring, OL,
// or the deck. End-to-end deck-shift verification on a live authenticated
// account remains outstanding for the broader stream.
//
// Cases mirror the P2B mapping (C1–C8):
//   C1 trigger          — explicit_preference_edit + eligible candidate → reserved
//   C2 wrong cause      — session_open + same compPool → null, reason=wrong_cause
//   C3 no favorites     — eligible cause + zero favoriteGenres → null, reason=no_favorites
//   C4 no eligible      — eligible cause + favorites set + no stated_favorite flag → null
//   C5 author-cap       — compositionAllows() returns false → skip and try next
//   C6 ADJACENT-only    — only candidate is fit_class != core_fit → null
//   C7 single slot      — STATED_RESERVATION_POLICY.maxReservedSlots === 1
//   C8 cause membership — eligibleCauses === ['explicit_preference_edit'] exactly
// =============================================================================

import { pickStatedReservation } from '../lib/composition/statedReservation';
import { STATED_RESERVATION_POLICY } from '../lib/recPolicy';
import type { ScoredBook } from '../lib/recommender';
import type { RecRequest, BuildCause } from '../lib/recRequest';
import type { AffinityKey } from '../lib/taxonomy/genres';

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
  cause?:     BuildCause;
  favorites?: AffinityKey[];
}): RecRequest {
  return {
    userId:  'test',
    signals: {
      statedTaste:   {
        signalClass:     'stated_durable',
        favoriteGenres:  opts.favorites ?? [],
        readingStyles:   [],
        favoriteAuthors: [],
        updatedAt:       null,
      },
      revealedTaste: { signalClass: 'revealed_behavioral', profile: {} as never },
      softAvoids:    { signalClass: 'soft_avoid', genres: [], updatedAt: null },
    },
    policy: {
      confidenceMode:         'high_signal',
      statedPreferenceFloor:  0.05,
      statedPreferenceWeight: 0.12,
      softAvoidFloor:        -0.06,
      softAvoidPenalty:      -0.15,
    },
    build: { cause: opts.cause ?? 'session_open', builtAt: 0, schemaVersion: 'rrv1' },
  };
}

type MkBookOpts = {
  id:               string;
  author:           string;
  statedFlag?:      string | null;     // e.g. 'stated_favorite:nonfiction', or null/undefined
  statedTaste?:     number;            // _score_breakdown.stated_taste
  fitClass?:        'core_fit' | 'adjacent_fit' | 'reject';
  weakMetadata?:    boolean;
  bookLane?:        string | null;
  /** P2B.1 retrieval-provenance. Default is `stated_genre:nonfiction` so
   *  pre-existing C1–C8 cases that test scoring/composition gates continue
   *  to pass without modification. C9+ cases override this to test the new
   *  retrieval gate explicitly. */
  retrievalReason?: string;
};
function mkBook(o: MkBookOpts): ScoredBook {
  const audit_flags: string[] = [];
  if (o.statedFlag) audit_flags.push(o.statedFlag);
  if (o.weakMetadata) audit_flags.push('weak_metadata');
  return {
    external_id:       o.id,
    title:             `Title ${o.id}`,
    author:            o.author,
    cover_url:         null,
    description:       null,
    isbn:              null,
    page_count:        200,
    published_at:      null,
    subjects:          [],
    _source:           'open_library',
    _retrieval_reason: o.retrievalReason ?? 'stated_genre:nonfiction',
    score:        0.5,
    confidence:   'medium',
    reasons:      [],
    risks:        [],
    _score_breakdown: {
      // Only the fields the helper reads matter; rest are placeholders.
      audit_flags,
      stated_taste: o.statedTaste ?? 0,
      fit_class:    o.fitClass    ?? 'core_fit',
      book_lane:    o.bookLane    ?? null,
    } as unknown as ScoredBook['_score_breakdown'],
    _debug: { pool_size: 1, rank: 1 },
  } as unknown as ScoredBook;
}

function compIdOf(b: ScoredBook): string {
  return b.external_id ?? b.title ?? '';
}

const allowAlways  = (_: ScoredBook): boolean => true;
const denyAlways   = (_: ScoredBook): boolean => false;

// ── C1: trigger ──────────────────────────────────────────────────────────────
section('C1 — Eligible cause + eligible candidate → reserved');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'A', author: 'Alpha',  statedFlag: null,                                statedTaste: 0,    fitClass: 'core_fit' }),
    mkBook({ id: 'B', author: 'Bravo',  statedFlag: 'stated_favorite:nonfiction',        statedTaste: 0.12, fitClass: 'core_fit' }),
    mkBook({ id: 'C', author: 'Charlie', statedFlag: 'stated_favorite:memoir_bio',       statedTaste: 0.10, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is non-null',           r.pick !== null);
  check('pick is book B (first eligible)', r.pick?.external_id === 'B', `got ${r.pick?.external_id}`);
  check('trace.applied === true',     r.trace.applied === true);
  check('trace.reason === reserved',  r.trace.reason === 'reserved', r.trace.reason);
  check('trace.cause === explicit_preference_edit', r.trace.cause === 'explicit_preference_edit');
  check('trace.key === nonfiction',   r.trace.key === 'nonfiction', r.trace.key);
}

// ── C2: wrong cause ──────────────────────────────────────────────────────────
section('C2 — Wrong cause (session_open) → null');
{
  const req = mkReq({ cause: 'session_open', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'B', author: 'Bravo', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is null',                  r.pick === null);
  check('trace.applied === false',       r.trace.applied === false);
  check('trace.reason === wrong_cause',  r.trace.reason === 'wrong_cause', r.trace.reason);
  check('trace.cause carried through',   r.trace.cause === 'session_open');
}

// ── C2b: no req at all ───────────────────────────────────────────────────────
section('C2b — Missing RecRequest (legacy caller) → null, reason=no_req');
{
  const pool = [mkBook({ id: 'B', author: 'B', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12 })];
  const r = pickStatedReservation(pool, undefined, new Set(), allowAlways, compIdOf);
  check('pick is null',          r.pick === null);
  check('trace.reason === no_req', r.trace.reason === 'no_req', r.trace.reason);
  check('trace.cause undefined', r.trace.cause === undefined);
}

// ── C3: no favorites ─────────────────────────────────────────────────────────
section('C3 — Eligible cause but zero favoriteGenres → null, reason=no_favorites');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: [] });
  const pool = [
    mkBook({ id: 'B', author: 'Bravo', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is null',                    r.pick === null);
  check('trace.reason === no_favorites',   r.trace.reason === 'no_favorites', r.trace.reason);
}

// ── C4: no eligible candidate ────────────────────────────────────────────────
section('C4 — No candidate carries stated_favorite flag → null, reason=no_eligible_candidate');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'A', author: 'A', statedFlag: null, statedTaste: 0, fitClass: 'core_fit' }),
    mkBook({ id: 'B', author: 'B', statedFlag: null, statedTaste: 0, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is null',                              r.pick === null);
  check('trace.reason === no_eligible_candidate',    r.trace.reason === 'no_eligible_candidate', r.trace.reason);
}

// ── C4b: stated flag present but stated_taste <= 0 ───────────────────────────
section('C4b — Flag present but stated_taste contribution ≤ 0 → skipped');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'B', author: 'B', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0,     fitClass: 'core_fit' }),
    mkBook({ id: 'C', author: 'C', statedFlag: 'stated_favorite:nonfiction', statedTaste: -0.05, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is null when no positive stated_taste',  r.pick === null);
  check('trace.reason === no_eligible_candidate',      r.trace.reason === 'no_eligible_candidate', r.trace.reason);
}

// ── C5: compositionAllows respect ────────────────────────────────────────────
section('C5 — compositionAllows() denial skips candidate; next eligible wins');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const denied = mkBook({ id: 'B', author: 'Bravo',   statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit' });
  const allowed = mkBook({ id: 'D', author: 'Delta',  statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.10, fitClass: 'core_fit' });
  const pool = [denied, allowed];
  // Compose-allows that vetoes book B but accepts D
  const allowExceptB = (b: ScoredBook): boolean => b.external_id !== 'B';
  const r = pickStatedReservation(pool, req, new Set(), allowExceptB, compIdOf);
  check('pick is the non-denied candidate',   r.pick?.external_id === 'D', `got ${r.pick?.external_id}`);
  check('trace.reason === reserved',          r.trace.reason === 'reserved');
}

// ── C5b: all denied → null ───────────────────────────────────────────────────
section('C5b — All eligible candidates denied by compositionAllows → null');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'B', author: 'Bravo', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), denyAlways, compIdOf);
  check('pick is null',                              r.pick === null);
  check('trace.reason === no_eligible_candidate',    r.trace.reason === 'no_eligible_candidate', r.trace.reason);
}

// ── C5c: alreadyComposedKeys exclusion ───────────────────────────────────────
section('C5c — alreadyComposedKeys excludes a candidate (defensive)');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'B', author: 'Bravo', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit' }),
    mkBook({ id: 'C', author: 'Charlie', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.10, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(['B']), allowAlways, compIdOf);
  check('pick skips already-composed key', r.pick?.external_id === 'C', `got ${r.pick?.external_id}`);
}

// ── C6: ADJACENT stated candidate accepted under explicit_preference_edit ──
// Phase 2 product contract: dense users editing toward an off-lane genre
// routinely produce only adjacent_fit stated candidates because
// computeFitClass keys on the user's REVEALED dominant lane. The original
// CORE-only contract failed this case. The corrected policy widens
// reservation to adjacent_fit ONLY for the explicit_preference_edit cause.
section('C6 — ADJACENT stated candidate accepted under explicit_preference_edit (P2 product contract)');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['thriller_mystery' as AffinityKey] });
  const pool = [
    mkBook({
      id: 'B', author: 'Bravo',
      statedFlag: 'stated_favorite:thriller_mystery',
      statedTaste: 0.08,                              // P1 floor
      fitClass: 'adjacent_fit',                       // off dominant lane
      retrievalReason: 'stated_genre:thriller_mystery',
    }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is non-null when adjacent + explicit_preference_edit',
    r.pick !== null, `pick: ${r.pick?.external_id}`);
  check('trace.reason === reserved', r.trace.reason === 'reserved', r.trace.reason);
  check('trace.key === thriller_mystery', r.trace.key === 'thriller_mystery', r.trace.key);
  // Defense-in-depth — the global default is intentionally still conservative.
  // Adjacent acceptance comes from the per-cause allowlist, NOT from flipping
  // the global flag. Both invariants are asserted here so a future change
  // that relaxes one without the other will fail this case.
  check('STATED_RESERVATION_POLICY.allowAdjacentReservation === false (global default unchanged)',
    STATED_RESERVATION_POLICY.allowAdjacentReservation === false);
  check('STATED_RESERVATION_POLICY.allowAdjacentForCauses includes explicit_preference_edit',
    STATED_RESERVATION_POLICY.allowAdjacentForCauses.includes('explicit_preference_edit'));
}

// ── C6.neg: ADJACENT stated candidate REJECTED for non-allowlisted causes ──
section('C6.neg — ADJACENT stated candidate still rejected when cause not in allowAdjacentForCauses');
{
  // session_open is reservation-ineligible at the cause gate (returns
  // wrong_cause), so we exercise the fit-class gate via a hypothetical
  // future cause that might be added to eligibleCauses but NOT to
  // allowAdjacentForCauses. We simulate this by using ANOTHER eligible-
  // cause-but-not-adjacent-allowlisted scenario: at the time of writing,
  // eligibleCauses === allowAdjacentForCauses === ['explicit_preference_edit'],
  // so to prove the gate works we assert the policy invariant directly
  // AND prove session_open ADJACENT is rejected at the prior wrong_cause gate.
  const reqWrongCause = mkReq({ cause: 'session_open', favorites: ['thriller_mystery' as AffinityKey] });
  const pool = [
    mkBook({
      id: 'B', author: 'Bravo',
      statedFlag: 'stated_favorite:thriller_mystery',
      statedTaste: 0.08,
      fitClass: 'adjacent_fit',
      retrievalReason: 'stated_genre:thriller_mystery',
    }),
  ];
  const r = pickStatedReservation(pool, reqWrongCause, new Set(), allowAlways, compIdOf);
  check('session_open never reserves regardless of fit class',
    r.pick === null && r.trace.reason === 'wrong_cause', r.trace.reason);

  // Future-proofing: explicitly assert no non-edit cause is in the adjacent
  // allowlist. If a future maintainer adds intent_apply to eligibleCauses
  // they must consciously decide whether to also add it here.
  const adjacencyExtras = STATED_RESERVATION_POLICY.allowAdjacentForCauses.filter(
    c => c !== 'explicit_preference_edit',
  );
  check('allowAdjacentForCauses contains no causes other than explicit_preference_edit',
    adjacencyExtras.length === 0, `unexpected: ${adjacencyExtras.join(',')}`);
}

// ── C6.weak: weak_metadata ALWAYS rejected, even under explicit_preference_edit
section('C6.weak — weak_metadata flag is a hard reject regardless of fit class widening');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['thriller_mystery' as AffinityKey] });
  const pool = [
    mkBook({
      id: 'B', author: 'Bravo',
      statedFlag: 'stated_favorite:thriller_mystery',
      statedTaste: 0.12,
      fitClass: 'adjacent_fit',
      weakMetadata: true,                             // hard reject
      retrievalReason: 'stated_genre:thriller_mystery',
    }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('weak_metadata hard-rejects even when adjacent would otherwise pass',
    r.pick === null, `pick: ${r.pick?.external_id}`);
  check('gateCounts.weak_metadata recorded',
    (r.trace.gateCounts?.weak_metadata ?? 0) === 1,
    `weak=${r.trace.gateCounts?.weak_metadata}`);
}

// ── C6b: weak_metadata demotes a CORE candidate to non-CORE for reservation ─
section('C6b — weak_metadata flag demotes candidate (mirrors isCompCore)');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'B', author: 'B', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit', weakMetadata: true }),
    mkBook({ id: 'C', author: 'C', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.10, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('weak_metadata book skipped, next CORE used', r.pick?.external_id === 'C', `got ${r.pick?.external_id}`);
}

// ── C7: single-slot invariant ────────────────────────────────────────────────
section('C7 — STATED_RESERVATION_POLICY enforces single-slot invariant');
{
  check('maxReservedSlots === 1', STATED_RESERVATION_POLICY.maxReservedSlots === 1,
    `got ${STATED_RESERVATION_POLICY.maxReservedSlots}`);
  // Helper itself is single-call by API shape — verified by signature returning
  // a single pick. Multi-slot reservation would require a different helper.
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({ id: 'B', author: 'B', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit' }),
    mkBook({ id: 'C', author: 'C', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.11, fitClass: 'core_fit' }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('returns one pick (not array)', r.pick !== null && !Array.isArray(r.pick));
}

// ── C9: retrieval-provenance gate (P2B.1 audit fix) ─────────────────────────
section('C9 — Scoring-provenance fires but _retrieval_reason is NOT stated_genre: → SKIPPED');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  // Book has full scoring provenance (flag + positive contribution + CORE)
  // but arrived via the revealedLanes branch. Pre-P2B.1 this would have been
  // wrongly reserved — the architect audit's exact drift case.
  const pool = [
    mkBook({
      id: 'B', author: 'Bravo',
      statedFlag: 'stated_favorite:nonfiction',
      statedTaste: 0.12,
      fitClass: 'core_fit',
      retrievalReason: 'lane:scifi_fantasy',
    }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is null when retrieval reason is not stated_genre:',
    r.pick === null, `pick: ${r.pick?.external_id}`);
  check('trace.reason === no_eligible_candidate',
    r.trace.reason === 'no_eligible_candidate', r.trace.reason);
}

// ── C9b: other non-stated retrieval prefixes also fail ──────────────────────
section('C9b — author / liked_subject / genre / cache prefixes all fail retrieval gate');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const prefixes = [
    'author_anchor:Brandon Sanderson',
    'repeated_author:Brandon Sanderson',
    'liked_subject:dragons',
    'genre:fantasy_scifi',
    'cache:restored',
  ];
  for (const reason of prefixes) {
    const pool = [
      mkBook({
        id: 'B', author: 'B',
        statedFlag: 'stated_favorite:nonfiction',
        statedTaste: 0.12,
        fitClass: 'core_fit',
        retrievalReason: reason,
      }),
    ];
    const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
    check(`reason=${reason}: pick is null`, r.pick === null);
  }
}

// ── C10: AND-gate — both retrieval AND scoring provenance present → reserved
section('C10 — Strict AND-gate: stated_genre: prefix + scoring provenance → reserved');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({
      id: 'B', author: 'Bravo',
      statedFlag: 'stated_favorite:nonfiction',
      statedTaste: 0.12,
      fitClass: 'core_fit',
      retrievalReason: 'stated_genre:nonfiction',
    }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is non-null', r.pick !== null);
  check('trace.reason === reserved', r.trace.reason === 'reserved');
  check('trace.key === nonfiction', r.trace.key === 'nonfiction');
}

// ── C11: retrieval provenance only, no scoring contribution → SKIPPED ───────
section('C11 — stated_genre: prefix present but stated_taste = 0 → SKIPPED');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  // Models the realistic case where statedGenres fetched a book by subject
  // but the book's primaryGenre doesn't actually match the favorite, so
  // computeStatedTasteContribution returned 0 and no flag was pushed.
  const pool = [
    mkBook({
      id: 'B', author: 'B',
      statedFlag: null,
      statedTaste: 0,
      fitClass: 'core_fit',
      retrievalReason: 'stated_genre:nonfiction',
    }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is null when retrieval-only, no scoring',
    r.pick === null, `pick: ${r.pick?.external_id}`);
  check('trace.reason === no_eligible_candidate',
    r.trace.reason === 'no_eligible_candidate');
}

// ── C12: catalog/local source can never satisfy the contract ─────────────────
section('C12 — Catalog source (local:eligible) with full scoring → SKIPPED');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({
      id: 'B', author: 'B',
      statedFlag: 'stated_favorite:nonfiction',
      statedTaste: 0.12,
      fitClass: 'core_fit',
      retrievalReason: 'local:eligible',
    }),
    mkBook({
      id: 'C', author: 'C',
      statedFlag: 'stated_favorite:nonfiction',
      statedTaste: 0.10,
      fitClass: 'core_fit',
      retrievalReason: 'local:fallback_scan',
    }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('catalog/fallback books always skipped',
    r.pick === null, `pick: ${r.pick?.external_id}`);
  check('trace.reason === no_eligible_candidate',
    r.trace.reason === 'no_eligible_candidate');
}

// ── C12b: mixed pool — local book first, statedGenres book second → wins ────
section('C12b — Mixed pool: local book skipped, next stated_genre: candidate wins');
{
  const req = mkReq({ cause: 'explicit_preference_edit', favorites: ['nonfiction' as AffinityKey] });
  const pool = [
    mkBook({
      id: 'A', author: 'A',
      statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.15, fitClass: 'core_fit',
      retrievalReason: 'local:eligible',
    }),
    mkBook({
      id: 'B', author: 'B',
      statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit',
      retrievalReason: 'stated_genre:nonfiction',
    }),
  ];
  const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
  check('pick is the stated_genre: candidate (local skipped)',
    r.pick?.external_id === 'B', `got ${r.pick?.external_id}`);
  check('trace.reason === reserved', r.trace.reason === 'reserved');
}

// ── C8: cause membership ─────────────────────────────────────────────────────
section('C8 — eligibleCauses contains exactly explicit_preference_edit');
{
  check('eligibleCauses.length === 1',
    STATED_RESERVATION_POLICY.eligibleCauses.length === 1,
    `got ${STATED_RESERVATION_POLICY.eligibleCauses.length}`);
  check('eligibleCauses[0] === explicit_preference_edit',
    STATED_RESERVATION_POLICY.eligibleCauses[0] === 'explicit_preference_edit');

  // Verify that NONE of the other defined BuildCauses trigger reservation.
  const nonEligible: BuildCause[] = [
    'session_open', 'manual_refresh', 'intent_apply', 'intent_clear',
    'feedback_action', 'onboarding_completion',
  ];
  const pool = [mkBook({ id: 'B', author: 'B', statedFlag: 'stated_favorite:nonfiction', statedTaste: 0.12, fitClass: 'core_fit' })];
  for (const cause of nonEligible) {
    const req = mkReq({ cause, favorites: ['nonfiction' as AffinityKey] });
    const r = pickStatedReservation(pool, req, new Set(), allowAlways, compIdOf);
    check(`cause=${cause}: pick is null`,         r.pick === null);
    check(`cause=${cause}: reason=wrong_cause`,   r.trace.reason === 'wrong_cause');
  }
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'OK' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
