/**
 * Repair utility for incorrect user_books.finished_at timestamps.
 *
 * Root cause of bad data:
 *   Before the date-integrity fix, transitionStatus() always wrote
 *   finished_at = now() when a book was marked finished, overwriting
 *   the real Goodreads-imported date.  Books finished in 2022 would
 *   therefore show finished_at = 2026 and be counted in this year's goal.
 *
 * Repair strategy:
 *   1. Find all user_books with status='finished' and finished_at in the
 *      current calendar year.
 *   2. Cross-reference each row with its linked import_row (via
 *      import_rows.user_book_id) to find the original Goodreads date_read.
 *   3. Where date_read is from a prior year, update finished_at to that date.
 *   4. Where no import date exists, flag for user review.
 *   5. Detect any duplicate (user_id, book_id) combos (shouldn't exist due
 *      to the DB unique constraint, but worth auditing).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type RepairAction =
  | 'repair_goodreads'  // import_rows has a prior-year date → will be fixed
  | 'no_source_flag'    // no reliable date source → user must decide
  | 'already_correct';  // import date agrees this is a current-year finish

export interface AuditRow {
  userBookId:         string;
  bookId:             string;
  title:              string;
  author:             string;
  currentFinishedAt:  string;
  importDateRead:     string | null;
  importSource:       string | null;
  action:             RepairAction;
  proposedFinishedAt: string | null;
  note:               string;
}

export interface DuplicateRow {
  bookId:  string;
  title:   string;
  count:   number;
}

export interface AuditReport {
  toRepair:   AuditRow[];
  toFlag:     AuditRow[];
  alreadyOk:  AuditRow[];
  duplicates: DuplicateRow[];
}

function dateToTimestamptz(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function currentYearStart(): string {
  return `${new Date().getFullYear()}-01-01T00:00:00Z`;
}

export async function auditFinishedDates(
  sb: SupabaseClient,
  userId: string,
): Promise<AuditReport> {
  const CURRENT_YEAR = new Date().getFullYear();
  const yearStart    = currentYearStart();

  // ── 1. All finished-this-year rows ─────────────────────────────────────────
  const { data: rows, error } = await sb
    .from('user_books')
    .select('id, book_id, finished_at, import_source, import_batch_id, book:books(title, author, external_id)')
    .eq('user_id', userId)
    .eq('status', 'finished')
    .gte('finished_at', yearStart);

  if (error || !rows || rows.length === 0) {
    return { toRepair: [], toFlag: [], alreadyOk: [], duplicates: [] };
  }

  const userBookIds = (rows as any[]).map(r => r.id as string);

  // ── 2. Fetch import_rows for these user_books ───────────────────────────────
  // Multiple import_rows may exist per user_book (e.g. two imports of same book).
  // We take the most confident match that has a date_read.
  const { data: importRows } = await sb
    .from('import_rows')
    .select('user_book_id, date_read, exclusive_shelf, match_confidence')
    .in('user_book_id', userBookIds)
    .not('date_read', 'is', null)
    .order('match_confidence', { ascending: false });

  // Build best-match map: user_book_id → most confident import row
  const importMap = new Map<string, { date_read: string }>();
  for (const ir of (importRows ?? []) as any[]) {
    if (!importMap.has(ir.user_book_id) && ir.date_read) {
      importMap.set(ir.user_book_id, ir);
    }
  }

  // ── 3. Classify each row ───────────────────────────────────────────────────
  const toRepair:  AuditRow[] = [];
  const toFlag:    AuditRow[] = [];
  const alreadyOk: AuditRow[] = [];

  for (const row of (rows as any[])) {
    const book = row.book as any;
    const ir   = importMap.get(row.id as string);
    const base = {
      userBookId:        row.id as string,
      bookId:            row.book_id as string,
      title:             (book?.title ?? '') as string,
      author:            (book?.author ?? '') as string,
      currentFinishedAt: row.finished_at as string,
      importSource:      (row.import_source ?? null) as string | null,
    };

    if (ir?.date_read) {
      const readYear = new Date(ir.date_read as string).getFullYear();
      if (readYear < CURRENT_YEAR) {
        toRepair.push({
          ...base,
          importDateRead:     ir.date_read as string,
          action:             'repair_goodreads',
          proposedFinishedAt: dateToTimestamptz(ir.date_read as string),
          note: `Goodreads date_read = ${ir.date_read} (${readYear}) — currently shows as ${CURRENT_YEAR}`,
        });
      } else {
        alreadyOk.push({
          ...base,
          importDateRead:     ir.date_read as string,
          action:             'already_correct',
          proposedFinishedAt: null,
          note: `Goodreads date_read = ${ir.date_read} confirms ${CURRENT_YEAR}`,
        });
      }
    } else {
      const isGoodreads = row.import_source === 'goodreads';
      toFlag.push({
        ...base,
        importDateRead:     null,
        action:             'no_source_flag',
        proposedFinishedAt: null,
        note: isGoodreads
          ? 'Goodreads import — no date_read in CSV; cannot verify automatically'
          : 'Manually added — user selected this year or unknown date',
      });
    }
  }

  // ── 4. Duplicate check ─────────────────────────────────────────────────────
  // The DB unique(user_id, book_id) constraint prevents true duplicates, but
  // we still surface any anomalies for transparency.
  const { data: allFinished } = await sb
    .from('user_books')
    .select('book_id, book:books(title)')
    .eq('user_id', userId)
    .eq('status', 'finished');

  const bookCount = new Map<string, number>();
  for (const r of (allFinished ?? []) as any[]) {
    bookCount.set(r.book_id, (bookCount.get(r.book_id) ?? 0) + 1);
  }

  const duplicates: DuplicateRow[] = [];
  for (const [bookId, count] of bookCount.entries()) {
    if (count > 1) {
      const row = (allFinished as any[]).find((r: any) => r.book_id === bookId);
      duplicates.push({ bookId, title: (row?.book as any)?.title ?? bookId, count });
    }
  }

  return { toRepair, toFlag, alreadyOk, duplicates };
}

export async function applyGoodreadsRepairs(
  sb: SupabaseClient,
  userId: string,
  repairs: AuditRow[],
): Promise<{ fixed: number; errors: string[] }> {
  const toFix  = repairs.filter(r => r.action === 'repair_goodreads' && r.proposedFinishedAt);
  const errors: string[] = [];
  let fixed = 0;

  for (const row of toFix) {
    const { error } = await sb
      .from('user_books')
      .update({ finished_at: row.proposedFinishedAt })
      .eq('id', row.userBookId)
      .eq('user_id', userId);

    if (error) {
      errors.push(`"${row.title}": ${error.message}`);
    } else {
      fixed++;
    }
  }

  return { fixed, errors };
}

export async function clearFinishedAt(
  sb: SupabaseClient,
  userId: string,
  userBookIds: string[],
): Promise<{ cleared: number; errors: string[] }> {
  const errors: string[] = [];
  let cleared = 0;

  for (const ubId of userBookIds) {
    const { error } = await sb
      .from('user_books')
      .update({ finished_at: null })
      .eq('id', ubId)
      .eq('user_id', userId);

    if (error) {
      errors.push(error.message);
    } else {
      cleared++;
    }
  }

  return { cleared, errors };
}
