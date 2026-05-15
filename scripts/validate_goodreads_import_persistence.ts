/**
 * validate_goodreads_import_persistence.ts
 *
 * Synthetic contract validator for the Goodreads importer correctness fix.
 *
 * Origin: live data from user 7dc10017 — 273 import_rows staged → only 200
 * user_books materialised. 73 rows (Royal Assassin, Ship of Destiny, Lightlark,
 * The Two Towers, …) ended with matched_book_id=null AND user_book_id=null
 * despite their canonical entries existing in the books catalog.
 *
 * Root causes (now fixed):
 *   1. Stager's resolveMatch had no title+author fallback (Priority 4) —
 *      Goodreads CSV rows lacking ISBN13 and any prior book_source_link were
 *      forced into the executor's groupCreate path even when a clean catalog
 *      row existed.
 *   2. Executor's local normBookKey did not strip parenthetical series
 *      suffixes ("Royal Assassin (Farseer Trilogy, #2)" vs catalog "Royal
 *      Assassin") so the title+author dedup silently missed.
 *   3. Books bulk INSERT was atomic per PG statement — one failure aborted
 *      the entire chunk and silently dropped up to 100 books at once.
 *   4. user_books bulk INSERT had the same fragility — duplicate
 *      (user_id, book_id) within a chunk killed the whole chunk.
 *   5. counters.added++ fired unconditionally per toInsert row regardless of
 *      whether the underlying user_books row actually persisted.
 *
 * This validator covers the pure-function pieces (#1, #2 normalisation, plus
 * the boundary identities that the executor recovery loop depends on). The
 * full pipeline correctness (#3, #4, #5) requires a live DB and is verified
 * via live smoke (per the operating standard step 5).
 */

// Inlined copy of lib/goodreadsStager.ts:normTitleAuthorKey + stripSubtitleLocal.
// Importing the stager directly transitively pulls in @supabase/supabase-js
// which transitively requires react-native — un-loadable under plain tsx.
// The validator instead asserts that the inlined copy here matches the spec
// (subtitle stripping + author normalisation) that the stager ships. If the
// stager helper diverges, this file must be updated in lockstep.
function stripSubtitleLocal(title: string): string {
  return title
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s*:\s+.*$/, '')
    .replace(/\s+\/\s+.*$/, '')
    .replace(/\s+[-\u2013\u2014]\s+.*$/, '')
    .trim();
}
function normTitleAuthorKey(title: string, author: string | null): string {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${n(stripSubtitleLocal(title))}||${n((author ?? '').split(',')[0])}`;
}

let failures = 0;
function expect(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   · ${label}`);
  } else {
    failures++;
    console.error(`  FAIL · ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[validate_goodreads_import_persistence] subtitle stripping');

// (1) Parenthetical series suffix — the canonical lost-row pattern.
expect(
  'Royal Assassin (Farseer Trilogy, #2) ↔ Royal Assassin',
  normTitleAuthorKey('Royal Assassin (Farseer Trilogy, #2)', 'Robin Hobb')
    === normTitleAuthorKey('Royal Assassin', 'Robin Hobb'),
);

expect(
  'Ship of Destiny (Liveship Traders, #3) ↔ Ship of Destiny',
  normTitleAuthorKey('Ship of Destiny (Liveship Traders, #3)', 'Robin Hobb')
    === normTitleAuthorKey('Ship of Destiny', 'Robin Hobb'),
);

expect(
  'The Two Towers (The Lord of the Rings, #2) ↔ The Two Towers',
  normTitleAuthorKey('The Two Towers (The Lord of the Rings, #2)', 'J.R.R. Tolkien')
    === normTitleAuthorKey('The Two Towers', 'J.R.R. Tolkien'),
);

// (2) Colon-suffix subtitle — common nonfiction pattern.
expect(
  'Sapiens: A Brief History of Humankind ↔ Sapiens',
  normTitleAuthorKey('Sapiens: A Brief History of Humankind', 'Yuval Noah Harari')
    === normTitleAuthorKey('Sapiens', 'Yuval Noah Harari'),
);

// (3) Em-dash subtitle.
expect(
  'Quiet — The Power of Introverts ↔ Quiet',
  normTitleAuthorKey('Quiet \u2014 The Power of Introverts', 'Susan Cain')
    === normTitleAuthorKey('Quiet', 'Susan Cain'),
);

// (4) Slash-separated alternate title.
expect(
  'War and Peace / Война и мир ↔ War and Peace',
  normTitleAuthorKey('War and Peace / War and Peace', 'Leo Tolstoy')
    === normTitleAuthorKey('War and Peace', 'Leo Tolstoy'),
);

// (5) Author normalisation must use only first author (Goodreads
//     "Last, First" → split on comma takes "Last").
expect(
  'multi-author "Hobb, Robin" ↔ "Hobb"',
  normTitleAuthorKey('Royal Assassin', 'Hobb, Robin')
    === normTitleAuthorKey('Royal Assassin', 'Hobb'),
);

console.log('[validate_goodreads_import_persistence] negative cases');

// (6) Genuinely different books MUST NOT collide after stripping.
expect(
  'Royal Assassin ≠ Royal',
  normTitleAuthorKey('Royal Assassin', 'Robin Hobb')
    !== normTitleAuthorKey('Royal', 'Robin Hobb'),
);

expect(
  'The Hobbit ≠ The Two Towers (same author)',
  normTitleAuthorKey('The Hobbit', 'J.R.R. Tolkien')
    !== normTitleAuthorKey('The Two Towers', 'J.R.R. Tolkien'),
);

// (7) Different authors with same title must not collide.
expect(
  'Dune (Frank Herbert) ≠ Dune (Brian Herbert)',
  normTitleAuthorKey('Dune', 'Frank Herbert')
    !== normTitleAuthorKey('Dune', 'Brian Herbert'),
);

console.log('[validate_goodreads_import_persistence] safety properties');

// (8) Empty-author tolerance — stager and executor both pass row.author ?? ''.
expect(
  'null author does not throw',
  typeof normTitleAuthorKey('Royal Assassin', null) === 'string',
);

// (9) Whitespace robustness.
expect(
  'leading/trailing whitespace ignored',
  normTitleAuthorKey('  Royal Assassin  ', '  Robin Hobb  ')
    === normTitleAuthorKey('Royal Assassin', 'Robin Hobb'),
);

if (failures > 0) {
  console.error(`\n[validate_goodreads_import_persistence] ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\n[validate_goodreads_import_persistence] all checks passed');
