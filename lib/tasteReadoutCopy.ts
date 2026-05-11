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

export function topDominantLanes(profile: TasteProfile, n: number = 2): string[] {
  const lanes = profile.det_lanes?.dominant_lanes ?? [];
  return lanes.slice(0, n).map(humanizeLaneKey);
}

// ── Headline / summary / learning copy ───────────────────────────────────────

export function buildHeadline(): string {
  return "Here's what we heard";
}

/**
 * Short one- or two-sentence summary anchored to the strongest available
 * signal. Hedged for tier 0/1, confident for tier 2+ ONLY when the anchor
 * comes from derived signal (lane or genre_affinities). When the anchor
 * is an intake-only fallback (the user just told us "I like fantasy"), we
 * downgrade to hedged copy regardless of tier so we never overstate
 * confidence on a self-reported preference.
 *
 * Priority of the anchoring signal:
 *   1. Dominant deterministic lane (dense importers only) — derived.
 *   2. Top genre from genre_affinities — derived.
 *   3. First favorite_genres entry from reader_preferences — intake-only.
 *   4. Generic fallback ("a starting picture").
 */
export function buildSummary(
  profile: TasteProfile | null,
  favoriteGenres: string[],
): string {
  const tier = profile?.tier ?? 0;
  const lane = profile ? topDominantLanes(profile, 1)[0] : undefined;
  const genre = profile ? topGenresFromProfile(profile, 1)[0] : undefined;
  const intakeGenre = (favoriteGenres ?? [])[0];
  const intakeGenreLabel = intakeGenre ? humanizeGenreKey(intakeGenre) : undefined;

  // Provenance matters: a derived anchor (lane/genre) earned from finished
  // books supports confident phrasing; an intake-only anchor reflects what
  // the user *said*, not what we *measured*, so it stays hedged.
  let anchor: string | null = null;
  let anchorIsDerived = false;
  if (lane) {
    anchor = lane;
    anchorIsDerived = true;
  } else if (genre) {
    anchor = genre;
    anchorIsDerived = true;
  } else if (intakeGenreLabel) {
    anchor = intakeGenreLabel;
    anchorIsDerived = false;
  }

  if (!anchor) {
    return 'Your starting picture is just forming. The more you save, dismiss, and rate, the sharper this gets.';
  }

  // Intake-only anchor → always hedged, even at high tier.
  if (!anchorIsDerived) {
    return `You told us you lean toward ${anchor.toLowerCase()} — that's where we'll start.`;
  }

  // Derived anchor — tier-aware framing.
  if (tier === 0) {
    return `Your starting picture leans toward ${anchor.toLowerCase()}.`;
  }
  if (tier === 1) {
    return `Early signal: you lean toward ${anchor.toLowerCase()}.`;
  }
  return `You read ${anchor.toLowerCase()} with a clear pattern we can work with.`;
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
  /** "genre" | "trait" | "avoided" | "author" — drives the chip styling. */
  kind: 'genre' | 'trait' | 'avoided' | 'author';
  label: string;
};

export function buildChips(
  profile: TasteProfile | null,
  favoriteGenres: string[],
  avoidGenres: string[] = [],
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

  // 2. Preferred traits.
  if (profile) {
    for (const t of topPreferredTraits(profile, 2)) {
      if (t && !chips.some(c => c.label === t)) {
        chips.push({ kind: 'trait', label: t });
      }
    }
  }

  // 3. Avoid genres (UX-3B) — straight from intake, no recommender claim.
  // Surfaced before avoided traits because they're a stronger explicit signal
  // (the user just told us during intake) and shouldn't be crowded out.
  for (const g of topAvoidGenres(avoidGenres, favoriteGenres, 2)) {
    const label = `Less of: ${g}`;
    if (!chips.some(c => c.label === label)) {
      chips.push({ kind: 'avoided', label });
    }
  }

  // 4. Avoided traits — high confidence only (handled inside topAvoidedTraits).
  if (profile) {
    for (const t of topAvoidedTraits(profile, 1)) {
      if (t && !chips.some(c => c.label === t)) {
        chips.push({ kind: 'avoided', label: `Less of: ${t}` });
      }
    }
  }

  // 5. Authors — only when we have at least 2 (so a single book's author
  // doesn't get elevated to "your authors").
  if (profile && (profile.liked_authors?.length ?? 0) >= 2) {
    const author = profile.liked_authors[0];
    if (author && !chips.some(c => c.label === author)) {
      chips.push({ kind: 'author', label: author });
    }
  }

  // Cap at 5 chips so the surface stays calm. Bumped from 4 in UX-3B to
  // give the new avoid-genre signal room without crowding out authors.
  return chips.slice(0, 5);
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
