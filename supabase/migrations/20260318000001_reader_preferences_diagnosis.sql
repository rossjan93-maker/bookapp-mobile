-- =============================================================================
-- Migration: Add diagnosis_answers to reader_preferences
-- Created:   2026-03-18
-- =============================================================================
-- Stores the user's answers to the 5 taste-calibration questions from the
-- diagnosis flow.  Format: { "q1": "idea_driven", "q2": "pacing_non_negotiable", ... }
-- Used as lightweight priors that influence the taste profile when explicit
-- ratings/tags are sparse.

alter table reader_preferences
  add column if not exists diagnosis_answers jsonb default '{}'::jsonb;
