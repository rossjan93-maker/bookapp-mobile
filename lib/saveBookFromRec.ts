import type { SupabaseClient } from '@supabase/supabase-js';
import { findOrInsertBookByExternalId } from './findOrInsertBookByExternalId';

export type SaveBookFromRecInput = {
  userId:      string;
  externalId:  string | null;
  bookId:      string | null;
  title:       string;
  author:      string;
  coverUrl:    string | null;
  subjects?:   string[] | null;
  pageCount?:  number | null;
  yearGoalYear?: number | null;
};

export type SaveBookFromRecResult = {
  bookDbId:   string | null;
  userBookId: string | null;
  error:      string | null;
};

export async function saveBookFromRec(
  client: SupabaseClient,
  input:  SaveBookFromRecInput,
): Promise<SaveBookFromRecResult> {
  let bookDbId: string | null = input.bookId;

  try {
    if (!bookDbId && input.externalId) {
      // I6 — Option B-lite cross-user dedup-read; see
      // docs/p1_5b_3_dedup_audit.md and docs/p1_5b_2_surface_audit.md §C.5
      const { row, error: helperErr } = await findOrInsertBookByExternalId<{ id: string }>(
        client,
        {
          userId:        input.userId,
          externalId:    input.externalId,
          selectColumns: 'id',
          insertPayload: {
            title:       input.title,
            author:      input.author,
            external_id: input.externalId,
            cover_url:   input.coverUrl,
            subjects:    input.subjects ?? null,
            page_count:  input.pageCount ?? null,
          },
          callSite: 'lib/saveBookFromRec.ts',
        },
      );
      if (helperErr) return { bookDbId: null, userBookId: null, error: helperErr.message };
      bookDbId = row?.id ?? null;
    }

    if (!bookDbId) {
      return { bookDbId: null, userBookId: null, error: 'Could not resolve book id' };
    }

    const row: Record<string, unknown> = {
      user_id: input.userId,
      book_id: bookDbId,
      status:  'want_to_read',
    };
    if (input.yearGoalYear != null) row.year_goal_year = input.yearGoalYear;

    const tryUpsert = async (payload: Record<string, unknown>) => {
      return client
        .from('user_books')
        .upsert(payload, { onConflict: 'user_id,book_id' })
        .select('id')
        .single();
    };

    let { data, error } = await tryUpsert(row);
    if (error && (error.code === '42703' || error.code === 'PGRST204') && 'year_goal_year' in row) {
      delete row.year_goal_year;
      const retry = await tryUpsert(row);
      data  = retry.data;
      error = retry.error;
    }
    if (error) return { bookDbId, userBookId: null, error: error.message };

    const userBookId = (data as { id: string } | null)?.id ?? null;
    return { bookDbId, userBookId, error: null };
  } catch (e: any) {
    return { bookDbId, userBookId: null, error: e?.message ?? 'Unknown error' };
  }
}
