-- =============================================================================
-- Migration: Onboarding completion flag on profiles
-- Created:   2026-03-27
-- =============================================================================
-- false (default) = user has not completed onboarding
-- true            = user has completed onboarding; skip the flow on next login
-- =============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false;
