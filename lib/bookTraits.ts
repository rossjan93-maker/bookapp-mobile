// =============================================================================
// Book Traits — deterministic extraction of measurable attributes
//
// Given available book metadata, returns:
//   - primaryGenre: best-guess genre key, or null
//   - genres: list of genre keys (currently max 1)
//   - traits: Record<TraitName, 0.0–1.0 signal strength>
//
// Trait names deliberately match the chip labels in the recommendation UI
// (Pacing, Characters, Originality, etc.) so user preferences and book
// signals can be compared on the same scale without normalisation.
// =============================================================================

export type BookTraits = {
  primaryGenre: string | null;
  genres: string[];
  traits: Record<string, number>;
};

// ── Genre detection signals (ordered by specificity — first match wins) ────────

export const GENRE_SIGNALS: Array<[string, string[]]> = [
  ['memoir_bio',       ['memoir', 'autobiography', 'biography', 'biographical']],
  ['nonfiction',       ['nonfiction', 'non-fiction', 'self-help', 'business', 'economics',
                        'psychology', 'science', 'history', 'philosophy', 'technology',
                        'politics', 'sociology', 'true crime']],
  ['horror',           ['horror', 'gothic', 'ghost story', 'supernatural', 'occult',
                        'vampire', 'zombie']],
  ['romance',          ['romance', 'romantic fiction', 'love story', "women's fiction", 'chick lit']],
  ['thriller_mystery', ['thriller', 'mystery', 'crime fiction', 'detective', 'suspense',
                        'noir', 'whodunit', 'spy fiction']],
  ['fantasy_scifi',    ['fantasy', 'science fiction', 'sci-fi', 'speculative fiction',
                        'dystopian', 'magical realism', 'space opera', 'epic fantasy',
                        'urban fantasy', 'alternate history']],
  ['literary',         ['literary fiction', 'literary', 'contemporary fiction']],
];

// ── Base trait scores per genre ───────────────────────────────────────────────
//
// Scores express how prominently a given trait features in the genre on average.
// 0.9 = defining feature,  0.5 = moderate presence,  0 = absent / not applicable.

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
    Pacing: 0.70, Characters: 0.70, Writing: 0.65,
    Atmosphere: 0.60, Ending: 0.60, Originality: 0.60,
  },
};

// ── Genre detection ────────────────────────────────────────────────────────────

export function detectGenre(book: {
  subjects?: string[] | null;
  title?: string | null;
  author?: string | null;
}): string | null {
  const corpus = [
    ...(book.subjects ?? []),
    book.title  ?? '',
    book.author ?? '',
  ].join(' ').toLowerCase();

  for (const [genre, signals] of GENRE_SIGNALS) {
    if (signals.some(s => corpus.includes(s))) return genre;
  }
  return null;
}

// ── Page-count adjustments ─────────────────────────────────────────────────────

function applyPageCount(
  traits: Record<string, number>,
  pageCount: number | null | undefined,
): Record<string, number> {
  if (!pageCount || pageCount <= 0) return traits;
  const t = { ...traits };

  if (pageCount > 600) {
    if (t.Scope        !== undefined) t.Scope        = Math.min(1, t.Scope        + 0.10);
    if (t.Worldbuilding !== undefined) t.Worldbuilding = Math.min(1, t.Worldbuilding + 0.08);
    if (t.Pacing       !== undefined) t.Pacing       = Math.max(0, t.Pacing       - 0.12);
    if (t.Depth        !== undefined) t.Depth        = Math.min(1, t.Depth        + 0.08);
  } else if (pageCount < 250) {
    if (t.Pacing !== undefined) t.Pacing = Math.min(1, t.Pacing + 0.12);
    if (t.Scope  !== undefined) t.Scope  = Math.max(0, t.Scope  - 0.10);
  }

  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +v.toFixed(2)]));
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
  const base         = GENRE_TRAIT_BASE[primaryGenre ?? 'general'] ?? GENRE_TRAIT_BASE.general;
  const traits       = applyPageCount(base, book.page_count);

  return {
    primaryGenre,
    genres: primaryGenre ? [primaryGenre] : ['general'],
    traits,
  };
}
