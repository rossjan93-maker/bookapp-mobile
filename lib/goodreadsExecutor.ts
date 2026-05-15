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

// Strip parenthetical/colon/dash subtitle suffixes so Goodreads-shaped titles
// like "Royal Assassin (Farseer Trilogy, #2)" collapse to "Royal Assassin"
// before normalization. Mirrors lib/recommendationIntegrity.ts:stripTitleSubtitle
// but inlined here to keep the executor self-contained (it is the source of
// truth for import-time book matching, not the recommender).
function stripSubtitleLocal(title: string): string {
  return title
    .replace(/\s*\(.*\)\s*$/, '')              // "(Series, #2)"
    .replace(/\s*:\s+.*$/, '')                 // ": A Subtitle"
    .replace(/\s+\/\s+.*$/, '')                // " / Alternate Title"
    .replace(/\s+[-\u2013\u2014]\s+.*$/, '')   // " - " / " – " / " — " subtitle
    .trim();
}

// Normalised title+author key used for catalog dedup. Strips parens / colons /
// dashes BEFORE the punctuation-collapse pass so series-suffixed Goodreads
// titles match their clean catalog counterparts.
function normBookKey(title: string, author: string | null): string {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${n(stripSubtitleLocal(title))}||${n((author ?? '').split(',')[0])}`;
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
  // Deduplicate within the CSV by Goodreads Book ID (in-memory).
  // books.external_id is reserved for Open Library work identifiers — we do NOT
  // write "goodreads:{id}" there.  Provenance lives in book_source_links instead.
  const sidToRow = new Map<string, ImportRow>();
  for (const row of groupCreate) {
    const sid = sourceBookId(row);
    if (sid) sidToRow.set(sid, row);
  }

  const allSids = [...sidToRow.keys()];

  // Look up which Goodreads Book IDs already have a book row (from a previous import).
  // book_source_links is the authoritative provenance table for this mapping.
  const bookIdBySid = new Map<string, string>(); // Goodreads Book Id → books.id
  if (allSids.length > 0) {
    for (const chunk of chunkArray(allSids, 300)) {
      const { data: existingLinks } = await supabase
        .from('book_source_links')
        .select('source_book_id, book_id')
        .eq('source', 'goodreads')
        .in('source_book_id', chunk);
      (existingLinks ?? []).forEach((l: { source_book_id: string; book_id: string }) => {
        bookIdBySid.set(l.source_book_id, l.book_id);
      });
    }
  }

  // Title+author dedup guard (P1.5a-gated): catalog rows that are verified,
  // legacy, or this user's own prior inserts get reused so we don't create
  // duplicates. The pre-fix `normBookKey` (local, no subtitle strip) silently
  // missed Goodreads-shaped titles like "Royal Assassin (Farseer Trilogy, #2)"
  // against catalog "Royal Assassin"; the module-level normBookKey now strips
  // those before normalising. We deliberately keep the verified/legacy/own-user
  // gate — widening it would re-open the P1.5a poisoning vector.
  if (allSids.some(sid => !bookIdBySid.has(sid))) {
    const { data: existingBooks } = await supabase
      .from('books')
      .select('id, title, author')
      .or(`provenance_state.in.(verified,legacy),provenance_inserted_by.eq.${userId}`)
      .limit(10000);

    const existingByKey = new Map<string, string>();
    for (const b of (existingBooks ?? []) as { id: string; title: string; author: string | null }[]) {
      existingByKey.set(normBookKey(b.title, b.author), b.id);
    }

    for (const sid of allSids) {
      if (bookIdBySid.has(sid)) continue;
      const row = sidToRow.get(sid)!;
      const match = existingByKey.get(normBookKey(row.title!, row.author ?? ''));
      if (match) {
        console.log(`[goodreadsExecutor] title+author match for "${row.title}" — reusing book ${match.slice(0, 8)}`);
        bookIdBySid.set(sid, match);
      }
    }
  }

  // Insert books for sids still unresolved.
  //
  // Pre-fix this was one bulk INSERT per chunk-of-100 — atomic per statement,
  // so any single row violating a constraint/trigger/RLS aborted the entire
  // chunk and silently dropped up to 100 books per failure (Royal Assassin /
  // Ship of Destiny / Lightlark / Two Towers all hit this on the canonical
  // 273-row import). The old code also zip-by-index on the returned rows,
  // which silently misaligned book_id ↔ source_book_id when RLS filtered any
  // row. Fix: try the bulk path for speed; on error OR partial result, fall
  // back to per-row inserts so each row's failure is independent. Re-key by
  // normalised title+author rather than index in both paths.
  const newSids = allSids.filter(sid => !bookIdBySid.has(sid));

  function buildBookInsert(sid: string) {
    const row = sidToRow.get(sid)!;
    return {
      title:                     row.title!,
      author:                    row.author!,
      isbn:                      row.isbn   ?? null,
      isbn13:                    row.isbn13  ?? null,
      publisher:                 row.publisher ?? null,
      binding:                   row.binding ?? null,
      page_count:                null as number | null,
      publication_year:          row.publication_year ?? null,
      original_publication_year: row.original_publication_year ?? null,
      cover_url:                 null as string | null,
    };
  }

  const perRowInsertErrors = new Map<string, string>();

  for (const chunk of chunkArray(newSids, 100)) {
    const inserts = chunk.map(buildBookInsert);
    const { data: inserted, error: insertError } = await supabase
      .from('books')
      .insert(inserts)
      .select('id, title, author');

    if (!insertError && (inserted ?? []).length === chunk.length) {
      const insertedByKey = new Map<string, string>();
      for (const b of inserted as { id: string; title: string; author: string }[]) {
        insertedByKey.set(normBookKey(b.title, b.author), b.id);
      }
      for (const sid of chunk) {
        const row = sidToRow.get(sid)!;
        const id = insertedByKey.get(normBookKey(row.title!, row.author));
        if (id) bookIdBySid.set(sid, id);
      }
    } else {
      if (insertError) {
        console.warn(`[goodreadsExecutor] bulk book insert failed (${insertError.message}); retrying ${chunk.length} rows individually`);
      } else {
        console.warn(`[goodreadsExecutor] bulk book insert returned ${(inserted ?? []).length}/${chunk.length}; retrying remainder individually`);
        const insertedByKey = new Map<string, string>();
        for (const b of (inserted ?? []) as { id: string; title: string; author: string }[]) {
          insertedByKey.set(normBookKey(b.title, b.author), b.id);
        }
        for (const sid of chunk) {
          const row = sidToRow.get(sid)!;
          const id = insertedByKey.get(normBookKey(row.title!, row.author));
          if (id) bookIdBySid.set(sid, id);
        }
      }

      for (const sid of chunk) {
        if (bookIdBySid.has(sid)) continue;
        const { data: row, error: rowErr } = await supabase
          .from('books')
          .insert(buildBookInsert(sid))
          .select('id')
          .maybeSingle();
        if (row?.id) {
          bookIdBySid.set(sid, row.id);
        } else {
          perRowInsertErrors.set(sid, rowErr?.message ?? 'Insert returned no row (possible RLS filter)');
        }
      }
    }
  }

  // Attach resolved book_id to groupCreate rows.
  const createWithBookId: Array<{ row: ImportRow; bookId: string }> = [];
  for (const row of groupCreate) {
    const sid = sourceBookId(row);
    const bookId = sid ? bookIdBySid.get(sid) : undefined;
    if (bookId) {
      createWithBookId.push({ row, bookId });
    } else {
      counters.failed++;
      const reason = sid ? (perRowInsertErrors.get(sid) ?? 'Book could not be created') : 'Missing source_book_id';
      await supabase
        .from('import_rows')
        .update({ resolution: 'failed', error_message: reason, resolved_at: now })
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

  // user_books has UNIQUE(user_id, book_id). Pre-fix bulk INSERT was atomic
  // per statement — a single duplicate (e.g. when staging collapsed two
  // Goodreads source IDs to the same canonical books.id via shared ISBN13)
  // aborted the entire 100-row chunk and silently dropped real user_books
  // rows. UPSERT with onConflict ignoreDuplicates makes each row's outcome
  // independent. ignoreDuplicates is correct here — the merge path below
  // handles the "row already existed" case for pre-existing user_books;
  // collisions inside this insert batch are intra-import duplicates and
  // should be silently absorbed, not overwritten.
  for (const chunk of chunkArray(insertPayloads, 100)) {
    const { error: ubInsertError } = await supabase
      .from('user_books')
      .upsert(chunk, { onConflict: 'user_id,book_id', ignoreDuplicates: true });
    if (ubInsertError) {
      console.warn('[goodreadsExecutor] user_books bulk upsert error:', ubInsertError.message);
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

  // Update import_rows for inserted user_books. Counter increments only when
  // the post-insert fetch confirms a real user_book row — pre-fix, counters.added
  // fired unconditionally per toInsert entry, overstating success when the
  // bulk insert had silently dropped rows.
  //
  // Intra-batch duplicate collapse: when staging mapped two Goodreads source
  // IDs (different editions) to the same canonical books.id (typically via
  // shared ISBN13), both rows land in toInsert with the same book_id. The
  // upsert with ignoreDuplicates produces ONE user_books row, but pre-second-fix
  // both source rows would still receive `_resolution` and bump counters.added
  // — overcounting against a single physical write. Track first-seen book_ids
  // and demote subsequent same-book rows to resolution='skipped' / counters.skipped
  // so import_batches.imported_rows + skipped_rows + failed_rows still sums to
  // the staged total without claiming duplicate work.
  //
  // We also write matched_book_id back here so import_rows reflects what we
  // actually linked, regardless of whether the match happened during staging
  // or during executor recovery.
  const claimedBookIds = new Set<string>();
  for (const insertedRow of toInsert) {
    const ubId = newlyInsertedUBMap.get(insertedRow.book_id);
    if (!ubId) {
      counters.failed++;
      await supabase
        .from('import_rows')
        .update({
          resolution: 'failed',
          error_message: 'user_books row not found after insert (possible RLS or duplicate-collapse)',
          resolved_at: now,
        })
        .eq('id', insertedRow._importRowId);
      continue;
    }

    if (claimedBookIds.has(insertedRow.book_id)) {
      // Duplicate intra-batch source row → physical user_books already created
      // for the first occurrence. Link this import_row to the same user_book
      // (audit truth: the row WAS imported, just absorbed) but count as skipped
      // not added.
      counters.skipped++;
      await supabase
        .from('import_rows')
        .update({
          resolution: 'skipped',
          user_book_id: ubId,
          matched_book_id: insertedRow.book_id,
          error_message: 'Duplicate of another row in the same import (collapsed to one user_books entry)',
          resolved_at: now,
        })
        .eq('id', insertedRow._importRowId);
      continue;
    }

    claimedBookIds.add(insertedRow.book_id);
    counters.added++;
    await supabase
      .from('import_rows')
      .update({
        resolution: insertedRow._resolution,
        user_book_id: ubId,
        matched_book_id: insertedRow.book_id,
        resolved_at: now,
      })
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
