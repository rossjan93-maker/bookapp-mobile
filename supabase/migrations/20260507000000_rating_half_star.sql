-- Half-star ratings (0.5 increments, 0.5 → 5.0).
--
-- Previously user_books.rating and activity_events.rating were integer
-- columns constrained to 1–5. To support half-star ratings we widen the
-- type to numeric(3,1) and add a check constraint that allows nulls plus
-- any value in {0.5, 1.0, 1.5, ..., 5.0}.
--
-- Existing integer values cast losslessly into numeric so no row data
-- changes. The old integer check constraint is dropped before the
-- type change because Postgres won't let us alter a column that has a
-- check still tied to its old domain.

-- A. user_books
alter table public.user_books
  drop constraint if exists user_books_rating_check;

alter table public.user_books
  alter column rating type numeric(3,1) using rating::numeric;

alter table public.user_books
  add constraint user_books_rating_check
  check (
    rating is null
    or (rating >= 0.5 and rating <= 5 and (rating * 2) = floor(rating * 2))
  );

-- B. activity_events
-- No prior check constraint existed on activity_events.rating, but we
-- still widen the column type so feed events can store half stars.
alter table public.activity_events
  alter column rating type numeric(3,1) using rating::numeric;

alter table public.activity_events
  add constraint activity_events_rating_check
  check (
    rating is null
    or (rating >= 0.5 and rating <= 5 and (rating * 2) = floor(rating * 2))
  );
