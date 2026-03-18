-- =============================================================================
-- rec_feedback
--
-- Stores per-user recommendation feedback events:
--   'impression'         — book was shown to the user
--   'saved'              — user tapped "Save for later" → added to library
--   'dismissed'          — user tapped "Not for me" → excluded from future recs
--   'more_like_this'     — user tapped "More like this" → genre boost in scoring
--   'explanation_opened' — user expanded the "Why this?" panel
--
-- Feedback drives scoring via loadFeedbackContext():
--   dismissed rows → excluded from candidate pool (by external_id or book_db_id)
--   more_like_this rows → genreBoosts map (+0.12–0.20 per genre)
--
-- external_id and book_db_id are both nullable because:
--   OL books may not exist in the books table when first dismissed (no book_db_id)
--   Catalog books may have no external_id (manually added, no OL key)
-- =============================================================================

create table if not exists rec_feedback (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  external_id      text,                       -- OL /works/OLxxxW key
  book_db_id       text,                       -- books.id UUID (if available)
  feedback_type    text        not null check (
    feedback_type in ('saved','dismissed','more_like_this','impression','explanation_opened')
  ),
  score_snapshot   numeric(5,3),               -- recommender score at feedback time
  source_snapshot  text,                       -- 'catalog'|'cached_external'|'open_library'
  book_genre       text,                       -- primaryGenre for boost computation
  reasons_snapshot text[],                     -- recommendation reasons at feedback time
  created_at       timestamptz not null default now()
);

alter table rec_feedback enable row level security;

create policy "users manage own rec feedback"
  on rec_feedback for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists rec_feedback_user_type
  on rec_feedback (user_id, feedback_type);

create index if not exists rec_feedback_user_created
  on rec_feedback (user_id, created_at desc);
