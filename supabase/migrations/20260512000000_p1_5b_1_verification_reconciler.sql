-- =============================================================================
-- Migration: P1.5b-1 — Verification Reconciler (server-side trusted ingest, read-only client impact)
-- Created:   2026-05-12
-- =============================================================================
-- Adds the server-side scaffolding for trusted catalog verification. NO client
-- code changes accompany this migration. Client INSERT paths continue to land
-- rows as 'unverified' per P1.5a; this migration makes those rows reachable
-- by an out-of-band reconciler that flips them to 'verified' (or keeps them
-- 'unverified' with backoff) using high-confidence provider lookups.
--
-- Scope (from the approved P1.5b-1 plan):
--   1. Extend public.books with verification metadata:
--        - last_verification_attempt_at  (every reconciler attempt timestamp)
--        - provider_verified_at          (set ONLY on successful verification)
--        - verification_attempt_count    (failure count; success leaves alone)
--        - last_verification_error       (set on failure, cleared on success)
--        - canonical_provider            (set ONLY on successful verification)
--   2. Partial index for the reconciler's batch query (oldest-attempted first;
--      excludes verified rows and permanently-failed rows by predicate).
--   3. Append-only public.provider_lookup_log table with 90-day retention
--      (RLS enabled, no policies → service-role-only access).
--   4. public.purge_provider_lookup_log() function callable by service-role
--      only (invoked daily by a separate dashboard scheduled trigger).
--
-- Out of scope (deferred to later P1.5b sub-batches):
--   - upsert-book-from-provider Edge Function                       (P1.5b-2)
--   - Client insert-path migration (add-book/scan/recs/onboarding)  (P1.5b-3)
--   - Cross-user filtering for 'unverified' rows                    (P1.5b-4)
--   - Title+author phase-3 auto-verification                        (future)
--   - Manual-entry table split (user_book_custom_entries)           (P2)
--
-- Column model legibility (the explicit reason last_verification_attempt_at
-- and provider_verified_at are TWO columns, not one dual-use timestamp):
--   never attempted        → last_verification_attempt_at IS NULL
--   attempted, not verified → state != 'verified' AND last_verification_attempt_at IS NOT NULL
--   verified at <when>      → provider_verified_at IS NOT NULL
--   in failure backoff      → state != 'verified' AND verification_attempt_count > 0
--   permanent failure       → verification_attempt_count >= 5
--
-- IDEMPOTENCY: Fully re-runnable.
--   - ADD COLUMN IF NOT EXISTS for all five new columns.
--   - CHECK constraint guarded by pg_constraint lookup.
--   - CREATE INDEX IF NOT EXISTS / CREATE TABLE IF NOT EXISTS throughout.
--   - CREATE OR REPLACE FUNCTION for purge function.
--
-- DATA SAFETY:
--   - No DROP TABLE, DELETE, TRUNCATE, ALTER COLUMN TYPE, or DROP COLUMN.
--   - All adds are new columns / new index / new table / new function.
--   - The purge function only deletes provider_lookup_log rows older than
--     90 days; never touches books or any other table.
--
-- INTERACTION WITH P0.5 CATALOG PROTECTION:
--   The reconciler runs as service-role (auth.uid() IS NULL inside the Edge
--   Function's adminClient). The P0.5 BEFORE UPDATE trigger
--   _books_protect_identity_columns() bypasses on auth.uid() IS NULL, so the
--   reconciler can write any books column. Application-layer policy (in the
--   Edge Function code, not in SQL) enforces the actual fill-empty / longer-
--   wins rules — the SQL just doesn't get in the way.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- (1) Add verification metadata columns to public.books (idempotent)
-- ---------------------------------------------------------------------------

alter table public.books
  add column if not exists last_verification_attempt_at timestamptz;

alter table public.books
  add column if not exists provider_verified_at timestamptz;

alter table public.books
  add column if not exists verification_attempt_count int not null default 0;

alter table public.books
  add column if not exists last_verification_error text;

alter table public.books
  add column if not exists canonical_provider text;

-- ---------------------------------------------------------------------------
-- (2) CHECK constraint on canonical_provider (idempotent)
-- ---------------------------------------------------------------------------

do $$ begin
  -- Table-qualified lookup avoids accidental name collisions if a
  -- similarly-named constraint is later added on a different table.
  if not exists (
    select 1 from pg_constraint
     where conname = 'books_canonical_provider_check'
       and conrelid = 'public.books'::regclass
  ) then
    alter table public.books
      add constraint books_canonical_provider_check
      check (canonical_provider is null
             or canonical_provider in ('open_library', 'google_books'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'books_last_verification_error_length_check'
       and conrelid = 'public.books'::regclass
  ) then
    -- Defense-in-depth: the Edge Function also truncates to 500 before
    -- writing. Mirror the cap on provider_lookup_log.error_detail so
    -- both audit surfaces share the same bound.
    alter table public.books
      add constraint books_last_verification_error_length_check
      check (last_verification_error is null
             or length(last_verification_error) <= 500);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (3) Partial index for the reconciler batch query
-- ---------------------------------------------------------------------------
-- Optimizes the reconciler's primary access path:
--   SELECT ... FROM books
--   WHERE provenance_state IN ('unverified','legacy')
--     AND verification_attempt_count < 5
--     AND (last_verification_attempt_at IS NULL
--          OR last_verification_attempt_at < now() - <backoff>)
--   ORDER BY verification_attempt_count ASC,
--            last_verification_attempt_at ASC NULLS FIRST
-- The predicate keeps the index small (only rows that could ever be
-- selected) and the leading column matches the ORDER BY.

create index if not exists books_verification_due_idx
  on public.books (verification_attempt_count, last_verification_attempt_at nulls first)
  where provenance_state in ('unverified', 'legacy')
    and verification_attempt_count < 5;

-- ---------------------------------------------------------------------------
-- (4) provider_lookup_log — append-only audit trail
-- ---------------------------------------------------------------------------
-- Captures every reconciler provider lookup outcome. Used for:
--   - debugging persistent verification failures
--   - measuring cache hit rate and provider success rate
--   - measuring provider conflict rate (OL vs GB disagreement)
--   - rate-limit / latency dashboards (week-1 ops review)
--
-- 90-day retention enforced by purge_provider_lookup_log() (run daily via
-- a separate dashboard scheduled trigger; setup documented in
-- docs/p1_5b_1_reconciler_runbook.md).
--
-- Locked-down access: RLS enabled with NO policies → only service-role can
-- read/write. The reconciler Edge Function uses service-role to write.
-- Operators query via the Supabase SQL editor (which uses service-role too).

create table if not exists public.provider_lookup_log (
  id              bigserial primary key,
  occurred_at     timestamptz not null default now(),
  provider        text        not null
    check (provider in ('open_library', 'google_books')),
  lookup_kind     text        not null
    check (lookup_kind in ('works_key', 'isbn', 'isbn13', 'volume_id')),
  identifier      text        not null,
  book_id         uuid        references public.books(id) on delete set null,
  status          text        not null
    check (status in (
      'cache_hit', 'success', 'not_found',
      'rate_limited', 'provider_error', 'timeout', 'conflict'
    )),
  latency_ms      int,
  http_status     int,
  error_detail    text        check (error_detail is null or length(error_detail) <= 500),
  conflict_field  text        check (conflict_field is null or length(conflict_field) <= 64)
);

create index if not exists provider_lookup_log_occurred_idx
  on public.provider_lookup_log (occurred_at desc);

create index if not exists provider_lookup_log_book_idx
  on public.provider_lookup_log (book_id)
  where book_id is not null;

alter table public.provider_lookup_log enable row level security;

-- Explicitly revoke default privileges from public roles.
-- No SELECT/INSERT/UPDATE/DELETE policies are created, so RLS denies all
-- access to anon/authenticated. Service-role bypasses RLS entirely.
revoke all on public.provider_lookup_log from anon, authenticated;
revoke all on sequence public.provider_lookup_log_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- (5) purge_provider_lookup_log() — 90-day retention
-- ---------------------------------------------------------------------------
-- Called daily by a Supabase dashboard scheduled trigger (separate from the
-- reconciler trigger; see runbook). Returns the number of rows deleted so
-- the trigger output is meaningful.
--
-- SECURITY DEFINER + revoke-from-public means the function executes with
-- the migration owner's privileges and is only callable by service-role
-- (because we revoke EXECUTE from anon/authenticated/public).

create or replace function public.purge_provider_lookup_log()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from public.provider_lookup_log
   where occurred_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_provider_lookup_log() from public;
revoke all on function public.purge_provider_lookup_log() from anon, authenticated;
grant execute on function public.purge_provider_lookup_log() to service_role;

-- ---------------------------------------------------------------------------
-- (6) Advisory lock RPC wrappers for the verify-books-batch Edge Function
-- ---------------------------------------------------------------------------
-- pg_try_advisory_lock() and pg_advisory_unlock() are built-in Postgres
-- functions, but PostgREST does NOT expose built-ins via /rest/v1/rpc by
-- default — only functions in the exposed schema (public). The Edge Function
-- needs explicit SECURITY DEFINER wrappers to acquire / release the lock
-- across its HTTP request lifetime.
--
-- IMPORTANT: PostgREST opens a fresh DB session per request. Session-scoped
-- advisory locks (pg_try_advisory_lock / pg_advisory_unlock) only live for
-- the duration of that session. Because the Edge Function makes the lock
-- and unlock calls in TWO separate HTTP requests, session-scoped locks
-- would auto-release after the lock call returns — defeating the purpose.
--
-- We therefore use a small public.verify_books_batch_lock table as an
-- explicit lock primitive: a single-row table where the row's presence
-- means "a run is in progress." The acquire RPC uses INSERT ... ON CONFLICT
-- DO NOTHING and reports whether it acquired; the release RPC DELETEs the
-- row. Both run as SECURITY DEFINER so the Edge Function can call them
-- without granting wide privileges to the service-role-backed RPC layer
-- (defense-in-depth — service-role already bypasses RLS).
--
-- The held_at timestamp lets ops detect a stuck lock (crashed Edge run)
-- and force-release it; the runbook documents the recovery procedure.

create table if not exists public.verify_books_batch_lock (
  singleton  boolean primary key default true check (singleton = true),
  held_at    timestamptz not null default now(),
  held_by    text                                   -- free-text actor label for ops debugging
);

alter table public.verify_books_batch_lock enable row level security;
revoke all on public.verify_books_batch_lock from anon, authenticated;
-- No policies → anon/authenticated denied. service_role bypasses RLS and
-- retains the default Supabase grants on public.* tables, which is what
-- the harness uses to inspect the lock row directly. The SECURITY DEFINER
-- RPCs above are the production access path.

-- Stale-lock threshold: a lock older than this is considered abandoned
-- (Edge run crashed before its `finally` could release). 30 minutes is a
-- conservative ceiling — a healthy batch with limit=500 takes far less
-- (mostly bounded by the 5s-per-provider-call * worst case ~2 calls/row,
-- so ~5000s only if every single row is a worst-case timeout, which the
-- rate limiter prevents). Bumping past 30m would mean a real stuck lock
-- delays the next scheduled run by that long.
create or replace function public.verify_books_batch_acquire_lock(p_actor text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale_threshold constant interval := interval '30 minutes';
  v_existing_held_at timestamptz;
  v_existing_held_by text;
  v_inserted int;
begin
  -- Step 1: opportunistic stale-lock takeover. If a lock row exists and
  -- its held_at is older than the threshold, delete it FIRST so the
  -- subsequent INSERT can land. The DELETE is filtered by held_at so a
  -- fresh lock from a peer invocation is never disturbed.
  select held_at, held_by
    into v_existing_held_at, v_existing_held_by
    from public.verify_books_batch_lock
   where singleton = true;

  if v_existing_held_at is not null
     and v_existing_held_at < (now() - v_stale_threshold) then
    -- Log the takeover to the application log via RAISE NOTICE; ops can
    -- grep this in Postgres logs if a stale takeover ever happens.
    raise notice 'verify_books_batch_acquire_lock: stale lock takeover (held_by=% held_at=%)',
      v_existing_held_by, v_existing_held_at;
    delete from public.verify_books_batch_lock
     where singleton = true
       and held_at < (now() - v_stale_threshold);
  end if;

  -- Step 2: normal acquire path. ON CONFLICT DO NOTHING means a fresh
  -- lock from a peer (held_at within the threshold) wins and we report
  -- false. The stale takeover above already cleared truly-abandoned rows.
  insert into public.verify_books_batch_lock (singleton, held_by)
  values (true, p_actor)
  on conflict (singleton) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

-- Drop the legacy zero-arg release function if a previous draft of this
-- migration shipped it. Postgres treats verify_books_batch_release_lock()
-- and verify_books_batch_release_lock(text) as two distinct overloaded
-- functions, so a CREATE OR REPLACE on the new signature would NOT remove
-- the old one — leaving an unconditional DELETE callable by service-role
-- and reintroducing the clobber-fresh-peer-lock race we just closed.
-- Idempotent: no-op on a clean DB where the zero-arg version was never
-- created (e.g. fresh projects), and a clean drop on environments that
-- ran an earlier draft of this migration.
drop function if exists public.verify_books_batch_release_lock();

-- Actor-aware release.
--
-- Why this is not unconditional: with the 30-minute stale-lock takeover in
-- acquire_lock, a long-running Run A can have its lock taken over by Run B
-- after the threshold. If Run A then finally reaches its finally{} block,
-- an unconditional DELETE would clobber Run B's fresh, healthy lock — and
-- a third Run C that arrives moments later would acquire on top of B,
-- defeating overlap protection entirely.
--
-- The fix: scope the DELETE to the caller's own actor label. Run A's
-- release is now a no-op (returns false) once Run B has taken over. The
-- Edge Function logs that false as a non-fatal warning; ops sees the
-- earlier RAISE NOTICE from acquire_lock if they need to investigate.
--
-- For operator-driven recovery (e.g. an actor label was lost in logs),
-- verify_books_batch_force_release_lock() below remains unconditional.
create or replace function public.verify_books_batch_release_lock(p_actor text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  if p_actor is null then
    -- Refuse silently-broken callers: a NULL actor would match the
    -- default-NULL held_by column and let any caller delete any lock.
    raise exception 'verify_books_batch_release_lock: p_actor must not be null'
      using errcode = '22023';
  end if;
  delete from public.verify_books_batch_lock
   where singleton = true
     and held_by = p_actor;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

-- Operator-only unconditional release. Distinct from release_lock(p_actor)
-- specifically so that:
--   (a) end-of-run releases cannot accidentally clobber a fresh peer lock
--       (they go through release_lock(p_actor) which is actor-scoped), and
--   (b) operator recovery (lost actor label / wedged state) has a single
--       documented escape hatch with a distinct name in audit logs.
create or replace function public.verify_books_batch_force_release_lock()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from public.verify_books_batch_lock where singleton = true;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

-- Lock down EXECUTE then explicitly grant to service_role.
-- RLS bypass for service_role does NOT imply function EXECUTE permission;
-- they are separate privilege systems. Without these GRANTs the Edge
-- Function's admin.rpc(...) calls would fail with `permission denied for function`.
revoke all on function public.verify_books_batch_acquire_lock(text)        from public, anon, authenticated;
revoke all on function public.verify_books_batch_release_lock(text)        from public, anon, authenticated;
revoke all on function public.verify_books_batch_force_release_lock()      from public, anon, authenticated;

grant execute on function public.verify_books_batch_acquire_lock(text)        to service_role;
grant execute on function public.verify_books_batch_release_lock(text)        to service_role;
grant execute on function public.verify_books_batch_force_release_lock()      to service_role;
