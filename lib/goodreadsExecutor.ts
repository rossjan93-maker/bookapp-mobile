// =============================================================================
// Goodreads Import Executor
// =============================================================================
// Reads staged import_rows and executes them into the real data model:
//   books          — create new book records for unmatched rows
//   user_books     — create or conservatively merge into existing records
//   book_source_links — upsert Goodreads source links
//   import_rows    — update each row with final resolution + user_book_id
//   import_batches — update counters and finalize status
// =============================================================================

import { supabase } from './supabase';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ExecutionSummary = {
  batchId: string;
  added: number;        // new user_books created (book was matched or newly created)
  merged: number;       // user already had book; import data merged into existing row
  skipped: number;      // user already had book; no new data worth merging
  reviewNeeded: number; // rows left unresolved
  failed: number;
  reviewRows: Array<{ title: string; author: string; reason: string | null }>;
  newBookIds: string[];           // IDs of books freshly created in this pass
  allAffectedBookIds: string[];   // IDs of ALL books touched (created + matched + reimported)
};

// ─── Internal row shape from import_rows ─────────────────────────────────────

type ImportRow = {
  id: string;
  raw_data: Record<string, string>;
  title: string | null;
  author: string | null;
  isbn: string | null;
  isbn13: string | null;
  publisher: string | null;
  binding: string | null;
  publication_year: number | null;
  original_publication_year: number | null;
  date_read: string | null;
  date_added: string | null;
  exclusive_shelf: string | null;
  raw_shelves: string[] | null;
  raw_shelf_positions: Record<string, number> | null;
  source_rating: number | null;
  review_body: string | null;
  read_count: number | null;
  owned_copies: number | null;
  matched_book_id: string | null;
  match_confidence: number | null;
  review_reason: string | null;
};

type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function mapShelfToStatus(shelf: string | null): UserBookStatus {
  switch (shelf) {
    case 'read':              return 'finished';
    case 'currently-reading': return 'reading';
    case 'to-read':           return 'want_to_read';
    default:                  return 'want_to_read';
  }
}

// Status upgrade order: want_to_read < reading < finished
// Never downgrade; only upgrade (e.g. want_to_read → finished is fine).
function upgradeStatus(existing: string, imported: UserBookStatus): UserBookStatus {
  const rank: Record<string, number> = { want_to_read: 0, reading: 1, finished: 2, dnf: 1 };
  const existingRank = rank[existing] ?? 0;
  const importedRank = rank[imported] ?? 0;
  return importedRank > existingRank ? imported : (existing as UserBookStatus);
}

// Convert a date string (YYYY-MM-DD) to a timestamptz-compatible ISO string at midnight UTC.
function dateToTimestamptz(date: string | null): string | null {
  if (!date) return null;
  return `${date}T00:00:00.000Z`;
}

// Extract the Goodreads Book Id from the raw_data JSONB blob.
function sourceBookId(row: ImportRow): string | null {
  return row.raw_data?.['Book Id'] ?? null;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function executeGoodreadsImport(
  userId: string,
  batchId: string,
  onProgress?: (phase: 'linking' | 'finalizing') => void,
): Promise<ExecutionSummary> {
  if (!supabase) throw new Error('Supabase not configured.');

  const now = new Date().toISOString();
  const counters = { added: 0, merged: 0, skipped: 0, reviewNeeded: 0, failed: 0 };
  const reviewRows: ExecutionSummary['reviewRows'] = [];

  // ── 1. Fetch all pending import_rows for this batch ───────────────────────
  const { data: pendingRows, error: fetchError } = await supabase
    .from('import_rows')
    .select('*')
    .eq('batch_id', batchId)
    .eq('resolution', 'pending');

  if (fetchError) throw new Error(`Failed to load staged rows: ${fetchError.message}`);
  if (!pendingRows || pendingRows.length === 0) {
    return { batchId, added: 0, merged: 0, skipped: 0, reviewNeeded: 0, failed: 0, reviewRows: [], newBookIds: [], allAffectedBookIds: [] };
  }

  const rows = pendingRows as ImportRow[];

  // ── 2. Separate rows into groups ──────────────────────────────────────────
  // Group A: matched_book_id already resolved during staging
  const groupMatched = rows.filter(r => !!r.matched_book_id);
  // Group B: unmatched but has enough data to create a book
  const groupCreate  = rows.filter(r => !r.matched_book_id && !!r.title && !!r.author);
  // Group C: neither — skip, mark review_needed
  const groupInvalid = rows.filter(r => !r.matched_book_id && (!r.title || !r.author));

  // ── 3. Mark invalid rows as review_needed immediately ────────────────────
  for (const invalidRow of groupInvalid) {
    counters.reviewNeeded++;
    reviewRows.push({
      title: invalidRow.title || '(no title)',
      author: invalidRow.author || '(no author)',
      reason: invalidRow.review_reason ?? 'Missing title or author',
    });
    await supabase
      .from('import_rows')
      .update({ resolution: 'review_needed', resolved_at: now })
      .eq('id', invalidRow.id);
  }

  // ── 4. Create books for group B ───────────────────────────────────────────
  // external_id = 'goodreads:{goodreads_book_id}' — stable and unique per edition.
  const externalIdToRow = new Map<string, ImportRow>();
  for (const row of groupCreate) {
    const sid = sourceBookId(row);
    if (sid) externalIdToRow.set(`goodreads:${sid}`, row);
  }

  const bookInsertPayloads = Array.from(externalIdToRow.entries()).map(([extId, row]) => ({
    external_id: extId,
    title: row.title!,
    author: row.author!,
    isbn: row.isbn ?? null,
    isbn13: row.isbn13 ?? null,
    publisher: row.publisher ?? null,
    binding: row.binding ?? null,
    page_count: null as number | null,       // page_count not in import_rows schema
    publication_year: row.publication_year ?? null,
    original_publication_year: row.original_publication_year ?? null,
    cover_url: null as string | null,        // Goodreads CSV has no cover URLs
  }));

  // Build bookId lookup map: external_id → book uuid
  const bookIdByExternalId = new Map<string, string>();

  for (const chunk of chunkArray(bookInsertPayloads, 100)) {
    // INSERT ... ON CONFLICT (external_id) DO NOTHING preserves existing richer records.
    const { error: insertError } = await supabase
      .from('books')
      .upsert(chunk, { onConflict: 'external_id', ignoreDuplicates: true });
    if (insertError) {
      // Non-fatal: some books may still be retrieved on the next select.
      console.warn('Book upsert partial error:', insertError.message);
    }
  }

  // Fetch book IDs for all external_ids we just upserted.
  const allExternalIds = bookInsertPayloads.map(b => b.external_id);
  for (const chunk of chunkArray(allExternalIds, 300)) {
    const { data: bookRows } = await supabase
      .from('books')
      .select('id, external_id')
      .in('external_id', chunk);
    (bookRows ?? []).forEach((b: { id: string; external_id: string }) => {
      bookIdByExternalId.set(b.external_id, b.id);
    });
  }

  // Attach resolved book_id to groupCreate rows
  const createWithBookId: Array<{ row: ImportRow; bookId: string }> = [];
  for (const row of groupCreate) {
    const sid = sourceBookId(row);
    const extId = sid ? `goodreads:${sid}` : null;
    const bookId = extId ? bookIdByExternalId.get(extId) : null;
    if (bookId) {
      createWithBookId.push({ row, bookId });
    } else {
      // Could not get a book ID — mark failed
      counters.failed++;
      await supabase
        .from('import_rows')
        .update({ resolution: 'failed', error_message: 'Book could not be created', resolved_at: now })
        .eq('id', row.id);
    }
  }

  // ── 5. Upsert book_source_links for ALL resolved rows ────────────────────
  const sourceLinkPayloads: Array<{ source: string; source_book_id: string; book_id: string }> = [];

  for (const { row: r, bookId } of createWithBookId) {
    const sid = sourceBookId(r);
    if (sid) sourceLinkPayloads.push({ source: 'goodreads', source_book_id: sid, book_id: bookId });
  }
  for (const row of groupMatched) {
    const sid = sourceBookId(row);
    if (sid && row.matched_book_id) {
      sourceLinkPayloads.push({ source: 'goodreads', source_book_id: sid, book_id: row.matched_book_id });
    }
  }

  for (const chunk of chunkArray(sourceLinkPayloads, 100)) {
    await supabase
      .from('book_source_links')
      .upsert(chunk, { onConflict: 'source,source_book_id', ignoreDuplicates: true });
  }

  // Signal that book creation is done; now linking reading history.
  onProgress?.('linking');

  // ── 6. Resolve all rows that now have a book_id ───────────────────────────
  // allResolved = groupMatched + createWithBookId (successfully got a book_id)
  type ResolvedRow = { row: ImportRow; bookId: string };
  const allResolved: ResolvedRow[] = [
    ...groupMatched.map(row => ({ row, bookId: row.matched_book_id! })),
    ...createWithBookId,
  ];

  // Bulk-fetch existing user_books for this user across all relevant book IDs.
  const allBookIds = Array.from(new Set(allResolved.map(r => r.bookId)));
  const existingUserBookMap = new Map<string, Record<string, unknown>>();

  for (const chunk of chunkArray(allBookIds, 300)) {
    const { data: existingUBs } = await supabase
      .from('user_books')
      .select('id, book_id, status, rating, review_body, private_note, finished_at, date_added, read_count, owned_copies, raw_shelves, raw_shelf_positions, review_contains_spoiler, import_source, import_source_book_id, import_batch_id, imported_at')
      .eq('user_id', userId)
      .in('book_id', chunk);
    (existingUBs ?? []).forEach((ub: Record<string, unknown>) => {
      existingUserBookMap.set(ub.book_id as string, ub);
    });
  }

  // ── 7. Build new user_book inserts and collect rows needing merge ─────────
  type NewUserBook = {
    user_id: string;
    book_id: string;
    status: UserBookStatus;
    finished_at: string | null;
    source: string;
    rating: number | null;
    date_added: string | null;
    review_body: string | null;
    private_note: string | null;
    review_contains_spoiler: boolean;
    read_count: number | null;
    owned_copies: number | null;
    raw_shelves: string[] | null;
    raw_shelf_positions: Record<string, number> | null;
    exclusive_shelf_imported: string | null;
    import_source: string;
    import_source_book_id: string | null;
    import_batch_id: string;
    imported_at: string;
    _importRowId: string;      // tracking only — stripped before DB insert
    _resolution: 'matched' | 'created'; // tracking only — stripped before DB insert
  };

  const toInsert: NewUserBook[] = [];
  const toMerge: Array<{ row: ImportRow; bookId: string; existing: Record<string, unknown> }> = [];

  for (const { row, bookId } of allResolved) {
    const existing = existingUserBookMap.get(bookId);
    const sid = sourceBookId(row);

    if (!existing) {
      // Determine final resolution label based on whether the book already
      // existed in our DB (matched during staging) or was just created above.
      const bookWasMatched = !!row.matched_book_id;
      toInsert.push({
        user_id: userId,
        book_id: bookId,
        status: mapShelfToStatus(row.exclusive_shelf),
        finished_at: row.exclusive_shelf === 'read' ? dateToTimestamptz(row.date_read) : null,
        source: 'self_added',
        rating: row.source_rating ?? null,
        date_added: row.date_added ?? null,
        review_body: row.review_body ?? null,
        private_note: row.raw_data?.['Private Notes']?.trim() || null,
        review_contains_spoiler: false,
        read_count: row.read_count ?? null,
        owned_copies: row.owned_copies ?? null,
        raw_shelves: row.raw_shelves ?? null,
        raw_shelf_positions: row.raw_shelf_positions ?? null,
        exclusive_shelf_imported: row.exclusive_shelf ?? null,
        import_source: 'goodreads',
        import_source_book_id: sid ?? null,
        import_batch_id: batchId,
        imported_at: now,
        _importRowId: row.id,
        _resolution: bookWasMatched ? 'matched' : 'created',
      });
    } else {
      toMerge.push({ row, bookId, existing });
    }
  }

  // ── 8. Bulk insert new user_books ─────────────────────────────────────────
  // Strip tracking-only fields before inserting.
  const insertPayloads = toInsert.map(({ _importRowId: _a, _resolution: _b, ...rest }) => rest);

  // Map import_row_id → book_id for result tracking
  const importRowToBookId = new Map(toInsert.map(r => [r._importRowId, r.book_id]));

  for (const chunk of chunkArray(insertPayloads, 100)) {
    const { error: ubInsertError } = await supabase
      .from('user_books')
      .insert(chunk);
    if (ubInsertError) {
      console.warn('user_books bulk insert partial error:', ubInsertError.message);
    }
  }

  // Fetch the newly inserted user_book IDs so we can write them back to import_rows.
  const newlyInsertedUBMap = new Map<string, string>(); // book_id → user_book.id
  for (const chunk of chunkArray(Array.from(importRowToBookId.values()), 300)) {
    const { data: newUBs } = await supabase
      .from('user_books')
      .select('id, book_id')
      .eq('user_id', userId)
      .in('book_id', chunk);
    (newUBs ?? []).forEach((ub: { id: string; book_id: string }) => {
      newlyInsertedUBMap.set(ub.book_id, ub.id);
    });
  }

  // Update import_rows for inserted user_books
  for (const insertedRow of toInsert) {
    const ubId = newlyInsertedUBMap.get(insertedRow.book_id);
    counters.added++;
    await supabase
      .from('import_rows')
      .update({ resolution: insertedRow._resolution, user_book_id: ubId ?? null, resolved_at: now })
      .eq('id', insertedRow._importRowId);
  }

  // ── 9. Conservative merge for existing user_books ─────────────────────────
  for (const { row, bookId, existing } of toMerge) {
    const sid = sourceBookId(row);
    const importedStatus = mapShelfToStatus(row.exclusive_shelf);
    const existingStatus = (existing.status as string) ?? 'want_to_read';
    const upgradedStatus = upgradeStatus(existingStatus, importedStatus);

    // Build update object — only fill null gaps or upgrade where import is clearly authoritative.
    const patch: Record<string, unknown> = {};

    if (upgradedStatus !== existingStatus)            patch.status = upgradedStatus;

    // finished_at: fill if null and book was marked read with a date
    if (!existing.finished_at && row.exclusive_shelf === 'read' && row.date_read) {
      patch.finished_at = dateToTimestamptz(row.date_read);
    }

    // rating: fill if currently null; never overwrite existing user rating
    if (existing.rating == null && row.source_rating != null)  patch.rating = row.source_rating;

    // review_body: fill if currently empty
    if (!existing.review_body && row.review_body)              patch.review_body = row.review_body;

    // private_note: fill if currently empty (read from raw_data since not in import_rows schema)
    const importPrivateNote = row.raw_data?.['Private Notes']?.trim() || null;
    if (!existing.private_note && importPrivateNote)           patch.private_note = importPrivateNote;

    // date_added: fill if currently null
    if (!existing.date_added && row.date_added)                patch.date_added = row.date_added;

    // read_count: take the higher of the two (import may have more accurate cumulative count)
    if (row.read_count != null) {
      const existingCount = (existing.read_count as number | null) ?? 0;
      if (row.read_count > existingCount)                      patch.read_count = row.read_count;
    }

    // owned_copies: fill if null
    if (existing.owned_copies == null && row.owned_copies != null) patch.owned_copies = row.owned_copies;

    // raw shelf data: fill if null (metadata only)
    if (!existing.raw_shelves && row.raw_shelves?.length)      patch.raw_shelves = row.raw_shelves;
    if (!existing.raw_shelf_positions && row.raw_shelf_positions) patch.raw_shelf_positions = row.raw_shelf_positions;

    // Import provenance: set once, never overwrite (first import wins)
    if (!existing.import_source) {
      patch.import_source = 'goodreads';
      patch.import_source_book_id = sid ?? null;
      patch.import_batch_id = batchId;
      patch.imported_at = now;
    }

    const hasMeaningfulChange = Object.keys(patch).length > 0;

    try {
      if (hasMeaningfulChange) {
        await supabase.from('user_books').update(patch).eq('id', existing.id as string);
        counters.merged++;
        await supabase
          .from('import_rows')
          .update({ resolution: 'merged', user_book_id: existing.id as string, resolved_at: now })
          .eq('id', row.id);
      } else {
        counters.skipped++;
        await supabase
          .from('import_rows')
          .update({ resolution: 'skipped', user_book_id: existing.id as string, resolved_at: now })
          .eq('id', row.id);
      }
    } catch (err) {
      counters.failed++;
      const msg = err instanceof Error ? err.message : 'Unknown merge error';
      await supabase
        .from('import_rows')
        .update({ resolution: 'failed', error_message: msg, resolved_at: now })
        .eq('id', row.id);
    }
  }

  // Signal that row processing is done; about to finalize counters.
  onProgress?.('finalizing');

  // ── 10. Finalize import_batches counters ──────────────────────────────────
  await supabase
    .from('import_batches')
    .update({
      status: 'complete',
      imported_rows: counters.added + counters.merged,
      skipped_rows: counters.skipped,
      failed_rows: counters.failed,
      review_needed: counters.reviewNeeded,
      completed_at: now,
    })
    .eq('id', batchId);

  // newBookIds: books freshly created in this pass.
  // allAffectedBookIds: every book touched (created + matched existing + reimported).
  const newBookIds = createWithBookId.map(c => c.bookId);

  return { batchId, ...counters, reviewRows, newBookIds, allAffectedBookIds: allBookIds };
}
