-- =============================================================================
-- Migration: Allow correction events in reading_sessions
-- Created:   2026-04-13
--
-- The original reading_sessions_forward_progress check constraint enforced
-- pages_read >= 0, which prevents inserting negative-delta correction events.
--
-- When a user reduces their current page (partial rollback or reset to 0),
-- saveCurrentPage() must insert a correction row with a negative pages_read
-- so that all analytics (monthly totals, reading days, top-book) recompute
-- correctly via net-sum aggregation.
--
-- This migration drops the old constraint and replaces it with a looser one
-- that: (a) still rejects rows with pages_read = 0 (no-op sessions are not
-- meaningful), and (b) allows negative pages_read for correction events,
-- while keeping the invariant that ended_page and started_page are valid
-- integers.
-- =============================================================================

alter table reading_sessions
  drop constraint reading_sessions_forward_progress;

alter table reading_sessions
  add constraint reading_sessions_nonzero_delta
    check (pages_read <> 0);
