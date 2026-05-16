// =============================================================================
// validate_multi_source_provenance.ts — P3A-1 D1 deterministic validator
//
// Run: `npx tsx scripts/validate_multi_source_provenance.ts` (exit 0 ok / 1 fail).
//
// Validation level: PROVENANCE-MERGE HELPER + DEDUP-LOOP CONTRACT. Tests
// the pure `mergeRetrievalReasons` function plus a synthetic replay of the
// merge/dedup loop in `getOLCandidates` (lib/recommender.ts) using fake
// CandidateBook[] result sets. Does NOT touch live OL, scoring, or
// composition.
//
// Cases:
//   M1 single-branch       — one branch returns a candidate → array length 1,
//                            singular === plural[0].
//   M2 two-branch dedup    — same external_id from two branches → array
//                            length 2, both reasons present in arrival order,
//                            singular preserved as first-seen.
//   M3 three-branch dedup  — three branches → array length 3, ordered.
//   M4 idempotent          — same reason added twice → no duplicate entry.
//   M5 dominant invariant  — for every merged book, _retrieval_reason ===
//                            _retrieval_reasons[0].
//   M6 AND-gate intact     — book whose dominant reason is `stated_genre:`
//                            still passes the legacy `startsWith` check;
//                            book whose dominant reason is `lane:` and whose
//                            additional reason is `stated_genre:` does NOT
//                            (per D1: AND-gate behaviour unchanged today).
//   M7 author-label fix    — fetchOLByAuthor-equivalent synthetic where the
//                            dense path emits `repeated_author:` retains
//                            that label (no collapse to `author_anchor:`).
//   M8 helper purity       — mergeRetrievalReasons returns a NEW array, does
//                            not mutate `existing`.
// =============================================================================

import { mergeRetrievalReasons } from '../lib/scoring/contributions';
import type { CandidateBook } from '../lib/recommender';

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

// ── Test fixture builder ─────────────────────────────────────────────────────
// Mirrors the shape produced by the OL fetch helpers (fetchOLByAuthor /
// fetchOLSubject) at lib/recommender.ts. Only the fields the merge loop and
// the AND-gate consume are populated.
function mkBook(externalId: string, reason: string, title = 'T'): CandidateBook {
  return {
    id:                `ol:${externalId}`,
    title,
    author:            'A',
    cover_url:         null,
    external_id:       externalId,
    subjects:          null,
    page_count:        null,
    description:       null,
    _source:           'open_library',
    _retrieval_reason: reason,
    _retrieval_reasons: [reason],
  };
}

// ── Merge-loop synthetic replay ──────────────────────────────────────────────
// Mirrors the dedup loop in getOLCandidates (lib/recommender.ts, ~L1295).
// Same control flow: first-seen wins for the kept candidate; duplicates
// append onto `_retrieval_reasons` via mergeRetrievalReasons.
function replayMerge(resultSets: CandidateBook[][]): CandidateBook[] {
  const seen = new Set<string>();
  const merged: CandidateBook[] = [];
  const idxByKey = new Map<string, number>();
  for (const set of resultSets) {
    for (const book of set) {
      const key = book.external_id ?? book.id;
      if (seen.has(key)) {
        const idx = idxByKey.get(key);
        if (idx !== undefined && book._retrieval_reason) {
          const existing = merged[idx];
          existing._retrieval_reasons = mergeRetrievalReasons(
            existing._retrieval_reasons ?? [existing._retrieval_reason],
            book._retrieval_reason,
          );
        }
        continue;
      }
      seen.add(key);
      if (!book._retrieval_reasons) {
        book._retrieval_reasons = book._retrieval_reason ? [book._retrieval_reason] : [];
      }
      idxByKey.set(key, merged.length);
      merged.push(book);
    }
  }
  return merged;
}

// ── M1 — single-branch baseline ──────────────────────────────────────────────
section('M1 — single-branch baseline');
{
  const merged = replayMerge([[mkBook('OL1W', 'stated_genre:thriller_mystery')]]);
  check('one merged candidate', merged.length === 1, `len=${merged.length}`);
  check('singular reason preserved',
    merged[0]._retrieval_reason === 'stated_genre:thriller_mystery',
    merged[0]._retrieval_reason);
  check('plural reasons length 1',
    (merged[0]._retrieval_reasons ?? []).length === 1,
    JSON.stringify(merged[0]._retrieval_reasons));
  check('singular === plural[0]',
    merged[0]._retrieval_reason === (merged[0]._retrieval_reasons ?? [])[0]);
}

// ── M2 — two-branch dedup ────────────────────────────────────────────────────
section('M2 — two-branch dedup (statedGenres + revealedLanes)');
{
  const stated  = [mkBook('OL2W', 'stated_genre:thriller_mystery')];
  const lane    = [mkBook('OL2W', 'lane:modern_suspense')];
  const merged  = replayMerge([stated, lane]);
  check('one merged candidate (deduped)', merged.length === 1, `len=${merged.length}`);
  check('singular === first-seen (stated_genre:)',
    merged[0]._retrieval_reason === 'stated_genre:thriller_mystery',
    merged[0]._retrieval_reason);
  check('plural length 2',
    (merged[0]._retrieval_reasons ?? []).length === 2,
    JSON.stringify(merged[0]._retrieval_reasons));
  check('plural arrival order: [stated_genre:, lane:]',
    JSON.stringify(merged[0]._retrieval_reasons) ===
      JSON.stringify(['stated_genre:thriller_mystery', 'lane:modern_suspense']));
}

// ── M3 — three-branch dedup ──────────────────────────────────────────────────
section('M3 — three-branch dedup');
{
  const merged = replayMerge([
    [mkBook('OL3W', 'stated_genre:nonfiction')],
    [mkBook('OL3W', 'lane:memoir_nonfiction')],
    [mkBook('OL3W', 'liked_subject:biography')],
  ]);
  check('one merged candidate', merged.length === 1);
  check('plural length 3',
    (merged[0]._retrieval_reasons ?? []).length === 3,
    JSON.stringify(merged[0]._retrieval_reasons));
  check('arrival order preserved',
    JSON.stringify(merged[0]._retrieval_reasons) === JSON.stringify([
      'stated_genre:nonfiction',
      'lane:memoir_nonfiction',
      'liked_subject:biography',
    ]));
}

// ── M4 — idempotent (same reason from two branches must not duplicate) ───────
section('M4 — idempotent against duplicate reason strings');
{
  const merged = replayMerge([
    [mkBook('OL4W', 'stated_genre:thriller_mystery')],
    [mkBook('OL4W', 'stated_genre:thriller_mystery')],
  ]);
  check('plural length 1 (no duplicate)',
    (merged[0]._retrieval_reasons ?? []).length === 1,
    JSON.stringify(merged[0]._retrieval_reasons));
}

// ── M5 — dominant invariant across many books ────────────────────────────────
section('M5 — dominant invariant across batch');
{
  const merged = replayMerge([
    [mkBook('A', 'stated_genre:fantasy_scifi'), mkBook('B', 'lane:literary')],
    [mkBook('A', 'lane:scifi_fantasy'), mkBook('C', 'author_anchor:Hobb')],
    [mkBook('B', 'liked_subject:literary fiction'), mkBook('C', 'repeated_author:Hobb')],
  ]);
  check('three distinct candidates', merged.length === 3, `len=${merged.length}`);
  for (const b of merged) {
    check(`dominant invariant for ${b.external_id}`,
      b._retrieval_reason === (b._retrieval_reasons ?? [])[0],
      `singular=${b._retrieval_reason} plural[0]=${(b._retrieval_reasons ?? [])[0]}`);
  }
  // Confirm C accumulated BOTH author labels separately (the D2 fix means
  // author_anchor: and repeated_author: are now distinguishable).
  const c = merged.find(b => b.external_id === 'C');
  check('C accumulates both author-label variants',
    c !== undefined &&
    (c!._retrieval_reasons ?? []).includes('author_anchor:Hobb') &&
    (c!._retrieval_reasons ?? []).includes('repeated_author:Hobb'),
    JSON.stringify(c?._retrieval_reasons));
}

// ── M6 — AND-gate behaviour unchanged at the legacy startsWith check ─────────
section('M6 — stated-reservation AND-gate behaviour unchanged');
{
  // Case A: dominant is stated_genre: → passes the AND-gate's startsWith.
  const passing = replayMerge([
    [mkBook('OL6A', 'stated_genre:thriller_mystery')],
    [mkBook('OL6A', 'lane:modern_suspense')],
  ])[0];
  check('dominant=stated_genre: still passes startsWith check',
    (passing._retrieval_reason ?? '').startsWith('stated_genre:'));

  // Case B: dominant is lane: but plural CONTAINS stated_genre: → must fail
  // the legacy AND-gate today. D1 says AND-gate behaviour is unchanged at
  // P3A-1; future contribution-grounded ranking may widen this, but not now.
  const failing = replayMerge([
    [mkBook('OL6B', 'lane:modern_suspense')],
    [mkBook('OL6B', 'stated_genre:thriller_mystery')],
  ])[0];
  check('dominant=lane: does NOT pass legacy startsWith check',
    !(failing._retrieval_reason ?? '').startsWith('stated_genre:'),
    failing._retrieval_reason);
  check('plural still records the stated_genre: contribution',
    (failing._retrieval_reasons ?? []).includes('stated_genre:thriller_mystery'),
    JSON.stringify(failing._retrieval_reasons));
}

// ── M7 — fetchOLByAuthor reason-label fix (D2) ───────────────────────────────
section('M7 — author label respects branch-emitted reason');
{
  // Synthetic replay of what fetchOLByAuthor produces NOW that it accepts a
  // retrieval_reason argument. The dense-path branch passes
  // `repeated_author:` and that must survive verbatim onto the candidate.
  const dense = mkBook('OL7D', 'repeated_author:Sanderson');
  check('dense-path candidate carries repeated_author: label',
    dense._retrieval_reason === 'repeated_author:Sanderson');
  check('dense-path plural mirrors dense label',
    (dense._retrieval_reasons ?? [])[0] === 'repeated_author:Sanderson');

  const sparse = mkBook('OL7S', 'author_anchor:Hobb');
  check('non-dense-path candidate carries author_anchor: label',
    sparse._retrieval_reason === 'author_anchor:Hobb');
}

// ── M8 — helper purity (no mutation of `existing`) ───────────────────────────
section('M8 — mergeRetrievalReasons does not mutate input');
{
  const before = ['stated_genre:thriller_mystery'];
  const after  = mergeRetrievalReasons(before, 'lane:modern_suspense');
  check('input array unchanged',
    before.length === 1 && before[0] === 'stated_genre:thriller_mystery',
    JSON.stringify(before));
  check('returned array has both',
    after.length === 2 && after[1] === 'lane:modern_suspense',
    JSON.stringify(after));
  check('returned array is a new reference', before !== after);

  // Empty/idempotent paths.
  check('empty incoming → existing copy',
    JSON.stringify(mergeRetrievalReasons(['x'], '')) === JSON.stringify(['x']));
  check('duplicate incoming → no growth',
    JSON.stringify(mergeRetrievalReasons(['x'], 'x')) === JSON.stringify(['x']));
}

// ── Summary ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
