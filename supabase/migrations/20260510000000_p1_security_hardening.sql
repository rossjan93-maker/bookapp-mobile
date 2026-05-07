-- =============================================================================
-- Migration: P1 Security Hardening (post-P0 / P0.5)
-- Created:   2026-05-10
-- =============================================================================
-- Adds the next batch of pre-beta security & abuse-resistance gates after
-- P0 (RLS + protected SELECT) and P0.5 (catalog write protection).
--
-- Five concerns addressed:
--
--   (1) Length CHECK constraints on user-generated text fields, so a single
--       row cannot create unbounded storage growth.
--
--         recommendations.note         <= 2000 chars
--         user_books.review_body       <= 10000 chars
--         user_books.private_note      <= 5000 chars
--         book_club_comments.body      <= 2000 chars
--
--       Limits chosen "conservative" — confirmed via user_query.  Live
--       preflight: 0 non-empty rows in any of these columns at migration
--       time, so no existing row violates the limits.
--
--   (2) current_page sanity:
--         a. CHECK current_page IS NULL OR current_page >= 0
--            (column-level, atomic, cheap).
--         b. BEFORE INSERT/UPDATE trigger that RAISES when
--            new.current_page > books.page_count (when both are known).
--            Fail-loud (consistent with P0.5 catalog protection).
--
--   (3) Friendships lifecycle DELETE policy.
--         Before this migration: NO delete policy existed → cancel /
--         decline / unfriend operations silently no-op'd.  This was a real
--         bug surfaced by audit; FriendsSheet.tsx already calls .delete()
--         in three places (cancel pending, decline received, unfriend
--         accepted), all of which couldn't succeed.
--         New DELETE policy: either party (requester or addressee) can
--         DELETE any friendship row they're part of, regardless of status.
--
--   (4) Friend-request abuse guard.
--         New SECURITY DEFINER RPC public.send_friend_request(addressee_id)
--         enforces:
--           - no self-requests
--           - addressee_id must reference an existing profile
--           - canonical pair dedup (uses the existing idx_friendships_pair)
--           - per-requester pending cap of 50 — friendly error on overflow
--         Direct INSERT on friendships is REVOKED from authenticated;
--         the RPC is the only ingress (per user_query → "rpc_only").
--
--   (5) Catalog INSERT first-write minimal guardrail.
--         Audited all 7 books-INSERT paths (RecommendationsFeed, Scan,
--         RecEntryScreen, add-book, saveBookFromRec, goodreadsExecutor,
--         and onboarding intake).  Two legitimate paths (add-book ISBN-miss
--         fallback, goodreadsExecutor bulk import) intentionally INSERT
--         with external_id NULL — populated later by metadataRepair.
--         Therefore an external_id NOT NULL requirement WOULD break
--         legitimate flows and is deferred to P1.5.
--
--         Mitigation that ships now (BEFORE INSERT trigger, non-service-role
--         only): require length(trim(title)) > 0 AND length(trim(author)) > 0
--         AND if external_id is provided it must be non-empty after trim.
--         Service-role bypass via auth.uid() IS NULL (consistent w/ P0.5).
--
--         Remaining deeper issue (NOT addressed here, P1.5 backlog):
--         even with these constraints, a malicious first writer can create
--         a plausible-but-bad row for a valid-looking external_id.  Fuller
--         fix is trusted catalog ingestion / provider validation /
--         low-confidence quarantine — explicitly out of scope per user
--         instruction.
--
-- Bypass semantics (where applicable):
--   All triggers short-circuit on auth.uid() IS NULL — i.e. service-role
--   connections, migrations, and edge functions running as table owner.
--   Anon writes are blocked upstream by RLS; the trigger never fires for
--   them because the RLS check matches 0 rows first.  Identical pattern to
--   the P0.5 catalog protection trigger.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (1) Text-field length CHECK constraints
-- ---------------------------------------------------------------------------

alter table public.recommendations
  add constraint recommendations_note_length
  check (note is null or char_length(note) <= 2000);

alter table public.user_books
  add constraint user_books_review_body_length
  check (review_body is null or char_length(review_body) <= 10000);

alter table public.user_books
  add constraint user_books_private_note_length
  check (private_note is null or char_length(private_note) <= 5000);

alter table public.book_club_comments
  add constraint book_club_comments_body_length
  check (char_length(body) <= 2000);

-- ---------------------------------------------------------------------------
-- (2a) current_page non-negative CHECK
-- ---------------------------------------------------------------------------

alter table public.user_books
  add constraint user_books_current_page_nonneg
  check (current_page is null or current_page >= 0);

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
  -- Only validate when the field is set
  if new.current_page is null then
    return new;
  end if;

  -- Look up the book's known page_count.  Trigger runs as definer so this
  -- read is not blocked by RLS on books.
  select page_count into v_page_count
    from public.books
   where id = new.book_id;

  if v_page_count is not null and new.current_page > v_page_count then
    raise exception
      'CURRENT_PAGE_EXCEEDS_PAGE_COUNT: current_page=% exceeds book.page_count=%',
      new.current_page, v_page_count
      using errcode = '23514';  -- check_violation
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
-- (3) Friendships DELETE policy
-- ---------------------------------------------------------------------------

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

-- Pending-request cap: a single requester may have at most 50 pending
-- outbound requests.  Beta-safe choice; revisit on usage data.
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

  -- Addressee must be a real profile
  if not exists (select 1 from public.profiles where id = p_addressee_id) then
    raise exception 'FRIEND_REQUEST_ADDRESSEE_NOT_FOUND' using errcode = '23503';
  end if;

  -- Canonical-pair dedup (matches the existing idx_friendships_pair).
  -- A row in either direction blocks a new request.
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
      using errcode = '53400';  -- configuration_limit_exceeded
  end if;

  insert into public.friendships (requester_id, addressee_id, status)
  values (v_uid, p_addressee_id, 'pending')
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.send_friend_request(uuid) from public;
grant execute on function public.send_friend_request(uuid) to authenticated;

-- Drop the existing INSERT policy so the RPC is the only ingress.
-- (Direct INSERT was previously allowed when auth.uid() = requester_id.)
drop policy if exists "friendships: users can insert as requester" on public.friendships;

-- ---------------------------------------------------------------------------
-- (5) Books INSERT minimal guardrail (non-service-role only)
-- ---------------------------------------------------------------------------
-- Narrow scope (per user_query): require non-empty title/author and (if
-- provided) non-empty external_id.  Service-role inserts (auth.uid() IS NULL)
-- bypass — preserves migrations, edge functions, maintenance scripts.
--
-- Does NOT require external_id NOT NULL — would break add-book ISBN fallback
-- and goodreadsExecutor bulk import.  Documented as P1.5 backlog.

create or replace function public._books_validate_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service-role bypass (no end-user JWT context)
  if auth.uid() is null then
    return new;
  end if;

  if new.title is null or length(trim(new.title)) = 0 then
    raise exception 'BOOKS_INSERT_TITLE_REQUIRED'
      using errcode = '23514';
  end if;

  if new.author is null or length(trim(new.author)) = 0 then
    raise exception 'BOOKS_INSERT_AUTHOR_REQUIRED'
      using errcode = '23514';
  end if;

  if new.external_id is not null and length(trim(new.external_id)) = 0 then
    raise exception 'BOOKS_INSERT_EXTERNAL_ID_BLANK'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_books_validate_insert on public.books;
create trigger trg_books_validate_insert
  before insert on public.books
  for each row
  execute function public._books_validate_insert();
