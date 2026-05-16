// =============================================================================
// validate_retrieval_contributions.ts — P3A-2 deterministic validator
//
// Run: `npx tsx scripts/validate_retrieval_contributions.ts` (exit 0 ok / 1 fail).
//
// Validation level: PURE CLASSIFIER + ATTACHMENT CONTRACT. Tests
// `classifyRetrievalReason` / `mapRetrievalContributions` and replays the
// merge-loop + scored-attachment shape from lib/recommender.ts using
// synthetic CandidateBook[] inputs. No live OL, no real scoring, no
// composition.
//
// Cases:
//   R1 single-reason       — one _retrieval_reasons entry → one contribution.
//   R2 multi-reason        — N reasons → N contributions, in arrival order.
//   R3 dominant invariant  — _retrieval_reason === _retrieval_reasons[0]
//                            === _retrieval_contributions[0].reason.
//   R4 prefix mapping      — every documented prefix maps to the right
//                            (source, signalClass, evidence.queryKind).
//   R5 cache-hit coherence — synthetic cache-restored candidate (only the
//                            singular reason populated) still produces a
//                            coherent contribution list when run through
//                            the same merge-loop init defaulting.
//   R6 ranking stability   — replay the merge-loop + attachment on a
//                            multi-branch fixture; assert the merged-pool
//                            order (which feeds scoring) is byte-identical
//                            to the no-contribution baseline. Contributions
//                            are additive metadata only.
//   R7 reservation intact  — singular `_retrieval_reason.startsWith('stated_genre:')`
//                            still fires for the appropriate candidates;
//                            the AND-gate's reason-source has not shifted.
//   R8 helper purity       — mapRetrievalContributions returns a fresh
//                            array; classifyRetrievalReason is referentially
//                            transparent for identical inputs.
// =============================================================================

import {
  classifyRetrievalReason,
  mapRetrievalContributions,
  mergeRetrievalReasons,
} from '../lib/scoring/contributions';
import type { RetrievalContribution } from '../lib/scoring/contributions';
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

// ── Fixture builder (mirrors recommender candidate shape) ────────────────────
function mkBook(externalId: string, reasons: string[]): CandidateBook {
  return {
    id:                `ol:${externalId}`,
    title:             'T',
    author:            'A',
    cover_url:         null,
    external_id:       externalId,
    subjects:          null,
    page_count:        null,
    description:       null,
    _source:           'open_library',
    _retrieval_reason: reasons[0] ?? '',
    _retrieval_reasons: [...reasons],
  };
}

// Replay the dedup/merge loop + the scored-attachment computation from
// lib/recommender.ts. Returns the would-be ScoredBook contribution arrays.
function replayAttach(resultSets: CandidateBook[][]): Array<{
  external_id: string | null;
  singular:    string;
  plural:      string[];
  contributions: RetrievalContribution[];
}> {
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
  return merged.map(b => {
    const reasonsForContrib =
         b._retrieval_reasons
      ?? (b._retrieval_reason ? [b._retrieval_reason] : []);
    return {
      external_id: b.external_id,
      singular:    b._retrieval_reason,
      plural:      [...(b._retrieval_reasons ?? [])],
      contributions: mapRetrievalContributions(reasonsForContrib),
    };
  });
}

// ── R1 — single-reason candidate ─────────────────────────────────────────────
section('R1 — single-reason candidate produces one contribution');
{
  const out = replayAttach([[mkBook('OL1W', ['stated_genre:thriller_mystery'])]]);
  check('one merged candidate', out.length === 1);
  check('one contribution', out[0].contributions.length === 1);
  const c = out[0].contributions[0];
  check('phase=retrieval', c.phase === 'retrieval');
  check('source=statedGenres', c.source === 'statedGenres', String(c.source));
  check('signalClass=stated_durable', c.signalClass === 'stated_durable');
}

// ── R2 — two/three-reason candidate ─────────────────────────────────────────
section('R2 — multi-reason candidate produces N contributions in order');
{
  const out = replayAttach([
    [mkBook('OL2W', ['stated_genre:thriller_mystery'])],
    [mkBook('OL2W', ['lane:modern_suspense'])],
    [mkBook('OL2W', ['liked_subject:psychological thriller'])],
  ]);
  check('one merged candidate', out.length === 1);
  check('three contributions', out[0].contributions.length === 3,
    `len=${out[0].contributions.length}`);
  check('contribution[0].source=statedGenres', out[0].contributions[0].source === 'statedGenres');
  check('contribution[1].source=revealedLanes', out[0].contributions[1].source === 'revealedLanes');
  check('contribution[2].source=revealedLanes', out[0].contributions[2].source === 'revealedLanes');
  check('arrival order matches plural[]',
    out[0].contributions.map(c => c.reason).join('|') === out[0].plural.join('|'));
}

// ── R3 — dominant invariant across batch ─────────────────────────────────────
section('R3 — dominant invariant: singular === plural[0] === contributions[0].reason');
{
  const out = replayAttach([
    [mkBook('A', ['stated_genre:fantasy_scifi']), mkBook('B', ['lane:literary'])],
    [mkBook('A', ['lane:scifi_fantasy']), mkBook('C', ['author_anchor:Hobb'])],
    [mkBook('B', ['liked_subject:literary fiction']), mkBook('C', ['repeated_author:Hobb'])],
  ]);
  check('three candidates', out.length === 3, `len=${out.length}`);
  for (const r of out) {
    check(`${r.external_id}: singular === plural[0]`,
      r.singular === r.plural[0],
      `singular=${r.singular} plural[0]=${r.plural[0]}`);
    check(`${r.external_id}: plural[0] === contributions[0].reason`,
      r.plural[0] === r.contributions[0].reason,
      `plural[0]=${r.plural[0]} contrib[0]=${r.contributions[0].reason}`);
  }
}

// ── R4 — full prefix mapping table ───────────────────────────────────────────
section('R4 — every documented prefix maps to the correct shape');
{
  const cases: Array<{
    reason: string;
    source: RetrievalContribution['source'];
    signalClass?: 'stated_durable' | 'revealed_behavioral';
    queryKind?: 'subject' | 'author' | 'title';
  }> = [
    { reason: 'stated_genre:nonfiction',  source: 'statedGenres',     signalClass: 'stated_durable',      queryKind: 'subject' },
    { reason: 'genre:fantasy_scifi',      source: 'revealedLanes',    signalClass: 'revealed_behavioral', queryKind: 'subject' },
    { reason: 'lane:modern_suspense',     source: 'revealedLanes',    signalClass: 'revealed_behavioral', queryKind: 'subject' },
    { reason: 'liked_subject:dragons',    source: 'revealedLanes',    signalClass: 'revealed_behavioral', queryKind: 'subject' },
    { reason: 'author_anchor:Hobb',       source: 'revealedAuthors',  signalClass: 'revealed_behavioral', queryKind: 'author'  },
    { reason: 'repeated_author:Hobb',     source: 'revealedAuthors',  signalClass: 'revealed_behavioral', queryKind: 'author'  },
    { reason: 'exact_series_seed:Farseer#1', source: 'exact_series_seed',                              queryKind: 'title' },
    { reason: 'local:eligible',           source: 'catalog' },
    { reason: 'local:fallback_scan',      source: 'fallback_scan' },
    { reason: 'cache:restored',           source: 'cached_external' },
    { reason: 'something_unmapped:foo',   source: 'unknown' },
  ];
  for (const tc of cases) {
    const c = classifyRetrievalReason(tc.reason);
    check(`reason="${tc.reason}" → source=${tc.source}`,
      c.source === tc.source, `got=${c.source}`);
    if (tc.signalClass) {
      check(`reason="${tc.reason}" → signalClass=${tc.signalClass}`,
        c.signalClass === tc.signalClass, `got=${c.signalClass}`);
    } else {
      check(`reason="${tc.reason}" → signalClass undefined`,
        c.signalClass === undefined, `got=${c.signalClass}`);
    }
    if (tc.queryKind) {
      check(`reason="${tc.reason}" → evidence.queryKind=${tc.queryKind}`,
        c.evidence?.queryKind === tc.queryKind, `got=${c.evidence?.queryKind}`);
    }
    check(`reason="${tc.reason}" → reason verbatim`, c.reason === tc.reason);
  }
}

// ── R5 — cache-restored candidate coherence ──────────────────────────────────
section('R5 — cache-restored candidate produces coherent contributions');
{
  // Simulate a cache-restore candidate: only the singular field is set
  // (older candidate predating the merge-loop init defaulting). The
  // attachment helper must still produce a contribution list of length 1.
  const restored: CandidateBook = {
    id: 'ol:OL5W', title: 'T', author: 'A',
    cover_url: null, external_id: 'OL5W', subjects: null,
    page_count: null, description: null,
    _source: 'cached_external',
    _retrieval_reason: 'stated_genre:thriller_mystery',
    // _retrieval_reasons intentionally omitted to simulate legacy shape.
  };
  const out = replayAttach([[restored]]);
  check('contribution list length 1',
    out[0].contributions.length === 1, `len=${out[0].contributions.length}`);
  check('contribution.source=statedGenres',
    out[0].contributions[0].source === 'statedGenres');
  check('plural backfilled from singular',
    out[0].plural.length === 1 && out[0].plural[0] === 'stated_genre:thriller_mystery');
}

// ── R6 — ranking stability (additive metadata only) ──────────────────────────
section('R6 — merged-pool order is unaffected by contribution attachment');
{
  // Snapshot the merged-pool external_id order BEFORE attachment vs. AFTER.
  // Since `mapRetrievalContributions` is pure-attachment with zero side
  // effects on the merge loop or candidate identity, the order MUST be
  // byte-identical. (This is the structural proof that no ranking signal
  // depends on the new contributions field today.)
  const fixture: CandidateBook[][] = [
    [mkBook('A', ['stated_genre:fantasy_scifi']), mkBook('B', ['lane:literary'])],
    [mkBook('A', ['lane:scifi_fantasy']), mkBook('C', ['author_anchor:Hobb'])],
    [mkBook('B', ['liked_subject:literary fiction']), mkBook('C', ['repeated_author:Hobb'])],
  ];
  // Baseline: deep-clone the fixture and run merge WITHOUT attachment.
  const cloned: CandidateBook[][] = fixture.map(set => set.map(b => ({ ...b, _retrieval_reasons: [...(b._retrieval_reasons ?? [])] })));
  const baselineSeen = new Set<string>();
  const baselineMerged: string[] = [];
  for (const set of cloned) {
    for (const b of set) {
      const k = b.external_id ?? b.id;
      if (baselineSeen.has(k)) continue;
      baselineSeen.add(k);
      baselineMerged.push(k);
    }
  }
  const withAttach = replayAttach(fixture).map(r => r.external_id ?? '');
  check('merged order byte-identical with vs. without attachment',
    JSON.stringify(baselineMerged) === JSON.stringify(withAttach),
    `baseline=${JSON.stringify(baselineMerged)} attach=${JSON.stringify(withAttach)}`);
}

// ── R7 — reservation AND-gate compatibility ──────────────────────────────────
section('R7 — stated-reservation AND-gate behaviour unchanged');
{
  const out = replayAttach([
    // A: stated dominant + lane secondary → must still pass startsWith.
    [mkBook('A', ['stated_genre:thriller_mystery'])],
    [mkBook('A', ['lane:modern_suspense'])],
    // B: lane dominant + stated secondary → must still FAIL startsWith
    //    (legacy AND-gate behaviour preserved per D1 spec).
    [mkBook('B', ['lane:modern_suspense'])],
    [mkBook('B', ['stated_genre:thriller_mystery'])],
  ]);
  const A = out.find(r => r.external_id === 'A')!;
  const B = out.find(r => r.external_id === 'B')!;
  check('A: dominant=stated_genre: passes legacy startsWith',
    A.singular.startsWith('stated_genre:'));
  check('A: contribution[0].source=statedGenres (matches dominant)',
    A.contributions[0].source === 'statedGenres');
  check('B: dominant=lane: still FAILS legacy startsWith (AND-gate intact)',
    !B.singular.startsWith('stated_genre:'),
    B.singular);
  check('B: contributions still record stated_genre: as secondary',
    B.contributions.some(c => c.reason === 'stated_genre:thriller_mystery'));
}

// ── R8 — helper purity ───────────────────────────────────────────────────────
section('R8 — purity of classifier and mapper');
{
  const a = classifyRetrievalReason('stated_genre:thriller_mystery');
  const b = classifyRetrievalReason('stated_genre:thriller_mystery');
  check('classifier deterministic across calls',
    a.source === b.source && a.signalClass === b.signalClass &&
    a.evidence?.queryValue === b.evidence?.queryValue);

  const reasons: readonly string[] = ['stated_genre:x', 'lane:y'];
  const r1 = mapRetrievalContributions(reasons);
  const r2 = mapRetrievalContributions(reasons);
  check('mapper returns fresh array each call', r1 !== r2);
  check('mapper output length === input length', r1.length === reasons.length);
  check('input array unmodified', reasons.length === 2 && reasons[0] === 'stated_genre:x');
}

// ── Summary ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}` +
  `${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
