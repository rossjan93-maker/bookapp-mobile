// =============================================================================
// Fit Classifier — deterministic center-of-gravity scoring
//
// Every recommended book is classified as:
//   core_fit     — strongly aligned to the user's dominant lanes and reading center
//   adjacent_fit — one believable step from core; consistent, not embarrassing
//   stretch_fit  — explainable via tolerance but not central to reading identity
//   reject       — exception-driven; should never appear in recommendations
//
// For dense users (≥2 dominant lanes OR ≥3 repeated liked authors), the fit
// class is used to adjust the effective ranking score:
//   core_fit    +0.25 / +0.30  (2-signal gate: needs ≥2 of {repeated_author, laneInDominant, primaryPos})
//   adjacent_fit  +0.10 / 0.00 (+0.10 for repeated_author_only; 0.00 otherwise)
//   stretch_fit    −0.20        (pushed below all core and adjacent books)
//   reject         −9999        (filtered out entirely)
//
// For light users (no dominant-lane evidence), the classifier still applies
// conservative reject logic (graphic format, classic canon) but does not
// penalise adjacent/stretch — we have insufficient data to be confident.
//
// Design rule: "Defensible" ≠ "Central."
// A book can be justified by broad overlap and still be wrong for the top slot.
// =============================================================================

import type { TasteProfile }                                from './tasteProfile';
import type { DeterministicLane, MysterySubtype, BookForm } from './bookTraits';

// ── Market-position taxonomy ──────────────────────────────────────────────────
// A coarser classification than genre. Maps to what "type of reading" the book
// represents commercially — used to compare candidate position against the
// user's center of gravity.

export type MarketPosition =
  | 'romantasy'          // romantic fantasy series: Maas, Yarros, Black, Sanderson×romance
  | 'epic_fantasy'       // epic / high fantasy (no strong romance): Hobb, Sanderson, Tolkien, Jordan
  | 'science_fiction'    // hard sci-fi / speculative: Dick, Le Guin, VanderMeer, Stephenson
  | 'horror_dark'        // horror / dark supernatural: King, Pessl, Jackson
  | 'domestic_suspense'  // psychological / domestic thriller: Foley, Moriarty, Mackintosh, Paris
  | 'cozy_detective'     // cozy / puzzle mystery: Christie, Osman, Griffiths, Tursten
  | 'book_club_fiction'  // women's fiction / contemporary emotional: Hannah, Picoult, Hilderbrand, Hoover
  | 'romance'            // contemporary or historical romance (no fantasy): Roberts, Willig, Quinn
  | 'memoir_nonfiction'  // memoir / autobiography / narrative nonfiction: Walls, Carr, Krakauer
  | 'literary_prestige'  // literary fiction / prize-winning: Strout, Morrison, Munro, Auster
  | 'classic_canon'      // pre-1950 canonical / public-domain: Austen, Brontë, Hemingway, Woolf
  | 'graphic_format'     // graphic novel / manga / comic: Spiegelman, Moore, Ware, Satrapi
  | 'general_fiction';   // unclassified contemporary fiction

// ── Fit class ─────────────────────────────────────────────────────────────────

export type FitClass =
  | 'core_fit'     // strongly aligned to user's dominant lanes and reading center
  | 'adjacent_fit' // one step from core; believable and consistent
  | 'stretch_fit'  // explainable via tolerance but not central to reading identity
  | 'reject';      // mostly exception-driven; should not appear in recommendations

// ── Center of gravity ─────────────────────────────────────────────────────────

export type CenterOfGravity = {
  is_dense:           boolean;          // true when enough repeated-pattern evidence exists
  dominant_lanes:     DeterministicLane[];
  repeated_authors:   string[];         // authors with ≥2 loved reads (lowercase)
  commercial_bias:    number;           // 0–1: fraction of dominant lanes that are commercial
  literary_tolerance: number;           // 0–1: from genre_affinities.literary
  memoir_tolerance:   number;           // 0–1: from genre_affinities.memoir_bio
  graphic_tolerance:  number;           // 0–1: conservative — 0 unless evidence found
  suspense_subtype:   MysterySubtype | null;
  has_fantasy_core:   boolean;
  has_suspense_core:  boolean;
  has_romance_core:   boolean;
  has_memoir_core:    boolean;
};

// ── Fit class result ──────────────────────────────────────────────────────────

export type FitClassResult = {
  fit_class:             FitClass;
  market_position:       MarketPosition;
  lane_match_strength:   'strong' | 'weak' | 'none';
  repeated_author_match: boolean;       // author is in user's repeated-liked list
  exception_dependency:  boolean;       // fit relies on one-off tolerance, not repeated pattern
  format_match:          boolean;       // book format matches user's reading medium
  cog_score_delta:       number;        // bonus (+) or penalty (−) applied to ranking score
  fit_reasoning:         string;        // internal debug reason (how class was assigned)
  fit_explanation:       string;        // user-facing explanation line (by class)
};

// ── Score deltas by fit class ─────────────────────────────────────────────────
// Applied on top of the base score before re-ranking.
//
// Principle: repeated behavior should beat broad overlap.
//   repeated_author_match → +0.30  (author evidence is the strongest signal)
//   lane_core_fit          → +0.25  (lane evidence is strong but not as specific)
//   adjacent_fit           →  0.00  (ranked purely on trait/genre score)
//   stretch_fit            → -0.20  (pushed below all core and adjacent)
//   reject                 → -9999  (filtered out entirely)
//
// The extra +0.05 for repeated-author books relative to lane-only core books
// ensures that "same author the user repeatedly returned to" always ranks above
// "different book in the right genre" — which is the correct truthfulness order.

const COG_DELTA: Record<FitClass, number> = {
  core_fit:     +0.25,   // default; overridden to +0.30 for repeated_author + lane
  adjacent_fit: +0.00,
  stretch_fit:  -0.20,
  reject:       -9999,
};

// Repeated author confirmed by a second strong signal (lane OR primary market position)
const COG_DELTA_REPEATED_AUTHOR = +0.30;
// Repeated author only — no lane or primary-market confirmation.
// Earns a small bonus over plain adjacent to keep author evidence visible in ranking,
// but must not reach the +0.25/+0.30 CORE band.
const COG_DELTA_REPEATED_AUTHOR_ADJACENT = +0.10;

// ── Known canonical / classic authors (pre-1950 era) ─────────────────────────

const CLASSIC_CANON_AUTHORS = new Set([
  'jane austen', 'emily brontë', 'charlotte brontë', 'anne brontë',
  'charles dickens', 'leo tolstoy', 'fyodor dostoevsky', 'nikolai gogol',
  'gustave flaubert', 'victor hugo', 'honoré de balzac',
  'ernest hemingway', 'f. scott fitzgerald', 'william faulkner',
  'virginia woolf', 'james joyce', 'george orwell', 'aldous huxley',
  'john steinbeck', 'sinclair lewis', 'willa cather', 'edith wharton',
  'henry james', 'e.m. forster', 'd.h. lawrence', 'thomas hardy',
  'joseph conrad', 'w. somerset maugham', 'h.g. wells',
  'mark twain', 'nathaniel hawthorne', 'herman melville',
  'edgar allan poe', 'arthur conan doyle', 'henry david thoreau',
  'ralph waldo emerson', 'walt whitman', 'william shakespeare',
]);

// ── Lane adjacency map ────────────────────────────────────────────────────────
// For each dominant lane, lists market positions that are "adjacent" (one step
// from core — believable next read) vs. everything else (stretch or reject).

const LANE_ADJACENT_POSITIONS: Record<DeterministicLane, MarketPosition[]> = {
  romantasy:            ['epic_fantasy', 'book_club_fiction', 'romance', 'domestic_suspense'],
  scifi_fantasy:        ['epic_fantasy', 'science_fiction', 'horror_dark', 'book_club_fiction'],
  modern_suspense:      ['domestic_suspense', 'cozy_detective', 'book_club_fiction', 'general_fiction'],
  romance:              ['book_club_fiction', 'romantasy', 'domestic_suspense', 'general_fiction'],
  contemporary_fiction: ['book_club_fiction', 'romance', 'domestic_suspense', 'memoir_nonfiction', 'general_fiction'],
  memoir_nonfiction:    ['literary_prestige', 'book_club_fiction', 'general_fiction'],
  literary:             ['memoir_nonfiction', 'book_club_fiction', 'general_fiction', 'literary_prestige'],
  horror:               ['horror_dark', 'domestic_suspense', 'epic_fantasy', 'science_fiction'],
};

// Primary market positions per dominant lane.
// A position is "primary" if it sits at the centre of that lane, not merely adjacent.
// Used by the two-signal CORE gate: CORE requires at least 2 of
//   {repeated_author_match, laneInDominant, marketPositionIsPrimary}.
const LANE_PRIMARY_POSITIONS: Partial<Record<DeterministicLane, MarketPosition[]>> = {
  romantasy:            ['romantasy'],
  scifi_fantasy:        ['epic_fantasy', 'science_fiction', 'romantasy', 'horror_dark'],
  modern_suspense:      ['domestic_suspense', 'cozy_detective'],
  romance:              ['romance', 'book_club_fiction'],
  contemporary_fiction: ['book_club_fiction'],
  memoir_nonfiction:    ['memoir_nonfiction'],
  literary:             ['literary_prestige'],
  horror:               ['horror_dark'],
};

// ── Public: computeCenterOfGravity ───────────────────────────────────────────

export function computeCenterOfGravity(profile: TasteProfile): CenterOfGravity {
  const det = profile.det_lanes;
  const aff = profile.genre_affinities ?? {};

  const dominant_lanes   = det?.dominant_lanes    ?? [];
  const repeated_authors = det?.repeated_liked_authors ?? [];
  const commercial_bias  = det?.commercial_prior  ?? 0;

  const literary_tolerance = Math.min(1, Math.max(0, aff['literary']   ?? 0));
  const memoir_tolerance   = Math.min(1, Math.max(0, aff['memoir_bio'] ?? 0));

  // Graphic tolerance: no dedicated affinity key exists. We keep it at 0 by
  // default — users who genuinely like graphic novels will have given feedback
  // boosts that partially offset the graphic penalty in scoring.
  const graphic_tolerance = 0;

  // Dense: enough pattern evidence exists to classify meaningfully.
  // Deliberately does NOT depend on is_dense_import — the import source flag
  // can be missing (source column mismatch) while pattern data is fully valid.
  const is_dense = dominant_lanes.length >= 2 || repeated_authors.length >= 3;

  return {
    is_dense,
    dominant_lanes,
    repeated_authors,
    commercial_bias,
    literary_tolerance,
    memoir_tolerance,
    graphic_tolerance,
    suspense_subtype:  det?.mystery_subtype ?? null,
    has_fantasy_core:  dominant_lanes.some(l => l === 'romantasy' || l === 'scifi_fantasy'),
    has_suspense_core: dominant_lanes.some(l => l === 'modern_suspense'),
    has_romance_core:  dominant_lanes.some(l => l === 'romance' || l === 'romantasy'),
    has_memoir_core:   dominant_lanes.some(l => l === 'memoir_nonfiction'),
  };
}

// ── Public: classifyMarketPosition ───────────────────────────────────────────

export function classifyMarketPosition(book: {
  subjects?:           string[] | null;
  title?:              string | null;
  author?:             string | null;
  book_form?:          BookForm | null;
  first_publish_year?: number | null;
}): MarketPosition {
  // Graphic format overrides everything
  if (book.book_form === 'graphic') return 'graphic_format';

  const corpus = [
    ...(book.subjects ?? []),
    book.title  ?? '',
    book.author ?? '',
  ].join(' ').toLowerCase();

  const has = (...terms: string[]) => terms.some(t => corpus.includes(t));
  const authorLower = (book.author ?? '').toLowerCase();

  // Classic canon: known author OR published before 1950
  const publishYear = book.first_publish_year ?? null;
  if ((publishYear !== null && publishYear < 1950) || CLASSIC_CANON_AUTHORS.has(authorLower)) {
    return 'classic_canon';
  }

  // Memoir / narrative nonfiction
  if (has('memoir', 'autobiography', 'personal memoir', 'narrative nonfiction',
          'autobiographical', 'personal narrative', 'creative nonfiction',
          'personal memoirs')) {
    return 'memoir_nonfiction';
  }
  if (has('biography') && !has('fictional', 'thriller', ' fiction')) {
    return 'memoir_nonfiction';
  }

  // ── Fantasy / horror disambiguation ─────────────────────────────────────────
  // Principle: market position must reflect the book's primary genre identity,
  // not just the first signal matched. Horror books that incidentally use "magic"
  // or "supernatural" must not fall into epic_fantasy ahead of horror_dark.
  //
  // Strategy: if explicit horror genre signals are present AND the book lacks
  // clear high-fantasy markers (fae, elves, epic fantasy, dragons, etc.),
  // classify as horror_dark before the generic hasFantasy epic_fantasy catch.

  // Epic-fantasy core signals — unambiguous high fantasy
  const hasEpicFantasyCore = has('epic fantasy', 'high fantasy', 'sword and sorcery',
                                  'fae', 'fey', 'elves', 'orcs', 'dragons',
                                  'realm of the elderlings', 'wheel of time', 'tolkien');

  // Explicit horror genre subjects — unambiguous horror
  const hasStrongHorror = has('horror fiction', 'horror novel', 'horror stories',
                               'supernatural horror', 'gothic horror',
                               'psychological horror', 'horror and ghost stories',
                               'occult fiction', 'dark fiction');

  // Romantasy: fantasy + romance signals co-present
  const hasFantasy = has('fantasy', 'magic', 'fae', 'fey', 'romantasy', 'dragons',
                         'witch', 'sorcerer', 'spellbinding', 'realm', 'kingdom',
                         'elves', 'orcs', 'epic fantasy', 'high fantasy');
  const hasRomance = has('romance', 'romantic', 'love story', "women's fiction",
                         'love interest', 'contemporary romance', 'historical romance',
                         'chick lit');
  if (hasFantasy && hasRomance) return 'romantasy';

  // Science fiction / speculative
  if (has('science fiction', 'sci-fi', 'sci fi', 'dystopian', 'speculative fiction',
          'space opera', 'cyberpunk', 'alternate history', 'post-apocalyptic')) {
    return 'science_fiction';
  }

  // Horror before generic epic_fantasy: if explicit horror markers are present
  // and there are no unambiguous high-fantasy core signals, classify as horror.
  // This correctly handles King's supernatural novels, Jackson's gothic horror,
  // Pessl's dark fiction, etc. that use "supernatural" but are not fantasy.
  if (hasStrongHorror && !hasEpicFantasyCore) return 'horror_dark';

  // Soft horror + general supernatural → check if clearly horror author
  const KNOWN_HORROR_AUTHORS = new Set([
    'stephen king', 'shirley jackson', 'dean koontz', 'clive barker',
    'joe hill', 'mariana pessl', 'paul tremblay', 'peter straub',
    'richard laymon', 'bentley little', 'ramsey campbell',
  ]);
  if (KNOWN_HORROR_AUTHORS.has(authorLower) && !hasEpicFantasyCore) return 'horror_dark';

  // Epic fantasy (without dominant romance element)
  if (hasFantasy) return 'epic_fantasy';

  // General horror (soft signals — comes after epic_fantasy to avoid misclassifying
  // dark fantasy as horror)
  if (has('horror', 'supernatural horror', 'gothic horror', 'occult', 'paranormal')) {
    return 'horror_dark';
  }

  // Literary prestige
  if (has('literary fiction', 'literary novel', 'man booker', 'booker prize',
          'national book award', 'pulitzer', 'pen/faulkner', 'pen faulkner',
          'national book critic', 'prize winning')) {
    return 'literary_prestige';
  }

  // Domestic suspense / psychological thriller
  if (has('psychological thriller', 'domestic thriller', 'psychological suspense',
          'domestic suspense', 'domestic noir')) {
    return 'domestic_suspense';
  }
  if (has('thriller') && !has('literary thriller', 'historical thriller',
                               'spy', 'espionage', 'cozy')) {
    return 'domestic_suspense';
  }
  if (has('mystery thriller', 'crime thriller', 'police procedural', 'crime fiction')) {
    return 'domestic_suspense';
  }

  // Cozy / puzzle detective
  if (has('cozy mystery', 'whodunit', 'amateur detective', 'classic detective',
          'puzzle mystery', 'village mystery', 'country house')) {
    return 'cozy_detective';
  }
  if (has('mystery fiction', 'mystery novel') && !has('thriller', 'suspense')) {
    return 'cozy_detective';
  }

  // Pure romance (no fantasy element)
  if (hasRomance) return 'romance';

  // Book-club / contemporary women's fiction
  if (has('book club', 'book-club', 'contemporary fiction', 'domestic fiction',
          'upmarket fiction')) {
    return 'book_club_fiction';
  }

  return 'general_fiction';
}

// ── Public: computeFitClass ───────────────────────────────────────────────────

export function computeFitClass(
  book: {
    subjects?:           string[] | null;
    title?:              string | null;
    author?:             string | null;
    book_form?:          BookForm | null;
    first_publish_year?: number | null;
  },
  bookLane:       DeterministicLane | null,
  marketPosition: MarketPosition,
  cog:            CenterOfGravity,
): FitClassResult {
  const authorLower         = (book.author ?? '').toLowerCase();
  const formatIsGraphic     = marketPosition === 'graphic_format';
  const format_match        = !formatIsGraphic || cog.graphic_tolerance >= 0.2;

  // Repeated author check (loose match: either direction substring)
  const repeated_author_match = cog.repeated_authors.some(a =>
    authorLower && a && (authorLower.includes(a) || a.includes(authorLower))
  );

  // ── Hard rejects (apply regardless of is_dense) ───────────────────────────

  // Classic canon is almost never right for modern commercial readers
  if (marketPosition === 'classic_canon' && cog.commercial_bias >= 0.4) {
    return mk('reject', marketPosition, 'none', false, true, format_match,
      `classic_canon blocked: commercial_bias=${cog.commercial_bias.toFixed(2)}`,
      "This is a classic that sits outside your modern reading center"
    );
  }

  // Graphic format rejected unless user has established tolerance
  if (formatIsGraphic && cog.graphic_tolerance < 0.1) {
    return mk('reject', marketPosition, 'none', false, true, false,
      'graphic_format blocked: no graphic_tolerance signal',
      "Graphic novel format — you haven't shown a clear preference for this medium"
    );
  }

  // Literary prestige rejected for strongly commercial readers with no literary history
  if (marketPosition === 'literary_prestige'
      && cog.literary_tolerance < 0.10
      && cog.commercial_bias >= 0.7) {
    return mk('reject', marketPosition, 'none', false, true, format_match,
      `literary_prestige blocked: commercial_bias=${cog.commercial_bias.toFixed(2)}, literary_tolerance=${cog.literary_tolerance.toFixed(2)}`,
      "More literary/prestige than the commercial fiction at the center of your library"
    );
  }

  // ── Light user (no dense pattern evidence) ────────────────────────────────
  if (!cog.is_dense) {
    if (formatIsGraphic) {
      return mk('stretch_fit', marketPosition, 'none', false, true, false,
        'light_user: graphic is stretch by default',
        "A stretch pick — graphic format without a clear preference signal"
      );
    }
    if (marketPosition === 'classic_canon' || marketPosition === 'literary_prestige') {
      return mk('stretch_fit', marketPosition, 'none', false, true, format_match,
        'light_user: prestige/canon is stretch by default',
        "A stretch pick — sits in the literary/classic space"
      );
    }
    return mk('adjacent_fit', marketPosition, 'weak', false, false, format_match,
      'light_user: non-prestige book is adjacent by default',
      "A reasonable match based on your reading patterns"
    );
  }

  // ── Dense user: two-signal CORE gate ──────────────────────────────────────
  //
  // Design principle: defensible ≠ central.
  // A single strong signal (repeated author OR lane match) makes a book
  // plausible but not central. CORE should reflect confirmed alignment across
  // at least two independent axes of evidence.
  //
  // CORE requires ≥ 2 of these three signals:
  //   S1  repeated_author_match     — user has read this author 2+ times and loved them
  //   S2  laneInDominant            — book's detected genre lane is a user dominant lane
  //   S3  marketPositionIsPrimary   — market position sits at the core of a dominant lane
  //                                   (not merely adjacent)
  //
  // Score deltas by signal combination:
  //   S1 + S2 (+ optionally S3)  → CORE  +0.30  (strongest: author evidence + lane fit)
  //   S1 + S3 only               → CORE  +0.25  (author in right market-position, lane drift)
  //   S2 + S3 only               → CORE  +0.25  (clean lane + primary market position)
  //   S1 alone                   → ADJACENT +0.10 (author evidence but lane/market don't confirm)
  //   S2 alone (any market pos)  → ADJACENT +0.00 (lane match, generic market position)
  //   S3 alone                   → handled by adjacentToAny below

  const laneInDominant = bookLane !== null && cog.dominant_lanes.includes(bookLane);

  const marketPositionIsPrimary = cog.dominant_lanes.some(
    l => (LANE_PRIMARY_POSITIONS[l] ?? []).includes(marketPosition)
  );

  const strongSignals =
    (repeated_author_match  ? 1 : 0) +
    (laneInDominant         ? 1 : 0) +
    (marketPositionIsPrimary ? 1 : 0);

  // ── Two or more signals → CORE (with prestige/format safety) ──────────────
  if (strongSignals >= 2 && format_match) {
    // Prestige/format positions are capped at adjacent even with two signals,
    // because the user's lane fit doesn't override format or literary distance.
    if (marketPosition === 'literary_prestige' || marketPosition === 'classic_canon'
        || marketPosition === 'graphic_format') {
      return mk('adjacent_fit', marketPosition, 'strong', repeated_author_match, true, format_match,
        `2-signal but prestige/format cap: signals=${strongSignals}, pos=${marketPosition}`,
        "Sits near your reading center but leans more literary or prestige"
      );
    }
    // Clean CORE: higher delta when repeated author + lane both fire
    const delta = (repeated_author_match && laneInDominant)
      ? COG_DELTA_REPEATED_AUTHOR
      : COG_DELTA.core_fit;
    const matchStrength = laneInDominant ? 'strong' : 'weak';
    return mk('core_fit', marketPosition, matchStrength, repeated_author_match, false, format_match,
      `2-signal core: repeated_author=${repeated_author_match}, lane=${laneInDominant}(${bookLane}), primary_pos=${marketPositionIsPrimary}`,
      repeated_author_match
        ? buildAuthorCoreExplanation(book.author ?? '', laneInDominant, bookLane)
        : buildCoreExplanation(bookLane!, cog),
      delta,
    );
  }

  // ── Single signal: repeated author only ───────────────────────────────────
  // Lane and primary-market-position don't confirm. Earns a small bonus over
  // plain adjacent to keep author evidence visible, but does not reach CORE.
  if (repeated_author_match && format_match) {
    const displayName = book.author || 'This author';
    return mk('adjacent_fit', marketPosition, 'none', true, false, format_match,
      `repeated_author_only(+0.10): ${authorLower} — lane=${bookLane ?? 'null'}, primary_pos=${marketPositionIsPrimary}`,
      `By ${displayName}, an author you've returned to — a step outside your main lane, worth exploring`,
      COG_DELTA_REPEATED_AUTHOR_ADJACENT,
    );
  }

  // ── Single signal: lane match only (generic market position) ──────────────
  if (laneInDominant && format_match) {
    if (marketPosition === 'literary_prestige' || marketPosition === 'classic_canon'
        || marketPosition === 'graphic_format') {
      return mk('adjacent_fit', marketPosition, 'strong', false, true, format_match,
        `lane_match(${bookLane}) but prestige/format position: ${marketPosition}`,
        "Sits near your reading center but leans more literary or prestige"
      );
    }
    return mk('adjacent_fit', marketPosition, 'strong', false, false, format_match,
      `lane_match_only(${bookLane}): market_pos=${marketPosition} not primary — needs 2nd signal for CORE`,
      buildAdjacentExplanation(marketPosition, cog)
    );
  }

  // ── Lane adjacency check ───────────────────────────────────────────────────
  const adjacentToAny = cog.dominant_lanes.some(
    l => (LANE_ADJACENT_POSITIONS[l] ?? []).includes(marketPosition)
  );

  if (adjacentToAny && format_match) {
    // Memoir for non-memoir reader — cap at stretch unless tolerance is high
    if (marketPosition === 'memoir_nonfiction' && !cog.has_memoir_core
        && cog.memoir_tolerance < 0.5) {
      return mk('stretch_fit', marketPosition, 'none', false, true, format_match,
        `memoir_nonfiction: adjacent lane match but memoir_tolerance=${cog.memoir_tolerance.toFixed(2)} < 0.5`,
        "A stretch pick — memoir/nonfiction sits at the edge of your reading center"
      );
    }
    return mk('adjacent_fit', marketPosition, 'weak', false, false, format_match,
      `position(${marketPosition}) is adjacent to one of: ${cog.dominant_lanes.join(', ')}`,
      buildAdjacentExplanation(marketPosition, cog)
    );
  }

  // ── Stretch / reject territory ────────────────────────────────────────────

  if (marketPosition === 'memoir_nonfiction') {
    if (cog.memoir_tolerance >= 0.5 || cog.has_memoir_core) {
      return mk('adjacent_fit', marketPosition, 'weak', false, true, format_match,
        `memoir: high tolerance(${cog.memoir_tolerance.toFixed(2)}) or memoir_core`,
        "Sits near the narrative nonfiction you sometimes enjoy"
      );
    }
    return mk('stretch_fit', marketPosition, 'none', false, true, format_match,
      `memoir: low tolerance(${cog.memoir_tolerance.toFixed(2)})`,
      "A stretch pick — memoir/nonfiction is at the edge of your reading center"
    );
  }

  if (marketPosition === 'literary_prestige') {
    if (cog.literary_tolerance >= 0.3) {
      return mk('adjacent_fit', marketPosition, 'weak', false, true, format_match,
        `literary_prestige: tolerance=${cog.literary_tolerance.toFixed(2)} >= 0.3`,
        "Sits near the literary fiction you sometimes pick up"
      );
    }
    return mk('stretch_fit', marketPosition, 'none', false, true, format_match,
      `literary_prestige: low tolerance(${cog.literary_tolerance.toFixed(2)})`,
      "A stretch pick — more literary/prestige than your strongest recurring reads"
    );
  }

  if (formatIsGraphic) {
    return mk('stretch_fit', marketPosition, 'none', false, true, false,
      `graphic_format: marginal tolerance(${cog.graphic_tolerance.toFixed(2)})`,
      "A stretch pick — graphic novel format is outside your usual reading"
    );
  }

  // Format-safe, no lane match, no adjacency — fallback adjacent
  return mk('adjacent_fit', marketPosition, 'none', false, false, format_match,
    `no_lane_match: ${bookLane ?? 'null'} not in [${cog.dominant_lanes.join(', ')}], format-safe fallback`,
    "A reasonable next read that sits near your reading center"
  );
}

// ── Internal builder ──────────────────────────────────────────────────────────

function mk(
  fit_class:             FitClass,
  market_position:       MarketPosition,
  lane_match_strength:   'strong' | 'weak' | 'none',
  repeated_author_match: boolean,
  exception_dependency:  boolean,
  format_match:          boolean,
  fit_reasoning:         string,
  fit_explanation:       string,
  custom_delta?:         number,
): FitClassResult {
  return {
    fit_class,
    market_position,
    lane_match_strength,
    repeated_author_match,
    exception_dependency,
    format_match,
    cog_score_delta: custom_delta ?? COG_DELTA[fit_class],
    fit_reasoning,
    fit_explanation,
  };
}

// ── Explanation builders ──────────────────────────────────────────────────────

// Human-readable label for each lane, used in generated explanation sentences.
const LANE_LABELS: Record<DeterministicLane, string> = {
  romantasy:            'romantic fantasy',
  scifi_fantasy:        'fantasy and speculative fiction',
  modern_suspense:      'psychological suspense',
  romance:              'emotionally driven romance',
  contemporary_fiction: 'contemporary character-driven fiction',
  memoir_nonfiction:    'narrative nonfiction',
  literary:             'literary fiction',
  horror:               'dark atmospheric fiction',
};

// Called for the 2-signal CORE case where lane evidence is the primary driver
// (no repeated-author match, or author already named in the surrounding context).
function buildCoreExplanation(lane: DeterministicLane, _cog: CenterOfGravity): string {
  const CORE_EXPLANATIONS: Partial<Record<DeterministicLane, string>> = {
    romantasy:            "Feels closest to the romantic fantasy series you return to most",
    scifi_fantasy:        "Fits the fantasy and speculative fiction at the center of your reading history",
    modern_suspense:      "Matches the twisty, readable suspense you return to most often",
    romance:              "Aligns with the emotionally driven romance at the core of your library",
    contemporary_fiction: "Feels close to the contemporary, character-driven fiction you consistently enjoy",
    memoir_nonfiction:    "Sits at the heart of the narrative nonfiction you read most",
    literary:             "Aligns with the literary fiction and craft-focused reading that defines your library",
    horror:               "Fits the dark, atmospheric fiction you return to consistently",
  };
  return CORE_EXPLANATIONS[lane] ?? "Strongly aligned with your most repeated reading patterns";
}

// Called for the 2-signal CORE case where repeated-author match is one of the
// signals. Combines the author name with lane context for a specific sentence.
function buildAuthorCoreExplanation(
  authorName: string,
  laneInDominant: boolean,
  bookLane:       DeterministicLane | null,
): string {
  const displayName = authorName || 'This author';
  if (laneInDominant && bookLane) {
    const laneLabel = LANE_LABELS[bookLane] ?? bookLane;
    return `By ${displayName}, a consistent favorite — lands exactly in your ${laneLabel} reading`;
  }
  // Author match fires but lane doesn't — still CORE via author + primary_pos.
  return `By ${displayName}, an author you keep returning to — sits in a style you've loved`;
}

function buildAdjacentExplanation(pos: MarketPosition, _cog: CenterOfGravity): string {
  const ADJACENT_EXPLANATIONS: Partial<Record<MarketPosition, string>> = {
    book_club_fiction:  "Sits near the emotionally driven fiction you enjoy — one step from your core lane",
    domestic_suspense:  "Fits the thriller and suspense territory adjacent to your main reading lane",
    cozy_detective:     "A lighter, puzzle-focused detective read that sits near your suspense center",
    epic_fantasy:       "Sits close to the fantasy you read most, without the romance element",
    science_fiction:    "Adjacent to the speculative and genre fiction in your library",
    romance:            "Shares the romantic and emotionally charged energy of your core reads",
    memoir_nonfiction:  "Sits near narrative nonfiction — a step from your fiction center",
    horror_dark:        "Brings the dark atmosphere adjacent to your thriller and suspense reads",
    romantasy:          "Shares the romantic fantasy energy close to the center of your reading",
    literary_prestige:  "Sits near the literary fiction you sometimes pick up, though it leans more prestige",
    general_fiction:    "A reasonable next read that sits near your reading center",
  };
  return ADJACENT_EXPLANATIONS[pos] ?? "A reasonable next read that sits near your reading center";
}
