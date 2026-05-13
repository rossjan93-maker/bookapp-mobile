/**
 * scripts/validate_taxonomy.ts
 *
 * P0A integrity guard. Exits 0 on success, 1 on any failure. Run with:
 *   npx tsx scripts/validate_taxonomy.ts
 *
 * Verifies:
 *   1. Every chip rendered in app/edit-preferences.tsx (via EDIT_GENRE_IDS)
 *      resolves through normalizeGenreInput().
 *   2. Every chip rendered in components/RecEntryScreen.tsx (via
 *      INTAKE_FICTION_IDS + INTAKE_NONFICTION_IDS) resolves.
 *   3. Previously silently-dropped legacy labels (History, Biography,
 *      Business, Science, Poetry, Classic, plus alias variants Sci-Fi /
 *      Sci-fi & fantasy / Biography & Memoir / Science & Nature) all
 *      resolve to the expected canonical id.
 *   4. No alias-index conflicts (the index throws at module load if any
 *      alias maps to two defs).
 *
 * Replaces tests/taxonomy.test.ts because the project has no jest/vitest
 * setup; the existing scripts/check_series_covers.ts pattern is used
 * instead (npx tsx, exit code 0/1).
 */

import {
  EDIT_GENRE_IDS,
  INTAKE_FICTION_IDS,
  INTAKE_NONFICTION_IDS,
  editLabel,
  intakeLabel,
  GENRE_DEFS,
} from '../lib/taxonomy/genres';
import { normalizeGenreInput, _aliasCount } from '../lib/taxonomy/normalize';

type Failure = { check: string; detail: string };
const failures: Failure[] = [];

// ── 1 / 2: chip lists resolve ────────────────────────────────────────────────
for (const id of EDIT_GENRE_IDS) {
  const label = editLabel(id);
  const def = normalizeGenreInput(label);
  if (!def || def.id !== id) {
    failures.push({
      check: 'edit chip resolves',
      detail: `id=${id} label=${JSON.stringify(label)} resolved=${def?.id ?? 'null'}`,
    });
  }
}
for (const id of [...INTAKE_FICTION_IDS, ...INTAKE_NONFICTION_IDS]) {
  const label = intakeLabel(id);
  const def = normalizeGenreInput(label);
  if (!def || def.id !== id) {
    failures.push({
      check: 'intake chip resolves',
      detail: `id=${id} label=${JSON.stringify(label)} resolved=${def?.id ?? 'null'}`,
    });
  }
}

// ── 3: legacy / alias coverage proofs ────────────────────────────────────────
const LEGACY_PROBES: ReadonlyArray<{ input: string; expectId: string }> = [
  { input: 'History',             expectId: 'history' },
  { input: 'Biography',           expectId: 'biography_memoir' },
  { input: 'Biography & Memoir',  expectId: 'biography_memoir' },
  { input: 'Business',            expectId: 'business' },
  { input: 'Science',             expectId: 'science' },
  { input: 'Science & Nature',    expectId: 'science' },
  { input: 'Poetry',              expectId: 'poetry' },
  { input: 'Classic',             expectId: 'classic' },
  { input: 'Classics',            expectId: 'classic' },
  { input: 'Sci-Fi',              expectId: 'sci_fi' },
  { input: 'Sci-fi & fantasy',    expectId: 'sci_fi' },
  { input: 'Science Fiction',     expectId: 'sci_fi' },
  { input: 'Non-Fiction',         expectId: 'nonfiction_general' },
  { input: 'Nonfiction',          expectId: 'nonfiction_general' },
  { input: 'Memoir',              expectId: 'biography_memoir' },
  { input: 'Self-Help',           expectId: 'self_help' },
  { input: 'Self Help',           expectId: 'self_help' },
];
for (const { input, expectId } of LEGACY_PROBES) {
  const def = normalizeGenreInput(input);
  if (!def || def.id !== expectId) {
    failures.push({
      check: 'legacy/alias resolves',
      detail: `input=${JSON.stringify(input)} expected=${expectId} got=${def?.id ?? 'null'}`,
    });
  }
}

// ── 4: alias index size sanity ──────────────────────────────────────────────
// At least one alias per def (they all have at least one uiLabels entry).
if (_aliasCount() < GENRE_DEFS.length) {
  failures.push({
    check: 'alias index size',
    detail: `aliasCount=${_aliasCount()} defs=${GENRE_DEFS.length}`,
  });
}

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`[taxonomy] FAIL — ${failures.length} integrity issue(s):`);
  for (const f of failures) console.error(`  - [${f.check}] ${f.detail}`);
  process.exit(1);
}

console.log(
  `[taxonomy] OK — ${GENRE_DEFS.length} defs, ${_aliasCount()} alias keys, ` +
    `${EDIT_GENRE_IDS.length} edit chips, ` +
    `${INTAKE_FICTION_IDS.length + INTAKE_NONFICTION_IDS.length} intake chips, ` +
    `${LEGACY_PROBES.length} legacy probes resolved.`,
);
process.exit(0);
