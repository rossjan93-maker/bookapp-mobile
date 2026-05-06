-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: user-managed custom shelves (Batch 4)
--
-- Adds two tables:
--   - user_shelves       — a named shelf owned by one user
--   - user_shelf_books   — membership rows joining a shelf to a user_book
--
-- Design notes:
--   - One book may belong to multiple shelves (no UNIQUE on user_book_id alone).
--   - Duplicate (shelf_id, user_book_id) entries are prevented by a UNIQUE
--     index so addBookToShelf can use upsert semantics safely.
--   - Deleting a shelf cascades shelf-membership rows but never touches
--     user_books — books survive shelf deletion.
--   - Deleting a user_book cascades its membership rows away (no orphans).
--   - sort_order is reserved for future drag-and-drop reordering; default 0
--     today, ordered by (sort_order, created_at) reads.
--   - RLS: every operation is restricted to auth.uid() = user_id. Membership
--     rows additionally inherit shelf ownership via the user_id column
--     (denormalised so RLS predicates stay single-table and fast).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.user_shelves (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null check (length(trim(name)) between 1 and 60),
  sort_order  integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One shelf name per user, case-insensitive. lower() index avoids citext dep.
create unique index if not exists user_shelves_user_name_lower_uniq
  on public.user_shelves (user_id, lower(name));

create index if not exists user_shelves_user_sort_idx
  on public.user_shelves (user_id, sort_order, created_at);

create table if not exists public.user_shelf_books (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  shelf_id      uuid        not null references public.user_shelves(id) on delete cascade,
  user_book_id  uuid        not null references public.user_books(id)   on delete cascade,
  created_at    timestamptz not null default now()
);

-- Prevent the same book being added twice to the same shelf.
create unique index if not exists user_shelf_books_shelf_book_uniq
  on public.user_shelf_books (shelf_id, user_book_id);

-- Lookup paths used by the app:
--   listShelfMembership(userId)  → (user_id) covering scan
--   shelf detail view            → (shelf_id)
--   per-book "which shelves?"    → (user_book_id)
create index if not exists user_shelf_books_user_idx
  on public.user_shelf_books (user_id);
create index if not exists user_shelf_books_user_book_idx
  on public.user_shelf_books (user_book_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.user_shelves       enable row level security;
alter table public.user_shelf_books   enable row level security;

-- user_shelves
drop policy if exists "users read own shelves"   on public.user_shelves;
drop policy if exists "users insert own shelves" on public.user_shelves;
drop policy if exists "users update own shelves" on public.user_shelves;
drop policy if exists "users delete own shelves" on public.user_shelves;

create policy "users read own shelves"
  on public.user_shelves for select
  using (auth.uid() = user_id);

create policy "users insert own shelves"
  on public.user_shelves for insert
  with check (auth.uid() = user_id);

create policy "users update own shelves"
  on public.user_shelves for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users delete own shelves"
  on public.user_shelves for delete
  using (auth.uid() = user_id);

-- user_shelf_books
drop policy if exists "users read own shelf books"   on public.user_shelf_books;
drop policy if exists "users insert own shelf books" on public.user_shelf_books;
drop policy if exists "users delete own shelf books" on public.user_shelf_books;

create policy "users read own shelf books"
  on public.user_shelf_books for select
  using (auth.uid() = user_id);

-- Insert/delete must additionally verify that the referenced shelf AND
-- user_book both belong to auth.uid(). RLS on the FK targets does NOT cascade
-- through references, so without these EXISTS checks a malicious client could
-- attach their own user_id to another user's shelf_id / user_book_id (a
-- broken-ownership / cross-tenant integrity hazard, not a direct read leak).
create policy "users insert own shelf books"
  on public.user_shelf_books for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_shelves s
      where s.id = user_shelf_books.shelf_id and s.user_id = auth.uid()
    )
    and exists (
      select 1 from public.user_books b
      where b.id = user_shelf_books.user_book_id and b.user_id = auth.uid()
    )
  );

create policy "users delete own shelf books"
  on public.user_shelf_books for delete
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_shelves s
      where s.id = user_shelf_books.shelf_id and s.user_id = auth.uid()
    )
    and exists (
      select 1 from public.user_books b
      where b.id = user_shelf_books.user_book_id and b.user_id = auth.uid()
    )
  );

-- updated_at trigger for user_shelves (rename / reorder)
create or replace function public._user_shelves_touch_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists user_shelves_touch_updated_at on public.user_shelves;
create trigger user_shelves_touch_updated_at
  before update on public.user_shelves
  for each row execute function public._user_shelves_touch_updated_at();
