import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Taste Profile — recommendation confidence model
//
// Tiers:
//   0  = 0–4 strong signals → "We're learning your taste"
//   1  = 5–9 strong signals → "Early read on your taste"
//   2  = 10+ strong signals → "Personalized for you"
//   3  = 10+ strong signals + imported history with enrichment → "High-confidence recommendations"
//
// A "strong signal" = one finished book with at least one of: rating, taste_tags, review_body, or imported.
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
  completed_books_count: number;
  imported_books_count:  number;
  rated_books_count:     number;
  taste_tag_count:       number;
  review_count:          number;
};

export type TasteProfile = {
  tier:             ConfidenceTier;
  label:            string;
  confidence:       'low' | 'medium' | 'high';
  preferred_traits: Record<string, number>;   // e.g. { Pacing: 0.6 }
  avoided_traits:   Record<string, number>;   // e.g. { Romance: -0.7 }
  open_questions:   string[];
  evidence:         TasteProfileEvidence;
  strongSignalCount: number;
  nextTierAt:       number;  // signals needed to reach next tier
};

export type RecommendationExplanation = {
  book_id:            string;
  confidence_label:   string;
  why_it_fits:        string[];
  aligned_preferences: string[];
  risk_or_mismatch:   string | null;
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function computeConfidenceTier(
  evidence: TasteProfileEvidence,
  strongSignalCount: number,
): ConfidenceTier {
  const hasImport = evidence.imported_books_count > 0;
  const hasEnrich = evidence.rated_books_count > 0
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
  return 10; // tier 2 → 3 requires import, not just count
}

export function confidenceLevel(tier: ConfidenceTier): 'low' | 'medium' | 'high' {
  if (tier <= 1) return 'low';
  if (tier === 2) return 'medium';
  return 'high';
}

// ── Trait scoring ─────────────────────────────────────────────────────────────

type TasteTagPayload = { liked?: string[]; didnt_work?: string[] };

type RawUserBook = {
  status:      string;
  rating:      number | null;
  taste_tags:  TasteTagPayload | null;
  review_body: string | null;
  source:      string | null;
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

// ── Open question generation ──────────────────────────────────────────────────

function deriveOpenQuestions(
  evidence: TasteProfileEvidence,
  preferred: Record<string, number>,
): string[] {
  const qs: string[] = [];
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
  const { data } = await client
    .from('user_books')
    .select('status, rating, taste_tags, review_body, source')
    .eq('user_id', userId);

  const rows: RawUserBook[] = (data ?? []) as RawUserBook[];
  const finished = rows.filter(r => r.status === 'finished');

  const evidence: TasteProfileEvidence = {
    completed_books_count: finished.length,
    imported_books_count:  rows.filter(r => r.source === 'goodreads').length,
    rated_books_count:     rows.filter(r => r.rating !== null).length,
    taste_tag_count:       rows.filter(r => {
      const t = r.taste_tags;
      return t && ((t.liked?.length ?? 0) + (t.didnt_work?.length ?? 0)) > 0;
    }).length,
    review_count: rows.filter(r => r.review_body && r.review_body.trim() !== '').length,
  };

  const strongSignalCount = finished.filter(r =>
    r.rating !== null ||
    (r.taste_tags && ((r.taste_tags.liked?.length ?? 0) + (r.taste_tags.didnt_work?.length ?? 0)) > 0) ||
    (r.review_body && r.review_body.trim() !== '') ||
    r.source === 'goodreads'
  ).length;

  const tier       = computeConfidenceTier(evidence, strongSignalCount);
  const label      = CONFIDENCE_LABELS[tier];
  const confidence = confidenceLevel(tier);
  const nextAt     = tierNextThreshold(tier);

  const { preferred_traits, avoided_traits } = buildTraitScores(rows);
  const open_questions = deriveOpenQuestions(evidence, preferred_traits);

  return {
    tier,
    label,
    confidence,
    preferred_traits,
    avoided_traits,
    open_questions,
    evidence,
    strongSignalCount,
    nextTierAt: nextAt,
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
  const pref = profile.preferred_traits;
  const avoid = profile.avoided_traits;
  const { rated_books_count, imported_books_count, taste_tag_count } = profile.evidence;

  // Trait-driven hypotheses
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

  // Rating pattern hypothesis
  if (rated_books_count >= 5) {
    const totalPref = Object.values(pref).reduce((a, b) => a + b, 0);
    const totalAvoid = Object.values(avoid).reduce((a, b) => a + b, 0);
    if (totalPref > 0 && Math.abs(totalAvoid) < 0.2) {
      hyps.push({ slug: 'generous_rater', statement: 'You may prefer books that lean into strengths rather than being well-rounded.', confidence: 'tentative' });
    }
  }

  // Import-based hypothesis
  if (imported_books_count >= 20) {
    hyps.push({ slug: 'established_reader', statement: 'Your reading history suggests you have well-defined taste — recommendations can be quite targeted.', confidence: 'strong' });
  } else if (imported_books_count >= 5) {
    hyps.push({ slug: 'active_reader', statement: 'Your imported history gives us a starting point, though more signals will sharpen the picture.', confidence: 'tentative' });
  }

  // Fallback hypothesis if no signals
  if (hyps.length === 0) {
    hyps.push({ slug: 'early_stage', statement: 'Your reading profile is just getting started — rate a few finished books to help us understand your taste.', confidence: 'tentative' });
  }

  return hyps.slice(0, 5);
}

// ── Adaptive questions (fixed set, tradeoff-based) ────────────────────────────

export type DiagnosisQuestion = {
  id:      string;
  text:    string;
  options: [string, string];  // [A, B]
  keys:    [string, string];  // slug for each answer
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
    text: 'When you abandon a book, is it more often because the characters didn\'t connect or because the story stalled?',
    options: ['Characters didn\'t connect', 'Story stalled / lost momentum'],
    keys:    ['dnf_characters', 'dnf_pacing'],
  },
];
