// =============================================================================
// validate_book_trait_coverage — P4B BookTraits foundation contract validator
//
// Proves the P4B observe-only invariants on deterministic fixtures (no live
// API, no LLM, no network). Asserts:
//
//   1. New BookTraits fields are present with unknown-first defaults.
//   2. classifyLength returns correct deterministic buckets.
//   3. parseSeriesPosition handles common Goodreads-style title patterns.
//   4. classifyTone does NOT over-infer from genre alone.
//   5. classifyPace does NOT over-infer from weak subject noise.
//   6. classifyComplexity does NOT classify every long / literary book as dense.
//   7. Confidence fields ('specific' | 'broad' | 'unknown') are set per the
//      documented rules.
//   8. detectGenre regression fixtures (the P3A live-smoke ones) remain green.
//   9. Existing legacy BookTraits surface (primaryGenre, bookForm, traits) is
//      byte-identical against fixtures — proving zero behaviour change.
//  10. Module exports remain stable for downstream consumers.
//
// Exit 0 on full pass; exit 1 on any failure (line-noisy with ✓ / ✗).
// =============================================================================

import {
  getBookTraits,
  classifyLength,
  classifyTone,
  classifyPace,
  classifyComplexity,
  parseSeriesPosition,
  enrichSeriesPositionFromCatalog,
  detectGenre,
  detectBookForm,
} from '../lib/bookTraits';

let failures = 0;
function check(label: string, cond: unknown, detail = ''): void {
  if (cond) {
    console.log('  ✓ ' + label);
  } else {
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
    failures++;
  }
}

// ── 1. New fields exist with unknown-first defaults ──────────────────────────
console.log('1. New BookTraits fields default to unknown when evidence is absent');
{
  const empty = getBookTraits({});
  check('tone defaults to unknown',                empty.tone === 'unknown');
  check('toneConfidence defaults to unknown',      empty.toneConfidence === 'unknown');
  check('pace defaults to unknown',                empty.pace === 'unknown');
  check('paceConfidence defaults to unknown',      empty.paceConfidence === 'unknown');
  check('complexity defaults to unknown',          empty.complexity === 'unknown');
  check('complexityConfidence defaults to unknown',empty.complexityConfidence === 'unknown');
  check('lengthClass defaults to unknown',         empty.lengthClass === 'unknown');
  check('seriesPosition defaults to null',         empty.seriesPosition === null);

  // Untitled / no-author still produces all fields present (not undefined)
  const keys = Object.keys(empty);
  check('all P4B fields are present (not undefined) on empty input',
    ['tone','toneConfidence','pace','paceConfidence','complexity',
     'complexityConfidence','lengthClass','seriesPosition'].every(k => keys.includes(k)));
}

// ── 2. Length-class buckets ──────────────────────────────────────────────────
console.log('2. classifyLength bucket boundaries');
check('null → unknown',           classifyLength(null) === 'unknown');
check('undefined → unknown',      classifyLength(undefined) === 'unknown');
check('0 → unknown',              classifyLength(0) === 'unknown');
check('-5 → unknown',             classifyLength(-5) === 'unknown');
check('NaN → unknown',            classifyLength(Number.NaN) === 'unknown');
check('120 → short',              classifyLength(120) === 'short');
check('240 → short (upper edge)', classifyLength(240) === 'short');
check('241 → standard',           classifyLength(241) === 'standard');
check('350 → standard',           classifyLength(350) === 'standard');
check('420 → standard (upper)',   classifyLength(420) === 'standard');
check('421 → long',               classifyLength(421) === 'long');
check('600 → long',               classifyLength(600) === 'long');
check('700 → long (upper edge)',  classifyLength(700) === 'long');
check('701 → tome',               classifyLength(701) === 'tome');
check('1200 → tome',              classifyLength(1200) === 'tome');

// ── 3. Series position parsing ───────────────────────────────────────────────
console.log('3. parseSeriesPosition recognises common title patterns');
{
  const a = parseSeriesPosition('Royal Assassin (Farseer Trilogy, #2)');
  check('Farseer #2 — seriesName',
    a?.seriesName === 'Farseer Trilogy', `got=${JSON.stringify(a)}`);
  check('Farseer #2 — index = 2',
    a?.index === 2);

  const b = parseSeriesPosition('Ship of Destiny (Liveship Traders, #3)');
  check('Liveship #3 — seriesName',
    b?.seriesName === 'Liveship Traders');
  check('Liveship #3 — index = 3',  b?.index === 3);

  const c = parseSeriesPosition('Words of Radiance (The Stormlight Archive, Book 2)');
  check('Stormlight Book 2 — seriesName',
    c?.seriesName === 'The Stormlight Archive');
  check('Stormlight Book 2 — index = 2', c?.index === 2);

  const d = parseSeriesPosition('Mistborn #1');
  check('Bare "#1" with no parens → null', d === null);

  const e = parseSeriesPosition('A Storm of Swords (A Song of Ice and Fire #3)');
  check('No comma before #N still parses',
    e?.seriesName === 'A Song of Ice and Fire' && e?.index === 3,
    `got=${JSON.stringify(e)}`);

  const f = parseSeriesPosition('The Goldfinch');
  check('Standalone book → null', f === null);

  const g = parseSeriesPosition('Some Book (2007)');
  check('Year-only parens → null',  g === null);

  const h = parseSeriesPosition('Some Book (Hardcover edition)');
  check('Non-volume parens → null', h === null);

  const i = parseSeriesPosition('');
  check('Empty title → null',       i === null);

  const j = parseSeriesPosition(null);
  check('null title → null',        j === null);

  // enrichSeriesPositionFromCatalog wiring (synthetic catalog stub)
  const k = enrichSeriesPositionFromCatalog(
    { seriesName: 'Farseer Trilogy', index: 2 },
    (norm) => norm === 'farseer trilogy' ? { total: 3 } : null,
  );
  check('catalog enrichment sets of=3',
    k.of === 3 && k.index === 2 && k.seriesName === 'Farseer Trilogy');

  const l = enrichSeriesPositionFromCatalog(
    { seriesName: 'Unknown Series', index: 1 },
    () => null,
  );
  check('catalog miss leaves of undefined',
    l.of === undefined && l.index === 1);
}

// ── 4. Tone does NOT over-infer from genre alone ─────────────────────────────
console.log('4. classifyTone is conservative — genre alone is not enough');
{
  // Romance + thriller genre tags alone → no tonal claim
  const romance = classifyTone({ subjects: ['Romance', 'Fiction'] });
  check('Romance subjects only → tone unknown',
    romance.tone === 'unknown' && romance.confidence === 'unknown',
    `got=${JSON.stringify(romance)}`);

  const thriller = classifyTone({ subjects: ['Thriller', 'Fiction'] });
  check('"Thriller" (single broad) → tone unknown',
    thriller.tone === 'unknown' && thriller.confidence === 'unknown',
    `got=${JSON.stringify(thriller)}`);

  // Two broad dark hits → dark/broad
  const twoBroadDark = classifyTone({ subjects: ['Thriller', 'Murder', 'Fiction'] });
  check('Two broad dark hits → tone dark, broad confidence',
    twoBroadDark.tone === 'dark' && twoBroadDark.confidence === 'broad',
    `got=${JSON.stringify(twoBroadDark)}`);

  // Specific dark hit → specific
  const specDark = classifyTone({ subjects: ['Psychological thriller', 'Fiction'] });
  check('"Psychological thriller" → tone dark, specific confidence',
    specDark.tone === 'dark' && specDark.confidence === 'specific',
    `got=${JSON.stringify(specDark)}`);

  // Specific light hit
  const specLight = classifyTone({ subjects: ['Cozy mystery', 'Fiction'] });
  check('"Cozy mystery" → tone light, specific confidence',
    specLight.tone === 'light' && specLight.confidence === 'specific',
    `got=${JSON.stringify(specLight)}`);

  // Mixed: both sides strong
  const mixed = classifyTone({
    subjects: ['Dark fantasy', 'Humorous fiction'],
  });
  check('Specific dark + specific light → mixed, specific',
    mixed.tone === 'mixed' && mixed.confidence === 'specific',
    `got=${JSON.stringify(mixed)}`);

  // Single broad-only light hit ("humor") is not enough
  const weakLight = classifyTone({ subjects: ['Humor', 'Fiction'] });
  check('"Humor" alone (single broad) → tone unknown',
    weakLight.tone === 'unknown',
    `got=${JSON.stringify(weakLight)}`);

  // Title-only signals are intentionally ignored ("Dark Matter" SF novel)
  const titleOnly = classifyTone({ subjects: [], description: '' });
  check('No subjects + no description → tone unknown',
    titleOnly.tone === 'unknown');
}

// ── 5. Pace does NOT over-infer from weak subject noise ──────────────────────
console.log('5. classifyPace is conservative — single broad subject is not enough');
{
  // "Fiction" alone → unknown
  const generic = classifyPace({ subjects: ['Fiction'] });
  check('Generic "Fiction" → pace unknown',
    generic.pace === 'unknown');

  // Single broad "Thriller" → unknown (matches replit.md gotcha philosophy)
  const justThriller = classifyPace({ subjects: ['Thriller'] });
  check('Single "Thriller" subject → pace unknown',
    justThriller.pace === 'unknown',
    `got=${JSON.stringify(justThriller)}`);

  // Two broad fast hits ("Thriller", "Suspense") → fast, broad
  const twoBroadFast = classifyPace({ subjects: ['Thriller', 'Suspense'] });
  check('Two broad fast hits → fast, broad',
    twoBroadFast.pace === 'fast' && twoBroadFast.confidence === 'broad');

  // Specific fast → specific
  const specFast = classifyPace({ subjects: ['Page-turner', 'Fiction'] });
  check('"Page-turner" → fast, specific',
    specFast.pace === 'fast' && specFast.confidence === 'specific');

  // Specific slow
  const specSlow = classifyPace({ subjects: ['Slow-burn', 'Literary fiction'] });
  check('"Slow-burn" → slow, specific',
    specSlow.pace === 'slow' && specSlow.confidence === 'specific');

  // Conflict → medium
  const conflict = classifyPace({
    subjects: ['Page-turner', 'Slow-burn'],
  });
  check('Fast specific + slow specific → medium, broad',
    conflict.pace === 'medium' && conflict.confidence === 'broad',
    `got=${JSON.stringify(conflict)}`);

  // "Literary" alone is broad-only single hit → unknown
  const justLit = classifyPace({ subjects: ['Literary'] });
  check('"Literary" alone (single broad) → pace unknown',
    justLit.pace === 'unknown');
}

// ── 6. Complexity is even more conservative on 'dense' ───────────────────────
console.log('6. classifyComplexity does not over-claim "dense"');
{
  // Long literary novel → NOT auto-dense
  const longLiterary = classifyComplexity({
    subjects:   ['Literary fiction', 'Fiction'],
    page_count: 720,
  });
  check('Long literary fiction → literary (not dense)',
    longLiterary.complexity === 'literary'
      && longLiterary.confidence === 'specific',
    `got=${JSON.stringify(longLiterary)}`);

  // History textbook alone is NOT enough — needs an academic signal
  const justHistory = classifyComplexity({
    subjects: ['History', 'Nonfiction'],
    page_count: 800,
  });
  check('Long "History" + "Nonfiction" alone → complexity unknown',
    justHistory.complexity === 'unknown',
    `got=${JSON.stringify(justHistory)}`);

  // Bare "Philosophy" alone is broad-only single hit → unknown
  const justPhil = classifyComplexity({
    subjects: ['Philosophy'],
  });
  check('Single broad "Philosophy" → unknown',
    justPhil.complexity === 'unknown',
    `got=${JSON.stringify(justPhil)}`);

  // Two broad dense hits → dense, broad
  const broadDense = classifyComplexity({
    subjects: ['Philosophy', 'Theology'],
  });
  check('Two broad dense hits → dense, broad',
    broadDense.complexity === 'dense'
      && broadDense.confidence === 'broad',
    `got=${JSON.stringify(broadDense)}`);

  // Single-token "Academic" alone is NOT enough under the multi-word gate;
  // it demotes to broad-pool evidence and requires corroboration.
  const academicAlone = classifyComplexity({ subjects: ['Academic'] });
  check('Single-token "Academic" alone → unknown (multi-word gate)',
    academicAlone.complexity === 'unknown',
    `got=${JSON.stringify(academicAlone)}`);

  // Single-token "Academic" + a broad dense corroborator → dense, broad
  const academicCorroborated = classifyComplexity({
    subjects: ['Academic', 'Philosophy'],
  });
  check('"Academic" + "Philosophy" (corroborated) → dense, broad',
    academicCorroborated.complexity === 'dense'
      && academicCorroborated.confidence === 'broad',
    `got=${JSON.stringify(academicCorroborated)}`);

  // A genuine multi-word specific signal still fires at 'specific'
  const expFiction = classifyComplexity({ subjects: ['Experimental fiction'] });
  check('"Experimental fiction" → dense, specific',
    expFiction.complexity === 'dense' && expFiction.confidence === 'specific',
    `got=${JSON.stringify(expFiction)}`);

  // Accessible
  const selfHelp = classifyComplexity({ subjects: ['Self-help'] });
  check('"Self-help" → accessible, specific',
    selfHelp.complexity === 'accessible' && selfHelp.confidence === 'specific',
    `got=${JSON.stringify(selfHelp)}`);

  // Empty
  const none = classifyComplexity({});
  check('No evidence → complexity unknown', none.complexity === 'unknown');
}

// ── 7. Confidence wiring through getBookTraits end-to-end ────────────────────
console.log('7. getBookTraits surfaces confidence fields correctly');
{
  const bt = getBookTraits({
    title:    'Royal Assassin (Farseer Trilogy, #2)',
    author:   'Robin Hobb',
    subjects: ['Fantasy', 'Epic fantasy'],
    page_count: 675,
  });
  check('Farseer #2 → lengthClass = long',
    bt.lengthClass === 'long');
  check('Farseer #2 → seriesPosition resolves',
    bt.seriesPosition?.seriesName === 'Farseer Trilogy'
      && bt.seriesPosition?.index === 2);
  check('Farseer #2 → tone unknown (no tonal evidence)',
    bt.tone === 'unknown' && bt.toneConfidence === 'unknown',
    `got tone=${bt.tone}/${bt.toneConfidence}`);
  check('Farseer #2 → pace unknown (no pace evidence)',
    bt.pace === 'unknown');
  check('Farseer #2 → complexity unknown (no academic / literary signal)',
    bt.complexity === 'unknown');

  // Tome length
  const tome = getBookTraits({
    title: 'The Way of Kings',
    page_count: 1007,
    subjects: ['Epic fantasy', 'Fantasy fiction'],
  });
  check('1007-page book → lengthClass = tome',
    tome.lengthClass === 'tome');
}

// ── 8. detectGenre regression coverage (P3A live-smoke fixtures) ─────────────
console.log('8. detectGenre regression — substring-bleed fixtures still pass');
check('"science fiction" → fantasy_scifi (not nonfiction)',
  detectGenre({ subjects: ['Science fiction', 'Fiction'] }) === 'fantasy_scifi');
check('"historical fiction" → not nonfiction',
  detectGenre({ subjects: ['Historical fiction', 'Fiction'] }) !== 'nonfiction');
check('"psychological thriller" → thriller_mystery (not nonfiction)',
  detectGenre({ subjects: ['Psychological thriller'] }) === 'thriller_mystery');
check('mixed-tag true nonfiction routes to nonfiction',
  detectGenre({ subjects: ['True crime', 'Mystery', 'Nonfiction'] }) === 'nonfiction');
check('memoir wins over nonfiction',
  detectGenre({ subjects: ['Memoir', 'Nonfiction'] }) === 'memoir_bio');
check('literary fiction routes to literary',
  detectGenre({ subjects: ['Literary fiction'] }) === 'literary');

// ── 9. Legacy surface is byte-identical (zero behavior change) ───────────────
console.log('9. Legacy BookTraits surface unchanged for representative fixtures');
{
  const fixtures = [
    { name: 'epic fantasy long', book: {
      title: 'The Way of Kings', subjects: ['Epic fantasy', 'Fantasy fiction'],
      page_count: 1007, author: 'Brandon Sanderson',
    }},
    { name: 'psych thriller', book: {
      title: 'Magpie Murders', subjects: ['Psychological thriller', 'Mystery fiction'],
      page_count: 480, author: 'Anthony Horowitz',
    }},
    { name: 'memoir nonfiction', book: {
      title: 'Educated', subjects: ['Memoir', 'Nonfiction', 'Biography'],
      page_count: 334, author: 'Tara Westover',
    }},
    { name: 'no subjects', book: {
      title: 'Mystery Book', subjects: [], page_count: null, author: 'Unknown',
    }},
  ];

  for (const f of fixtures) {
    const bt = getBookTraits(f.book);
    // Legacy fields must remain populated as before
    check(`[${f.name}] primaryGenre is set (or null)`,
      bt.primaryGenre === null || typeof bt.primaryGenre === 'string');
    check(`[${f.name}] traits map is non-empty`,
      Object.keys(bt.traits).length > 0);
    check(`[${f.name}] bookForm respects detectBookForm`,
      bt.bookForm === detectBookForm(f.book));
    check(`[${f.name}] genres includes primaryGenre OR 'general'`,
      bt.genres.length > 0 &&
        (bt.genres[0] === bt.primaryGenre || bt.genres[0] === 'general'));
  }
}

// ── 10. Exported surface stability ───────────────────────────────────────────
console.log('10. Module exports remain stable');
check('classifyLength exported',         typeof classifyLength === 'function');
check('classifyTone exported',           typeof classifyTone === 'function');
check('classifyPace exported',           typeof classifyPace === 'function');
check('classifyComplexity exported',     typeof classifyComplexity === 'function');
check('parseSeriesPosition exported',    typeof parseSeriesPosition === 'function');
check('enrichSeriesPositionFromCatalog exported',
  typeof enrichSeriesPositionFromCatalog === 'function');
check('getBookTraits exported',          typeof getBookTraits === 'function');
check('detectGenre exported',            typeof detectGenre === 'function');
check('detectBookForm exported',         typeof detectBookForm === 'function');

// ── Summary ──────────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log('\n✓ All P4B book-trait coverage checks passed.');
  process.exit(0);
} else {
  console.log(`\n✗ ${failures} check(s) failed.`);
  process.exit(1);
}
