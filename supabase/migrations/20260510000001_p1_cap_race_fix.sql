-- =============================================================================
-- Migration: P1 follow-up — cap race fix + dedup race fallback
-- Created:   2026-05-10
-- =============================================================================
-- Code-review finding (architect) on 20260510000000_p1_security_hardening.sql:
--
--   "Pending cap can be bypassed via race: cap check is count(*) then insert,
--    without lock/serialization. Parallel requests from one requester can all
--    observe < 50 then insert, exceeding 50 pending."
--
-- Fix:
--   1. Acquire pg_advisory_xact_lock(hashtext(v_uid::text)) BEFORE the count
--      check. This serializes all send_friend_request() calls for a single
--      requester within their respective transactions; the lock is released
--      automatically on commit/rollback.  Different requesters do not block
--      each other in practice (their hashes differ — collisions on int4 hash
--      space exist but cause at most brief queueing, not correctness issues).
--
--   2. Wrap the INSERT in an exception block so that if two concurrent calls
--      somehow race past the lock (e.g. via ON CONFLICT path on the underlying
--      idx_friendships_pair unique index), the unique_violation is normalised
--      to FRIEND_REQUEST_DUPLICATE (SQLSTATE 23505) instead of a generic
--      "duplicate key value..." message.  This makes client error
--      classification deterministic regardless of timing.
--
-- Idempotent: CREATE OR REPLACE replaces the existing function in place.
-- =============================================================================

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

  -- Per-requester serialization for the cap-check + insert window.
  -- Released automatically at end of transaction.  Different requesters
  -- get different hashes, so this does not contend cross-user.
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  -- Canonical-pair dedup (cheap, runs after the lock so concurrent retries
  -- from the same requester get a deterministic FRIEND_REQUEST_DUPLICATE).
  select id into v_existing
    from public.friendships
   where (requester_id = v_uid and addressee_id = p_addressee_id)
      or (requester_id = p_addressee_id and addressee_id = v_uid);
  if v_existing is not null then
    raise exception 'FRIEND_REQUEST_DUPLICATE' using errcode = '23505';
  end if;

  -- Pending cap: 50 outbound pending per requester.  Now race-safe under the
  -- per-requester advisory lock above.
  select count(*) into v_pending
    from public.friendships
   where requester_id = v_uid
     and status = 'pending';
  if v_pending >= 50 then
    raise exception 'FRIEND_REQUEST_PENDING_CAP_EXCEEDED: max 50 pending requests'
      using errcode = '53400';
  end if;

  -- Backstop: if anything still races past the advisory lock (e.g. cross-
  -- requester collision on hash() or different transaction isolation), the
  -- unique index idx_friendships_pair will fire.  Normalise to our explicit
  -- FRIEND_REQUEST_DUPLICATE so client classification is deterministic.
  begin
    insert into public.friendships (requester_id, addressee_id, status)
    values (v_uid, p_addressee_id, 'pending')
    returning * into v_row;
  exception
    when unique_violation then
      raise exception 'FRIEND_REQUEST_DUPLICATE' using errcode = '23505';
  end;

  return v_row;
end;
$$;
