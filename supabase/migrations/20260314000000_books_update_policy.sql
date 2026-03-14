-- Allow authenticated users to update books that exist in their library.
-- Scope: only books linked to the user's own user_books rows.
-- This covers manual page_count entry and OL/Google Books enrichment.
create policy "users can update books in their library"
  on books for update
  to authenticated
  using (
    exists (
      select 1 from user_books
      where user_books.book_id = books.id
        and user_books.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from user_books
      where user_books.book_id = books.id
        and user_books.user_id = auth.uid()
    )
  );
