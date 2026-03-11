-- credibility_events: recipient inserts; sender or recipient can read
create policy "users can insert credibility_events they receive"
  on credibility_events for insert
  to authenticated
  with check (auth.uid() = to_user_id);

create policy "users can read credibility_events they are involved in"
  on credibility_events for select
  to authenticated
  using (auth.uid() = from_user_id or auth.uid() = to_user_id);
