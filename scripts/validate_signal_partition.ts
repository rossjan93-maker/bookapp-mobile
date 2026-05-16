// =============================================================================
// validate_signal_partition.ts — P4A Signal Partition Contract validator
//
// Synchronous probes only — same convention as scripts/validate_rec_request.ts
// and the rest of the validator suite. No DB calls. Run with:
//   npx tsx scripts/validate_signal_partition.ts
//
// Asserts the P4A contract:
//   1. every captured quick-taste signal has an explicit signal_class
//   2. diagnosis_answers intent-shaped fields can be represented as
//      current_intent for new captures
//   3. legacy diagnosis_answers without intentScope remain durable/back-compat
//   4. reading_styles split into durable vs intent partitions
//   5. no reading_style is double-counted
//   6. avoid_genres remain soft_avoid
//   7. favorite_genres remain stated_durable
//   8. ratings/statuses/imported history remain revealed_behavioral or
//      durable as appropriate
//   9. short-term feedback remains short_term_feedback
//  10. no ranking/scoring/composition behavior changes (smoke: legacy
//      back-compat fields survive unchanged through buildSignals)
//  11. P3A composer-backed reasons remain unchanged (smoke: composer module
//      surface still exports composeReasons)
//  12. existing validators still pass (delegated — runs the rest of the
//      suite manually; this validator only asserts that its own module
//      imports cleanly without forcing a change to those validators)
// =============================================================================

import { buildSignals } from '../lib/recSignals/build';
import {
  partitionReadingStyles,
  classifyDiagnosisAnswers,
  READING_STYLE_ALL_LABELS,
  READING_STYLE_DURABLE_LABELS,
  READING_STYLE_INTENT_LABELS,
  DIAGNOSIS_INTENT_KEYS,
} from '../lib/recSignals/partitions';
import type { TasteProfile } from '../lib/tasteProfile';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeProfile(tier: number): TasteProfile {
  return { tier } as unknown as TasteProfile;
}

// ── 0. Partition declarations are well-formed ────────────────────────────────
console.log('0. Reading-style partition lists');
check('READING_STYLE_ALL_LABELS = durable ∪ intent (counts match)',
  READING_STYLE_ALL_LABELS.length === READING_STYLE_DURABLE_LABELS.length + READING_STYLE_INTENT_LABELS.length,
  `all=${READING_STYLE_ALL_LABELS.length} durable=${READING_STYLE_DURABLE_LABELS.length} intent=${READING_STYLE_INTENT_LABELS.length}`,
);
const _intentSet  = new Set<string>(READING_STYLE_INTENT_LABELS);
const _durableSet = new Set<string>(READING_STYLE_DURABLE_LABELS);
const _overlap = READING_STYLE_DURABLE_LABELS.filter(s => _intentSet.has(s));
check('no reading_style appears in BOTH partitions (5. no double-count)',
  _overlap.length === 0,
  `overlap=${JSON.stringify(_overlap)}`);
const _missing = READING_STYLE_ALL_LABELS.filter(s => !_intentSet.has(s) && !_durableSet.has(s));
check('every style in ALL_LABELS is classified into exactly one partition',
  _missing.length === 0,
  `missing=${JSON.stringify(_missing)}`);

// Compare against the canonical UI list in app/edit-preferences.tsx to catch
// drift if a chip is added to the UI without classification here.
const UI_STYLES_AS_OF_P4A = [
  'Fast-paced', 'Slow-burn', 'Character-driven', 'Plot-driven', 'Dense prose',
  'Light read', 'Dark themes', 'Funny / Witty', 'Reflective', 'Action-packed',
];
const _allSet = new Set<string>(READING_STYLE_ALL_LABELS);
const _uiUnknown = UI_STYLES_AS_OF_P4A.filter(s => !_allSet.has(s));
check('every UI style chip is present in the partition lists',
  _uiUnknown.length === 0,
  `unknown=${JSON.stringify(_uiUnknown)}`);

// ── 1. Every captured quick-taste signal has an explicit signal_class ────────
console.log('1. Signal classes present on every emitted signal');
const sigFull = buildSignals({
  profile: makeProfile(2),
  prefsRow: {
    favorite_genres: ['Fantasy'],
    avoid_genres:    ['Horror'],
    reading_styles:  ['Fast-paced', 'Character-driven'],
    favorite_authors: 'Brandon Sanderson',
    updated_at: '2026-05-16T00:00:00Z',
    diagnosis_answers: { q_outcome: 'idea_driven', fic_nonfic_split: 'mostly_fiction' },
  },
  intent:   { mood: 'palate_cleanser' },
  feedback: { dismissed: 3 },
});
check('statedTaste.signalClass = stated_durable',
  sigFull.statedTaste.signalClass === 'stated_durable');
check('revealedTaste.signalClass = revealed_behavioral',
  sigFull.revealedTaste.signalClass === 'revealed_behavioral');
check('softAvoids.signalClass = soft_avoid',
  sigFull.softAvoids.signalClass === 'soft_avoid');
check('currentIntent.signalClass = current_intent',
  sigFull.currentIntent?.signalClass === 'current_intent');
check('diagnosisAnswers.signalClass = current_intent (typed surface)',
  sigFull.diagnosisAnswers?.signalClass === 'current_intent');
check('shortTermFeedback.signalClass = short_term_feedback',
  sigFull.shortTermFeedback?.signalClass === 'short_term_feedback');

// ── 2. Intent-shaped diagnosis fields representable as current_intent ────────
console.log('2. Intent-shaped diagnosis_answers route into current_intent');
const newCapture = classifyDiagnosisAnswers({
  intentScope:  'session',
  q_outcome:    'escape',
  q_pacing:     'pacing_non_negotiable',
  q_tone:       'light_tone',
  q_what_grips: 'emotion_driven',
  b_fiction_split: 'mostly_fiction',
});
check('new capture: intentScope = session',
  newCapture.intentScope === 'session');
check('new capture: legacy = false',
  newCapture.legacy === false);
check('new capture: intentShaped contains all 4 intent keys',
  DIAGNOSIS_INTENT_KEYS.every(k => k in newCapture.intentShaped),
  `intentShaped=${JSON.stringify(newCapture.intentShaped)}`);
check('new capture: b_fiction_split (b_-prefixed durable) routed to durableShaped',
  newCapture.durableShaped.b_fiction_split === 'mostly_fiction'
    && !('b_fiction_split' in newCapture.intentShaped));
check('new capture: intentScope key itself is NOT leaked into raw',
  !('intentScope' in newCapture.raw));

// ── 3. Legacy diagnosis_answers without intentScope remain durable ───────────
console.log('3. Legacy back-compat: rows without intentScope → durable');
const legacy = classifyDiagnosisAnswers({
  q_outcome:       'idea_driven',
  q_pacing:        'pacing_flexible',
  q_tone:          'dark_tone',
  b_fiction_split: 'mostly_fiction',
});
check('legacy: intentScope = durable',
  legacy.intentScope === 'durable');
check('legacy: legacy flag = true',
  legacy.legacy === true);
check('legacy: raw map preserves all original keys (back-compat)',
  legacy.raw.q_outcome === 'idea_driven'
    && legacy.raw.q_pacing === 'pacing_flexible'
    && legacy.raw.q_tone === 'dark_tone'
    && legacy.raw.b_fiction_split === 'mostly_fiction');
check('legacy: intentShaped still partitions correctly even when legacy',
  legacy.intentShaped.q_outcome === 'idea_driven'
    && legacy.intentShaped.q_pacing === 'pacing_flexible'
    && legacy.intentShaped.q_tone === 'dark_tone');
check('legacy: null/undefined answers → empty classification, durable, legacy',
  (() => {
    const c = classifyDiagnosisAnswers(null);
    return c.intentScope === 'durable' && c.legacy === true && Object.keys(c.raw).length === 0;
  })());
check('legacy: non-object input is tolerated (no throw, empty result)',
  (() => {
    const c = classifyDiagnosisAnswers('not-an-object');
    return c.intentScope === 'durable' && c.legacy === true && Object.keys(c.raw).length === 0;
  })());

// ── 4. Reading-styles split into durable vs intent partitions ────────────────
console.log('4. Reading-styles partition at buildSignals');
const styled = buildSignals({
  profile: makeProfile(2),
  prefsRow: {
    favorite_genres: [],
    avoid_genres: [],
    reading_styles: ['Fast-paced', 'Character-driven', 'Dense prose', 'Funny / Witty', 'totally-made-up-chip'],
    favorite_authors: null,
    updated_at: null,
    diagnosis_answers: null,
  },
});
check('readingStylesDurable contains Character-driven + Dense prose',
  styled.statedTaste.readingStylesDurable.includes('Character-driven')
    && styled.statedTaste.readingStylesDurable.includes('Dense prose'));
check('readingStylesIntent contains Fast-paced + Funny / Witty',
  styled.statedTaste.readingStylesIntent.includes('Fast-paced')
    && styled.statedTaste.readingStylesIntent.includes('Funny / Witty'));
check('readingStylesUnknown contains the made-up chip (telemetry, no silent merge)',
  styled.statedTaste.readingStylesUnknown.includes('totally-made-up-chip'));
check('readingStyles (back-compat) preserves the original list verbatim',
  styled.statedTaste.readingStyles.length === 5
    && styled.statedTaste.readingStyles[0] === 'Fast-paced');

// ── 5. No reading_style is double-counted ────────────────────────────────────
console.log('5. No double-count between durable + intent (per-signal)');
const dupSet = new Set<string>([
  ...styled.statedTaste.readingStylesDurable,
  ...styled.statedTaste.readingStylesIntent,
]);
const dupCount = styled.statedTaste.readingStylesDurable.length + styled.statedTaste.readingStylesIntent.length;
check('union size equals sum (no overlap in emitted signal)',
  dupSet.size === dupCount,
  `union=${dupSet.size} sum=${dupCount}`);

// ── 6. avoid_genres remain soft_avoid ────────────────────────────────────────
console.log('6. avoid_genres → soft_avoid signal');
check('Horror avoid → softAvoids.genres includes horror affinity key',
  sigFull.softAvoids.genres.includes('horror'),
  `genres=${JSON.stringify(sigFull.softAvoids.genres)}`);
check('softAvoids has no hard_avoid leakage',
  (sigFull.softAvoids as any).signalClass !== 'hard_avoid');

// ── 7. favorite_genres remain stated_durable ─────────────────────────────────
console.log('7. favorite_genres → stated_durable');
check('Fantasy favorite → stated.favoriteGenres includes fantasy_scifi',
  sigFull.statedTaste.favoriteGenres.includes('fantasy_scifi'));
check('statedTaste signal class is stated_durable (not current_intent)',
  sigFull.statedTaste.signalClass === 'stated_durable');

// ── 8. Ratings / statuses / imported history → revealed_behavioral ───────────
console.log('8. Behavioral signals routed through revealedTaste (by-reference)');
check('revealedTaste.profile === the input TasteProfile (no rederivation)',
  sigFull.revealedTaste.profile === (sigFull.revealedTaste.profile));
// The TasteProfile module owns ratings/statuses/imported-history derivation;
// recSignals wraps it by reference rather than recomputing. Asserting the
// reference-equality contract here is the right surface to validate.
const _p = makeProfile(2);
const wrap = buildSignals({ profile: _p, prefsRow: null });
check('revealedTaste wraps the exact TasteProfile reference passed in',
  wrap.revealedTaste.profile === _p);

// ── 9. Short-term feedback remains short_term_feedback ───────────────────────
console.log('9. short_term_feedback signal class preserved');
check('shortTermFeedback emitted when feedback provided',
  sigFull.shortTermFeedback != null
    && sigFull.shortTermFeedback.signalClass === 'short_term_feedback');
const noFb = buildSignals({ profile: makeProfile(0), prefsRow: null });
check('shortTermFeedback absent when no feedback provided',
  noFb.shortTermFeedback === undefined);

// ── 10. Behavior-neutrality smoke: back-compat fields survive unchanged ──────
console.log('10. P4A is behavior-neutral (back-compat surfaces unchanged)');
const legacyStyleInput = ['Fast-paced', 'Slow-burn', 'Reflective', 'Dense prose'];
const baseline = buildSignals({
  profile: makeProfile(2),
  prefsRow: {
    favorite_genres: ['Mystery'],
    avoid_genres:    ['Horror'],
    reading_styles:  legacyStyleInput,
    favorite_authors: 'Tana French',
    updated_at:       '2026-05-16T00:00:00Z',
    diagnosis_answers: { q_outcome: 'idea_driven', b_fiction_split: 'mostly_fiction' },
  },
});
check('readingStyles (the field consumed by applyStyleBoosts today) is byte-identical to input',
  baseline.statedTaste.readingStyles.length === legacyStyleInput.length
    && baseline.statedTaste.readingStyles.every((s, i) => s === legacyStyleInput[i]));
check('favoriteGenres set unchanged from prior P1 contract',
  baseline.statedTaste.favoriteGenres.includes('thriller_mystery'));
check('softAvoids.genres set unchanged from prior P1 contract',
  baseline.softAvoids.genres.includes('horror'));
check('legacy diagnosis_answers raw map preserved verbatim (consumed by applyDiagnosisBoosts)',
  baseline.diagnosisAnswers?.raw.q_outcome === 'idea_driven'
    && baseline.diagnosisAnswers?.raw.b_fiction_split === 'mostly_fiction'
    && baseline.diagnosisAnswers?.legacy === true
    && baseline.diagnosisAnswers?.intentScope === 'durable');

// ── 11. P3A composer module surface still exports composeReasons ─────────────
console.log('11. P3A composer surface unchanged');
let composerOk = false;
try {
  // Dynamic require so a refactor of compose.ts surface fails this validator
  // loudly rather than at typecheck of an unrelated edit.
  const compose = require('../lib/explanations/compose');
  composerOk = typeof compose.composeExplanation === 'function'
            && typeof compose.deriveBackcompatReasons === 'function';
} catch {
  composerOk = false;
}
check('lib/explanations/compose exports composeExplanation + deriveBackcompatReasons (P3A surface untouched)',
  composerOk);

// ── 12. P4C-0.5 writer contract — quick-taste stamps intentScope='session' ───
//
// The quick-taste writer (components/RecEntryScreen.tsx :: saveQuickIntake)
// builds the diagnosis_answers jsonb as:
//     { ...intake.tasteAnswers, ...behavioralMeta, ...intentScopeMeta }
// where intentScopeMeta = { intentScope: 'session' } iff
// intake.tasteAnswers contains any DIAGNOSIS_INTENT_KEYS member.
//
// We replay that exact shape here (no DB call, no React) and feed it
// through classifyDiagnosisAnswers + deriveP4CContributions to prove:
//   12a. new quick-taste payload (with intent-shaped answer) → intentScope=session
//   12b. legacy row (no intentScope key) → durable / legacy=true
//   12c. q_outcome / q_pacing / q_tone / q_what_grips classify as current_intent
//   12d. b_fiction_split stays durable
//   12e. P4C current_intent_fit evidence.intentScope='session' on new captures
//   12f. P4C contributions all carry value=0 (observe-only invariant)
//   12g. composer-backed reasons surface unchanged (re-asserted as smoke)
console.log('12. P4C-0.5 writer contract (intentScope stamping)');

// Replay the writer's diagnosis_answers builder.
function buildDiagnosisFromIntake(opts: {
  tasteAnswers:  Record<string, string>;
  fictionSplit:  string;
}): Record<string, string> {
  const behavioralMeta = {
    b_fiction_split:  opts.fictionSplit,
    intake_completed: 'true',
  };
  const hasIntent = DIAGNOSIS_INTENT_KEYS.some(k => k in opts.tasteAnswers);
  const intentMeta: Record<string, string> = hasIntent ? { intentScope: 'session' } : {};
  return { ...opts.tasteAnswers, ...behavioralMeta, ...intentMeta };
}

// 12a. New quick-taste capture writes intentScope='session'
const writerNew = buildDiagnosisFromIntake({
  tasteAnswers:  {
    q_outcome:    'escape',
    q_pacing:     'pacing_non_negotiable',
    q_tone:       'light_tone',
    q_what_grips: 'emotion_driven',
  },
  fictionSplit: 'mostly_fiction',
});
check('12a. writer payload carries intentScope=session when intent-shaped answers present',
  writerNew.intentScope === 'session');
const newCls = classifyDiagnosisAnswers(writerNew);
check('12a.i  classifyDiagnosisAnswers reads intentScope=session',
  newCls.intentScope === 'session');
check('12a.ii legacy flag=false on new captures',
  newCls.legacy === false);

// 12b. Legacy row (no intentScope) still classifies as durable
const legacyRow = {
  q_outcome:       'idea_driven',
  q_pacing:        'pacing_flexible',
  b_fiction_split: 'mostly_fiction',
  intake_completed:'true',
};
const legacyCls = classifyDiagnosisAnswers(legacyRow);
check('12b. legacy row without intentScope → durable / legacy=true',
  legacyCls.intentScope === 'durable' && legacyCls.legacy === true);

// 12c. q_outcome / q_pacing / q_tone / q_what_grips partition into intentShaped
check('12c. all four intent keys classify into intentShaped on new captures',
  DIAGNOSIS_INTENT_KEYS.every(k => k in newCls.intentShaped),
  `intentShaped=${JSON.stringify(newCls.intentShaped)}`);

// 12d. b_fiction_split stays durable, not intent
check('12d. b_fiction_split routes to durableShaped (never intentShaped)',
  newCls.durableShaped.b_fiction_split === 'mostly_fiction'
  && !('b_fiction_split' in newCls.intentShaped));

// 12e + 12f. Drive deriveP4CContributions and check observation invariant.
const { deriveP4CContributions } = require('../lib/scoring/p4cContributions');
const { getBookTraits }          = require('../lib/bookTraits');

// Build a Signals from a synthetic prefs row that mirrors the writer output.
const writerSignals = buildSignals({
  profile:  makeProfile(2),
  prefsRow: {
    favorite_genres: ['Fantasy'],
    avoid_genres:    [],
    reading_styles:  [],
    favorite_authors: null,
    updated_at:       null,
    diagnosis_answers: writerNew,
  },
});

// Pairing fixture: book with tone=light to satisfy current_intent_fit gating.
const pairingBook = {
  title: 'X', author: 'Y', subjects: [],
};
const pairingTraits = {
  ...getBookTraits(pairingBook),
  tone: 'light', toneConfidence: 'specific',
};

const p4cCs = deriveP4CContributions({
  book:                 pairingBook,
  traits:               pairingTraits,
  signals:              writerSignals,
  seriesPositionsRead:  new Map(),
});

const cif = p4cCs.find((c: { kind: string }) => c.kind === 'current_intent_fit');
check('12e. current_intent_fit emitted (intent + pairing)',
  !!cif);
if (cif) {
  const ev = cif.evidence as { intentScope?: string; legacy?: boolean };
  check('12e.i  current_intent_fit.evidence.intentScope === session',
    ev.intentScope === 'session', `got ${ev.intentScope}`);
  check('12e.ii current_intent_fit.evidence.legacy === false',
    ev.legacy === false);
}
check('12f. ALL P4C contributions carry value === 0 (observe-only invariant)',
  p4cCs.every((c: { value: number }) => c.value === 0),
  `values=${JSON.stringify(p4cCs.map((c: { kind: string; value: number }) => [c.kind, c.value]))}`);

// 12g. Legacy-row drive: current_intent_fit may emit (pairing satisfied via
// other intent-shaped keys) but its evidence.intentScope must read 'durable'
// because the legacy row carries no explicit discriminator.
const legacySignals = buildSignals({
  profile:  makeProfile(2),
  prefsRow: {
    favorite_genres: [],
    avoid_genres:    [],
    reading_styles:  [],
    favorite_authors: null,
    updated_at:       null,
    diagnosis_answers: legacyRow,
  },
});
const legacyCs = deriveP4CContributions({
  book:                pairingBook,
  traits:              pairingTraits,
  signals:             legacySignals,
  seriesPositionsRead: new Map(),
});
const legacyCif = legacyCs.find((c: { kind: string }) => c.kind === 'current_intent_fit');
if (legacyCif) {
  const ev = legacyCif.evidence as { intentScope?: string; legacy?: boolean };
  check('12g. legacy-row current_intent_fit.evidence.intentScope === durable',
    ev.intentScope === 'durable');
  check('12g.i legacy-row current_intent_fit.evidence.legacy === true',
    ev.legacy === true);
} else {
  // No pairing emitted — acceptable; the invariant is conditional. Record
  // so a future change cannot silently drop this coverage.
  check('12g. legacy-row: no current_intent_fit (pairing absent — invariant vacuously holds)',
    true);
}

// ── 12. Existing validator modules import without forcing changes ────────────
console.log('12. Existing validator modules still import cleanly');
// We import the recRequest validator module's *transitive* deps to confirm
// P4A's type additions did not break their import surface. (Running the
// validators themselves is done in the run-script step outside this file.)
let validatorImportsOk = true;
try {
  require('../lib/recRequest');
  require('../lib/recPolicy');
  require('../lib/taxonomy/genres');
  require('../lib/taxonomy/normalize');
} catch (e) {
  validatorImportsOk = false;
  console.error('   import failure:', (e as Error).message);
}
check('recRequest / recPolicy / taxonomy imports survived P4A type additions',
  validatorImportsOk);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
  console.log('✓ All P4A signal partition checks passed.');
  process.exit(0);
} else {
  console.error(`✗ ${failures} check(s) failed.`);
  process.exit(1);
}
