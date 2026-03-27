-- =============================================================================
-- scan_history
--
-- Persists every "will I like this?" scan event so the user can revisit
-- results and so the app can surface a scan history list in future.
--
-- Columns:
--   isbn          — the barcode value (EAN-13 / ISBN-13 / ISBN-10) as scanned
--   external_id   — OL /works/OLxxxW key if resolved (for feedback correlation)
--   score         — 0–1 fit score returned by evaluateScanFit
--   verdict       — 'strong_fit' | 'likely_fit' | 'mixed_fit' | 'not_for_you'
--   confidence    — 'high' | 'medium' | 'low'
--   action_taken  — null until the user acts; then 'saved' | 'dismissed' | 'more_like_this'
--   low_signal    — true when the result was returned in low-signal mode (tier 0)
-- =============================================================================

create table if not exists scan_history (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  isbn          text        not null,
  title         text        not null,
  author        text        not null,
  cover_url     text,
  external_id   text,
  score         numeric(5,3),
  verdict       text        check (verdict in ('strong_fit','likely_fit','mixed_fit','not_for_you')),
  confidence    text        check (confidence in ('high','medium','low')),
  reasons       text[]      default '{}',
  caution       text,
  action_taken  text        check (action_taken in ('saved','dismissed','more_like_this')),
  low_signal    boolean     not null default false,
  scanned_at    timestamptz not null default now()
);

alter table scan_history enable row level security;

create policy "users manage own scan history"
  on scan_history for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists scan_history_user_scanned
  on scan_history (user_id, scanned_at desc);
