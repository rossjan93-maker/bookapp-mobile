// =============================================================================
// Canonical genre taxonomy (P0A)
//
// Single source of truth for genre concepts across:
//   - Edit Preferences chip list  (app/edit-preferences.tsx)
//   - Onboarding intake chips     (components/RecEntryScreen.tsx)
//   - tasteProfile genre-affinity / subject blending (lib/tasteProfile.ts)
//   - (P0A.1) recommender retrieval-side subject mapping
//
// Adding a chip without a corresponding GenreDef is a typecheck failure
// because chip lists are derived from EDIT_GENRE_IDS / INTAKE_FICTION_IDS /
// INTAKE_NONFICTION_IDS, which are typed as GenreId[].
//
// ─── Background — silent-drop bug class fixed by P0A ───
// Pre-P0A, three independent label sets coexisted:
//   1. app/edit-preferences.tsx GENRES (flat 18-label list)
//   2. components/RecEntryScreen.tsx FICTION_GENRES + NONFICTION_GENRES
//      (different label spellings, e.g. "Science & Nature" vs "Science")
//   3. lib/tasteProfile.ts GENRE_AFFINITY_MAP / GENRE_SUBJECTS_MAP
//      (only covered the intake-shaped labels).
// Result: six edit-preferences labels — History, Biography, Business,
// Science, Poetry, Classic — saved into reader_preferences.favorite_genres
// but were silently dropped when tasteProfile blended them in for tier 0/1
// users (the `if (key)` guard at lib/tasteProfile.ts:782 quietly skipped any
// label without an exact map entry).
//
// P0A makes alias resolution authoritative: every legacy label normalizes
// to a canonical GenreDef, every chip list is derived from the taxonomy,
// and tasteProfile consumes normalizeGenreInput() instead of indexing a
// local map. Misses are surfaced via the dev warning channel rather than
// silent no-ops (see lib/taxonomy/normalize.ts).
//
// ─── Scope note ───
// P0A does NOT solve tier-2+ explicit-preference responsiveness. The tier
// gate at lib/tasteProfile.ts:776 (`if (tier <= 1 && ...)`) zeroes mapped
// prefs entirely for higher-tier users; that ships in P1 (signal contract)
// + P2 (branch planner). Do not spot-patch by widening the gate here.
// =============================================================================

/** Affinity bucket consumed by recommender scoring. */
export type AffinityKey =
  | 'literary'
  | 'fantasy_scifi'
  | 'thriller_mystery'
  | 'romance'
  | 'horror'
  | 'memoir_bio'
  | 'nonfiction';

export type Fictionality = 'fiction' | 'nonfiction' | 'both';

export type GenreDef = {
  /** Stable canonical id. Never displayed; safe to reference from code. */
  id: string;
  /**
   * User-facing labels per surface. A surface that doesn't render this
   * concept omits its key. Edit and intake labels may differ when the
   * legacy chip lists used different spellings (we preserve both, since
   * users may already have either spelling stored in
   * reader_preferences.favorite_genres / avoid_genres).
   */
  uiLabels: {
    edit?: string;
    intake?: string;
    cardTag?: string;
  };
  /**
   * Normalization-only inputs. Every uiLabels entry is implicitly an alias
   * (no need to repeat). Add legacy or alternate spellings here so saved
   * DB rows resolve cleanly. Match is case-insensitive + whitespace-normalized.
   */
  aliasInputs: string[];
  affinityKey: AffinityKey;
  /**
   * Open Library subject seeds used by tasteProfile to derive
   * blendedLikedSubjects for tier-0 cold start. Recommender retrieval-side
   * consumption ships in P0A.1.
   */
  olSubjects: string[];
  fictionality: Fictionality;
};

// ─── Canonical defs ──────────────────────────────────────────────────────────
// Order within this array is irrelevant — chip rendering uses the explicit
// ID arrays below.

const _DEFS = [
  {
    id: 'literary_fiction',
    uiLabels: { edit: 'Literary Fiction', intake: 'Literary Fiction', cardTag: 'Literary' },
    aliasInputs: [],
    affinityKey: 'literary',
    olSubjects: ['literary fiction', 'contemporary fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'fantasy',
    uiLabels: { edit: 'Fantasy', intake: 'Fantasy', cardTag: 'Fantasy' },
    aliasInputs: ['epic fantasy'],
    affinityKey: 'fantasy_scifi',
    olSubjects: ['fantasy', 'epic fantasy', 'fantasy fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'sci_fi',
    uiLabels: { edit: 'Sci-Fi', intake: 'Sci-Fi', cardTag: 'Sci-Fi' },
    aliasInputs: ['Science Fiction', 'Sci-fi & fantasy', 'Sci Fi', 'SciFi'],
    affinityKey: 'fantasy_scifi',
    olSubjects: ['science fiction', 'space opera', 'speculative fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'mystery',
    uiLabels: { edit: 'Mystery', intake: 'Mystery', cardTag: 'Mystery' },
    aliasInputs: [],
    affinityKey: 'thriller_mystery',
    olSubjects: ['mystery', 'detective fiction', 'crime fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'thriller',
    uiLabels: { edit: 'Thriller', intake: 'Thriller', cardTag: 'Thriller' },
    aliasInputs: [],
    affinityKey: 'thriller_mystery',
    olSubjects: ['thriller', 'psychological thriller', 'suspense fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'romance',
    uiLabels: { edit: 'Romance', intake: 'Romance', cardTag: 'Romance' },
    aliasInputs: [],
    affinityKey: 'romance',
    olSubjects: ['romance', 'contemporary romance', 'romantic fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'horror',
    uiLabels: { edit: 'Horror', intake: 'Horror', cardTag: 'Horror' },
    aliasInputs: [],
    affinityKey: 'horror',
    olSubjects: ['horror', 'supernatural fiction', 'gothic fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'historical_fiction',
    uiLabels: { edit: 'Historical Fiction', intake: 'Historical Fiction', cardTag: 'Historical' },
    aliasInputs: [],
    affinityKey: 'literary',
    olSubjects: ['historical fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'young_adult',
    uiLabels: { edit: 'Young Adult', intake: 'Young Adult', cardTag: 'YA' },
    aliasInputs: ['YA'],
    affinityKey: 'literary',
    olSubjects: ['young adult fiction'],
    fictionality: 'fiction',
  },
  {
    id: 'graphic_novel',
    uiLabels: { edit: 'Graphic Novel', cardTag: 'Graphic Novel' },
    aliasInputs: ['Graphic Novels', 'Comics'],
    affinityKey: 'literary',
    olSubjects: ['graphic novels', 'comics'],
    fictionality: 'fiction',
  },
  {
    id: 'classic',
    uiLabels: { edit: 'Classic', cardTag: 'Classic' },
    aliasInputs: ['Classics', 'Classic Literature'],
    affinityKey: 'literary',
    olSubjects: ['classics', 'classic literature'],
    fictionality: 'fiction',
  },
  {
    id: 'poetry',
    uiLabels: { edit: 'Poetry', cardTag: 'Poetry' },
    aliasInputs: [],
    affinityKey: 'literary',
    olSubjects: ['poetry'],
    fictionality: 'both',
  },
  {
    id: 'nonfiction_general',
    uiLabels: { edit: 'Non-Fiction', cardTag: 'Non-Fiction' },
    aliasInputs: ['Nonfiction', 'Non Fiction'],
    affinityKey: 'nonfiction',
    olSubjects: ['popular nonfiction', 'popular science'],
    fictionality: 'nonfiction',
  },
  {
    id: 'biography_memoir',
    uiLabels: { edit: 'Biography', intake: 'Biography & Memoir', cardTag: 'Memoir' },
    aliasInputs: ['Memoir', 'Autobiography', 'Biography & Memoir'],
    affinityKey: 'memoir_bio',
    olSubjects: ['biography', 'autobiography', 'memoir'],
    fictionality: 'nonfiction',
  },
  {
    id: 'history',
    uiLabels: { edit: 'History', intake: 'History', cardTag: 'History' },
    aliasInputs: ['World History'],
    affinityKey: 'nonfiction',
    olSubjects: ['history', 'world history'],
    fictionality: 'nonfiction',
  },
  {
    id: 'science',
    uiLabels: { edit: 'Science', intake: 'Science & Nature', cardTag: 'Science' },
    aliasInputs: ['Science & Nature', 'Popular Science', 'Nature'],
    affinityKey: 'nonfiction',
    olSubjects: ['science', 'popular science', 'nature'],
    fictionality: 'nonfiction',
  },
  {
    id: 'essays_ideas',
    uiLabels: { intake: 'Essays & Ideas', cardTag: 'Essays' },
    aliasInputs: ['Essays', 'Philosophy', 'Essays & Ideas'],
    affinityKey: 'nonfiction',
    olSubjects: ['essays', 'philosophy'],
    fictionality: 'nonfiction',
  },
  {
    id: 'self_help',
    uiLabels: { edit: 'Self-Help', intake: 'Self-Help', cardTag: 'Self-Help' },
    aliasInputs: ['Self Help', 'Personal Development'],
    affinityKey: 'nonfiction',
    olSubjects: ['self-help', 'personal development'],
    fictionality: 'nonfiction',
  },
  {
    id: 'business',
    uiLabels: { edit: 'Business', intake: 'Business', cardTag: 'Business' },
    aliasInputs: ['Economics'],
    affinityKey: 'nonfiction',
    olSubjects: ['business', 'economics'],
    fictionality: 'nonfiction',
  },
  {
    id: 'true_crime',
    uiLabels: { intake: 'True Crime', cardTag: 'True Crime' },
    aliasInputs: ['True Crime'],
    affinityKey: 'thriller_mystery',
    olSubjects: ['true crime'],
    fictionality: 'nonfiction',
  },
  {
    id: 'politics_society',
    uiLabels: { intake: 'Politics & Society', cardTag: 'Politics' },
    aliasInputs: ['Politics', 'Social Science', 'Politics & Society'],
    affinityKey: 'nonfiction',
    olSubjects: ['politics', 'social science'],
    fictionality: 'nonfiction',
  },
] as const satisfies readonly GenreDef[];

export type GenreId = (typeof _DEFS)[number]['id'];

export const GENRE_DEFS: readonly GenreDef[] = _DEFS;

// ─── Surface-specific ordered ID lists ───────────────────────────────────────
// These determine chip render order. Typed as GenreId[] so a typo or removed
// def fails typecheck.

/** Edit Preferences chip list (Reading Taste editor). Order preserved from
 * the pre-P0A flat GENRES array. */
export const EDIT_GENRE_IDS: readonly GenreId[] = [
  'literary_fiction',
  'fantasy',
  'sci_fi',
  'mystery',
  'thriller',
  'romance',
  'horror',
  'historical_fiction',
  'nonfiction_general',
  'history',
  'biography_memoir',
  'self_help',
  'business',
  'science',
  'poetry',
  'graphic_novel',
  'young_adult',
  'classic',
];

/** Onboarding intake fiction chips. Order preserved from FICTION_GENRES. */
export const INTAKE_FICTION_IDS: readonly GenreId[] = [
  'literary_fiction',
  'fantasy',
  'sci_fi',
  'thriller',
  'mystery',
  'romance',
  'horror',
  'historical_fiction',
  'young_adult',
];

/** Onboarding intake nonfiction chips. Order preserved from NONFICTION_GENRES. */
export const INTAKE_NONFICTION_IDS: readonly GenreId[] = [
  'biography_memoir',
  'history',
  'science',
  'essays_ideas',
  'self_help',
  'business',
  'true_crime',
  'politics_society',
];

// ─── Lookups ─────────────────────────────────────────────────────────────────

const _BY_ID: Map<GenreId, GenreDef> = new Map(
  GENRE_DEFS.map((d) => [d.id as GenreId, d]),
);

export function getGenreById(id: GenreId): GenreDef {
  const def = _BY_ID.get(id);
  if (!def) {
    // Unreachable under type system; defensive throw for runtime safety.
    throw new Error(`[taxonomy] unknown GenreId: ${id}`);
  }
  return def;
}

/** Convenience: rendered label for a surface, with safe fallback. */
export function editLabel(id: GenreId): string {
  const d = getGenreById(id);
  return d.uiLabels.edit ?? d.uiLabels.intake ?? d.id;
}

export function intakeLabel(id: GenreId): string {
  const d = getGenreById(id);
  return d.uiLabels.intake ?? d.uiLabels.edit ?? d.id;
}

// =============================================================================
// Retrieval-side anchors (P0A.1)
//
// Open Library subject anchors used by lib/recommender.ts during candidate
// retrieval (the "Standard multi-anchor retrieval" branch). These are
// intentionally **specific** strings ("epic fantasy", not "fantasy") chosen
// to avoid classic / public-domain drift in OL search — see the historical
// comment that lived above GENRE_OL_SUBJECTS in recommender.ts pre-P0A.1.
//
// Keyed by AffinityKey rather than GenreId because retrieval operates on the
// affinity bucket (multiple GenreDefs share an affinity, e.g. `fantasy` and
// `sci_fi` both → `fantasy_scifi`). The 'general' bucket is a non-affinity
// fallback used when a user has zero rated genres and no trait priors.
//
// **Strings preserved verbatim from the pre-P0A.1 GENRE_OL_SUBJECTS map.**
// They are *not* derived from GenreDef.olSubjects because the two concepts
// serve different purposes:
//   - GenreDef.olSubjects feeds tier-0 cold-start `liked_subjects` seeding
//     in tasteProfile (broad coverage, fed into local scoring).
//   - AFFINITY_RETRIEVAL_SUBJECTS feeds the OL `subject:` query string
//     (tight, drift-resistant, optimized for the OL corpus).
// Conflating them would either over-broaden retrieval or under-seed
// tasteProfile. Keep them deliberately distinct.
//
// Dense-import retrieval (DENSE_LANE_OL_SUBJECTS in recommender.ts) is
// **not** folded here: half of those keys (romantasy, contemporary_fiction,
// modern_suspense, memoir_nonfiction) are DeterministicLane concepts from
// lib/bookTraits.ts that don't have a 1:1 GenreDef. Forcing them into the
// genre taxonomy would be a leaky abstraction — see P0A.1 stop conditions.
// =============================================================================

export type RetrievalAffinityKey = AffinityKey | 'general';

export const AFFINITY_RETRIEVAL_SUBJECTS: Record<RetrievalAffinityKey, readonly [string, string]> = {
  fantasy_scifi:    ['epic fantasy',           'dystopian fiction'],
  thriller_mystery: ['psychological thriller', 'crime fiction'],
  romance:          ['contemporary romance',   'romance fiction'],
  horror:           ['horror fiction',         'psychological horror'],
  memoir_bio:       ['personal memoirs',       'biography'],
  nonfiction:       ['popular science',        'popular nonfiction'],
  literary:         ['literary fiction',       'contemporary literary fiction'],
  general:          ['contemporary fiction',   'popular fiction'],
};

/** Lookup with a guaranteed `general` fallback for unknown keys. The pre-P0A.1
 *  call site used `?? ['contemporary fiction', 'popular fiction']`; this
 *  preserves identical behavior. */
export function getRetrievalSubjects(key: string): readonly [string, string] {
  if (Object.hasOwn(AFFINITY_RETRIEVAL_SUBJECTS, key)) {
    return AFFINITY_RETRIEVAL_SUBJECTS[key as RetrievalAffinityKey];
  }
  return AFFINITY_RETRIEVAL_SUBJECTS.general;
}
