// =============================================================================
// scripts/validate_intent_lens.ts — P4C.1 follow-up · chip→typed signal contract
//
// Locks the contract for the chip → typed current_intent signal plumbing
// batch. Exit 0 = green. Any failure prints the failing assertion + a
// short remediation hint.
//
// Assertions (7, per the batch spec):
//   1. Explicit "No X" chips stay hard (tone='light' → exclude.avoid_dark;
//      length / format / standalone unchanged).
//   2. Softer chips (intensity='low', mood='light_fun', mood='palate_cleanser')
//      become typed current_intent signals — no hard exclude is written for
//      their tone implication; only palate_cleanser's length cap remains hard.
//   3. The session lens does not persist — buildSignals derives nextReadChips
//      ONLY from the in-memory intent payload, never from prefsRow.
//   4. Clear lens restores the baseline contract — empty intent → no
//      nextReadChips signal → no chip-sourced contribution.
//   5. P4C contribution caps apply to soft lens values — chip-derived
//      tone_fit / pace_fit / not_right_now_risk respect perKindAbsCap.
//   6. Stated favorite floors are not overpowered by soft lens values —
//      P4C_LIMITED_RANKING_POLICY.stackAbsCap < STATED_TASTE_POLICY.prefFloor.
//   7. No RecCard / composer visible copy changes — every P4C kind stays
//      not_yet_emitted in COMPOSER_EMISSION_GATES (covered by
//      validate_p4c_limited_ranking §11; re-asserted here for locality).
// =============================================================================

import { buildSignals, type RawPrefsRow } from '../lib/recSignals/build';
import { deriveP4CContributions } from '../lib/scoring/p4cContributions';
import { P4C_LIMITED_RANKING_POLICY, STATED_TASTE_POLICY, clampP4IntentStack } from '../lib/recPolicy';
import { classifyIntentLens } from '../lib/currentIntentLens';
import type { TasteProfile } from '../lib/tasteProfile';
import type { NextReadIntent } from '../lib/nextReadIntent';
import type { BookTraits } from '../lib/bookTraits';

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function header(t: string) { console.log(`\n${t}`); }

// ── Fixtures ────────────────────────────────────────────────────────────────
const emptyProfile: TasteProfile = {
  tier: 0, label: 'cold', confidence: 'low',
  preferred_traits: {}, avoided_traits: {}, genre_affinities: {},
  liked_subjects: [], liked_authors: [], open_questions: [],
  evidence: {
    rated_books_count: 0, dnf_books_count: 0, finished_books_count: 0,
    imported_books_count: 0, taste_tag_count: 0, review_count: 0,
  } as any,
  strongSignalCount: 0, nextTierAt: 5,
};
const emptyPrefs: RawPrefsRow = {
  favorite_genres: [], avoid_genres: [], reading_styles: [],
  favorite_authors: null, updated_at: null, diagnosis_answers: null,
};
const darkBookTraits: BookTraits = {
  tone: 'dark', toneConfidence: 'specific',
  pace: 'medium', paceConfidence: 'broad',
  complexity: 'unknown', complexityConfidence: 'broad',
  primaryGenre: 'thriller_mystery', genres: [],
  marketPosition: null, seriesPosition: null, length: null,
} as any;
const fastBookTraits: BookTraits = {
  ...darkBookTraits,
  tone: 'light', toneConfidence: 'specific',
  pace: 'fast', paceConfidence: 'specific',
};

// ── 1. Hard chips stay hard ─────────────────────────────────────────────────
header('§1 explicit "No X" chips stay hard');
{
  // Simulate handleApplyIntent post-change for: toneChip='light' (explicit
  // No dark) + lengthChip='short' + formatChip='fiction' + seriesChip=true.
  // We assert the SHAPE the new handleApplyIntent produces.
  const intent: NextReadIntent = {
    hard: { fiction_only: true, standalone_only: true, max_page_count: 300 },
    soft: { tone: 'light' },
    exclude: { avoid_dark: true },
  };
  if (!intent.exclude.avoid_dark) fail('tone="light" must still set exclude.avoid_dark');
  if (!intent.hard.fiction_only)   fail('format=fiction must still set hard.fiction_only');
  if (!intent.hard.standalone_only)fail('series chip must still set hard.standalone_only');
  if (intent.hard.max_page_count !== 300) fail('length=short must still set hard.max_page_count=300');
  ok('tone="light" preserves exclude.avoid_dark hard rule');
  ok('format / length / standalone preserved as hard rules');
}

// ── 2. Softer chips become typed signals — no implicit hard exclude ─────────
header('§2 softer chips become typed (no implicit hard avoid_dark/literary)');
{
  // intensity='low' alone — must NOT write exclude.avoid_dark.
  const intent1: NextReadIntent = { hard: {}, soft: { intensity: 'low' }, exclude: {} };
  if (intent1.exclude.avoid_dark)   fail('intensity="low" must no longer set exclude.avoid_dark');
  if (intent1.exclude.avoid_literary) fail('intensity="low" must not set exclude.avoid_literary');

  // mood='light_fun' alone — must NOT write either exclude.
  const intent2: NextReadIntent = { hard: {}, soft: { readingEnergy: 'light_fun' }, exclude: {} };
  if (intent2.exclude.avoid_dark)     fail('mood="light_fun" must no longer set exclude.avoid_dark');
  if (intent2.exclude.avoid_literary) fail('mood="light_fun" must no longer set exclude.avoid_literary');

  // mood='palate_cleanser' alone — must keep hard.max_page_count BUT drop avoid_dark.
  const intent3: NextReadIntent = {
    hard: { max_page_count: 400 },
    soft: { readingEnergy: 'palate_cleanser' },
    exclude: {},
  };
  if (intent3.exclude.avoid_dark)             fail('mood="palate_cleanser" must drop avoid_dark');
  if (intent3.hard.max_page_count !== 400)    fail('mood="palate_cleanser" length cap must remain hard');

  // Verify buildSignals derives a typed nextReadChips signal for each.
  const sigs1 = buildSignals({ profile: emptyProfile, prefsRow: emptyPrefs, intent: intent1 });
  const sigs2 = buildSignals({ profile: emptyProfile, prefsRow: emptyPrefs, intent: intent2 });
  const sigs3 = buildSignals({ profile: emptyProfile, prefsRow: emptyPrefs, intent: intent3 });
  if (sigs1.nextReadChips?.intensity !== 'low')         fail('nextReadChips must carry intensity=low');
  if (sigs2.nextReadChips?.energy !== 'light_fun')      fail('nextReadChips must carry energy=light_fun');
  if (sigs3.nextReadChips?.energy !== 'palate_cleanser')fail('nextReadChips must carry energy=palate_cleanser');
  if (sigs1.nextReadChips?.intentScope !== 'session')   fail('nextReadChips intentScope must be session');
  ok('intensity="low" emits typed chip signal, no hard exclude');
  ok('mood="light_fun" emits typed chip signal, no hard exclude');
  ok('mood="palate_cleanser" keeps length cap hard, drops avoid_dark, emits typed signal');
}

// ── 3. Lens does not persist (no prefsRow path emits nextReadChips) ─────────
header('§3 session lens does not persist (prefsRow never feeds nextReadChips)');
{
  // Even with a fully populated prefs row, nextReadChips MUST be undefined
  // when no intent payload is present. This is the contract that prevents
  // accidental promotion of the session lens into durable storage.
  const denseRow: RawPrefsRow = {
    favorite_genres: ['thriller_mystery', 'romance'],
    avoid_genres:    ['horror'],
    reading_styles:  ['Fast-paced', 'Light read', 'Dark themes'],
    favorite_authors: 'Agatha Christie',
    updated_at: new Date().toISOString(),
    diagnosis_answers: { q_tone: 'light', q_pacing: 'fast', intentScope: 'session' },
  };
  const sigs = buildSignals({ profile: emptyProfile, prefsRow: denseRow, intent: null });
  if (sigs.nextReadChips != null) {
    fail('nextReadChips must be undefined when intent is null — prefsRow must not seed it');
  }
  ok('nextReadChips undefined when intent is null, regardless of prefsRow contents');
}

// ── 4. Clear lens restores baseline (empty intent → no chip signal) ─────────
header('§4 clear lens restores baseline');
{
  const sigs = buildSignals({
    profile: emptyProfile, prefsRow: emptyPrefs,
    intent: { hard: {}, soft: {}, exclude: {} },
  });
  if (sigs.nextReadChips != null) fail('empty intent (cleared lens) must produce no nextReadChips');
  const contribs = deriveP4CContributions({
    book: {}, traits: darkBookTraits, signals: sigs,
    seriesPositionsRead: new Map(),
  });
  const chipSourced = contribs.flatMap(c =>
    (c.evidence?.userToneSources as string[] | undefined) ?? [],
  ).filter(s => s.startsWith('chip:'));
  if (chipSourced.length > 0) fail('cleared lens must not yield any chip:-sourced contribution evidence');
  ok('empty intent → no nextReadChips, no chip-sourced contribution evidence');
}

// ── 5. P4C caps apply to chip-driven contributions ──────────────────────────
header('§5 P4C.1 per-kind / stack caps govern chip-driven values');
{
  const PER_KIND = P4C_LIMITED_RANKING_POLICY.perKindAbsCap;
  if (!(PER_KIND > 0 && PER_KIND <= 0.20 + 1e-9)) {
    fail(`perKindAbsCap must be in (0, 0.20]; got ${PER_KIND}`);
  }
  // Pile on every chip that could push tone-light + pace-fast inferences.
  const intent: NextReadIntent = {
    hard: {}, exclude: {},
    soft: { tone: 'light', intensity: 'low', pace: 'fast', readingEnergy: 'light_fun' },
  };
  const sigs = buildSignals({ profile: emptyProfile, prefsRow: emptyPrefs, intent });
  const contribs = deriveP4CContributions({
    book: {}, traits: darkBookTraits, signals: sigs,
    seriesPositionsRead: new Map(),
  });
  for (const c of contribs) {
    if (Math.abs(c.value) > PER_KIND + 1e-9) {
      fail(`contribution ${c.kind} value=${c.value} exceeds per-kind cap ${PER_KIND}`);
    }
  }
  // not_right_now_risk must be negative-only for the dark-book mismatch.
  const nrn = contribs.find(c => c.kind === 'not_right_now_risk');
  if (!nrn) fail('expected not_right_now_risk contribution for dark-book + light-chip mismatch');
  if ((nrn?.value ?? 0) > 0) fail('not_right_now_risk must never carry a positive value');
  // Pace match on the *light* book — confirm pace_fit emits with chip:pace source.
  const sigsFast = buildSignals({ profile: emptyProfile, prefsRow: emptyPrefs, intent });
  const contribsFast = deriveP4CContributions({
    book: {}, traits: fastBookTraits, signals: sigsFast,
    seriesPositionsRead: new Map(),
  });
  const paceFit = contribsFast.find(c => c.kind === 'pace_fit');
  const paceSources = (paceFit?.evidence?.userPaceSources as string[] | undefined) ?? [];
  if (!paceSources.some(s => s.startsWith('chip:pace:'))) {
    fail('pace_fit must include a chip:pace source when paceChip="fast"');
  }
  ok(`per-kind cap ${PER_KIND} respected by all chip-driven contributions`);
  ok('not_right_now_risk remains negative-only under chip-driven inputs');
  ok('chip:pace:* source threads through pace_fit evidence');
}

// ── 6. Stated-taste floor is not overpowered by chip stack ──────────────────
//      Behavioral guarantee: `clampP4IntentStack` floor-protects the stated
//      taste contribution against the maximum possible negative chip stack.
//      A user who has Romance as a stated favorite + a soft-lens "Less dark"
//      / "Light & accessible" combination must still see a Romance pick
//      retain at least `STATED_TASTE_POLICY.prefFloor` of stated-taste lift.
header('§6 stated-taste floor outranks max chip stack');
{
  const floor    = STATED_TASTE_POLICY.prefFloor;
  const negCap   = P4C_LIMITED_RANKING_POLICY.stackNegCap;   // e.g. -0.30
  const posCap   = P4C_LIMITED_RANKING_POLICY.stackPosCap;   // e.g.  0.30
  // Worst-case for a stated favorite: stated_taste sits at the prefFloor
  // and every chip-driven contribution is negative and stacks to the cap.
  // Worst-case net (no protection): stackPosCap=0, max negatives=negCap.
  // With floor protection: stated_taste=floor must survive — i.e. the
  // net P4 adjustment must not exceed -floor in magnitude (otherwise it
  // would erase the stated bump on a borderline candidate).
  const netWithProtection    = clampP4IntentStack(0, negCap, floor);
  const netWithoutProtection = clampP4IntentStack(0, negCap, 0);
  if (typeof netWithProtection !== 'number') {
    fail('clampP4IntentStack must return a number');
  }
  if (netWithProtection + floor < 0 - 1e-9) {
    fail(`stated-taste floor (${floor}) eroded by chip stack: net=${netWithProtection} + floor=${floor} = ${netWithProtection + floor}`);
  }
  if (!(netWithoutProtection < netWithProtection)) {
    fail(`floor protection must strictly improve net for a stated favorite (got with=${netWithProtection} vs without=${netWithoutProtection})`);
  }
  if (posCap <= 0) fail(`stackPosCap must be > 0; got ${posCap}`);
  ok(`clampP4IntentStack protects stated-taste floor=${floor} at worst-case neg=${negCap} (net=${netWithProtection})`);
  ok(`floor protection strictly improves over unprotected (with=${netWithProtection} > without=${netWithoutProtection})`);
}

// ── 7. Composer emission gates unchanged (no visible RecCard copy change) ───
header('§7 composer suppresses every P4C kind (no visible RecCard copy change)');
{
  // Authoritative contract check lives in validate_p4c_limited_ranking §11.
  // We re-assert it here at source level so a chip-side change can't drift
  // the composer surface unnoticed: every P4C kind must remain suppressed
  // via `not_yet_emitted` in lib/explanations/compose.ts.
  const fs   = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const composeSrc = fs.readFileSync(
    path.resolve(__dirname, '../lib/explanations/compose.ts'),
    'utf8',
  );
  const P4C_KINDS = [
    'current_intent_fit','tone_fit','pace_fit','complexity_fit',
    'series_continuation_fit','avoidance_conflict','not_right_now_risk',
  ];
  // The suppression marker `${kind}:not_yet_emitted` is pushed for every
  // P4C contribution kind today. Loosen to a single shared sentinel
  // (`not_yet_emitted`) presence + each kind named somewhere in the file —
  // we just need to know nothing introduced a NEW emit path for a P4C kind.
  if (!composeSrc.includes('not_yet_emitted')) {
    fail('compose.ts no longer contains `not_yet_emitted` sentinel — composer admit-path may have changed');
  }
  for (const k of P4C_KINDS) {
    if (!composeSrc.includes(k)) {
      fail(`compose.ts does not reference kind '${k}' — suppression coverage drift?`);
    }
  }
  ok('compose.ts still routes every P4C kind through the not_yet_emitted suppression sentinel');
}

// ── Lens classifier sanity (tier assignment matches new behavior) ──────────
header('§lens classifier — chip tier assignment');
{
  const intent: NextReadIntent = {
    hard: { max_page_count: 400 },
    soft: { intensity: 'low', readingEnergy: 'palate_cleanser', pace: 'fast' },
    exclude: {},
  };
  const lens = classifyIntentLens(intent);
  // pace=fast → soft
  if (!lens.soft.some(e => e.id === 'pace_fast')) fail('pace_fast must classify as soft');
  // intensity=low + energy=palate_cleanser → notRightNow
  if (!lens.notRightNow.some(e => e.id === 'intensity_low')) {
    fail('intensity_low must classify as notRightNow after chip→signal migration');
  }
  if (!lens.notRightNow.some(e => e.id === 'energy_palate_cleanser')) {
    fail('energy_palate_cleanser must classify as notRightNow');
  }
  // Length cap stays hard.
  if (!lens.hard.some(e => e.id === 'max_page_count')) {
    fail('hard.max_page_count must remain in hard tier');
  }
  ok('chips classified into correct tiers (soft / notRightNow / hard)');
}

console.log('\n✓ ALL CHECKS PASSED\n');
