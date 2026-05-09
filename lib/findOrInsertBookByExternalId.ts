import type { SupabaseClient } from '@supabase/supabase-js';

export type FindOrInsertVia = 'filtered_hit' | 'insert' | 'unfiltered_fallback';

export type FindOrInsertResult<T extends Record<string, unknown>> = {
  row:          (T & { id: string }) | null;
  via:          FindOrInsertVia;
  fallbackUsed: boolean;
  error:        { code: string; message: string } | null;
};

/**
 * Option B-lite cross-user dedup-read pattern (P1.5b-3, see
 * docs/p1_5b_2_surface_audit.md §C.5 and docs/p1_5b_3_dedup_audit.md).
 *
 * Why: `books.external_id` is UNIQUE. The provenance filter
 * (`provenance_state.eq.verified,provenance_inserted_by.eq.${userId}`)
 * can hide an unverified row that another user inserted. Without a
 * fallback, the subsequent INSERT would hit SQLSTATE 23505 and the
 * caller's save would fail.
 *
 *   1. Filtered read first (verified OR own inserts).
 *   2. On miss, attempt INSERT.
 *   3. On 23505, do an UNFILTERED read by external_id and use that row.
 *   4. Emit a structured console.warn on fallback.
 *
 * Does NOT introduce a "verifying…" UI state.
 * Does NOT weaken the D1/D2/D4 hard-filter pattern (those stay strict).
 *
 * Persistent telemetry (catalog_event_log or RPC-backed surface) is a
 * future P2 follow-up — provider_lookup_log is intentionally
 * service-role-only and must not be loosened from client paths.
 */
export async function findOrInsertBookByExternalId<T extends Record<string, unknown>>(
  client: SupabaseClient,
  args: {
    userId:        string;
    externalId:    string;
    selectColumns: string;                     // e.g. 'id' or 'id, cover_url, page_count'
    insertPayload: Record<string, unknown>;
    callSite:      string;                     // for telemetry
  },
): Promise<FindOrInsertResult<T>> {
  const filterExpr = `provenance_state.eq.verified,provenance_inserted_by.eq.${args.userId}`;

  // 1. filtered read
  const { data: hit } = await client
    .from('books')
    .select(args.selectColumns)
    .eq('external_id', args.externalId)
    .or(filterExpr)
    .maybeSingle();
  if (hit) {
    return {
      row:          hit as unknown as T & { id: string },
      via:          'filtered_hit',
      fallbackUsed: false,
      error:        null,
    };
  }

  // 2. insert on miss
  const { data: created, error: insertErr } = await client
    .from('books')
    .insert(args.insertPayload)
    .select(args.selectColumns)
    .single();
  if (!insertErr && created) {
    return {
      row:          created as unknown as T & { id: string },
      via:          'insert',
      fallbackUsed: false,
      error:        null,
    };
  }

  // 3. unfiltered fallback on UNIQUE collision
  if (insertErr?.code === '23505') {
    const { data: collided } = await client
      .from('books')
      .select(args.selectColumns)
      .eq('external_id', args.externalId)
      .maybeSingle();
    if (collided) {
      // 4. structured warn (no PII; no title/author/user-visible text)
      console.warn('[catalog]', {
        event:             'cross_user_dedup_fallback',
        call_site:         args.callSite,
        external_id:       args.externalId,
        error_code:        '23505',
        recovered_book_id: (collided as unknown as { id: string }).id,
      });
      return {
        row:          collided as unknown as T & { id: string },
        via:          'unfiltered_fallback',
        fallbackUsed: true,
        error:        null,
      };
    }
  }

  return {
    row:          null,
    via:          'insert',
    fallbackUsed: false,
    error:        insertErr
      ? { code: insertErr.code ?? 'unknown', message: insertErr.message }
      : { code: 'unknown', message: 'insert returned no row' },
  };
}
