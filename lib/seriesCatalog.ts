// ── Canonical series catalog ──────────────────────────────────────────────────
//
// Single source of truth for series structure.  Nothing in the UI or the
// recommendation pipeline may infer series membership, series total, or
// series order from any source other than this file.
//
// CONTRACT (all fields required for a series to appear here):
//   displayName   — human-readable series name shown in UI badges
//   total         — exact number of main-sequence published books
//                   (planned books in announced trilogies are included;
//                    unpublished books beyond the announced plan are NOT)
//   orderedBooks  — books shown in the series cover row, in series order.
//                   For series > 5 books, the first 5 are listed here;
//                   `total` still reflects the true series length.
//                   The cover-validation step requires every entry in
//                   orderedBooks to return a canonical single-edition cover.
//                   If any entry fails, the entire series row is hidden.
//
// DO NOT add a series unless all three fields can be filled with certainty.
// It is better to show NO series than to show an inaccurate one.

export type SeriesBook = {
  title:      string;
  author:     string;
  olCoverId?: number; // Canonical OL cover ID — looked up offline, stored to avoid runtime CORS issues
};

export type SeriesCatalogEntry = {
  displayName:  string;
  total:        number;
  orderedBooks: SeriesBook[];
};

// Keys match the `series` field in recommendationIntegrity.ts CURATED database
// exactly (including capitalisation).
const SERIES_CATALOG: Record<string, SeriesCatalogEntry> = {

  // ── Robin Hobb — Realm of the Elderlings ─────────────────────────────────
  'Farseer Trilogy': {
    displayName:  'Farseer Trilogy',
    total:        3,
    orderedBooks: [
      { title: "Assassin's Apprentice", author: 'Robin Hobb', olCoverId: 4915230 },
      { title: 'Royal Assassin',        author: 'Robin Hobb', olCoverId: 2177291 },
      { title: "Assassin's Quest",      author: 'Robin Hobb', olCoverId: 368112 },
    ],
  },

  'Liveship Traders': {
    displayName:  'Liveship Traders Trilogy',
    total:        3,
    orderedBooks: [
      { title: 'Ship of Magic',   author: 'Robin Hobb', olCoverId: 372583 },
      { title: 'Mad Ship',        author: 'Robin Hobb', olCoverId: 368046 },
      { title: 'Ship of Destiny', author: 'Robin Hobb', olCoverId: 8314580 },
    ],
  },

  'Tawny Man Trilogy': {
    displayName:  'Tawny Man Trilogy',
    total:        3,
    orderedBooks: [
      { title: "Fool's Errand", author: 'Robin Hobb', olCoverId: 373090 },
      { title: 'Golden Fool',   author: 'Robin Hobb', olCoverId: 373091 },
      { title: "Fool's Fate",   author: 'Robin Hobb', olCoverId: 374007 },
    ],
  },

  'Rain Wilds Chronicles': {
    displayName:  'Rain Wilds Chronicles',
    total:        4,
    orderedBooks: [
      { title: 'Dragon Keeper',    author: 'Robin Hobb', olCoverId: 6680847 },
      { title: 'Dragon Haven',     author: 'Robin Hobb', olCoverId: 6298448 },
      { title: 'City of Dragons',  author: 'Robin Hobb', olCoverId: 7254797 },
      { title: 'Blood of Dragons', author: 'Robin Hobb', olCoverId: 7284727 },
    ],
  },

  'Fitz and the Fool': {
    displayName:  'Fitz and the Fool Trilogy',
    total:        3,
    orderedBooks: [
      { title: "Fool's Assassin", author: 'Robin Hobb', olCoverId: 10107391 },
      { title: "Fool's Quest",    author: 'Robin Hobb', olCoverId: 13172508 },
      { title: "Assassin's Fate", author: 'Robin Hobb', olCoverId: 8417258 },
    ],
  },

  // ── Brandon Sanderson ─────────────────────────────────────────────────────
  'Mistborn': {
    displayName:  'Mistborn',
    total:        3,
    orderedBooks: [
      { title: 'The Final Empire',      author: 'Brandon Sanderson', olCoverId: 14658160 },
      { title: 'The Well of Ascension', author: 'Brandon Sanderson', olCoverId: 14658341 },
      { title: 'The Hero of Ages',      author: 'Brandon Sanderson', olCoverId: 14658094 },
    ],
  },

  'Wax and Wayne': {
    displayName:  'Mistborn: Wax and Wayne',
    total:        4,
    orderedBooks: [
      { title: 'The Alloy of Law',      author: 'Brandon Sanderson', olCoverId: 14658081 },
      { title: 'Shadows of Self',       author: 'Brandon Sanderson', olCoverId: 14658321 },
      { title: 'The Bands of Mourning', author: 'Brandon Sanderson', olCoverId: 14658335 },
      { title: 'The Lost Metal',        author: 'Brandon Sanderson', olCoverId: 14658507 },
    ],
  },

  'The Stormlight Archive': {
    displayName:  'The Stormlight Archive',
    total:        5,
    orderedBooks: [
      { title: 'The Way of Kings',   author: 'Brandon Sanderson', olCoverId: 14658316 },
      { title: 'Words of Radiance',  author: 'Brandon Sanderson', olCoverId: 14658334 },
      { title: 'Oathbringer',        author: 'Brandon Sanderson', olCoverId: 14658111 },
      { title: 'Rhythm of War',      author: 'Brandon Sanderson', olCoverId: 14658361 },
      { title: 'The Wind and Truth', author: 'Brandon Sanderson' },
    ],
  },

  'Skyward': {
    displayName:  'Skyward',
    total:        4,
    orderedBooks: [
      { title: 'Skyward',   author: 'Brandon Sanderson', olCoverId: 14658323 },
      { title: 'Starsight', author: 'Brandon Sanderson', olCoverId: 14662078 },
      { title: 'Cytonic',   author: 'Brandon Sanderson', olCoverId: 14658369 },
      { title: 'Defiant',   author: 'Brandon Sanderson', olCoverId: 13815273 },
    ],
  },

  // ── Sarah J. Maas ─────────────────────────────────────────────────────────
  // Throne of Glass prequel (position 0) is treated as position 1 for labelling;
  // the 7-book mainline series starts with Throne of Glass (pos 1).
  'Throne of Glass': {
    displayName:  'Throne of Glass',
    total:        7,
    orderedBooks: [
      { title: 'Throne of Glass',   author: 'Sarah J. Maas', olCoverId: 13312488 },
      { title: 'Crown of Midnight', author: 'Sarah J. Maas', olCoverId: 14348029 },
      { title: 'Heir of Fire',      author: 'Sarah J. Maas', olCoverId: 9318480 },
      { title: 'Queen of Shadows',  author: 'Sarah J. Maas', olCoverId: 7994583 },
      { title: 'Empire of Storms',  author: 'Sarah J. Maas', olCoverId: 14349313 },
    ],
  },

  'ACOTAR': {
    displayName:  'A Court of Thorns and Roses',
    total:        5,
    orderedBooks: [
      { title: 'A Court of Thorns and Roses',    author: 'Sarah J. Maas', olCoverId: 8738585 },
      { title: 'A Court of Mist and Fury',       author: 'Sarah J. Maas', olCoverId: 14315081 },
      { title: 'A Court of Wings and Ruin',      author: 'Sarah J. Maas', olCoverId: 8506724 },
      { title: 'A Court of Frost and Starlight', author: 'Sarah J. Maas', olCoverId: 8569939 },
      { title: 'A Court of Silver Flames',       author: 'Sarah J. Maas', olCoverId: 10643508 },
    ],
  },

  'Crescent City': {
    displayName:  'Crescent City',
    total:        3,
    orderedBooks: [
      { title: 'House of Earth and Blood',  author: 'Sarah J. Maas', olCoverId: 9289603 },
      { title: 'House of Sky and Breath',   author: 'Sarah J. Maas', olCoverId: 10327411 },
      { title: 'House of Flame and Shadow', author: 'Sarah J. Maas', olCoverId: 13525139 },
    ],
  },

  // ── George R. R. Martin ───────────────────────────────────────────────────
  // 5 published books; The Winds of Winter is not yet published.
  'A Song of Ice and Fire': {
    displayName:  'A Song of Ice and Fire',
    total:        5,
    orderedBooks: [
      { title: 'A Game of Thrones',    author: 'George R. R. Martin', olCoverId: 9269962 },
      { title: 'A Clash of Kings',     author: 'George R. R. Martin', olCoverId: 8231751 },
      { title: 'A Storm of Swords',    author: 'George R. R. Martin', olCoverId: 15124196 },
      { title: 'A Feast for Crows',    author: 'George R. R. Martin', olCoverId: 6501256 },
      { title: 'A Dance with Dragons', author: 'George R. R. Martin', olCoverId: 11298743 },
    ],
  },

  // ── Leigh Bardugo ─────────────────────────────────────────────────────────
  'Shadow and Bone': {
    displayName:  'Shadow and Bone',
    total:        3,
    orderedBooks: [
      { title: 'Shadow and Bone', author: 'Leigh Bardugo', olCoverId: 13816048 },
      { title: 'Siege and Storm', author: 'Leigh Bardugo', olCoverId: 10297781 },
      { title: 'Ruin and Rising', author: 'Leigh Bardugo', olCoverId: 12667421 },
    ],
  },

  'Six of Crows': {
    displayName:  'Six of Crows',
    total:        2,
    orderedBooks: [
      { title: 'Six of Crows',    author: 'Leigh Bardugo', olCoverId: 12667417 },
      { title: 'Crooked Kingdom', author: 'Leigh Bardugo', olCoverId: 12667428 },
    ],
  },

  'King of Scars': {
    displayName:  'King of Scars',
    total:        2,
    orderedBooks: [
      { title: 'King of Scars',  author: 'Leigh Bardugo', olCoverId: 12714913 },
      { title: 'Rule of Wolves', author: 'Leigh Bardugo', olCoverId: 10394566 },
    ],
  },

  // ── Holly Black ───────────────────────────────────────────────────────────
  'The Folk of the Air': {
    displayName:  'The Folk of the Air',
    total:        3,
    orderedBooks: [
      { title: 'The Cruel Prince',     author: 'Holly Black', olCoverId: 8361789 },
      { title: 'The Wicked King',      author: 'Holly Black', olCoverId: 8361788 },
      { title: 'The Queen of Nothing', author: 'Holly Black', olCoverId: 9146990 },
    ],
  },

  'The Stolen Heir': {
    displayName:  'The Stolen Heir',
    total:        2,
    orderedBooks: [
      { title: 'The Stolen Heir',                      author: 'Holly Black', olCoverId: 13122196 },
      { title: 'The Prisoner of the Castle of Unrest', author: 'Holly Black' },
    ],
  },

  // ── Raven Kennedy ─────────────────────────────────────────────────────────
  'The Plated Prisoner': {
    displayName:  'The Plated Prisoner',
    total:        5,
    orderedBooks: [
      { title: 'Gild',  author: 'Raven Kennedy', olCoverId: 13290449 },
      { title: 'Glint', author: 'Raven Kennedy', olCoverId: 13614818 },
      { title: 'Gleam', author: 'Raven Kennedy', olCoverId: 14667127 },
      { title: 'Glow',  author: 'Raven Kennedy', olCoverId: 15152413 },
      { title: 'Gold',  author: 'Raven Kennedy', olCoverId: 14668980 },
    ],
  },

  // ── Rebecca Yarros ────────────────────────────────────────────────────────
  'The Empyrean': {
    displayName:  'The Empyrean',
    total:        3,
    orderedBooks: [
      { title: 'Fourth Wing', author: 'Rebecca Yarros', olCoverId: 14407898 },
      { title: 'Iron Flame',  author: 'Rebecca Yarros', olCoverId: 14405746 },
      { title: 'Onyx Storm',  author: 'Rebecca Yarros', olCoverId: 14826089 },
    ],
  },

  // ── Anthony Horowitz ──────────────────────────────────────────────────────
  'Hawthorne and Horowitz': {
    displayName:  'Hawthorne and Horowitz',
    total:        4,
    orderedBooks: [
      { title: 'The Word is Murder',    author: 'Anthony Horowitz', olCoverId: 9155652 },
      { title: 'The Sentence is Death', author: 'Anthony Horowitz', olCoverId: 8598870 },
      { title: 'A Line to Kill',        author: 'Anthony Horowitz', olCoverId: 11422612 },
      { title: 'Close to Death',        author: 'Anthony Horowitz', olCoverId: 14606602 },
    ],
  },

  'Susan Ryeland': {
    displayName:  'Susan Ryeland',
    total:        2,
    orderedBooks: [
      { title: 'Magpie Murders',    author: 'Anthony Horowitz', olCoverId: 8189045 },
      { title: 'Moonflower Murders',author: 'Anthony Horowitz', olCoverId: 10096871 },
    ],
  },

  // ── Elin Hilderbrand ──────────────────────────────────────────────────────
  'Winter Street': {
    displayName:  'Winter Street',
    total:        4,
    orderedBooks: [
      { title: 'Winter Street',   author: 'Elin Hilderbrand', olCoverId: 8994580 },
      { title: 'Winter Stroll',   author: 'Elin Hilderbrand', olCoverId: 10414609 },
      { title: 'Winter Storms',   author: 'Elin Hilderbrand', olCoverId: 9139654 },
      { title: 'Winter Solstice', author: 'Elin Hilderbrand', olCoverId: 8861679 },
    ],
  },

  'Paradise': {
    displayName:  'Paradise',
    total:        3,
    orderedBooks: [
      { title: 'Winter in Paradise',       author: 'Elin Hilderbrand', olCoverId: 8813208 },
      { title: 'What Happens in Paradise', author: 'Elin Hilderbrand', olCoverId: 8945090 },
      { title: 'Here in Paradise',         author: 'Elin Hilderbrand' },
    ],
  },

  // ── Colleen Hoover ────────────────────────────────────────────────────────
  'Slammed': {
    displayName:  'Slammed',
    total:        3,
    orderedBooks: [
      { title: 'Slammed',          author: 'Colleen Hoover', olCoverId: 12852065 },
      { title: 'Point of Retreat', author: 'Colleen Hoover', olCoverId: 7590980 },
      { title: 'This Girl',        author: 'Colleen Hoover', olCoverId: 13459261 },
    ],
  },

  'Hopeless': {
    displayName:  'Hopeless',
    total:        2,
    orderedBooks: [
      { title: 'Hopeless',    author: 'Colleen Hoover', olCoverId: 10549926 },
      { title: 'Losing Hope', author: 'Colleen Hoover', olCoverId: 9326787 },
    ],
  },

  'It Ends with Us': {
    displayName:  'It Ends with Us',
    total:        2,
    orderedBooks: [
      { title: 'It Ends with Us',   author: 'Colleen Hoover', olCoverId: 10473609 },
      { title: 'It Starts with Us', author: 'Colleen Hoover', olCoverId: 12749873 },
    ],
  },

  // ── J.K. Rowling — Harry Potter ──────────────────────────────────────────
  'Harry Potter': {
    displayName:  'Harry Potter',
    total:        7,
    orderedBooks: [
      { title: "Harry Potter and the Sorcerer's Stone",  author: 'J.K. Rowling', olCoverId: 276518 },
      { title: 'Harry Potter and the Chamber of Secrets',author: 'J.K. Rowling', olCoverId: 15158664 },
      { title: 'Harry Potter and the Prisoner of Azkaban',author:'J.K. Rowling', olCoverId: 10580435 },
      { title: 'Harry Potter and the Goblet of Fire',    author: 'J.K. Rowling', olCoverId: 12059372 },
      { title: 'Harry Potter and the Order of the Phoenix',author:'J.K. Rowling', olCoverId: 15158666},
    ],
  },

  // ── V.E. Schwab / Victoria Schwab ─────────────────────────────────────────
  'Villains': {
    displayName:  'Villains',
    total:        2,
    orderedBooks: [
      { title: 'Vicious',  author: 'V.E. Schwab', olCoverId: 7410937 },
      { title: 'Vengeful', author: 'V.E. Schwab', olCoverId: 8843140 },
    ],
  },

  'Shades of Magic': {
    displayName:  'Shades of Magic',
    total:        3,
    orderedBooks: [
      { title: 'A Darker Shade of Magic', author: 'V.E. Schwab', olCoverId: 7410930 },
      { title: 'A Gathering of Shadows',  author: 'V.E. Schwab', olCoverId: 7990183 },
      { title: 'A Conjuring of Light',    author: 'V.E. Schwab', olCoverId: 7990184 },
    ],
  },

  // ── Robert Jordan — Wheel of Time ────────────────────────────────────────
  // 14 published books total; cover row shows the first 5.
  'The Wheel of Time': {
    displayName:  'The Wheel of Time',
    total:        14,
    orderedBooks: [
      { title: 'The Eye of the World',  author: 'Robert Jordan', olCoverId: 980232 },
      { title: 'The Great Hunt',        author: 'Robert Jordan', olCoverId: 182352 },
      { title: 'The Dragon Reborn',     author: 'Robert Jordan', olCoverId: 603239 },
      { title: 'The Shadow Rising',     author: 'Robert Jordan', olCoverId: 603240 },
      { title: 'The Fires of Heaven',   author: 'Robert Jordan', olCoverId: 603821 },
    ],
  },

  // ── Patrick Rothfuss — Kingkiller Chronicle ───────────────────────────────
  // Announced as a trilogy; Doors of Stone not yet published.
  'Kingkiller Chronicle': {
    displayName:  'The Kingkiller Chronicle',
    total:        3,
    orderedBooks: [
      { title: 'The Name of the Wind', author: 'Patrick Rothfuss', olCoverId: 11480483 },
      { title: "The Wise Man's Fear",  author: 'Patrick Rothfuss', olCoverId: 8294024 },
    ],
  },

  // ── Cassandra Clare — The Shadowhunter Chronicles ─────────────────────────
  'The Mortal Instruments': {
    displayName:  'The Mortal Instruments',
    total:        6,
    orderedBooks: [
      { title: 'City of Bones',         author: 'Cassandra Clare', olCoverId: 10121449 },
      { title: 'City of Ashes',         author: 'Cassandra Clare', olCoverId: 8783750 },
      { title: 'City of Glass',         author: 'Cassandra Clare', olCoverId: 10397651 },
      { title: 'City of Fallen Angels', author: 'Cassandra Clare', olCoverId: 8200331 },
      { title: 'City of Lost Souls',    author: 'Cassandra Clare', olCoverId: 8200328 },
    ],
  },

  'The Infernal Devices': {
    displayName:  'The Infernal Devices',
    total:        3,
    orderedBooks: [
      { title: 'Clockwork Angel',    author: 'Cassandra Clare', olCoverId: 6582736 },
      { title: 'Clockwork Prince',   author: 'Cassandra Clare', olCoverId: 6934916 },
      { title: 'Clockwork Princess', author: 'Cassandra Clare', olCoverId: 9042989 },
    ],
  },
};

// ── Saga catalog ──────────────────────────────────────────────────────────────
//
// A "saga" is a set of multiple related series that form a single coherent
// reading journey with a strongly recommended reading order.  Unlike the
// per-series prereqs (which gate individual series), the saga registry defines
// the FULL top-level journey so the system can:
//   • Never recommend a later saga entry before earlier ones are complete
//   • Explain recommendations with saga-level language, not just series-level
//
// CONTRACT:
//   saga_name        — human-readable name shown in explanations
//   series_order     — ordered list of SERIES_CATALOG keys (exact match required)
//
// DO NOT add a saga unless the reading order is unambiguous and curated.
// Conservative inclusion: if order is debated, exclude from saga registry.
//
// Current sagas:
//   Realm of the Elderlings (Robin Hobb) — 5 sub-series, strictly ordered
//   Mistborn Saga (Brandon Sanderson)    — Era 1 → Era 2

export type SagaCatalogEntry = {
  saga_name:    string;
  series_order: string[];  // ordered series keys, index 0 = read first
};

const SAGA_CATALOG: Record<string, SagaCatalogEntry> = {

  // ── Robin Hobb — Realm of the Elderlings ─────────────────────────────────
  // Canonical reading order: Farseer → Liveship → Tawny Man → Rain Wilds → FatF.
  // All five sub-series are deeply interconnected; skipping ahead breaks story
  // continuity and major character revelations.
  'Realm of the Elderlings': {
    saga_name:    'Realm of the Elderlings',
    series_order: [
      'Farseer Trilogy',
      'Liveship Traders',
      'Tawny Man Trilogy',
      'Rain Wilds Chronicles',
      'Fitz and the Fool',
    ],
  },

  // ── Brandon Sanderson — Mistborn Saga ────────────────────────────────────
  // Era 1 (original trilogy) must be complete before Era 2 (Wax and Wayne).
  // Era 2 is set ~300 years later; reading order is mandatory for full context.
  'Mistborn Saga': {
    saga_name:    'Mistborn Saga',
    series_order: [
      'Mistborn',
      'Wax and Wayne',
    ],
  },

};

// Given a series catalog key (e.g. 'Tawny Man Trilogy'), returns:
//   - sagaKey:      SAGA_CATALOG key (e.g. 'Realm of the Elderlings')
//   - sagaName:     human-readable name
//   - seriesIndex:  0-based position of this series in the saga's series_order
// Returns null if the series does not belong to any saga.
export function getSagaForSeries(
  seriesKey: string,
): { sagaKey: string; sagaName: string; seriesIndex: number } | null {
  for (const [sagaKey, sagaEntry] of Object.entries(SAGA_CATALOG)) {
    const idx = sagaEntry.series_order.indexOf(seriesKey);
    if (idx !== -1) {
      return { sagaKey, sagaName: sagaEntry.saga_name, seriesIndex: idx };
    }
  }
  return null;
}

export function getAllSagaCatalog(): Readonly<Record<string, SagaCatalogEntry>> {
  return SAGA_CATALOG;
}

export function getSeriesCatalog(seriesName: string): SeriesCatalogEntry | null {
  return SERIES_CATALOG[seriesName] ?? null;
}

// Returns the full catalog — used by exact-series retrieval seeding.
export function getAllSeriesCatalog(): Readonly<Record<string, SeriesCatalogEntry>> {
  return SERIES_CATALOG;
}

// Normalise a title or author string for catalog matching:
// lowercase, strip smart quotes and apostrophes, collapse non-alnum to spaces.
function normForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Given a book title + author, return the canonical series key and 1-indexed
// position if the book is found in the static catalog, or null otherwise.
// Used by Library navigation to attach series context to Book Detail routes.
export function findSeriesForBook(
  title: string,
  author: string,
): { seriesName: string; seriesPosition: number } | null {
  const nt = normForMatch(title);
  const na = normForMatch(author);
  for (const [seriesName, entry] of Object.entries(SERIES_CATALOG)) {
    for (let i = 0; i < entry.orderedBooks.length; i++) {
      const b = entry.orderedBooks[i];
      if (normForMatch(b.title) === nt && normForMatch(b.author) === na) {
        return { seriesName, seriesPosition: i + 1 };
      }
    }
  }
  return null;
}
