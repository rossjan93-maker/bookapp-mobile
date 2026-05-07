-- =============================================================================
-- Migration: P1 catalog protection — clarity refinement
-- Created:   2026-05-09
-- =============================================================================
-- Replaces the silent-revert trigger from 20260508000000 with a fail-loud
-- one that returns a clear PostgREST error when a client tries to overwrite
-- a protected catalog field. Silent reversion closed the abuse vector but
-- hid bugs and made the write model hard to reason about (a successful 200
-- response could secretly mean "your patch was thrown away"). The new trigger
-- raises exceptions with structured messages so call sites can observe what
-- happened.
--
-- Field classification (books):
--   user-mutable (untouched by trigger; gated by RLS library-ownership only):
--     page_count, subjects, content_warnings, cover_source,
--     metadata_confidence, isbn, isbn13, additional_authors, published_year,
--     plus any future column not listed below.
--   shared catalog identity (immutable post-insert):
--     title
--     author
--   identity backfill (NULL → non-NULL only):
--     external_id    Goodreads imports start NULL and get an OL works key
--                    during metadata repair.
--     cover_url      Fill-empty only — provider enrichment fills missing
--                    covers. Cover *upgrades* (non-null → different non-null)
--                    are intentionally rejected by this trigger; the only
--                    legitimate upgrade path was the dormant cover-upgrade
--                    branch in lib/metadataRepair.ts which was already
--                    silently broken under the previous silent-revert
--                    trigger and is filed as a follow-up.
--     description    Fill-empty only.
--
-- Field classification (book_source_links):
--   immutable post-insert: book_id, source     (ON CONFLICT natural key)
--   mutable by library owner via RLS:          source_book_id, raw_payload,
--                                              last_fetched_at, fetch_status
--
-- Field classification (book_enrichment_cache):
--   immutable post-insert: external_id          (PK / ON CONFLICT key)
--   mutable by library owner via RLS:           every other column
--
-- Service-role / superuser writes (auth.uid() IS NULL — migrations, edge
-- functions, the future payment webhook) bypass every check below.
--
-- Error contract for clients:
--   * SQLSTATE 42501 (insufficient_privilege)  → PostgREST returns HTTP 403.
--   * MESSAGE prefixed `CATALOG_PROTECTED:` so client code can identify the
--     failure mode without parsing free-form text.
--   * DETAIL/HINT carry diagnostic info (which column, current vs attempted).
-- =============================================================================


-- =============================================================================
-- A. books — replace silent-revert with fail-loud
-- =============================================================================

create or replace function public._books_protect_identity_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_violations text[] := array[]::text[];
begin
  -- Service-role / migration writes bypass the trigger entirely.
  if auth.uid() is null then
    return new;
  end if;

  -- title — immutable post-insert
  if new.title is distinct from old.title then
    v_violations := v_violations || format(
      'title (current=%L, attempted=%L)',
      old.title, new.title
    );
  end if;

  -- author — immutable post-insert
  if new.author is distinct from old.author then
    v_violations := v_violations || format(
      'author (current=%L, attempted=%L)',
      old.author, new.author
    );
  end if;

  -- external_id — NULL → non-NULL backfill allowed; any other change rejected
  if old.external_id is not null
     and new.external_id is distinct from old.external_id then
    v_violations := v_violations || format(
      'external_id (current=%L, attempted=%L)',
      old.external_id, new.external_id
    );
  end if;

  -- cover_url — fill-empty only
  if old.cover_url is not null
     and new.cover_url is distinct from old.cover_url then
    v_violations := v_violations || format(
      'cover_url (current is set, attempted change to %L)',
      new.cover_url
    );
  end if;

  -- description — fill-empty only
  if old.description is not null
     and new.description is distinct from old.description then
    v_violations := v_violations || 'description (current is set, attempted change)';
  end if;

  if array_length(v_violations, 1) is not null then
    raise exception
      'CATALOG_PROTECTED: cannot overwrite protected catalog column(s) on books.id=%; violations: %',
      old.id, array_to_string(v_violations, '; ')
      using errcode = '42501',
            hint = 'title and author are immutable post-insert. '
                || 'external_id, cover_url, and description are fill-if-empty '
                || '(NULL → non-NULL is allowed; non-NULL → different value is rejected). '
                || 'Provider enrichment must NOT overwrite a value that is already set. '
                || 'If a legitimate metadata replacement is required (e.g. a cover '
                || 'upgrade with stronger provenance), perform it via a service-role '
                || 'RPC, not a direct PATCH from the client.';
  end if;

  return new;
end;
$$;

revoke all on function public._books_protect_identity_columns() from public;

-- The trigger itself was created in 20260508000000_p0_security_hardening.sql
-- and points at this function — CREATE OR REPLACE FUNCTION above swaps the
-- behaviour in place. We re-assert the trigger here for idempotency in case
-- this migration is the only one ever applied to a fresh project.
drop trigger if exists books_protect_identity_columns on public.books;
create trigger books_protect_identity_columns
  before update on public.books
  for each row execute function public._books_protect_identity_columns();


-- =============================================================================
-- B. book_source_links — identity columns immutable post-insert
-- =============================================================================
-- (book_id, source) is the natural key used in upsert ON CONFLICT. Updating
-- either column would silently corrupt the audit trail (the row would now
-- describe a different (book, source) pairing than the historical INSERT
-- captured). RLS already gates UPDATE on library ownership; this trigger
-- adds the column-immutability layer.

create or replace function public._book_source_links_protect_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.book_id is distinct from old.book_id then
    raise exception
      'CATALOG_PROTECTED: book_source_links.book_id is immutable post-insert (id=%, current=%, attempted=%)',
      old.id, old.book_id, new.book_id
      using errcode = '42501',
            hint = 'book_id is part of the natural (book_id, source) key. '
                || 'To re-target the link to a different book, INSERT a new row.';
  end if;

  if new.source is distinct from old.source then
    raise exception
      'CATALOG_PROTECTED: book_source_links.source is immutable post-insert (id=%, current=%, attempted=%)',
      old.id, old.source, new.source
      using errcode = '42501',
            hint = 'source is part of the natural (book_id, source) key. '
                || 'To record a different provider, INSERT a new row.';
  end if;

  return new;
end;
$$;

revoke all on function public._book_source_links_protect_identity() from public;

drop trigger if exists book_source_links_protect_identity on public.book_source_links;
create trigger book_source_links_protect_identity
  before update on public.book_source_links
  for each row execute function public._book_source_links_protect_identity();


-- =============================================================================
-- C. book_enrichment_cache — identity column immutable post-insert
-- =============================================================================
-- external_id is the PK and the ON CONFLICT key for the cache upsert. RLS
-- already gates UPDATE on library ownership; this trigger ensures that even
-- if a row is updated, its identity cannot drift.

create or replace function public._book_enrichment_cache_protect_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.external_id is distinct from old.external_id then
    raise exception
      'CATALOG_PROTECTED: book_enrichment_cache.external_id is immutable post-insert (current=%, attempted=%)',
      old.external_id, new.external_id
      using errcode = '42501',
            hint = 'external_id is the primary key. To cache a different '
                || 'external_id, INSERT a new row.';
  end if;

  return new;
end;
$$;

revoke all on function public._book_enrichment_cache_protect_identity() from public;

drop trigger if exists book_enrichment_cache_protect_identity on public.book_enrichment_cache;
create trigger book_enrichment_cache_protect_identity
  before update on public.book_enrichment_cache
  for each row execute function public._book_enrichment_cache_protect_identity();
