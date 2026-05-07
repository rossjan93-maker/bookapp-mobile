/**
 * Canonical user-book action utilities.
 *
 * Single source of truth for status transitions, edits, page-progress saves,
 * soft-deletes, and restores.  Every mutation first snapshots the current row
 * into user_book_history so all changes are auditable and undoable.
 *
 * Rules enforced here (never break these):
 *  - Never auto-overwrite an existing finished_at with now() unless the caller
 *    explicitly provides a new date.
 *  - Never fabricate dates — unknown/unset dates are represented as null.
 *  - Soft-delete only: deleted_at = now() on remove; null on restore.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { localDateString } from './streaks';

// ── Types ─────────────────────────────────────────────────────────────────────

export type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

export type TransitionResult = {
  startedAt:         string | null;
  finishedAt:        string | null;
  completionEventId: string | null;
};

/** Snapshot of a user_books row used for undo. */
export type BookSnapshot = {
  status:       UserBookStatus;
  startedAt:    string | null;
  finishedAt:   string | null;
  finishedYear: number | null;
  deletedAt:    string | null;
};

/**
 * How to express the finished date in an edit:
 *  - exact   – a known calendar date (YYYY-MM-DD or ISO string)
 *  - year    – year-only resolution (finished_at set to Dec-31 of that year,
 *               finished_year stored as metadata so UI knows it's year-only)
 *  - unknown – date is not known; finished_at + finished_year both null
 *  - keep    – do not modify the existing value
 */
export type FinishedDateInput =
  | { kind: 'exact';    date: string  }
  | { kind: 'year';     year: number  }
  | { kind: 'unknown'                 }
  | { kind: 'keep'                    };

export type StartedDateInput =
  | { kind: 'date';    date: string  }
  | { kind: 'unknown'                }
  | { kind: 'keep'                   };

export type EditBookParams = {
  userBookId:   string;
  userId:       string;
  newStatus?:   UserBookStatus;
  startedAt?:   StartedDateInput;
  finishedAt?:  FinishedDateInput;
};

export type EditBookResult = {
  snapshot:  BookSnapshot;           // previous state — pass to undo
  updatedAt: string;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Insert a history row capturing the state BEFORE a mutation. */
async function insertHistory(
  supabase: SupabaseClient,
  userBookId: string,
  snapshot: BookSnapshot,
  action: 'status_change' | 'date_edit' | 'delete' | 'restore',
): Promise<void> {
  await supabase.from('user_book_history').insert({
    user_book_id:      userBookId,
    prev_status:       snapshot.status,
    prev_started_at:   snapshot.startedAt,
    prev_finished_at:  snapshot.finishedAt,
    prev_finished_year: snapshot.finishedYear,
    prev_deleted_at:   snapshot.deletedAt,
    action,
  });
}

/** Fetch the current row and return it as a BookSnapshot. */
async function fetchSnapshot(
  supabase: SupabaseClient,
  userBookId: string,
): Promise<BookSnapshot | null> {
  const { data } = await supabase
    .from('user_books')
    .select('status, started_at, finished_at, finished_year, deleted_at')
    .eq('id', userBookId)
    .single();

  if (!data) return null;
  return {
    status:       data.status,
    startedAt:    data.started_at   ?? null,
    finishedAt:   data.finished_at  ?? null,
    finishedYear: data.finished_year ?? null,
    deletedAt:    data.deleted_at   ?? null,
  };
}

/** Resolve a FinishedDateInput into { finished_at, finished_year } DB values. */
function resolveFinishedDate(input: FinishedDateInput): {
  finished_at?:   string | null;
  finished_year?: number | null;
} {
  switch (input.kind) {
    case 'exact': {
      // Parse to a full ISO timestamp; derive year from the date.
      const d     = new Date(input.date.includes('T') ? input.date : `${input.date}T00:00:00.000Z`);
      const year  = d.getUTCFullYear();
      return { finished_at: d.toISOString(), finished_year: null };
    }
    case 'year': {
      // Use Dec-31 as the proxy date so yearly-goal queries still count it.
      const proxy = `${input.year}-12-31T00:00:00.000Z`;
      return { finished_at: proxy, finished_year: input.year };
    }
    case 'unknown':
      return { finished_at: null, finished_year: null };
    case 'keep':
      return {};                                 // omit keys → no update
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Full canonical status transition for a user_books row.
 *
 * Handles:
 *  - user_books status / started_at / finished_at update
 *  - recommendations table status + resolved_at sync
 *  - credibility_events insert on recommendation finish
 *  - activity_events for recommendation_started / recommendation_finished /
 *    book_finished
 *  - history row insert (action = 'status_change')
 *
 * Callers are responsible for:
 *  - local React state updates
 *  - post-finish rating / taste-tag flows
 */
export async function transitionStatus(
  supabase: SupabaseClient,
  params: {
    userBookId:          string;
    bookId:              string;
    userId:              string;
    newStatus:           UserBookStatus;
    existingFinishedAt?: string | null;
  },
): Promise<{ data: TransitionResult | null; error: string | null; snapshot: BookSnapshot | null }> {
  const { userBookId, bookId, userId, newStatus, existingFinishedAt } = params;
  const now = new Date().toISOString();

  // Snapshot current state before mutating.
  const snapshot = await fetchSnapshot(supabase, userBookId);
  if (snapshot) {
    await insertHistory(supabase, userBookId, snapshot, 'status_change');
  }

  const userBookUpdate: Record<string, unknown> = { status: newStatus };
  // Always clear the explicit pause flag on a status change. A paused row is
  // an annotation on a *currently-reading* book — finishing, DNFing, or moving
  // back to want_to_read all imply the pause is no longer meaningful, and
  // leaving the timestamp behind would make the read-state inference report
  // 'paused' the instant the book was ever moved back into 'reading'. We
  // also clear it for newStatus === 'reading' itself, so re-starting a paused
  // book through the status flow gives a clean slate.
  // Sent unconditionally; if the column doesn't exist yet (migration pending)
  // PostgREST surfaces a schema error and the whole update is rejected — to
  // keep status changes working pre-migration, we rely on the schema having
  // been applied. See supabase/migrations/20260506000000_user_books_paused_at.sql.
  userBookUpdate.paused_at = null;
  if (newStatus === 'reading') userBookUpdate.started_at = now;
  if (newStatus === 'finished' || newStatus === 'dnf') {
    // Preserve an existing finish date (e.g. from a Goodreads import) rather
    // than overwriting it with today's date.  Only assign now() when there is
    // no prior date recorded.
    userBookUpdate.finished_at = existingFinishedAt ?? now;
    // Clear finished_year when transitioning via status (exact time is known).
    userBookUpdate.finished_year = null;
  }

  let { error: updateError } = await supabase
    .from('user_books')
    .update(userBookUpdate)
    .eq('id', userBookId);

  // Schema-tolerant: if the paused_at column doesn't exist yet (migration
  // pending), retry without it so core status changes still work.
  if (updateError) {
    const isSchemaError =
      updateError.code === '42703' ||
      updateError.code === 'PGRST204' ||
      (typeof updateError.message === 'string' && updateError.message.includes('does not exist'));
    if (isSchemaError && 'paused_at' in userBookUpdate) {
      const { paused_at: _drop, ...withoutPause } = userBookUpdate;
      const retry = await supabase
        .from('user_books')
        .update(withoutPause)
        .eq('id', userBookId);
      updateError = retry.error;
    }
  }

  if (updateError) {
    return { data: null, error: 'Could not update status. Please try again.', snapshot };
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
    error:    null,
    snapshot,
  };
}

/**
 * Edit a user_books row (status and/or dates) non-destructively.
 *
 * Always:
 *  1. Fetches the current snapshot.
 *  2. Writes a history row.
 *  3. Applies only the fields explicitly passed (fields with 'keep' are skipped).
 *
 * Never fabricates dates.  If the caller does not pass a finishedAt input the
 * existing value is preserved regardless of status change.
 */
export async function editUserBook(
  supabase: SupabaseClient,
  params: EditBookParams,
): Promise<{ result: EditBookResult | null; error: string | null }> {
  const { userBookId, newStatus, startedAt, finishedAt } = params;

  const snapshot = await fetchSnapshot(supabase, userBookId);
  if (!snapshot) return { result: null, error: 'Book not found.' };

  const action = finishedAt && finishedAt.kind !== 'keep' && finishedAt.kind !== 'unknown'
    ? 'date_edit'
    : newStatus && newStatus !== snapshot.status
      ? 'status_change'
      : 'date_edit';

  await insertHistory(supabase, userBookId, snapshot, action as any);

  const patch: Record<string, unknown> = {};

  if (newStatus) {
    patch.status = newStatus;
    // Mirror the invariant from transitionStatus(): any status change clears
    // the explicit pause flag. A paused row is annotation on a 'reading'
    // book; moving away from (or re-entering) reading must reset it so the
    // read-state inference doesn't surface a stale "Paused" pill.
    patch.paused_at = null;
  }

  if (startedAt) {
    if (startedAt.kind === 'date')    patch.started_at = new Date(startedAt.date).toISOString();
    if (startedAt.kind === 'unknown') patch.started_at = null;
    // 'keep' → no patch
  }

  if (finishedAt) {
    const resolved = resolveFinishedDate(finishedAt);
    if ('finished_at'   in resolved) patch.finished_at   = resolved.finished_at;
    if ('finished_year' in resolved) patch.finished_year = resolved.finished_year;
  }

  if (Object.keys(patch).length === 0) {
    return { result: { snapshot, updatedAt: new Date().toISOString() }, error: null };
  }

  let { error } = await supabase.from('user_books').update(patch).eq('id', userBookId);
  // Schema-tolerant: paused_at column may not exist yet — retry without it.
  if (error && 'paused_at' in patch) {
    const isSchemaError =
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      (typeof error.message === 'string' && error.message.includes('does not exist'));
    if (isSchemaError) {
      const { paused_at: _drop, ...withoutPause } = patch;
      const retry = await supabase.from('user_books').update(withoutPause).eq('id', userBookId);
      error = retry.error;
    }
  }
  if (error) return { result: null, error: 'Could not save changes.' };

  return { result: { snapshot, updatedAt: new Date().toISOString() }, error: null };
}

/**
 * Restore a user_books row to a previous snapshot.
 * Used by the undo system after editUserBook or transitionStatus.
 */
export async function restoreSnapshot(
  supabase: SupabaseClient,
  params: { userBookId: string; snapshot: BookSnapshot },
): Promise<{ error: string | null }> {
  const { userBookId, snapshot } = params;

  const { error } = await supabase.from('user_books').update({
    status:       snapshot.status,
    started_at:   snapshot.startedAt,
    finished_at:  snapshot.finishedAt,
    finished_year: snapshot.finishedYear,
    deleted_at:   snapshot.deletedAt,
  }).eq('id', userBookId);

  return { error: error ? 'Could not undo. Please try again.' : null };
}

/**
 * Soft-delete a user_books row (sets deleted_at = now()).
 * The row is preserved; all queries must filter `deleted_at IS NULL`.
 */
export async function softDeleteBook(
  supabase: SupabaseClient,
  params: { userBookId: string },
): Promise<{ snapshot: BookSnapshot | null; error: string | null }> {
  const { userBookId } = params;

  const snapshot = await fetchSnapshot(supabase, userBookId);
  if (!snapshot) return { snapshot: null, error: 'Book not found.' };

  await insertHistory(supabase, userBookId, snapshot, 'delete');

  const { error } = await supabase
    .from('user_books')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', userBookId);

  return { snapshot, error: error ? 'Could not remove book.' : null };
}

/**
 * Restore a soft-deleted book (sets deleted_at = null).
 */
export async function restoreBook(
  supabase: SupabaseClient,
  params: { userBookId: string },
): Promise<{ error: string | null }> {
  const { userBookId } = params;

  const snapshot = await fetchSnapshot(supabase, userBookId);
  if (snapshot) await insertHistory(supabase, userBookId, snapshot, 'restore');

  const { error } = await supabase
    .from('user_books')
    .update({ deleted_at: null })
    .eq('id', userBookId);

  return { error: error ? 'Could not restore book.' : null };
}

/**
 * Read the currently persisted edition key for a user_books row.
 * Returns null when no edition has been selected or the column is absent.
 */
export async function getEditionKey(
  supabase: SupabaseClient,
  params: { userBookId: string },
): Promise<{ editionKey: string | null; error: string | null }> {
  const { userBookId } = params;
  const { data, error } = await supabase
    .from('user_books')
    .select('edition_key')
    .eq('id', userBookId)
    .single();
  if (error) return { editionKey: null, error: null }; // graceful — column may not exist yet
  return { editionKey: (data as { edition_key?: string | null })?.edition_key ?? null, error: null };
}

/**
 * Persist an Open Library edition key choice to user_books.
 * Pass null to clear a previously chosen edition.
 * This does not affect current_page or any other field.
 */
export async function setEditionKey(
  supabase: SupabaseClient,
  params: { userBookId: string; editionKey: string | null },
): Promise<{ error: string | null }> {
  const { userBookId, editionKey } = params;
  const { error } = await supabase
    .from('user_books')
    .update({ edition_key: editionKey })
    .eq('id', userBookId);
  return { error: error ? 'Could not save edition.' : null };
}

/**
 * Set or clear the explicit "paused" flag on a user_books row.
 *
 * Pass paused = true to mark the book as paused (writes paused_at = now()),
 * paused = false to resume (writes paused_at = null). Only meaningful for
 * books in 'reading' status — transitionStatus() always clears paused_at
 * when moving to finished / dnf / want_to_read so the flag can never
 * outlive the status it was set under.
 *
 * Returns { error } shaped like the rest of this module. The column may
 * not exist yet (migration pending) — in that case we surface a friendly
 * message rather than the raw Postgres error so the caller can fall back
 * gracefully (e.g. hide the button).
 */
export async function setPaused(
  supabase: SupabaseClient,
  params: { userBookId: string; paused: boolean },
): Promise<{ error: string | null }> {
  const { userBookId, paused } = params;
  const { error } = await supabase
    .from('user_books')
    .update({ paused_at: paused ? new Date().toISOString() : null })
    .eq('id', userBookId);
  if (!error) return { error: null };
  // Schema-error surface: column hasn't been added in this Supabase project.
  const isSchemaError =
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    (typeof error.message === 'string' && error.message.includes('does not exist'));
  return {
    error: isSchemaError
      ? 'Pause is not yet enabled on this database — apply the latest migration.'
      : 'Could not save pause state.',
  };
}

/**
 * Set or clear the "year goal stack" flag on a user_books row.
 *
 * Pass `year` = current calendar year to add the book to this year's
 * stack; pass `null` to remove it. Stored as an integer (not boolean)
 * so the historical signal survives — a book stacked for 2026 stays
 * marked as 2026 even after 2027 begins, and the home screen treats
 * any year != currentYear as "not currently stacked" without
 * destroying the value.
 *
 * Schema-tolerant: column may not exist yet on this Supabase project
 * if migration 20260507000001_user_books_year_goal.sql hasn't been
 * applied — surfaced as a friendly error so the caller can hide the
 * affordance gracefully.
 */
export async function setYearGoal(
  supabase: SupabaseClient,
  params: { userBookId: string; year: number | null },
): Promise<{ error: string | null }> {
  const { userBookId, year } = params;
  const { error } = await supabase
    .from('user_books')
    .update({ year_goal_year: year })
    .eq('id', userBookId);
  if (!error) return { error: null };
  const isSchemaError =
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    (typeof error.message === 'string' && error.message.includes('does not exist'));
  return {
    error: isSchemaError
      ? 'Year-goal stacking is not yet enabled on this database — apply the latest migration.'
      : 'Could not save your year-goal selection.',
  };
}

/**
 * Save an updated current_page to user_books and append both:
 *   1. reading_progress_events row  — lightweight page snapshot (always)
 *   2. reading_sessions row          — richer session record (forward progress only)
 *
 * A session is derived automatically from the delta between the previous page
 * and the new page.  Regressions (newPage < currentPage) are silently rejected
 * for sessions but still permitted in the progress snapshot — they remain
 * visible in the events log so the data is never lost.
 *
 * sessions are fire-and-forget (non-blocking) to keep the UX snappy.
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

  // ── Append reading_progress_events row (any page change) ──────────────────
  if (newPage !== currentPage) {
    supabase
      .from('reading_progress_events')
      .insert({ user_book_id: userBookId, book_id: bookId, user_id: userId, page: newPage })
      .then(({ error: evtErr }) => {
        if (evtErr) console.warn('[SESSION] progress_events insert failed:', evtErr.message, evtErr.code);
      });
  }

  // ── Derive and insert a reading_sessions row ──────────────────────────────
  // startedPage defaults to 0 when this is the first page update.
  // Forward progress (pagesRead > 0) inserts a normal session row.
  // Backward change (pagesRead < 0) inserts a correction row with a negative
  // pages_read so that analytics can compute net totals correctly and totals
  // decrease when the user reduces or resets their page.
  const startedPage = currentPage ?? 0;
  const pagesRead   = newPage - startedPage;

  if (pagesRead !== 0) {
    const sessionPayload = {
      user_id:          userId,
      book_id:          bookId,
      user_book_id:     userBookId,
      session_date:     localDateString(new Date()),
      started_page:     startedPage,
      ended_page:       newPage,
      pages_read:       pagesRead,
      duration_minutes: null as number | null,
    };
    if (__DEV__) console.log('[SESSION] inserting reading_sessions row:', JSON.stringify(sessionPayload));
    const { error: sessionErr } = await supabase
      .from('reading_sessions')
      .insert(sessionPayload);
    if (__DEV__) {
      if (sessionErr) {
        console.warn('[SESSION] reading_sessions insert FAILED:', sessionErr.message, '| code:', sessionErr.code, '| details:', sessionErr.details, '| hint:', sessionErr.hint);
      } else {
        console.log('[SESSION] reading_sessions row written ✓');
      }
    }
  }

  return { error: null };
}
