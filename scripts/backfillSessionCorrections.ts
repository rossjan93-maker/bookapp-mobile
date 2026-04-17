(global as any).__DEV__ = false;
// =============================================================================
// scripts/backfillSessionCorrections.ts
// =============================================================================
// One-time repair: realign reading_sessions raw sums with user_books.current_page
// for books whose history was corrupted by pre-migration silent reset failures.
//
// BACKGROUND
// ----------
// Before migration 20260413000000 was applied, the reading_sessions table had a
// strict CHECK constraint (reading_sessions_forward_progress) that rejected any
// row with negative pages_read or backward ended_page < started_page.  When a
// user reset a book to 0 (or rolled back), saveCurrentPage() attempted to
// insert a negative-delta correction row which the constraint silently rejected
// (the call is fire-and-forget after user_books.current_page is already
// updated).  Result: orphan FORWARD session rows whose sum exceeds the book's
// current_page.
//
// The read-time reconciliation cap in lib/pacing.ts and lib/readingWraps.ts
// keeps the displayed numbers correct, but the raw log is internally
// inconsistent.  This script appends a single SYNTHETIC correction row per
// affected book to bring sum(pages_read) back into agreement with current_page.
//
// SAFETY
// ------
// 1. Append-only — no existing rows are modified or deleted.
// 2. Dry-run by default — pass --apply to actually write.
// 3. Scoped per user — required --user-id argument; no global mode.
// 4. Reversible — every inserted row id is logged to .local/backfill-logs/
//    <timestamp>.json so the operation can be undone with a single delete.
// 5. Idempotent — re-running on a user already in agreement is a no-op.
// 6. Conservative direction — only fixes sum > current_page (orphan forwards).
//    Books with sum < current_page are reported but NOT auto-fixed (that
//    indicates a different bug — direct current_page edit without a matching
//    session — and needs manual product review).
// 7. The synthetic row is dated TODAY so it cannot become the firstStartedPage
//    of any prior month and therefore cannot perturb any historical wrap.
//
// CORRECTION ROW SHAPE
// --------------------
//   session_date  = today (UTC YYYY-MM-DD)
//   started_page  = sum(pages_read) before correction
//   ended_page    = current_page
//   pages_read    = current_page - sum(pages_read)   (negative)
//   duration_minutes = null
//
// started_page may be physically meaningless (e.g. > page_count) when the prior
// log is wildly inflated — that's intentional.  The row's purpose is purely
// arithmetic balance, and ended_page - started_page == pages_read is preserved
// for any future invariant checks.
//
// USAGE
// -----
//   npx tsx scripts/backfillSessionCorrections.ts --user-id=<uuid>
//   npx tsx scripts/backfillSessionCorrections.ts --user-id=<uuid> --apply
//
// REVERSAL
// --------
// To undo a run, take the array of inserted row ids from the JSON log and run:
//   delete from reading_sessions where id in ('<id1>','<id2>',...);
// =============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const LOG = '[BACKFILL_CORRECTIONS]';

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { userId: string | undefined; apply: boolean } {
  let userId: string | undefined;
  let apply = false;
  for (let i = 2; i < argv.length; i++) {
    const raw = argv[i];
    const eqIdx = raw.indexOf('=');
    const flag = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const inline = eqIdx >= 0 ? raw.slice(eqIdx + 1) : undefined;
    if (flag === '--apply') {
      apply = true;
    } else if (flag === '--user-id') {
      userId = inline ?? argv[++i];
    } else {
      console.error(`${LOG} Unknown flag: ${flag}`);
      process.exit(2);
    }
  }
  return { userId, apply };
}

// ── Types ────────────────────────────────────────────────────────────────────

type UserBookRow = {
  id: string;
  user_id: string;
  book_id: string;
  current_page: number | null;
};

type SessionRow = {
  id: string;
  user_book_id: string;
  pages_read: number;
};

type BookReport = {
  user_book_id: string;
  book_id: string;
  current_page: number;
  session_count: number;
  sum_before: number;
  delta: number;
  status: 'ok' | 'fixable' | 'underread' | 'no_sessions';
  inserted_row_id?: string;
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { userId, apply } = parseArgs(process.argv);
  if (!userId) {
    console.error(`${LOG} Missing required --user-id=<uuid>`);
    process.exit(2);
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    console.error(`${LOG} Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    process.exit(2);
  }

  const client: SupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`${LOG} mode=${apply ? 'APPLY' : 'DRY-RUN'} user=${userId}`);

  // 1. Load all of this user's user_books.
  const { data: ubData, error: ubErr } = await client
    .from('user_books')
    .select('id, user_id, book_id, current_page')
    .eq('user_id', userId);
  if (ubErr) throw ubErr;
  const userBooks = (ubData ?? []) as UserBookRow[];
  console.log(`${LOG} loaded ${userBooks.length} user_books`);

  // 2. Load all reading_sessions for this user (one round-trip).
  const { data: sData, error: sErr } = await client
    .from('reading_sessions')
    .select('id, user_book_id, pages_read')
    .eq('user_id', userId);
  if (sErr) throw sErr;
  const sessions = (sData ?? []) as SessionRow[];
  console.log(`${LOG} loaded ${sessions.length} reading_sessions`);

  // 3. Group sessions by user_book and compute sums.
  const sumsByBook = new Map<string, { sum: number; count: number }>();
  for (const s of sessions) {
    const cur = sumsByBook.get(s.user_book_id) ?? { sum: 0, count: 0 };
    cur.sum += s.pages_read;
    cur.count += 1;
    sumsByBook.set(s.user_book_id, cur);
  }

  // 4. Classify each book.
  const reports: BookReport[] = [];
  for (const ub of userBooks) {
    const cp = ub.current_page ?? 0;
    const agg = sumsByBook.get(ub.id) ?? { sum: 0, count: 0 };
    const delta = cp - agg.sum;

    let status: BookReport['status'];
    if (agg.count === 0) {
      status = cp > 0 ? 'no_sessions' : 'ok';
    } else if (delta === 0) {
      status = 'ok';
    } else if (delta < 0) {
      status = 'fixable'; // sum > current_page (orphan forward)
    } else {
      status = 'underread'; // sum < current_page — different bug, skip
    }

    reports.push({
      user_book_id: ub.id,
      book_id: ub.book_id,
      current_page: cp,
      session_count: agg.count,
      sum_before: agg.sum,
      delta,
      status,
    });
  }

  // 5. Print classification summary.
  const counts = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`${LOG} classification:`, counts);

  const fixables = reports.filter((r) => r.status === 'fixable');
  const underread = reports.filter((r) => r.status === 'underread');
  if (underread.length) {
    console.log(`${LOG} ${underread.length} book(s) have sum < current_page — NOT auto-fixed:`);
    for (const r of underread) {
      console.log(
        `  ${LOG}   user_book=${r.user_book_id} cp=${r.current_page} sum=${r.sum_before} delta=+${r.delta}`,
      );
    }
  }

  if (!fixables.length) {
    console.log(`${LOG} no fixable books — nothing to do.`);
    return;
  }

  console.log(`${LOG} ${fixables.length} fixable book(s):`);
  for (const r of fixables) {
    console.log(
      `  ${LOG}   user_book=${r.user_book_id} cp=${r.current_page} sum=${r.sum_before} delta=${r.delta}`,
    );
  }

  if (!apply) {
    console.log(`${LOG} dry-run — not writing.  Re-run with --apply to insert correction rows.`);
    return;
  }

  // 6. Build correction-row payloads.
  const today = new Date();
  const sessionDate = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
  const payloads = fixables.map((r) => ({
    user_id: userId,
    book_id: r.book_id,
    user_book_id: r.user_book_id,
    session_date: sessionDate,
    started_page: r.sum_before,
    ended_page: r.current_page,
    pages_read: r.delta, // negative
    duration_minutes: null,
  }));

  // 7. Insert.
  const { data: insData, error: insErr } = await client
    .from('reading_sessions')
    .insert(payloads)
    .select('id, user_book_id, pages_read, session_date');
  if (insErr) {
    console.error(`${LOG} INSERT FAILED:`, insErr);
    throw insErr;
  }
  const inserted = insData ?? [];
  console.log(`${LOG} inserted ${inserted.length} correction row(s).`);

  // Attach inserted ids to reports.
  for (const row of inserted) {
    const r = fixables.find((f) => f.user_book_id === row.user_book_id);
    if (r) r.inserted_row_id = row.id as string;
  }

  // 8. Verify per-book sums now equal current_page.
  const fixedBookIds = fixables.map((r) => r.user_book_id);
  const { data: vData, error: vErr } = await client
    .from('reading_sessions')
    .select('user_book_id, pages_read')
    .in('user_book_id', fixedBookIds);
  if (vErr) throw vErr;
  const verifySums = new Map<string, number>();
  for (const row of vData ?? []) {
    verifySums.set(
      row.user_book_id as string,
      (verifySums.get(row.user_book_id as string) ?? 0) + (row.pages_read as number),
    );
  }
  let allMatch = true;
  console.log(`${LOG} post-insert verification:`);
  for (const r of fixables) {
    const newSum = verifySums.get(r.user_book_id) ?? 0;
    const ok = newSum === r.current_page;
    if (!ok) allMatch = false;
    console.log(
      `  ${LOG}   user_book=${r.user_book_id} cp=${r.current_page} new_sum=${newSum} ${ok ? 'OK' : 'MISMATCH'}`,
    );
  }
  console.log(`${LOG} verification ${allMatch ? 'PASSED' : 'FAILED'}.`);

  // 9. Write reversibility log.
  const logDir = path.join(process.cwd(), '.local', 'backfill-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = today.toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `backfill-${userId}-${stamp}.json`);
  const logBody = {
    timestamp: today.toISOString(),
    user_id: userId,
    mode: 'apply',
    inserted_row_ids: fixables.map((r) => r.inserted_row_id).filter(Boolean),
    reports,
    reversal_sql: `delete from reading_sessions where id in (${fixables
      .map((r) => `'${r.inserted_row_id}'`)
      .join(', ')});`,
  };
  fs.writeFileSync(logPath, JSON.stringify(logBody, null, 2));
  console.log(`${LOG} wrote reversibility log: ${logPath}`);
}

main().catch((err) => {
  console.error(`${LOG} FATAL:`, err);
  process.exit(1);
});
