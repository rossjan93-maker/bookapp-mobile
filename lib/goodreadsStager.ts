// =============================================================================
// Goodreads Import Stager
// =============================================================================
// Writes parsed rows into import_batches + import_rows.
// Performs bulk matching against books / book_source_links before staging.
// Does NOT write to books or user_books — that is the execution pass.
// =============================================================================

import { supabase } from './supabase';
import type { ParsedGoodreadsRow } from './goodreadsParser';

export type MatchResult = {
  matchedBookId: string | null;
  matchConfidence: number;
  matchMethod: string | null;
};

export type StagedRowSummary = {
  title: string;
  author: string;
  resolution: string;
  reviewReason: string | null;
  matchedBookId: string | null;
  matchConfidence: number;
};

export type StageSummary = {
  batchId: string;
  totalRows: number;
  alreadyInApp: number;    // high-confidence match found in books table
  readyToImport: number;   // valid rows, no existing match (will be created)
  needsReview: number;     // missing/invalid data
  reviewRows: StagedRowSummary[];
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function bulkQueryISBN13(isbn13s: string[]): Promise<Map<string, string>> {
  if (!supabase || isbn13s.length === 0) return new Map();
  const map = new Map<string, string>();
  for (const chunk of chunkArray(isbn13s, 300)) {
    const { data } = await supabase
      .from('books')
      .select('id, isbn13')
      .in('isbn13', chunk);
    (data ?? []).forEach((b: { id: string; isbn13: string | null }) => {
      if (b.isbn13) map.set(b.isbn13, b.id);
    });
  }
  return map;
}

async function bulkQueryISBN(isbns: string[]): Promise<Map<string, string>> {
  if (!supabase || isbns.length === 0) return new Map();
  const map = new Map<string, string>();
  for (const chunk of chunkArray(isbns, 300)) {
    const { data } = await supabase
      .from('books')
      .select('id, isbn')
      .in('isbn', chunk);
    (data ?? []).forEach((b: { id: string; isbn: string | null }) => {
      if (b.isbn) map.set(b.isbn, b.id);
    });
  }
  return map;
}

async function bulkQueryGoodreadsLinks(goodreadsIds: string[]): Promise<Map<string, string>> {
  if (!supabase || goodreadsIds.length === 0) return new Map();
  const map = new Map<string, string>();
  for (const chunk of chunkArray(goodreadsIds, 300)) {
    const { data } = await supabase
      .from('book_source_links')
      .select('book_id, source_book_id')
      .eq('source', 'goodreads')
      .in('source_book_id', chunk);
    (data ?? []).forEach((l: { book_id: string; source_book_id: string }) => {
      map.set(l.source_book_id, l.book_id);
    });
  }
  return map;
}

// Strip parenthetical/colon/dash subtitle suffixes so Goodreads-shaped titles
// like "Royal Assassin (Farseer Trilogy, #2)" collapse to "Royal Assassin"
// before normalisation. Mirrors lib/goodreadsExecutor.ts:stripSubtitleLocal.
function stripSubtitleLocal(title: string): string {
  return title
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s*:\s+.*$/, '')
    .replace(/\s+\/\s+.*$/, '')
    .replace(/\s+[-\u2013\u2014]\s+.*$/, '')
    .trim();
}

export function normTitleAuthorKey(title: string, author: string | null): string {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${n(stripSubtitleLocal(title))}||${n((author ?? '').split(',')[0])}`;
}

// P1.5a-gated catalog snapshot for stager-side title+author fallback. Only
// returns books that are verified, legacy, or this user's own prior inserts —
// the same anti-poisoning gate the executor applies. Without this fallback,
// rows like "Royal Assassin (Farseer Trilogy, #2)" with no ISBN13 are forced
// into the executor's groupCreate path even when a clean catalog row exists.
async function bulkQueryTitleAuthor(userId: string): Promise<Map<string, string>> {
  if (!supabase) return new Map();
  const { data } = await supabase
    .from('books')
    .select('id, title, author')
    .or(`provenance_state.in.(verified,legacy),provenance_inserted_by.eq.${userId}`)
    .limit(10000);
  const map = new Map<string, string>();
  for (const b of (data ?? []) as { id: string; title: string; author: string | null }[]) {
    map.set(normTitleAuthorKey(b.title, b.author), b.id);
  }
  return map;
}

function resolveMatch(
  row: ParsedGoodreadsRow,
  isbn13Map: Map<string, string>,
  isbnMap: Map<string, string>,
  goodreadsMap: Map<string, string>,
  titleAuthorMap: Map<string, string>,
): MatchResult {
  // Priority 1: Goodreads source link (exact platform match)
  const gdBookId = goodreadsMap.get(row.source_book_id);
  if (gdBookId) {
    return { matchedBookId: gdBookId, matchConfidence: 1.0, matchMethod: 'goodreads_id' };
  }

  // Priority 2: ISBN-13 match
  if (row.isbn13) {
    const bookId = isbn13Map.get(row.isbn13);
    if (bookId) {
      return { matchedBookId: bookId, matchConfidence: 0.95, matchMethod: 'isbn13' };
    }
  }

  // Priority 3: ISBN match
  if (row.isbn) {
    const bookId = isbnMap.get(row.isbn);
    if (bookId) {
      return { matchedBookId: bookId, matchConfidence: 0.85, matchMethod: 'isbn' };
    }
  }

  // Priority 4: title+author fallback (P1.5a-gated, subtitle-stripped). Many
  // older Goodreads CSV rows have no ISBN/ISBN13 yet still correspond to a
  // catalog book. Without this, the executor's title+author dedup is the only
  // line of defence — and a single bulk-insert chunk failure there silently
  // drops the entire batch (see goodreadsExecutor fix).
  if (row.title) {
    const bookId = titleAuthorMap.get(normTitleAuthorKey(row.title, row.author));
    if (bookId) {
      return { matchedBookId: bookId, matchConfidence: 0.7, matchMethod: 'title_author' };
    }
  }

  return { matchedBookId: null, matchConfidence: 0, matchMethod: null };
}

function classifyResolution(
  row: ParsedGoodreadsRow,
  match: MatchResult,
): { resolution: string; reviewReason: string | null } {
  // Missing required fields → needs human review
  if (!row.title || !row.author) {
    return {
      resolution: 'review_needed',
      reviewReason: !row.title ? 'Missing title' : 'Missing author',
    };
  }
  // Valid row, may or may not have a match — all go to 'pending' for execution
  return { resolution: 'pending', reviewReason: null };
}

// ---------------------------------------------------------------------------
// loadStageSummary — reconstruct a StageSummary from an existing batch_id
// Used by the import screen when resuming from the in-app Goodreads browser.
// ---------------------------------------------------------------------------

export async function loadStageSummary(batchId: string): Promise<StageSummary> {
  if (!supabase) throw new Error('Supabase not configured.');

  // Get batch-level totals
  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .select('id, total_rows, review_needed')
    .eq('id', batchId)
    .single();

  if (batchErr || !batch) {
    throw new Error(`Import batch not found: ${batchErr?.message ?? 'unknown error'}`);
  }

  // Get row-level detail to reconstruct counts and review list
  const { data: rows, error: rowsErr } = await supabase
    .from('import_rows')
    .select('resolution, review_reason, matched_book_id, title, author, match_confidence')
    .eq('batch_id', batchId);

  if (rowsErr) {
    throw new Error(`Failed to load staging details: ${rowsErr.message}`);
  }

  let alreadyInApp = 0;
  let readyToImport = 0;
  let needsReview = 0;
  const reviewRows: StagedRowSummary[] = [];

  for (const row of rows ?? []) {
    if (row.resolution === 'review_needed') {
      needsReview++;
      reviewRows.push({
        title: row.title || '(no title)',
        author: row.author || '(no author)',
        resolution: 'review_needed',
        reviewReason: row.review_reason ?? null,
        matchedBookId: null,
        matchConfidence: 0,
      });
    } else if (row.matched_book_id) {
      alreadyInApp++;
    } else {
      readyToImport++;
    }
  }

  return {
    batchId,
    totalRows: batch.total_rows as number,
    alreadyInApp,
    readyToImport,
    needsReview,
    reviewRows,
  };
}

// ---------------------------------------------------------------------------
// Main export: stageGoodreadsImport
// ---------------------------------------------------------------------------

export async function stageGoodreadsImport(
  userId: string,
  parsedRows: ParsedGoodreadsRow[],
  filename: string,
): Promise<StageSummary> {
  if (!supabase) throw new Error('Supabase not configured.');

  // ── 1. Create import_batch ────────────────────────────────────────────────
  const { data: batchData, error: batchError } = await supabase
    .from('import_batches')
    .insert({
      user_id: userId,
      source: 'goodreads',
      filename,
      status: 'processing',
      total_rows: parsedRows.length,
    })
    .select('id')
    .single();

  if (batchError || !batchData) {
    throw new Error(`Failed to create import batch: ${batchError?.message ?? 'unknown error'}`);
  }

  const batchId = batchData.id as string;

  // ── 2. Bulk matching ──────────────────────────────────────────────────────
  const allGoodreadsIds = parsedRows.map(r => r.source_book_id).filter(Boolean);
  const allIsbn13s  = parsedRows.map(r => r.isbn13).filter((v): v is string => !!v);
  const allIsbns    = parsedRows.map(r => r.isbn).filter((v): v is string => !!v);

  const [goodreadsMap, isbn13Map, isbnMap, titleAuthorMap] = await Promise.all([
    bulkQueryGoodreadsLinks(allGoodreadsIds),
    bulkQueryISBN13(allIsbn13s),
    bulkQueryISBN(allIsbns),
    bulkQueryTitleAuthor(userId),
  ]);

  // ── 3. Build import_rows payload ──────────────────────────────────────────
  type ImportRowInsert = {
    batch_id: string;
    user_id: string;
    raw_data: Record<string, string>;
    title: string;
    author: string;
    additional_authors: string | null;
    isbn: string | null;
    isbn13: string | null;
    publisher: string | null;
    binding: string | null;
    publication_year: number | null;
    original_publication_year: number | null;
    date_read: string | null;
    date_added: string | null;
    exclusive_shelf: string;
    raw_shelves: string[];
    source_rating: number | null;
    review_body: string | null;
    read_count: number | null;
    owned_copies: number | null;
    matched_book_id: string | null;
    match_confidence: number;
    match_method: string | null;
    resolution: string;
    review_reason: string | null;
  };

  const rowPayloads: ImportRowInsert[] = [];
  const summaryRows: StagedRowSummary[] = [];

  let alreadyInApp = 0;
  let readyToImport = 0;
  let needsReview = 0;

  for (const row of parsedRows) {
    const match = resolveMatch(row, isbn13Map, isbnMap, goodreadsMap, titleAuthorMap);
    const { resolution, reviewReason } = classifyResolution(row, match);

    if (resolution === 'review_needed') {
      needsReview++;
      summaryRows.push({
        title: row.title || '(no title)',
        author: row.author || '(no author)',
        resolution,
        reviewReason,
        matchedBookId: null,
        matchConfidence: 0,
      });
    } else if (match.matchedBookId) {
      alreadyInApp++;
    } else {
      readyToImport++;
    }

    rowPayloads.push({
      batch_id: batchId,
      user_id: userId,
      raw_data: row.raw_data,
      title: row.title,
      author: row.author,
      additional_authors: row.additional_authors,
      isbn: row.isbn,
      isbn13: row.isbn13,
      publisher: row.publisher,
      binding: row.binding,
      publication_year: row.publication_year,
      original_publication_year: row.original_publication_year,
      date_read: row.date_read,
      date_added: row.date_added,
      exclusive_shelf: row.exclusive_shelf,
      raw_shelves: row.raw_shelves,
      source_rating: row.source_rating,
      review_body: row.review_body,
      read_count: row.read_count,
      owned_copies: row.owned_copies,
      matched_book_id: match.matchedBookId,
      match_confidence: match.matchConfidence,
      match_method: match.matchMethod,
      resolution,
      review_reason: reviewReason,
    });
  }

  // ── 4. Bulk insert import_rows (chunks of 100) ────────────────────────────
  for (const chunk of chunkArray(rowPayloads, 100)) {
    const { error } = await supabase.from('import_rows').insert(chunk);
    if (error) {
      // Mark batch as failed before throwing
      await supabase
        .from('import_batches')
        .update({ status: 'failed', error_message: error.message })
        .eq('id', batchId);
      throw new Error(`Failed to stage import rows: ${error.message}`);
    }
  }

  // ── 5. Finalize batch ─────────────────────────────────────────────────────
  await supabase
    .from('import_batches')
    .update({
      status: 'complete',
      imported_rows: 0,              // execution not yet run
      skipped_rows: 0,
      failed_rows: 0,
      review_needed: needsReview,
      completed_at: new Date().toISOString(),
    })
    .eq('id', batchId);

  return {
    batchId,
    totalRows: parsedRows.length,
    alreadyInApp,
    readyToImport,
    needsReview,
    reviewRows: summaryRows,
  };
}
