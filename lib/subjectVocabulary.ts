// =============================================================================
// Subject Vocabulary — curated canonical subject terms for Readstack
// =============================================================================
// This is the single source of truth for allowed subject strings in the books
// catalog.  Every term is lowercase, space-separated, and matched by the
// word-boundary regex in lib/shelves.ts matchesSubjects().
//
// Used by:
//   - lib/subjectInference.ts   (LLM inference prompt constraint)
//   - Future: subject validation / migration tooling
//
// Coverage:
//   Genre fiction · Non-fiction · Thematic · Audience specifiers
//
// Design rules:
//   1. Specific > generic.  "psychological thriller" over "thriller" when both apply.
//   2. No trailing punctuation, no comma-separated phrases.
//   3. Compound terms must be space-separated (e.g. "young adult fiction").
//   4. Each term maps to an unambiguous reader expectation.
// =============================================================================

export const SUBJECT_VOCABULARY = [
  // ── Genre fiction — fantasy ─────────────────────────────────────────────────
  'fantasy',
  'epic fantasy',
  'dark fantasy',
  'romantasy',
  'urban fantasy',
  'portal fantasy',
  'historical fantasy',
  'fairy tale retelling',
  'mythology',
  'folklore',
  'paranormal romance',
  'paranormal fiction',
  'supernatural fiction',

  // ── Genre fiction — science fiction ────────────────────────────────────────
  'science fiction',
  'dystopian fiction',
  'space opera',
  'cli-fi',

  // ── Genre fiction — mystery / crime ────────────────────────────────────────
  'mystery',
  'detective fiction',
  'cozy mystery',
  'noir',
  'crime fiction',
  'legal thriller',
  'medical thriller',
  'political thriller',
  'psychological thriller',
  'thriller',
  'spy fiction',
  'heist fiction',

  // ── Genre fiction — romance ────────────────────────────────────────────────
  'romance',
  'contemporary romance',
  'historical romance',
  'enemies to lovers',
  'forced proximity',

  // ── Genre fiction — horror / gothic ───────────────────────────────────────
  'horror',
  'gothic fiction',
  'body horror',

  // ── Genre fiction — other fiction ─────────────────────────────────────────
  'historical fiction',
  'literary fiction',
  'contemporary fiction',
  'magical realism',
  'adventure fiction',
  'action and adventure',
  'military fiction',
  'war fiction',
  'satire',
  'campus fiction',
  "women's fiction",
  'domestic fiction',

  // ── Audience specifiers ────────────────────────────────────────────────────
  'young adult fiction',
  'new adult fiction',
  'middle grade fiction',
  'juvenile fiction',

  // ── Non-fiction — personal narrative ──────────────────────────────────────
  'memoir',
  'autobiography',
  'biography',
  'personal memoirs',

  // ── Non-fiction — self-help / business ────────────────────────────────────
  'self-help',
  'personal development',
  'motivational',
  'business',
  'entrepreneurship',
  'leadership',
  'finance',
  'economics',

  // ── Non-fiction — knowledge ───────────────────────────────────────────────
  'psychology',
  'cognitive science',
  'behavioral science',
  'neuroscience',
  'sociology',
  'philosophy',
  'political science',
  'history',
  'social history',
  'world history',
  'american history',
  'science',
  'popular science',
  'natural history',
  'medicine',
  'health and wellness',
  'nutrition',
  'spirituality',
  'religion',
  'mindfulness',

  // ── Non-fiction — culture / lifestyle ────────────────────────────────────
  'true crime',
  'cooking',
  'food and drink',
  'travel',
  'humor',
  'journalism',
  'literary criticism',
  'cultural criticism',
  'education',
  'parenting',

  // ── Themes ────────────────────────────────────────────────────────────────
  'coming of age',
  'family drama',
  'friendship',
  'lgbtq+ fiction',
  'grief and loss',
  'survival',
  'redemption',
] as const;

export type SubjectTerm = (typeof SUBJECT_VOCABULARY)[number];

/** Set for O(1) membership checks during LLM output validation. */
export const SUBJECT_VOCABULARY_SET = new Set<string>(SUBJECT_VOCABULARY);
