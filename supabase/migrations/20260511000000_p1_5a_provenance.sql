-- =============================================================================
-- Migration: P1.5a — Catalog Provenance (audit trail + quarantine flag)
-- Created:   2026-05-11
-- =============================================================================
-- Adds the smallest-safe step toward P1.5 (trusted catalog ingestion) without
-- changing client behavior or breaking add-book / Goodreads import / scan /
-- recommendations / metadataRepair. Closes one concrete dedup hole and lays
-- the groundwork for P1.5b (server-side provider-backed upsert + verification).
--
-- Scope (from the approved P1.5a plan):
--   1. Add books.provenance_state ('legacy' | 'unverified' | 'verified')
--   2. Add books.provenance_inserted_by (uuid → auth.users.id, NULL for
--      service-role / pre-existing rows)
--   3. Backfill ALL existing rows to 'legacy' (NOT 'verified' — we are not
--      pretending old rows were truly provider-verified; 'legacy' is honest
--      and grandfathers them in for dedup purposes)
--   4. BEFORE INSERT trigger:
--        - non-service-role inserts are forced to provenance_state='unverified'
--          and provenance_inserted_by=auth.uid()
--        - service-role / definer writes (auth.uid() IS NULL) may set the
--          fields explicitly (e.g. a future provider-backed RPC writes
--          'verified')
--   5. Extend the existing P1 _books_validate_insert with lightweight
--      external_id format validation: when external_id is provided it must
--      look like one of the recognized identifiers:
--        - /works/OL<digits>W   (Open Library works key — primary canonical)
--        - gb:<volume_id>       (Google Books — convention used by recommender,
--                                scan, save-from-rec)
--        - gb_<volume_id>       (Google Books — convention used by onboarding
--                                anchor book; inconsistency with `gb:` is
--                                ACCEPTED in P1.5a, deferred to P1.5b /
--                                metadata-identity cleanup)
--      Blank external_id (when provided) is already rejected by P1; keep that.
--      NULL external_id is still allowed (Goodreads import + add-book manual
--      fallback both depend on it).
--
-- Out of scope (deferred to P1.5b):
--   - Server-side OL/GB lookup (edge function or pg_net)
--   - Trusted upsert_book_from_provider RPC
--   - Cross-user surface filtering on 'unverified'
--   - Verification job that flips 'unverified' → 'verified'
--   - Splitting manual entries into a separate user_book_custom_entries table
--   - Normalizing the gb_ vs gb: prefix inconsistency
--
-- IDEMPOTENCY: Fully re-runnable.
--   - ADD COLUMN IF NOT EXISTS for both new columns.
--   - CHECK constraint guarded by pg_constraint lookup.
--   - Backfill is conditional: only fires for rows still at the column default
--     with NULL provenance_inserted_by (so a re-run after new INSERTs lands
--     since the new INSERTs will already have the correct values).
--   - CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS for both triggers.
--
-- DATA SAFETY:
--   - No DROP TABLE, DELETE, TRUNCATE, ALTER COLUMN TYPE, or DROP COLUMN.
--   - The backfill is a single UPDATE that only touches rows with NULL
--     provenance_inserted_by AND provenance_state = 'unverified' (i.e. rows
--     that have not yet been touched by either a new INSERT trigger fire or
--     a prior partial run of this migration).
--
-- CLIENT-SIDE COMPANION (not in this migration):
--   lib/goodreadsExecutor.ts — the title+author dedup lookup is filtered to
--   rows where provenance_state IN ('verified','legacy') OR
--   provenance_inserted_by = current user. This prevents a malicious manual
--   entry from user A from being absorbed as the canonical row for user B's
--   Goodreads import. Diff is delivered alongside this migration.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- (1) Add columns (idempotent)
-- ---------------------------------------------------------------------------

alter table public.books
  add column if not exists provenance_state text not null default 'unverified';

alter table public.books
  add column if not exists provenance_inserted_by uuid
    references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- (2) CHECK constraint on provenance_state (idempotent)
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'books_provenance_state_check'
  ) then
    alter table public.books
      add constraint books_provenance_state_check
      check (provenance_state in ('legacy', 'unverified', 'verified'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (3) Backfill existing rows to 'legacy'
-- ---------------------------------------------------------------------------
-- Honest grandfathering: pre-existing rows are NOT marked 'verified' (we have
-- no proof they were actually provider-verified). They are marked 'legacy' so
-- the Goodreads dedup filter can still match them while distinguishing them
-- from rows the trusted-write path will produce in P1.5b.
--
-- Only update rows that still look "fresh" (default 'unverified' + NULL
-- inserted_by) — this makes the migration safe to re-run without clobbering
-- rows that have since been INSERTed by the new trigger (which sets
-- 'unverified' + a non-NULL inserted_by).

update public.books
   set provenance_state = 'legacy'
 where provenance_state = 'unverified'
   and provenance_inserted_by is null;

-- ---------------------------------------------------------------------------
-- (4) BEFORE INSERT trigger: force provenance fields for non-service-role
-- ---------------------------------------------------------------------------
-- Bypass semantics match P0.5 / P1: when auth.uid() IS NULL, the caller has
-- no end-user JWT context (service-role JWT, direct DB session, edge function
-- as table owner, or anon — anon is safe because RLS on books INSERT requires
-- the user to be authenticated). The non-bypass path overrides whatever the
-- client supplied: provenance_state := 'unverified' and provenance_inserted_by
-- := auth.uid(). This means the client cannot lie about provenance — it is
-- always set by the trigger from the JWT.
--
-- Service-role writes MAY set provenance_state explicitly (e.g. the future
-- provider-backed RPC will write 'verified'). When auth.uid() IS NULL we leave
-- the supplied values alone, so the column default ('unverified') still
-- applies if the trusted caller didn't override.

create or replace function public._books_set_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    -- Trusted-write path. Caller controls provenance_state + inserted_by.
    -- (column default 'unverified' applies if not specified)
    return new;
  end if;

  -- Untrusted client write. Force the provenance fields regardless of input.
  new.provenance_state       := 'unverified';
  new.provenance_inserted_by := auth.uid();

  return new;
end;
$$;

revoke all on function public._books_set_provenance() from public;

-- Name chosen so it fires BEFORE trg_books_validate_insert alphabetically.
drop trigger if exists trg_books_set_provenance on public.books;
create trigger trg_books_set_provenance
  before insert on public.books
  for each row
  execute function public._books_set_provenance();

-- ---------------------------------------------------------------------------
-- (5) Extend P1's _books_validate_insert with external_id format validation
-- ---------------------------------------------------------------------------
-- Replaces the P1 body. Keeps the existing three rules (title required,
-- author required, blank external_id rejected) and adds a fourth: when
-- external_id is provided AND the caller is non-service-role, it must match
-- one of the recognized identifier shapes. NULL is still allowed.
--
-- The shape allowlist is intentionally loose (prefix + permissive body) so
-- that legitimate variations (e.g. /works/OL12345W with optional trailing
-- characters that some OL endpoints emit) are not over-rejected. The goal is
-- to block obviously crafted external_ids ("admin", "../etc/passwd", "<script>"),
-- not to fully validate provider-format correctness.

create or replace function public._books_validate_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service-role / definer bypass (no end-user JWT context).
  if auth.uid() is null then
    return new;
  end if;

  if new.title is null or length(trim(new.title)) = 0 then
    raise exception 'BOOKS_INSERT_TITLE_REQUIRED' using errcode = '23514';
  end if;

  if new.author is null or length(trim(new.author)) = 0 then
    raise exception 'BOOKS_INSERT_AUTHOR_REQUIRED' using errcode = '23514';
  end if;

  if new.external_id is not null then
    if length(trim(new.external_id)) = 0 then
      raise exception 'BOOKS_INSERT_EXTERNAL_ID_BLANK' using errcode = '23514';
    end if;

    -- Lightweight format allowlist. See header for rationale.
    -- All three patterns are fully anchored ($) so a recognized prefix cannot
    -- be used to smuggle additional content (e.g. /works/OL1W<script> would
    -- match a prefix-only regex). Anchoring is the cheap part of safety.
    --   /works/OL<digits>W   — Open Library works key (canonical clean form)
    --   gb:<volume_id>       — Google Books (recommender / scan / save-from-rec)
    --   gb_<volume_id>       — Google Books (onboarding anchor book; the
    --                          gb_ vs gb: inconsistency is documented in
    --                          replit.md and deferred to P1.5b)
    if new.external_id !~ '^/works/OL[0-9]+W$' and
       new.external_id !~ '^gb:[A-Za-z0-9_-]+$' and
       new.external_id !~ '^gb_[A-Za-z0-9_-]+$' then
      raise exception
        'BOOKS_INSERT_EXTERNAL_ID_FORMAT: external_id=%L does not match any recognized provider shape',
        new.external_id
        using errcode = '23514',
              hint = 'Expected one of: /works/OL<digits>W, gb:<id>, or gb_<id>. '
                  || 'NULL external_id is allowed for manual entries and '
                  || 'Goodreads imports prior to metadata repair.';
    end if;
  end if;

  return new;
end;
$$;

-- Trigger registration unchanged (already created in P1) — but re-create
-- defensively in case of out-of-order migration apply.
drop trigger if exists trg_books_validate_insert on public.books;
create trigger trg_books_validate_insert
  before insert on public.books
  for each row
  execute function public._books_validate_insert();
