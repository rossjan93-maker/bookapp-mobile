-- Allow actors to update their own activity_events rows.
-- Required for the finish+rating merge flow: when a user rates a book
-- immediately after finishing, the existing completion event is updated
-- in-place (SET rating = n) rather than inserting a separate book_rated row.
-- Without this policy RLS silently blocks the UPDATE and rating never
-- appears on the completion event in the feed.

create policy "users can update their own activity_events"
  on activity_events for update
  to authenticated
  using  (auth.uid() = actor_id)
  with check (auth.uid() = actor_id);
