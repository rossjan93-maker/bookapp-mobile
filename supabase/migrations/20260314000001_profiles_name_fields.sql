-- Optional first_name / last_name on profiles.
-- Existing rows remain valid with NULL values.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name  text;
