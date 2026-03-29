// Supabase Edge Function: admin-reset-account
//
// Dev / admin-only. Finds and fully purges a user account by email.
// For repeatable test account reset without manual DB surgery.
//
// Deployment (requires Supabase CLI):
//   supabase functions deploy admin-reset-account
//   supabase secrets set ADMIN_RESET_SECRET=your-dev-secret-here
//
// Usage (curl example — admin/dev only, never from the mobile client):
//   curl -X POST https://<project>.supabase.co/functions/v1/admin-reset-account \
//     -H "Content-Type: application/json" \
//     -H "X-Admin-Secret: your-dev-secret-here" \
//     -d '{"email":"test@example.com"}'
//
// The primary implementation is also available via SQL RPC
// public.admin_reset_account() in the migration file.
//
// Security:
//   - Requires ADMIN_RESET_SECRET env var set via `supabase secrets set`
//   - Caller must pass matching secret in X-Admin-Secret header
//   - Service role key is NEVER exposed to the mobile client
//   - Only callable from server-side / admin context

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_RESET_SECRET        = Deno.env.get('ADMIN_RESET_SECRET') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: corsHeaders });
  }

  // ── Verify admin secret ───────────────────────────────────────────────────
  if (!ADMIN_RESET_SECRET) {
    return Response.json(
      { ok: false, error: 'admin_reset_not_configured', hint: 'Run: supabase secrets set ADMIN_RESET_SECRET=...' },
      { status: 500, headers: corsHeaders }
    );
  }

  const providedSecret = req.headers.get('X-Admin-Secret') ?? '';
  if (providedSecret !== ADMIN_RESET_SECRET) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 403, headers: corsHeaders });
  }

  // ── Parse request body ────────────────────────────────────────────────────
  let email: string;
  try {
    const body = await req.json();
    email = (body?.email ?? '').trim().toLowerCase();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: corsHeaders });
  }

  if (!email) {
    return Response.json({ ok: false, error: 'email_required' }, { status: 400, headers: corsHeaders });
  }

  try {
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Find user by email ────────────────────────────────────────────────────
    // listUsers doesn't support filtering by email in the JS SDK, so we page
    // through until we find the match. For a dev/admin tool with small user
    // counts this is acceptable.
    let targetUserId: string | null = null;
    let page = 1;

    outer: while (true) {
      const { data: { users }, error } = await adminClient.auth.admin.listUsers({ page, perPage: 100 });
      if (error) throw error;
      if (!users || users.length === 0) break;

      for (const u of users) {
        if ((u.email ?? '').toLowerCase() === email) {
          targetUserId = u.id;
          break outer;
        }
      }

      if (users.length < 100) break;
      page++;
    }

    if (!targetUserId) {
      return Response.json({ ok: false, error: 'user_not_found', email }, { status: 404, headers: corsHeaders });
    }

    const uid = targetUserId;

    // ── Cascade delete app data ───────────────────────────────────────────────
    await adminClient.from('credibility_events').delete().or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
    await adminClient.from('activity_events').delete().eq('actor_id', uid);
    await adminClient.from('recommendations').delete().or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
    await adminClient.from('reader_preferences').delete().eq('user_id', uid);
    await adminClient.from('user_books').delete().eq('user_id', uid);
    await adminClient.from('friendships').delete().or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
    await adminClient.from('profiles').delete().eq('id', uid);

    // ── Delete auth user ──────────────────────────────────────────────────────
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(uid);
    if (deleteError) {
      return Response.json({ ok: false, error: deleteError.message }, { status: 500, headers: corsHeaders });
    }

    return Response.json({ ok: true, deleted_user_id: uid, email }, { headers: corsHeaders });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  }
});
