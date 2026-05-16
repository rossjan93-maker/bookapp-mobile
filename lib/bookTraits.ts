// =============================================================================
// Book Traits — deterministic extraction of measurable attributes
//
// Given available book metadata, returns:
//   - primaryGenre : best-guess genre key, or null
//   - bookForm     : detected prose form (poetry / short_stories / play / etc.)
//   - genres       : list of genre keys
//   - traits       : Record<TraitName, 0.0–1.0 signal strength>
//
// Design rules:
//   1. Book FORM is detected first and restricts which traits are valid.
//      Poetry cannot receive Characters/Ending/Pacing — those traits are
//      prose-specific and produce nonsensical explanations.
//   2. Genre base traits are only applied for prose books (bookForm == null).
//      If a form is detected, form-specific trait bases take precedence.
//   3. Each base trait is a "ceiling", not a guarantee — page-count and
//      metadata adjustments can push values up or down within [0, 1].
// =============================================================================

// ── Book form ─────────────────────────────────────────────────────────────────

export type BookForm =
  | 'poetry'
  | 'short_stories'
  | 'play'
  | 'graphic'
  | 'anthology';

export type BookTraits = {
  primaryGenre: string | null;
  bookForm:     BookForm | null;
  genres:       string[];
  traits:       Record<string, number>;
};

// ── Form detection signals ────────────────────────────────────────────────────

const POETRY_SIGNALS = [
  'poetry', 'poems', 'poem', 'poet', 'verse', 'verses', 'sonnet', 'sonnets',
  'haiku', 'ode', 'odes', 'ballad', 'ballads', 'lyric poetry', 'epic poem',
  'collected poems', 'selected poems', 'complete poems',
];

const SHORT_STORY_SIGNALS = [
  'short stories', 'short story', 'short fiction', 'novellas', 'novella',
  'tale collection', 'tales collection',
  // NOTE: bare 'stories' intentionally omitted — it matches too many OL subject
  // tags (e.g. "Legal stories, American", "Fiction—stories") and causes
  // novels like To Kill a Mockingbird to be misclassified.
];

const PLAY_SIGNALS = [
  'drama', 'plays', 'theater', 'theatre', 'screenplay', 'script', 'stage play',
  'dramatic works',
];

const GRAPHIC_SIGNALS = [
  // NOTE: bare 'comic' intentionally omitted — it matches the very common OL
  // tag "Comic books, strips, etc." as a substring and fires on prose books
  // (e.g. Parable of the Sower) that happen to receive that OL classification.
  // Use the more specific 'comics', 'comic book', 'comic strip' instead.
  'comics', 'graphic novel', 'manga', 'illustrated novel',
  'sequential art', 'comic book', 'comic strip',
];

const ANTHOLOGY_SIGNALS = [
  'anthology', 'collected works', 'selected works', 'complete works',
  'complete collection',
];

export function detectBookForm(book: {
  subjects?:    string[] | null;
  title?:       string | null;
  description?: string | null;
}): BookForm | null {
  const corpus = [
    ...(book.subjects ?? []),
    book.title ?? '',
  ].join(' ').toLowerCase();

  if (POETRY_SIGNALS.some(s => corpus.includes(s)))      return 'poetry';
  if (PLAY_SIGNALS.some(s => corpus.includes(s)))         return 'play';
  if (GRAPHIC_SIGNALS.some(s => corpus.includes(s)))      return 'graphic';
  if (ANTHOLOGY_SIGNALS.some(s => corpus.includes(s)))    return 'anthology';
  if (SHORT_STORY_SIGNALS.some(s => corpus.includes(s)))  return 'short_stories';
  return null;
}

// ── Traits that are NOT applicable for a given form ───────────────────────────
// Any trait in this set is zeroed-out / removed from inference for that form,
// preventing nonsensical explanations like "characters" for a poetry collection.

const FORM_TRAIT_BLACKLIST: Record<BookForm, Set<string>> = {
  poetry: new Set([
    'Characters', 'Ending', 'Twists', 'Plot', 'Pacing', 'Tension',
    'Suspense', 'Worldbuilding', 'Scope', 'Chemistry', 'Emotional payoff',
    'Evidence', 'Clarity', 'Practicality', 'Structure',
  ]),
  play: new Set([
    'Pacing', 'Worldbuilding', 'Scope', 'Twists', 'Evidence',
    'Clarity', 'Practicality', 'Chemistry', 'Emotional payoff',
  ]),
  short_stories: new Set(['Scope', 'Worldbuilding']),
  graphic: new Set([
    'Prose', 'Insight', 'Evidence', 'Clarity', 'Practicality',
    'Structure', 'Depth', 'Scope',
  ]),
  anthology: new Set(['Pacing', 'Twists', 'Tension', 'Suspense', 'Chemistry', 'Emotional payoff']),
};

// ── Form-specific trait base (replaces genre base entirely for that form) ─────
const FORM_TRAIT_BASE: Partial<Record<BookForm, Record<string, number>>> = {
  poetry: {
    Prose:        0.90,
    Originality:  0.82,
    Writing:      0.88,
    Depth:        0.72,
    Atmosphere:   0.68,
    Emotional:    0.72,
  },
  play: {
    Characters:   0.85,
    Atmosphere:   0.80,
    Tension:      0.72,
    Depth:        0.68,
    Writing:      0.72,
    Originality:  0.65,
    Ending:       0.62,
  },
  graphic: {
    Atmosphere:   0.82,
    Pacing:       0.72,
    Characters:   0.75,
    Originality:  0.68,
    Tension:      0.65,
    Ending:       0.58,
  },
  anthology: {
    Writing:      0.80,
    Originality:  0.72,
    Depth:        0.65,
    Prose:        0.70,
    Atmosphere:   0.60,
    Characters:   0.60,
  },
};

// ── Genre detection signals (ordered by specificity — first match wins) ────────

// Order is load-bearing: first-match wins inside detectGenre().
//
// History of this list:
//   1. Original: memoir_bio → nonfiction → horror → romance → thriller →
//      fantasy_scifi → literary. With `corpus.includes()` substring
//      matching this leaked fiction books into nonfiction because the
//      nonfiction signal list contained broad single tokens (`science`,
//      `history`, `psychology`, `philosophy`, `technology`, `sociology`)
//      that appear inside fiction subjects (`science fiction`,
//      `historical fiction`, `psychological thriller`, `Greek mythology
//      / ancient history`, `psychology of grief`). This was the Scenario
//      B P3A live-smoke blocker.
//
//   2. Two complementary changes close the leak:
//      (a) detectGenre() switched from `includes()` to pre-compiled
//          word-boundary regex (`\b<token>\b`, case-insensitive) — see
//          GENRE_SIGNAL_MATCHERS below. This is the documented Gotcha in
//          replit.md ("word-boundary regex, never includes()").
//      (b) The broad single tokens were pruned from the nonfiction list.
//          Coverage of those domains is preserved via unambiguous
//          compound forms (`popular science`, `science nonfiction`,
//          `pop history`, etc.) plus the umbrella `nonfiction` /
//          `non-fiction` tokens that genuine nonfiction subjects nearly
//          always carry.
//
//   3. Bucket order: memoir_bio → nonfiction → fiction buckets →
//      literary. The user-supplied spec recommended putting `nonfiction`
//      LAST, but the architect surfaced a regression on mixed-tag true
//      nonfiction — e.g. `['true crime','mystery','nonfiction']` or
//      `['political thriller','nonfiction']` — where the fiction bucket
//      fires first and traps a book that is clearly nonfiction by its
//      `nonfiction` anchor tag. The spec explicitly permitted deviation
//      ("If you choose a different order, justify it.") and the prune
//      in (2b) makes nonfiction-second safe: every remaining signal in
//      the nonfiction list now requires either the literal `nonfiction`
//      / `non-fiction` token or an unambiguous compound nonfiction
//      string (`popular science`, `true crime`, etc.), none of which
//      appear inside fiction subjects under word-boundary matching.
export const GENRE_SIGNALS: Array<[string, string[]]> = [
  ['memoir_bio',       ['memoir', 'autobiography', 'biography', 'biographical']],
  ['nonfiction',       ['nonfiction', 'non-fiction', 'self-help', 'business', 'economics',
                        'politics', 'true crime', 'popular science', 'pop science',
                        'science nonfiction', 'popular nonfiction', 'public policy',
                        'history nonfiction', 'pop history', 'narrative nonfiction',
                        'creative nonfiction', 'investigative journalism']],
  ['fantasy_scifi',    ['fantasy', 'science fiction', 'sci-fi', 'speculative fiction',
                        'dystopian', 'magical realism', 'space opera', 'epic fantasy',
                        'urban fantasy', 'alternate history']],
  ['thriller_mystery', ['thriller', 'mystery', 'crime fiction', 'detective', 'suspense',
                        'noir', 'whodunit', 'spy fiction']],
  ['romance',          ['romance', 'romantic fiction', 'love story', "women's fiction", 'chick lit']],
  ['horror',           ['horror', 'gothic', 'ghost story', 'supernatural', 'occult',
                        'vampire', 'zombie']],
  ['literary',         ['literary fiction', 'literary', 'contemporary fiction']],
];

// Pre-compiled word-boundary matchers for each signal. Compiled once at
// module load (not per-detectGenre call) so the hot scoring path stays
// allocation-free. `\b` works at the boundary between a word character
// (`[A-Za-z0-9_]`) and a non-word character, so multi-word signals like
// `"science fiction"` and hyphenated signals like `"non-fiction"` still
// match cleanly (the hyphen is a non-word char, the boundary lands on
// each word's edges).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const GENRE_SIGNAL_MATCHERS: Array<[string, RegExp[]]> = GENRE_SIGNALS.map(
  ([genre, signals]) => [
    genre,
    signals.map(s => new RegExp(`\\b${escapeRegex(s)}\\b`, 'i')),
  ],
);

// ── Base trait scores per genre ───────────────────────────────────────────────
//
// These are genre-level priors — how strongly a given trait typically features
// in that genre. Individual books will vary; these are starting estimates only.
//
// 0.9 = defining feature,  0.5 = moderate presence,  0 = absent / inapplicable.

const GENRE_TRAIT_BASE: Record<string, Record<string, number>> = {
  fantasy_scifi: {
    Worldbuilding: 0.90, Atmosphere: 0.82, Scope: 0.88, Originality: 0.76,
    Characters:    0.72, Pacing:      0.58, Tension: 0.65, Ending: 0.65,
  },
  thriller_mystery: {
    Suspense: 0.92, Pacing: 0.86, Twists: 0.88, Tension: 0.88,
    Plot:     0.85, Characters: 0.60, Atmosphere: 0.72, Ending: 0.78,
  },
  romance: {
    Chemistry: 0.92, 'Emotional payoff': 0.88, Characters: 0.82, Tension: 0.72,
    Ending:    0.82, Pacing: 0.62, Writing: 0.65, Depth: 0.52,
  },
  horror: {
    Atmosphere: 0.92, Tension: 0.88, Suspense: 0.82, Pacing: 0.70,
    Characters: 0.60, Originality: 0.65, Ending: 0.65, Worldbuilding: 0.58,
  },
  memoir_bio: {
    Honesty: 0.92, Perspective: 0.92, Insight: 0.88, Writing: 0.72,
    Depth:   0.82, Structure: 0.65, Pacing: 0.52,
  },
  nonfiction: {
    Insight: 0.92, Evidence: 0.88, Clarity: 0.85, Structure: 0.78,
    Depth:   0.78, Practicality: 0.72, Originality: 0.65, Writing: 0.62,
  },
  literary: {
    Prose: 0.92, Characters: 0.88, Emotional: 0.82, Depth: 0.88,
    Atmosphere: 0.78, Originality: 0.78, Pacing: 0.48, Ending: 0.68,
  },
  general: {
    Pacing: 0.60, Characters: 0.60, Writing: 0.55,
    Atmosphere: 0.52, Ending: 0.52, Originality: 0.50,
  },
};

// ── Genre detection ────────────────────────────────────────────────────────────

export function detectGenre(book: {
  subjects?: string[] | null;
  title?: string | null;
  author?: string | null;
}): string | null {
  // Word-boundary matching, not substring. Substring matching is the
  // documented Gotcha in replit.md and was the root cause of the
  // Scenario B P3A live-smoke blocker — `'history'` matching inside
  // `'historical fiction'`, `'science'` matching inside
  // `'science fiction'`, etc. See GENRE_SIGNAL_MATCHERS above.
  const corpus = [
    ...(book.subjects ?? []),
    book.title  ?? '',
    book.author ?? '',
  ].join(' ');

  for (const [genre, matchers] of GENRE_SIGNAL_MATCHERS) {
    if (matchers.some(re => re.test(corpus))) return genre;
  }
  return null;
}

// ── Page-count adjustments ─────────────────────────────────────────────────────

function applyPageCount(
  traits:    Record<string, number>,
  pageCount: number | null | undefined,
): Record<string, number> {
  if (!pageCount || pageCount <= 0) return traits;
  const t = { ...traits };

  if (pageCount > 600) {
    if (t.Scope         !== undefined) t.Scope         = Math.min(1, t.Scope         + 0.10);
    if (t.Worldbuilding !== undefined) t.Worldbuilding = Math.min(1, t.Worldbuilding + 0.08);
    if (t.Pacing        !== undefined) t.Pacing        = Math.max(0, t.Pacing        - 0.12);
    if (t.Depth         !== undefined) t.Depth         = Math.min(1, t.Depth         + 0.08);
  } else if (pageCount < 250) {
    if (t.Pacing !== undefined) t.Pacing = Math.min(1, t.Pacing + 0.12);
    if (t.Scope  !== undefined) t.Scope  = Math.max(0, t.Scope  - 0.10);
  }

  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +v.toFixed(2)]));
}

// ── Metadata quality assessment ────────────────────────────────────────────────

export function assessMetadataQuality(book: {
  subjects?:    string[] | null;
  description?: string | null;
  page_count?:  number | null;
}): 'strong' | 'moderate' | 'weak' {
  const subjectCount  = (book.subjects ?? []).length;
  const hasDescription = (book.description ?? '').trim().length > 80;
  const hasPageCount   = (book.page_count ?? 0) > 0;

  const signals = (subjectCount >= 5 ? 2 : subjectCount >= 2 ? 1 : 0)
    + (hasDescription ? 2 : 0)
    + (hasPageCount   ? 1 : 0);

  if (signals >= 4) return 'strong';
  if (signals >= 2) return 'moderate';
  return 'weak';
}

// ── Deterministic reading lane types ──────────────────────────────────────────
// Used by the dense-import engine to build and compare user reading patterns.
// A "lane" is a meaningful cluster of repeated reading behaviour, coarser than
// genre (romantasy bundles fantasy + romance elements; modern_suspense bundles
// domestic thrillers, psychological thrillers, and contemporary mysteries).

export type DeterministicLane =
  | 'romantasy'            // fantasy × romance / emotional fantasy series
  | 'contemporary_fiction' // book-club women's fiction / contemporary emotional
  | 'modern_suspense'      // psychological thriller / domestic thriller / puzzle mystery
  | 'memoir_nonfiction'    // memoir / autobiography / narrative nonfiction
  | 'literary'             // literary fiction with craft/prose focus
  | 'scifi_fantasy'        // epic/spec fantasy, science fiction (no romance element)
  | 'romance'              // contemporary or historical romance (no fantasy element)
  | 'horror';              // horror / dark supernatural

export type MysterySubtype =
  | 'contemporary_thriller' // psychological thriller, domestic thriller, modern suspense
  | 'puzzle_detective'      // cozy, whodunit, amateur detective, classic puzzle
  | 'hard_boiled_noir'      // noir, hard-boiled, private detective (Chandler style)
  | 'spy_adventure';        // espionage / spy / secret-agent thriller (Fleming, le Carré)

// ── Lane detection for a single book ─────────────────────────────────────────
// Priority order: romantasy → scifi_fantasy → modern_suspense → romance →
//   memoir_nonfiction → literary → contemporary_fiction → horror
// Returns null when there is insufficient subject signal to classify.

export function detectBookLane(book: {
  subjects?: string[] | null;
  title?:    string | null;
  author?:   string | null;
}): DeterministicLane | null {
  const corpus = [
    ...(book.subjects ?? []),
    book.title  ?? '',
    book.author ?? '',
  ].join(' ').toLowerCase();

  const has = (...terms: string[]) => terms.some(t => corpus.includes(t));

  const hasFantasy  = has('fantasy', 'magic', 'fae', 'fey', 'romantasy', 'dragons', 'witch', 'sorcerer', 'spellbinding');
  const hasRomance  = has('romance', 'romantic', 'love story', 'chick lit', "women's fiction", 'contemporary romance', 'historical romance', 'love interest');
  const hasSeries   = has('series', 'trilogy', 'book 1', 'book 2');

  // Romantasy: fantasy + romance elements co-present
  if (hasFantasy && hasRomance) return 'romantasy';
  // Strong series fantasy (like Maas, Hobb) without romance subjects
  if (hasFantasy && has('epic fantasy', 'high fantasy', 'sword', 'realm', 'kingdom', 'elves', 'orcs')) return 'scifi_fantasy';
  if (hasFantasy) return 'scifi_fantasy';

  // Science fiction / speculative
  if (has('science fiction', 'sci-fi', 'sci fi', 'dystopian', 'speculative fiction', 'space opera', 'cyberpunk', 'alternate history')) return 'scifi_fantasy';

  // Hard-boiled noir — check before generic modern_suspense
  if (has('hard-boiled', 'hard boiled', 'noir', 'private detective', 'private investigator', 'pulp fiction')) return 'modern_suspense';

  // Thriller / suspense family
  if (has('psychological thriller', 'domestic thriller', 'psychological suspense', 'suspense fiction', 'legal thriller', 'medical thriller')) return 'modern_suspense';
  if (has('mystery fiction', 'mystery thriller', 'crime thriller', 'whodunit', 'cozy mystery', 'amateur detective')) return 'modern_suspense';
  if (has('thriller') && !has('historical thriller', 'literary thriller')) return 'modern_suspense';

  // Romance (no fantasy)
  if (hasRomance) return 'romance';

  // Memoir / narrative nonfiction
  if (has('memoir', 'autobiography', 'personal memoir', 'narrative nonfiction', 'creative nonfiction', 'personal narrative', 'autobiographical')) return 'memoir_nonfiction';
  if (has('biography') && !has('political biography', 'scientific biography')) return 'memoir_nonfiction';

  // Literary (strong signal required — not just "fiction" or "contemporary fiction")
  if (has('literary fiction', 'literary novel', 'literary thriller', 'man booker', 'booker prize', 'national book award')) return 'literary';

  // Contemporary fiction / book club
  if (has('book club', 'book-club', 'contemporary fiction', 'domestic fiction', 'general fiction', 'popular fiction')) return 'contemporary_fiction';
  if (hasSeries && has('fiction')) return 'contemporary_fiction';

  // Horror
  if (has('horror', 'supernatural horror', 'gothic horror', 'occult', 'paranormal')) return 'horror';

  return null;
}

// ── Mystery subtype detection for a book ─────────────────────────────────────
// Used in scoring to penalise hard-boiled/noir books for contemporary-thriller
// oriented users (Horowitz/Foley reader ≠ Chandler reader).

export function detectBookMysterySubtype(book: {
  subjects?: string[] | null;
  title?:    string | null;
}): MysterySubtype | null {
  const corpus = [
    ...(book.subjects ?? []),
    book.title ?? '',
  ].join(' ').toLowerCase();

  const has = (...terms: string[]) => terms.some(t => corpus.includes(t));

  // Spy / espionage detected first — these are distinct from domestic thriller
  if (has('espionage', 'spy fiction', 'secret service', 'intelligence service', 'cold war spy',
          'james bond', 'spy thriller', 'spy novel', 'spies')) return 'spy_adventure';
  if (has('hard-boiled', 'hard boiled', 'noir', 'private detective', 'private investigator', 'pulp fiction')) return 'hard_boiled_noir';
  if (has('cozy mystery', 'cozy', 'amateur detective', 'whodunit', 'puzzle mystery', 'classic detective', 'village mystery')) return 'puzzle_detective';
  if (has('psychological thriller', 'domestic thriller', 'psychological suspense')) return 'contemporary_thriller';
  if (has('thriller') && !has('historical', 'literary', 'espionage', 'spy')) return 'contemporary_thriller';
  if (has('mystery') && has('contemporary', 'modern', 'current')) return 'contemporary_thriller';
  return null;
}

// ── Philosophy / spiritual detection ──────────────────────────────────────────
// Used to penalise philosophy / spiritual drift for readers whose primary lane
// is memoir or commercial fiction (biography ≠ philosophy; autobiography ≠ yoga).

export function isPhilosophyOrSpiritual(book: {
  subjects?: string[] | null;
  title?:    string | null;
}): boolean {
  const corpus = [
    ...(book.subjects ?? []),
    book.title ?? '',
  ].join(' ').toLowerCase();

  const has = (...terms: string[]) => terms.some(t => corpus.includes(t));

  return has(
    'philosophy', 'philosophical', 'phenomenology', 'metaphysics',
    'existentialism', 'ethics', 'epistemology',
    'spiritual', 'spirituality', 'meditation', 'yoga', 'mindfulness',
    'hinduism', 'buddhism', 'zen', 'taoism', 'sufism', 'theosophy',
    'eastern philosophy', 'western philosophy', 'self-realization',
    'autobiography of a yogi',
  );
}

// ── Main extractor ─────────────────────────────────────────────────────────────

export function getBookTraits(book: {
  subjects?:    string[] | null;
  title?:       string | null;
  author?:      string | null;
  page_count?:  number | null;
  description?: string | null;
}): BookTraits {
  const primaryGenre = detectGenre(book);
  const bookForm     = detectBookForm(book);

  let traits: Record<string, number>;

  if (bookForm && FORM_TRAIT_BASE[bookForm]) {
    // Form-specific base takes full precedence — do not mix in genre base
    traits = { ...FORM_TRAIT_BASE[bookForm]! };
  } else {
    // Genre-driven base for standard prose books
    const base = GENRE_TRAIT_BASE[primaryGenre ?? 'general'] ?? GENRE_TRAIT_BASE.general;
    traits = { ...base };

    // Remove any traits that are blacklisted for this form
    if (bookForm && FORM_TRAIT_BLACKLIST[bookForm]) {
      for (const banned of FORM_TRAIT_BLACKLIST[bookForm]) {
        delete traits[banned];
      }
    }

    traits = applyPageCount(traits, book.page_count);
  }

  return {
    primaryGenre,
    bookForm,
    genres: primaryGenre ? [primaryGenre] : ['general'],
    traits,
  };
}
