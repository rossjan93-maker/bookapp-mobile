-- =============================================================================
-- Migration: P0.5 catalog protection — clarity + stricter classification
-- Created:   2026-05-09
-- =============================================================================
-- Refines the silent-revert trigger from 20260508000000 in two ways:
--
--   (1) FAIL-LOUD. The trigger now RAISEs on any forbidden write instead of
--       silently dropping the change. Silent reversion closed the abuse vector
--       but hid bugs (a successful 200 response could secretly mean "your patch
--       was thrown away") and made write semantics impossible to reason about
--       from the client.
--
--   (2) STRICTER CLASSIFICATION. The previous trigger protected only 5 columns
--       (title, author, external_id, cover_url, description). The remaining
--       9 catalog columns we now consider sensitive — isbn, isbn13,
--       publication_year, original_publication_year, additional_authors,
--       subjects, content_warnings, cover_source, metadata_confidence — could
--       all be freely rewritten by any authenticated user who had the book in
--       their library. The provider columns in particular (subjects /
--       content_warnings / cover_source / metadata_confidence) are read by
--       recommender + content-warning code paths shared across every user of
--       that books row, so a single rewrite could reshape the experience for
--       everyone. This migration extends trigger coverage to all 14 protected
--       columns (5 retained + 9 added).
--
-- Bypass semantics:
--   The trigger short-circuits when auth.uid() IS NULL — i.e. the request
--   reached the database with no end-user JWT context. This branch is taken
--   by: (a) service-role JWTs (no `sub` claim → auth.uid() returns NULL),
--   (b) direct DB sessions used by migrations / edge functions running as
--   the table owner, (c) anonymous PostgREST requests with no Authorization
--   header. Cases (a) and (b) are the trusted-write paths; case (c) is safe
--   because RLS on books UPDATE requires the row to belong to the caller's
--   library, so an anon UPDATE matches 0 rows and the trigger never fires.
--   The bypass therefore covers "no end-user context" rather than "service
--   role specifically," which is the correct narrowing for a BEFORE UPDATE
--   trigger that runs after RLS has already filtered the row set.
--
-- Field classification (books):
--   user-mutable (untouched by trigger; gated by RLS library-ownership only):
--     page_count
--   shared catalog identity (immutable post-insert):
--     title, author
--   identity / metadata backfill (NULL → non-NULL only):
--     external_id, cover_url, description, isbn, isbn13, publication_year,
--     original_publication_year, additional_authors
--   provider / trusted-write only (fill-empty enforced — empty array or NULL
--   counts as "empty" for array columns; NULL counts as "empty" for text):
--     subjects, content_warnings, cover_source, metadata_confidence
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
-- Empty-string handling for text columns: a string column is treated as
-- "empty" when its value is NULL or ''. This matters because Goodreads import
-- and some legacy CSV paths can persist '' rather than NULL when a field was
-- absent in the source row. Both NULL → set and '' → set are allowed for the
-- 8 fill-empty / provider-fill-empty text columns (external_id, cover_url,
-- description, isbn, isbn13, additional_authors, cover_source,
-- metadata_confidence). Array columns (subjects, content_warnings) treat NULL
-- and zero-cardinality arrays as empty.
--
-- Error contract for clients:
--   * SQLSTATE 42501 (insufficient_privilege)  → PostgREST returns HTTP 403.
--   * MESSAGE prefixed `CATALOG_PROTECTED:` so client code can identify the
--     failure mode without parsing free-form text.
--   * HINT carries the policy summary so logs are self-explanatory.
--
-- Reversibility:
--   Every change here is in-place via CREATE OR REPLACE FUNCTION. To roll back
--   to the silent-revert behaviour from 20260508000000, re-apply that file's
--   _books_protect_identity_columns() body and DROP TRIGGER … ; DROP FUNCTION
--   … for the two new tables (book_source_links, book_enrichment_cache).
--   No data is mutated by this migration.
-- =============================================================================


-- =============================================================================
-- A. books — fail-loud + stricter classification (14 protected columns)
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
  -- No end-user JWT context (service-role JWT, direct DB session run by
  -- migrations / edge functions, or unauthenticated request). Anon is safe
  -- here because RLS on books UPDATE requires library ownership and matches
  -- 0 rows for an anon caller before this trigger ever fires; service-role
  -- and DB-owner sessions are the trusted-write paths. See header for full
  -- bypass-semantics discussion.
  if auth.uid() is null then
    return new;
  end if;

  -- ── Immutable post-insert ────────────────────────────────────────────────
  if new.title is distinct from old.title then
    v_violations := v_violations || format(
      'title (immutable; current=%L attempted=%L)', old.title, new.title);
  end if;

  if new.author is distinct from old.author then
    v_violations := v_violations || format(
      'author (immutable; current=%L attempted=%L)', old.author, new.author);
  end if;

  -- ── Fill-if-empty (text columns): NULL or '' → non-empty allowed ─────────
  -- Goodreads import and legacy CSV paths can persist '' rather than NULL
  -- when a field was absent upstream, so '' counts as "empty" for fill-empty
  -- semantics. The check is `old.X is not null and old.X <> ''`.
  if old.external_id is not null and old.external_id <> ''
     and new.external_id is distinct from old.external_id then
    v_violations := v_violations || format(
      'external_id (fill-empty; current=%L attempted=%L)',
      old.external_id, new.external_id);
  end if;

  if old.cover_url is not null and old.cover_url <> ''
     and new.cover_url is distinct from old.cover_url then
    v_violations := v_violations || format(
      'cover_url (fill-empty; currently set, attempted change to %L)', new.cover_url);
  end if;

  if old.description is not null and old.description <> ''
     and new.description is distinct from old.description then
    v_violations := v_violations || format(
      'description (fill-empty; currently set with %s chars, attempted change)',
      length(old.description));
  end if;

  if old.isbn is not null and old.isbn <> ''
     and new.isbn is distinct from old.isbn then
    v_violations := v_violations || format(
      'isbn (fill-empty; current=%L attempted=%L)', old.isbn, new.isbn);
  end if;

  if old.isbn13 is not null and old.isbn13 <> ''
     and new.isbn13 is distinct from old.isbn13 then
    v_violations := v_violations || format(
      'isbn13 (fill-empty; current=%L attempted=%L)', old.isbn13, new.isbn13);
  end if;

  -- publication_year / original_publication_year are integers — no empty-string
  -- case applies; NULL is the only "empty" sentinel. Both year fields are
  -- written by Goodreads import (Year Published / Original Publication Year),
  -- both are catalog-shared, both fill-empty.
  if old.publication_year is not null
     and new.publication_year is distinct from old.publication_year then
    v_violations := v_violations || format(
      'publication_year (fill-empty; current=%L attempted=%L)',
      old.publication_year, new.publication_year);
  end if;

  if old.original_publication_year is not null
     and new.original_publication_year is distinct from old.original_publication_year then
    v_violations := v_violations || format(
      'original_publication_year (fill-empty; current=%L attempted=%L)',
      old.original_publication_year, new.original_publication_year);
  end if;

  if old.additional_authors is not null and old.additional_authors <> ''
     and new.additional_authors is distinct from old.additional_authors then
    v_violations := v_violations || format(
      'additional_authors (fill-empty; current=%L attempted=%L)',
      old.additional_authors, new.additional_authors);
  end if;

  -- ── Provider / trusted-write only (fill-empty for arrays + text) ─────────
  -- For array columns, "empty" means NULL OR cardinality = 0 — clients store
  -- []::text[] for content_warnings, so we have to treat both as empty.
  if old.subjects is not null
     and coalesce(array_length(old.subjects, 1), 0) > 0
     and new.subjects is distinct from old.subjects then
    v_violations := v_violations || format(
      'subjects (provider-only fill-empty; current has %s entries, attempted overwrite)',
      coalesce(array_length(old.subjects, 1), 0));
  end if;

  if old.content_warnings is not null
     and coalesce(array_length(old.content_warnings, 1), 0) > 0
     and new.content_warnings is distinct from old.content_warnings then
    v_violations := v_violations || format(
      'content_warnings (provider-only fill-empty; current has %s entries, attempted overwrite)',
      coalesce(array_length(old.content_warnings, 1), 0));
  end if;

  -- Text provider columns — '' counts as empty for the same reason as the
  -- fill-empty block above.
  if old.cover_source is not null and old.cover_source <> ''
     and new.cover_source is distinct from old.cover_source then
    v_violations := v_violations || format(
      'cover_source (provider-only fill-empty; current=%L attempted=%L)',
      old.cover_source, new.cover_source);
  end if;

  if old.metadata_confidence is not null and old.metadata_confidence <> ''
     and new.metadata_confidence is distinct from old.metadata_confidence then
    v_violations := v_violations || format(
      'metadata_confidence (provider-only fill-empty; current=%L attempted=%L)',
      old.metadata_confidence, new.metadata_confidence);
  end if;

  if array_length(v_violations, 1) is not null then
    raise exception
      'CATALOG_PROTECTED: cannot overwrite protected catalog column(s) on books.id=%; violations: %',
      old.id, array_to_string(v_violations, '; ')
      using errcode = '42501',
            hint = 'title and author are immutable post-insert. '
                || 'external_id, cover_url, description, isbn, isbn13, '
                || 'publication_year, original_publication_year, '
                || 'additional_authors are fill-if-empty. '
                || 'subjects, content_warnings, cover_source, metadata_confidence '
                || 'are provider-only fill-empty (NULL or empty allowed → set; '
                || 'overwriting an existing value requires a service-role write).';
  end if;

  return new;
end;
$$;

revoke all on function public._books_protect_identity_columns() from public;

drop trigger if exists books_protect_identity_columns on public.books;
create trigger books_protect_identity_columns
  before update on public.books
  for each row execute function public._books_protect_identity_columns();


-- =============================================================================
-- B. book_source_links — identity columns immutable post-insert
-- =============================================================================
-- (book_id, source) is the natural key used in upsert ON CONFLICT. Mutating
-- either column would silently corrupt the audit trail (the row would now
-- describe a different (book, source) pairing than the historical INSERT
-- captured). RLS already gates UPDATE on library ownership; this trigger
-- adds the column-immutability layer on top.

create or replace function public._book_source_links_protect_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No end-user JWT context — see books trigger for bypass discussion.
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
-- when a cache row is updated, its identity cannot drift.

create or replace function public._book_enrichment_cache_protect_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No end-user JWT context — see books trigger for bypass discussion.
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
