// =============================================================================
// expertRec.ts — Expert recommendation reasoning layer
//
// Implements three core functions:
//   buildReaderThesis    — Who is this reader? What do they consistently love?
//   judgeCandidateFit    — Does this book genuinely fit the thesis?
//   composeRecommendationSet — Select + rank the final picks with rich explanations
//
// Implementation note: v1 is implemented as deterministic TypeScript heuristics
// grounded entirely in the evidence pack. The function signatures and output
// schemas are designed for a future LLM-backed implementation — the heuristics
// can be replaced with a single structured prompt call with no changes to callers.
//
// Truthfulness rules enforced throughout:
//   • Canon tolerance ≠ canon preference (one loved classic ≠ classic reader)
//   • Repeated authors/series outweigh isolated exceptions
//   • Public popularity is never the primary justification
//   • Poetry/philosophy/plays receive form-appropriate trait claims only
//   • Weak evidence ≠ permission to recommend
// =============================================================================

import type { EvidencePack, CandidateEvidence } from './evidencePack';
import type { ScoredBook }                        from './recommender';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DominantLane = {
  label:       string;      // e.g. "Epic fantasy & speculative fiction"
  genre_key:   string;      // e.g. "fantasy_scifi"
  strength:    number;      // 0–1 from genre affinity
  explanation: string;      // grounded in actual books read
  evidence: {
    authors:  string[];
    books:    string[];
    themes:   string[];
  };
};

export type ExceptionLane = {
  label:        string;
  genre_key:    string;
  explanation:  string;
  why_not_core: string;     // why this is NOT a dominant lane
};

export type ReaderThesis = {
  /** Genres the user consistently reads and loves (strength > 0.25, ≥ 1 signal book). */
  dominant_lanes: DominantLane[];

  /** Genres that appear occasionally but aren't a genuine lane. */
  exception_lanes: ExceptionLane[];

  /** One-sentence core reading identity. */
  center_of_gravity: string;

  /** Things the reader consistently dislikes or avoids. */
  anti_preferences: string[];

  /**
   * Hard rules for recommendation truthfulness — things the expert layer
   * must never do regardless of score (e.g. "do not recommend poetry").
   */
  recommendation_guardrails: string[];

  /** Language style for explanations (e.g. 'character-focused', 'atmosphere-driven'). */
  explanation_language: string[];

  /** Confidence in the thesis based on signal quantity. */
  confidence: 'low' | 'medium' | 'high';
};

export type CandidateJudgment = {
  candidate_id:      string;
  verdict:           'strong_fit' | 'good_match' | 'worth_exploring' | 'reject';
  fit_score:         number;       // 0–1, expert-layer score (not raw deterministic)
  confidence:        'low' | 'medium' | 'high';
  primary_lane:      string | null;
  why_it_fits:       string[];
  risks:             string[];
  truthfulness_flags: string[];   // Issues found in the truthfulness audit
  rejection_reason:  string | null;
};

export type ExpertPick = {
  candidate_id: string;
  title:        string;
  author:       string;
  fit_label:    string;
  why:          string[];
  risks:        string[];
  source:       string;
  lane:         string | null;
  det_score:    number;
  expert_score: number;
};

export type ExpertRecResult = {
  reader_thesis: ReaderThesis;
  summary:       string;
  confidence:    'low' | 'medium' | 'high';
  picks:         ExpertPick[];
  omitted: Array<{
    candidate_id: string;
    title:        string;
    reason:       string;
  }>;
  /** Total candidates judged (for debug). */
  judged_count: number;
};

// ── Genre labels ──────────────────────────────────────────────────────────────

const GENRE_LABELS: Record<string, string> = {
  fantasy_scifi:    'fantasy & speculative fiction',
  thriller_mystery: 'thriller & mystery',
  romance:          'romance',
  horror:           'horror & gothic fiction',
  memoir_bio:       'memoir & biography',
  nonfiction:       'nonfiction',
  literary:         'literary fiction',
  general:          'general fiction',
};

const GENRE_DISPLAY: Record<string, string> = {
  fantasy_scifi:    'Fantasy & Sci-Fi',
  thriller_mystery: 'Thriller & Mystery',
  romance:          'Romance',
  horror:           'Horror',
  memoir_bio:       'Memoir & Biography',
  nonfiction:       'Nonfiction',
  literary:         'Literary Fiction',
  general:          'General Fiction',
};

// Form-detection: subject patterns that indicate non-prose book forms
const FORM_PATTERNS: Array<[RegExp, string]> = [
  [/poetry|poems|verse|lyric poetry|collected poems/, 'poetry'],
  [/drama|play|playwright|stage|theatre|theater|stagecraft/, 'play'],
  [/short stories|short fiction|flash fiction|novella collection/, 'short_stories'],
  [/graphic novel|comic|manga|illustrated/, 'graphic'],
  [/anthology|collection of/, 'anthology'],
];

function detectForm(subjects: string[]): string | null {
  const corpus = subjects.join(' ').toLowerCase();
  for (const [pat, form] of FORM_PATTERNS) {
    if (pat.test(corpus)) return form;
  }
  return null;
}

function detectGenreFromSubjects(subjects: string[]): string | null {
  const corpus = subjects.join(' ').toLowerCase();
  if (/memoir|autobiography|biography|biographical/.test(corpus))              return 'memoir_bio';
  if (/nonfiction|non-fiction|self-help|psychology|science|philosophy/.test(corpus)) return 'nonfiction';
  if (/horror|gothic|ghost|supernatural|occult/.test(corpus))                  return 'horror';
  if (/romance|romantic fiction|love story/.test(corpus))                      return 'romance';
  if (/thriller|mystery|crime fiction|detective|suspense|noir/.test(corpus))   return 'thriller_mystery';
  if (/fantasy|science fiction|sci-fi|dystopian|speculative|space opera/.test(corpus)) return 'fantasy_scifi';
  if (/literary fiction|contemporary fiction/.test(corpus))                    return 'literary';
  return null;
}

// ── buildReaderThesis ─────────────────────────────────────────────────────────

/**
 * Analyse the evidence pack and construct a structured reader thesis.
 * Grounded entirely in evidence — no invented facts.
 */
export function buildReaderThesis(pack: EvidencePack): ReaderThesis {
  const { profile, loved_books, repeated_authors, liked_subjects, diagnosis_answers } = pack;

  // ── Identify dominant vs exception lanes from genre affinities ────────────
  const affinities = Object.entries(profile.genre_affinities)
    .sort((a, b) => b[1] - a[1]);

  const dominant_lanes: DominantLane[] = [];
  const exception_lanes: ExceptionLane[] = [];

  for (const [genre_key, strength] of affinities) {
    if (strength <= 0) continue;

    const label       = GENRE_LABELS[genre_key] ?? genre_key;
    const lovedInLane = loved_books.filter(b => b.genre === genre_key);
    const authorSet   = new Set(lovedInLane.map(b => b.author?.toLowerCase().trim() ?? ''));
    const laneAuthors = repeated_authors.filter(a => authorSet.has(a.toLowerCase().trim()));
    const laneBooks   = lovedInLane.slice(0, 3).map(b => b.title);
    const laneThemes  = liked_subjects
      .filter(s => isSubjectInGenre(s, genre_key))
      .slice(0, 3);

    if (strength >= 0.25 && lovedInLane.length >= 1) {
      dominant_lanes.push({
        label,
        genre_key,
        strength,
        explanation: buildLaneExplanation(genre_key, strength, lovedInLane, laneAuthors),
        evidence: {
          authors: laneAuthors.slice(0, 3),
          books:   laneBooks,
          themes:  laneThemes,
        },
      });
    } else if (strength >= 0.10) {
      exception_lanes.push({
        label,
        genre_key,
        explanation: `Appears occasionally in your reading history.`,
        why_not_core: lovedInLane.length === 0
          ? 'No finished books in this genre with a strong rating.'
          : `Only ${lovedInLane.length} loved book${lovedInLane.length > 1 ? 's' : ''} — not enough for a consistent lane.`,
      });
    }
  }

  // ── Center of gravity ─────────────────────────────────────────────────────
  const topTrait = Object.entries(profile.preferred_traits)
    .filter(([, v]) => v >= 0.3)
    .sort((a, b) => b[1] - a[1])[0];
  const center_of_gravity = buildCenterOfGravity(dominant_lanes, topTrait, repeated_authors, pack);

  // ── Anti-preferences ─────────────────────────────────────────────────────
  const anti_preferences: string[] = [];

  // Traits the user consistently rates down
  for (const [trait, weight] of Object.entries(profile.avoided_traits)) {
    if (weight < -0.25) {
      anti_preferences.push(`Books where ${trait.toLowerCase()} is a defining feature`);
    }
  }
  // Genres with negative or near-zero affinity (only if user has enough data)
  if (loved_books.length >= 5) {
    for (const [genre_key, strength] of affinities) {
      if (strength < -0.1) {
        anti_preferences.push(`${GENRE_DISPLAY[genre_key] ?? genre_key} as a primary genre`);
      }
    }
  }
  // Explicit diagnosis answers that indicate avoidance
  if (diagnosis_answers) {
    for (const [, answer] of Object.entries(diagnosis_answers)) {
      if (typeof answer === 'string' && /avoid|not|don.t like|dislike/i.test(answer)) {
        anti_preferences.push(answer.slice(0, 80));
      }
    }
  }

  // ── Guardrails (truthfulness rules) ──────────────────────────────────────
  const recommendation_guardrails = buildGuardrails(pack, dominant_lanes);

  // ── Explanation language style ────────────────────────────────────────────
  const explanation_language = buildExplanationLanguage(profile, dominant_lanes, repeated_authors);

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidence: ReaderThesis['confidence'] =
    profile.tier >= 2 ? 'high' :
    profile.tier >= 1 ? 'medium' :
    'low';

  return {
    dominant_lanes,
    exception_lanes,
    center_of_gravity,
    anti_preferences,
    recommendation_guardrails,
    explanation_language,
    confidence,
  };
}

// ── judgeCandidateFit ─────────────────────────────────────────────────────────

/**
 * Judge a single candidate against the reader thesis.
 * Returns a truthfulness-audited verdict.
 */
export function judgeCandidateFit(
  thesis:    ReaderThesis,
  candidate: CandidateEvidence,
  pack:      EvidencePack,
): CandidateJudgment {
  const truthfulness_flags: string[] = [];
  const why_it_fits:        string[] = [];
  const risks:               string[] = [];

  const candidateGenre  = detectGenreFromSubjects(candidate.subjects);
  const candidateForm   = detectForm(candidate.subjects);
  const dominantKeys    = new Set(thesis.dominant_lanes.map(l => l.genre_key));
  const exceptionKeys   = new Set(thesis.exception_lanes.map(l => l.genre_key));

  // ── Guardrail enforcement ─────────────────────────────────────────────────
  for (const guardrail of thesis.recommendation_guardrails) {
    const gl = guardrail.toLowerCase();
    // Form guardrails
    if (candidateForm === 'poetry' && gl.includes('poetry')) {
      return reject(candidate.id, `This is a poetry collection. ${guardrail}`);
    }
    if (candidateForm === 'play' && gl.includes('play')) {
      return reject(candidate.id, `This is a play. ${guardrail}`);
    }
    if (candidateForm === 'graphic' && gl.includes('graphic novel')) {
      return reject(candidate.id, `This is a graphic novel. ${guardrail}`);
    }
  }

  // ── Form-specific truthfulness audit ─────────────────────────────────────
  if (candidateForm === 'poetry') {
    truthfulness_flags.push('poetry_form_not_in_dominant_lanes');
    // Only allow through if user has explicit poetry preference signal
    const poetryInLanes = [...dominantKeys, ...exceptionKeys].includes('literary');
    const likedPoetry   = pack.loved_books.some(b => b.subjects.join(' ').toLowerCase().includes('poetry'));
    if (!poetryInLanes || !likedPoetry) {
      return reject(candidate.id, 'Poetry collection with no evidence of user interest in poetry.');
    }
  }
  if (candidateForm === 'play') {
    truthfulness_flags.push('play_form_not_in_dominant_lanes');
    return reject(candidate.id, 'Dramatic play with no evidence of user interest in stage works.');
  }

  // ── Lane matching ─────────────────────────────────────────────────────────
  let primary_lane: string | null = null;
  let lane_score = 0;

  if (candidateGenre && dominantKeys.has(candidateGenre)) {
    primary_lane = thesis.dominant_lanes.find(l => l.genre_key === candidateGenre)?.label ?? null;
    const laneStrength = thesis.dominant_lanes.find(l => l.genre_key === candidateGenre)?.strength ?? 0;
    lane_score = laneStrength * 0.4; // up to 0.4 from lane match

    why_it_fits.push(`Falls within ${GENRE_DISPLAY[candidateGenre] ?? candidateGenre} — a genre you consistently enjoy`);

    // Author evidence
    const authorKey = candidate.author?.toLowerCase().trim() ?? '';
    if (pack.repeated_authors.includes(authorKey)) {
      lane_score += 0.15;
      why_it_fits.push(`You've read and loved multiple books by ${candidate.author}`);
    } else if (pack.loved_books.some(b => b.author?.toLowerCase() === authorKey)) {
      lane_score += 0.08;
      why_it_fits.push(`You've previously enjoyed ${candidate.author}`);
    }

    // Subject overlap with liked subjects
    const subjectMatches = candidate.subjects.filter(s =>
      pack.liked_subjects.some(ls => ls.includes(s.toLowerCase()) || s.toLowerCase().includes(ls))
    );
    if (subjectMatches.length >= 2) {
      lane_score += 0.12;
      why_it_fits.push(`Themes (${subjectMatches.slice(0, 2).join(', ')}) align with your reading history`);
    } else if (subjectMatches.length === 1) {
      lane_score += 0.06;
    }

  } else if (candidateGenre && exceptionKeys.has(candidateGenre)) {
    primary_lane = thesis.exception_lanes.find(l => l.genre_key === candidateGenre)?.label ?? null;
    lane_score = 0.15; // weak lane match — worth exploring
    why_it_fits.push(`Touches on ${GENRE_DISPLAY[candidateGenre] ?? candidateGenre}, which occasionally appears in your reading`);
    risks.push(`Not a primary lane for you — this is an exploratory pick`);

  } else if (!candidateGenre) {
    // Unknown genre — lean on deterministic score
    lane_score = candidate.det_score * 0.3;
    risks.push('Limited metadata makes this harder to assess');
    truthfulness_flags.push('unknown_genre');
  } else {
    // Candidate is in a genre the user hasn't read or doesn't like
    const affinity = pack.profile.genre_affinities[candidateGenre] ?? 0;
    if (affinity < -0.1) {
      return reject(candidate.id,
        `${GENRE_DISPLAY[candidateGenre] ?? candidateGenre} genre doesn't match your reading taste.`);
    }
    lane_score = Math.max(0, affinity * 0.3);
    risks.push(`${GENRE_DISPLAY[candidateGenre] ?? 'This genre'} isn't well represented in your reading history`);
    truthfulness_flags.push('outside_dominant_lanes');
  }

  // ── Trait alignment bonus ─────────────────────────────────────────────────
  const traitScore = Math.min(0.2, candidate.det_score * 0.35);
  if (candidate.det_score >= 0.45 && why_it_fits.length < 3) {
    const topPref = Object.entries(pack.profile.preferred_traits)
      .filter(([, v]) => v >= 0.3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => k.toLowerCase());
    if (topPref.length > 0) {
      why_it_fits.push(`Shows signs of ${topPref.join(' and ')} — qualities you rate highly`);
    }
  }

  // ── Anti-preference check ─────────────────────────────────────────────────
  for (const antipref of pack.profile.avoided_traits ? Object.entries(pack.profile.avoided_traits) : []) {
    const [trait, weight] = antipref;
    if (weight < -0.3) {
      // Check if candidate subjects suggest this avoided trait
      const traitCorpus = candidate.subjects.join(' ').toLowerCase();
      const traitSignals: Record<string, RegExp> = {
        Romance:      /romance|romantic/,
        Violence:     /war|battle|combat|brutal/,
        'Slow pacing': /slow|meditative|contemplative/,
      };
      if (traitSignals[trait]?.test(traitCorpus)) {
        risks.push(`May contain ${trait.toLowerCase()} elements you tend to rate down`);
      }
    }
  }

  // ── Final expert score ─────────────────────────────────────────────────────
  const fit_score = Math.min(1, lane_score + traitScore);
  const hasTruthFlags = truthfulness_flags.length > 0;

  let verdict: CandidateJudgment['verdict'];
  if (hasTruthFlags && fit_score < 0.4) {
    verdict = 'reject';
  } else if (fit_score >= 0.55) {
    verdict = 'strong_fit';
  } else if (fit_score >= 0.35) {
    verdict = 'good_match';
  } else if (fit_score >= 0.18) {
    verdict = 'worth_exploring';
  } else {
    verdict = 'reject';
  }

  const confidence: CandidateJudgment['confidence'] =
    truthfulness_flags.length > 1 ? 'low' :
    fit_score >= 0.4               ? 'high' :
    'medium';

  return {
    candidate_id:      candidate.id,
    verdict,
    fit_score,
    confidence,
    primary_lane,
    why_it_fits:       why_it_fits.slice(0, 3),
    risks:             risks.slice(0, 2),
    truthfulness_flags,
    rejection_reason:  verdict === 'reject' ? 'Below expert fit threshold' : null,
  };
}

// ── composeRecommendationSet ──────────────────────────────────────────────────

/**
 * Select the final recommendation set from judged candidates.
 * Applies lane diversity and produces richer per-pick explanations.
 */
export function composeRecommendationSet(
  thesis:           ReaderThesis,
  judged:           Map<string, CandidateJudgment>,
  candidates:       CandidateEvidence[],
  baseRecs:         ScoredBook[],
  limit:            number = 5,
): ExpertRecResult {
  const omitted: ExpertRecResult['omitted'] = [];
  const picks:   ExpertPick[] = [];
  const laneCount: Record<string, number> = {};
  const MAX_PER_LANE = 2;

  // Merge judgment into base recs — maintain deterministic order as tiebreaker
  const judgedCandidates = candidates
    .map(c => {
      const j = judged.get(c.id);
      return j ? { candidate: c, judgment: j } : null;
    })
    .filter((x): x is { candidate: CandidateEvidence; judgment: CandidateJudgment } => x !== null)
    .sort((a, b) => {
      // Primary sort: expert verdict tier
      const verdictScore = (v: string) =>
        v === 'strong_fit' ? 4 : v === 'good_match' ? 3 : v === 'worth_exploring' ? 2 : 0;
      const vDiff = verdictScore(b.judgment.verdict) - verdictScore(a.judgment.verdict);
      if (vDiff !== 0) return vDiff;
      // Secondary: expert fit score
      const fDiff = b.judgment.fit_score - a.judgment.fit_score;
      if (Math.abs(fDiff) > 0.05) return fDiff;
      // Tiebreaker: deterministic score
      return b.candidate.det_score - a.candidate.det_score;
    });

  for (const { candidate, judgment } of judgedCandidates) {
    if (judgment.verdict === 'reject') {
      omitted.push({
        candidate_id: candidate.id,
        title:        candidate.title,
        reason:       judgment.rejection_reason ?? 'Below fit threshold',
      });
      continue;
    }

    // Lane diversity cap
    const lane = judgment.primary_lane ?? 'general';
    if ((laneCount[lane] ?? 0) >= MAX_PER_LANE) {
      omitted.push({
        candidate_id: candidate.id,
        title:        candidate.title,
        reason:       `Lane cap reached for "${lane}" (max ${MAX_PER_LANE} per lane)`,
      });
      continue;
    }

    // Find corresponding base rec for metadata
    const baseRec = baseRecs.find(r =>
      r.external_id === candidate.external_id || r.id === candidate.id
    );

    const fit_label = verdict_to_label(judgment.verdict);
    const why       = buildPickExplanation(judgment, thesis, candidate);

    picks.push({
      candidate_id: candidate.id,
      title:        candidate.title,
      author:       candidate.author,
      fit_label,
      why,
      risks:        judgment.risks,
      source:       candidate.source,
      lane:         judgment.primary_lane,
      det_score:    candidate.det_score,
      expert_score: judgment.fit_score,
    });

    laneCount[lane] = (laneCount[lane] ?? 0) + 1;
    if (picks.length >= limit) break;
  }

  // If expert layer produced fewer picks than limit, pad with base rec fallbacks
  // that weren't already included (don't reject books that had no judgment issues)
  if (picks.length < limit) {
    for (const base of baseRecs) {
      if (picks.length >= limit) break;
      const alreadyIncluded = picks.some(p => p.candidate_id === base.id || p.title === base.title);
      if (alreadyIncluded) continue;
      const judgment = judged.get(base.id);
      if (judgment?.verdict === 'reject') continue; // explicitly rejected — don't include
      picks.push({
        candidate_id: base.id,
        title:        base.title,
        author:       base.author,
        fit_label:    'Worth exploring',
        why:          base.reasons.slice(0, 2),
        risks:        base.risks,
        source:       base._source,
        lane:         null,
        det_score:    base.score,
        expert_score: 0,
      });
    }
  }

  const confidence: ExpertRecResult['confidence'] =
    thesis.confidence === 'high' && picks.filter(p => p.expert_score >= 0.4).length >= 3 ? 'high' :
    picks.length >= 3 ? 'medium' :
    'low';

  const summary = buildRecommendationSummary(thesis, picks, confidence);

  return {
    reader_thesis: thesis,
    summary,
    confidence,
    picks,
    omitted,
    judged_count: judgedCandidates.length,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function reject(candidate_id: string, reason: string): CandidateJudgment {
  return {
    candidate_id,
    verdict:           'reject',
    fit_score:         0,
    confidence:        'high',
    primary_lane:      null,
    why_it_fits:       [],
    risks:             [],
    truthfulness_flags: ['explicit_reject'],
    rejection_reason:  reason,
  };
}

function verdict_to_label(verdict: CandidateJudgment['verdict']): string {
  switch (verdict) {
    case 'strong_fit':     return 'Strong fit';
    case 'good_match':     return 'Good match';
    case 'worth_exploring': return 'Worth exploring';
    default:               return 'Worth exploring';
  }
}

function buildLaneExplanation(
  genre_key:   string,
  strength:    number,
  lovedBooks:  Array<{ title: string; author: string }>,
  authors:     string[],
): string {
  const genreDisplay = GENRE_DISPLAY[genre_key] ?? genre_key;
  const bookCount    = lovedBooks.length;
  const authorNote   = authors.length >= 2
    ? ` including works by ${authors.slice(0, 2).join(' and ')}`
    : authors.length === 1 ? ` including ${authors[0]}` : '';

  if (strength >= 0.5) {
    return `${genreDisplay} is a clear primary interest — you've read and loved ${bookCount} book${bookCount > 1 ? 's' : ''} in this space${authorNote}.`;
  }
  return `${genreDisplay} appears consistently in your reading history (${bookCount} loved book${bookCount > 1 ? 's' : ''}${authorNote}).`;
}

function buildCenterOfGravity(
  dominant_lanes:   DominantLane[],
  topTrait:         [string, number] | undefined,
  repeated_authors: string[],
  pack:             EvidencePack,
): string {
  if (dominant_lanes.length === 0) return 'A reader still exploring different genres and styles.';

  const topLane  = dominant_lanes[0];
  const traitStr = topTrait ? ` You particularly value ${topTrait[0].toLowerCase()} in what you read.` : '';
  const authStr  = repeated_authors.length >= 2
    ? ` You show strong author loyalty, returning to writers like ${repeated_authors.slice(0, 2).join(' and ')}.`
    : '';

  if (dominant_lanes.length >= 2) {
    const second = dominant_lanes[1];
    return `Primarily a ${topLane.label} reader, with a secondary interest in ${second.label}.${traitStr}${authStr}`;
  }

  return `A focused ${topLane.label} reader.${traitStr}${authStr}`;
}

function buildGuardrails(pack: EvidencePack, dominant_lanes: DominantLane[]): string[] {
  const guardrails: string[] = [];
  const dominantGenres = new Set(dominant_lanes.map(l => l.genre_key));

  // Form guardrails: never recommend poetry/plays unless the user reads them
  const lovesPoetrySingal = pack.loved_books.some(b =>
    b.subjects.join(' ').toLowerCase().includes('poetry') ||
    b.subjects.join(' ').toLowerCase().includes('poems')
  );
  if (!lovesPoetrySingal) {
    guardrails.push('Do not recommend poetry collections or verse — no evidence of interest in poetry.');
  }

  const lovesPlays = pack.loved_books.some(b =>
    b.subjects.join(' ').toLowerCase().match(/drama|play|playwright|theatre/)
  );
  if (!lovesPlays) {
    guardrails.push('Do not recommend plays or dramatic works — no evidence of interest in stage works.');
  }

  // Graphic novel guardrail
  const lovesGraphic = pack.loved_books.some(b =>
    b.subjects.join(' ').toLowerCase().match(/graphic novel|comic|manga/)
  );
  if (!lovesGraphic) {
    guardrails.push('Do not recommend graphic novels or comics — no evidence of interest.');
  }

  // Genre guardrails: avoid genres not in dominant or exception lanes
  const allKnownGenres = ['fantasy_scifi', 'thriller_mystery', 'romance', 'horror', 'memoir_bio', 'nonfiction', 'literary', 'general'];
  const exceptionKeys = new Set(pack.profile.genre_affinities
    ? Object.entries(pack.profile.genre_affinities)
        .filter(([, v]) => v >= 0.1)
        .map(([k]) => k)
    : []
  );

  for (const genre of allKnownGenres) {
    const affinity = pack.profile.genre_affinities[genre] ?? 0;
    if (!dominantGenres.has(genre) && !exceptionKeys.has(genre) && affinity < -0.05) {
      guardrails.push(`Avoid recommending ${GENRE_DISPLAY[genre] ?? genre} — negative affinity in user history.`);
    }
  }

  // Anti-preference guardrails from heavily avoided traits
  for (const [trait, weight] of Object.entries(pack.profile.avoided_traits ?? {})) {
    if (weight < -0.4) {
      guardrails.push(`Avoid books where ${trait.toLowerCase()} is a central element — user consistently rates this down.`);
    }
  }

  return guardrails;
}

function buildExplanationLanguage(
  profile:       EvidencePack['profile'],
  dominant_lanes: DominantLane[],
  repeated_authors: string[],
): string[] {
  const style: string[] = [];
  const pref = profile.preferred_traits;

  if ((pref['Characters'] ?? 0) >= 0.35) style.push('character-focused');
  if ((pref['Atmosphere'] ?? 0) >= 0.35) style.push('atmosphere-driven');
  if ((pref['Pacing'] ?? 0)    >= 0.35) style.push('pacing-conscious');
  if ((pref['Originality'] ?? 0) >= 0.35) style.push('originality-seeking');
  if ((pref['Emotional'] ?? 0) >= 0.35) style.push('emotionally resonant');
  if ((pref['Prose'] ?? 0)     >= 0.35) style.push('prose-quality-conscious');

  if (repeated_authors.length >= 3) style.push('author-loyal');
  if (dominant_lanes.length === 1)   style.push('genre-focused');
  if (dominant_lanes.length >= 3)    style.push('eclectic');

  return style.length > 0 ? style : ['exploratory'];
}

function buildPickExplanation(
  judgment: CandidateJudgment,
  thesis:   ReaderThesis,
  candidate: CandidateEvidence,
): string[] {
  const reasons: string[] = [...judgment.why_it_fits];

  // Add lane-context reason if not already covered
  if (judgment.primary_lane && !reasons.some(r => r.includes(judgment.primary_lane!))) {
    reasons.unshift(`Fits your ${judgment.primary_lane} lane`);
  }

  // Add thesis-level context
  if (thesis.explanation_language.includes('author-loyal') && candidate.author) {
    const authorKey = candidate.author.toLowerCase().trim();
    // already handled in why_it_fits
  }

  return reasons.slice(0, 3);
}

function buildRecommendationSummary(
  thesis:     ReaderThesis,
  picks:      ExpertPick[],
  confidence: ExpertRecResult['confidence'],
): string {
  if (picks.length === 0) return 'No strong matches found in the current candidate pool.';

  const laneCoverage = [...new Set(picks.map(p => p.lane).filter(Boolean))];
  const topLane      = thesis.dominant_lanes[0]?.label ?? 'your interests';

  if (confidence === 'high') {
    return `${picks.length} carefully selected picks grounded in your ${topLane} reading pattern${laneCoverage.length > 1 ? ` and ${laneCoverage.length - 1} other lane${laneCoverage.length > 2 ? 's' : ''}` : ''}.`;
  }
  if (confidence === 'medium') {
    return `${picks.length} picks matched to your reading history${thesis.dominant_lanes.length ? ` across ${thesis.dominant_lanes.length} lane${thesis.dominant_lanes.length > 1 ? 's' : ''}` : ''}.`;
  }
  return `${picks.length} picks based on early reading signals. Rate more books to sharpen these recommendations.`;
}

function isSubjectInGenre(subject: string, genre_key: string): boolean {
  const s = subject.toLowerCase();
  switch (genre_key) {
    case 'fantasy_scifi':    return /fantasy|science fiction|sci-fi|speculative|dystopian/.test(s);
    case 'thriller_mystery': return /thriller|mystery|crime|detective|suspense|noir/.test(s);
    case 'romance':          return /romance|romantic/.test(s);
    case 'horror':           return /horror|gothic|supernatural/.test(s);
    case 'memoir_bio':       return /memoir|biography|autobiography/.test(s);
    case 'nonfiction':       return /nonfiction|non-fiction|science|psychology|history/.test(s);
    case 'literary':         return /literary|contemporary fiction/.test(s);
    default:                 return false;
  }
}
