-- =============================================================================
-- Migration: P1 Security Hardening (post-P0 / P0.5)
-- Created:   2026-05-10
-- =============================================================================
-- Adds the next batch of pre-beta security & abuse-resistance gates after
-- P0 (RLS + protected SELECT) and P0.5 (catalog write protection).
--
-- IDEMPOTENCY: This migration is fully re-runnable.
--   - All CHECK constraints are added inside DO blocks that check pg_constraint
--     first, so a re-run is a no-op (pg has no native ADD CONSTRAINT IF NOT EXISTS
--     across all supported versions).
--   - All policies use DROP POLICY IF EXISTS before CREATE POLICY.
--   - All triggers use DROP TRIGGER IF EXISTS before CREATE TRIGGER.
--   - All functions use CREATE OR REPLACE.
--   - book_club_comments constraint runs only if the table exists (older
--     Supabase projects may not have the 20260414 book_clubs migration applied).
--   - Preflight DO blocks RAISE if existing rows would violate a new constraint
--     instead of failing the constraint with an opaque error.
--
-- DATA SAFETY:
--   - No DROP TABLE, DELETE, TRUNCATE, ALTER COLUMN TYPE, or DROP COLUMN.
--   - The only DROP POLICY is for friendships INSERT (intentional; replaced by
--     the SECURITY DEFINER RPC, see section 4).
--
-- Five concerns addressed:
--
--   (1) Length CHECK constraints on user-generated text fields, so a single
--       row cannot create unbounded storage growth.
--         recommendations.note         <= 2000
--         user_books.review_body       <= 10000
--         user_books.private_note      <= 5000
--         book_club_comments.body      <= 2000  (only if table exists)
--       Limits chosen "conservative" via user_query.  Live preflight at
--       migration-author time: 0 non-empty rows in any of these columns.
--       Migration-time DO-block preflight re-checks live and raises if any
--       row would violate.
--
--   (2) current_page sanity:
--         a. CHECK current_page IS NULL OR current_page >= 0 (column-level).
--         b. BEFORE INSERT/UPDATE trigger that RAISES when
--            new.current_page > books.page_count (when both are known).
--            Fail-loud, consistent with P0.5.
--
--   (3) Friendships lifecycle DELETE policy.
--         Before this migration: NO delete policy → cancel/decline/unfriend
--         silently no-op'd in the existing FriendsSheet.tsx UI.  Real bug.
--         New DELETE policy: either party (requester OR addressee) can
--         DELETE any friendship row they're part of, regardless of status.
--
--   (4) Friend-request abuse guard.
--         New SECURITY DEFINER RPC public.send_friend_request(p_addressee_id)
--         enforces: no-self, addressee-exists, canonical-pair dedup, per-
--         requester pending cap of 50.  Direct INSERT on friendships is
--         REVOKED by dropping the existing INSERT policy.  RPC is the only
--         ingress (per user_query → "rpc_only").
--
--   (5) Catalog INSERT first-write minimal guardrail.
--         BEFORE INSERT trigger requires non-empty trimmed title AND author
--         on non-service-role inserts.  If external_id is provided, it must
--         be non-empty after trim (NULL still allowed because add-book ISBN-
--         miss fallback and goodreadsExecutor legitimately INSERT with NULL
--         external_id — populated later by metadataRepair).
--         Deferred to P1.5: external_id NOT NULL requirement, plausible-but-
--         bad first-writer detection, trusted catalog ingestion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Preflight: refuse to apply if any existing row would violate the new limits.
-- This is belt-and-braces — at migration-author time all four columns had 0
-- non-empty rows, but new rows could have been written between then and apply.
-- ---------------------------------------------------------------------------

do $$
declare
  v_count integer;
begin
  -- recommendations.note
  select count(*) into v_count from public.recommendations
   where note is not null and char_length(note) > 2000;
  if v_count > 0 then
    raise exception 'P1 PREFLIGHT FAIL: % recommendations.note row(s) exceed 2000 chars', v_count;
  end if;

  -- user_books.review_body
  select count(*) into v_count from public.user_books
   where review_body is not null and char_length(review_body) > 10000;
  if v_count > 0 then
    raise exception 'P1 PREFLIGHT FAIL: % user_books.review_body row(s) exceed 10000 chars', v_count;
  end if;

  -- user_books.private_note
  select count(*) into v_count from public.user_books
   where private_note is not null and char_length(private_note) > 5000;
  if v_count > 0 then
    raise exception 'P1 PREFLIGHT FAIL: % user_books.private_note row(s) exceed 5000 chars', v_count;
  end if;

  -- book_club_comments.body  (only if table exists)
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'book_club_comments'
  ) then
    execute 'select count(*) from public.book_club_comments where char_length(body) > 2000'
       into v_count;
    if v_count > 0 then
      raise exception 'P1 PREFLIGHT FAIL: % book_club_comments.body row(s) exceed 2000 chars', v_count;
    end if;
  end if;

  -- current_page sanity (negative)
  select count(*) into v_count from public.user_books
   where current_page is not null and current_page < 0;
  if v_count > 0 then
    raise exception 'P1 PREFLIGHT FAIL: % user_books.current_page row(s) are negative', v_count;
  end if;

  -- current_page sanity (exceeds page_count)
  select count(*) into v_count
    from public.user_books ub
    join public.books b on b.id = ub.book_id
   where ub.current_page is not null
     and b.page_count   is not null
     and ub.current_page > b.page_count;
  if v_count > 0 then
    raise exception 'P1 PREFLIGHT FAIL: % user_books row(s) have current_page > books.page_count', v_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (1) Text-field length CHECK constraints (idempotent)
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'recommendations_note_length'
  ) then
    alter table public.recommendations
      add constraint recommendations_note_length
      check (note is null or char_length(note) <= 2000);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_books_review_body_length'
  ) then
    alter table public.user_books
      add constraint user_books_review_body_length
      check (review_body is null or char_length(review_body) <= 10000);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_books_private_note_length'
  ) then
    alter table public.user_books
      add constraint user_books_private_note_length
      check (private_note is null or char_length(private_note) <= 5000);
  end if;
end $$;

-- book_club_comments.body — only if the table has been created
do $$ begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'book_club_comments'
  ) and not exists (
    select 1 from pg_constraint where conname = 'book_club_comments_body_length'
  ) then
    execute $sql$
      alter table public.book_club_comments
        add constraint book_club_comments_body_length
        check (char_length(body) <= 2000)
    $sql$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (2a) current_page non-negative CHECK (idempotent)
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_books_current_page_nonneg'
  ) then
    alter table public.user_books
      add constraint user_books_current_page_nonneg
      check (current_page is null or current_page >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (2b) current_page <= books.page_count trigger (fail-loud)
-- ---------------------------------------------------------------------------

create or replace function public._user_books_validate_current_page()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page_count integer;
begin
  if new.current_page is null then
    return new;
  end if;

  -- Trigger runs as definer so this read is not blocked by RLS on books.
  select page_count into v_page_count
    from public.books
   where id = new.book_id;

  if v_page_count is not null and new.current_page > v_page_count then
    raise exception
      'CURRENT_PAGE_EXCEEDS_PAGE_COUNT: current_page=% exceeds book.page_count=%',
      new.current_page, v_page_count
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_user_books_validate_current_page on public.user_books;
create trigger trg_user_books_validate_current_page
  before insert or update of current_page on public.user_books
  for each row
  execute function public._user_books_validate_current_page();

-- ---------------------------------------------------------------------------
-- (3) Friendships DELETE policy (idempotent)
-- ---------------------------------------------------------------------------
-- Either party (requester or addressee) can DELETE any row they belong to.
-- RLS ensures this matches 0 rows for any third-party caller, so DELETE
-- exposure is strictly self-relevant.

drop policy if exists "friendships: either party can delete" on public.friendships;
create policy "friendships: either party can delete"
  on public.friendships
  for delete
  to authenticated
  using (
    auth.uid() = requester_id or
    auth.uid() = addressee_id
  );

-- ---------------------------------------------------------------------------
-- (4) Friend-request abuse guard via SECURITY DEFINER RPC
-- ---------------------------------------------------------------------------

create or replace function public.send_friend_request(p_addressee_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_pending   integer;
  v_existing  uuid;
  v_row       public.friendships;
begin
  if v_uid is null then
    raise exception 'FRIEND_REQUEST_UNAUTHENTICATED' using errcode = '42501';
  end if;

  if p_addressee_id is null then
    raise exception 'FRIEND_REQUEST_INVALID_ADDRESSEE' using errcode = '22023';
  end if;

  if p_addressee_id = v_uid then
    raise exception 'FRIEND_REQUEST_SELF' using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles where id = p_addressee_id) then
    raise exception 'FRIEND_REQUEST_ADDRESSEE_NOT_FOUND' using errcode = '23503';
  end if;

  -- Canonical-pair dedup.  A row in either direction blocks a new request.
  select id into v_existing
    from public.friendships
   where (requester_id = v_uid and addressee_id = p_addressee_id)
      or (requester_id = p_addressee_id and addressee_id = v_uid);
  if v_existing is not null then
    raise exception 'FRIEND_REQUEST_DUPLICATE' using errcode = '23505';
  end if;

  -- Pending cap: 50 outbound pending per requester.
  select count(*) into v_pending
    from public.friendships
   where requester_id = v_uid
     and status = 'pending';
  if v_pending >= 50 then
    raise exception 'FRIEND_REQUEST_PENDING_CAP_EXCEEDED: max 50 pending requests'
      using errcode = '53400';
  end if;

  insert into public.friendships (requester_id, addressee_id, status)
  values (v_uid, p_addressee_id, 'pending')
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.send_friend_request(uuid) from public;
revoke all on function public.send_friend_request(uuid) from anon;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- Drop the existing INSERT policy so the RPC is the only ingress.
-- Original policy from 20260311000002_friendships_rls_policies.sql:
--   "friendships: users can insert as requester"
drop policy if exists "friendships: users can insert as requester" on public.friendships;

-- ---------------------------------------------------------------------------
-- (5) Books INSERT minimal guardrail (non-service-role only)
-- ---------------------------------------------------------------------------

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

  if new.external_id is not null and length(trim(new.external_id)) = 0 then
    raise exception 'BOOKS_INSERT_EXTERNAL_ID_BLANK' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_books_validate_insert on public.books;
create trigger trg_books_validate_insert
  before insert on public.books
  for each row
  execute function public._books_validate_insert();
