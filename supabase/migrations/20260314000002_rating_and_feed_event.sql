-- ─── Rating + book_rated feed event ─────────────────────────────────────────
--
-- A. user_books.rating  — nullable 1-5 integer per user per book
-- B. activity_events.rating — denormalized for feed rendering (no extra join needed)
-- C. activity_event_type enum — new 'book_rated' value

-- A. Add rating to user_books
alter table user_books
  add column if not exists rating integer
  check (rating is null or (rating >= 1 and rating <= 5));

-- B. Add rating to activity_events (denormalized; only set for book_rated events)
alter table activity_events
  add column if not exists rating integer;

-- C. Extend the event type enum
alter type activity_event_type add value if not exists 'book_rated';
