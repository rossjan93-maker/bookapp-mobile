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
  title:  string;
  author: string;
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
      { title: "Assassin's Apprentice", author: 'Robin Hobb' },
      { title: 'Royal Assassin',        author: 'Robin Hobb' },
      { title: "Assassin's Quest",      author: 'Robin Hobb' },
    ],
  },

  'Liveship Traders': {
    displayName:  'Liveship Traders Trilogy',
    total:        3,
    orderedBooks: [
      { title: 'Ship of Magic',   author: 'Robin Hobb' },
      { title: 'Mad Ship',        author: 'Robin Hobb' },
      { title: 'Ship of Destiny', author: 'Robin Hobb' },
    ],
  },

  'Tawny Man Trilogy': {
    displayName:  'Tawny Man Trilogy',
    total:        3,
    orderedBooks: [
      { title: "Fool's Errand", author: 'Robin Hobb' },
      { title: 'Golden Fool',   author: 'Robin Hobb' },
      { title: "Fool's Fate",   author: 'Robin Hobb' },
    ],
  },

  'Rain Wilds Chronicles': {
    displayName:  'Rain Wilds Chronicles',
    total:        4,
    orderedBooks: [
      { title: 'Dragon Keeper',    author: 'Robin Hobb' },
      { title: 'Dragon Haven',     author: 'Robin Hobb' },
      { title: 'City of Dragons',  author: 'Robin Hobb' },
      { title: 'Blood of Dragons', author: 'Robin Hobb' },
    ],
  },

  'Fitz and the Fool': {
    displayName:  'Fitz and the Fool Trilogy',
    total:        3,
    orderedBooks: [
      { title: "Fool's Assassin", author: 'Robin Hobb' },
      { title: "Fool's Quest",    author: 'Robin Hobb' },
      { title: "Assassin's Fate", author: 'Robin Hobb' },
    ],
  },

  // ── Brandon Sanderson ─────────────────────────────────────────────────────
  'Mistborn': {
    displayName:  'Mistborn',
    total:        3,
    orderedBooks: [
      { title: 'The Final Empire',      author: 'Brandon Sanderson' },
      { title: 'The Well of Ascension', author: 'Brandon Sanderson' },
      { title: 'The Hero of Ages',      author: 'Brandon Sanderson' },
    ],
  },

  'Wax and Wayne': {
    displayName:  'Mistborn: Wax and Wayne',
    total:        4,
    orderedBooks: [
      { title: 'The Alloy of Law',      author: 'Brandon Sanderson' },
      { title: 'Shadows of Self',       author: 'Brandon Sanderson' },
      { title: 'The Bands of Mourning', author: 'Brandon Sanderson' },
      { title: 'The Lost Metal',        author: 'Brandon Sanderson' },
    ],
  },

  'The Stormlight Archive': {
    displayName:  'The Stormlight Archive',
    total:        5,
    orderedBooks: [
      { title: 'The Way of Kings',   author: 'Brandon Sanderson' },
      { title: 'Words of Radiance',  author: 'Brandon Sanderson' },
      { title: 'Oathbringer',        author: 'Brandon Sanderson' },
      { title: 'Rhythm of War',      author: 'Brandon Sanderson' },
      { title: 'The Wind and Truth', author: 'Brandon Sanderson' },
    ],
  },

  'Skyward': {
    displayName:  'Skyward',
    total:        4,
    orderedBooks: [
      { title: 'Skyward',   author: 'Brandon Sanderson' },
      { title: 'Starsight', author: 'Brandon Sanderson' },
      { title: 'Cytonic',   author: 'Brandon Sanderson' },
      { title: 'Defiant',   author: 'Brandon Sanderson' },
    ],
  },

  // ── Sarah J. Maas ─────────────────────────────────────────────────────────
  // Throne of Glass prequel (position 0) is treated as position 1 for labelling;
  // the 7-book mainline series starts with Throne of Glass (pos 1).
  'Throne of Glass': {
    displayName:  'Throne of Glass',
    total:        7,
    orderedBooks: [
      { title: 'Throne of Glass',   author: 'Sarah J. Maas' },
      { title: 'Crown of Midnight', author: 'Sarah J. Maas' },
      { title: 'Heir of Fire',      author: 'Sarah J. Maas' },
      { title: 'Queen of Shadows',  author: 'Sarah J. Maas' },
      { title: 'Empire of Storms',  author: 'Sarah J. Maas' },
    ],
  },

  'ACOTAR': {
    displayName:  'A Court of Thorns and Roses',
    total:        5,
    orderedBooks: [
      { title: 'A Court of Thorns and Roses',    author: 'Sarah J. Maas' },
      { title: 'A Court of Mist and Fury',       author: 'Sarah J. Maas' },
      { title: 'A Court of Wings and Ruin',      author: 'Sarah J. Maas' },
      { title: 'A Court of Frost and Starlight', author: 'Sarah J. Maas' },
      { title: 'A Court of Silver Flames',       author: 'Sarah J. Maas' },
    ],
  },

  'Crescent City': {
    displayName:  'Crescent City',
    total:        3,
    orderedBooks: [
      { title: 'House of Earth and Blood',  author: 'Sarah J. Maas' },
      { title: 'House of Sky and Breath',   author: 'Sarah J. Maas' },
      { title: 'House of Flame and Shadow', author: 'Sarah J. Maas' },
    ],
  },

  // ── George R. R. Martin ───────────────────────────────────────────────────
  // 5 published books; The Winds of Winter is not yet published.
  'A Song of Ice and Fire': {
    displayName:  'A Song of Ice and Fire',
    total:        5,
    orderedBooks: [
      { title: 'A Game of Thrones',    author: 'George R. R. Martin' },
      { title: 'A Clash of Kings',     author: 'George R. R. Martin' },
      { title: 'A Storm of Swords',    author: 'George R. R. Martin' },
      { title: 'A Feast for Crows',    author: 'George R. R. Martin' },
      { title: 'A Dance with Dragons', author: 'George R. R. Martin' },
    ],
  },

  // ── Leigh Bardugo ─────────────────────────────────────────────────────────
  'Shadow and Bone': {
    displayName:  'Shadow and Bone',
    total:        3,
    orderedBooks: [
      { title: 'Shadow and Bone', author: 'Leigh Bardugo' },
      { title: 'Siege and Storm', author: 'Leigh Bardugo' },
      { title: 'Ruin and Rising', author: 'Leigh Bardugo' },
    ],
  },

  'Six of Crows': {
    displayName:  'Six of Crows',
    total:        2,
    orderedBooks: [
      { title: 'Six of Crows',    author: 'Leigh Bardugo' },
      { title: 'Crooked Kingdom', author: 'Leigh Bardugo' },
    ],
  },

  'King of Scars': {
    displayName:  'King of Scars',
    total:        2,
    orderedBooks: [
      { title: 'King of Scars',  author: 'Leigh Bardugo' },
      { title: 'Rule of Wolves', author: 'Leigh Bardugo' },
    ],
  },

  // ── Holly Black ───────────────────────────────────────────────────────────
  'The Folk of the Air': {
    displayName:  'The Folk of the Air',
    total:        3,
    orderedBooks: [
      { title: 'The Cruel Prince',     author: 'Holly Black' },
      { title: 'The Wicked King',      author: 'Holly Black' },
      { title: 'The Queen of Nothing', author: 'Holly Black' },
    ],
  },

  'The Stolen Heir': {
    displayName:  'The Stolen Heir',
    total:        2,
    orderedBooks: [
      { title: 'The Stolen Heir',                      author: 'Holly Black' },
      { title: 'The Prisoner of the Castle of Unrest', author: 'Holly Black' },
    ],
  },

  // ── Raven Kennedy ─────────────────────────────────────────────────────────
  'The Plated Prisoner': {
    displayName:  'The Plated Prisoner',
    total:        5,
    orderedBooks: [
      { title: 'Gild',  author: 'Raven Kennedy' },
      { title: 'Glint', author: 'Raven Kennedy' },
      { title: 'Gleam', author: 'Raven Kennedy' },
      { title: 'Glow',  author: 'Raven Kennedy' },
      { title: 'Gold',  author: 'Raven Kennedy' },
    ],
  },

  // ── Rebecca Yarros ────────────────────────────────────────────────────────
  'The Empyrean': {
    displayName:  'The Empyrean',
    total:        3,
    orderedBooks: [
      { title: 'Fourth Wing', author: 'Rebecca Yarros' },
      { title: 'Iron Flame',  author: 'Rebecca Yarros' },
      { title: 'Onyx Storm',  author: 'Rebecca Yarros' },
    ],
  },

  // ── Anthony Horowitz ──────────────────────────────────────────────────────
  'Hawthorne and Horowitz': {
    displayName:  'Hawthorne and Horowitz',
    total:        4,
    orderedBooks: [
      { title: 'The Word is Murder',    author: 'Anthony Horowitz' },
      { title: 'The Sentence is Death', author: 'Anthony Horowitz' },
      { title: 'A Line to Kill',        author: 'Anthony Horowitz' },
      { title: 'Close to Death',        author: 'Anthony Horowitz' },
    ],
  },

  'Susan Ryeland': {
    displayName:  'Susan Ryeland',
    total:        2,
    orderedBooks: [
      { title: 'Magpie Murders',    author: 'Anthony Horowitz' },
      { title: 'Moonflower Murders',author: 'Anthony Horowitz' },
    ],
  },

  // ── Elin Hilderbrand ──────────────────────────────────────────────────────
  'Winter Street': {
    displayName:  'Winter Street',
    total:        4,
    orderedBooks: [
      { title: 'Winter Street',   author: 'Elin Hilderbrand' },
      { title: 'Winter Stroll',   author: 'Elin Hilderbrand' },
      { title: 'Winter Storms',   author: 'Elin Hilderbrand' },
      { title: 'Winter Solstice', author: 'Elin Hilderbrand' },
    ],
  },

  'Paradise': {
    displayName:  'Paradise',
    total:        3,
    orderedBooks: [
      { title: 'Winter in Paradise',       author: 'Elin Hilderbrand' },
      { title: 'What Happens in Paradise', author: 'Elin Hilderbrand' },
      { title: 'Here in Paradise',         author: 'Elin Hilderbrand' },
    ],
  },

  // ── Colleen Hoover ────────────────────────────────────────────────────────
  'Slammed': {
    displayName:  'Slammed',
    total:        3,
    orderedBooks: [
      { title: 'Slammed',          author: 'Colleen Hoover' },
      { title: 'Point of Retreat', author: 'Colleen Hoover' },
      { title: 'This Girl',        author: 'Colleen Hoover' },
    ],
  },

  'Hopeless': {
    displayName:  'Hopeless',
    total:        2,
    orderedBooks: [
      { title: 'Hopeless',    author: 'Colleen Hoover' },
      { title: 'Losing Hope', author: 'Colleen Hoover' },
    ],
  },

  'It Ends with Us': {
    displayName:  'It Ends with Us',
    total:        2,
    orderedBooks: [
      { title: 'It Ends with Us',   author: 'Colleen Hoover' },
      { title: 'It Starts with Us', author: 'Colleen Hoover' },
    ],
  },

  // ── J.K. Rowling — Harry Potter ──────────────────────────────────────────
  'Harry Potter': {
    displayName:  'Harry Potter',
    total:        7,
    orderedBooks: [
      { title: "Harry Potter and the Sorcerer's Stone",  author: 'J.K. Rowling' },
      { title: 'Harry Potter and the Chamber of Secrets',author: 'J.K. Rowling' },
      { title: 'Harry Potter and the Prisoner of Azkaban',author:'J.K. Rowling' },
      { title: 'Harry Potter and the Goblet of Fire',    author: 'J.K. Rowling' },
      { title: 'Harry Potter and the Order of the Phoenix',author:'J.K. Rowling'},
    ],
  },

  // ── V.E. Schwab / Victoria Schwab ─────────────────────────────────────────
  'Villains': {
    displayName:  'Villains',
    total:        2,
    orderedBooks: [
      { title: 'Vicious',  author: 'V.E. Schwab' },
      { title: 'Vengeful', author: 'V.E. Schwab' },
    ],
  },

  'Shades of Magic': {
    displayName:  'Shades of Magic',
    total:        3,
    orderedBooks: [
      { title: 'A Darker Shade of Magic', author: 'V.E. Schwab' },
      { title: 'A Gathering of Shadows',  author: 'V.E. Schwab' },
      { title: 'A Conjuring of Light',    author: 'V.E. Schwab' },
    ],
  },

  // ── Robert Jordan — Wheel of Time ────────────────────────────────────────
  // 14 published books total; cover row shows the first 5.
  'The Wheel of Time': {
    displayName:  'The Wheel of Time',
    total:        14,
    orderedBooks: [
      { title: 'The Eye of the World',  author: 'Robert Jordan' },
      { title: 'The Great Hunt',        author: 'Robert Jordan' },
      { title: 'The Dragon Reborn',     author: 'Robert Jordan' },
      { title: 'The Shadow Rising',     author: 'Robert Jordan' },
      { title: 'The Fires of Heaven',   author: 'Robert Jordan' },
    ],
  },

  // ── Patrick Rothfuss — Kingkiller Chronicle ───────────────────────────────
  // Announced as a trilogy; Doors of Stone not yet published.
  'Kingkiller Chronicle': {
    displayName:  'The Kingkiller Chronicle',
    total:        3,
    orderedBooks: [
      { title: 'The Name of the Wind', author: 'Patrick Rothfuss' },
      { title: "The Wise Man's Fear",  author: 'Patrick Rothfuss' },
    ],
  },

  // ── Cassandra Clare — The Shadowhunter Chronicles ─────────────────────────
  'The Mortal Instruments': {
    displayName:  'The Mortal Instruments',
    total:        6,
    orderedBooks: [
      { title: 'City of Bones',         author: 'Cassandra Clare' },
      { title: 'City of Ashes',         author: 'Cassandra Clare' },
      { title: 'City of Glass',         author: 'Cassandra Clare' },
      { title: 'City of Fallen Angels', author: 'Cassandra Clare' },
      { title: 'City of Lost Souls',    author: 'Cassandra Clare' },
    ],
  },

  'The Infernal Devices': {
    displayName:  'The Infernal Devices',
    total:        3,
    orderedBooks: [
      { title: 'Clockwork Angel',    author: 'Cassandra Clare' },
      { title: 'Clockwork Prince',   author: 'Cassandra Clare' },
      { title: 'Clockwork Princess', author: 'Cassandra Clare' },
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
