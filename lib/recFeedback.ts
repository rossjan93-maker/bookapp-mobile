// =============================================================================
// recFeedback — recommendation feedback persistence and scoring context
//
// Feedback types:
//   'impression'         — book was rendered in the recommendation list
//   'saved'              — user tapped "Save for later"
//   'dismissed'          — user tapped "Not for me"
//   'more_like_this'     — user tapped "More like this"
//   'explanation_opened' — user expanded the "Why this?" detail panel
//
// Feedback drives future ranking via FeedbackContext:
//   dismissedIds    → books excluded from the candidate pool entirely
//   genreBoosts     → additive score bonus for genres the user upvoted
//                     first signal: +0.12, each extra: +0.06, cap: +0.20
//
// All DB calls fail silently (best-effort) — feedback must never block the UI.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { getBookTraits }        from './bookTraits';
import type { CandidateBook, ScoredBook } from './recommender';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeedbackType =
  | 'saved'
  | 'dismissed'
  | 'more_like_this'
  | 'impression'
  | 'explanation_opened';

export type FeedbackContext = {
  dismissedIds: Set<string>;        // external_ids + book_db_ids to exclude
  genreBoosts:  Record<string, number>; // genre → cumulative boost (0.12–0.20)
};

// ── Persist a single feedback event ──────────────────────────────────────────

export async function persistFeedback(
  client:       SupabaseClient,
  userId:       string,
  book:         CandidateBook | ScoredBook,
  feedbackType: FeedbackType,
  extras?: {
    book_db_id?: string;  // DB UUID — provided by caller when known (e.g. after save)
  },
): Promise<void> {
  try {
    const bt = getBookTraits(book);
    await client.from('rec_feedback').insert({
      user_id:          userId,
      external_id:      book.external_id ?? null,
      book_db_id:       book._source === 'catalog' ? book.id : (extras?.book_db_id ?? null),
      feedback_type:    feedbackType,
      score_snapshot:   'score'   in book ? book.score   : null,
      source_snapshot:  book._source,
      book_genre:       bt.primaryGenre ?? null,
      reasons_snapshot: 'reasons' in book ? book.reasons : null,
    });
  } catch {
    // Best-effort — never surface to user
  }
}

// ── Load the feedback context used by the recommender ─────────────────────────
// Returns dismissed book IDs (for candidate exclusion) and genre boosts
// (for score augmentation on similar books).
// Returns an empty context if the table doesn't exist or the query fails.

export async function loadFeedbackContext(
  client: SupabaseClient,
  userId: string,
): Promise<FeedbackContext> {
  try {
    const { data, error } = await client
      .from('rec_feedback')
      .select('external_id, book_db_id, feedback_type, book_genre')
      .eq('user_id', userId)
      .in('feedback_type', ['dismissed', 'more_like_this']);

    if (error) return emptyContext();

    type Row = {
      external_id:   string | null;
      book_db_id:    string | null;
      feedback_type: string;
      book_genre:    string | null;
    };

    const rows          = (data ?? []) as Row[];
    const dismissedIds  = new Set<string>();
    const genreCounts:   Record<string, number> = {};

    for (const row of rows) {
      if (row.feedback_type === 'dismissed') {
        if (row.external_id) dismissedIds.add(row.external_id);
        if (row.book_db_id)  dismissedIds.add(row.book_db_id);
      } else if (row.feedback_type === 'more_like_this' && row.book_genre) {
        genreCounts[row.book_genre] = (genreCounts[row.book_genre] ?? 0) + 1;
      }
    }

    // Boost magnitude: first signal = +0.12, each extra = +0.06, cap = +0.20
    const genreBoosts: Record<string, number> = {};
    for (const [genre, count] of Object.entries(genreCounts)) {
      genreBoosts[genre] = +(Math.min(0.20, 0.12 + (count - 1) * 0.06)).toFixed(2);
    }

    return { dismissedIds, genreBoosts };
  } catch {
    return emptyContext();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function emptyContext(): FeedbackContext {
  return { dismissedIds: new Set(), genreBoosts: {} };
}
