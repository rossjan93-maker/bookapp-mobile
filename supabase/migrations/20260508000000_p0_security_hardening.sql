-- =============================================================================
-- Migration: P0 Pre-beta security hardening
-- Created:   2026-05-08
-- =============================================================================
-- Closes the highest-severity findings from the pre-beta security audit:
--   A. Catalog defacement vector — books / book_enrichment_cache /
--      book_source_links were world-writeable for any authenticated user with
--      the book in their library (or, for the cache, for any authenticated
--      user at all).  This migration narrows update privileges so a malicious
--      user cannot rewrite shared metadata that everyone else sees.
--   B. Profile PII enumeration — `profiles` SELECT was open to every
--      authenticated user, exposing username + first/last name + reading goal
--      + onboarding status for everyone with an account.  This migration
--      restricts SELECT to self + accepted friends, and adds two RPCs that
--      cover the legitimate non-friend lookups (free-text friend search,
--      username-availability pre-check) without leaking the rest of the row.
--   C. Self-promote-to-paid bypass — the client could `UPDATE rec_entitlements
--      SET plan='paid'` from the device.  This migration removes client
--      INSERT/UPDATE policies and replaces the legitimate "consume one
--      expert refresh" write path with a SECURITY DEFINER RPC that never
--      touches the `plan` column.
--
-- Compatibility notes:
--   * Books INSERT is kept fully open — every "save book from rec" / scan /
--     manual-add path needs to create catalog rows.
--   * book_source_links INSERT is kept open — Goodreads import upserts links
--     before the corresponding user_books row exists in the same batch.
--   * book_enrichment_cache INSERT is kept open — the recommender enriches
--     OL candidates that may not yet have any books row at all.
--   * For each table, only the OVERWRITE path (UPDATE / upsert-update-half)
--     is what we tighten, since that is the defacement vector.
-- =============================================================================


-- =============================================================================
-- A. Catalog write hardening
-- =============================================================================

-- ── A.1 books: column-immutability trigger ────────────────────────────────────
-- The existing UPDATE policy ("users can update books in their library",
-- migration 20260314000000) already restricts writes to users who own a
-- user_books row referencing the book. That policy stays; this trigger adds a
-- second layer that prevents identity columns from being rewritten once they
-- are set, even by a user who legitimately has the book in their library.
--
-- Rules (silent coercion, never raises — most call sites are best-effort
-- enrichment that should not abort the whole patch on a single locked field):
--   * title  — immutable post-insert
--   * author — immutable post-insert
--   * external_id — null → non-null backfill allowed (Goodreads imports start
--     without one and pick up an OL works key during metadata repair); any
--     other change is silently reverted.
--   * cover_url   — only allowed when OLD.cover_url IS NULL (fill-if-empty)
--   * description — only allowed when OLD.description IS NULL (fill-if-empty)
--
-- Service-role / superuser writes (migrations, edge functions) bypass the
-- check — auth.uid() is null in that context.

create or replace function public._books_protect_identity_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Skip enforcement for service-role / migration writes.
  if auth.uid() is null then
    return new;
  end if;

  if new.title is distinct from old.title then
    new.title := old.title;
  end if;

  if new.author is distinct from old.author then
    new.author := old.author;
  end if;

  if old.external_id is not null
     and new.external_id is distinct from old.external_id then
    new.external_id := old.external_id;
  end if;

  if old.cover_url is not null
     and new.cover_url is distinct from old.cover_url then
    new.cover_url := old.cover_url;
  end if;

  if old.description is not null
     and new.description is distinct from old.description then
    new.description := old.description;
  end if;

  return new;
end;
$$;

revoke all on function public._books_protect_identity_columns() from public;

drop trigger if exists books_protect_identity_columns on public.books;

create trigger books_protect_identity_columns
  before update on public.books
  for each row execute function public._books_protect_identity_columns();


-- ── A.2 book_enrichment_cache: gate UPDATE on library ownership ──────────────
-- INSERT stays open (recommender writes cache rows for OL candidates that
-- don't yet exist in the books table). UPDATE — the overwrite half of the
-- client's `upsert(onConflict: external_id)` — is what we tighten: only a
-- user who has the book in their own library may refresh the cached row.
--
-- Worst-case degradation: re-enrichment after the 24h TTL silently no-ops
-- for users who don't own the book. The cache simply stays at its previous
-- contents until someone with the book in their library re-enriches.

drop policy if exists "book_enrichment_cache_update" on public.book_enrichment_cache;

create policy "book_enrichment_cache_update"
  on public.book_enrichment_cache for update
  to authenticated
  using (
    exists (
      select 1
        from public.user_books ub
        join public.books b on b.id = ub.book_id
       where b.external_id = book_enrichment_cache.external_id
         and ub.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
        from public.user_books ub
        join public.books b on b.id = ub.book_id
       where b.external_id = book_enrichment_cache.external_id
         and ub.user_id = auth.uid()
    )
  );


-- ── A.3 book_source_links: add the missing UPDATE policy ─────────────────────
-- The original migration (20260315000003) created INSERT and SELECT policies
-- but no UPDATE policy. The client uses `upsert(onConflict: 'book_id,source')`
-- via `lib/metadataProvider.ts recordProviderLink`, so once a row exists the
-- update half silently fails RLS. This adds the missing policy with the same
-- library-ownership gate used by `books`.

drop policy if exists "users update book_source_links in their library"
  on public.book_source_links;

create policy "users update book_source_links in their library"
  on public.book_source_links for update
  to authenticated
  using (
    exists (
      select 1 from public.user_books ub
       where ub.book_id = book_source_links.book_id
         and ub.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.user_books ub
       where ub.book_id = book_source_links.book_id
         and ub.user_id = auth.uid()
    )
  );


-- =============================================================================
-- B. Profile discovery tightening
-- =============================================================================

-- ── B.1 Replace "view all profiles" with "self or accepted friend" ───────────
-- The audit flagged that `using (true)` made every authenticated user able to
-- enumerate every profile. We narrow SELECT to the rows the app actually
-- needs to render: the user's own row, and the rows for users with whom the
-- viewer has an accepted friendship.
--
-- All non-friend lookups go through the two RPCs defined below.

drop policy if exists "profiles: authenticated users can view all profiles"
  on public.profiles;

drop policy if exists "profiles: self or accepted friend can select"
  on public.profiles;

-- Note: the existing own-row SELECT policy from migration 20260311000001
-- ("profiles: users can select own row") still exists and continues to grant
-- access to the caller's own row. This policy is purely additive for the
-- friend case so the two compose correctly.

create policy "profiles: self or accepted friend can select"
  on public.profiles for select
  to authenticated
  using (
    auth.uid() = id
    or exists (
      select 1 from public.friendships f
       where f.status = 'accepted'
         and (
           (f.requester_id = auth.uid() and f.addressee_id = profiles.id)
           or
           (f.addressee_id = auth.uid() and f.requester_id = profiles.id)
         )
    )
  );


-- ── B.2 search_profiles RPC ─────────────────────────────────────────────────
-- Friend-discovery search by username substring. SECURITY DEFINER so it can
-- read `profiles` regardless of the new restrictive SELECT policy. Returns
-- only the minimum fields needed to render a search-result row in
-- components/FriendsSheet.tsx. Caps results at 20.
--
-- Excludes the caller from results. Requires the query to be at least 1
-- non-whitespace character.

create or replace function public.search_profiles(q text)
returns table (
  id         uuid,
  username   text,
  first_name text,
  last_name  text
)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.username, p.first_name, p.last_name
    from public.profiles p
   where auth.uid() is not null
     and length(trim(coalesce(q, ''))) >= 1
     and p.id <> auth.uid()
     and p.username ilike '%' || trim(q) || '%'
   order by p.username
   limit 20;
$$;

revoke all    on function public.search_profiles(text) from public;
grant execute on function public.search_profiles(text) to authenticated;


-- ── B.3 is_username_available RPC ───────────────────────────────────────────
-- Pre-checks username availability during sign-up. Callable by the anon role
-- because the user is not yet authenticated when they pick a username.
-- Returns a single boolean — never leaks any other profile field.
--
-- The check is case-insensitive to match the unique index in migration
-- 20260321000000_username_ci_unique_index.sql.

create or replace function public.is_username_available(p_username text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select length(trim(coalesce(p_username, ''))) >= 1
     and not exists (
       select 1 from public.profiles
        where lower(username) = lower(trim(p_username))
     );
$$;

revoke all    on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;


-- =============================================================================
-- C. rec_entitlements lockdown
-- =============================================================================

-- ── C.1 Remove client INSERT and UPDATE policies ─────────────────────────────
-- The audit flagged that `using (auth.uid() = user_id)` on UPDATE allowed any
-- client to write `plan = 'paid'` for themselves, bypassing any future
-- paywall. INSERT had the same shape and could be used to bootstrap a paid
-- row at sign-up time. SELECT (own-row) stays — clients still need to read
-- their own entitlement to render the rec UI.

drop policy if exists "users can insert own entitlement" on public.rec_entitlements;
drop policy if exists "users can update own entitlement" on public.rec_entitlements;


-- ── C.2 consume_expert_refresh RPC ──────────────────────────────────────────
-- Replaces the client-side upsert in lib/recEntitlement.ts consumeExpertRefresh.
-- SECURITY DEFINER so the function bypasses RLS on rec_entitlements.
--
-- IMPORTANT: the action taken (first-use vs period-refresh vs quota-exhausted
-- vs paid) is computed ENTIRELY server-side from the current row state. We
-- intentionally do not accept a client-supplied "reason" parameter — earlier
-- design did, and review flagged that as a free-tier privilege escalation
-- oracle (a malicious client could call reason='free_first_use' repeatedly to
-- reset expert_refreshes_this_period = 1 and bypass the per-period quota).
-- The `plan` column is also never written here — plan transitions are
-- reserved for the future server-side payment webhook.
--
-- Quota constants mirror lib/recEntitlement.ts:
--   FREE_EXPERT_PERIOD_DAYS         = 30
--   FREE_EXPERT_REFRESHES_PER_PERIOD = 1
-- If those constants change in the client, update them here too.
--
-- Returns jsonb describing the action taken; best-effort semantics preserved
-- (no exception is propagated to the client).

create or replace function public.consume_expert_refresh()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid               uuid := auth.uid();
  v_now               timestamptz := now();
  v_period_days       integer := 30;
  v_quota_per_period  integer := 1;
  v_existing          record;
  v_period_expired    boolean;
  v_is_paid           boolean;
  v_refreshes_used    integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select plan,
         free_expert_used,
         expert_refreshes_this_period,
         period_start_at
    into v_existing
    from public.rec_entitlements
   where user_id = v_uid;

  -- ── Bootstrap: no row yet → first ever use ─────────────────────────────
  -- Plan defaults to 'free' (column default). free_expert_used flips true,
  -- period counter starts at 1, period window opens now.
  if not found then
    insert into public.rec_entitlements (
      user_id,
      plan,
      free_expert_used,
      free_expert_used_at,
      expert_refreshes_this_period,
      period_start_at,
      last_expert_refresh_at,
      updated_at
    ) values (
      v_uid,
      'free',
      true,
      v_now,
      1,
      v_now,
      v_now,
      v_now
    );
    return jsonb_build_object('ok', true, 'action', 'free_first_use');
  end if;

  -- ── Paid / beta tiers — just bump the timestamp ──────────────────────────
  v_is_paid := v_existing.plan in ('paid', 'beta');
  if v_is_paid then
    update public.rec_entitlements
       set last_expert_refresh_at = v_now,
           updated_at             = v_now
     where user_id = v_uid;
    return jsonb_build_object('ok', true, 'action', 'paid_or_beta');
  end if;

  -- ── Free tier — never used the complimentary preview yet ────────────────
  if not coalesce(v_existing.free_expert_used, false) then
    update public.rec_entitlements
       set free_expert_used             = true,
           free_expert_used_at          = v_now,
           expert_refreshes_this_period = 1,
           period_start_at              = v_now,
           last_expert_refresh_at       = v_now,
           updated_at                   = v_now
     where user_id = v_uid;
    return jsonb_build_object('ok', true, 'action', 'free_first_use');
  end if;

  -- ── Free tier — period-window math drives refresh vs. quota_exhausted ───
  v_period_expired := v_existing.period_start_at is null
                       or (v_now - v_existing.period_start_at)
                            > make_interval(days => v_period_days);
  v_refreshes_used := case
                        when v_period_expired then 0
                        else coalesce(v_existing.expert_refreshes_this_period, 0)
                      end;

  if v_refreshes_used >= v_quota_per_period then
    -- Quota exhausted — do NOT increment, do NOT reset window. Caller's
    -- `canRunExpertRecs` should have blocked this; we refuse defensively.
    return jsonb_build_object('ok', false, 'action', 'quota_exhausted');
  end if;

  update public.rec_entitlements
     set expert_refreshes_this_period = v_refreshes_used + 1,
         period_start_at              = case
                                          when v_period_expired then v_now
                                          else v_existing.period_start_at
                                        end,
         last_expert_refresh_at       = v_now,
         updated_at                   = v_now
   where user_id = v_uid;
  return jsonb_build_object('ok', true, 'action', 'free_period_refresh');

exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm, 'detail', sqlstate);
end;
$$;

revoke all    on function public.consume_expert_refresh() from public;
grant execute on function public.consume_expert_refresh() to authenticated;
