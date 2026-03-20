// ── Recommendation Integrity Layer (RIL) ────────────────────────────────────
//
// Pipeline position (runs after CoG classification, before set-composition):
//   candidate retrieval
//   → scoring + fit classification (recommender.ts)
//   → [THIS MODULE] RIL: series annotation + integrity suppression
//   → intent filter → composition engine → user-facing recs
//
// Rules enforced:
//   1. Entry-point integrity: never surface a series book at position > 1 to a
//      reader who has not established a relationship with that author.
//   2. Series flooding collapse: when multiple books from the same series appear
//      in the pool, keep only the best entry point.
//   3. Series labelling: annotate every book so the UI can render badges
//      ("Start here", "Continue the series").
//
// Detection priority chain (first match wins):
//   A. Curated database   → confidence 'high'   (covers ~50 major series)
//   B. Title regex        → confidence 'medium'  (OL parenthetical notation)
//   C. Description regex  → confidence 'medium'  (ordinal + numeric patterns)
//   D. No match           → confidence null       (book passes through unchanged)
//
// Suppression rules by confidence:
//   high:   suppress position > 1 for non-repeated-author readers (even if sole pool member)
//   medium: suppress position > 1 for non-repeated-author readers (same, but audit notes confidence)
//   null:   no suppression (conservative pass-through)
//
// Why the original title-regex-only approach was insufficient:
//   Open Library returns bare titles for most series books. "Words of Radiance",
//   "Oathbringer", "Fool's fate", "Assassin's Fate", "Mad Ship", "A Storm of
//   Swords" — none of these appear with the "(Series, #N)" parenthetical in the
//   OL search API response. The regex only caught books OL happened to tag
//   explicitly (e.g., "House of Earth and Blood (Crescent City, #1)").
//   Additionally, the group-size guard (skip when group.members.length <= 1)
//   prevented suppression when the later-volume was the *only* representative
//   of its series in the pool — the most common real-world case.

import type { ScoredBook, ScoreBreakdown } from './recommender';

// ── Public types ─────────────────────────────────────────────────────────────

export type SeriesLabel =
  | 'series_starter'       // position 1 → "Start here"
  | 'series_continuation'  // position > 1, user has read author → "Continue the series"
  | 'series_later_volume'; // position > 1, author unfamiliar → suppressed

export type DetectionConfidence = 'high' | 'medium';

export type SeriesPosition = {
  series_name:      string;
  series_position:  number;             // 1-indexed; 0 = prequel (treated as 1 for labelling)
  confidence:       DetectionConfidence;
  detection_method: string;
};

export type IntegrityLayerResult = {
  visible:             ScoredBook[];    // passed to composition engine
  integritySuppressed: ScoredBook[];    // audit-only
};

// ── Series-read set builder ───────────────────────────────────────────────────
// Builds the set of series names the user has already started reading.
// Runs every read book through the curated database and collects series names.
// This is the authoritative source for continuation eligibility — author
// familiarity alone is not a sufficient signal.

export function buildSeriesReadSet(
  readBooks: Array<{ title: string; author: string }>,
): Set<string> {
  const names = new Set<string>();
  for (const book of readBooks) {
    const entry = lookupCurated(book.author, book.title);
    if (entry) names.add(normKey(entry.series));
  }
  return names;
}

// ── Helper ───────────────────────────────────────────────────────────────────

function normKey(s: string): string {
  return s.toLowerCase()
    .replace(/['''\u2018\u2019]/g, '')   // strip apostrophes/smart quotes without adding space
    .replace(/[^a-z0-9 ]/g, ' ')         // all other non-alphanumeric → space
    .replace(/\s+/g, ' ')
    .trim();
}

function rilId(b: ScoredBook): string {
  return b.external_id ?? `${b.author}::${b.title}`;
}

// ── A. Curated series database ───────────────────────────────────────────────
// Source of truth for high-confidence series membership.
// Key: normKey(author) → normKey(title) → { series, position }
// Covers the authors most likely to appear in dense-import fantasy/SFF/romance pools.

type CuratedEntry = { series: string; position: number };

const CURATED: Record<string, Record<string, CuratedEntry>> = {

  // ── Robin Hobb — Realm of the Elderlings ───────────────────────────────
  'robin hobb': {
    // Farseer Trilogy
    'assassins apprentice':                 { series: 'Farseer Trilogy',          position: 1 },
    'royal assassin':                       { series: 'Farseer Trilogy',          position: 2 },
    'assassins quest':                      { series: 'Farseer Trilogy',          position: 3 },
    // Liveship Traders
    'ship of magic':                        { series: 'Liveship Traders',         position: 1 },
    'mad ship':                             { series: 'Liveship Traders',         position: 2 },
    'ship of destiny':                      { series: 'Liveship Traders',         position: 3 },
    // Tawny Man Trilogy
    'fools errand':                         { series: 'Tawny Man Trilogy',        position: 1 },
    'golden fool':                          { series: 'Tawny Man Trilogy',        position: 2 },
    'fools fate':                           { series: 'Tawny Man Trilogy',        position: 3 },
    // Rain Wilds Chronicles
    'dragon keeper':                        { series: 'Rain Wilds Chronicles',    position: 1 },
    'dragon haven':                         { series: 'Rain Wilds Chronicles',    position: 2 },
    'city of dragons':                      { series: 'Rain Wilds Chronicles',    position: 3 },
    'blood of dragons':                     { series: 'Rain Wilds Chronicles',    position: 4 },
    // Fitz and the Fool
    'fools assassin':                       { series: 'Fitz and the Fool',        position: 1 },
    'fools quest':                          { series: 'Fitz and the Fool',        position: 2 },
    'assassins fate':                       { series: 'Fitz and the Fool',        position: 3 },
  },

  // ── Brandon Sanderson — Cosmere + Skyward ──────────────────────────────
  'brandon sanderson': {
    // Mistborn Era 1
    'the final empire':                     { series: 'Mistborn',                 position: 1 },
    'final empire':                         { series: 'Mistborn',                 position: 1 },
    'mistborn':                             { series: 'Mistborn',                 position: 1 },
    'the well of ascension':                { series: 'Mistborn',                 position: 2 },
    'well of ascension':                    { series: 'Mistborn',                 position: 2 },
    'the hero of ages':                     { series: 'Mistborn',                 position: 3 },
    'hero of ages':                         { series: 'Mistborn',                 position: 3 },
    // Mistborn Era 2 (Wax and Wayne)
    'the alloy of law':                     { series: 'Wax and Wayne',            position: 1 },
    'alloy of law':                         { series: 'Wax and Wayne',            position: 1 },
    'shadows of self':                      { series: 'Wax and Wayne',            position: 2 },
    'the bands of mourning':                { series: 'Wax and Wayne',            position: 3 },
    'bands of mourning':                    { series: 'Wax and Wayne',            position: 3 },
    'the lost metal':                       { series: 'Wax and Wayne',            position: 4 },
    'lost metal':                           { series: 'Wax and Wayne',            position: 4 },
    // The Stormlight Archive
    'the way of kings':                     { series: 'The Stormlight Archive',   position: 1 },
    'way of kings':                         { series: 'The Stormlight Archive',   position: 1 },
    'words of radiance':                    { series: 'The Stormlight Archive',   position: 2 },
    'oathbringer':                          { series: 'The Stormlight Archive',   position: 3 },
    'rhythm of war':                        { series: 'The Stormlight Archive',   position: 4 },
    'the wind and truth':                   { series: 'The Stormlight Archive',   position: 5 },
    'wind and truth':                       { series: 'The Stormlight Archive',   position: 5 },
    // Skyward
    'skyward':                              { series: 'Skyward',                  position: 1 },
    'starsight':                            { series: 'Skyward',                  position: 2 },
    'cytonic':                              { series: 'Skyward',                  position: 3 },
    'defiant':                              { series: 'Skyward',                  position: 4 },
    // Elantris, Warbreaker — standalones (not listed)
  },

  // ── Sarah J. Maas ─────────────────────────────────────────────────────
  'sarah j maas': {
    // Throne of Glass
    'the assassins blade':                  { series: 'Throne of Glass',          position: 0 }, // prequel
    'assassins blade':                      { series: 'Throne of Glass',          position: 0 },
    'throne of glass':                      { series: 'Throne of Glass',          position: 1 },
    'crown of midnight':                    { series: 'Throne of Glass',          position: 2 },
    'heir of fire':                         { series: 'Throne of Glass',          position: 3 },
    'queen of shadows':                     { series: 'Throne of Glass',          position: 4 },
    'empire of storms':                     { series: 'Throne of Glass',          position: 5 },
    'tower of dawn':                        { series: 'Throne of Glass',          position: 6 },
    'kingdom of ash':                       { series: 'Throne of Glass',          position: 7 },
    // A Court of Thorns and Roses
    'a court of thorns and roses':          { series: 'ACOTAR',                   position: 1 },
    'court of thorns and roses':            { series: 'ACOTAR',                   position: 1 },
    'a court of mist and fury':             { series: 'ACOTAR',                   position: 2 },
    'court of mist and fury':               { series: 'ACOTAR',                   position: 2 },
    'a court of wings and ruin':            { series: 'ACOTAR',                   position: 3 },
    'court of wings and ruin':              { series: 'ACOTAR',                   position: 3 },
    'a court of frost and starlight':       { series: 'ACOTAR',                   position: 4 },
    'a court of silver flames':             { series: 'ACOTAR',                   position: 5 },
    'court of silver flames':               { series: 'ACOTAR',                   position: 5 },
    // Crescent City
    'house of earth and blood':             { series: 'Crescent City',            position: 1 },
    'house of sky and breath':              { series: 'Crescent City',            position: 2 },
    'house of flame and shadow':            { series: 'Crescent City',            position: 3 },
  },

  // ── George R. R. Martin ───────────────────────────────────────────────
  'george r r martin': {
    'a game of thrones':                    { series: 'A Song of Ice and Fire',   position: 1 },
    'game of thrones':                      { series: 'A Song of Ice and Fire',   position: 1 },
    'a clash of kings':                     { series: 'A Song of Ice and Fire',   position: 2 },
    'clash of kings':                       { series: 'A Song of Ice and Fire',   position: 2 },
    'a storm of swords':                    { series: 'A Song of Ice and Fire',   position: 3 },
    'storm of swords':                      { series: 'A Song of Ice and Fire',   position: 3 },
    'a feast for crows':                    { series: 'A Song of Ice and Fire',   position: 4 },
    'feast for crows':                      { series: 'A Song of Ice and Fire',   position: 4 },
    'a dance with dragons':                 { series: 'A Song of Ice and Fire',   position: 5 },
    'dance with dragons':                   { series: 'A Song of Ice and Fire',   position: 5 },
    'the winds of winter':                  { series: 'A Song of Ice and Fire',   position: 6 },
    'winds of winter':                      { series: 'A Song of Ice and Fire',   position: 6 },
  },

  // ── Leigh Bardugo ─────────────────────────────────────────────────────
  'leigh bardugo': {
    // Shadow and Bone
    'shadow and bone':                      { series: 'Shadow and Bone',          position: 1 },
    'siege and storm':                      { series: 'Shadow and Bone',          position: 2 },
    'ruin and rising':                      { series: 'Shadow and Bone',          position: 3 },
    // Six of Crows
    'six of crows':                         { series: 'Six of Crows',             position: 1 },
    'crooked kingdom':                      { series: 'Six of Crows',             position: 2 },
    // King of Scars
    'king of scars':                        { series: 'King of Scars',            position: 1 },
    'rule of wolves':                       { series: 'King of Scars',            position: 2 },
  },

  // ── Holly Black — The Folk of the Air ────────────────────────────────
  'holly black': {
    'the cruel prince':                     { series: 'The Folk of the Air',      position: 1 },
    'cruel prince':                         { series: 'The Folk of the Air',      position: 1 },
    'the wicked king':                      { series: 'The Folk of the Air',      position: 2 },
    'wicked king':                          { series: 'The Folk of the Air',      position: 2 },
    'the queen of nothing':                 { series: 'The Folk of the Air',      position: 3 },
    'queen of nothing':                     { series: 'The Folk of the Air',      position: 3 },
    // The Stolen Heir
    'the stolen heir':                      { series: 'The Stolen Heir',          position: 1 },
    'the prisoner of the castle of unrest': { series: 'The Stolen Heir',          position: 2 },
  },

  // ── Raven Kennedy — The Plated Prisoner ──────────────────────────────
  'raven kennedy': {
    'gild':                                 { series: 'The Plated Prisoner',      position: 1 },
    'glint':                                { series: 'The Plated Prisoner',      position: 2 },
    'gleam':                                { series: 'The Plated Prisoner',      position: 3 },
    'glow':                                 { series: 'The Plated Prisoner',      position: 4 },
    'gold':                                 { series: 'The Plated Prisoner',      position: 5 },
  },

  // ── Rebecca Yarros — The Empyrean ─────────────────────────────────────
  'rebecca yarros': {
    'fourth wing':                          { series: 'The Empyrean',             position: 1 },
    'iron flame':                           { series: 'The Empyrean',             position: 2 },
    'onyx storm':                           { series: 'The Empyrean',             position: 3 },
  },

  // ── Anthony Horowitz ──────────────────────────────────────────────────
  'anthony horowitz': {
    'the word is murder':                   { series: 'Hawthorne and Horowitz',   position: 1 },
    'word is murder':                       { series: 'Hawthorne and Horowitz',   position: 1 },
    'the sentence is death':                { series: 'Hawthorne and Horowitz',   position: 2 },
    'sentence is death':                    { series: 'Hawthorne and Horowitz',   position: 2 },
    'a line to kill':                       { series: 'Hawthorne and Horowitz',   position: 3 },
    'line to kill':                         { series: 'Hawthorne and Horowitz',   position: 3 },
    'close to death':                       { series: 'Hawthorne and Horowitz',   position: 4 },
    'magpie murders':                       { series: 'Susan Ryeland',            position: 1 },
    'moonflower murders':                   { series: 'Susan Ryeland',            position: 2 },
    'stormbreaker':                         { series: 'Alex Rider',               position: 1 },
    'point blanc':                          { series: 'Alex Rider',               position: 2 },
    'skeleton key':                         { series: 'Alex Rider',               position: 3 },
    'eagle strike':                         { series: 'Alex Rider',               position: 4 },
  },

  // ── Elin Hilderbrand ─────────────────────────────────────────────────
  'elin hilderbrand': {
    // Winter Street
    'winter street':                        { series: 'Winter Street',            position: 1 },
    'winter stroll':                        { series: 'Winter Street',            position: 2 },
    'winter storms':                        { series: 'Winter Street',            position: 3 },
    'winter solstice':                      { series: 'Winter Street',            position: 4 },
    // Paradise
    'winter in paradise':                   { series: 'Paradise',                 position: 1 },
    'what happens in paradise':             { series: 'Paradise',                 position: 2 },
    'here in paradise':                     { series: 'Paradise',                 position: 3 },
  },

  // ── Colleen Hoover ────────────────────────────────────────────────────
  'colleen hoover': {
    // Slammed
    'slammed':                              { series: 'Slammed',                  position: 1 },
    'point of retreat':                     { series: 'Slammed',                  position: 2 },
    'this girl':                            { series: 'Slammed',                  position: 3 },
    // Hopeless
    'hopeless':                             { series: 'Hopeless',                 position: 1 },
    'losing hope':                          { series: 'Hopeless',                 position: 2 },
    // It Ends with Us
    'it starts with us':                    { series: 'It Ends with Us',          position: 2 },
  },

  // ── J.K. Rowling — Harry Potter ──────────────────────────────────────
  'j k rowling': {
    "harry potter and the sorcerers stone":    { series: 'Harry Potter', position: 1 },
    "harry potter and the philosophers stone": { series: 'Harry Potter', position: 1 },
    "harry potter and the chamber of secrets": { series: 'Harry Potter', position: 2 },
    "harry potter and the prisoner of azkaban":{ series: 'Harry Potter', position: 3 },
    "harry potter and the goblet of fire":     { series: 'Harry Potter', position: 4 },
    "harry potter and the order of the phoenix":{ series: 'Harry Potter', position: 5 },
    "harry potter and the half blood prince":  { series: 'Harry Potter', position: 6 },
    "harry potter and the deathly hallows":    { series: 'Harry Potter', position: 7 },
  },

  // ── Lucy Foley / Lisa Jewell / Liane Moriarty — standalone thrillers ─
  // These authors write primarily standalones. Only known series listed.

  // ── V.E. Schwab / Victoria Schwab ─────────────────────────────────────
  've schwab': {
    'vicious':                              { series: 'Villains',                 position: 1 },
    'vengeful':                             { series: 'Villains',                 position: 2 },
    'a darker shade of magic':              { series: 'Shades of Magic',          position: 1 },
    'darker shade of magic':                { series: 'Shades of Magic',          position: 1 },
    'a gathering of shadows':               { series: 'Shades of Magic',          position: 2 },
    'a conjuring of light':                 { series: 'Shades of Magic',          position: 3 },
  },
  'victoria schwab': {
    'vicious':                              { series: 'Villains',                 position: 1 },
    'vengeful':                             { series: 'Villains',                 position: 2 },
    'a darker shade of magic':              { series: 'Shades of Magic',          position: 1 },
    'darker shade of magic':                { series: 'Shades of Magic',          position: 1 },
    'a gathering of shadows':               { series: 'Shades of Magic',          position: 2 },
    'a conjuring of light':                 { series: 'Shades of Magic',          position: 3 },
  },

  // ── Robert Jordan — Wheel of Time ────────────────────────────────────
  'robert jordan': {
    'the eye of the world':                 { series: 'The Wheel of Time',        position: 1 },
    'eye of the world':                     { series: 'The Wheel of Time',        position: 1 },
    'the great hunt':                       { series: 'The Wheel of Time',        position: 2 },
    'the dragon reborn':                    { series: 'The Wheel of Time',        position: 3 },
    'the shadow rising':                    { series: 'The Wheel of Time',        position: 4 },
    'the fires of heaven':                  { series: 'The Wheel of Time',        position: 5 },
  },

  // ── Patrick Rothfuss — Kingkiller Chronicle ───────────────────────────
  'patrick rothfuss': {
    'the name of the wind':                 { series: 'Kingkiller Chronicle',     position: 1 },
    'name of the wind':                     { series: 'Kingkiller Chronicle',     position: 1 },
    'the wise mans fear':                   { series: 'Kingkiller Chronicle',     position: 2 },
    'wise mans fear':                       { series: 'Kingkiller Chronicle',     position: 2 },
  },

  // ── Cassandra Clare — The Shadowhunter Chronicles ─────────────────────
  'cassandra clare': {
    'city of bones':                        { series: 'The Mortal Instruments',   position: 1 },
    'city of ashes':                        { series: 'The Mortal Instruments',   position: 2 },
    'city of glass':                        { series: 'The Mortal Instruments',   position: 3 },
    'city of fallen angels':                { series: 'The Mortal Instruments',   position: 4 },
    'city of lost souls':                   { series: 'The Mortal Instruments',   position: 5 },
    'city of heavenly fire':                { series: 'The Mortal Instruments',   position: 6 },
    'clockwork angel':                      { series: 'The Infernal Devices',     position: 1 },
    'clockwork prince':                     { series: 'The Infernal Devices',     position: 2 },
    'clockwork princess':                   { series: 'The Infernal Devices',     position: 3 },
  },
};

// Author name normalisation — handles common formatting variants.
// "Sarah J. Maas", "Sarah J Maas", "S.J. Maas" → 'sarah j maas'
function normalizeAuthor(author: string): string {
  return normKey(author);
}

function lookupCurated(
  author: string,
  title:  string,
): CuratedEntry | null {
  const aKey = normalizeAuthor(author);
  const tKey = normKey(title);

  const authorMap = CURATED[aKey];
  if (!authorMap) return null;

  // Exact title match
  if (authorMap[tKey]) return authorMap[tKey];

  // Strip leading article variants ("the ", "a ", "an ") from title key
  const stripped = tKey.replace(/^(the|a|an) /, '');
  if (stripped !== tKey && authorMap[stripped]) return authorMap[stripped];

  return null;
}

// ── B. Title regex patterns ───────────────────────────────────────────────────
// Secondary source; catches OL's explicit parenthetical notation when present.

const TITLE_SERIES_RE: Array<{
  re: RegExp;
  extract: (m: RegExpMatchArray) => { series_name: string; series_position: number } | null;
}> = [
  {
    // "(Series Name, #2)" or "(Series Name, #2.5)"
    re: /\(([^)]+?),\s*#(\d+(?:\.\d+)?)\)/,
    extract: m => {
      const pos = parseFloat(m[2]);
      return isNaN(pos) || pos < 1 ? null : { series_name: m[1].trim(), series_position: Math.floor(pos) };
    },
  },
  {
    // "(Series Name #2)" — no comma
    re: /\(([^)]+?)\s#(\d+(?:\.\d+)?)\)/,
    extract: m => {
      const pos = parseFloat(m[2]);
      return isNaN(pos) || pos < 1 ? null : { series_name: m[1].trim(), series_position: Math.floor(pos) };
    },
  },
  {
    // "(Series Name, Book 2)" or "(Series Name, Vol. 2)"
    re: /\(([^)]+?),\s*(?:Book|Vol\.?|Volume)\s+(\d+)\)/i,
    extract: m => {
      const pos = parseInt(m[2]);
      return isNaN(pos) || pos < 1 ? null : { series_name: m[1].trim(), series_position: pos };
    },
  },
];

function detectFromTitle(title: string): SeriesPosition | null {
  for (const { re, extract } of TITLE_SERIES_RE) {
    const m = title.match(re);
    if (!m) continue;
    const result = extract(m);
    if (result) return { ...result, confidence: 'medium', detection_method: 'title_pattern' };
  }
  return null;
}

// ── C. Description regex patterns ────────────────────────────────────────────
// Tertiary source; parses common OL description phrasing.
// Limited to patterns with high signal (explicit ordinal + series name).

const ORDINAL_MAP: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

const DESC_SERIES_RE: Array<{
  re: RegExp;
  extract: (m: RegExpMatchArray) => { series_name: string; series_position: number } | null;
}> = [
  {
    // "book 2 in the Stormlight Archive" / "book two of the Mistborn trilogy"
    re: /\bbook\s+(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:in|of)\s+(?:the\s+)?([A-Z][^,.!?:]{3,40}?)(?:\s+(?:series|trilogy|saga|duology|sequence|cycle))?[.,!;:\n]/i,
    extract: m => {
      const rawPos = m[1].toLowerCase();
      const pos = ORDINAL_MAP[rawPos] ?? parseInt(rawPos);
      if (isNaN(pos) || pos < 1 || pos > 15) return null;
      return { series_name: m[2].trim(), series_position: pos };
    },
  },
  {
    // "the second novel in the Mistborn series"
    re: /\bthe\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:novel|book|volume|entry|installment)\s+(?:in|of)\s+(?:the\s+)?([A-Z][^,.!?:]{3,40}?)(?:\s+(?:series|trilogy|saga|duology|sequence))?[.,!;:\n]/i,
    extract: m => {
      const pos = ORDINAL_MAP[m[1].toLowerCase()];
      if (!pos) return null;
      return { series_name: m[2].trim(), series_position: pos };
    },
  },
  {
    // "volume 3 of the X series" / "#3 in the X saga"
    re: /\b(?:volume|vol\.?|#)\s*(\d+)\s+(?:in|of)\s+(?:the\s+)?([A-Z][^,.!?:]{3,40}?)(?:\s+(?:series|trilogy|saga|duology|sequence|cycle))?[.,!;:\n]/i,
    extract: m => {
      const pos = parseInt(m[1]);
      if (isNaN(pos) || pos < 1 || pos > 15) return null;
      return { series_name: m[2].trim(), series_position: pos };
    },
  },
];

function detectFromDescription(description: string | null | undefined): SeriesPosition | null {
  if (!description || description.length < 20) return null;
  for (const { re, extract } of DESC_SERIES_RE) {
    const m = description.match(re);
    if (!m) continue;
    const result = extract(m);
    if (result) return { ...result, confidence: 'medium', detection_method: 'description_pattern' };
  }
  return null;
}

// ── Main detection entry point ────────────────────────────────────────────────
// Priority: curated → title → description.  Returns null if nothing detected.

export function detectSeriesPosition(book: {
  title:       string | null | undefined;
  author:      string | null | undefined;
  description: string | null | undefined;
}): SeriesPosition | null {
  // A — curated
  if (book.author && book.title) {
    const curated = lookupCurated(book.author, book.title);
    if (curated) {
      return {
        series_name:      curated.series,
        series_position:  Math.max(1, curated.position), // treat prequel (0) as position 1 for labelling
        confidence:       'high',
        detection_method: 'curated',
      };
    }
  }

  // B — title patterns
  if (book.title) {
    const fromTitle = detectFromTitle(book.title);
    if (fromTitle) return fromTitle;
  }

  // C — description
  const fromDesc = detectFromDescription(book.description);
  if (fromDesc) return fromDesc;

  return null;
}

// ── Series label derivation ───────────────────────────────────────────────────

// Why author familiarity alone is insufficient:
//   A reader may have read 10 books by Robin Hobb but never started the
//   Liveship Traders series. Surfacing "Mad Ship" (Liveship #2) as a
//   "Continue the series" pick is wrong — the user hasn't started that series.
//   The rule must be: user has read a book from THIS EXACT SERIES, not merely
//   from this author. `seriesReadSet` is built from the user's actual library
//   by running every read book through the curated database lookup.

export function deriveSeriesLabel(
  series:        SeriesPosition | null,
  seriesReadSet: Set<string>,
): SeriesLabel | null {
  if (!series) return null;
  if (series.series_position <= 1) return 'series_starter';
  if (seriesReadSet.has(normKey(series.series_name))) return 'series_continuation';
  return 'series_later_volume';
}

// ── Main integrity pass ───────────────────────────────────────────────────────

export function applyIntegrityLayer(
  books:         ScoredBook[],
  seriesReadSet: Set<string> = new Set(),
): IntegrityLayerResult {

  type Annotated = { book: ScoredBook; series: SeriesPosition | null; label: SeriesLabel | null };

  // ── Step 1: Annotate ──────────────────────────────────────────────────────
  const annotated: Annotated[] = books.map(book => {
    const series = detectSeriesPosition(book);
    const label  = deriveSeriesLabel(series, seriesReadSet);

    // Persist into score breakdown for UI and audit
    (book._score_breakdown as Record<string, unknown>)['series_name']      = series?.series_name      ?? null;
    (book._score_breakdown as Record<string, unknown>)['series_position']  = series?.series_position  ?? null;
    (book._score_breakdown as Record<string, unknown>)['series_label']     = label;
    (book._score_breakdown as Record<string, unknown>)['series_confidence']= series?.confidence       ?? null;
    (book._score_breakdown as Record<string, unknown>)['series_method']    = series?.detection_method ?? null;

    return { book, series, label };
  });

  // ── Step 2: Group by (author, series_name) ────────────────────────────────
  type SeriesGroup = { best_position: number; members: Annotated[] };
  const seriesGroups = new Map<string, SeriesGroup>();

  for (const item of annotated) {
    if (!item.series) continue;
    const groupKey = `${normKey(item.book.author)}::${normKey(item.series.series_name)}`;
    if (!seriesGroups.has(groupKey)) {
      seriesGroups.set(groupKey, { best_position: Infinity, members: [] });
    }
    const group = seriesGroups.get(groupKey)!;
    group.members.push(item);
    if (item.series.series_position < group.best_position) {
      group.best_position = item.series.series_position;
    }
  }

  // ── Step 3: Determine suppressions ───────────────────────────────────────
  // Continuation eligibility: user must have read a book from THIS specific
  // series. Author familiarity alone is insufficient — a reader may know Robin
  // Hobb well but never have started the Liveship Traders series.
  const suppressedIds = new Set<string>();

  function suppressBook(item: Annotated, reason: string) {
    suppressedIds.add(rilId(item.book));
    (item.book._score_breakdown as Record<string, unknown>)['ril_suppressed'] = true;
    (item.book._score_breakdown as Record<string, unknown>)['ril_reason']     = reason;
  }

  function hasStartedSeries(seriesName: string): boolean {
    return seriesReadSet.has(normKey(seriesName));
  }

  for (const [, group] of seriesGroups) {
    group.members.sort(
      (a, b) => (a.series?.series_position ?? 99) - (b.series?.series_position ?? 99)
    );

    const [best, ...rest] = group.members;
    const bestPos         = best.series!.series_position;
    const seriesName      = best.series!.series_name;
    const bestStarted     = hasStartedSeries(seriesName);

    // Suppress redundant higher-position members when user hasn't started this series
    for (const item of rest) {
      if (!hasStartedSeries(seriesName)) {
        suppressBook(item, `series_dedup: #${item.series!.series_position} suppressed; best entry point is #${bestPos} [${item.series!.detection_method}/${item.series!.confidence}]`);
      }
    }

    // Suppress even the "best" pool member if it's still a continuation
    // and user hasn't started this specific series. Fires even for solo pool members.
    if (bestPos > 1 && !bestStarted) {
      suppressBook(best, `series_no_entry_point: #${bestPos} suppressed; user has not started ${seriesName} [${best.series!.detection_method}/${best.series!.confidence}]`);
    }
  }

  // ── Step 4: Partition ─────────────────────────────────────────────────────
  const visible:             ScoredBook[] = [];
  const integritySuppressed: ScoredBook[] = [];

  for (const { book } of annotated) {
    if (suppressedIds.has(rilId(book))) integritySuppressed.push(book);
    else                                visible.push(book);
  }

  return { visible, integritySuppressed };
}
