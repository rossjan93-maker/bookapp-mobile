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

function resolveMatch(
  row: ParsedGoodreadsRow,
  isbn13Map: Map<string, string>,
  isbnMap: Map<string, string>,
  goodreadsMap: Map<string, string>,
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

  const [goodreadsMap, isbn13Map, isbnMap] = await Promise.all([
    bulkQueryGoodreadsLinks(allGoodreadsIds),
    bulkQueryISBN13(allIsbn13s),
    bulkQueryISBN(allIsbns),
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
    const match = resolveMatch(row, isbn13Map, isbnMap, goodreadsMap);
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
