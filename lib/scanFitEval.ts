// =============================================================================
// scanFitEval — "Will I like this?" fit evaluation for scanned physical books
//
// This module is the bridge between a scanned ISBN and the existing
// recommendation / taste-fit engine.  It does NOT build a parallel scoring
// system; it reuses scoreBookForUser, computeFitClass, and the TasteProfile
// exactly as the recommendation tab does.
//
// Flow:
//   1. resolveISBN(isbn)         — Google Books (primary) + OL (subjects + key)
//   2. searchByTitle(title, author) — manual fallback resolution
//   3. evaluateScanFit(book, profile, feedback) — pure fit evaluation
//      a. Build CandidateBook shape from resolved metadata
//      b. Run inferConsensusTraits for enrichment (sync, no API call)
//      c. Call scoreBookForUser — same function as the recommender
//      d. Call computeFitClass — same CoG classifier as the recommender
//      e. Apply CoG delta, derive verdict + confidence
//      f. Return ScanFitResult
// =============================================================================

import { scoreBookForUser }                        from './recommender';
import type { CandidateBook }                      from './recommender';
import type { TasteProfile }                       from './tasteProfile';
import type { FeedbackContext }                    from './recFeedback';
import { computeCenterOfGravity, computeFitClass, classifyMarketPosition } from './fitClassifier';
import { detectBookLane }                          from './bookTraits';
import { inferConsensusTraits }                    from './bookEnrichment';
import type { BookEnrichmentProfile }              from './bookEnrichment';

// ── Constants ─────────────────────────────────────────────────────────────────

const API_KEY: string | null =
  (typeof process !== 'undefined' &&
   typeof process.env?.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY === 'string' &&
   process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim().length > 0)
    ? process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim()
    : null;

// ── Types ─────────────────────────────────────────────────────────────────────

export type MetaQuality = 'full' | 'partial' | 'minimal';

export type ResolvedBook = {
  isbn:         string;
  title:        string;
  author:       string;
  cover_url:    string | null;
  description:  string | null;
  page_count:   number | null;
  subjects:     string[];        // merged from GB categories + OL subjects
  categories:   string[];        // raw GB categories (for trait inference)
  publishYear:  number | null;
  externalId:   string | null;   // OL /works/OLxxxW key (null if OL lookup failed)
  metaQuality:  MetaQuality;
};

export type ScanVerdict =
  | 'strong_fit'
  | 'likely_fit'
  | 'mixed_fit'
  | 'not_for_you';

export const VERDICT_LABELS: Record<ScanVerdict, string> = {
  strong_fit:  'Strong fit',
  likely_fit:  'Likely fit',
  mixed_fit:   'Mixed signals',
  not_for_you: 'Probably not for you',
};

export const VERDICT_HEADLINES: Record<ScanVerdict, string> = {
  strong_fit:  'Yes — this looks like your kind of book.',
  likely_fit:  'Probably yes.',
  mixed_fit:   'This could go either way.',
  not_for_you: 'Not a good fit for you.',
};

export const VERDICT_GUIDANCE: Record<ScanVerdict, string> = {
  strong_fit:  'Strong chance you\'ll enjoy this.',
  likely_fit:  'Strong chance you\'ll enjoy this.',
  mixed_fit:   'This could go either way.',
  not_for_you: 'You can safely skip this.',
};

export type ScanFitResult = {
  book:          ResolvedBook;
  score:         number;         // 0–1 internal
  score_display: number;         // 0–100 rounded
  verdict:       ScanVerdict;
  verdict_label: string;
  confidence:    'high' | 'medium' | 'low';
  reasons:       string[];       // 2–3 user-facing reasons
  caution:       string | null;  // 1 risk/caution if present
  guidance:      string;         // decision nudge line shown below reasons
  low_signal:    boolean;        // true = tier ≤ 1 (not enough taste data)
  fit_class:     string;         // 'core_fit' | 'adjacent_fit' | 'stretch_fit' | 'reject'
  external_id:   string | null;  // for feedback persistence
};

// ── ISBN resolution via Google Books + Open Library ──────────────────────────

type GBItem = {
  volumeInfo?: {
    title?:        string;
    authors?:      string[];
    description?:  string;
    pageCount?:    number;
    categories?:   string[];
    publishedDate?: string;
    imageLinks?:   { thumbnail?: string; smallThumbnail?: string };
  };
};

async function gbFetch(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);
    const res        = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function resolveISBN(isbn: string): Promise<ResolvedBook | null> {
  const clean = isbn.replace(/[-\s]/g, '').trim();
  if (clean.length < 10) return null;

  const keyParam = API_KEY ? `&key=${API_KEY}` : '';

  // ── Google Books ISBN lookup (primary) ────────────────────────────────────
  let title       = '';
  let author      = 'Unknown author';
  let cover_url:   string | null = null;
  let description: string | null = null;
  let page_count:  number | null = null;
  let publishYear: number | null = null;
  let categories:  string[]      = [];

  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${clean}&maxResults=1${keyParam}`;
  const gbData = await gbFetch(gbUrl, 5000) as { items?: GBItem[] } | null;
  const vi = gbData?.items?.[0]?.volumeInfo;

  if (vi) {
    title = vi.title ?? '';
    if (Array.isArray(vi.authors) && vi.authors.length > 0) author = vi.authors[0];
    if (typeof vi.description === 'string' && vi.description.length > 20) description = vi.description;
    if (typeof vi.pageCount === 'number' && vi.pageCount >= 30) page_count = vi.pageCount;
    if (Array.isArray(vi.categories)) categories = vi.categories;
    const thumb = vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail;
    if (typeof thumb === 'string') cover_url = thumb.replace(/^http:\/\//, 'https://');
    if (typeof vi.publishedDate === 'string') {
      const y = parseInt(vi.publishedDate.slice(0, 4), 10);
      if (!isNaN(y) && y > 1000) publishYear = y;
    }
  }

  if (!title) return null;  // Google Books found nothing — ISBN unknown

  // ── Open Library ISBN lookup (work key + subjects) ────────────────────────
  let externalId:  string | null = null;
  let olSubjects:  string[]      = [];

  type OLDoc = { key?: string; subject?: string[] };
  const olUrl  = `https://openlibrary.org/search.json?isbn=${clean}&limit=1&fields=key,subject`;
  const olData = await gbFetch(olUrl, 3000) as { docs?: OLDoc[] } | null;
  const olDoc  = olData?.docs?.[0];
  if (olDoc) {
    externalId = olDoc.key ?? null;
    olSubjects = Array.isArray(olDoc.subject) ? olDoc.subject.slice(0, 20) : [];
  }

  // ── Merge subjects ────────────────────────────────────────────────────────
  const gbSubjects = categories.flatMap(c => c.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean));
  const merged     = Array.from(new Set([
    ...gbSubjects.map(s => s.toLowerCase()),
    ...olSubjects.map(s => s.toLowerCase()),
  ])).slice(0, 25);

  const metaQuality: MetaQuality =
    cover_url && description && merged.length > 2 ? 'full'
    : (cover_url || description)                   ? 'partial'
    :                                                 'minimal';

  return {
    isbn: clean, title, author, cover_url, description, page_count,
    subjects: merged, categories, publishYear, externalId, metaQuality,
  };
}

// ── Manual title + author search (fallback) ───────────────────────────────────

export async function searchByTitle(
  title:  string,
  author: string,
): Promise<ResolvedBook | null> {
  if (!title.trim()) return null;

  const keyParam   = API_KEY ? `&key=${API_KEY}` : '';
  const authorPart = author.trim()
    ? `+inauthor:${encodeURIComponent(author.trim().slice(0, 40))}`
    : '';
  const q = `intitle:${encodeURIComponent(title.trim().slice(0, 60))}${authorPart}`;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3${keyParam}`;

  const data = await gbFetch(url, 5000) as { items?: GBItem[] } | null;
  if (!data?.items?.length) return null;

  for (const item of data.items) {
    const vi = item.volumeInfo;
    if (!vi?.title) continue;

    // Basic title sanity check
    const expWords  = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const resWords  = vi.title.toLowerCase().split(/\s+/);
    const hits      = expWords.filter(w => resWords.some(r => r.includes(w))).length;
    if (expWords.length > 0 && hits / expWords.length < 0.5) continue;

    const categories: string[] = Array.isArray(vi.categories) ? vi.categories : [];
    const gbSubjects = categories.flatMap(c => c.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean));
    const subjects   = Array.from(new Set(gbSubjects.map(s => s.toLowerCase()))).slice(0, 20);

    const thumb      = vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail;
    const cover_url  = typeof thumb === 'string' ? thumb.replace(/^http:\/\//, 'https://') : null;
    const desc       = typeof vi.description === 'string' && vi.description.length > 20
                         ? vi.description : null;
    const pc         = typeof vi.pageCount === 'number' && vi.pageCount >= 30 ? vi.pageCount : null;
    let publishYear: number | null = null;
    if (typeof vi.publishedDate === 'string') {
      const y = parseInt(vi.publishedDate.slice(0, 4), 10);
      if (!isNaN(y) && y > 1000) publishYear = y;
    }

    const metaQuality: MetaQuality =
      cover_url && desc && subjects.length > 2 ? 'full'
      : (cover_url || desc)                    ? 'partial'
      :                                           'minimal';

    return {
      isbn:         '',
      title:        vi.title,
      author:       (Array.isArray(vi.authors) ? vi.authors[0] : null) ?? author,
      cover_url,
      description:  desc,
      page_count:   pc,
      subjects,
      categories,
      publishYear,
      externalId:   null,
      metaQuality,
    };
  }

  return null;
}

// ── Fit evaluation ────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Generic / abstract phrases that add no information — stripped from positive reasons.
const FILLER_PHRASES = [
  'reasonable next read',
  'sits near your reading center',
  'near your reading center',
  'a step outside your main lane',
  'reasonable match based on',
  'a reasonable match',
];

// Human-readable lane names for mismatch messages.
const LANE_LABEL_MAP: Record<string, string> = {
  romantasy:            'romantic fantasy',
  scifi_fantasy:        'fantasy / sci-fi',
  modern_suspense:      'thrillers and suspense',
  romance:              'romance',
  contemporary_fiction: 'contemporary fiction',
  memoir_nonfiction:    'memoir and nonfiction',
  literary:             'literary fiction',
  horror:               'dark / horror fiction',
};

function laneDisplayLabel(lane: string): string {
  return LANE_LABEL_MAP[lane] ?? lane.replace(/_/g, ' ');
}

// Juvenile subject signals — kept in sync with recommender.ts.
const JUVENILE_SUBJECT_SIGS = [
  'juvenile', "children's", 'picture book', 'juvenile fiction',
  'juvenile literature', "children's fiction", "children's literature",
  'board book', 'easy reader',
];

type CenterOfGravity = ReturnType<typeof computeCenterOfGravity>;

function detectAudienceMismatch(
  book:    ResolvedBook,
  profile: TasteProfile,
): string | null {
  const text = [
    ...book.subjects,
    ...book.categories,
    book.description ?? '',
  ].join(' ').toLowerCase();

  const isJuvenile = JUVENILE_SUBJECT_SIGS.some(sig => text.includes(sig));
  if (isJuvenile && profile.tier >= 1) {
    return "This is a children's book, while you mostly read adult fiction";
  }
  return null;
}

// buildScanReasons — polarity-aware reason + caution generation.
//
// Positive verdicts  → reinforcing reasons drawn from scorer matches.
// Mixed verdicts     → one positive then one cautionary signal (tradeoff).
// Negative verdicts  → mismatch-first: risks → fit_explanation → lane gap → audience gap.
//                      Positive scorer reasons are suppressed (they caused the confusion).
//
function buildScanReasons(
  verdict:        ScanVerdict,
  finalScore:     number,
  fitClass:       string,
  fitExplanation: string,
  scoredReasons:  string[],
  scoredRisks:    string[],
  book:           ResolvedBook,
  profile:        TasteProfile,
  bookLane:       string | null,
  cog:            CenterOfGravity,
): { reasons: string[]; caution: string | null } {

  // ── Negative verdict: mismatch-first reasoning ─────────────────────────────
  if (verdict === 'not_for_you' || finalScore < 0.40) {
    const reasons: string[] = [];

    // 1. Hard classifier explanation is already a concrete mismatch sentence.
    if (fitClass === 'reject' || fitClass === 'stretch_fit') {
      reasons.push(capitalize(fitExplanation));
    }

    // 2. Scorer risks: avoided traits, genre affinity penalties.
    for (const risk of scoredRisks) {
      if (reasons.length >= 2) break;
      const cap = capitalize(risk);
      if (!reasons.some(r => r.toLowerCase().includes(cap.toLowerCase().slice(0, 20)))) {
        reasons.push(cap);
      }
    }

    // 3. Audience mismatch (children's book for adult reader).
    const audience = detectAudienceMismatch(book, profile);
    if (audience && reasons.length < 2) reasons.push(audience);

    // 4. Lane mismatch derivation when no other signals fire.
    if (reasons.length === 0 && cog.dominant_lanes.length > 0) {
      const bookLabel = bookLane ? laneDisplayLabel(bookLane) : 'this genre';
      const userLabel = cog.dominant_lanes.slice(0, 2).map(laneDisplayLabel).join(' and ');
      reasons.push(`You rarely read ${bookLabel} — your library leans toward ${userLabel}`);
    }

    // 5. Absolute last resort.
    if (reasons.length === 0) {
      reasons.push("The genre doesn't match what you typically enjoy");
    }

    // Caution: surface one weak positive signal only for adjacent_fit books
    // so the user understands why a score > 0 was possible.
    let caution: string | null = null;
    if (scoredReasons.length > 0 && fitClass === 'adjacent_fit') {
      caution = capitalize(scoredReasons[0]);
    }

    return { reasons: reasons.slice(0, 2), caution };
  }

  // ── Mixed verdict: tradeoff framing ───────────────────────────────────────
  if (verdict === 'mixed_fit') {
    const reasons: string[] = [];

    // Lead with one positive scorer reason (no filler).
    for (const r of scoredReasons) {
      if (reasons.length >= 1) break;
      const cap = capitalize(r);
      if (!FILLER_PHRASES.some(f => cap.toLowerCase().includes(f))) {
        reasons.push(cap);
      }
    }
    // Fall back to fit_explanation for the positive lead.
    if (reasons.length === 0 && (fitClass === 'adjacent_fit' || fitClass === 'core_fit')) {
      const exp = capitalize(fitExplanation);
      if (!FILLER_PHRASES.some(f => exp.toLowerCase().includes(f))) {
        reasons.push(exp);
      }
    }

    // Then the risk / cautionary signal.
    if (scoredRisks.length > 0) {
      reasons.push(capitalize(scoredRisks[0]));
    } else if (fitClass === 'stretch_fit') {
      const exp = capitalize(fitExplanation);
      if (!reasons.some(r => r.toLowerCase().includes(exp.toLowerCase().slice(0, 20)))) {
        reasons.push(exp);
      }
    }

    // Fill one more positive if room remains.
    for (const r of scoredReasons.slice(1)) {
      if (reasons.length >= 3) break;
      const cap = capitalize(r);
      if (!FILLER_PHRASES.some(f => cap.toLowerCase().includes(f))
          && !reasons.some(x => x.toLowerCase().includes(cap.toLowerCase().slice(0, 20)))) {
        reasons.push(cap);
      }
    }

    const caution = scoredRisks.length > 1 ? capitalize(scoredRisks[1]) : null;
    return { reasons: reasons.slice(0, 3), caution };
  }

  // ── Positive verdict: reinforcing reasons ──────────────────────────────────
  const reasons: string[] = [];
  for (const r of scoredReasons.slice(0, 2)) {
    const cap = capitalize(r);
    if (!FILLER_PHRASES.some(f => cap.toLowerCase().includes(f))) {
      reasons.push(cap);
    }
  }
  // Supplement with fit_explanation if room and it's concrete.
  if (reasons.length < 2 && (fitClass === 'core_fit' || fitClass === 'adjacent_fit')) {
    const exp = capitalize(fitExplanation);
    if (!FILLER_PHRASES.some(f => exp.toLowerCase().includes(f))
        && !reasons.some(r => r.toLowerCase().includes(exp.toLowerCase().slice(0, 20)))) {
      reasons.push(exp);
    }
  }
  // Third slot.
  for (const r of scoredReasons.slice(2)) {
    if (reasons.length >= 3) break;
    const cap = capitalize(r);
    if (!FILLER_PHRASES.some(f => cap.toLowerCase().includes(f))
        && !reasons.some(x => x.toLowerCase().includes(cap.toLowerCase().slice(0, 20)))) {
      reasons.push(cap);
    }
  }
  if (reasons.length === 0) {
    reasons.push(metadataObservation(book));
  }

  const caution = scoredRisks.length > 0 ? capitalize(scoredRisks[0]) : null;
  return { reasons: reasons.slice(0, 3), caution };
}

function deriveVerdict(fitClass: string, finalScore: number): ScanVerdict {
  if (fitClass === 'reject')      return 'not_for_you';
  if (fitClass === 'stretch_fit') {
    return finalScore >= 0.35 ? 'mixed_fit' : 'not_for_you';
  }
  if (finalScore >= 0.62) return 'strong_fit';
  if (finalScore >= 0.42) return 'likely_fit';
  if (finalScore >= 0.25) return 'mixed_fit';
  return 'not_for_you';
}

function deriveConfidence(
  tier:       number,
  fitClass:   string,
  metaQuality: MetaQuality,
): 'high' | 'medium' | 'low' {
  if (tier <= 1) return 'low';
  if (metaQuality === 'minimal') return 'low';
  if (fitClass === 'core_fit' && tier >= 2) return 'high';
  return 'medium';
}

function metadataObservation(book: ResolvedBook): string {
  if (book.subjects.some(s => s.includes('fantasy') || s.includes('science fiction'))) {
    return `A speculative fiction title — add more books to your library to see how it fits your taste`;
  }
  if (book.subjects.some(s => s.includes('thriller') || s.includes('mystery'))) {
    return `A suspense/mystery title — add more books to your library for a personalised verdict`;
  }
  return `Add more books to your library to get a personalised fit verdict`;
}

export function evaluateScanFit(
  resolvedBook: ResolvedBook,
  profile:      TasteProfile,
  feedback:     FeedbackContext,
): ScanFitResult {
  const candidateBook: CandidateBook = {
    id:                `scan:${resolvedBook.isbn || resolvedBook.title}`,
    title:             resolvedBook.title,
    author:            resolvedBook.author,
    cover_url:         resolvedBook.cover_url,
    external_id:       resolvedBook.externalId,
    subjects:          resolvedBook.subjects.length > 0 ? resolvedBook.subjects : null,
    page_count:        resolvedBook.page_count,
    description:       resolvedBook.description,
    _source:           'open_library',
    _retrieval_reason: 'isbn_scan',
  };

  // Build a lightweight enrichment profile using the consensus trait inference
  // (synchronous keyword pass — no extra API call).
  const consensusTraits = inferConsensusTraits(
    resolvedBook.subjects,
    resolvedBook.categories,
    resolvedBook.description ?? '',
  );
  const enrichment: BookEnrichmentProfile = {
    external_id:        resolvedBook.externalId ?? resolvedBook.isbn,
    consensus_traits:   consensusTraits,
    repeated_praise:    [],
    repeated_risks:     [],
    comparable_titles:  [],
    audience_signals:   [],
    popularity_signals: {},
    source_summary:     { google_books: true },
  };

  // ── Scoring (same function used by the recommendation engine) ─────────────
  const scored = scoreBookForUser(candidateBook, profile, feedback, enrichment);

  // ── Center-of-gravity fit classification ──────────────────────────────────
  const cog         = computeCenterOfGravity(profile);
  const bookLane    = detectBookLane(candidateBook);
  const marketPos   = classifyMarketPosition({
    subjects:          candidateBook.subjects,
    title:             candidateBook.title,
    author:            candidateBook.author,
    first_publish_year: resolvedBook.publishYear,
  });
  const fitResult   = computeFitClass(candidateBook, bookLane, marketPos, cog);

  // Apply CoG delta (same adjustment getRankedRecs applies to ranked books).
  // For 'reject' books we keep the base score but cap it at 0.20 to reflect
  // the hard classification without setting it to -9999.
  const isReject    = fitResult.fit_class === 'reject';
  const cogDelta    = isReject ? 0 : fitResult.cog_score_delta;
  const adjusted    = Math.max(0, Math.min(1, scored.score + cogDelta));
  const finalScore  = isReject ? Math.min(adjusted, 0.20) : adjusted;

  // ── Verdict + confidence ──────────────────────────────────────────────────
  const verdict     = deriveVerdict(fitResult.fit_class, finalScore);
  const confidence  = deriveConfidence(profile.tier, fitResult.fit_class, resolvedBook.metaQuality);

  // ── Reasons + caution (polarity-aware) ────────────────────────────────────
  // For negative verdicts mismatch signals are surfaced first; positive scorer
  // reasons are gated to positive/mixed verdicts only (they were the source of
  // the "5/100 paired with 'Matches your appreciation for characters'" bug).
  const { reasons, caution } = buildScanReasons(
    verdict,
    finalScore,
    fitResult.fit_class,
    fitResult.fit_explanation,
    scored.reasons,
    scored.risks,
    resolvedBook,
    profile,
    bookLane,
    cog,
  );

  return {
    book:          resolvedBook,
    score:         finalScore,
    score_display: Math.round(finalScore * 100),
    verdict,
    verdict_label: VERDICT_LABELS[verdict],
    confidence,
    reasons,
    caution,
    guidance:      VERDICT_GUIDANCE[verdict],
    low_signal:    profile.tier <= 1,
    fit_class:     fitResult.fit_class,
    external_id:   resolvedBook.externalId,
  };
}
