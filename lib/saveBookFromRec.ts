import type { SupabaseClient } from '@supabase/supabase-js';

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
      const { data: existing } = await client
        .from('books')
        .select('id')
        .eq('external_id', input.externalId)
        .maybeSingle();
      if (existing) {
        bookDbId = (existing as { id: string }).id;
      } else {
        const { data: created, error: createErr } = await client
          .from('books')
          .insert({
            title:       input.title,
            author:      input.author,
            external_id: input.externalId,
            cover_url:   input.coverUrl,
            subjects:    input.subjects ?? null,
            page_count:  input.pageCount ?? null,
          })
          .select('id')
          .single();
        if (createErr) return { bookDbId: null, userBookId: null, error: createErr.message };
        bookDbId = (created as { id: string } | null)?.id ?? null;
      }
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
