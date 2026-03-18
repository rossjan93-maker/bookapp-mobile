// =============================================================================
// Recommender — book scoring and candidate sourcing
//
// Architecture:
//   getCandidateBooks(client, userId)
//     → async, queries books the user hasn't yet read
//   scoreBookForUser(book, profile)
//     → pure sync, returns score + reasons + risks
//   getRankedRecs(candidates, profile, limit)
//     → pure sync, scores all candidates and returns top-N with diversity
//   getPersonalizedRecs(client, userId, profile, limit)
//     → convenience wrapper: getCandidates + getRankedRecs
//
// Keeping scoring pure (no DB calls) allows search.tsx to batch getCandidates
// inside its existing Promise.all and run scoring synchronously afterwards,
// without a second round-trip.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TasteProfile }  from './tasteProfile';
import { getBookTraits }       from './bookTraits';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateBook = {
  id:          string;
  title:       string;
  author:      string;
  cover_url:   string | null;
  external_id: string | null;
  subjects:    string[] | null;
  page_count:  number | null;
  description: string | null;
};

export type ScoredBook = CandidateBook & {
  score:      number;
  confidence: 'low' | 'medium' | 'high';
  reasons:    string[];
  risks:      string[];
};

// ── Fit label helpers (used by the UI) ────────────────────────────────────────

export function fitLabel(score: number): string {
  if (score > 0.50) return 'Strong fit';
  if (score > 0.28) return 'Good match';
  return 'Worth exploring';
}

export function fitColor(score: number): string {
  if (score > 0.50) return '#16a34a';
  if (score > 0.28) return '#2563eb';
  return '#78716c';
}

// ── Candidate sourcing ────────────────────────────────────────────────────────

export async function getCandidateBooks(
  client: SupabaseClient,
  userId: string,
): Promise<CandidateBook[]> {
  const { data: userBooks } = await client
    .from('user_books')
    .select('book_id')
    .eq('user_id', userId);

  const readIds = new Set((userBooks ?? []).map((ub: { book_id: string }) => ub.book_id));

  // Prefer books with subject metadata (more scoreable)
  const { data: richBooks } = await client
    .from('books')
    .select('id, title, author, cover_url, external_id, subjects, page_count, description')
    .not('subjects', 'is', null)
    .limit(80);

  const richCandidates = ((richBooks ?? []) as CandidateBook[]).filter(b => !readIds.has(b.id));

  if (richCandidates.length >= 15) return richCandidates;

  // Supplement with books lacking subjects when the pool is thin
  const { data: sparseBooks } = await client
    .from('books')
    .select('id, title, author, cover_url, external_id, subjects, page_count, description')
    .is('subjects', null)
    .limit(40);

  const sparseCandidates = ((sparseBooks ?? []) as CandidateBook[]).filter(b => !readIds.has(b.id));
  return [...richCandidates, ...sparseCandidates].slice(0, 80);
}

// ── Scoring (pure) ────────────────────────────────────────────────────────────

export function scoreBookForUser(
  book: CandidateBook,
  profile: TasteProfile,
): Pick<ScoredBook, 'score' | 'confidence' | 'reasons' | 'risks'> {
  const bt         = getBookTraits(book);
  const pref       = profile.preferred_traits;
  const avoid      = profile.avoided_traits;
  const affinities = profile.genre_affinities ?? {};
  const reasons: string[] = [];
  const risks:   string[] = [];
  let score = 0;

  // 1. Preferred trait alignment
  const prefMatches: string[] = [];
  for (const [trait, userWeight] of Object.entries(pref)) {
    const bookWeight = bt.traits[trait] ?? 0;
    const contribution = userWeight * bookWeight;
    if (contribution > 0.22) {
      prefMatches.push(trait.toLowerCase());
      score += contribution;
    }
  }
  if (prefMatches.length >= 2) {
    reasons.push(`Aligns with your preference for ${prefMatches.slice(0, 2).join(' and ')}`);
  } else if (prefMatches.length === 1) {
    reasons.push(`Matches your appreciation for ${prefMatches[0]}`);
  }

  // 2. Avoided trait penalties
  const avoidHits: string[] = [];
  for (const [trait, penalty] of Object.entries(avoid)) {
    const bookWeight = bt.traits[trait] ?? 0;
    const contribution = penalty * bookWeight; // penalty < 0
    if (contribution < -0.18) {
      avoidHits.push(trait.toLowerCase());
      score += contribution;
    }
  }
  if (avoidHits.length > 0) {
    risks.push(`Leans toward ${avoidHits[0]} — which hasn't worked well for you`);
  }

  // 3. Genre affinity bonus / penalty
  if (bt.primaryGenre) {
    const affinity = affinities[bt.primaryGenre] ?? 0;
    if (affinity > 0.5) {
      score += 0.28;
      if (reasons.length < 2) reasons.push(`Fits a genre you consistently enjoy`);
    } else if (affinity > 0.2) {
      score += 0.12;
    } else if (affinity < -0.35) {
      score -= 0.22;
      if (risks.length < 1) {
        const label = bt.primaryGenre.replace('_', '/');
        risks.push(`You've had mixed results with ${label} before`);
      }
    }
  }

  // 4. Quality floor — surface only books with at least some positive signal
  const finalScore = Math.max(0, Math.min(1, score));

  // 5. Confidence calibration against profile quality
  let confidence: 'low' | 'medium' | 'high';
  if (profile.tier >= 3 && finalScore > 0.42) {
    confidence = 'high';
  } else if (profile.tier >= 2 && finalScore > 0.22) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    score:      +finalScore.toFixed(3),
    confidence,
    reasons:    [...new Set(reasons)].slice(0, 2),
    risks:      [...new Set(risks)].slice(0, 1),
  };
}

// ── Ranked recs (pure) ─────────────────────────────────────────────────────────

export function getRankedRecs(
  candidates: CandidateBook[],
  profile: TasteProfile,
  limit = 5,
): ScoredBook[] {
  if (candidates.length === 0) return [];

  const scored: ScoredBook[] = candidates.map(book => ({
    ...book,
    ...scoreBookForUser(book, profile),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Diversity: max 2 books per primary genre so results aren't all one genre
  const genreCount: Record<string, number> = {};
  const diverse: ScoredBook[] = [];
  for (const book of scored) {
    const genre = getBookTraits(book).primaryGenre ?? 'general';
    const count = genreCount[genre] ?? 0;
    if (count < 2) {
      diverse.push(book);
      genreCount[genre] = count + 1;
    }
    if (diverse.length >= limit) break;
  }

  return diverse;
}

// ── Convenience async wrapper ─────────────────────────────────────────────────

export async function getPersonalizedRecs(
  client: SupabaseClient,
  userId: string,
  profile: TasteProfile,
  limit = 5,
): Promise<ScoredBook[]> {
  const candidates = await getCandidateBooks(client, userId);
  return getRankedRecs(candidates, profile, limit);
}
