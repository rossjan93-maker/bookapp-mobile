// =============================================================================
// Taste Readout copy — pure helpers that turn TasteProfile + reader_preferences
// data into human-readable strings for the post-intake "Here's what we heard"
// surface (components/TasteReadout.tsx).
//
// All functions here are pure. No IO, no side effects, no LLM calls.
// Hedging rules:
//   - Tier 0 → "Your starting picture" framing, no hard claims.
//   - Tier 1 → "Early signal" framing.
//   - Tier 2+ → confident framing allowed.
//   - Avoided traits surfaced ONLY when confidence is 'high' (tier 3) so we
//     don't tell a user "you avoid X" from one or two dismissals.
// =============================================================================

import type { TasteProfile, DeterministicLane } from './tasteProfile';

// ── Lane labels (mirror RecCard.EXPLANATION_LANE_LABELS) ─────────────────────
// Kept local so this module has zero dependencies beyond TasteProfile types.

const LANE_LABELS: Record<DeterministicLane, string> = {
  romantasy:            'romantic fantasy',
  scifi_fantasy:        'fantasy and speculative fiction',
  modern_suspense:      'psychological suspense',
  romance:              'emotionally driven romance',
  contemporary_fiction: 'contemporary fiction',
  memoir_nonfiction:    'narrative nonfiction',
  literary:             'literary fiction',
  horror:               'dark atmospheric fiction',
};

// ── Genre-key humanisation ───────────────────────────────────────────────────
// Maps the snake_case keys used in TasteProfile.genre_affinities and the
// reader_preferences.favorite_genres array to display-friendly labels.

const GENRE_LABELS: Record<string, string> = {
  thriller_mystery:     'Thriller & mystery',
  literary_fiction:     'Literary fiction',
  contemporary_fiction: 'Contemporary fiction',
  romance:              'Romance',
  romantasy:            'Romantic fantasy',
  fantasy:              'Fantasy',
  sci_fi:               'Sci-fi',
  scifi:                'Sci-fi',
  scifi_fantasy:        'Sci-fi & fantasy',
  // Aliases for keys returned by lib/bookTraits.ts `detectGenre` so V2 learning
  // toasts ("Got it — leaning toward more X picks.") humanise cleanly. Note:
  // `literary` is defined further down in this table and is upgraded there from
  // 'Literary' → 'Literary fiction' to keep that wording consistent here too.
  fantasy_scifi:        'Sci-fi & fantasy',
  memoir_bio:           'Memoir & biography',
  horror:               'Horror',
  historical_fiction:   'Historical fiction',
  young_adult:          'Young adult',
  ya:                   'Young adult',
  memoir:               'Memoir',
  memoir_nonfiction:    'Memoir & narrative nonfiction',
  nonfiction:           'Nonfiction',
  biography:            'Biography',
  business:             'Business',
  self_help:            'Self-help',
  poetry:               'Poetry',
  classics:             'Classics',
  literary:             'Literary fiction',
};

export function humanizeGenreKey(key: string): string {
  if (!key) return '';
  const direct = GENRE_LABELS[key.toLowerCase()];
  if (direct) return direct;
  // Fallback: replace underscores, sentence-case the result.
  const cleaned = key.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function humanizeLaneKey(lane: DeterministicLane): string {
  return LANE_LABELS[lane] ?? lane.replace(/_/g, ' ');
}

// ── Trait-key humanisation ───────────────────────────────────────────────────
// TasteProfile.preferred_traits / avoided_traits keys come from the trait
// model in lib/bookTraits.ts. We surface them as short noun phrases.

const TRAIT_LABELS: Record<string, { liked: string; avoided: string }> = {
  pacing:             { liked: 'fast pacing',          avoided: 'slow pacing' },
  emotionality:       { liked: 'emotional depth',      avoided: 'heavy emotion' },
  worldbuilding:      { liked: 'rich worldbuilding',   avoided: 'dense worldbuilding' },
  prose:              { liked: 'literary prose',       avoided: 'dense prose' },
  literary_prose:     { liked: 'literary prose',       avoided: 'dense prose' },
  insight:            { liked: 'thoughtful insight',   avoided: 'heavy theorising' },
  suspense:           { liked: 'suspense and tension', avoided: 'high tension' },
  originality:        { liked: 'unusual premises',     avoided: 'unconventional structure' },
  romance_intensity:  { liked: 'strong romance',       avoided: 'foregrounded romance' },
  practicality:       { liked: 'practical takeaways',  avoided: 'how-to framing' },
  humor:              { liked: 'humour',               avoided: 'comic tone' },
  darkness:           { liked: 'dark themes',          avoided: 'dark themes' },
  violence:           { liked: 'visceral action',      avoided: 'graphic violence' },
};

export function humanizeTraitKey(key: string, kind: 'liked' | 'avoided'): string {
  const entry = TRAIT_LABELS[key.toLowerCase()];
  if (entry) return entry[kind];
  // Fallback: humanise the key itself.
  return key.replace(/[_-]+/g, ' ').toLowerCase();
}

// ── Top-N selectors ──────────────────────────────────────────────────────────
// All selectors are tolerant of missing / empty data. Never throw.

export function topGenresFromProfile(profile: TasteProfile, n: number = 3): string[] {
  const aff = profile.genre_affinities ?? {};
  return Object.entries(aff)
    .filter(([, w]) => typeof w === 'number' && w > 0.15)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, n)
    .map(([k]) => humanizeGenreKey(k));
}

export function topPreferredTraits(profile: TasteProfile, n: number = 3): string[] {
  const traits = profile.preferred_traits ?? {};
  return Object.entries(traits)
    .filter(([, w]) => typeof w === 'number' && w > 0.2)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, n)
    .map(([k]) => humanizeTraitKey(k, 'liked'));
}

export function topAvoidedTraits(profile: TasteProfile, n: number = 2): string[] {
  // Only surface avoided traits when overall confidence is high. Otherwise
  // we risk telling the user "you avoid X" from very thin signal.
  if (profile.confidence !== 'high') return [];
  const traits = profile.avoided_traits ?? {};
  return Object.entries(traits)
    .filter(([, w]) => typeof w === 'number' && w > 0.25)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, n)
    .map(([k]) => humanizeTraitKey(k, 'avoided'));
}

export function topAuthors(profile: TasteProfile, n: number = 3): string[] {
  return (profile.liked_authors ?? []).slice(0, n);
}

/**
 * UX-3B: surface avoid-genre intake selections as "Less of: X" chips.
 *
 * These come straight from reader_preferences.avoid_genres (raw display
 * labels like "Horror" or "Literary Fiction" written by IntakeAvoid). We
 * humanise defensively in case future writers store snake_case keys, and
 * we de-dupe against the user's liked-genre intake list so a contradictory
 * row in the DB cannot produce a "Loves X / Less of: X" pair.
 *
 * Cap defaults to 2 — keeps the chip row calm even if the user picked
 * many avoid genres during intake.
 */
export function topAvoidGenres(
  avoidGenres: string[] | null | undefined,
  favoriteGenres: string[] | null | undefined,
  n: number = 2,
): string[] {
  const avoid = Array.isArray(avoidGenres) ? avoidGenres : [];
  if (avoid.length === 0) return [];
  const liked = new Set(
    (Array.isArray(favoriteGenres) ? favoriteGenres : []).map(g => g.trim().toLowerCase()),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of avoid) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (liked.has(trimmed.toLowerCase())) continue;
    const label = humanizeGenreKey(trimmed);
    const dedupKey = label.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push(label);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * UX-3E: surface q_outcome (UX-3C) as a "Reading for: X" stated-preference
 * chip. Reads from reader_preferences.diagnosis_answers — written by the
 * intake_outcome step in RecEntryScreen. Pure key-to-label lookup. Returns
 * null when the user skipped the outcome question or picked an unknown key,
 * so the caller can omit the chip cleanly.
 */
const OUTCOME_LABELS: Record<string, string> = {
  effortless:        'escape',
  craft_first:       'depth',
  originality_first: 'surprise',
  grip_both:         'range',
};

export function topOutcomeChip(
  diagnosisAnswers: Record<string, string> | null | undefined,
): string | null {
  const ans = diagnosisAnswers?.q_outcome;
  if (typeof ans !== 'string') return null;
  const label = OUTCOME_LABELS[ans];
  return label ? `Reading for: ${label}` : null;
}

/**
 * UX-3E: surface q_tone (UX-3D) as a "Tone: X" stated-preference chip.
 * Pure lookup. tone_flexible deliberately returns null — a "flexible" chip
 * adds no useful signal to the user and just crowds the row.
 */
const TONE_LABELS: Record<string, string> = {
  dark_tone:  'darker',
  light_tone: 'lighter',
  // tone_flexible intentionally omitted — render nothing.
};

export function topToneChip(
  diagnosisAnswers: Record<string, string> | null | undefined,
): string | null {
  const ans = diagnosisAnswers?.q_tone;
  if (typeof ans !== 'string') return null;
  const label = TONE_LABELS[ans];
  return label ? `Tone: ${label}` : null;
}

export function topDominantLanes(profile: TasteProfile, n: number = 2): string[] {
  const lanes = profile.det_lanes?.dominant_lanes ?? [];
  return lanes.slice(0, n).map(humanizeLaneKey);
}

// ── Headline / summary / learning copy ───────────────────────────────────────

export function buildHeadline(): string {
  return "Here's what we heard";
}

// ── FS-5a: intake-only synthesis helpers ─────────────────────────────────────
// Composable pieces used by buildSummary's intake-only path. Each helper is
// tolerant of missing data and returns a small string fragment (or null) so
// the top-level sentence can be assembled from whichever signals we actually
// have. NONE of these imply reading history — they describe stated preferences
// only and use forward-looking ("we'll steer toward…") language.

/**
 * Maps the many possible genre-key shapes (snake_case from intake, display
 * labels from the avoid path, humanized labels from earlier writers) to a
 * small set of canonical "buckets" used for cluster phrasing. Anything not
 * in this table falls through to a generic two-genre / one-genre cluster.
 */
const GENRE_BUCKETS: Record<string, string> = {
  'sci-fi':                          'speculative',
  'sci_fi':                          'speculative',
  'scifi':                           'speculative',
  'fantasy':                         'speculative',
  'sci-fi & fantasy':                'speculative',
  'scifi_fantasy':                   'speculative',
  'fantasy_scifi':                   'speculative',
  'thriller & mystery':              'thriller',
  'thriller_mystery':                'thriller',
  'mystery':                         'thriller',
  'thriller':                        'thriller',
  'literary fiction':                'literary',
  'literary_fiction':                'literary',
  'literary':                        'literary',
  'romance':                         'romance',
  'romantic fantasy':                'romance',
  'romantasy':                       'romance',
  'contemporary fiction':            'contemporary',
  'contemporary_fiction':            'contemporary',
  'memoir':                          'memoir',
  'memoir & biography':              'memoir',
  'memoir_bio':                      'memoir',
  'biography':                       'memoir',
  'memoir_nonfiction':               'memoir',
  'memoir & narrative nonfiction':   'memoir',
  'nonfiction':                      'nonfiction',
  'business':                        'nonfiction',
  'self-help':                       'nonfiction',
  'self_help':                       'nonfiction',
  'horror':                          'horror',
  'historical fiction':              'historical',
  'historical_fiction':              'historical',
  'young adult':                     'ya',
  'young_adult':                     'ya',
  'ya':                              'ya',
  'classics':                        'classics',
  'poetry':                          'poetry',
};

function bucketOfGenre(g: string): string | null {
  if (typeof g !== 'string') return null;
  return GENRE_BUCKETS[g.trim().toLowerCase()] ?? null;
}

/**
 * Build a short noun phrase describing the user's liked-genre cluster, with
 * tone prefix folded in when stated. Hand-tuned for the most common pairs;
 * everything else falls through to a generic "{a} and {b}" or "{a}" form.
 */
function describeGenreCluster(
  favoriteGenres: string[],
  tone: string | null | undefined,
): string {
  const keys = (favoriteGenres ?? [])
    .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    .slice(0, 3);
  if (keys.length === 0) return '';

  const buckets = new Set(
    keys.map(bucketOfGenre).filter((x): x is string => x != null),
  );
  const has = (b: string) => buckets.has(b);

  const tonePrefix =
    tone === 'dark_tone'  ? 'darker '  :
    tone === 'light_tone' ? 'lighter ' :
    '';

  // Hand-tuned pairs first — most common intake combinations.
  if (has('speculative') && has('thriller'))    return `${tonePrefix}speculative stories and tight thrillers`;
  if (has('speculative') && has('romance'))     return `${tonePrefix}speculative fiction with a romantic pull`;
  if (has('speculative') && has('horror'))      return `${tonePrefix}speculative fiction with a horror edge`;
  if (has('speculative') && has('literary'))    return `${tonePrefix}speculative fiction with a literary bent`;
  if (has('thriller')    && has('literary'))    return `${tonePrefix}literary thrillers and suspense`;
  if (has('thriller')    && has('horror'))      return `${tonePrefix}thrillers with a horror edge`;
  if (has('romance')     && has('contemporary')) return `${tonePrefix}contemporary romance and relationship-driven fiction`;
  if (has('memoir')      && has('nonfiction'))  return 'memoir and big-picture nonfiction';

  // Single-bucket forms.
  if (has('speculative')) return `${tonePrefix}speculative fiction`;
  if (has('thriller'))    return `${tonePrefix}thrillers and suspense`;
  if (has('romance'))     return `${tonePrefix}romance`;
  if (has('literary'))    return `${tonePrefix}literary fiction`;
  if (has('contemporary')) return `${tonePrefix}contemporary fiction`;
  if (has('historical'))  return `${tonePrefix}historical fiction`;
  if (has('horror'))      return `${tonePrefix}horror and dark fiction`;
  if (has('memoir'))      return 'memoir and narrative nonfiction';
  if (has('nonfiction'))  return 'nonfiction reads';
  if (has('ya'))          return `${tonePrefix}young adult fiction`;
  if (has('classics'))    return `${tonePrefix}classics`;
  if (has('poetry'))      return 'poetry';

  // Generic fallback when no buckets matched — humanize and join.
  if (keys.length >= 2) {
    const a = humanizeGenreKey(keys[0]).toLowerCase();
    const b = humanizeGenreKey(keys[1]).toLowerCase();
    return `${tonePrefix}${a} and ${b}`;
  }
  return `${tonePrefix}${humanizeGenreKey(keys[0]).toLowerCase()}`;
}

/** Verb phrases for the q_outcome answer keys. Forward-looking, never claims
 *  the user *has* read this way. Unknown keys → null (omit the clause). */
const OUTCOME_VERBS: Record<string, string> = {
  craft_first:       'reward attention',
  effortless:        'go down easy',
  originality_first: 'surprise you',
  grip_both:         'do a few things at once',
};

/**
 * Build the optional middle clause ("that move quickly but still reward
 * attention", etc.) from pacing and outcome signals. Returns '' when neither
 * signal is present, so the caller can omit it cleanly. Uses "but still" only
 * for the genuine tension case (fast + craft_first); other combinations use
 * "and", which is more honest.
 */
function describeMiddleClause(
  wantsFast: boolean,
  outcome: string | null | undefined,
): string {
  const verb = outcome ? OUTCOME_VERBS[outcome] ?? null : null;
  if (wantsFast && verb) {
    const conjunction = outcome === 'craft_first' ? 'but still' : 'and';
    return `that move quickly ${conjunction} ${verb}`;
  }
  if (wantsFast) return 'that move quickly';
  if (verb)      return `that ${verb}`;
  return '';
}

/**
 * Build the optional second sentence describing avoid-genres as a forward-
 * looking commitment ("We'll steer away from business-heavy picks."). Reuses
 * topAvoidGenres so the favorite-vs-avoid contradiction guard from UX-3B
 * applies here too. Returns null when there are no usable avoid genres.
 */
function describeAvoidSentence(
  avoidGenres: string[],
  favoriteGenres: string[],
): string | null {
  const avoid = topAvoidGenres(avoidGenres, favoriteGenres, 2);
  if (avoid.length === 0) return null;
  if (avoid.length === 1) {
    const a = avoid[0].toLowerCase();
    // "business-heavy" reads cleanly for single-token labels;
    // multi-word labels ("young adult", "literary fiction", "self-help"
    // is hyphenated and reads OK either way) get the gentler "out of the mix"
    // form to avoid clunky concatenations like "literary fiction-heavy".
    if (!/\s/.test(a)) return `We'll steer away from ${a}-heavy picks.`;
    return `We'll keep ${a} out of the mix.`;
  }
  return `We'll keep ${avoid[0].toLowerCase()} and ${avoid[1].toLowerCase()} out of the mix.`;
}

/**
 * Compose an intake-only synthesis sentence (plus optional avoid sentence)
 * from the user's stated preferences. Returns null when we don't have enough
 * "rich" signal beyond a single liked genre — in that case the caller falls
 * back to the existing single-line hedge so we don't ship a flat or robotic
 * synthesized sentence for thin intake users.
 *
 * "Rich" = at least one of: q_outcome, q_tone (non-flexible), an avoid
 * genre, or a fast-pacing signal (from q_pacing or preferred_traits). A user
 * with two liked genres but no other signals also qualifies as rich enough,
 * since the cluster phrasing alone is meaningfully better than echo.
 */
function buildIntakeSynthesis(
  profile: TasteProfile | null,
  favoriteGenres: string[],
  avoidGenres: string[],
  diagnosisAnswers: Record<string, string> | null,
): string | null {
  const genres = (favoriteGenres ?? []).filter(
    (g): g is string => typeof g === 'string' && g.trim().length > 0,
  );
  if (genres.length === 0) return null;

  const outcome = diagnosisAnswers?.q_outcome ?? null;
  const tone    = diagnosisAnswers?.q_tone ?? null;
  const pacingAns = diagnosisAnswers?.q_pacing ?? null;

  const validOutcome = outcome != null && outcome in OUTCOME_VERBS;
  const validTone    = tone === 'dark_tone' || tone === 'light_tone';
  const hasAvoid     = topAvoidGenres(avoidGenres, favoriteGenres, 2).length > 0;

  // Fast pacing can come from intake (q_pacing === 'fast_paced') OR from a
  // history-derived preferred-traits signal. Either source is enough.
  const fastFromIntake = pacingAns === 'fast_paced';
  const fastFromTraits = profile
    ? topPreferredTraits(profile, 3).includes('fast pacing')
    : false;
  const wantsFast = fastFromIntake || fastFromTraits;

  const richSignals =
    (validOutcome ? 1 : 0) +
    (validTone    ? 1 : 0) +
    (hasAvoid     ? 1 : 0) +
    (wantsFast    ? 1 : 0) +
    (genres.length >= 2 ? 1 : 0);

  if (richSignals === 0) return null;

  const cluster = describeGenreCluster(genres, validTone ? tone : null);
  if (!cluster) return null;
  const middle  = describeMiddleClause(wantsFast, validOutcome ? outcome : null);
  const sentence1 = `You're pointing Readstack toward ${cluster}${middle ? ` ${middle}` : ''}.`;
  const avoidSentence = describeAvoidSentence(avoidGenres, favoriteGenres);
  return avoidSentence ? `${sentence1} ${avoidSentence}` : sentence1;
}

/**
 * Short summary anchored to the strongest available signal. Hedged for tier
 * 0/1, confident for tier 2+ ONLY when the anchor comes from derived signal
 * (lane or genre_affinities). When the anchor is intake-only, we either
 * synthesize a richer sentence from stated preferences (FS-5a) or fall back
 * to the existing single-line hedge — never overstating confidence on a
 * self-reported preference.
 *
 * Priority of the anchoring signal:
 *   1. Dominant deterministic lane (dense importers only) — derived.
 *   2. Top genre from genre_affinities — derived.
 *   3. Intake synthesis (FS-5a) when stated signal is rich enough — stated.
 *   4. First favorite_genres entry from reader_preferences — intake-only hedge.
 *   5. Generic fallback ("a starting picture").
 *
 * The new optional `avoidGenres` and `diagnosisAnswers` arguments default to
 * safe values so older callers keep working unchanged.
 */
export function buildSummary(
  profile: TasteProfile | null,
  favoriteGenres: string[],
  avoidGenres: string[] = [],
  diagnosisAnswers: Record<string, string> | null = null,
): string {
  const tier = profile?.tier ?? 0;
  const lane = profile ? topDominantLanes(profile, 1)[0] : undefined;
  const genre = profile ? topGenresFromProfile(profile, 1)[0] : undefined;

  // Derived anchor wins — history-rich users get the same tier-aware copy as
  // before. The new synthesis path is intake-only and never weakens this.
  if (lane) {
    if (tier === 0) return `Your starting picture leans toward ${lane.toLowerCase()}.`;
    if (tier === 1) return `Early signal: you lean toward ${lane.toLowerCase()}.`;
    return `You read ${lane.toLowerCase()} with a clear pattern we can work with.`;
  }
  if (genre) {
    if (tier === 0) return `Your starting picture leans toward ${genre.toLowerCase()}.`;
    if (tier === 1) return `Early signal: you lean toward ${genre.toLowerCase()}.`;
    return `You read ${genre.toLowerCase()} with a clear pattern we can work with.`;
  }

  // Intake-only path — try the richer FS-5a synthesis first.
  const synth = buildIntakeSynthesis(profile, favoriteGenres, avoidGenres, diagnosisAnswers);
  if (synth) return synth;

  // Fallback hedge for thin intake (single genre, no rich stated signal).
  const intakeGenre = (favoriteGenres ?? [])[0];
  if (intakeGenre) {
    return `You told us you lean toward ${humanizeGenreKey(intakeGenre).toLowerCase()} — that's where we'll start.`;
  }

  return 'Your starting picture is just forming. The more you save, dismiss, and rate, the sharper this gets.';
}

export function buildLearningLine(profile: TasteProfile | null): string {
  const tier = profile?.tier ?? 0;
  if (tier >= 2) {
    return 'This sharpens further as you save, dismiss, and rate what we suggest.';
  }
  return 'This is a starting picture. It sharpens as you save, dismiss, and rate books.';
}

// ── Chips (signal bullets) ───────────────────────────────────────────────────
// Returns 2-4 short labels for the chip row. Always returns at least one chip
// when any signal exists (intake genres count). Empty array means "no chips,
// fall through to thin-state copy".

export type ReadoutChip = {
  /** "genre" | "trait" | "avoided" | "author" | "stated" — drives the chip
   *  styling. 'stated' is for UX-3E q_outcome / q_tone intake answers — it
   *  shares the warm-neutral styling with 'avoided' so the user reads them
   *  as informational ("you told us") rather than high-confidence derived. */
  kind: 'genre' | 'trait' | 'avoided' | 'author' | 'stated';
  label: string;
};

export function buildChips(
  profile: TasteProfile | null,
  favoriteGenres: string[],
  avoidGenres: string[] = [],
  diagnosisAnswers: Record<string, string> | null = null,
): ReadoutChip[] {
  const chips: ReadoutChip[] = [];

  // 1. Genres — prefer derived genre_affinities, fall back to intake.
  const derivedGenres = profile ? topGenresFromProfile(profile, 2) : [];
  const genres = derivedGenres.length > 0
    ? derivedGenres
    : (favoriteGenres ?? []).slice(0, 2).map(humanizeGenreKey);
  for (const g of genres) {
    if (g && !chips.some(c => c.label === g)) {
      chips.push({ kind: 'genre', label: g });
    }
  }

  // 2. Stated outcome / tone (UX-3E) — surfaced near the top because they're
  // the most recent explicit signal (user literally just answered) and they
  // anchor the *why* of this session, which complements the *what* (genres).
  // 'stated' kind = warm-neutral styling so it doesn't read as a derived
  // claim about the user's history.
  const outcomeChip = topOutcomeChip(diagnosisAnswers);
  if (outcomeChip) {
    chips.push({ kind: 'stated', label: outcomeChip });
  }
  const toneChip = topToneChip(diagnosisAnswers);
  if (toneChip) {
    chips.push({ kind: 'stated', label: toneChip });
  }
  // UX-3E contradiction guard: if the user said dark_tone, suppress any
  // future "Less of: dark themes" avoided-trait chip below — and vice
  // versa for light_tone. The avoided-trait pool only surfaces 'darkness'
  // at high confidence, so the collision is rare but ugly when it happens.
  const toneAns = diagnosisAnswers?.q_tone;
  const suppressAvoidedTrait = new Set<string>();
  if (toneAns === 'dark_tone')  suppressAvoidedTrait.add('Less of: dark themes');
  if (toneAns === 'light_tone') {
    // light_tone + "Less of: dark themes" is consistent — keep it.
    // No suppression needed; both reinforce.
  }

  // 3. Preferred traits.
  if (profile) {
    for (const t of topPreferredTraits(profile, 2)) {
      if (t && !chips.some(c => c.label === t)) {
        chips.push({ kind: 'trait', label: t });
      }
    }
  }

  // 4. Avoid genres (UX-3B) — straight from intake, no recommender claim.
  // Surfaced before avoided traits because they're a stronger explicit signal
  // (the user just told us during intake) and shouldn't be crowded out.
  for (const g of topAvoidGenres(avoidGenres, favoriteGenres, 2)) {
    const label = `Less of: ${g}`;
    if (!chips.some(c => c.label === label)) {
      chips.push({ kind: 'avoided', label });
    }
  }

  // 5. Avoided traits — high confidence only (handled inside topAvoidedTraits).
  if (profile) {
    for (const t of topAvoidedTraits(profile, 1)) {
      if (t) {
        const label = `Less of: ${t}`;
        if (suppressAvoidedTrait.has(label)) continue;
        if (!chips.some(c => c.label === label)) {
          chips.push({ kind: 'avoided', label });
        }
      }
    }
  }

  // 6. Authors — only when we have at least 2 (so a single book's author
  // doesn't get elevated to "your authors").
  if (profile && (profile.liked_authors?.length ?? 0) >= 2) {
    const author = profile.liked_authors[0];
    if (author && !chips.some(c => c.label === author)) {
      chips.push({ kind: 'author', label: author });
    }
  }

  // Cap at 6 chips so the surface stays calm. Bumped from 5 in UX-3E to
  // give the new stated-preference signals room without crowding out
  // existing avoid-genre / author chips that UX-3B already balanced for.
  return chips.slice(0, 6);
}

// ── Thin-state detection ─────────────────────────────────────────────────────

/**
 * True when we have effectively no signal at all — neither derived profile
 * data nor intake answers. The caller should render the lightweight thin-state
 * copy in that case.
 */
export function isThinReadout(
  profile: TasteProfile | null,
  favoriteGenres: string[],
): boolean {
  if (!profile) return (favoriteGenres ?? []).length === 0;
  const hasGenres = Object.keys(profile.genre_affinities ?? {}).length > 0;
  const hasTraits = Object.keys(profile.preferred_traits ?? {}).length > 0;
  const hasAuthors = (profile.liked_authors ?? []).length > 0;
  const hasIntake = (favoriteGenres ?? []).length > 0;
  return !hasGenres && !hasTraits && !hasAuthors && !hasIntake;
}

export const THIN_READOUT_COPY =
  "Your profile is just getting started. We'll use your first saves, skips, and ratings to sharpen your recommendations.";
