#!/usr/bin/env -S npx tsx
// ─────────────────────────────────────────────────────────────────────────────
// validate_detect_genre.ts
//
// Pins the lib/bookTraits.ts::detectGenre contract after the Scenario B
// P3A live-smoke blocker fix:
//   - substring `includes()` → word-boundary regex
//   - broad nonfiction signals pruned (`science`, `history`, `psychology`,
//     `philosophy`, `technology`, `sociology`)
//   - bucket order: memoir_bio → nonfiction → fiction buckets → literary
//     (nonfiction promoted to position #2; justified deviation from the
//     spec's nonfiction-last recommendation because the pruned signal
//     list no longer leaks into fiction subjects, and the architect
//     surfaced a mixed-tag true-nonfiction regression with nonfiction-last
//     — see R1/R2/R3 below).
//
// Negative invariants (anti-leak):
//   - Fiction subject metadata containing the broad tokens `science`,
//     `history`, `psychology`, `philosophy`, `technology`, `sociology`
//     must NOT classify as nonfiction.
//
// Positive invariants (preserve true nonfiction):
//   - Books whose subjects carry unambiguous nonfiction signals
//     (`nonfiction`, `true crime`, `self-help`, `business`, `economics`,
//     `politics`) must still resolve to nonfiction.
//   - Memoir / autobiography routes to memoir_bio (unchanged).
//
// Spec reference: P3A live-smoke Scenario B blocker authorization.
// ─────────────────────────────────────────────────────────────────────────────
import { detectGenre } from '../lib/bookTraits';
import { computeStatedTasteContribution } from '../lib/recPolicy';
import type { AffinityKey } from '../lib/taxonomy/genres';

type Case = {
  id:        string;
  subjects:  string[];
  expected:  string | null;
  mustNotBe?: string;
};

const CASES: Case[] = [
  // ── Must NOT classify as nonfiction ────────────────────────────────────────
  { id: 'C1 sci-fi',         subjects: ['science fiction', 'space opera'],          expected: 'fantasy_scifi',    mustNotBe: 'nonfiction' },
  { id: 'C2 historical fic', subjects: ['historical fiction', 'ancient Greece'],    expected: null /* not nonfiction; literary tag absent → general */, mustNotBe: 'nonfiction' },
  { id: 'C3 psych thriller', subjects: ['psychological thriller', 'suspense'],      expected: 'thriller_mystery', mustNotBe: 'nonfiction' },
  { id: 'C4 Greek myth',     subjects: ['Greek mythology', 'Trojan War'],           expected: null /* not nonfiction; no literary tag */, mustNotBe: 'nonfiction' },
  { id: 'C5 YA + cancer',    subjects: ['young adult fiction', 'love story', 'cancer'], expected: 'romance',     mustNotBe: 'nonfiction' },
  { id: 'C6 philosophical novel', subjects: ['philosophical novel'],                expected: null /* "philosophical novel" carries no fiction bucket signal; not nonfiction either under word-boundary */, mustNotBe: 'nonfiction' },

  // ── Must still classify as nonfiction ──────────────────────────────────────
  { id: 'C7 mountaineering nonfiction', subjects: ['mountaineering', 'nonfiction', 'true crime'], expected: 'nonfiction' },
  { id: 'C8 self-help + business',      subjects: ['self-help', 'business'],         expected: 'nonfiction' },
  { id: 'C9 memoir autobio',            subjects: ['memoir', 'autobiography'],       expected: 'memoir_bio' },
  { id: 'C10 economics + nonfiction',   subjects: ['economics', 'public policy', 'nonfiction'], expected: 'nonfiction' },

  // ── Specific Scenario-B smoke books (regression pin) ───────────────────────
  // Synthetic subject sets approximating what OL/GBooks return; precise
  // catalog values may differ but the broad-token leak is what we're
  // closing here.
  { id: 'SB1 TFiOS',            subjects: ['young adult fiction', 'love story', 'cancer', 'psychology of grief'], expected: 'romance', mustNotBe: 'nonfiction' },
  { id: 'SB2 Song of Achilles', subjects: ['historical fiction', 'Greek mythology', 'ancient history', 'Trojan War'], expected: null, mustNotBe: 'nonfiction' },
  { id: 'SB3 Murder Himalaya',  subjects: ['mountaineering', 'true crime', 'nonfiction'], expected: 'nonfiction' },

  // ── Bonus: bare 'history' on fiction must NOT trip nonfiction ──────────────
  { id: 'B1 fic + history tag', subjects: ['historical fiction', 'history'], expected: null, mustNotBe: 'nonfiction' },

  // ── Architect-surfaced regression class: mixed-tag TRUE nonfiction. ─────────
  // Catalog metadata for genuine nonfiction sometimes carries
  // fiction-adjacent subject tokens (`mystery` on a true-crime book,
  // `thriller` on an investigative political book, `literary` on
  // literary criticism). These books are unambiguously nonfiction by
  // their `nonfiction` / `true crime` anchor and must classify as such
  // — even though a fiction bucket would also match on the noisy tag.
  // Pinning these prevents future bucket reorders from re-introducing
  // the regression the spec's recommended order accidentally created.
  { id: 'R1 true crime + mystery + nonfiction', subjects: ['true crime', 'mystery', 'nonfiction'], expected: 'nonfiction' },
  { id: 'R2 literary criticism + nonfiction',   subjects: ['literary criticism', 'nonfiction'],     expected: 'nonfiction' },
  { id: 'R3 political thriller + nonfiction',   subjects: ['political thriller', 'nonfiction'],     expected: 'nonfiction' },
];

let failures = 0;
function check(label: string, ok: boolean, hint?: string): void {
  console.log(`  ${ok ? '✔' : '✘'} ${label}${ok ? '' : ` — ${hint}`}`);
  if (!ok) failures++;
}

console.log('─ validate_detect_genre — Scenario B regression pin ─');
for (const c of CASES) {
  const got = detectGenre({ subjects: c.subjects, title: null, author: null });
  if (c.mustNotBe) {
    check(`${c.id}: not "${c.mustNotBe}"`, got !== c.mustNotBe, `got=${got}`);
  }
  check(`${c.id}: == ${c.expected}`, got === c.expected, `got=${got}`);
}

// ── Scenario B cross-stage fixture — detector → stated-taste contribution ────
// Spec deliverable §6: User with stated favorites ['thriller_mystery',
// 'nonfiction'] must NOT receive a stated_favorite:nonfiction contribution
// for the fiction smoke books, but MUST still receive it for the control.
// This pins the chain at its inflection point — if detectGenre is honest,
// computeStatedTasteContribution is honest, the audit flag is honest, the
// derived contribution is honest, and the composer copy is honest. The
// dual-path composer behaviour itself is already covered by
// validate_explanation_quality_contribution + validate_explanation_projection.
console.log('\n─ Scenario B cross-stage fixture (detector → stated-taste) ─');
const SB_FAVS: AffinityKey[] = ['thriller_mystery', 'nonfiction'] as AffinityKey[];
const SB_BOOKS: Array<{ id: string; subjects: string[]; expectMatchedKey: string | null }> = [
  { id: 'TFiOS',
    subjects: ['young adult fiction', 'love story', 'cancer', 'psychology of grief'],
    expectMatchedKey: null /* romance — not in stated favorites, so no match */ },
  { id: 'Song of Achilles',
    subjects: ['historical fiction', 'Greek mythology', 'ancient history', 'Trojan War'],
    expectMatchedKey: null /* primaryGenre=null → no contribution */ },
  { id: 'Murder in the High Himalaya',
    subjects: ['mountaineering', 'true crime', 'nonfiction'],
    expectMatchedKey: 'nonfiction' /* primaryGenre=nonfiction ∈ favorites → match */ },
];
for (const b of SB_BOOKS) {
  const pg = detectGenre({ subjects: b.subjects, title: null, author: null });
  const contrib = computeStatedTasteContribution(pg, SB_FAVS, [], /* tier */ 2);
  const matchedKey = contrib.matched?.kind === 'favorite' ? contrib.matched.key : null;
  check(`${b.id}: primaryGenre=${pg} → matched.key=${matchedKey}`,
    matchedKey === b.expectMatchedKey,
    `expected ${b.expectMatchedKey}, got ${matchedKey}`);
  // Negative assertion for fiction books: bonus must be 0, no false boost.
  if (b.expectMatchedKey === null) {
    check(`${b.id}: stated_taste bonus == 0 (no false ranking boost)`,
      contrib.bonus === 0,
      `bonus=${contrib.bonus}`);
  }
}

console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
