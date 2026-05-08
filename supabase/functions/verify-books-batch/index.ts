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
//   SUPABASE_URL                              (auto-injected by Supabase runtime)
//   READSTACK_SERVICE_ROLE_KEY                (preferred; set via `supabase secrets set`)
//     ↳ falls back to SUPABASE_SERVICE_ROLE_KEY (auto-injected at runtime)
//   GOOGLE_BOOKS_API_KEY                      (optional; falls back to anon GB)
//
// Why two names: the Supabase CLI refuses to set secrets whose name starts
// with `SUPABASE_` (reserved prefix). The runtime injects its own
// SUPABASE_SERVICE_ROLE_KEY automatically — but operators who need to override
// it (e.g. to lock the function to a rotated key, or to test against a
// non-default value) cannot do so under that name. READSTACK_SERVICE_ROLE_KEY
// is the operator-settable alias; if present it wins, otherwise we fall back
// to the runtime-injected value. Both must decode to role=service_role for
// the auth gate below to pass.
// ============================================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type { CanonicalBookFields, LookupOutcome, ReconcilerRow } from '../_shared/providers/types.ts';
import { lookupOpenLibrary } from '../_shared/providers/openLibrary.ts';
import { lookupGoogleBooks } from '../_shared/providers/googleBooks.ts';
import { getCachedFields, writeCachedFields } from '../_shared/providers/cache.ts';
import { LookupLogger } from '../_shared/providers/lookupLogger.ts';
import { anyProviderAvailable } from '../_shared/providers/rateLimiter.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// Operator-settable alias wins over the runtime-injected key. See header for
// rationale. We resolve once at module load; both auth gate and admin client
// must use the same value, so a single source of truth is important.
const SERVICE_ROLE_KEY =
  Deno.env.get('READSTACK_SERVICE_ROLE_KEY') ??
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  null;
// Boolean presence + length only — never the value itself. Length is safe to
// log because JWTs are not secret-by-length and this aids deploy diagnosis.
console.log(JSON.stringify({
  evt: 'service_role_key_resolved',
  readstack_present: !!Deno.env.get('READSTACK_SERVICE_ROLE_KEY'),
  fallback_present: !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  resolved_present: !!SERVICE_ROLE_KEY,
  resolved_length: SERVICE_ROLE_KEY?.length ?? 0,
}));

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

// ─── P1.5b-1.1 helpers ──────────────────────────────────────────────────────
// F1: parser for the legacy `onboarding_isbn_<10-or-13-digits>` external_id
// scheme. The digits ARE an ISBN; the `onboarding_isbn_` prefix is an
// internal Readstack convention from the onboarding entry flow and is
// unrecognized by every external provider. We extract the ISBN and inject
// matching tries into the resolver so these rows can verify against either
// provider via the standard ISBN/ISBN13 paths.
//
// Bounded by the strict 10-or-13-digit regex; nothing else is accepted.
// Returns null for any input that doesn't match — callers must treat null
// as "not an onboarding_isbn external_id" (NOT as "verification failure").
function parseOnboardingIsbn(
  externalId: string | null,
): { kind: 'isbn' | 'isbn13'; value: string } | null {
  if (!externalId) return null;
  const m = externalId.match(/^onboarding_isbn_(\d{10}|\d{13})$/);
  if (!m) return null;
  return m[1].length === 13 ? { kind: 'isbn13', value: m[1] } : { kind: 'isbn', value: m[1] };
}

// Modified F4: terminal-classification helper.
//
// A row is "terminal" when there is no actionable verification path forward
// — no recognized external_id scheme AND no ISBN/ISBN13 to fall back on.
// These rows would otherwise spin uselessly through every cron tick,
// burning provider budget that should serve verifiable rows.
//
// Three terminal reasons (the strings are persisted to
// books.last_verification_error verbatim):
//   - 'placeholder_manual_entry'        — `/works/other_<slug>` scratch rows
//   - 'unsupported_external_id_scheme'  — recognized as opaque (e.g. `goodreads:NNN`)
//                                          but no ISBN to fall back on
//   - 'missing_supported_identifier'    — no external_id AND no ISBN at all
//
// Returns null for rows that DO have a verification path (caller proceeds
// to the normal resolver loop). Order of checks matters: we accept ISBN as
// sufficient even when the external_id is unrecognized, because the ISBN
// path is high-confidence and the row will verify normally via that path.
//
// IMPORTANT: this helper does NOT mark rows verified. The caller, when
// terminal, sets verification_attempt_count = MAX_ATTEMPTS and persists
// the reason string — the row stays in its existing provenance_state
// (typically 'legacy'). F5 is the future migration that may move these to
// `'unverified'` or a new `'manual'` state for surface filtering.
type TerminalReason =
  | 'placeholder_manual_entry'
  | 'unsupported_external_id_scheme'
  | 'missing_supported_identifier';

function classifyTerminal(row: ReconcilerRow): TerminalReason | null {
  // ISBN of either form is always an actionable verification path.
  if (!isEmpty(row.isbn13) || !isEmpty(row.isbn)) return null;

  // External_id schemes the resolver knows how to dispatch on.
  if (row.external_id) {
    if (/^\/works\/OL\d+W$/.test(row.external_id)) return null;          // OL works key
    if (/^gb[:_][A-Za-z0-9_-]+$/.test(row.external_id)) return null;     // GB volume id
    if (parseOnboardingIsbn(row.external_id)) return null;               // F1: onboarding_isbn_<digits>
    if (/^\/works\/other_/.test(row.external_id)) return 'placeholder_manual_entry';
    return 'unsupported_external_id_scheme';
  }
  return 'missing_supported_identifier';
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

    // Modified F4: pre-flight terminal classification. If the row has no
    // actionable verification path, mark it terminal and skip provider
    // attempts entirely. Terminal rows get verification_attempt_count =
    // MAX_ATTEMPTS so the reconciler's WHERE-clause predicate excludes them
    // on subsequent runs. Provenance_state is intentionally left unchanged.
    const terminalReason = classifyTerminal(row);
    if (terminalReason) {
      failed += 1;
      const { error: updErr } = await admin.from('books').update({
        last_verification_attempt_at: new Date().toISOString(),
        verification_attempt_count: MAX_ATTEMPTS,
        last_verification_error: terminalReason,
      }).eq('id', row.id);
      if (updErr) {
        console.error(`[verify-books-batch] terminal update for book ${row.id}:`, updErr.message);
      }
      continue;
    }

    const outcomes: LookupOutcome[] = [];
    let success: { provider: 'open_library' | 'google_books'; fields: CanonicalBookFields } | null = null;

    // Decide lookup order based on what identifiers we have.
    //
    // Ordering rationale (do not reorder casually):
    //   1. ISBN-first because ISBN is the highest-confidence identifier and
    //      the OL ISBN endpoint also returns the canonical works key, so a
    //      successful ISBN call costs the same as a works_key call (OL even
    //      consolidates them into a single bibkeys request internally).
    //   2. external_id (works_key or GB volume_id) second — this is what
    //      F2 implicitly enforces: when a row has BOTH a works_key and an
    //      ISBN, OL ISBN is tried first; if OL ISBN returns a transient
    //      5xx/timeout/rate_limit (mapped to status='not_found' or
    //      'rate_limited'), control falls through to the works_key try
    //      and then to the GB ISBN try. The for-loop only breaks on
    //      success or on rate_limit-with-no-providers-available.
    //   3. GB ISBN last — this is F3: when OL ISBN/works_key both return
    //      'not_found', GB-by-ISBN gets one final shot before we record
    //      a failure. Mirrors the symmetrical OL-then-GB ladder we use
    //      for the cover-fetch path elsewhere in the app.
    const tries: Array<() => Promise<LookupOutcome>> = [];

    // F1: synthesize an ISBN-equivalent identifier for `onboarding_isbn_<digits>`
    // external_ids when the row's isbn/isbn13 columns are empty. Adds the
    // synth ISBN to the start of the tries ladder so it benefits from the
    // same OL→GB fallthrough as natively-ISBN'd rows.
    const synthIsbn = parseOnboardingIsbn(row.external_id);
    if (synthIsbn) {
      const cacheKey = `${synthIsbn.kind}:${synthIsbn.value}`;
      if (synthIsbn.kind === 'isbn13' && isEmpty(row.isbn13)) {
        tries.push(async () => {
          const cached = await getCachedFields(admin as never, cacheKey);
          if (cached.hit && cached.fields) {
            return { provider: 'open_library', lookup_kind: 'isbn13', identifier: synthIsbn.value, status: 'cache_hit', latency_ms: 0, http_status: null, error_detail: null, conflict_field: null, fields: cached.fields };
          }
          return await lookupOpenLibrary('isbn13', synthIsbn.value);
        });
        tries.push(() => lookupGoogleBooks('isbn13', synthIsbn.value));
      } else if (synthIsbn.kind === 'isbn' && isEmpty(row.isbn)) {
        tries.push(async () => {
          const cached = await getCachedFields(admin as never, cacheKey);
          if (cached.hit && cached.fields) {
            return { provider: 'open_library', lookup_kind: 'isbn', identifier: synthIsbn.value, status: 'cache_hit', latency_ms: 0, http_status: null, error_detail: null, conflict_field: null, fields: cached.fields };
          }
          return await lookupOpenLibrary('isbn', synthIsbn.value);
        });
        tries.push(() => lookupGoogleBooks('isbn', synthIsbn.value));
      }
    }

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
      // Outcomes here are guaranteed non-empty: the pre-flight
      // classifyTerminal() check above handles the no-actionable-identifier
      // case (sets count=MAX_ATTEMPTS and emits a diagnostic terminal
      // string). If we somehow reach this branch with outcomes.length===0,
      // it means a row had a tries[] entry that didn't run — surface it as
      // a distinct error string for triage rather than silently incrementing.
      //
      // Truncate to MAX_ERROR_LEN — defense-in-depth: the books CHECK
      // also enforces the 500-char cap, but we'd rather not surface a
      // CHECK violation from the reconciler when we can avoid it.
      const lastError = outcomes.length > 0
        ? `${outcomes[outcomes.length - 1].status}:${outcomes[outcomes.length - 1].error_detail ?? ''}`.slice(0, MAX_ERROR_LEN)
        : 'tries_built_but_none_executed';
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

  // Fail loud if neither secret name resolved. Returning 500 (not 401) here is
  // deliberate: the request is well-formed but the function is misconfigured,
  // and we want operators to see a distinct failure mode that points at the
  // deploy step, not at their request headers.
  if (!SERVICE_ROLE_KEY) {
    return Response.json({ ok: false, error: 'missing_service_role_key' }, { status: 500, headers: corsHeaders });
  }

  // Service-role-only auth gate. We compare the JWT to the service-role key
  // directly because the reconciler is a privileged background job — there
  // is no user identity to authenticate, only the operator/cron credential.
  const auth = req.headers.get('Authorization') ?? '';
  const expected = `Bearer ${SERVICE_ROLE_KEY}`;
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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
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
    // Actor-scoped release: passes our own actorLabel so that if this run
    // exceeded the 30-minute stale-lock threshold and a peer took over,
    // we won't clobber the peer's healthy lock. A `false` return here is
    // non-fatal and means "we lost the lock to a takeover" — the matching
    // RAISE NOTICE from acquire_lock is the audit trail.
    const { data: released, error: releaseErr } = await admin.rpc(
      'verify_books_batch_release_lock',
      { p_actor: actorLabel },
    );
    if (releaseErr) {
      console.error('[verify-books-batch] release-lock RPC failed:', releaseErr.message);
    } else if (released !== true) {
      console.warn('[verify-books-batch] release returned false — lock was taken over by a peer (actor=' + actorLabel + ')');
    }
  }
});
