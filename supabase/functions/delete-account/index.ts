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
// public.delete_own_account() in supabase/migrations/20260329000000_account_lifecycle.sql.
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

    // Cascade delete in dependency order
    await adminClient.from('credibility_events').delete().or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
    await adminClient.from('activity_events').delete().eq('actor_id', uid);
    await adminClient.from('recommendations').delete().or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
    await adminClient.from('reader_preferences').delete().eq('user_id', uid);
    await adminClient.from('user_books').delete().eq('user_id', uid);
    await adminClient.from('friendships').delete().or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
    await adminClient.from('profiles').delete().eq('id', uid);

    // Delete the auth user — cascades rec_feedback, rec_entitlements, rec_cache,
    // rec_candidate_cache, scan_history via ON DELETE CASCADE on auth.users(id)
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(uid);
    if (deleteError) {
      return Response.json({ ok: false, error: deleteError.message }, { status: 500, headers: corsHeaders });
    }

    return Response.json({ ok: true }, { headers: corsHeaders });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
