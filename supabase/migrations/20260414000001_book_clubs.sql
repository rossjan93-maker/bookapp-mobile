-- =============================================================================
-- Migration: Book Clubs (Phase 1)
-- Created:   2026-04-14
-- =============================================================================
-- Four new tables: book_clubs, book_club_members, book_club_books,
-- book_club_comments.
--
-- Constraints:
--   - Do NOT alter user_books, reading_sessions, or reading_progress_events.
--   - All new tables reference existing tables; never modify them.
--   - RLS enforced throughout.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type book_club_member_role as enum ('admin', 'member');
create type book_club_book_status as enum ('active', 'completed', 'cancelled');

-- ---------------------------------------------------------------------------
-- book_clubs
-- ---------------------------------------------------------------------------

create table book_clubs (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  description text,
  created_by  uuid        not null references profiles (id),
  created_at  timestamptz not null default now()
);

alter table book_clubs enable row level security;

-- ---------------------------------------------------------------------------
-- book_club_members
-- ---------------------------------------------------------------------------

create table book_club_members (
  id        uuid                   primary key default gen_random_uuid(),
  club_id   uuid                   not null references book_clubs (id) on delete cascade,
  user_id   uuid                   not null references profiles (id),
  role      book_club_member_role  not null default 'member',
  joined_at timestamptz            not null default now(),
  unique (club_id, user_id)
);

alter table book_club_members enable row level security;

create index idx_book_club_members_club_id on book_club_members (club_id);
create index idx_book_club_members_user_id on book_club_members (user_id);

-- ---------------------------------------------------------------------------
-- book_club_books
-- ---------------------------------------------------------------------------

create table book_club_books (
  id                 uuid                  primary key default gen_random_uuid(),
  club_id            uuid                  not null references book_clubs (id) on delete cascade,
  book_id            uuid                  not null references books (id),
  selected_by        uuid                  not null references profiles (id),
  total_pages        integer               not null,
  target_finish_date date,
  status             book_club_book_status not null default 'active',
  created_at         timestamptz           not null default now()
);

alter table book_club_books enable row level security;

-- Enforce one active book per club at the DB level.
create unique index idx_book_club_books_one_active
  on book_club_books (club_id)
  where (status = 'active');

create index idx_book_club_books_club_id on book_club_books (club_id);

-- Composite unique index needed so that book_club_comments can reference
-- (club_book_id, club_id) as a composite FK (PK alone is insufficient).
create unique index idx_book_club_books_id_club
  on book_club_books (id, club_id);

-- ---------------------------------------------------------------------------
-- book_club_comments
-- ---------------------------------------------------------------------------

create table book_club_comments (
  id             uuid        primary key default gen_random_uuid(),
  club_id        uuid        not null references book_clubs (id) on delete cascade,
  club_book_id   uuid        not null references book_club_books (id) on delete cascade,
  user_id        uuid        not null references profiles (id),
  body           text        not null,
  page_threshold integer     not null,
  created_at     timestamptz not null default now()
);

alter table book_club_comments enable row level security;

create index idx_book_club_comments_club_book_id on book_club_comments (club_book_id, created_at);

-- Composite FK: comment's (club_book_id, club_id) must match a real
-- book_club_books row whose club_id equals the comment's club_id.
-- Prevents cross-club comment/book_id mismatches.
alter table book_club_comments
  add constraint fk_book_club_comments_club_book_club
    foreign key (club_book_id, club_id)
    references book_club_books (id, club_id);

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

-- book_clubs: creator or members can read.
-- creator access is needed so that createClub() can read the inserted row
-- back via .insert().select().single() before the membership row is created.
create policy "book_clubs: creator or members can select"
  on book_clubs
  for select
  to authenticated
  using (
    auth.uid() = created_by
    or exists (
      select 1 from book_club_members bcm
      where bcm.club_id = book_clubs.id
        and bcm.user_id = auth.uid()
    )
  );

-- book_clubs: any authenticated user can create a club
create policy "book_clubs: authenticated users can insert"
  on book_clubs
  for insert
  to authenticated
  with check (auth.uid() = created_by);

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers (defined before RLS policies that reference them)
-- ---------------------------------------------------------------------------

-- is_club_member: returns true iff auth.uid() is a member of the given club.
-- Runs as function owner (postgres), bypassing book_club_members RLS.
-- Used in the book_club_members SELECT policy to let members see co-members
-- without a self-referential policy expression.
create or replace function is_club_member(p_club_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from book_club_members
    where club_id = p_club_id
      and user_id = auth.uid()
  );
$$;

grant execute on function is_club_member(uuid) to authenticated;

-- is_club_admin: returns true iff auth.uid() has role='admin' in the given club.
-- Runs as function owner (postgres), bypassing book_club_members RLS.
-- Used in the book_club_members INSERT policy to avoid self-referential queries.
create or replace function is_club_admin(p_club_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from book_club_members
    where club_id = p_club_id
      and user_id = auth.uid()
      and role = 'admin'
  );
$$;

grant execute on function is_club_admin(uuid) to authenticated;

-- book_club_members: members can read all membership rows for clubs they belong to.
-- Uses is_club_member() (SECURITY DEFINER) to check membership without
-- a self-referential policy expression that would risk RLS recursion.
-- This allows fetchMyClubs() to compute correct member counts and the
-- invite modal to check existing membership.
create policy "book_club_members: members can see co-members"
  on book_club_members
  for select
  to authenticated
  using (is_club_member(club_id));

-- book_club_members: insert policy — two tightly-scoped cases only:
--   1. Club creator bootstrapping their own admin membership (role must be 'admin',
--      user_id must be auth.uid(), and auth.uid() must be the club creator).
--   2. An existing admin inviting a user who is an accepted friend.
--      Case 2 uses is_club_admin() (SECURITY DEFINER) to avoid self-reference.
create policy "book_club_members: creator or admin can insert"
  on book_club_members
  for insert
  to authenticated
  with check (
    (
      -- Case 1: club creator bootstrapping their own admin membership.
      auth.uid() = user_id
      and role = 'admin'
      and exists (
        select 1 from book_clubs bc
        where bc.id = book_club_members.club_id
          and bc.created_by = auth.uid()
      )
    )
    or
    (
      -- Case 2: existing admin inviting a user who is an accepted friend.
      -- is_club_admin() is SECURITY DEFINER so avoids recursive RLS.
      is_club_admin(book_club_members.club_id)
      and exists (
        select 1 from friendships f
        where f.status = 'accepted'
          and (
            (f.requester_id = auth.uid() and f.addressee_id = book_club_members.user_id)
            or
            (f.requester_id = book_club_members.user_id and f.addressee_id = auth.uid())
          )
      )
    )
  );

-- book_club_books: members can read their club's books
create policy "book_club_books: members can select"
  on book_club_books
  for select
  to authenticated
  using (
    exists (
      select 1 from book_club_members bcm
      where bcm.club_id = book_club_books.club_id
        and bcm.user_id = auth.uid()
    )
  );

-- book_club_books: only admins can insert/update
create policy "book_club_books: admins can insert"
  on book_club_books
  for insert
  to authenticated
  with check (
    exists (
      select 1 from book_club_members bcm
      where bcm.club_id = book_club_books.club_id
        and bcm.user_id = auth.uid()
        and bcm.role = 'admin'
    )
  );

create policy "book_club_books: admins can update"
  on book_club_books
  for update
  to authenticated
  using (
    exists (
      select 1 from book_club_members bcm
      where bcm.club_id = book_club_books.club_id
        and bcm.user_id = auth.uid()
        and bcm.role = 'admin'
    )
  );

-- book_club_comments: members can read comments for their club's books
create policy "book_club_comments: members can select"
  on book_club_comments
  for select
  to authenticated
  using (
    exists (
      select 1 from book_club_members bcm
      where bcm.club_id = book_club_comments.club_id
        and bcm.user_id = auth.uid()
    )
  );

-- book_club_comments: members can post comments
create policy "book_club_comments: members can insert"
  on book_club_comments
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from book_club_members bcm
      where bcm.club_id = book_club_comments.club_id
        and bcm.user_id = auth.uid()
    )
  );

-- book_club_comments: only the author can delete their own comment
create policy "book_club_comments: author can delete"
  on book_club_comments
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Security-definer function: club_member_progress
-- ---------------------------------------------------------------------------
-- Returns each member's reading progress percentage for a given club book.
-- Runs as the function owner (postgres), bypassing user_books RLS which
-- prevents users from reading other members' current_page directly.
--
-- Security: the function verifies the calling user is a member of the club
-- before returning any data, so non-members receive an empty result set.
--
-- Returns: user_id, display_name, percent_complete (0–100, clamped).
-- Never returns raw page numbers — only percentages.

create or replace function club_member_progress(
  p_club_id    uuid,
  p_book_id    uuid,
  p_total_pages integer
)
returns table (
  user_id          uuid,
  username         text,
  first_name       text,
  last_name        text,
  percent_complete integer
)
language sql
security definer
stable
set search_path = public
as $$
  select
    bcm.user_id,
    p.username,
    p.first_name,
    p.last_name,
    case
      when p_total_pages > 0 then
        least(100, greatest(0,
          round((coalesce(ub.current_page, 0)::numeric / p_total_pages) * 100)
        ))
      else 0
    end::integer as percent_complete
  from book_club_members bcm
  join profiles p on p.id = bcm.user_id
  left join user_books ub
    on ub.user_id = bcm.user_id
   and ub.book_id = p_book_id
  where bcm.club_id = p_club_id
    -- security gate: the calling user must be a member of this club
    and exists (
      select 1 from book_club_members caller_check
      where caller_check.club_id = p_club_id
        and caller_check.user_id = auth.uid()
    );
$$;

-- Grant execute to authenticated role so Supabase RPC calls work.
grant execute on function club_member_progress(uuid, uuid, integer) to authenticated;
