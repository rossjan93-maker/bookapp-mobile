// Supabase Edge Function: delete-account
//
// Alternative to the SQL RPC approach for user self-serve account deletion.
// This Edge Function variant is useful if you need more control over the deletion
// flow (e.g., sending a farewell email, webhook, analytics event) before deletion.
//
// Deployment (requires Supabase CLI):
//   supabase functions deploy delete-account
//
// The primary implementation used by the mobile app is the SQL RPC
// public.delete_own_account() in supabase/migrations/20260329000000_account_lifecycle.sql
// (fixed in 20260330000000_fix_deletion_and_reset.sql).
// This Edge Function is a ready-to-deploy alternative/complement.
//
// Security: Caller must provide a valid user JWT in the Authorization header.
//           The function verifies the JWT, then uses the service role key to delete
//           the auth user. The user can only delete themselves.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY        = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Helper: throw if supabase operation returns an error
function assertOk(error: unknown, step: string) {
  if (error && typeof error === 'object' && 'message' in error) {
    throw new Error(`[${step}] ${(error as { message: string }).message}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return Response.json({ ok: false, error: 'missing_authorization' }, { status: 401, headers: corsHeaders });
    }

    // ── Verify the caller's identity via their JWT ──────────────────────────
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: corsHeaders });
    }

    const uid = user.id;

    // ── Use service role client for the privileged deletes ──────────────────
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Step 1a: activity_events referencing THIS USER's recommendations ────
    // Handles cross-user events (actor_id ≠ uid). Must precede recommendations delete.
    const { data: userRecIds } = await adminClient
      .from('recommendations')
      .select('id')
      .or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);

    if (userRecIds && userRecIds.length > 0) {
      const ids = userRecIds.map((r: { id: string }) => r.id);
      const { error: e1a } = await adminClient
        .from('activity_events')
        .delete()
        .in('recommendation_id', ids);
      assertOk(e1a, 'activity_events_by_rec');
    }

    // ── Step 1b: remaining activity_events where the user was the actor ─────
    const { error: e1b } = await adminClient
      .from('activity_events')
      .delete()
      .eq('actor_id', uid);
    assertOk(e1b, 'activity_events_by_actor');

    // ── Step 2a: credibility_events referencing THIS USER's recommendations ─
    if (userRecIds && userRecIds.length > 0) {
      const ids = userRecIds.map((r: { id: string }) => r.id);
      const { error: e2a } = await adminClient
        .from('credibility_events')
        .delete()
        .in('recommendation_id', ids);
      assertOk(e2a, 'credibility_events_by_rec');
    }

    // ── Step 2b: remaining credibility_events involving this user ───────────
    const { error: e2b } = await adminClient
      .from('credibility_events')
      .delete()
      .or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
    assertOk(e2b, 'credibility_events_by_user');

    // ── Step 3: recommendations (CASCADE handles any remaining ae/ce refs) ──
    const { error: e3 } = await adminClient
      .from('recommendations')
      .delete()
      .or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
    assertOk(e3, 'recommendations');

    // ── Step 4: reader_preferences ──────────────────────────────────────────
    const { error: e4 } = await adminClient
      .from('reader_preferences')
      .delete()
      .eq('user_id', uid);
    assertOk(e4, 'reader_preferences');

    // ── Step 4.5 (NEW): import_rows owned by this user ──────────────────────
    // MUST run before user_books delete. import_rows.user_book_id references
    // user_books(id) with no ON DELETE clause (defaults to NO ACTION), so
    // any user who has imported a Goodreads CSV would otherwise trip
    // import_rows_user_book_id_fkey at Step 5. import_rows is user-scoped
    // (user_id NOT NULL) and the rows are pure audit history of one-time
    // ingest — safe to delete with the account. import_batches cascades
    // automatically when profiles is deleted at Step 7, so we do not need
    // to touch it explicitly. Mirrors the SQL fix in
    // supabase/migrations/20260515000000_account_deletion_fix_import_rows.sql.
    const { error: e4_5 } = await adminClient
      .from('import_rows')
      .delete()
      .eq('user_id', uid);
    assertOk(e4_5, 'import_rows');

    // ── Step 5: user_books (user_book_history cascades automatically) ───────
    const { error: e5 } = await adminClient
      .from('user_books')
      .delete()
      .eq('user_id', uid);
    assertOk(e5, 'user_books');

    // ── Step 6: friendships ─────────────────────────────────────────────────
    const { error: e6 } = await adminClient
      .from('friendships')
      .delete()
      .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
    assertOk(e6, 'friendships');

    // ── Step 7: profiles (cascades reading_progress_events, import_batches) ─
    const { error: e7 } = await adminClient
      .from('profiles')
      .delete()
      .eq('id', uid);
    assertOk(e7, 'profiles');

    // ── Step 8: auth user (cascades rec_feedback, rec_entitlements, ─────────
    //            rec_cache, rec_candidate_cache, scan_history)
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(uid);
    if (deleteError) {
      return Response.json({ ok: false, error: deleteError.message }, { status: 500, headers: corsHeaders });
    }

    return Response.json({ ok: true }, { headers: corsHeaders });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[delete-account] ERROR:', message);
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
