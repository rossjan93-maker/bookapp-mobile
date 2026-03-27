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
  mixed_fit:   "It's a mixed picture.",
  not_for_you: 'Probably not, based on what you read.',
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

  // ── Reasons ───────────────────────────────────────────────────────────────
  // Start from scorer reasons (trait + genre signals); supplement with CoG
  // fit explanation when there is headroom.
  const reasons: string[] = [];
  for (const r of scored.reasons.slice(0, 2)) {
    reasons.push(capitalize(r));
  }
  if (reasons.length < 2) {
    if (fitResult.fit_class === 'core_fit' || fitResult.fit_class === 'adjacent_fit') {
      const exp = fitResult.fit_explanation;
      if (exp && !reasons.some(r => r.toLowerCase().includes(exp.toLowerCase().slice(0, 20)))) {
        reasons.push(exp.charAt(0).toUpperCase() + exp.slice(1));
      }
    }
  }
  for (const r of scored.reasons.slice(2)) {
    if (reasons.length >= 3) break;
    reasons.push(capitalize(r));
  }
  // Low-signal fallback: don't leave the user with zero reasons
  if (reasons.length === 0) {
    reasons.push(metadataObservation(resolvedBook));
  }

  // ── Caution ───────────────────────────────────────────────────────────────
  let caution: string | null = null;
  if (scored.risks.length > 0) {
    caution = capitalize(scored.risks[0]);
  } else if (fitResult.fit_class === 'stretch_fit' || isReject) {
    caution = fitResult.fit_explanation.charAt(0).toUpperCase() + fitResult.fit_explanation.slice(1);
  }

  return {
    book:          resolvedBook,
    score:         finalScore,
    score_display: Math.round(finalScore * 100),
    verdict,
    verdict_label: VERDICT_LABELS[verdict],
    confidence,
    reasons,
    caution,
    low_signal:    profile.tier <= 1,
    fit_class:     fitResult.fit_class,
    external_id:   resolvedBook.externalId,
  };
}
