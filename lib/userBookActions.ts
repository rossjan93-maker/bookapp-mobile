/**
 * Canonical user-book action utilities.
 *
 * Single source of truth for status transitions and page-progress saves so
 * that Library, Book Detail, and any future caller share identical DB logic.
 *
 * Each function is pure async — it owns only DB side-effects and returns a
 * result.  Callers own their own React state updates and post-finish flows.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

export type TransitionResult = {
  startedAt:         string | null;
  finishedAt:        string | null;
  completionEventId: string | null;
};

/**
 * Full canonical status transition for a user_books row.
 *
 * Handles:
 *  - user_books status / started_at / finished_at update
 *  - recommendations table status + resolved_at sync
 *  - credibility_events insert on recommendation finish
 *  - activity_events for recommendation_started / recommendation_finished /
 *    book_finished
 *
 * Callers are responsible for:
 *  - local React state updates (items, currentStatus, etc.)
 *  - post-finish rating / taste-tag flows
 */
export async function transitionStatus(
  supabase: SupabaseClient,
  params: {
    userBookId:         string;
    bookId:             string;
    userId:             string;
    newStatus:          UserBookStatus;
    existingFinishedAt?: string | null;
  },
): Promise<{ data: TransitionResult | null; error: string | null }> {
  const { userBookId, bookId, userId, newStatus, existingFinishedAt } = params;
  const now = new Date().toISOString();

  const userBookUpdate: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'reading') userBookUpdate.started_at = now;
  if (newStatus === 'finished' || newStatus === 'dnf') {
    // Preserve an existing finish date (e.g. from a Goodreads import) rather
    // than overwriting it with today's date.  Only assign now() when there is
    // no prior date recorded.
    userBookUpdate.finished_at = existingFinishedAt ?? now;
  }

  const { error: updateError } = await supabase
    .from('user_books')
    .update(userBookUpdate)
    .eq('id', userBookId);

  if (updateError) {
    return { data: null, error: 'Could not update status. Please try again.' };
  }

  let completionEventId: string | null = null;

  const { data: rec } = await supabase
    .from('recommendations')
    .select('id, from_user_id, to_user_id, book_id')
    .eq('user_book_id', userBookId)
    .maybeSingle();

  if (rec) {
    const recStatusMap: Record<UserBookStatus, string> = {
      want_to_read: 'saved',
      reading:      'started',
      finished:     'finished',
      dnf:          'dnf',
    };
    const recUpdate: Record<string, unknown> = { status: recStatusMap[newStatus] };
    if (newStatus === 'finished' || newStatus === 'dnf') recUpdate.resolved_at = now;

    const { error: recUpdateError } = await supabase
      .from('recommendations')
      .update(recUpdate)
      .eq('id', rec.id);

    if (!recUpdateError && newStatus === 'finished') {
      const { data: existingEvent } = await supabase
        .from('credibility_events')
        .select('id')
        .eq('recommendation_id', rec.id)
        .maybeSingle();
      if (!existingEvent) {
        await supabase.from('credibility_events').insert({
          recommendation_id: rec.id,
          from_user_id:      rec.from_user_id,
          to_user_id:        rec.to_user_id,
          book_id:           rec.book_id,
        });
      }
    }

    if (!recUpdateError) {
      if (newStatus === 'reading') {
        await supabase.from('activity_events').insert({
          actor_id:          userId,
          event_type:        'recommendation_started',
          book_id:           rec.book_id,
          recommendation_id: rec.id,
        });
      } else if (newStatus === 'finished') {
        const { data: evtData } = await supabase
          .from('activity_events')
          .insert({
            actor_id:          userId,
            event_type:        'recommendation_finished',
            book_id:           rec.book_id,
            recommendation_id: rec.id,
          })
          .select('id')
          .single();
        completionEventId = evtData?.id ?? null;
      }
    }
  } else if (newStatus === 'finished') {
    const { data: evtData } = await supabase
      .from('activity_events')
      .insert({ actor_id: userId, event_type: 'book_finished', book_id: bookId })
      .select('id')
      .single();
    completionEventId = evtData?.id ?? null;
  }

  const writtenFinishedAt =
    (newStatus === 'finished' || newStatus === 'dnf')
      ? (existingFinishedAt ?? now)
      : null;

  return {
    data: {
      startedAt:         newStatus === 'reading' ? now : null,
      finishedAt:        writtenFinishedAt,
      completionEventId,
    },
    error: null,
  };
}

/**
 * Save an updated current_page to user_books and append a
 * reading_progress_events history row (fire-and-forget insert).
 */
export async function saveCurrentPage(
  supabase: SupabaseClient,
  params: {
    userBookId:  string;
    bookId:      string;
    userId:      string;
    newPage:     number;
    currentPage: number | null;
  },
): Promise<{ error: string | null }> {
  const { userBookId, bookId, userId, newPage, currentPage } = params;

  const { error } = await supabase
    .from('user_books')
    .update({ current_page: newPage, progress_updated_at: new Date().toISOString() })
    .eq('id', userBookId);

  if (error) return { error: 'Could not save — try again.' };

  if (newPage !== currentPage) {
    supabase
      .from('reading_progress_events')
      .insert({ user_book_id: userBookId, book_id: bookId, user_id: userId, page: newPage })
      .then(() => {});
  }

  return { error: null };
}
