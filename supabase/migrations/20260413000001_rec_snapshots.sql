-- rec_snapshots — durable per-(user, book) recommendation evidence
--
-- Stores only the rendered user-facing output: the explanation sentence and
-- the evidence tag array. No raw recommender internals (score_breakdown,
-- reasons arrays, lane weights) are persisted here.
--
-- Written fire-and-forget when a user taps a RecCard — the same event that
-- writes the session cache in lib/recContext.ts. The two writes are parallel:
-- the session cache is instant and synchronous; the DB write is async and
-- best-effort. If the DB write fails, the session cache still works for the
-- current tap-through.
--
-- Read by the book detail screen when the session cache is empty (direct nav,
-- app restart, or session expiry). Provides "Why this book?" evidence without
-- requiring the user to have arrived from the rec feed in the current session.
--
-- Updated on re-tap: if the recommender generates different evidence on a later
-- run, the snapshot is replaced. Old evidence is overwritten, never accumulated.
-- The updated_at column tracks the most recent write for debugging.

create table if not exists rec_snapshots (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  external_id   text        not null,
  explanation   text,
  evidence_tags text[]      not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, external_id)
);

alter table rec_snapshots enable row level security;

create policy "users manage own rec snapshots"
  on rec_snapshots for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Point lookup from book detail: one row per (user, book).
-- No additional index needed beyond the primary key.
