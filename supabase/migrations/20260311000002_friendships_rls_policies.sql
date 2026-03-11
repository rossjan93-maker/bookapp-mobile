-- =============================================================================
-- Migration: Friendships RLS Policies + Profiles Discovery Policy
-- Created:   2026-03-11
-- =============================================================================
-- Adds the minimum policies needed for MVP friend discovery and connections.
-- RLS is already enabled on both tables from the foundation migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles: discovery
-- ---------------------------------------------------------------------------
-- Allows any authenticated user to read any profile row.
-- Required so users can search for others to send friend requests to.
-- The existing own-row select policy (migration 000001) already covers
-- a user reading their own profile; this policy covers reading others'.

create policy "profiles: authenticated users can view all profiles"
  on profiles
  for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- friendships: select
-- ---------------------------------------------------------------------------
-- A user can see any friendship row where they are either party.
-- This covers: pending requests received, pending requests sent, accepted friends.

create policy "friendships: users can select own rows"
  on friendships
  for select
  to authenticated
  using (
    auth.uid() = requester_id or
    auth.uid() = addressee_id
  );

-- ---------------------------------------------------------------------------
-- friendships: insert
-- ---------------------------------------------------------------------------
-- A user can only create a friendship row where they are the requester.
-- Prevents impersonating another user as the initiator of a request.

create policy "friendships: users can insert as requester"
  on friendships
  for insert
  to authenticated
  with check (auth.uid() = requester_id);

-- ---------------------------------------------------------------------------
-- friendships: update
-- ---------------------------------------------------------------------------
-- Only the addressee can update a friendship row.
-- This is the accept/decline action: the addressee changes status from
-- pending to accepted. The requester cannot self-accept their own request.

create policy "friendships: addressee can update"
  on friendships
  for update
  to authenticated
  using (auth.uid() = addressee_id)
  with check (auth.uid() = addressee_id);
