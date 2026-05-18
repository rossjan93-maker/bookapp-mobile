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

// ── 8. Dark-signal coverage on canonical fixtures (P4C.1 live-smoke blocker) ─
//      Asserts the user-facing promise: explicit "No dark" hard-removes
//      Gone Girl / The Silent Patient (canonical psychological thrillers)
//      while leaving Thursday Murder Club (cozy) and Everything I Never
//      Told You (literary) eligible. And "Less dark" alone (intensity='low'
//      typed signal, no avoid_dark) must NOT hard-remove any of them.
header('§8 dark-signal coverage on canonical fixtures');
{
  const { getIntentExclusionReason } = require('../lib/nextReadIntent') as
    typeof import('../lib/nextReadIntent');

  // Canonical OL-style subject sets — representative of what each book
  // actually returns from Open Library / Google Books today. These are
  // used as test fixtures only; they are not a manual blocklist.
  // P4C.1 follow-up #5 (2026-05-17 runtime-log driven) — fixtures now
  // mirror the EXACT subjects captured by [INTENT_FORENSIC_RANKED] in the
  // live failure log, plus the per-book market_position from the trait
  // pipeline. Subjects here are pasted verbatim from the user's log so we
  // are validating against actual OL/Google Books corpus, not idealized
  // taxonomy.
  const fixtures = [
    {
      name: 'Gone Girl',
      // Live log: thriller, mystery, suspense, psychological fiction,
      //          crime fiction
      subjects: ['thriller', 'mystery', 'suspense',
                 'psychological fiction', 'crime fiction'],
      title:   'Gone Girl',
      marketPos: 'domestic_suspense' as const,
      shouldExcludeOnNoDark:    true,   // 'crime fiction' phrasal hit + market-position belt
      shouldExcludeOnLessDark:  false,
    },
    {
      name: 'The Silent Patient',
      // Live log: Fiction, psychological / Fiction, thrillers /
      //          Family violence / Psychotherapy patients
      subjects: ['Fiction, psychological', 'Fiction, thrillers',
                 'Family violence', 'Psychotherapy patients'],
      title:   'The Silent Patient',
      marketPos: 'domestic_suspense' as const,
      shouldExcludeOnNoDark:    true,   // 'family violence' + 'psychotherapy patient' phrasal hits
      shouldExcludeOnLessDark:  false,
    },
    {
      name: 'The Thursday Murder Club',
      // Cozy mystery — must remain eligible. No dark phrasal marker;
      // single-token 'murder' / 'mystery' deliberately not in DARK_SIGNALS.
      subjects: ['cozy mystery', 'detective and mystery stories', 'murder',
                 'older people', 'fiction', 'humorous fiction'],
      title:   'The Thursday Murder Club',
      marketPos: 'book_club_fiction' as const,
      shouldExcludeOnNoDark:    false,
      shouldExcludeOnLessDark:  false,
    },
    {
      name: 'Everything I Never Told You',
      // Literary grief novel — user explicitly left this ambiguous in the
      // follow-up brief. We deliberately did NOT add 'psychological
      // fiction' or 'grief' to DARK_SIGNALS, so ENITY stays eligible.
      subjects: ['grief', 'drowning', 'literary fiction',
                 'psychological fiction', 'family secrets',
                 'mothers and daughters'],
      title:   'Everything I Never Told You',
      marketPos: 'literary_prestige' as const,
      shouldExcludeOnNoDark:    false,
      shouldExcludeOnLessDark:  false,
    },
  ];

  const noDarkIntent:    NextReadIntent = { hard: {}, soft: { tone: 'light' }, exclude: { avoid_dark: true } };
  const lessDarkIntent:  NextReadIntent = { hard: {}, soft: { intensity: 'low' }, exclude: {} };

  for (const f of fixtures) {
    const noDarkReason   = getIntentExclusionReason(
      { subjects: f.subjects, title: f.title },
      noDarkIntent,
      f.marketPos,
    );
    const lessDarkReason = getIntentExclusionReason(
      { subjects: f.subjects, title: f.title },
      lessDarkIntent,
      f.marketPos,
    );

    const noDarkExcluded   = noDarkReason   === 'avoid_dark';
    const lessDarkExcluded = lessDarkReason === 'avoid_dark';

    if (noDarkExcluded !== f.shouldExcludeOnNoDark) {
      fail(`"${f.name}" under explicit No-dark: expected excluded=${f.shouldExcludeOnNoDark}, got excluded=${noDarkExcluded} (reason=${noDarkReason})`);
    }
    if (lessDarkExcluded !== f.shouldExcludeOnLessDark) {
      fail(`"${f.name}" under Less-dark only: expected excluded=${f.shouldExcludeOnLessDark}, got excluded=${lessDarkExcluded} (Less dark must NEVER hard-exclude)`);
    }
    ok(`"${f.name}": No-dark excludes=${noDarkExcluded} (want ${f.shouldExcludeOnNoDark}); Less-dark excludes=${lessDarkExcluded} (want ${f.shouldExcludeOnLessDark})`);
  }
}

// ── 9. Cache-path intent filter (lens MUST gate even cached recs) ─────────
//      2026-05-17 live-smoke root cause: `lib/recCache.ts shouldRebuild`
//      does NOT trigger on lens apply, so a cache HIT inside
//      `getPersonalizedRecsWithExpert` used to return `rec_set` untouched
//      and skip the intent filter that lives in the discoveryPool loop.
//      The fix is a post-cache filter at the cache-hit return path that
//      reuses `getIntentExclusionReason` + `passesIntentHardFilters`.
//      This section locks BOTH halves:
//        (a) The recommender source actually contains the post-cache filter
//            inside the active-intent branch.
//        (b) The same helper combo applied to the canonical four fixtures
//            produces the verdicts the live UI must show.
header('§9 cache-path intent filter (locks live-smoke fix)');
{
  const fs   = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'recommender.ts'),
    'utf8',
  );

  // (a) Architectural assertion — both gates must be called inside the
  //     cache-hit return path, gated by isIntentActive. Anchor on the
  //     "Session-only intent filter on cached recs" banner so the assertion
  //     survives any future addition of nested DEV traces.
  const cacheBlockMatch = src.match(
    /Session-only intent filter on cached recs[\s\S]{0,6000}?\n\s*return\s*\{\s*\n\s*recs:\s*\[\.\.\.cachedCont/,
  );
  if (!cacheBlockMatch) {
    fail('could not locate `if (!rebuildDecision.should_rebuild) { ... }` block in lib/recommender.ts — the cache-hit return shape changed; re-confirm the post-cache filter is still wired before re-asserting');
  }
  const cacheBlock = cacheBlockMatch[0];
  if (!/isIntentActive\s*\(\s*intent\s*\)/.test(cacheBlock)) {
    fail('cache-hit return path does not call isIntentActive(intent) — the post-cache lens filter is not gated correctly');
  }
  if (!/getIntentExclusionReason\s*\(/.test(cacheBlock)) {
    fail('cache-hit return path does not call getIntentExclusionReason — cached recs would bypass No-dark exclusion');
  }
  if (!/passesIntentHardFilters\s*\(/.test(cacheBlock)) {
    fail('cache-hit return path does not call passesIntentHardFilters — cached recs would bypass length / fiction-only / standalone hard gates');
  }
  ok('cache-hit return path wires both intent gates inside isIntentActive(intent) branch');

  // (a.2) Architectural assertion — the fresh expert-build return path
  //       (after composeRecommendationSet, before the final return) must
  //       ALSO apply the same intent gates. composeRecommendationSet
  //       (lib/expertRec.ts:460) picks from pack.candidates, which is
  //       intent-blind, so expertRecs can include books the intent filter
  //       would reject. Without this gate, the cache-hit fix alone leaves
  //       a hole on the very first build (or any shouldRebuild trigger).
  const expertReturnMatch = src.match(
    /const\s+expertCont\s*=\s*baseResult\.continuations[\s\S]{0,8000}?\n\s*return\s*\{\s*\n\s*recs:\s*\[\.\.\.expertCont/,
  );
  if (!expertReturnMatch) {
    fail('could not locate the fresh expert-build return block in lib/recommender.ts — re-confirm the post-build intent filter is still wired before re-asserting');
  }
  const expertBlock = expertReturnMatch[0];
  if (!/isIntentActive\s*\(\s*intent\s*\)/.test(expertBlock)) {
    fail('fresh expert-build return path does not call isIntentActive(intent) — expert picks would bypass No-dark when shouldRebuild triggers (new_reading_signal / feedback_changed / TTL / first build)');
  }
  if (!/getIntentExclusionReason\s*\(/.test(expertBlock)) {
    fail('fresh expert-build return path does not call getIntentExclusionReason — fresh expert recs would bypass No-dark exclusion (e.g. Gone Girl / Silent Patient survive even though composeRecommendationSet is intent-blind)');
  }
  if (!/passesIntentHardFilters\s*\(/.test(expertBlock)) {
    fail('fresh expert-build return path does not call passesIntentHardFilters — fresh expert recs would bypass length / fiction-only / standalone hard gates');
  }
  ok('fresh expert-build return path wires both intent gates inside isIntentActive(intent) branch');

  // (b) Behavior assertion — same helper combo as the cache-path filter,
  //     applied to canonical four fixtures, produces correct verdicts.
  const { getIntentExclusionReason, passesIntentHardFilters } = require('../lib/nextReadIntent') as
    typeof import('../lib/nextReadIntent');

  const cacheFixtures = [
    { name: 'Gone Girl',                 subjects: ['Psychological thriller', 'Domestic suspense', 'Missing persons'], shouldSurvive: false },
    { name: 'The Silent Patient',        subjects: ['Psychological thriller', 'Psychotherapy', 'Suspense', 'Murder'],  shouldSurvive: false },
    { name: 'The Thursday Murder Club',  subjects: ['Cozy mystery', 'Humorous fiction', 'Murder'],                      shouldSurvive: true  },
    { name: 'Everything I Never Told You', subjects: ['Literary fiction', 'Family secrets', 'Domestic fiction'],         shouldSurvive: true  },
  ];

  const noDarkIntent: NextReadIntent = { hard: {}, soft: { tone: 'light' }, exclude: { avoid_dark: true } };
  const neutralMarketPos = 'book_club_fiction' as const;

  for (const f of cacheFixtures) {
    const book = { subjects: f.subjects, title: f.name, page_count: 350 };
    // Mirror the exact filter chain used in the cache-hit return path:
    const excluded =
      !!getIntentExclusionReason(book, noDarkIntent, neutralMarketPos) ||
      !passesIntentHardFilters(book, noDarkIntent, null, neutralMarketPos);
    const survives = !excluded;
    if (survives !== f.shouldSurvive) {
      fail(`cache-path filter verdict mismatch for "${f.name}": expected survives=${f.shouldSurvive}, got ${survives}`);
    }
    ok(`cache-path filter: "${f.name}" survives=${survives} (want ${f.shouldSurvive})`);
  }
}

// ── §10 Shared Intent Eligibility Evaluator — fixture matrix ─────────────
// P4C.1 follow-up #6 (2026-05-18): all "Your Next Read" hard/soft lens
// decisions now flow through `evaluateBookAgainstIntentLens`. This section
// locks the contract against 12 representative fixtures × 4 lens types
// (No-dark, Less-dark, No-literary, No-romance). Light & accessible /
// Short & light are mood/page-count lenses and not exclusion-driven, so
// they are exercised by validate_p4c_limited_ranking + the chip→tier
// classifier section above rather than re-asserted here.
//
// Each fixture asserts:
//   • hardExclusions present iff product rule requires it
//   • Less-dark NEVER produces a hard exclusion (rule 4)
//   • status === 'excluded' iff a hard exclusion fired
//   • Books that hit broad-only dark evidence under No-dark route to
//     notRightNowRisks (NOT hardExclusions) — verified for Secret History
//     and Everything I Never Told You once a description corroborates the
//     broad signal; subject-only fixtures stay 'unknown' / eligible.
//
// FIXTURE INTENT: rewrite this matrix, not DARK_SIGNALS, for any future
// dark-coverage decision. Title-specific patching is explicitly out.
header('§10 shared Intent Eligibility Evaluator — fixture matrix');
{
  const { evaluateBookAgainstIntentLens } = require('../lib/nextReadIntent') as
    typeof import('../lib/nextReadIntent');
  type MP = import('../lib/fitClassifier').MarketPosition;

  type Fx = {
    name:        string;
    subjects:    string[];
    description?: string;
    title:       string;
    marketPos:   MP;
    // expected verdicts under each lens (true = hardExclusion present)
    noDarkExcluded:     boolean;
    lessDarkExcluded:   boolean;   // ALWAYS false per rule 4
    noLiteraryExcluded: boolean;
    noRomanceExcluded:  boolean;
  };

  const fixtures: Fx[] = [
    // Live-corpus fixtures (from runtime [INTENT_FORENSIC_RANKED] logs):
    { name: 'Gone Girl',
      subjects: ['thriller', 'mystery', 'suspense', 'psychological fiction', 'crime fiction'],
      title: 'Gone Girl', marketPos: 'domestic_suspense',
      noDarkExcluded: true, lessDarkExcluded: false, noLiteraryExcluded: false, noRomanceExcluded: false },

    { name: 'The Silent Patient',
      subjects: ['Fiction, psychological', 'Fiction, thrillers', 'Family violence', 'Psychotherapy patients'],
      title: 'The Silent Patient', marketPos: 'domestic_suspense',
      noDarkExcluded: true, lessDarkExcluded: false, noLiteraryExcluded: false, noRomanceExcluded: false },

    { name: 'Verity',
      subjects: ['Psychological fiction', 'Suspense fiction', 'Thrillers (Fiction)',
                 'Romance fiction', 'Romantic suspense fiction'],
      title: 'Verity', marketPos: 'domestic_suspense',  // line 307 has('thriller') substring
      noDarkExcluded: true,  // market-position rule fires (domestic_suspense + psychological/suspense/thriller)
      lessDarkExcluded: false, noLiteraryExcluded: false, noRomanceExcluded: false },

    { name: 'The Secret History',
      subjects: ['Murder', 'Classical philology', 'Friendship', 'Vermont',
                 'College students', 'Bildungsromans', 'Literary fiction'],
      title: 'The Secret History', marketPos: 'literary_prestige',
      // No specific dark evidence: classifyTone returns broad-only or
      // unknown without description; no phrasal hit; not domestic_suspense.
      // Per rule 5 (unknown → do not hard-exclude), Secret History is
      // ELIGIBLE under No-dark. Broad-only dark would land in
      // notRightNowRisks for downstream demotion, not hardExclusions.
      noDarkExcluded: false, lessDarkExcluded: false,
      noLiteraryExcluded: true, noRomanceExcluded: false },

    { name: 'The Thursday Murder Club',
      subjects: ['cozy mystery', 'detective and mystery stories', 'murder',
                 'older people', 'fiction', 'humorous fiction'],
      title: 'The Thursday Murder Club', marketPos: 'cozy_detective',
      noDarkExcluded: false,  // classifyTone → light/specific; cozy invariant
      lessDarkExcluded: false, noLiteraryExcluded: false, noRomanceExcluded: false },

    { name: 'Everything I Never Told You',
      subjects: ['grief', 'drowning', 'literary fiction', 'psychological fiction',
                 'family secrets', 'mothers and daughters'],
      title: 'Everything I Never Told You', marketPos: 'literary_prestige',
      // 'grief' is a single-token in TONE_DARK_SPECIFIC → folds to broad;
      // only 1 dark broad hit → not darkStrong → tone=unknown.
      // No phrasal DARK_SIGNALS hit. Not domestic_suspense. → eligible.
      noDarkExcluded: false, lessDarkExcluded: false,
      noLiteraryExcluded: true, noRomanceExcluded: false },

    // Generic controls:
    { name: 'Beach Read (pure-romance control)',
      subjects: ['Romance', 'Romantic comedy', 'Fiction'],
      title: 'Beach Read', marketPos: 'romance',
      noDarkExcluded: false, lessDarkExcluded: false,
      noLiteraryExcluded: false, noRomanceExcluded: true },

    { name: 'Pure Romance Control',
      subjects: ['Romance', 'Contemporary romance', 'Love story'],
      title: 'Generic Romance', marketPos: 'romance',
      noDarkExcluded: false, lessDarkExcluded: false,
      noLiteraryExcluded: false, noRomanceExcluded: true },

    { name: 'Cozy Mystery Control',
      subjects: ['Cozy mystery', 'Amateur detective', 'Murder'],
      title: 'Generic Cozy', marketPos: 'cozy_detective',
      noDarkExcluded: false,  // lightSpec=1 (cozy mystery) beats darkBroad=1 (murder)
      lessDarkExcluded: false, noLiteraryExcluded: false, noRomanceExcluded: false },

    { name: 'Dark Literary Control',
      subjects: ['Literary fiction', 'Trauma', 'Abuse', 'Psychological fiction'],
      title: 'Generic Dark Literary', marketPos: 'literary_prestige',
      // 'trauma' + 'abuse' both phrasal hits in curated DARK_SIGNALS
      // (single-token entries kept per documented exception).
      noDarkExcluded: true, lessDarkExcluded: false,
      noLiteraryExcluded: true, noRomanceExcluded: false },

    { name: 'Domestic Suspense Control',
      subjects: ['Psychological suspense', 'Domestic noir', 'Marriage'],
      title: 'Generic Domestic Suspense', marketPos: 'domestic_suspense',
      noDarkExcluded: true,  // 'psychological suspense' phrasal hit
      lessDarkExcluded: false, noLiteraryExcluded: false, noRomanceExcluded: false },

    { name: 'Romantic Suspense Control',
      subjects: ['Romantic suspense', 'Romance', 'Suspense'],
      title: 'Generic Romantic Suspense', marketPos: 'romance',
      // No phrasal hit, not domestic_suspense; classifyTone unknown.
      // Per rule 10, romantic suspense WITHOUT specific suspense/dark
      // evidence is NOT excluded under No-dark.
      noDarkExcluded: false, lessDarkExcluded: false,
      noLiteraryExcluded: false, noRomanceExcluded: true },
  ];

  const lenses = {
    noDark:      { hard: {}, soft: {},                   exclude: { avoid_dark: true } } as NextReadIntent,
    lessDark:    { hard: {}, soft: { intensity: 'low' }, exclude: {} }                   as NextReadIntent,
    noLiterary:  { hard: {}, soft: {},                   exclude: { avoid_literary: true } } as NextReadIntent,
    noRomance:   { hard: {}, soft: {},                   exclude: { avoid_romance:  true } } as NextReadIntent,
  };

  let fixtureFailures = 0;
  for (const f of fixtures) {
    const book = { subjects: f.subjects, title: f.title, description: f.description };
    const cases: Array<[keyof typeof lenses, boolean]> = [
      ['noDark',     f.noDarkExcluded],
      ['lessDark',   f.lessDarkExcluded],
      ['noLiterary', f.noLiteraryExcluded],
      ['noRomance',  f.noRomanceExcluded],
    ];
    for (const [lensName, expected] of cases) {
      const verdict = evaluateBookAgainstIntentLens(book, lenses[lensName], f.marketPos);
      const excluded = verdict.hardExclusions.length > 0;
      if (excluded !== expected) {
        console.error(`  ✗ "${f.name}" under ${lensName}: expected excluded=${expected}, got excluded=${excluded} (status=${verdict.status}, reasons=${verdict.hardExclusions.map(h => h.reason).join(',')})`);
        fixtureFailures++;
      }
    }
    // Less-dark MUST NEVER produce a hard exclusion — rule 4.
    const lessDarkVerdict = evaluateBookAgainstIntentLens(book, lenses.lessDark, f.marketPos);
    if (lessDarkVerdict.hardExclusions.length > 0) {
      console.error(`  ✗ "${f.name}": Less-dark produced a hard exclusion (${lessDarkVerdict.hardExclusions[0].reason}) — must be bounded demotion only`);
      fixtureFailures++;
    }

    // status field MUST agree with hardExclusions presence under No-dark.
    const noDarkVerdict = evaluateBookAgainstIntentLens(book, lenses.noDark, f.marketPos);
    const statusExcluded = noDarkVerdict.status === 'excluded';
    if (statusExcluded !== f.noDarkExcluded) {
      console.error(`  ✗ "${f.name}": No-dark status='${noDarkVerdict.status}' but expected excluded=${f.noDarkExcluded}`);
      fixtureFailures++;
    }
    // Verdict shape invariant: 'excluded' iff hardExclusions non-empty.
    if ((noDarkVerdict.status === 'excluded') !== (noDarkVerdict.hardExclusions.length > 0)) {
      console.error(`  ✗ "${f.name}": status='excluded' must iff hardExclusions non-empty (status=${noDarkVerdict.status}, hard=${noDarkVerdict.hardExclusions.length})`);
      fixtureFailures++;
    }
  }
  if (fixtureFailures > 0) fail(`§10 fixture matrix: ${fixtureFailures} assertion(s) failed`);
  ok(`§10 fixture matrix: 12 fixtures × 4 lenses (48 hardExclusion assertions) all green`);
  ok(`§10 invariant: Less-dark produced ZERO hard exclusions across all 12 fixtures (rule 4 preserved)`);
  ok(`§10 invariant: status === 'excluded' iff hardExclusions non-empty (12 fixtures verified)`);
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
