import type { SupabaseClient } from '@supabase/supabase-js';
import { detectGenre, detectBookLane, detectBookMysterySubtype } from './bookTraits';
import type { DeterministicLane, MysterySubtype } from './bookTraits';

// =============================================================================
// Taste Profile — recommendation confidence model
//
// Tiers:
//   0  = 0–4 strong signals → "We're learning your taste"
//   1  = 5–9 strong signals → "Early read on your taste"
//   2  = 10+ strong signals → "Personalized for you"
//   3  = 10+ strong signals + imported history with enrichment → "High-confidence"
//
// A "strong signal" = one finished book with at least one of:
//   rating, taste_tags, review_body, or imported.
// =============================================================================

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConfidenceTier = 0 | 1 | 2 | 3;

export const CONFIDENCE_LABELS: Record<ConfidenceTier, string> = {
  0: "We're learning your taste",
  1: 'Early read on your taste',
  2: 'Personalized for you',
  3: 'High-confidence recommendations',
};

export type TasteProfileEvidence = {
  completed_books_count:   number;
  imported_books_count:    number;
  rated_books_count:       number;
  taste_tag_count:         number;
  review_count:            number;
  diagnosis_answer_count:  number;
};

export type TasteProfile = {
  tier:              ConfidenceTier;
  label:             string;
  confidence:        'low' | 'medium' | 'high';
  preferred_traits:  Record<string, number>;
  avoided_traits:    Record<string, number>;
  genre_affinities:  Record<string, number>;   // e.g. { thriller_mystery: 0.7, nonfiction: -0.2 }
  liked_subjects:    string[];  // top subjects from 4+ rated finished books (for OL anchoring)
  liked_authors:     string[];  // authors of 4+ rated finished books (for author-adjacent retrieval)
  open_questions:    string[];
  evidence:          TasteProfileEvidence;
  strongSignalCount: number;
  nextTierAt:        number;
  det_lanes?:        DeterministicLanes;  // populated for dense-import users
};

export type RecommendationExplanation = {
  book_id:             string;
  confidence_label:    string;
  why_it_fits:         string[];
  aligned_preferences: string[];
  risk_or_mismatch:    string | null;
};

// ── Deterministic lanes (built from dense import history) ─────────────────────
// Exported so the recommender can use them for retrieval and scoring.

export type { DeterministicLane, MysterySubtype } from './bookTraits';

export type DeterministicLanes = {
  is_dense_import:        boolean;      // ≥20 imported books
  dominant_lanes:         DeterministicLane[]; // lanes with ≥3 loved reads (dense) or ≥2 (light)
  repeated_liked_authors: string[];     // authors with ≥2 loved (4+★) books, lowercase
  exception_authors:      string[];     // authors with exactly 1 loved book — tolerance, not preference
  mystery_subtype:        MysterySubtype | null;
  commercial_prior:       number;       // 0–1 fraction of dominant lanes that are modern-commercial
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function computeConfidenceTier(
  evidence: TasteProfileEvidence,
  strongSignalCount: number,
): ConfidenceTier {
  const hasImport  = evidence.imported_books_count > 0;
  const hasEnrich  = evidence.rated_books_count > 0
    || evidence.taste_tag_count > 0
    || evidence.review_count > 0;
  if (strongSignalCount >= 10 && hasImport && hasEnrich) return 3;
  if (strongSignalCount >= 10) return 2;
  if (strongSignalCount >= 5)  return 1;
  return 0;
}

export function tierNextThreshold(tier: ConfidenceTier): number {
  if (tier === 0) return 5;
  if (tier === 1) return 10;
  return 10;
}

export function confidenceLevel(tier: ConfidenceTier): 'low' | 'medium' | 'high' {
  if (tier <= 1) return 'low';
  if (tier === 2) return 'medium';
  return 'high';
}

// ── Trait scoring from taste_tags ─────────────────────────────────────────────

type TasteTagPayload = { liked?: string[]; didnt_work?: string[] };

type RawUserBook = {
  status:        string;
  rating:        number | null;
  taste_tags:    TasteTagPayload | null;
  review_body:   string | null;
  source:        string | null;
  import_source: string | null;  // set by goodreadsExecutor; separate from source
};

function buildTraitScores(rows: RawUserBook[]): {
  preferred_traits: Record<string, number>;
  avoided_traits:   Record<string, number>;
} {
  const likedCounts: Record<string, number> = {};
  const avoidCounts: Record<string, number> = {};
  let tagged = 0;

  for (const row of rows) {
    if (!row.taste_tags) continue;
    const liked    = row.taste_tags.liked      ?? [];
    const disliked = row.taste_tags.didnt_work ?? [];
    if (liked.length === 0 && disliked.length === 0) continue;
    tagged++;
    for (const t of liked)    likedCounts[t] = (likedCounts[t] ?? 0) + 1;
    for (const t of disliked) avoidCounts[t] = (avoidCounts[t] ?? 0) + 1;
  }

  if (tagged === 0) return { preferred_traits: {}, avoided_traits: {} };

  const preferred_traits: Record<string, number> = {};
  const avoided_traits:   Record<string, number> = {};
  for (const [tag, count] of Object.entries(likedCounts)) {
    preferred_traits[tag] = +(count / tagged).toFixed(2);
  }
  for (const [tag, count] of Object.entries(avoidCounts)) {
    avoided_traits[tag] = +(-count / tagged).toFixed(2);
  }
  return { preferred_traits, avoided_traits };
}

// ── Diagnosis answer boosts ────────────────────────────────────────────────────
//
// Diagnosis answers act as lightweight priors: they nudge preferred/avoided
// trait scores in a principled direction when explicit tag data is sparse.
// The effect is intentionally small (~0.15–0.25) so tag data dominates once
// the user has rated several books.

const ANSWER_BOOSTS: Record<string, (p: Record<string, number>, a: Record<string, number>) => void> = {
  idea_driven:           (p)    => { p.Insight  = Math.min(1, (p.Insight  ?? 0) + 0.20); p.Evidence  = Math.min(1, (p.Evidence  ?? 0) + 0.10); },
  emotion_driven:        (p)    => { p.Emotional = Math.min(1, (p.Emotional ?? 0) + 0.20); p.Characters = Math.min(1, (p.Characters ?? 0) + 0.10); },
  pacing_non_negotiable: (p)    => { p.Pacing    = Math.min(1, (p.Pacing    ?? 0) + 0.25); },
  ideas_over_pacing:     (p)    => { p.Pacing    = Math.max(0, (p.Pacing    ?? 0.30) - 0.15); },
  originality_first:     (p)    => { p.Originality = Math.min(1, (p.Originality ?? 0) + 0.25); },
  craft_first:           (p)    => { p.Writing   = Math.min(1, (p.Writing   ?? 0) + 0.20); p.Prose = Math.min(1, (p.Prose ?? 0) + 0.15); },
  challenging:           (p)    => { p.Depth     = Math.min(1, (p.Depth     ?? 0) + 0.15); },
  effortless:            (p)    => { p.Pacing    = Math.min(1, (p.Pacing    ?? 0) + 0.15); },
  dnf_characters:        (p)    => { p.Characters = Math.min(1, (p.Characters ?? 0) + 0.25); },
  dnf_pacing:            (p)    => { p.Pacing    = Math.min(1, (p.Pacing    ?? 0) + 0.20); },
};

function applyDiagnosisBoosts(
  preferred: Record<string, number>,
  avoided:   Record<string, number>,
  answers:   Record<string, string>,
): { preferred: Record<string, number>; avoided: Record<string, number> } {
  const p = { ...preferred };
  const a = { ...avoided };
  for (const answer of Object.values(answers)) {
    ANSWER_BOOSTS[answer]?.(p, a);
  }
  // Round to 2dp
  const round = (r: Record<string, number>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(2)]));
  return { preferred: round(p), avoided: round(a) };
}

// ── Liked subjects + authors from 4+ star finished books ──────────────────────
// Used by the recommender as anchor terms for OL subject / author searches.

type FinishedBookRow = {
  rating:      number | null;
  raw_shelves: string[] | null;  // Goodreads import shelf names — used as subject supplements
  book: { subjects?: string[] | null; title?: string | null; author?: string | null } | null;
};

// Noise subjects that appear in many OL search results — useless as anchors.
// Extended to cover common Goodreads import noise.
const GENERIC_OL_SUBJECTS = new Set([
  // Format / cataloguing noise
  'fiction', 'non-fiction', 'nonfiction', 'books', 'reading',
  'accessible book', 'protected daisy', 'open library nl',
  'internet archive wishlist', 'large type books',
  'juvenile fiction', 'juvenile literature',
  // Language / nationality noise (too broad to anchor)
  'english', 'american', 'british', 'american fiction', 'english fiction',
  'literature', 'literary', 'american literature', 'english literature',
  'british literature', 'world literature',
  // Format descriptors
  'novel', 'novels', 'short stories', 'collections',
  // Era / period noise (very broad — will retrieve anything from that era)
  '19th century', '18th century', '20th century', '21st century',
  // Over-broad thematic noise from Goodreads imports
  'love', 'friendship', 'adventure', 'survival', 'family', 'death',
  'war', 'history', 'coming of age', 'good and evil',
  'adventure and adventurers', 'man-woman relationships',
  'social problems', 'social classes', 'interpersonal relations',
  // Marketing / bestseller labels — not content anchors
  'bestseller', 'bestsellers', 'best seller', 'best sellers',
  'new york times bestseller', 'new york times best seller',
  'nyt bestseller', 'national bestseller', 'international bestseller',
  'sunday times bestseller', 'usa today bestseller',
  // Children's / juvenile — distinct from adult commercial fiction
  "children's fiction", "children's literature", "children's books",
  'juvenile nonfiction', 'picture books', "young adult fiction",
  // Demographic shelf labels (Goodreads): describe audience, not content
  'fiction, women', 'fiction women', 'women',
  // Popularity / format labels that contaminate retrieval
  'popular fiction', 'popular culture', 'adult fiction', 'adults',
]);

// Subjects that indicate classic/PD content — not useful anchors for
// modern recommendations even if a user enjoyed a classic.
const CLASSIC_ANCHOR_NOISE = new Set([
  'classical literature', 'classic literature', 'classics',
  'ancient literature', 'medieval literature', 'victorian literature',
  'elizabethan', 'renaissance literature',
]);

function buildLikedAnchors(
  rows: FinishedBookRow[],
  isDenseGoodreadsUser: boolean = false,
): {
  liked_subjects: string[];
  liked_authors:  string[];
} {
  const subjectFreq: Record<string, number> = {};
  const seenAuthors  = new Set<string>();
  const liked_authors: string[] = [];

  for (const row of rows) {
    if ((row.rating ?? 0) < 4 || !row.book) continue;

    // Authors — only non-generic names from loved books
    const authorRaw = row.book.author?.trim() ?? '';
    const authorKey = authorRaw.toLowerCase();
    if (authorRaw && !seenAuthors.has(authorKey) && !/^unknown/i.test(authorRaw)) {
      seenAuthors.add(authorKey);
      liked_authors.push(authorRaw);
    }

    // Subjects — normalise, noise-filter, and count frequency
    for (const s of (row.book.subjects ?? [])) {
      const norm = s.toLowerCase().trim();
      if (norm.length < 5) continue;
      if (GENERIC_OL_SUBJECTS.has(norm)) continue;
      if (CLASSIC_ANCHOR_NOISE.has(norm)) continue;
      // Skip subjects that are more than 4 words (usually long descriptors, not useful anchors)
      if (norm.split(' ').length > 4) continue;
      // Skip Goodreads-style category tree paths: "fiction, women", "fiction, fantasy, general"
      // These are hierarchical shelving labels, not content anchors.
      if (/^fiction,\s/.test(norm) || /,\s*fiction$/.test(norm)) continue;
      // Skip subjects that start with "new york times" (bestseller marketing labels)
      if (norm.startsWith('new york times')) continue;
      subjectFreq[norm] = (subjectFreq[norm] ?? 0) + 1;
    }
  }

  // For dense Goodreads users (many imported books), raise the minimum frequency
  // threshold so we only anchor on subjects that appear in 2+ loved books.
  // This prevents a single imported niche book from contaminating retrieval.
  const minFreq = isDenseGoodreadsUser ? 2 : 1;

  const liked_subjects = Object.entries(subjectFreq)
    .filter(([, freq]) => freq >= minFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s]) => s);

  return { liked_subjects, liked_authors: liked_authors.slice(0, 5) };
}

// ── Deterministic lanes from repeated reading patterns ─────────────────────────
//
// Builds the DeterministicLanes struct from the user's loved (4+★) finished
// books. Only meaningful for dense-import users (≥20 imported books).
//
// Key principle — "canon tolerance is not canon preference":
//   A single loved classic / literary book is an *exception*, not a lane.
//   We require ≥2 loved books in a lane (≥3 for dense imports) before we
//   treat it as a dominant lane that should drive retrieval and scoring.
//
// Mystery subtype:
//   We tally hard_boiled_noir vs contemporary_thriller vs puzzle_detective
//   from loved mystery books to distinguish Chandler-style readers from
//   Foley/Horowitz-style readers.

const COMMERCIAL_LANES = new Set<DeterministicLane>([
  'romantasy', 'contemporary_fiction', 'modern_suspense', 'romance',
]);

function buildDeterministicLanes(
  rows:     FinishedBookRow[],
  evidence: TasteProfileEvidence,
): DeterministicLanes {
  const isDenseImport = evidence.imported_books_count >= 20;

  const authorFreq: Record<string, number> = {};
  const laneFreq:   Partial<Record<DeterministicLane, number>> = {};
  const mysterySubtypeCounts: Partial<Record<MysterySubtype, number>> = {};

  for (const row of rows) {
    if ((row.rating ?? 0) < 4 || !row.book) continue;

    const authorRaw = (row.book.author ?? '').trim();
    const authorKey = authorRaw.toLowerCase();
    if (!authorRaw || /^unknown/i.test(authorRaw)) continue;

    authorFreq[authorKey] = (authorFreq[authorKey] ?? 0) + 1;

    // Combine OL subjects with Goodreads shelf names for lane detection.
    // Imported books have subjects = null until OL repair runs; shelf names
    // (e.g. "fantasy", "romance", "thriller") act as a bridging signal.
    const combinedSubjects = [...(row.book.subjects ?? []), ...(row.raw_shelves ?? [])];
    const lane = detectBookLane({ subjects: combinedSubjects, title: row.book.title, author: authorRaw });
    if (lane) {
      laneFreq[lane] = (laneFreq[lane] ?? 0) + 1;
    }

    // Mystery subtype tracking — only for books in the suspense family
    if (lane === 'modern_suspense' || combinedSubjects.join(' ').toLowerCase().includes('mystery')) {
      const subtype = detectBookMysterySubtype({ subjects: combinedSubjects, title: row.book.title });
      if (subtype) {
        mysterySubtypeCounts[subtype] = (mysterySubtypeCounts[subtype] ?? 0) + 1;
      }
    }
  }

  // Repeated liked authors: appeared ≥2 times in loved (4+★) books
  const repeated_liked_authors = Object.entries(authorFreq)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([a]) => a);

  // Exception authors: appeared exactly once (loved as one-off, not a pattern)
  const exception_authors = Object.entries(authorFreq)
    .filter(([, c]) => c === 1)
    .map(([a]) => a);

  // Dominant lanes — stricter threshold for dense imports
  const laneThreshold = isDenseImport ? 3 : 2;
  const dominant_lanes = (Object.entries(laneFreq) as [DeterministicLane, number][])
    .filter(([, c]) => c >= laneThreshold)
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => l);

  // Mystery subtype — dominant one wins
  const mystery_subtype = Object.keys(mysterySubtypeCounts).length > 0
    ? (Object.entries(mysterySubtypeCounts)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0][0] as MysterySubtype)
    : null;

  // Commercial prior — fraction of dominant lanes that are modern-commercial
  const commercial_prior = dominant_lanes.length > 0
    ? dominant_lanes.filter(l => COMMERCIAL_LANES.has(l)).length / dominant_lanes.length
    : 0;

  return {
    is_dense_import: isDenseImport,
    dominant_lanes,
    repeated_liked_authors,
    exception_authors,
    mystery_subtype,
    commercial_prior,
  };
}

// ── Genre affinities from rated finished books ─────────────────────────────────
//
// Bayesian smoothing rationale:
//   The raw formula (pos - neg) / total returns 1.0 for a single loved book in
//   a genre — e.g. one Goodreads-imported memoir with a 5★ rating gives
//   memoir_bio = 1.0, which is then treated as a dominant signal everywhere.
//   A single book is not enough to establish that a genre "dominates" the user's
//   reading identity. We apply confidence scaling:
//
//     affinity = raw × min(1, total / GENRE_MIN_EVIDENCE)
//
//   This shrinks high-affinity values toward 0 when evidence is thin:
//   • 1 book rated 5★:   raw=1.0, confidence=0.20 → affinity=0.20
//   • 2 books, both 5★:  raw=1.0, confidence=0.40 → affinity=0.40
//   • 5 books, all 5★:   raw=1.0, confidence=1.00 → affinity=1.00
//   • 10 books rated 4★: raw=1.0, confidence=1.00 → affinity=1.00
//
//   This never hurts genuine heavy readers — they have enough evidence for
//   full confidence. It only suppresses noise from 1-2 shelf-categorised imports.

const GENRE_MIN_EVIDENCE = 5;  // books needed in a genre for full affinity confidence

function buildGenreAffinities(rows: FinishedBookRow[]): Record<string, number> {
  const counts: Record<string, { pos: number; neg: number; total: number }> = {};

  for (const row of rows) {
    if (!row.rating || !row.book) continue;
    // Combine OL subjects with Goodreads shelf names so imported books
    // (which land with subjects = null until metadata repair runs) can
    // still contribute to genre affinities.
    const genre = detectGenre({
      ...row.book,
      subjects: [...(row.book.subjects ?? []), ...(row.raw_shelves ?? [])],
    });
    if (!genre) continue;
    if (!counts[genre]) counts[genre] = { pos: 0, neg: 0, total: 0 };
    counts[genre].total++;
    if (row.rating >= 4) counts[genre].pos++;
    else if (row.rating <= 2) counts[genre].neg++;
  }

  const affinities: Record<string, number> = {};
  for (const [genre, { pos, neg, total }] of Object.entries(counts)) {
    if (total < 1) continue;
    const rawAffinity  = (pos - neg) / total;
    // Bayesian shrinkage: scale by evidence confidence so sparse genres
    // cannot reach extreme affinity values from 1–2 books.
    const confidence   = Math.min(1, total / GENRE_MIN_EVIDENCE);
    affinities[genre]  = +(rawAffinity * confidence).toFixed(2);
  }
  return affinities;
}

// ── Open question generation ──────────────────────────────────────────────────

function deriveOpenQuestions(
  evidence: TasteProfileEvidence,
  preferred: Record<string, number>,
): string[] {
  const qs:    string[] = [];
  const known = new Set(Object.keys(preferred));

  if (!known.has('Pacing') && !known.has('Plot')) {
    qs.push('How much do they tolerate slow pacing?');
  }
  if (!known.has('Characters') && !known.has('Emotional')) {
    qs.push('Do they prefer character-driven or idea-driven stories?');
  }
  if (!known.has('Originality') && !known.has('Writing')) {
    qs.push('Is originality or craft more important to them?');
  }
  if (evidence.rated_books_count < 5) {
    qs.push('Not enough explicit ratings to model quality threshold yet.');
  }
  if (evidence.taste_tag_count < 3) {
    qs.push('Trait preferences are largely unconfirmed — more taste tags needed.');
  }
  return qs.slice(0, 5);
}

// ── Main async entrypoint ─────────────────────────────────────────────────────

export async function computeTasteProfile(
  client: SupabaseClient,
  userId: string,
): Promise<TasteProfile> {
  // Run all three queries concurrently
  const [booksRes, finishedRatedRes, prefsRes] = await Promise.all([
    client
      .from('user_books')
      .select('status, rating, taste_tags, review_body, source, import_source')
      .eq('user_id', userId),

    // For genre affinity: finished books with rating + book subjects.
    // raw_shelves (Goodreads shelf names) supplements subjects for imported
    // books that have not yet had OL metadata repair run on them.
    client
      .from('user_books')
      .select('rating, raw_shelves, book:books(subjects, title, author)')
      .eq('user_id', userId)
      .eq('status', 'finished')
      .not('rating', 'is', null),

    // Diagnosis answers + genre preferences from reader_preferences
    client
      .from('reader_preferences')
      .select('diagnosis_answers, favorite_genres, avoid_genres')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  const rows: RawUserBook[] = (booksRes.data ?? []) as RawUserBook[];
  const finished = rows.filter(r => r.status === 'finished');

  type PrefsRow = {
    diagnosis_answers?: Record<string, string>;
    favorite_genres?:   string[];
    avoid_genres?:      string[];
  };
  const prefsData = (prefsRes.data ?? null) as PrefsRow | null;

  const diagnosisAnswers = (prefsData?.diagnosis_answers ?? {}) as Record<string, string>;

  // Helper: recognise a Goodreads-imported row regardless of which column was set.
  // goodreadsStager sets source='goodreads'; goodreadsExecutor sets import_source='goodreads'.
  // Both paths must be counted to avoid imported_books_count=0 for large GR users.
  const isGoodreadsRow = (r: RawUserBook) =>
    r.source === 'goodreads' || r.import_source === 'goodreads';

  const evidence: TasteProfileEvidence = {
    completed_books_count:  finished.length,
    imported_books_count:   rows.filter(isGoodreadsRow).length,
    rated_books_count:      rows.filter(r => r.rating !== null).length,
    taste_tag_count:        rows.filter(r => {
      const t = r.taste_tags;
      return t && ((t.liked?.length ?? 0) + (t.didnt_work?.length ?? 0)) > 0;
    }).length,
    review_count:           rows.filter(r => r.review_body && r.review_body.trim() !== '').length,
    diagnosis_answer_count: Object.keys(diagnosisAnswers).length,
  };

  const strongSignalCount = finished.filter(r =>
    r.rating !== null ||
    (r.taste_tags && ((r.taste_tags.liked?.length ?? 0) + (r.taste_tags.didnt_work?.length ?? 0)) > 0) ||
    (r.review_body && r.review_body.trim() !== '') ||
    isGoodreadsRow(r)
  ).length;

  const tier       = computeConfidenceTier(evidence, strongSignalCount);
  const label      = CONFIDENCE_LABELS[tier];
  const confidence = confidenceLevel(tier);
  const nextAt     = tierNextThreshold(tier);

  const { preferred_traits: rawPref, avoided_traits: rawAvoid } = buildTraitScores(rows);

  // Apply diagnosis answer boosts on top of tag-derived scores
  const { preferred: preferred_traits, avoided: avoided_traits } =
    applyDiagnosisBoosts(rawPref, rawAvoid, diagnosisAnswers);

  const finishedRatedRows = (finishedRatedRes.data ?? []) as FinishedBookRow[];

  // Genre affinities from rated finished books
  const genre_affinities = buildGenreAffinities(finishedRatedRows);

  // Liked subject + author anchors for retrieval
  // Dense Goodreads users (≥20 imported books) get stricter subject noise filtering
  const isDenseGoodreadsUser = evidence.imported_books_count >= 20;
  const { liked_subjects, liked_authors } = buildLikedAnchors(finishedRatedRows, isDenseGoodreadsUser);

  // Deterministic lanes — built for all users; only has teeth for dense-import users
  const det_lanes = buildDeterministicLanes(finishedRatedRows, evidence);

  const open_questions = deriveOpenQuestions(evidence, preferred_traits);

  // ── Onboarding genre prior — blend for tier 0-1 users ────────────────────
  // Maps genre labels (from onboarding chips) to the same affinity keys used
  // by buildGenreAffinities so they flow through scoring identically.
  // Weight fades as real book history accumulates: 0.50 at tier 0 → 0.25 at tier 1
  // → not applied at tier 2+ (history is reliable enough to override).
  const GENRE_AFFINITY_MAP: Record<string, string> = {
    'Literary Fiction':   'literary',
    'Fantasy':            'fantasy_scifi',
    'Sci-Fi':             'fantasy_scifi',
    'Thriller':           'thriller_mystery',
    'Mystery':            'thriller_mystery',
    'Romance':            'romance',
    'Horror':             'horror',
    'Historical Fiction': 'literary',
    'Non-Fiction':        'nonfiction',
    'Biography & Memoir': 'memoir_bio',
    'Self-Help':          'nonfiction',
    'Young Adult':        'literary',
    'Graphic Novel':      'literary',
  };

  const GENRE_SUBJECTS_MAP: Record<string, string[]> = {
    'Literary Fiction':   ['literary fiction', 'contemporary fiction'],
    'Fantasy':            ['fantasy', 'epic fantasy', 'fantasy fiction'],
    'Sci-Fi':             ['science fiction', 'space opera', 'speculative fiction'],
    'Thriller':           ['thriller', 'psychological thriller', 'suspense fiction'],
    'Mystery':            ['mystery', 'detective fiction', 'crime fiction'],
    'Romance':            ['romance', 'contemporary romance', 'romantic fiction'],
    'Horror':             ['horror', 'supernatural fiction', 'gothic fiction'],
    'Historical Fiction': ['historical fiction'],
    'Non-Fiction':        ['popular nonfiction', 'popular science'],
    'Biography & Memoir': ['biography', 'autobiography', 'memoir'],
    'Self-Help':          ['self-help', 'personal development'],
    'Young Adult':        ['young adult fiction'],
    'Graphic Novel':      ['graphic novels', 'comics'],
  };

  let blendedGenreAffinities = genre_affinities;
  let blendedLikedSubjects   = liked_subjects;

  const prefGenres  = (prefsData?.favorite_genres ?? []) as string[];
  const avoidGenres = (prefsData?.avoid_genres    ?? []) as string[];

  if (tier <= 1 && (prefGenres.length > 0 || avoidGenres.length > 0)) {
    const prefWeight  =  0.50 - tier * 0.25;  // 0.50 at tier 0, 0.25 at tier 1
    const avoidWeight = -(0.50 - tier * 0.25);
    blendedGenreAffinities = { ...genre_affinities };

    for (const label of prefGenres) {
      const key = GENRE_AFFINITY_MAP[label];
      if (key) blendedGenreAffinities[key] = Math.min(1, (blendedGenreAffinities[key] ?? 0) + prefWeight);
    }
    for (const label of avoidGenres) {
      const key = GENRE_AFFINITY_MAP[label];
      if (key) blendedGenreAffinities[key] = Math.max(-1, (blendedGenreAffinities[key] ?? 0) + avoidWeight);
    }

    // For tier 0 with no book anchors yet, derive liked_subjects from preferred genres
    if (tier === 0 && liked_subjects.length === 0 && prefGenres.length > 0) {
      const subjectSet = new Set<string>();
      for (const label of prefGenres) {
        for (const s of (GENRE_SUBJECTS_MAP[label] ?? [])) subjectSet.add(s);
      }
      blendedLikedSubjects = [...subjectSet].slice(0, 8);
    }
  }

  return {
    tier,
    label,
    confidence,
    preferred_traits,
    avoided_traits,
    genre_affinities:  blendedGenreAffinities,
    liked_subjects:    blendedLikedSubjects,
    liked_authors,
    open_questions,
    evidence,
    strongSignalCount,
    nextTierAt: nextAt,
    det_lanes,
  };
}

// ── Hypothesis generation (for diagnosis flow) ────────────────────────────────

export type TasteHypothesis = {
  slug:       string;
  statement:  string;
  confidence: 'strong' | 'tentative';
};

export function generateHypotheses(profile: TasteProfile): TasteHypothesis[] {
  const hyps: TasteHypothesis[] = [];
  const pref  = profile.preferred_traits;
  const avoid = profile.avoided_traits;
  const { rated_books_count, imported_books_count, taste_tag_count } = profile.evidence;

  if ((pref['Pacing'] ?? 0) >= 0.4) {
    hyps.push({ slug: 'pacing_valued', statement: 'You appear to value pacing and momentum.', confidence: 'strong' });
  } else if ((pref['Pacing'] ?? 0) >= 0.2) {
    hyps.push({ slug: 'pacing_valued', statement: 'Pacing may be more important to you than average.', confidence: 'tentative' });
  }
  if ((pref['Originality'] ?? 0) >= 0.35) {
    hyps.push({ slug: 'originality_valued', statement: 'You seem to reward originality more than familiarity.', confidence: 'strong' });
  }
  if ((pref['Characters'] ?? 0) >= 0.4) {
    hyps.push({ slug: 'character_driven', statement: 'Character-driven stories seem to resonate with you.', confidence: 'strong' });
  }
  if ((avoid['Romance'] ?? 0) <= -0.3) {
    hyps.push({ slug: 'romance_low', statement: 'Romance-heavy books may underperform for you.', confidence: 'strong' });
  }
  if ((pref['Emotional'] ?? 0) >= 0.3) {
    hyps.push({ slug: 'emotional_resonance', statement: 'Emotional resonance is a strong factor in what lands for you.', confidence: 'tentative' });
  }
  if (rated_books_count >= 5) {
    const totalAvoid = Object.values(avoid).reduce((a, b) => a + b, 0);
    if (Math.abs(totalAvoid) < 0.2) {
      hyps.push({ slug: 'generous_rater', statement: 'You may prefer books that lean into strengths rather than being well-rounded.', confidence: 'tentative' });
    }
  }
  if (imported_books_count >= 20) {
    hyps.push({ slug: 'established_reader', statement: 'Your reading history suggests well-defined taste — recommendations can be quite targeted.', confidence: 'strong' });
  } else if (imported_books_count >= 5) {
    hyps.push({ slug: 'active_reader', statement: 'Your imported history gives us a starting point, though more signals will sharpen the picture.', confidence: 'tentative' });
  }
  if (hyps.length === 0) {
    hyps.push({ slug: 'early_stage', statement: 'Your reading profile is just getting started — rate a few finished books to help us learn.', confidence: 'tentative' });
  }
  return hyps.slice(0, 5);
}

// ── Diagnosis questions ───────────────────────────────────────────────────────

export type DiagnosisQuestion = {
  id:      string;
  text:    string;
  options: [string, string];
  keys:    [string, string];
};

export const DIAGNOSIS_QUESTIONS: DiagnosisQuestion[] = [
  {
    id: 'q1',
    text: 'When a book really works for you, is it more often because it teaches you something new or because it affects you emotionally?',
    options: ['Teaches me something new', 'Affects me emotionally'],
    keys:    ['idea_driven', 'emotion_driven'],
  },
  {
    id: 'q2',
    text: 'Are you more forgiving of slow pacing if the ideas are genuinely strong?',
    options: ['Yes — ideas can compensate', 'No — pacing matters regardless'],
    keys:    ['ideas_over_pacing', 'pacing_non_negotiable'],
  },
  {
    id: 'q3',
    text: 'Between a book that breaks new ground but is rough around the edges, and one that is beautifully executed but familiar — which do you prefer?',
    options: ['Originality, even if unpolished', 'Polish and craft, even if familiar'],
    keys:    ['originality_first', 'craft_first'],
  },
  {
    id: 'q4',
    text: 'Do you generally prefer books that challenge you, or books that pull you forward effortlessly?',
    options: ['Challenge me', 'Pull me forward effortlessly'],
    keys:    ['challenging', 'effortless'],
  },
  {
    id: 'q5',
    text: "When you abandon a book, is it more often because the characters didn't connect or because the story stalled?",
    options: ["Characters didn't connect", 'Story stalled / lost momentum'],
    keys:    ['dnf_characters', 'dnf_pacing'],
  },
];
