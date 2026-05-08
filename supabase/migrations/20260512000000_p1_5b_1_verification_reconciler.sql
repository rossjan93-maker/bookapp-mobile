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
-- No policies → only service-role / SECURITY DEFINER functions can touch it.

create or replace function public.verify_books_batch_acquire_lock(p_actor text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int;
begin
  insert into public.verify_books_batch_lock (singleton, held_by)
  values (true, p_actor)
  on conflict (singleton) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

create or replace function public.verify_books_batch_release_lock()
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

create or replace function public.verify_books_batch_force_release_lock()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  -- Identical body to release_lock today, but kept as a separate name
  -- so the runbook + audit logs can distinguish operator-forced releases
  -- from normal end-of-run releases.
  delete from public.verify_books_batch_lock where singleton = true;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.verify_books_batch_acquire_lock(text)        from public, anon, authenticated;
revoke all on function public.verify_books_batch_release_lock()            from public, anon, authenticated;
revoke all on function public.verify_books_batch_force_release_lock()      from public, anon, authenticated;
