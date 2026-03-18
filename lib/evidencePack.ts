// =============================================================================
// evidencePack.ts — structured evidence for the expert recommendation layer
//
// The evidence pack consolidates everything the expert reasoning layer needs to
// build a reader thesis and judge candidates:
//   • taste profile (traits, genres, affinities)
//   • loved / disliked books with full metadata
//   • repeated authors (signals intentional loyalty vs. accident)
//   • liked subjects (what subjects appear across loved books)
//   • diagnosis answers (explicit stated preferences)
//   • recommendation feedback history
//   • candidate books with enrichment + deterministic scores
//   • already-read book external IDs (to avoid repeats)
// =============================================================================

import type { SupabaseClient }        from '@supabase/supabase-js';
import type { TasteProfile }          from './tasteProfile';
import type { CandidateBook }         from './recommender';
import type { BookEnrichmentProfile } from './bookEnrichment';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BookEvidence = {
  title:       string;
  author:      string;
  genre:       string | null;
  subjects:    string[];
  rating:      number | null;
  review_body: string | null;
  taste_tags:  { liked?: string[]; didnt_work?: string[] };
  source:      string | null;
};

export type CandidateEvidence = {
  id:                  string;
  external_id:         string | null;
  title:               string;
  author:              string;
  subjects:            string[];
  page_count:          number | null;
  det_score:           number;         // deterministic score
  retrieval_reason:    string;
  source:              string;
  enrichment:          BookEnrichmentProfile | null;
};

export type EvidencePack = {
  /** User ID this pack was built for. */
  user_id: string;

  /** Full taste profile (traits, genres, tier, etc.). */
  profile: TasteProfile;

  /** Loved books: finished with rating ≥ 4. */
  loved_books: BookEvidence[];

  /** Disliked books: finished with rating ≤ 2. */
  disliked_books: BookEvidence[];

  /** Authors that appear in 2+ loved books (intentional reading, not accident). */
  repeated_authors: string[];

  /**
   * Subjects appearing across loved books (already noise-filtered via tasteProfile).
   * Same as profile.liked_subjects but kept here for convenience.
   */
  liked_subjects: string[];

  /** Explicit diagnosis answers (from reader_preferences.diagnosis_answers). */
  diagnosis_answers: Record<string, string> | null;

  /** Candidate books with deterministic scores and enrichment data. */
  candidates: CandidateEvidence[];

  /** External IDs of books the user has already read (exclude from recs). */
  already_read_ids: Set<string>;

  /** Signal count snapshot (for cache invalidation). */
  signal_count:   number;
  feedback_count: number;
  import_complete: boolean;
};

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Fetch supplementary evidence and assemble the full evidence pack.
 * Called by the expert layer orchestrator in recommender.ts.
 */
export async function buildEvidencePack(
  client:       SupabaseClient,
  userId:       string,
  profile:      TasteProfile,
  candidates:   CandidateBook[],
  enrichmentMap: Map<string, BookEnrichmentProfile>,
  detScores:    Map<string, number>,  // externalId/id → deterministic score
): Promise<EvidencePack> {
  // ── Fetch finished books with rating + taste data ─────────────────────────
  const { data: finishedRaw } = await client
    .from('user_books')
    .select(`
      rating, review_body, taste_tags, status, source,
      book:books(title, author, external_id, subjects)
    `)
    .eq('user_id', userId)
    .eq('status', 'finished')
    .not('rating', 'is', null);

  type FinishedRow = {
    rating:      number | null;
    review_body: string | null;
    taste_tags:  { liked?: string[]; didnt_work?: string[] } | null;
    source:      string | null;
    book:        { title: string; author: string; external_id: string | null; subjects: string[] | null } | null;
  };

  const finished: FinishedRow[] = (finishedRaw ?? []) as unknown as FinishedRow[];

  // ── Fetch already-read external IDs (for exclusion) ───────────────────────
  const { data: readRaw } = await client
    .from('user_books')
    .select('book:books(external_id)')
    .eq('user_id', userId);

  type ReadRow = { book: { external_id: string | null } | null };
  const already_read_ids = new Set<string>(
    ((readRaw ?? []) as unknown as ReadRow[])
      .map(r => r.book?.external_id)
      .filter((id): id is string => !!id)
  );

  // ── Fetch diagnosis answers ───────────────────────────────────────────────
  const { data: prefRow } = await client
    .from('reader_preferences')
    .select('diagnosis_answers')
    .eq('user_id', userId)
    .maybeSingle();

  const diagnosis_answers = (prefRow?.diagnosis_answers as Record<string, string> | null) ?? null;

  // ── Fetch rec feedback count (for cache invalidation signals) ─────────────
  const { count: feedbackCount } = await client
    .from('rec_feedback')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  // ── Build loved / disliked book lists ─────────────────────────────────────
  const loved_books:    BookEvidence[] = [];
  const disliked_books: BookEvidence[] = [];
  const authorFreq:     Record<string, number> = {};

  for (const row of finished) {
    if (!row.book) continue;
    const rating = row.rating ?? 0;
    const ev: BookEvidence = {
      title:       row.book.title,
      author:      row.book.author,
      genre:       detectGenreFromSubjects(row.book.subjects ?? []),
      subjects:    row.book.subjects ?? [],
      rating,
      review_body: row.review_body,
      taste_tags:  row.taste_tags ?? {},
      source:      row.source,
    };
    if (rating >= 4) {
      loved_books.push(ev);
      const key = row.book.author?.toLowerCase().trim() ?? '';
      if (key) authorFreq[key] = (authorFreq[key] ?? 0) + 1;
    } else if (rating <= 2) {
      disliked_books.push(ev);
    }
  }

  const repeated_authors = Object.entries(authorFreq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([author]) => author);

  // ── Wrap candidates with enrichment + deterministic score ─────────────────
  const candidatesEvidence: CandidateEvidence[] = candidates.map(c => {
    const enrichKey = c.external_id ?? c.id;
    return {
      id:               c.id,
      external_id:      c.external_id,
      title:            c.title,
      author:           c.author,
      subjects:         c.subjects ?? [],
      page_count:       c.page_count,
      det_score:        detScores.get(enrichKey) ?? detScores.get(c.id) ?? 0,
      retrieval_reason: c._retrieval_reason,
      source:           c._source,
      enrichment:       enrichmentMap.get(enrichKey) ?? null,
    };
  });

  return {
    user_id:           userId,
    profile,
    loved_books,
    disliked_books,
    repeated_authors,
    liked_subjects:    profile.liked_subjects ?? [],
    diagnosis_answers,
    candidates:        candidatesEvidence,
    already_read_ids,
    signal_count:      profile.strongSignalCount ?? 0,
    feedback_count:    feedbackCount ?? 0,
    import_complete:   (profile.evidence.imported_books_count ?? 0) > 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lightweight genre detection from subjects (mirrors bookTraits.ts logic). */
function detectGenreFromSubjects(subjects: string[]): string | null {
  const corpus = subjects.join(' ').toLowerCase();
  if (/memoir|autobiography|biography|biographical/.test(corpus))             return 'memoir_bio';
  if (/nonfiction|non-fiction|self-help|psychology|science|philosophy/.test(corpus)) return 'nonfiction';
  if (/horror|gothic|ghost|supernatural|occult/.test(corpus))                 return 'horror';
  if (/romance|romantic fiction|love story/.test(corpus))                     return 'romance';
  if (/thriller|mystery|crime fiction|detective|suspense|noir/.test(corpus))  return 'thriller_mystery';
  if (/fantasy|science fiction|sci-fi|dystopian|speculative|space opera/.test(corpus)) return 'fantasy_scifi';
  if (/literary fiction|contemporary fiction/.test(corpus))                   return 'literary';
  return null;
}
