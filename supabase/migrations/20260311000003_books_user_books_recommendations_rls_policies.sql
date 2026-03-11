-- books: any authenticated user can read and insert books
create policy "authenticated users can read books"
  on books for select
  to authenticated
  using (true);

create policy "authenticated users can insert books"
  on books for insert
  to authenticated
  with check (true);

-- user_books: users can only access their own rows
create policy "users can read own user_books"
  on user_books for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can insert own user_books"
  on user_books for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users can update own user_books"
  on user_books for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- recommendations: sender or recipient can read; only sender can insert; only recipient can update
create policy "users can read recommendations they are involved in"
  on recommendations for select
  to authenticated
  using (auth.uid() = from_user_id or auth.uid() = to_user_id);

create policy "users can insert recommendations they send"
  on recommendations for insert
  to authenticated
  with check (
    auth.uid() = from_user_id
    and exists (
      select 1 from friendships
      where status = 'accepted'
        and (
          (requester_id = from_user_id and addressee_id = to_user_id)
          or
          (requester_id = to_user_id and addressee_id = from_user_id)
        )
    )
  );

create policy "users can update recommendations sent to them"
  on recommendations for update
  to authenticated
  using (auth.uid() = to_user_id)
  with check (auth.uid() = to_user_id);
