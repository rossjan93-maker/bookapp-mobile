// Supabase Edge Function: verify-books-batch
// ============================================================================
// Reconciler that walks public.books rows in ('unverified','legacy') state
// and attempts to verify them against the canonical providers (Open Library
// and Google Books). On a high-confidence match (ISBN / works key / GB
// volume id) the row is flipped to provenance_state='verified' with
// canonical_provider and provider_verified_at set. On no match / error /
// timeout, verification_attempt_count is incremented and the row enters
// exponential backoff.
//
// Title+author search ("phase 3") is intentionally NOT implemented in
// P1.5b-1 — only high-confidence identifiers can auto-verify.
//
// Invocation:
//   - Scheduled trigger (Supabase dashboard) — hourly week 1, then nightly
//   - Manual ops invocation via service-role JWT
//   - Either way: requires service-role JWT in Authorization header
//
// Concurrency:
//   - pg_try_advisory_lock prevents overlapping invocations
//   - Each row is its own transaction (via separate update calls)
//   - Crash-safe: next run picks up where this one left off
//
// Deployment:
//   supabase functions deploy verify-books-batch
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (provided by Supabase runtime)
//   GOOGLE_BOOKS_API_KEY                      (optional; falls back to anon)
// ============================================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type { CanonicalBookFields, LookupOutcome, ReconcilerRow } from '../_shared/providers/types.ts';
import { lookupOpenLibrary } from '../_shared/providers/openLibrary.ts';
import { lookupGoogleBooks } from '../_shared/providers/googleBooks.ts';
import { getCachedFields, writeCachedFields } from '../_shared/providers/cache.ts';
import { LookupLogger } from '../_shared/providers/lookupLogger.ts';
import { anyProviderAvailable } from '../_shared/providers/rateLimiter.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;
const MAX_ATTEMPTS = 5;
const MAX_ERROR_LEN = 500; // mirrors books.last_verification_error CHECK

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Backoff in milliseconds, indexed by current attempt count (BEFORE this run).
//   count=0 → never attempted; eligible immediately
//   count=1 → wait 1h since last attempt before retrying
//   count=2 → wait 6h
//   count=3 → wait 24h
//   count=4 → wait 7d
//   count>=5 → permanently excluded by query predicate
function backoffMsForAttemptCount(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 60 * 60 * 1000;
  if (n === 2) return 6 * 60 * 60 * 1000;
  if (n === 3) return 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000; // n=4
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// Apply fill-empty / longer-wins policy. The reconciler runs as service-role
// so the P0.5 trigger lets it write anything; this is the application-layer
// guard rail.
//
// STRICT P1.5b-1 RULE: title and author are NEVER written by mergeFields,
// not even when the existing value is empty. Catalog identity is owned by
// the original inserter (or by the future trusted-write path in P1.5b-2);
// the reconciler only fills metadata around it. If you ever see a "title":
// or "author": key emitted from this function, it is a bug.
function mergeFields(
  existing: ReconcilerRow,
  incoming: CanonicalBookFields,
  // We don't have current description/subjects/etc. in ReconcilerRow because
  // the SELECT only pulls identity columns. Pass them separately when caller
  // has them; otherwise behave conservatively (fill-only-when-NULL).
  current?: Partial<{
    cover_url: string | null;
    description: string | null;
    subjects: string[] | null;
    publication_year: number | null;
    original_publication_year: number | null;
  }>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  // (NOTE: title and author are intentionally absent from this function.
  //  See the docblock above. Adding them here is a P1.5b-1 boundary
  //  violation — route catalog identity changes through P1.5b-2 instead.)
  // External id: fill if empty.
  if (isEmpty(existing.external_id) && !isEmpty(incoming.external_id)) {
    patch.external_id = incoming.external_id;
  }
  // ISBNs: fill if empty.
  if (isEmpty(existing.isbn) && !isEmpty(incoming.isbn)) patch.isbn = incoming.isbn;
  if (isEmpty(existing.isbn13) && !isEmpty(incoming.isbn13)) patch.isbn13 = incoming.isbn13;
  // Cover/description/subjects/years use `current` when available.
  if (current) {
    if (isEmpty(current.cover_url) && !isEmpty(incoming.cover_url)) {
      patch.cover_url = incoming.cover_url;
      patch.cover_source = 'reconciler';
    }
    if (
      !isEmpty(incoming.description) &&
      (isEmpty(current.description) ||
        (typeof current.description === 'string' &&
          (incoming.description as string).length >= Math.floor(current.description.length * 1.5)))
    ) {
      patch.description = incoming.description;
    }
    if (Array.isArray(incoming.subjects) && incoming.subjects.length > 0) {
      const cur = Array.isArray(current.subjects) ? current.subjects : [];
      // Strict superset: incoming includes every existing subject and adds at least one.
      const curSet = new Set(cur.map((s) => s.toLowerCase()));
      const incSet = new Set(incoming.subjects.map((s) => s.toLowerCase()));
      const isSuperset = [...curSet].every((s) => incSet.has(s)) && incSet.size > curSet.size;
      if (cur.length === 0 || isSuperset) patch.subjects = incoming.subjects;
    }
    if (isEmpty(current.publication_year) && !isEmpty(incoming.publication_year)) {
      patch.publication_year = incoming.publication_year;
    }
    if (isEmpty(current.original_publication_year) && !isEmpty(incoming.original_publication_year)) {
      patch.original_publication_year = incoming.original_publication_year;
    }
  }
  return patch;
}

async function runReconciler(admin: SupabaseClient, batchLimit: number): Promise<{
  processed: number;
  verified: number;
  failed: number;
  cache_hits: number;
  stopped_for_rate_limit: boolean;
  latency_ms: number;
}> {
  const t0 = Date.now();
  const logger = new LookupLogger(admin as unknown as Parameters<typeof writeCachedFields>[0] extends infer A ? A : never);
  let processed = 0, verified = 0, failed = 0, cache_hits = 0;
  let stopped_for_rate_limit = false;

  // Two-pass query — we cannot easily express the per-row backoff predicate
  // in PostgREST, so we filter in the application after fetching with a
  // generous limit. The partial index keeps the scan cheap.
  const { data: candidates, error: selErr } = await admin
    .from('books')
    .select(
      'id,title,author,isbn,isbn13,external_id,provenance_state,verification_attempt_count,last_verification_attempt_at,cover_url,description,subjects,publication_year,original_publication_year',
    )
    .in('provenance_state', ['unverified', 'legacy'])
    .lt('verification_attempt_count', MAX_ATTEMPTS)
    .order('verification_attempt_count', { ascending: true })
    .order('last_verification_attempt_at', { ascending: true, nullsFirst: true })
    .limit(batchLimit * 4); // overfetch — many will be filtered out by backoff

  if (selErr) throw new Error(`select_candidates_failed: ${selErr.message}`);

  const now = Date.now();
  const eligible: Array<ReconcilerRow & {
    cover_url: string | null;
    description: string | null;
    subjects: string[] | null;
    publication_year: number | null;
    original_publication_year: number | null;
  }> = [];
  for (const row of (candidates ?? [])) {
    const r = row as ReconcilerRow & {
      cover_url: string | null;
      description: string | null;
      subjects: string[] | null;
      publication_year: number | null;
      original_publication_year: number | null;
    };
    const lastTs = r.last_verification_attempt_at ? Date.parse(r.last_verification_attempt_at) : null;
    const wait = backoffMsForAttemptCount(r.verification_attempt_count);
    if (lastTs == null || (now - lastTs) >= wait) {
      eligible.push(r);
      if (eligible.length >= batchLimit) break;
    }
  }

  for (const row of eligible) {
    if (!anyProviderAvailable()) {
      stopped_for_rate_limit = true;
      break;
    }
    processed += 1;
    const outcomes: LookupOutcome[] = [];
    let success: { provider: 'open_library' | 'google_books'; fields: CanonicalBookFields } | null = null;

    // Decide lookup order based on what identifiers we have.
    const tries: Array<() => Promise<LookupOutcome>> = [];

    // Phase 1: ISBN-first (highest confidence)
    if (row.isbn13) {
      tries.push(async () => {
        const cached = await getCachedFields(admin as never, `isbn13:${row.isbn13}`);
        if (cached.hit && cached.fields) {
          return { provider: 'open_library', lookup_kind: 'isbn13', identifier: row.isbn13!, status: 'cache_hit', latency_ms: 0, http_status: null, error_detail: null, conflict_field: null, fields: cached.fields };
        }
        return await lookupOpenLibrary('isbn13', row.isbn13!);
      });
    }
    if (row.isbn) {
      tries.push(async () => {
        const cached = await getCachedFields(admin as never, `isbn:${row.isbn}`);
        if (cached.hit && cached.fields) {
          return { provider: 'open_library', lookup_kind: 'isbn', identifier: row.isbn!, status: 'cache_hit', latency_ms: 0, http_status: null, error_detail: null, conflict_field: null, fields: cached.fields };
        }
        return await lookupOpenLibrary('isbn', row.isbn!);
      });
    }

    // Phase 2: external_id-direct (works key or GB volume id)
    if (row.external_id) {
      if (/^\/works\/OL\d+W$/.test(row.external_id)) {
        const ek = row.external_id;
        tries.push(async () => {
          const cached = await getCachedFields(admin as never, ek);
          if (cached.hit && cached.fields) {
            return { provider: 'open_library', lookup_kind: 'works_key', identifier: ek, status: 'cache_hit', latency_ms: 0, http_status: null, error_detail: null, conflict_field: null, fields: cached.fields };
          }
          return await lookupOpenLibrary('works_key', ek);
        });
      } else if (/^gb[:_][A-Za-z0-9_-]+$/.test(row.external_id)) {
        const volumeId = row.external_id.slice(3);
        const ek = row.external_id;
        tries.push(async () => {
          const cached = await getCachedFields(admin as never, ek);
          if (cached.hit && cached.fields) {
            return { provider: 'google_books', lookup_kind: 'volume_id', identifier: volumeId, status: 'cache_hit', latency_ms: 0, http_status: null, error_detail: null, conflict_field: null, fields: cached.fields };
          }
          return await lookupGoogleBooks('volume_id', volumeId);
        });
      }
    }

    // Phase 1 fallback to GB if OL didn't resolve and we have ISBN
    if (row.isbn13) tries.push(() => lookupGoogleBooks('isbn13', row.isbn13!));
    if (row.isbn) tries.push(() => lookupGoogleBooks('isbn', row.isbn!));

    for (const tryFn of tries) {
      const outcome = await tryFn();
      outcomes.push(outcome);
      if (outcome.status === 'cache_hit') cache_hits += 1;
      if ((outcome.status === 'success' || outcome.status === 'cache_hit') && outcome.fields) {
        success = { provider: outcome.provider, fields: outcome.fields };
        break;
      }
      if (outcome.status === 'rate_limited' && !anyProviderAvailable()) {
        stopped_for_rate_limit = true;
        break;
      }
    }

    // Persist outcomes to provider_lookup_log.
    for (const o of outcomes) logger.add(row.id, o);

    if (success) {
      const patch = mergeFields(row, success.fields, {
        cover_url: row.cover_url,
        description: row.description,
        subjects: row.subjects,
        publication_year: row.publication_year,
        original_publication_year: row.original_publication_year,
      });
      patch.provenance_state = 'verified';
      patch.provider_verified_at = new Date().toISOString();
      patch.last_verification_attempt_at = new Date().toISOString();
      patch.canonical_provider = success.provider;
      patch.last_verification_error = null;
      // verification_attempt_count intentionally not changed on success.

      const { error: updErr } = await admin.from('books').update(patch).eq('id', row.id);
      if (updErr) {
        failed += 1;
        logger.add(row.id, {
          provider: success.provider,
          lookup_kind: 'works_key',
          identifier: row.external_id ?? '(unknown)',
          status: 'provider_error',
          latency_ms: 0,
          http_status: null,
          error_detail: `update_failed: ${updErr.message}`.slice(0, 500),
          conflict_field: null,
          fields: null,
        });
      } else {
        verified += 1;
        // Cache the successful payload by external_id for cheap re-runs.
        const externalId = (patch.external_id as string | undefined) ?? row.external_id;
        if (externalId && success.fields) {
          await writeCachedFields(admin as never, externalId, row.id, success.provider, success.fields);
        }
      }
    } else {
      failed += 1;
      // Truncate to MAX_ERROR_LEN — defense-in-depth: the books CHECK
      // also enforces the 500-char cap, but we'd rather not surface a
      // CHECK violation from the reconciler when we can avoid it.
      const lastError = outcomes.length > 0
        ? `${outcomes[outcomes.length - 1].status}:${outcomes[outcomes.length - 1].error_detail ?? ''}`.slice(0, MAX_ERROR_LEN)
        : 'no_attempts_made';
      const { error: updErr } = await admin.from('books').update({
        last_verification_attempt_at: new Date().toISOString(),
        verification_attempt_count: row.verification_attempt_count + 1,
        last_verification_error: lastError,
      }).eq('id', row.id);
      if (updErr) console.error(`[verify-books-batch] failure update for book ${row.id}:`, updErr.message);
    }
  }

  await logger.flush();
  return {
    processed,
    verified,
    failed,
    cache_hits,
    stopped_for_rate_limit,
    latency_ms: Date.now() - t0,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: corsHeaders });
  }

  // Service-role-only auth gate. We compare the JWT to the service-role key
  // directly because the reconciler is a privileged background job — there
  // is no user identity to authenticate, only the operator/cron credential.
  const auth = req.headers.get('Authorization') ?? '';
  const expected = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  if (auth !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: corsHeaders });
  }

  let batchLimit = DEFAULT_BATCH_LIMIT;
  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  if (limitParam) {
    const n = parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0) batchLimit = Math.min(n, MAX_BATCH_LIMIT);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Acquire the table-row lock primitive defined in the migration.
  // We use a row-presence lock (not pg_try_advisory_lock) because PostgREST
  // opens a fresh DB session per HTTP request — a session-scoped advisory
  // lock would auto-release after the acquire call returned, defeating the
  // overlap protection. See the migration header for the rationale.
  const actorLabel = `verify-books-batch@${new Date().toISOString()}`;
  const { data: acquired, error: lockErr } = await admin.rpc(
    'verify_books_batch_acquire_lock',
    { p_actor: actorLabel },
  );
  if (lockErr) {
    console.error('[verify-books-batch] acquire-lock RPC failed:', lockErr.message);
    return Response.json(
      { ok: false, error: `acquire_lock_failed: ${lockErr.message}` },
      { status: 500, headers: corsHeaders },
    );
  }
  if (acquired !== true) {
    return Response.json(
      { ok: true, skipped: true, reason: 'already_running' },
      { headers: corsHeaders },
    );
  }

  try {
    const summary = await runReconciler(admin, batchLimit);
    return Response.json({ ok: true, ...summary }, { headers: corsHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[verify-books-batch] ERROR:', message);
    return Response.json({ ok: false, error: message }, { status: 500, headers: corsHeaders });
  } finally {
    // Always release. If the release fails, log loudly — the runbook covers
    // the manual recovery procedure (verify_books_batch_force_release_lock).
    const { error: releaseErr } = await admin.rpc('verify_books_batch_release_lock');
    if (releaseErr) {
      console.error('[verify-books-batch] release-lock RPC failed:', releaseErr.message);
    }
  }
});
