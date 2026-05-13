// ─── Trait-copy humanization ─────────────────────────────────────────────────
// Single source of truth for turning raw recommender trait keys into natural,
// reader-facing language. Used by:
//   • lib/recommender.ts       — assembling "Aligns with..." / "Matches..." reasons[]
//   • components/RecCard.tsx   — reason-pool rendering (single-trait fallback)
//
// Vocabulary spans two domains:
//   • Long-form keys from the recommender enrichment map and TasteProfile
//     preferred_traits when seeded from rating data
//     (literary_prose, emotionality, worldbuilding, romance_intensity, ...)
//   • Short-form keys from raw user taste_tags.liked entries written by the
//     in-app rating UI (prose, emotional, characters, pacing, ...)
//
// Both forms must humanize cleanly — the pre-fix bug was that NEITHER form was
// being humanized at the join site, so phrases like "prose and emotional"
// reached the user (FX-1, audit shipped 2026-05-13).

const TRAIT_HUMAN: Record<string, string> = {
  // Long-form (recommender enrichment / preferred_traits computed vocab)
  literary_prose:    'literary writing',
  emotionality:      'emotional weight',
  worldbuilding:     'immersive worldbuilding',
  romance_intensity: 'romantic intensity',
  practicality:      'practical depth',

  // Short-form (raw user taste_tags.liked vocab)
  prose:             'literary writing',
  emotional:         'emotional weight',
  characters:        'character-driven storytelling',
  pacing:            'forward momentum',
  insight:           'ideas worth sitting with',
  originality:       'a genuinely fresh feel',
  suspense:          'real suspense',
  depth:             'substance',
  romance:           'romantic intensity',
};

// Bucket two synonymous keys (e.g. literary_prose + prose) under one canonical
// label so the curated pair table doesn't need duplicate entries.
function canonical(key: string): string {
  const k = key.toLowerCase().trim();
  if (k === 'literary_prose')    return 'prose';
  if (k === 'emotionality')      return 'emotional';
  if (k === 'romance_intensity') return 'romance';
  return k;
}

// Curated phrasings for the most common 2-trait combinations. Designed to
// read as natural recommendation reasoning, not as "{trait_a} and {trait_b}"
// coordination — the pre-fix join produced ungrammatical output whenever the
// keys were heterogeneous parts of speech (noun + adjective).
//
// Lookup is order-insensitive (we try both "a+b" and "b+a"). Long-tail combos
// not in this table fall back to the dominant single-trait phrase rather than
// risking a malformed pair — see composeTraitPhrase().
const PAIR_TABLE: Record<string, string> = {
  'prose+emotional':           'literary writing with real emotional weight',
  'characters+emotional':      'character-driven storytelling with real emotional pull',
  'pacing+insight':            'forward momentum that still gives you ideas to sit with',
  'depth+originality':         'substantive, genuinely fresh writing',
  'prose+pacing':              'literary writing that still moves',
  'emotional+pacing':          'emotional weight at a propulsive pace',
  'suspense+pacing':           'tight, propulsive suspense',
  'prose+insight':             'literary writing with ideas worth sitting with',
  'emotional+insight':         'emotional weight paired with ideas to sit with',
  'worldbuilding+pacing':      'immersive worldbuilding at a strong clip',
  'worldbuilding+originality': 'rich worldbuilding with a genuinely fresh feel',
  'prose+characters':          'character-driven literary writing',
  'prose+depth':               'literary writing with real substance',
  'emotional+depth':           'emotional weight with real substance',
  'characters+pacing':         'character-driven storytelling that still moves',
  'characters+insight':        'character-driven storytelling with ideas to sit with',
  'suspense+emotional':        'real suspense with emotional pull',
  'romance+emotional':         'romantic intensity with real emotional weight',
};

// Defensive re-humanization for downstream renderers (e.g. RecCard's
// rewriteReasonText) that receive the captured `${x}` from a regex match on
// a recommender reason string. Closes the legacy-cache leak path: pre-FX-1
// recommender results persisted in `recCache` carry raw concatenations like
// "prose and emotional" or bare keys like "emotional". This helper detects
// that shape and re-runs humanization; already-humanized phrases ("literary
// writing with real emotional weight", "emotional weight") pass through
// unchanged because their tokens aren't in the trait-key vocabulary.
//
// Detection rule: split on " and ", check if EVERY token (lowercased,
// trimmed) is in the known trait-key vocabulary. If yes → recompose via
// composeTraitPhrase. If no → return input unchanged (don't risk damaging
// already-good copy from new computations).
export function rehumanizeReasonPhrase(captured: string): string {
  const tokens = captured.split(/\s+and\s+/i).map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return captured;
  const allKnown = tokens.every(t => {
    const k = t.toLowerCase();
    return k in TRAIT_HUMAN;
  });
  if (!allKnown) return captured;
  return composeTraitPhrase(tokens);
}

export function humanizeTraitKey(key: string): string {
  const k = key.toLowerCase().trim();
  if (TRAIT_HUMAN[k]) return TRAIT_HUMAN[k];
  // Long-tail unknown key: snake_case → space-separated, keeps render legible
  // while flagging in dev console that the map needs expansion.
  return k.replace(/_/g, ' ');
}

// Returns a natural noun phrase for 1 or 2 trait keys.
//
// For 2 keys: consults PAIR_TABLE first (order-insensitive). On miss, falls
// back to the dominant single-trait phrase ALONE — this is intentional: the
// pre-fix `join(' and ')` of mixed-POS keys was the original bug, and emitting
// only the strongest signal is strictly better than risking a broken pair.
//
// For 1 key: returns humanizeTraitKey directly.
//
// For 0 keys: returns empty string (caller must check before composing).
export function composeTraitPhrase(rawKeys: string[]): string {
  if (rawKeys.length === 0) return '';
  if (rawKeys.length === 1) return humanizeTraitKey(rawKeys[0]);

  const a = canonical(rawKeys[0]);
  const b = canonical(rawKeys[1]);
  if (a === b) return humanizeTraitKey(rawKeys[0]);

  const curated = PAIR_TABLE[`${a}+${b}`] ?? PAIR_TABLE[`${b}+${a}`];
  if (curated) return curated;

  // Long-tail combo: dominant trait only, no risky coordination.
  return humanizeTraitKey(rawKeys[0]);
}
