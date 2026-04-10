// =============================================================================
// Dev Inspector — lightweight operator tooling
// =============================================================================
//
// Exposes inspection functions on window.__rs for use from the browser console
// during development and testing sessions.
//
// Setup (called automatically in library.tsx when __DEV__ is true):
//   ✓ mounted → call site logs: window.__rs.{covers, summaries, credibility, health}
//
// Usage from browser DevTools console:
//   __rs.covers()       — books with no cover_url
//   __rs.summaries()    — books with no description
//   __rs.credibility()  — books whose stored cover URL fails the allowlist check
//   __rs.health()       — provider health counters since last reset
//   __rs.all()          — runs all four in sequence
//
// All functions are no-ops unless running in a dev context.
// No persistence, no DB writes — purely read-only observation.
//
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { validateCoverUrl, coverCredibilityLabel } from './coverCredibility';
import { logProviderHealthSummary } from './providerHealth';
import { inferReadState, computeSessionPacing, formatProjectedFinish, type SessionRow } from './pacing';
import { computeStreaks } from './streaks';

const PREFIX = '[INSPECTOR]';

// ── Shared query helpers ───────────────────────────────────────────────────────

type BookRow = {
  id:           string;
  title:        string | null;
  author:       string | null;
  cover_url:    string | null;
  cover_source: string | null;
  description:  string | null;
};

async function fetchAllBooks(client: SupabaseClient): Promise<BookRow[]> {
  const { data, error } = await client
    .from('books')
    .select('id, title, author, cover_url, cover_source, description')
    .order('title', { ascending: true });

  if (error) {
    console.log(`${PREFIX} fetch error — ${error.message}`);
    return [];
  }
  return (data ?? []) as BookRow[];
}

// ── Individual inspection functions ───────────────────────────────────────────

/**
 * Logs books with no cover_url, grouped by cover_source.
 * Use to find candidates for the repair loop.
 */
export async function inspectMissingCovers(client: SupabaseClient): Promise<void> {
  const all     = await fetchAllBooks(client);
  const missing = all.filter(b => !b.cover_url);

  if (missing.length === 0) {
    console.log(`${PREFIX} covers — no books with missing cover ✓`);
    return;
  }

  console.log(`${PREFIX} covers — ${missing.length} book(s) with no cover_url:`);
  for (const b of missing) {
    console.log(
      `  id=${b.id.slice(0, 8)}  source=${b.cover_source ?? 'null'}  ` +
      `"${(b.title ?? '').slice(0, 50)}" / ${b.author ?? '?'}`,
    );
  }
}

/**
 * Logs books with no description, grouped by whether they have a cover
 * (cover-only books are lower priority to re-fetch).
 */
export async function inspectMissingSummaries(client: SupabaseClient): Promise<void> {
  const all     = await fetchAllBooks(client);
  const missing = all.filter(b => !b.description);

  if (missing.length === 0) {
    console.log(`${PREFIX} summaries — no books with missing description ✓`);
    return;
  }

  const withCover    = missing.filter(b => !!b.cover_url);
  const withoutCover = missing.filter(b => !b.cover_url);

  console.log(
    `${PREFIX} summaries — ${missing.length} book(s) with no description` +
    ` (${withCover.length} have covers, ${withoutCover.length} have neither):`,
  );

  for (const b of missing.slice(0, 20)) {
    const hasCover = b.cover_url ? '✓cover' : '✗cover';
    console.log(
      `  [${hasCover}] id=${b.id.slice(0, 8)}  ` +
      `"${(b.title ?? '').slice(0, 50)}" / ${b.author ?? '?'}`,
    );
  }

  if (missing.length > 20) {
    console.log(`  … and ${missing.length - 20} more`);
  }
}

/**
 * Scans all books whose cover_url is set and checks each against the
 * credibility allowlist. Logs any that would trigger the typographic fallback.
 * This does NOT fire network requests — it's a pure URL pattern check.
 */
export async function inspectCredibilityRejections(client: SupabaseClient): Promise<void> {
  const all          = await fetchAllBooks(client);
  const withCover    = all.filter(b => !!b.cover_url);
  const rejected     = withCover.filter(b => !validateCoverUrl(b.cover_url).valid);

  if (rejected.length === 0) {
    console.log(
      `${PREFIX} credibility — all ${withCover.length} cover URLs pass the allowlist ✓`,
    );
    return;
  }

  console.log(
    `${PREFIX} credibility — ${rejected.length}/${withCover.length} cover URLs` +
    ` fail allowlist (will show typographic fallback):`,
  );

  const byReason: Record<string, BookRow[]> = {};
  for (const b of rejected) {
    const reason = coverCredibilityLabel(b.cover_url);
    (byReason[reason] ??= []).push(b);
  }

  for (const [reason, books] of Object.entries(byReason)) {
    console.log(`  Reason: ${reason} (${books.length} books)`);
    for (const b of books.slice(0, 5)) {
      console.log(
        `    id=${b.id.slice(0, 8)}  source=${b.cover_source ?? 'null'}  ` +
        `url=${(b.cover_url ?? '').slice(0, 60)}  ` +
        `"${(b.title ?? '').slice(0, 40)}"`,
      );
    }
    if (books.length > 5) {
      console.log(`    … and ${books.length - 5} more`);
    }
  }
}

// ── Pacing + state inspection ─────────────────────────────────────────────────

/**
 * Inspect session data, read state, and projected finish for a given user_book.
 * Usage:  __rs.pacing('<user_book_id>')
 *
 * Logs:
 *   - Read state inference (active / paused / stalled)
 *   - All reading_sessions rows (date, pages, cumulative total)
 *   - Session-based pace and projected finish when data is sufficient
 */
export async function inspectPacing(
  client: SupabaseClient,
  userBookId: string,
): Promise<void> {
  // Fetch user_books row for state inference
  const { data: ub, error: ubErr } = await client
    .from('user_books')
    .select('status, started_at, finished_at, current_page, progress_updated_at, book_id, book:books(title, author, page_count)')
    .eq('id', userBookId)
    .single();

  if (ubErr || !ub) {
    console.log(`${PREFIX} pacing — user_book not found (${userBookId.slice(0, 8)})`);
    return;
  }

  const book = ub.book as { title?: string; author?: string; page_count?: number | null } | null;
  console.log(`${PREFIX} pacing — "${book?.title ?? '?'}" by ${book?.author ?? '?'}`);
  console.log(`  user_book_id: ${userBookId.slice(0, 8)}`);
  console.log(`  status: ${ub.status}  current_page: ${ub.current_page ?? 'n/a'}  page_count: ${book?.page_count ?? 'n/a'}`);
  console.log(`  started_at: ${ub.started_at ?? 'n/a'}  progress_updated_at: ${ub.progress_updated_at ?? 'n/a'}`);

  const readState = inferReadState({
    status:            ub.status,
    progressUpdatedAt: ub.progress_updated_at,
    startedAt:         ub.started_at,
    currentPage:       ub.current_page,
  });
  console.log(`  read_state: ${readState}`);

  // Fetch sessions
  const { data: sessions, error: sessErr } = await client
    .from('reading_sessions')
    .select('session_date, started_page, ended_page, pages_read, created_at')
    .eq('user_book_id', userBookId)
    .order('session_date', { ascending: true })
    .order('created_at',   { ascending: true });

  if (sessErr) {
    console.log(`  sessions — fetch error: ${sessErr.message}`);
    return;
  }

  const rows = (sessions ?? []) as Array<{
    session_date: string; started_page: number; ended_page: number; pages_read: number; created_at: string;
  }>;

  if (!rows.length) {
    console.log('  sessions — none recorded yet (no forward page updates since migration)');
    return;
  }

  let cumulative = 0;
  console.log(`  sessions (${rows.length}):`);
  for (const s of rows) {
    cumulative += s.pages_read;
    console.log(
      `    ${s.session_date}  pp.${s.started_page}→${s.ended_page}` +
      `  +${s.pages_read} pages  (cumulative: ${cumulative})`,
    );
  }

  const pageCount = book?.page_count;
  const pacing = (pageCount && ub.current_page)
    ? computeSessionPacing(
        rows.map(r => ({ session_date: r.session_date, pages_read: r.pages_read })),
        ub.current_page,
        pageCount,
      )
    : null;

  if (!pacing) {
    console.log('  pace estimate — unavailable (insufficient page data)');
    return;
  }

  console.log(
    `  pace estimate (${pacing.strength}):` +
    `  ${pacing.pagesPerDay} ppd  →  ~${pacing.pagesLeft} pages left` +
    `  →  finish ${formatProjectedFinish(pacing.estimatedFinish)}`,
  );
}

/**
 * Inspect reading streaks for the signed-in user.
 * Usage:  __rs.streaks()
 *
 * Logs current streak, longest streak, and the last 10 reading days.
 */
export async function inspectStreaks(client: SupabaseClient): Promise<void> {
  const { data: { user } } = await client.auth.getUser();
  if (!user) {
    console.log(`${PREFIX} streaks — not signed in`);
    return;
  }

  const { data, error } = await client
    .from('reading_sessions')
    .select('session_date, pages_read')
    .eq('user_id', user.id)
    .gt('pages_read', 0)
    .order('session_date', { ascending: true });

  if (error) {
    console.log(`${PREFIX} streaks — fetch error: ${error.message}`);
    return;
  }

  const rows = (data ?? []) as Array<{ session_date: string; pages_read: number }>;
  if (!rows.length) {
    console.log(`${PREFIX} streaks — no sessions recorded yet (reading_sessions table is empty for this user)`);
    return;
  }

  const dates  = rows.map(r => r.session_date);
  const result = computeStreaks(dates);

  console.log(`${PREFIX} streaks — current: ${result.current} day${result.current !== 1 ? 's' : ''}  |  longest: ${result.longest} day${result.longest !== 1 ? 's' : ''}`);

  // Count pages per day
  const pagesByDay = new Map<string, number>();
  for (const r of rows) {
    pagesByDay.set(r.session_date, (pagesByDay.get(r.session_date) ?? 0) + r.pages_read);
  }

  const uniqueDays = [...new Set(dates)].sort().slice(-10);
  console.log(`  last ${uniqueDays.length} reading day(s):`);
  for (const d of uniqueDays) {
    console.log(`    ${d}  ${pagesByDay.get(d) ?? 0} pages`);
  }
}

// ── Global registration ────────────────────────────────────────────────────────

/**
 * Mounts all inspection functions on globalThis.__rs for browser console access.
 * Call this once in a dev context (library.tsx useEffect when __DEV__ is true).
 *
 * After mounting:
 *   __rs.covers()       — books with no cover
 *   __rs.summaries()    — books with no description
 *   __rs.credibility()  — covers failing the allowlist
 *   __rs.health()       — provider health counters
 *   __rs.all()          — run all four
 */
export function mountDevInspector(client: SupabaseClient): void {
  const rs = {
    covers:      () => inspectMissingCovers(client),
    summaries:   () => inspectMissingSummaries(client),
    credibility: () => inspectCredibilityRejections(client),
    health:      () => logProviderHealthSummary(),
    pacing:      (userBookId: string) => inspectPacing(client, userBookId),
    streaks:     () => inspectStreaks(client),
    all:         async () => {
      await inspectMissingCovers(client);
      await inspectMissingSummaries(client);
      await inspectCredibilityRejections(client);
      logProviderHealthSummary();
    },
  };

  (globalThis as unknown as Record<string, unknown>).__rs = rs;

  console.log(
    `${PREFIX} mounted → __rs.{covers, summaries, credibility, health, pacing, streaks, all}`,
  );
}
