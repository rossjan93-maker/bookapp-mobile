-- activity_events: actor inserts own rows; actor and accepted friends can read
create policy "users can insert their own activity_events"
  on activity_events for insert
  to authenticated
  with check (auth.uid() = actor_id);

create policy "users can read activity_events from self or accepted friends"
  on activity_events for select
  to authenticated
  using (
    auth.uid() = actor_id
    or exists (
      select 1 from friendships
      where status = 'accepted'
        and (
          (requester_id = auth.uid() and addressee_id = actor_id)
          or
          (addressee_id = auth.uid() and requester_id = actor_id)
        )
    )
  );
