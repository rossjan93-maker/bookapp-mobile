// =============================================================================
// scripts/validate_book_evidence.ts — BookEvidence Batch B contract validator
//
// Acceptance gate for the typed `deriveBookEvidence(book)` layer. Exit 0 = green.
//
// Sections:
//   §1 Signal-list migration parity — exported SignalSet entries in
//      lib/evidence/signals.ts equal the partition of the original
//      bookTraits.ts constants (inline-snapshotted below).
//   §2 deriveBookEvidence purity — pure, frozen, robust to null/empty inputs.
//   §3 Corpus parity — evidence.corpus.semantic / .surface match the prior
//      buildSemanticCorpus / buildCorpus shapes.
//   §4 BookTraits byte-identity — getBookTraits(book) returns the expected
//      tone / pace / complexity / confidence values across a canonical
//      fixture matrix (incl. fixtures cited by validate_intent_lens et al.).
//   §5 IntentEligibilityVerdict byte-identity — evaluateBookAgainstIntentLens
//      verdicts on the same fixtures × the four canonical lenses.
//   §6 Fixture inclusion proof — coverage spans the union of fixtures used
//      by sibling validators (Gone Girl, Thursday Murder Club, Silent
//      Patient, Verity, Everything I Never Told You).
//   §7 Public surface stability — no removed exports from bookTraits.ts /
//      nextReadIntent.ts; IntentEligibilityVerdict shape unchanged.
//   §8 Composer / RecCard untouched (import surface check).
//   §9 recValidity.VERSION pinned (rcv8 from Phase B.0 2026-05-26).
// =============================================================================

import {
  deriveBookEvidence,
} from '../lib/evidence/bookEvidence';
import {
  TONE_DARK, TONE_LIGHT,
  PACE_FAST, PACE_SLOW,
  COMPLEXITY_ACCESSIBLE, COMPLEXITY_LITERARY, COMPLEXITY_DENSE,
  DARK_SIGNALS, DOMESTIC_SUSPENSE_SUPPORT_SIGNALS,
  countMatchesDetailed,
  type SignalSet,
} from '../lib/evidence/signals';
import {
  getBookTraits,
  classifyTone, classifyPace, classifyComplexity,
  classifyToneFromEvidence, classifyPaceFromEvidence, classifyComplexityFromEvidence,
} from '../lib/bookTraits';
import {
  evaluateBookAgainstIntentLens,
  getIntentExclusionReason,
  emptyIntent,
  type NextReadIntent,
} from '../lib/nextReadIntent';
import type { MarketPosition } from '../lib/fitClassifier';
import { computeRecConfigHash } from '../lib/recValidity';

import * as fs from 'fs';
import * as path from 'path';

// ── reporting helpers ────────────────────────────────────────────────────────
let _passed = 0;
let _failed = 0;
function ok(msg: string)   { _passed++; console.log(`  ✓ ${msg}`); }
function fail(msg: string) { _failed++; console.error(`  ✗ ${msg}`); }
function header(t: string) { console.log(`\n${t}`); }
function assert(cond: boolean, msg: string) { (cond ? ok : fail)(msg); }
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(msg);
  else fail(`${msg}\n      expected: ${e}\n      actual:   ${a}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Signal-list migration parity
// ─────────────────────────────────────────────────────────────────────────────
// Inline snapshots of the ORIGINAL bookTraits.ts private constants. The
// partition rule (single-token entries fold into BROAD; phrasal entries stay
// SPECIFIC) is applied at this layer; the SignalSet in signals.ts must match
// the result element-by-element.

const ORIG = {
  TONE_DARK_SPECIFIC: [
    'dark fantasy', 'dark fiction', 'dark themes', 'grimdark', 'noir',
    'psychological thriller', 'psychological horror', 'gothic horror',
    'true crime', 'trauma', 'grief', 'bleak', 'grim',
    'tragedy', 'tragic',
  ],
  TONE_DARK_BROAD: [
    'horror', 'thriller', 'murder', 'death', 'war', 'violence',
  ],
  TONE_LIGHT_SPECIFIC: [
    'cozy mystery', 'cozy fantasy', 'cozy fiction', 'romantic comedy',
    'feel-good', 'feel good', 'heartwarming', 'uplifting',
    'humorous fiction', 'comic fiction', 'comedic',
    'beach read',
  ],
  TONE_LIGHT_BROAD: [
    'humor', 'humour', 'comedy', 'funny', 'witty', 'cozy', 'lighthearted',
    'light-hearted',
  ],
  PACE_FAST_SPECIFIC: [
    'page-turner', 'page turner', 'fast-paced', 'fast paced',
    'psychological thriller', 'action-packed', 'action packed',
    'spy thriller', 'spy novel', 'crime thriller', 'legal thriller',
    'medical thriller',
  ],
  PACE_FAST_BROAD: [
    'thriller', 'suspense', 'action', 'fast',
  ],
  PACE_SLOW_SPECIFIC: [
    'slow-burn', 'slow burn', 'literary fiction', 'literary novel',
    'meditative', 'contemplative', 'philosophical fiction',
    'character study', 'reflective',
  ],
  PACE_SLOW_BROAD: [
    'literary', 'philosophical', 'contemplation', 'introspective',
  ],
  COMPLEXITY_ACCESSIBLE_SPECIFIC: [
    'self-help', 'self help', 'how-to', 'beach read', 'cozy mystery',
    'cozy fantasy', 'popular nonfiction', 'popular science', 'pop science',
    'commercial fiction',
  ],
  COMPLEXITY_ACCESSIBLE_BROAD: [
    'accessible', 'commercial', 'popular', 'beginner',
  ],
  COMPLEXITY_LITERARY_SPECIFIC: [
    'literary fiction', 'literary novel', 'lyrical prose',
    'man booker', 'booker prize', 'national book award', 'pulitzer prize',
  ],
  COMPLEXITY_LITERARY_BROAD: [
    'literary', 'lyrical',
  ],
  COMPLEXITY_DENSE_SPECIFIC: [
    'academic', 'scholarly', 'theoretical', 'experimental fiction',
    'postmodern', 'philosophical treatise', 'critical theory',
    'monograph', 'dissertation',
  ],
  COMPLEXITY_DENSE_BROAD: [
    'dense', 'epic', 'philosophy', 'theology', 'theory',
  ],
};

function isPhrasal(s: string): boolean { return /[\s-]/.test(s.trim()); }
function partition(spec: string[], broad: string[]): { specific: string[]; broad: string[] } {
  const phrasal: string[] = [];
  const tokens:  string[] = [];
  for (const s of spec) (isPhrasal(s) ? phrasal : tokens).push(s);
  return { specific: phrasal, broad: [...broad, ...tokens] };
}

function checkPartition(name: string, set: SignalSet, spec: string[], broad: string[]) {
  const expected = partition(spec, broad);
  assertEq([...set.specific], expected.specific, `§1 ${name}.specific = phrasal entries from original SPECIFIC`);
  assertEq([...set.broad],    expected.broad,    `§1 ${name}.broad    = original BROAD + single-token SPECIFIC`);
}

function section1() {
  header('§1 Signal-list migration parity');
  checkPartition('TONE_DARK',            TONE_DARK,            ORIG.TONE_DARK_SPECIFIC,            ORIG.TONE_DARK_BROAD);
  checkPartition('TONE_LIGHT',           TONE_LIGHT,           ORIG.TONE_LIGHT_SPECIFIC,           ORIG.TONE_LIGHT_BROAD);
  checkPartition('PACE_FAST',            PACE_FAST,            ORIG.PACE_FAST_SPECIFIC,            ORIG.PACE_FAST_BROAD);
  checkPartition('PACE_SLOW',            PACE_SLOW,            ORIG.PACE_SLOW_SPECIFIC,            ORIG.PACE_SLOW_BROAD);
  checkPartition('COMPLEXITY_ACCESSIBLE',COMPLEXITY_ACCESSIBLE,ORIG.COMPLEXITY_ACCESSIBLE_SPECIFIC,ORIG.COMPLEXITY_ACCESSIBLE_BROAD);
  checkPartition('COMPLEXITY_LITERARY',  COMPLEXITY_LITERARY,  ORIG.COMPLEXITY_LITERARY_SPECIFIC,  ORIG.COMPLEXITY_LITERARY_BROAD);
  checkPartition('COMPLEXITY_DENSE',     COMPLEXITY_DENSE,     ORIG.COMPLEXITY_DENSE_SPECIFIC,     ORIG.COMPLEXITY_DENSE_BROAD);
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 — deriveBookEvidence purity
// ─────────────────────────────────────────────────────────────────────────────
function section2() {
  header('§2 deriveBookEvidence purity');

  // (a) Deterministic — same input twice → deep-equal output.
  const book = { subjects: ['psychological thriller', 'mystery'], title: 'X', description: 'A dark suspense.' };
  const a = deriveBookEvidence(book);
  const b = deriveBookEvidence(book);
  assertEq(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), '§2 deterministic across two calls');

  // (b) Robust to null / empty / minimal.
  const empty = deriveBookEvidence(null);
  assertEq(empty.input.subjects.length, 0, '§2 null book → subjects = []');
  assertEq(empty.input.title, '',           '§2 null book → title = ""');
  assertEq(empty.input.description, '',     '§2 null book → description = ""');
  assertEq(empty.input.pageCount, null,     '§2 null book → pageCount = null');
  assertEq(empty.toneDark.specificCount, 0, '§2 null book → toneDark.specificCount = 0');
  assertEq(empty.darkPhrasal.matched, false,'§2 null book → darkPhrasal.matched = false');

  const undef = deriveBookEvidence(undefined);
  assertEq(undef.input.title, '', '§2 undefined book → title = ""');

  // (c) Frozen — defense-in-depth.
  assert(Object.isFrozen(a),                       '§2 returned object is frozen');
  assert(Object.isFrozen(a.corpus),                '§2 corpus is frozen');
  assert(Object.isFrozen(a.input),                 '§2 input is frozen');
  assert(Object.isFrozen(a.toneDark),              '§2 toneDark axis is frozen');
  assert(Object.isFrozen(a.darkPhrasal),           '§2 darkPhrasal is frozen');
  assert(Object.isFrozen(a.domesticSuspenseSupport),'§2 domesticSuspenseSupport is frozen');

  // (d) countMatchesDetailed matches what AxisMatch stores.
  const directDark = countMatchesDetailed(a.corpus.semantic, TONE_DARK);
  assertEq(
    {
      specificCount: a.toneDark.specificCount,
      broadCount:    a.toneDark.broadCount,
      firstSpecific: a.toneDark.firstSpecific,
      firstBroad:    a.toneDark.firstBroad,
    },
    directDark,
    '§2 axisMatch matches direct countMatchesDetailed on TONE_DARK',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Corpus parity
// ─────────────────────────────────────────────────────────────────────────────
function legacySemantic(book: { subjects?: string[] | null; description?: string | null }): string {
  return `${(book.subjects ?? []).join(' ')} ${book.description ?? ''}`;
}
function legacySurface(book: { subjects?: string[] | null; title?: string | null }): string {
  return [...(book.subjects ?? []), book.title ?? ''].join(' ').toLowerCase();
}

function section3() {
  header('§3 Corpus parity');
  for (const f of FIXTURES) {
    const ev = deriveBookEvidence(f.book);
    assertEq(ev.corpus.semantic, legacySemantic(f.book), `§3 [${f.id}] semantic corpus = legacy buildSemanticCorpus`);
    assertEq(ev.corpus.surface,  legacySurface(f.book),  `§3 [${f.id}] surface corpus  = legacy buildCorpus (lowercased)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture matrix — covers the union of titles used by sibling validators:
//   Gone Girl, Thursday Murder Club, Silent Patient, Verity,
//   Everything I Never Told You, plus form/pace/complexity fixtures.
// ─────────────────────────────────────────────────────────────────────────────
type Fixture = {
  id: string;
  book: { subjects?: string[] | null; title?: string | null; description?: string | null; page_count?: number | null };
  marketPos: MarketPosition;
  expectedTraits: {
    tone: 'dark' | 'light' | 'mixed' | 'unknown';
    toneConfidence: 'specific' | 'broad' | 'unknown';
    pace: 'fast' | 'medium' | 'slow' | 'unknown';
    paceConfidence: 'specific' | 'broad' | 'unknown';
    complexity: 'accessible' | 'literary' | 'dense' | 'unknown';
    complexityConfidence: 'specific' | 'broad' | 'unknown';
  };
  // Per-lens hardExclusion expectations (lens id → list of reasons in order).
  // Lenses tested: 'noDark', 'lessDark', 'noClassics', 'empty'.
  expectedHardReasons: {
    noDark:     string[];
    lessDark:   string[];
    noClassics: string[];
    empty:      string[];
  };
};

const FIXTURES: Fixture[] = [
  {
    id: 'gone_girl',
    book: {
      subjects: ['psychological thriller', 'domestic suspense', 'fiction', 'mystery'],
      title: 'Gone Girl',
      description: 'A dark and twisting story about marriage and betrayal.',
      page_count: 432,
    },
    marketPos: 'domestic_suspense',
    expectedTraits: {
      // 'dark' broad (from 'dark and twisting'), 'psychological thriller' specific
      // 'psychological thriller', 'thriller', 'mystery' — dark specific.
      tone: 'dark', toneConfidence: 'specific',
      // 'psychological thriller' specific in PACE_FAST, plus 'thriller' broad.
      pace: 'fast', paceConfidence: 'specific',
      complexity: 'unknown', complexityConfidence: 'unknown',
    },
    expectedHardReasons: {
      noDark:     ['avoid_dark'],
      lessDark:   [],
      noClassics: [],
      empty:      [],
    },
  },
  {
    id: 'thursday_murder_club',
    book: {
      subjects: ['mystery', 'cozy mystery', 'detective', 'crime fiction', 'mystery fiction'],
      title: 'The Thursday Murder Club',
      description: 'A heartwarming mystery set in a peaceful retirement village.',
      page_count: 400,
    },
    marketPos: 'cozy_detective',
    expectedTraits: {
      // 'cozy mystery' specific light, 'heartwarming' folded broad (now broad-folded). Light strong.
      // 'murder' broad dark from title via surface; but TONE classifier uses SEMANTIC corpus
      // (subjects + description). semantic = 'mystery cozy mystery detective crime fiction
      //  mystery fiction A heartwarming mystery set in a peaceful retirement village.'
      // → cozy mystery (spec light), 'heartwarming' (folded broad light) → lightStrong, no dark
      // (no 'murder' in semantic, just title).
      tone: 'light', toneConfidence: 'specific',
      pace: 'unknown', paceConfidence: 'unknown',
      // 'cozy mystery' is in COMPLEXITY_ACCESSIBLE_SPECIFIC.
      complexity: 'accessible', complexityConfidence: 'specific',
    },
    expectedHardReasons: {
      // No-dark: classifyTone=light. DARK_SIGNALS phrasal on SURFACE corpus —
      // surface = subjects + title (lower) → includes 'murder' (broad)? murder is
      // in DARK_SIGNALS.broad as 'murders'? Actually DARK_SIGNALS doesn't include
      // bare 'murder' (P4C.1 follow-up #7 removed it). Domestic suspense rule
      // doesn't apply (marketPos = cozy_mystery). → no hard exclusion.
      noDark:     [],
      lessDark:   [],
      noClassics: [],
      empty:      [],
    },
  },
  {
    id: 'silent_patient',
    book: {
      subjects: ['psychological thriller', 'family violence', 'mental illness', 'psychotherapy patient'],
      title: 'The Silent Patient',
      description: 'A psychological thriller about a woman who shoots her husband.',
      page_count: 336,
    },
    marketPos: 'domestic_suspense',
    expectedTraits: {
      tone: 'dark', toneConfidence: 'specific',
      pace: 'fast', paceConfidence: 'specific',
      complexity: 'unknown', complexityConfidence: 'unknown',
    },
    expectedHardReasons: {
      noDark:     ['avoid_dark'],
      lessDark:   [],
      noClassics: [],
      empty:      [],
    },
  },
  {
    id: 'verity',
    book: {
      subjects: ['psychological thriller', 'domestic thriller', 'romantic suspense', 'fiction'],
      title: 'Verity',
      description: 'A dark psychological thriller with disturbing revelations.',
      page_count: 336,
    },
    marketPos: 'domestic_suspense',
    expectedTraits: {
      tone: 'dark', toneConfidence: 'specific',
      pace: 'fast', paceConfidence: 'specific',
      complexity: 'unknown', complexityConfidence: 'unknown',
    },
    expectedHardReasons: {
      noDark:     ['avoid_dark'],
      lessDark:   [],
      noClassics: [],
      empty:      [],
    },
  },
  {
    id: 'everything_i_never_told_you',
    book: {
      subjects: ['literary fiction', 'family secrets', 'fiction', 'asian american'],
      title: 'Everything I Never Told You',
      description: 'A literary novel about a family processing grief after their daughter dies.',
      page_count: 304,
    },
    marketPos: 'literary_prestige',
    expectedTraits: {
      // 'grief' single-token folded into TONE_DARK.broad. Just 1 broad → not strong.
      // No light. Tone: unknown.
      tone: 'unknown', toneConfidence: 'unknown',
      // 'literary fiction' specific slow, 'literary' broad. slow strong.
      pace: 'slow', paceConfidence: 'specific',
      // 'literary fiction' specific literary, 'literary novel' specific literary.
      complexity: 'literary', complexityConfidence: 'specific',
    },
    expectedHardReasons: {
      // No-dark: tone classifier=unknown (semantic includes 'grief' but
      // 'grief' is a single token folded into TONE_DARK.broad — 1 broad hit
      // alone is not strong). DARK_SIGNALS phrasal runs on the SURFACE corpus
      // (subjects + title only, no description) → no 'grief' there. Market
      // position is literary_prestige, not domestic_suspense. → no hard
      // exclusion under noDark. (avoid_literary is NOT enabled in this lens.)
      noDark:     [],
      lessDark:   [],
      noClassics: [],
      empty:      [],
    },
  },
  {
    id: 'project_hail_mary',
    book: {
      subjects: ['science fiction', 'space opera', 'fiction'],
      title: 'Project Hail Mary',
      description: 'A fast-paced page-turner about a lone astronaut saving Earth.',
      page_count: 476,
    },
    marketPos: 'general_fiction',
    expectedTraits: {
      tone: 'unknown', toneConfidence: 'unknown',
      pace: 'fast', paceConfidence: 'specific',
      complexity: 'unknown', complexityConfidence: 'unknown',
    },
    expectedHardReasons: { noDark: [], lessDark: [], noClassics: [], empty: [] },
  },
  {
    id: 'house_of_leaves',
    book: {
      subjects: ['horror fiction', 'experimental fiction', 'postmodern', 'fiction'],
      title: 'House of Leaves',
      description: 'An experimental, postmodern horror novel.',
      page_count: 736,
    },
    marketPos: 'literary_prestige',
    expectedTraits: {
      // 'horror' (broad), 'horror' in semantic, plus DARK in description has 'horror'.
      // semantic includes 'horror fiction', 'horror'. dark spec ≥ 1? 'horror fiction'
      // is NOT in TONE_DARK.specific (we have 'dark fantasy','dark fiction','dark themes',
      // 'psychological thriller','psychological horror','gothic horror','true crime'). 'horror'
      // is broad. Broad count ≥ 2: 'horror' appears multiple times but distinct matchers count.
      // Only 1 distinct broad phrase fires ('horror'). So darkBroad=1, not strong.
      // No light. → unknown.
      tone: 'unknown', toneConfidence: 'unknown',
      pace: 'unknown', paceConfidence: 'unknown',
      // 'experimental fiction' specific dense.
      complexity: 'dense', complexityConfidence: 'specific',
    },
    expectedHardReasons: {
      // No-dark: tone unknown (broad-only doesn't fire dark via classifier).
      // DARK_SIGNALS phrasal: surface has 'horror fiction' which IS in DARK_SIGNALS.specific!
      // → phrasalHit='horror fiction' → hardExclude.
      noDark:     ['avoid_dark'],
      lessDark:   [],
      noClassics: [],
      empty:      [],
    },
  },
  {
    id: 'pride_and_prejudice',
    book: {
      subjects: ['classics', 'romance', 'fiction', 'literary'],
      title: 'Pride and Prejudice',
      description: 'A witty comedy of manners about love and marriage.',
      page_count: 432,
    },
    marketPos: 'classic_canon',
    expectedTraits: {
      // 'witty' broad light, 'comedy' broad light → lightStrong (2 broad). 'literary' broad
      // pace → broad slow only (1 broad, not strong). No dark.
      tone: 'light', toneConfidence: 'broad',
      pace: 'unknown', paceConfidence: 'unknown',
      // 'literary' broad complexity (1 broad). Need 2 broad for literary broad. Not strong.
      complexity: 'unknown', complexityConfidence: 'unknown',
    },
    expectedHardReasons: {
      noDark:     [],
      lessDark:   [],
      noClassics: ['avoid_classics'],
      empty:      [],
    },
  },
  {
    id: 'empty_book',
    book: { subjects: [], title: '', description: '', page_count: null },
    marketPos: 'general_fiction',
    expectedTraits: {
      tone: 'unknown', toneConfidence: 'unknown',
      pace: 'unknown', paceConfidence: 'unknown',
      complexity: 'unknown', complexityConfidence: 'unknown',
    },
    expectedHardReasons: { noDark: [], lessDark: [], noClassics: [], empty: [] },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// §4 — BookTraits byte-identity
// ─────────────────────────────────────────────────────────────────────────────
function section4() {
  header('§4 BookTraits byte-identity');
  for (const f of FIXTURES) {
    const t = getBookTraits(f.book);
    assertEq(t.tone,                 f.expectedTraits.tone,                 `§4 [${f.id}] tone`);
    assertEq(t.toneConfidence,       f.expectedTraits.toneConfidence,       `§4 [${f.id}] toneConfidence`);
    assertEq(t.pace,                 f.expectedTraits.pace,                 `§4 [${f.id}] pace`);
    assertEq(t.paceConfidence,       f.expectedTraits.paceConfidence,       `§4 [${f.id}] paceConfidence`);
    assertEq(t.complexity,           f.expectedTraits.complexity,           `§4 [${f.id}] complexity`);
    assertEq(t.complexityConfidence, f.expectedTraits.complexityConfidence, `§4 [${f.id}] complexityConfidence`);

    // Shim equivalence: classifyTone(book) === classifyToneFromEvidence(derive(book)).
    const ev = deriveBookEvidence(f.book);
    assertEq(classifyTone(f.book),       classifyToneFromEvidence(ev),       `§4 [${f.id}] classifyTone shim parity`);
    assertEq(classifyPace(f.book),       classifyPaceFromEvidence(ev),       `§4 [${f.id}] classifyPace shim parity`);
    assertEq(classifyComplexity(f.book), classifyComplexityFromEvidence(ev), `§4 [${f.id}] classifyComplexity shim parity`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 — IntentEligibilityVerdict byte-identity
// ─────────────────────────────────────────────────────────────────────────────
function makeLens(kind: 'noDark' | 'lessDark' | 'noClassics' | 'empty'): NextReadIntent {
  const intent = emptyIntent();
  if (kind === 'noDark')     intent.exclude.avoid_dark    = true;
  if (kind === 'lessDark')   intent.soft.intensity        = 'low';
  if (kind === 'noClassics') intent.exclude.avoid_classics = true;
  return intent;
}

function section5() {
  header('§5 IntentEligibilityVerdict byte-identity');
  for (const f of FIXTURES) {
    for (const lensKind of ['noDark', 'lessDark', 'noClassics', 'empty'] as const) {
      const intent  = makeLens(lensKind);
      const verdict = evaluateBookAgainstIntentLens(f.book, intent, f.marketPos);
      const reasons = verdict.hardExclusions.map(h => h.reason);
      assertEq(reasons, f.expectedHardReasons[lensKind], `§5 [${f.id} / ${lensKind}] hardExclusion reasons`);

      // Also exercise the thin wrapper.
      const single = getIntentExclusionReason(f.book, intent, f.marketPos);
      assertEq(single, reasons[0] ?? null, `§5 [${f.id} / ${lensKind}] getIntentExclusionReason matches verdict[0]`);

      // Status synthesis sanity: excluded ⇒ at least one hard reason.
      if (verdict.status === 'excluded') {
        assert(verdict.hardExclusions.length > 0, `§5 [${f.id} / ${lensKind}] status=excluded implies hardExclusions.length>0`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Fixture inclusion proof
// ─────────────────────────────────────────────────────────────────────────────
function section6() {
  header('§6 Fixture inclusion proof');
  const titles = new Set(FIXTURES.map(f => f.id));
  for (const must of ['gone_girl', 'thursday_murder_club', 'silent_patient', 'verity', 'everything_i_never_told_you']) {
    assert(titles.has(must), `§6 fixture set includes ${must}`);
  }
  assert(FIXTURES.some(f => f.book.subjects?.length === 0), '§6 includes empty-corpus fixture');
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 — Public surface stability (key shape check)
// ─────────────────────────────────────────────────────────────────────────────
function section7() {
  header('§7 Public surface stability');
  const verdict = evaluateBookAgainstIntentLens(
    { subjects: ['psychological thriller'], title: 't', description: 'd' },
    (() => { const i = emptyIntent(); i.exclude.avoid_dark = true; return i; })(),
    'domestic_suspense',
  );
  const keys = Object.keys(verdict).sort();
  assertEq(keys,
    ['confidence', 'evidence', 'hardExclusions', 'notRightNowRisks', 'softDemotions', 'status'],
    '§7 IntentEligibilityVerdict shape unchanged');

  // BookTraits shape unchanged.
  const traits = getBookTraits({ subjects: ['fiction'], title: 'x', description: '' });
  assertEq(Object.keys(traits).sort(),
    ['bookForm', 'complexity', 'complexityConfidence', 'genres', 'lengthClass', 'pace', 'paceConfidence', 'primaryGenre', 'seriesPosition', 'tone', 'toneConfidence', 'traits'],
    '§7 BookTraits shape unchanged');
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 — Composer / RecCard import surface unchanged
// ─────────────────────────────────────────────────────────────────────────────
function section8() {
  header('§8 Composer / RecCard untouched (file checks)');
  const composer = path.resolve(__dirname, '../lib/explanations/compose.ts');
  const recCard  = path.resolve(__dirname, '../components/RecCard.tsx');
  for (const p of [composer, recCard]) {
    if (!fs.existsSync(p)) { fail(`§8 expected file missing: ${p}`); continue; }
    const src = fs.readFileSync(p, 'utf8');
    assert(!src.includes("from '../evidence/bookEvidence'") && !src.includes("from '../lib/evidence/bookEvidence'"),
      `§8 ${path.basename(p)} does not import bookEvidence (no surface change)`);
    assert(!src.includes('deriveBookEvidence'),
      `§8 ${path.basename(p)} does not reference deriveBookEvidence`);
  }

  // signals.ts itself must still export the Batch A names (no accidental removal).
  const signalsSrc = fs.readFileSync(path.resolve(__dirname, '../lib/evidence/signals.ts'), 'utf8');
  for (const sym of ['DARK_SIGNALS', 'DOMESTIC_SUSPENSE_SUPPORT_SIGNALS', 'firstSignalMatch', 'hasAnySignal']) {
    const exported = new RegExp(`export\\s+(const|function|type)\\s+${sym}\\b`).test(signalsSrc);
    assert(exported, `§8 signals.ts still exports ${sym}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 — recValidity.VERSION pinned (rcv9 since rawTier fix 2026-06-22)
// ─────────────────────────────────────────────────────────────────────────────
function section9() {
  header('§9 recValidity stability');
  // VERSION is module-private — assert via computeRecConfigHash output prefix.
  const sentinel = {} as Parameters<typeof computeRecConfigHash>[0];
  const hash = (() => {
    try {
      return computeRecConfigHash(sentinel as any);
    } catch {
      // Some shapes throw; fall back to reading source.
      return null;
    }
  })();
  const src = fs.readFileSync(path.resolve(__dirname, '../lib/recValidity.ts'), 'utf8');
  assert(/const\s+VERSION\s*=\s*'rcv9'/.test(src), '§9 lib/recValidity.ts has VERSION = \'rcv9\'');
  void hash;
}

// ─────────────────────────────────────────────────────────────────────────────
function main() {
  section1();
  section2();
  section3();
  section4();
  section5();
  section6();
  section7();
  section8();
  section9();

  console.log(`\n  Result: ${_passed} passed, ${_failed} failed.`);
  if (_failed > 0) {
    console.error(`\n  ✗ validate_book_evidence FAILED — see above.\n`);
    process.exit(1);
  } else {
    console.log(`\n  ✓ validate_book_evidence PASS\n`);
  }
}
main();

// Suppress unused-import warning when DOMESTIC_SUSPENSE_SUPPORT_SIGNALS isn't
// referenced by section1 (we re-export-check only). Keep the import to assert
// the symbol still exists at the type level.
void DOMESTIC_SUSPENSE_SUPPORT_SIGNALS;
void DARK_SIGNALS;
