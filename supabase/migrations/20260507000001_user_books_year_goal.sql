-- Year-goal stack: lets a user earmark specific books as part of their
-- "read this year" goal. When `year_goal_year` equals the current
-- calendar year and the book is not yet finished, it appears in the
-- queue rendered alongside the yearly progress bar on the home screen,
-- and its remaining pages feed the per-stack pacing projection.
--
-- Nullable integer (not boolean) so the value persists across years —
-- e.g. a book stacked for 2026 keeps year_goal_year = 2026 even after
-- 2027 begins, and we treat it as "not in this year's stack" without
-- destroying the historical signal. Ranges: 2000–2100 is a defensive
-- guard against bogus values; the app only ever writes the current year.
--
-- Index on (user_id, year_goal_year) speeds the home-screen lookup
-- which filters by both columns on every load.

alter table user_books
  add column if not exists year_goal_year integer;

alter table user_books
  drop constraint if exists user_books_year_goal_year_check;

alter table user_books
  add constraint user_books_year_goal_year_check
  check (year_goal_year is null or (year_goal_year between 2000 and 2100));

create index if not exists user_books_user_year_goal_idx
  on user_books (user_id, year_goal_year)
  where year_goal_year is not null;
