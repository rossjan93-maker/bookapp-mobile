/**
 * Alias expansion for high-frequency fandom shorthand.
 *
 * When a user types a known abbreviation ("acotar", "lotr", "hp"), expand it
 * to the full canonical title phrase before retrieval. The expanded string
 * flows through the normal confidence architecture unchanged — "a court of
 * thorns and roses" scores exact-match (1000 HIGH) against OL's result for
 * that title, so the right series book surfaces at #1 with no coloring-book
 * noise.
 *
 * Keys   → normalized input: lowercase, letters + digits only (no spaces/punctuation)
 * Values → the expanded title query sent to Open Library
 *
 * Expansion runs only for exact key matches. Unknown abbreviations fall through
 * to the normal search path unchanged.
 */

const ALIAS_TABLE: Record<string, string> = {
  // ── A Court of Thorns and Roses ──────────────────────────────────────────
  acotar:  'a court of thorns and roses',
  acomaf:  'a court of mist and fury',
  acofas:  'a court of frost and starlight',
  acosas:  'a court of silver flames',
  acowar:  'a court of wings and ruin',

  // ── Lord of the Rings ─────────────────────────────────────────────────────
  lotr:    'lord of the rings',
  fotr:    'the fellowship of the ring',
  ttt:     'the two towers',
  rotk:    'the return of the king',

  // ── Harry Potter ──────────────────────────────────────────────────────────
  hp:      'harry potter',
  hpss:    'harry potter sorcerers stone',
  hpcos:   'harry potter chamber of secrets',
  hppoa:   'harry potter prisoner of azkaban',
  hpgof:   'harry potter goblet of fire',
  hpootp:  'harry potter order of the phoenix',
  hphbp:   'harry potter half blood prince',
  hpdh:    'harry potter deathly hallows',

  // ── A Song of Ice and Fire / Game of Thrones ──────────────────────────────
  asoiaf:  'a song of ice and fire',
  got:     'game of thrones',
  agot:    'a game of thrones',
  acok:    'a clash of kings',
  asos:    'a storm of swords',
  affc:    'a feast for crows',
  adwd:    'a dance with dragons',

  // ── Throne of Glass ───────────────────────────────────────────────────────
  tog:     'throne of glass',
  cog:     'crown of midnight',
  hos:     'heir of fire',
  qos:     'queen of shadows',
  eos:     'empire of storms',
  tow:     'tower of dawn',
  koa:     'kingdom of ash',

  // ── Crescent City ─────────────────────────────────────────────────────────
  cc:      'crescent city',
  hoeab:   'house of earth and blood',
  hosab:   'house of sky and breath',
  hofas:   'house of flame and shadow',

  // ── The Empyrean ──────────────────────────────────────────────────────────
  fw:      'fourth wing',
  iw:      'iron flame',

  // ── The Hunger Games ──────────────────────────────────────────────────────
  thg:     'the hunger games',
  cf:      'catching fire',
  tbosas:  'the ballad of songbirds and snakes',

  // ── Six of Crows / Grishaverse ────────────────────────────────────────────
  soc:     'six of crows',
  ck:      'crooked kingdom',
  sab:     'shadow and bone',
  ror:     'ruin and rising',
  sob:     'siege and storm',

  // ── The Mortal Instruments / Shadowhunters ────────────────────────────────
  tmi:     'the mortal instruments',
  cob:     'city of bones',
  coa:     'city of ashes',
  tid:     'the infernal devices',
  cpa:     'clockwork angel',
  cp:      'clockwork prince',
  cps:     'clockwork princess',
  tda:     'the dark artifices',
  tlh:     'the last hours',

  // ── The Raven Cycle ───────────────────────────────────────────────────────
  trc:     'the raven cycle',
  trb:     'the raven boys',

  // ── Divergent ─────────────────────────────────────────────────────────────
  div:     'divergent',

  // ── Mistborn ──────────────────────────────────────────────────────────────
  mb:      'mistborn',
  tfe:     'the final empire',
  woa:     'the well of ascension',
  hoa:     'the hero of ages',
};

/**
 * Expand a known fandom abbreviation to its full title query.
 *
 * Returns the expanded string on a match, or null if the query is not a
 * known alias (caller should use the original query unchanged).
 */
export function expandAlias(rawQuery: string): string | null {
  const key = rawQuery.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return ALIAS_TABLE[key] ?? null;
}
