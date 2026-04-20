/**
 * Reading Wrap computation — monthly and yearly summaries derived from
 * reading_sessions data.
 *
 * Design principles:
 *   - Pure functions only.  No I/O, no side effects, fully testable.
 *   - All stats derived directly from real session rows — never faked/mocked.
 *   - Honest about data coverage: the session window is typically 90 days.
 *     `booksFinished` is supplied externally from a full-year user_books query
 *     so the goal tracker is always accurate.
 *   - Reflective, calm tone in insight copy.  Not gamified.
 *
 * Sections:
 *   A. Shared types
 *   B. Monthly wrap computation
 *   C. Yearly wrap computation
 *   D. Reader insights derivation
 */

import { computeStreaks } from './streaks';
import { activeSegment } from './sessionSegment';

// =============================================================================
// A. Shared types
// =============================================================================

/**
 * A single reading session row, optionally enriched with the user_book_id so
 * per-book aggregations work.  This is the canonical input shape accepted by
 * all wrap functions.
 *
 * `pages_read` may be negative — those are correction rows written by
 * saveCurrentPage when the user reduces their progress.  `started_page` is
 * the user's page-position before this session and is used by the
 * reconciliation cap (see `aggregatePeriod`) as the per-book baseline for the
 * period.
 */
export type WrapSession = {
  session_date: string;   // 'YYYY-MM-DD' local date
  pages_read: number;     // forward sessions positive; corrections negative
  started_page?: number;  // page-position before this session (default 0)
  user_book_id?: string;  // omit if not available — book-level stats degrade gracefully
};

/**
 * Internal aggregation result over a set of session rows for a single period
 * (month or year).  All metrics here have the per-book reconciliation cap
 * already applied — the wrap functions just shape this into their public type.
 */
export type PeriodAggregate = {
  pagesRead:           number;
  readingDays:         number;
  sessionCount:        number;
  longestSessionPages: number | null;
  /** bookId → effective contribution after cap (always ≥ 0) */
  contributionByBook:  Record<string, number>;
  /** Dates with positive net pages from at least one active book. Sorted asc. */
  activeReadingDates:  string[];
};

/**
 * Aggregate session rows for a single period (month or year), applying a
 * per-book reconciliation cap so that the metrics reflect the user's actual
 * current state — not the raw forward sessions log.
 *
 * Why this exists: if a user reset a book's progress before the
 * `pages_read != 0` constraint was relaxed (migration 20260413000000), the
 * negative correction row may not have been written, leaving orphan forward
 * sessions in the log.  A naïve sum would still credit those pages even
 * though `current_page` shows the book is back at zero.  This function caps
 * each book's contribution to what `current_page` actually justifies.
 *
 * Per-book contribution formula (when current_page is known):
 *   contribution = max(0, min(net_session_pages_in_period,
 *                             current_page − started_page_of_first_session))
 *
 * - The first session's `started_page` is the page-position at the start of
 *   the period for that book.
 * - `current_page − first.started_page` is the maximum forward progress that
 *   could have been made in this period.
 * - We also cap at `net_session_pages` so we never credit more than the
 *   sessions log itself recorded (e.g. out-of-band manual edits don't
 *   inflate session-derived stats).
 *
 * When `currentPageByBook` is not provided OR the book is missing from it,
 * we fall back to `max(0, net_session_pages)` — the legacy net-sum model.
 * This keeps every existing caller backward-compatible.
 *
 * Sessions without a `user_book_id` (legacy / unknown) are summed in
 * uncapped — they cannot be reconciled against any book.
 */
export function aggregatePeriod(
  rows: WrapSession[],
  currentPageByBook?: Record<string, number | null>,
): PeriodAggregate {
  // ── Group rows by book ────────────────────────────────────────────────────
  const rowsByBook: Record<string, WrapSession[]> = {};
  const noBookRows: WrapSession[] = [];
  for (const r of rows) {
    if (r.user_book_id) {
      if (!rowsByBook[r.user_book_id]) rowsByBook[r.user_book_id] = [];
      rowsByBook[r.user_book_id].push(r);
    } else {
      noBookRows.push(r);
    }
  }

  // ── Per-book effective contribution (with cap) ────────────────────────────
  const contributionByBook: Record<string, number> = {};
  const activeBookIds = new Set<string>();
  // Per-book ACTIVE SEGMENT — the rows after the most-recent reset-to-0 in
  // this period (or all rows when no reset occurred).  Used downstream so
  // reading days, session count, and longest-session all agree on the same
  // "still counts" set as the contribution math.  See lib/sessionSegment.ts.
  const activeRowsByBook: Record<string, WrapSession[]> = {};

  for (const [bookId, bookRows] of Object.entries(rowsByBook)) {
    const active = activeSegment(bookRows);
    activeRowsByBook[bookId] = active;
    const netSessions = active.reduce((sum, r) => sum + r.pages_read, 0);
    const cp = currentPageByBook?.[bookId];

    let contribution: number;
    if (cp == null) {
      // No reconciliation possible — use legacy net-sum, clamped to 0
      contribution = Math.max(0, netSessions);
    } else if (active.length < bookRows.length) {
      // A reset-to-0 occurred inside this period — baseline is unconditionally
      // 0 inside the active segment.  Cap at current_page, the most the user
      // could possibly have re-read since the reset.  Pre-reset rows are
      // intentionally dropped: per product semantics, "reset to 0 = start
      // over", so pages that were undone don't count toward this period.
      contribution = Math.max(0, Math.min(netSessions, cp));
    } else {
      // No reset this period — anchor on the first POSITIVE-delta row in the
      // segment, not first-by-date.  Negative-delta rows (organic partial
      // corrections from saveCurrentPage, or synthetic backfill rows) carry
      // a started_page reflecting the pre-correction position, which would
      // inflate the cap base if used.  Falls back to the first row when no
      // positive-delta row exists — contribution is then correctly clamped
      // to 0 for correction-only periods.
      const firstForward = active.find((r) => r.pages_read > 0) ?? active[0];
      const firstStartedPage = firstForward.started_page ?? 0;
      const headroom = cp - firstStartedPage;
      contribution = Math.max(0, Math.min(netSessions, headroom));
    }

    contributionByBook[bookId] = contribution;
    if (contribution > 0) activeBookIds.add(bookId);
  }

  // Unbooked rows: sum into total but don't participate in book-level metrics
  const unbookedNet = Math.max(0, noBookRows.reduce((s, r) => s + r.pages_read, 0));

  // ── Total pages (sum of capped contributions) ─────────────────────────────
  const pagesRead =
    Object.values(contributionByBook).reduce((s, c) => s + c, 0) + unbookedNet;

  // ── Reading days: dates where any active book has positive net ────────────
  // A date is a reading day if at least one active book contributed positive
  // net pages on it.  Books that were rolled back to zero contribute no days.
  // Reading days, session count, and longest-session all read from the
  // per-book ACTIVE SEGMENT — pre-reset rows are intentionally dropped so
  // every metric agrees with the contribution math.
  const dateNetByActive: Record<string, number> = {};
  for (const bookId of activeBookIds) {
    for (const r of activeRowsByBook[bookId]) {
      dateNetByActive[r.session_date] =
        (dateNetByActive[r.session_date] ?? 0) + r.pages_read;
    }
  }
  for (const r of noBookRows) {
    dateNetByActive[r.session_date] =
      (dateNetByActive[r.session_date] ?? 0) + r.pages_read;
  }
  const activeReadingDates = Object.entries(dateNetByActive)
    .filter(([, net]) => net > 0)
    .map(([d]) => d)
    .sort();
  const readingDays = activeReadingDates.length;

  // ── Session count: forward sessions on active books only ──────────────────
  // Corrections aren't user-visible events.  Sessions for rolled-back books
  // are excluded — the user effectively undid them.
  let sessionCount = 0;
  let longestSessionPages: number | null = null;

  for (const bookId of activeBookIds) {
    for (const r of activeRowsByBook[bookId]) {
      if (r.pages_read > 0) {
        sessionCount++;
        if (longestSessionPages == null || r.pages_read > longestSessionPages) {
          longestSessionPages = r.pages_read;
        }
      }
    }
  }
  for (const r of noBookRows) {
    if (r.pages_read > 0) {
      sessionCount++;
      if (longestSessionPages == null || r.pages_read > longestSessionPages) {
        longestSessionPages = r.pages_read;
      }
    }
  }

  return {
    pagesRead,
    readingDays,
    sessionCount,
    longestSessionPages,
    contributionByBook,
    activeReadingDates,
  };
}

/**
 * Minimal book reference.  Populated from a lookup built by callers from
 * user_books + currentReads data already in memory.
 */
export type WrapBookRef = {
  title: string;
  author: string;
};

/**
 * Monthly breakdown entry used inside YearlyWrap.
 * Also returned as `mostActiveMonth` with a human-readable label.
 */
export type MonthBreakdown = {
  /** 'YYYY-MM' */
  month: string;
  pagesRead: number;
  readingDays: number;
  sessionCount: number;
};

// =============================================================================
// B. Monthly wrap
// =============================================================================

export type MonthlyWrap = {
  /** 'YYYY-MM' — the calendar month this wrap covers. */
  month: string;

  /** Net pages logged this month (forward sessions minus correction events). */
  pagesRead: number;

  /** Distinct calendar days with at least one valid session. */
  readingDays: number;

  /** Total session rows this month. */
  sessionCount: number;

  /**
   * Mean pages per reading day.
   * null when there are no reading days (avoids division-by-zero in callers).
   */
  avgPagesPerReadingDay: number | null;

  /**
   * Highest single session in pages this month.
   * null when no sessions exist.
   */
  longestSessionPages: number | null;

  /**
   * Number of distinct books logged this month (by user_book_id).
   * 0 when user_book_id is not present in the session data.
   */
  booksActive: number;

  /**
   * Book with the highest total pages read this month.
   * null if no user_book_id data or no sessions.
   */
  topBook: (WrapBookRef & { pagesRead: number; userBookId: string }) | null;

  /**
   * Longest consecutive reading-day streak within this month only.
   * Computed independently of the all-time streak so it stays calendar-scoped.
   */
  longestStreakInMonth: number;
};

/**
 * Compute a MonthlyWrap for the given calendar month prefix.
 *
 * @param allSessions        Flat WrapSession array (typically 90-day window; filtered internally).
 * @param month              'YYYY-MM' prefix of the month to summarise.
 * @param bookLookup         Optional map from user_book_id → title/author for topBook resolution.
 * @param currentPageByBook  Optional map from user_book_id → current_page (from user_books).
 *                           When provided, each book's contribution is capped against
 *                           current_page so books that have been rolled back to a
 *                           lower page (or zero) no longer inflate this month's
 *                           totals.  See `aggregatePeriod` for the formula.
 */
export function computeMonthlyWrap(
  allSessions: WrapSession[],
  month: string,
  bookLookup?: Record<string, WrapBookRef>,
  currentPageByBook?: Record<string, number | null>,
): MonthlyWrap {
  const rows = allSessions.filter(s => s.session_date.startsWith(month));
  const agg  = aggregatePeriod(rows, currentPageByBook);

  const avgPagesPerReadingDay = agg.readingDays > 0
    ? Math.round(agg.pagesRead / agg.readingDays)
    : null;

  // Books with positive effective contribution after the reconciliation cap.
  // A book rolled back to zero this month has contribution 0 and is excluded.
  const positiveBooks = Object.entries(agg.contributionByBook).filter(([, c]) => c > 0);
  const booksActive   = positiveBooks.length;

  let topBook: MonthlyWrap['topBook'] = null;
  if (bookLookup && booksActive > 0) {
    const topEntry = positiveBooks.sort(([, a], [, b]) => b - a)[0];
    if (topEntry) {
      const [topId, topPages] = topEntry;
      const ref = bookLookup[topId];
      if (ref) topBook = { ...ref, pagesRead: topPages, userBookId: topId };
    }
  }

  // ── Streak within this month only ──────────────────────────────────────────
  const { current, longest } = computeStreaks(agg.activeReadingDates);
  const longestStreakInMonth  = Math.max(current, longest);

  return {
    month,
    pagesRead:           agg.pagesRead,
    readingDays:         agg.readingDays,
    sessionCount:        agg.sessionCount,
    avgPagesPerReadingDay,
    longestSessionPages: agg.longestSessionPages,
    booksActive,
    topBook,
    longestStreakInMonth,
  };
}

// =============================================================================
// C. Yearly wrap
// =============================================================================

export type YearlyWrap = {
  year: number;

  /**
   * Accurate book count from a full-year user_books query.
   * Supplied externally so it is never subject to the 90-day session window.
   */
  booksFinished: number;

  /**
   * Session-derived totals.
   * These are based on the session window passed in (typically 90 days) and
   * may therefore undercount if the year started more than 90 days ago.
   * Useful for pace/pattern analysis but not as authoritative totals.
   */
  pagesRead: number;
  readingDays: number;
  sessionCount: number;
  avgPagesPerReadingDay: number | null;

  /**
   * Per-month breakdown — sparse, only months that have at least one session.
   * Sorted ascending by month string.
   */
  monthlyBreakdown: MonthBreakdown[];

  /** Month with the highest reading-day count in the breakdown. */
  mostActiveMonth: (MonthBreakdown & { label: string }) | null;

  /**
   * Longest consecutive reading streak across the session window.
   * May be shorter than the true all-year longest if the session window is narrow.
   */
  longestStreak: number;
};

const SHORT_MONTH_LABELS: Record<string, string> = {
  '01': 'January',  '02': 'February', '03': 'March',    '04': 'April',
  '05': 'May',      '06': 'June',     '07': 'July',     '08': 'August',
  '09': 'September','10': 'October',  '11': 'November', '12': 'December',
};

function fullMonthLabel(monthPrefix: string): string {
  const mm = monthPrefix.slice(5, 7);
  return SHORT_MONTH_LABELS[mm] ?? monthPrefix;
}

/**
 * Compute a YearlyWrap.
 *
 * @param allSessions      Flat WrapSession array (may span multiple years; filtered internally).
 * @param year             4-digit year to summarise.
 * @param booksFinished    Accurate count from caller's full-year user_books query.
 * @param bookLookup       Optional — not yet used by YearlyWrap itself (reserved for future topBook-per-year).
 */
export function computeYearlyWrap(
  allSessions: WrapSession[],
  year: number,
  booksFinished: number,
  _bookLookup?: Record<string, WrapBookRef>,
  currentPageByBook?: Record<string, number | null>,
): YearlyWrap {
  const yearPrefix = String(year);
  const yearRows   = allSessions.filter(s => s.session_date.startsWith(yearPrefix));

  // ── Yearly totals — same per-book reconciliation cap as monthly ───────────
  const yearAgg = aggregatePeriod(yearRows, currentPageByBook);

  const avgPagesPerReadingDay = yearAgg.readingDays > 0
    ? Math.round(yearAgg.pagesRead / yearAgg.readingDays)
    : null;

  // ── Monthly breakdown ──────────────────────────────────────────────────────
  // Each month uses the same cap formula independently.  This is correct
  // because firstStartedPage is computed within each month's row set, so a
  // book that was rolled back today has every prior month's contribution
  // pulled down to zero — consistent with the totals above.
  const rowsByMonth: Record<string, WrapSession[]> = {};
  for (const r of yearRows) {
    const m = r.session_date.slice(0, 7); // 'YYYY-MM'
    if (!rowsByMonth[m]) rowsByMonth[m] = [];
    rowsByMonth[m].push(r);
  }

  const monthlyBreakdown: MonthBreakdown[] = Object.keys(rowsByMonth)
    .sort()
    .map(m => {
      const monthAgg = aggregatePeriod(rowsByMonth[m], currentPageByBook);
      return {
        month:        m,
        pagesRead:    monthAgg.pagesRead,
        readingDays:  monthAgg.readingDays,
        sessionCount: monthAgg.sessionCount,
      };
    })
    // Drop fully-rolled-back months from the breakdown so they don't show as
    // empty entries in the year view.
    .filter(b => b.pagesRead > 0 || b.readingDays > 0 || b.sessionCount > 0);

  // Most active month (by reading days; tie-break: more pages)
  const mostActiveMonthData = monthlyBreakdown.reduce<MonthBreakdown | null>(
    (best, m) =>
      !best ||
      m.readingDays > best.readingDays ||
      (m.readingDays === best.readingDays && m.pagesRead > best.pagesRead)
        ? m
        : best,
    null,
  );
  const mostActiveMonth = mostActiveMonthData
    ? { ...mostActiveMonthData, label: fullMonthLabel(mostActiveMonthData.month) }
    : null;

  // ── Longest streak ─────────────────────────────────────────────────────────
  const { current, longest } = computeStreaks(yearAgg.activeReadingDates);
  const longestStreak = Math.max(current, longest);

  return {
    year,
    booksFinished,
    pagesRead:    yearAgg.pagesRead,
    readingDays:  yearAgg.readingDays,
    sessionCount: yearAgg.sessionCount,
    avgPagesPerReadingDay,
    monthlyBreakdown,
    mostActiveMonth,
    longestStreak,
  };
}

// =============================================================================
// D. Year heatmap
// =============================================================================

/**
 * Compute a net-pages-per-day map for the trailing `windowDays` days (default 365).
 *
 * Rules:
 *  - Negative correction rows are summed in (they reduce the day's total).
 *  - Days whose net total is zero or negative are excluded from the result
 *    so callers treat them identically to days with no activity.
 *  - Days outside the trailing window are ignored.
 *
 * @param allSessions  Raw session rows (may include negative corrections).
 * @param windowDays   How many trailing calendar days to include (default 365).
 * @returns            Sparse map of 'YYYY-MM-DD' → positive net pages.
 */
export function computeYearHeatmap(
  allSessions: WrapSession[],
  windowDays: number = 365,
): Record<string, number> {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - (windowDays - 1));
  const startStr = startDate.toISOString().slice(0, 10);
  const todayStr  = today.toISOString().slice(0, 10);

  // Apply reset-aware segmentation per book BEFORE summing into the date map.
  // Without this, a book reset to 0 inside the window would have its pre-reset
  // positives cancel against the negative reset row, zeroing out the day; and
  // any post-reset re-reading would be hidden behind the cancelled history.
  // Per product semantics ("reset to 0 = start over"), pre-reset rows are
  // dropped and only post-reset reading lights up the heatmap.
  const rowsByBook: Record<string, WrapSession[]> = {};
  const noBookRows: WrapSession[] = [];
  for (const s of allSessions) {
    if (s.session_date < startStr || s.session_date > todayStr) continue;
    if (s.user_book_id) {
      if (!rowsByBook[s.user_book_id]) rowsByBook[s.user_book_id] = [];
      rowsByBook[s.user_book_id].push(s);
    } else {
      noBookRows.push(s);
    }
  }

  const netByDate: Record<string, number> = {};
  for (const bookRows of Object.values(rowsByBook)) {
    for (const r of activeSegment(bookRows)) {
      netByDate[r.session_date] = (netByDate[r.session_date] ?? 0) + r.pages_read;
    }
  }
  for (const r of noBookRows) {
    netByDate[r.session_date] = (netByDate[r.session_date] ?? 0) + r.pages_read;
  }

  const result: Record<string, number> = {};
  for (const [date, net] of Object.entries(netByDate)) {
    if (net > 0) result[date] = net;
  }
  return result;
}

// =============================================================================
// E. Reader insights
// =============================================================================

/**
 * The kind of insight.  Each kind appears at most once in the returned array.
 * Kept as a string union so callers can switch/filter by kind if needed.
 */
export type InsightKind =
  | 'consistency'        // How regularly the reader reads this month
  | 'session_depth'      // Average session length
  | 'momentum_up'        // Pace up vs last month
  | 'momentum_steady'    // About the same pace as last month
  | 'best_month_so_far'  // Most active month of the year so far
  | 'year_pace';         // Books-finished vs yearly goal projection

export type ReaderInsight = {
  kind: InsightKind;
  /** Complete, display-ready sentence. Calm and reflective — never guilting. */
  text: string;
  /** 'notable' — surfaces first; 'mild' — quieter context. */
  strength: 'notable' | 'mild';
};

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

function shortMonthLabel(monthPrefix: string): string {
  const mm = monthPrefix.slice(5, 7);
  const names: Record<string, string> = {
    '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr',
    '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug',
    '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec',
  };
  return names[mm] ?? monthPrefix;
}

/**
 * Derive up to 2 reader insights from wrap data.
 *
 * Priority order (highest first):
 *   1. Notable insights
 *   2. Mild insights
 *
 * Returns an empty array when there is not enough data to make any
 * meaningful observation (avoids surfacing empty or trivially low numbers).
 *
 * @param currentWrap   Monthly wrap for the current calendar month.
 * @param prevWrap      Monthly wrap for the previous calendar month (may be null).
 * @param yearlyWrap    Yearly wrap for the current year (may be null).
 * @param yearlyGoal    User's annual reading goal (books), null if not set.
 * @param today         Override today for testing; defaults to new Date().
 */
export function deriveInsights(
  currentWrap: MonthlyWrap,
  prevWrap: MonthlyWrap | null,
  yearlyWrap: YearlyWrap | null,
  yearlyGoal: number | null,
  today?: Date,
): ReaderInsight[] {
  const ref        = today ?? new Date();
  const daysSoFar  = ref.getDate();          // days elapsed so far in the month
  const candidates: ReaderInsight[] = [];

  // ── 1. Consistency ─────────────────────────────────────────────────────────
  // Only surface when there is meaningful data (≥ 3 reading days this month).
  // The low-rate bare-count tier ("N days so far") is intentionally omitted —
  // a plain number without context is not an insight.
  if (currentWrap.readingDays >= 3) {
    const rate = currentWrap.readingDays / daysSoFar;

    if (rate >= 0.7) {
      candidates.push({
        kind:     'consistency',
        text:     `Reading nearly every day — ${currentWrap.readingDays} of ${daysSoFar} days this month.`,
        strength: 'notable',
      });
    } else if (rate >= 0.4) {
      candidates.push({
        kind:     'consistency',
        text:     `About every other day — ${currentWrap.readingDays} reading days this month.`,
        strength: 'mild',
      });
    }
    // Below 40% rate with fewer than 7 days: not surfaced — too sparse to observe.
  }

  // ── 2. Session depth ───────────────────────────────────────────────────────
  // Only surface when avg is meaningful (≥ 15 pages/day) and habit is established (≥ 3 days).
  // Phrased around the experience of sitting down to read, not a metric readout.
  if (currentWrap.avgPagesPerReadingDay && currentWrap.avgPagesPerReadingDay >= 15 && currentWrap.readingDays >= 3) {
    candidates.push({
      kind:     'session_depth',
      text:     `About ${currentWrap.avgPagesPerReadingDay} pages each time you read this month.`,
      strength: 'mild',
    });
  }

  // ── 3. Month-over-month momentum ───────────────────────────────────────────
  // Compare normalised pace (pages-per-reading-day) to avoid partial-month bias.
  // Avoids evaluative language ("pace is up" → "reading more per day than").
  if (
    prevWrap &&
    prevWrap.readingDays >= 3 &&
    currentWrap.readingDays >= 3 &&
    prevWrap.avgPagesPerReadingDay
  ) {
    const curr  = currentWrap.avgPagesPerReadingDay ?? 0;
    const prev  = prevWrap.avgPagesPerReadingDay;
    const delta = (curr - prev) / prev;

    if (delta >= 0.2) {
      candidates.push({
        kind:     'momentum_up',
        text:     `Reading more per day than in ${shortMonthLabel(prevWrap.month)}.`,
        strength: 'notable',
      });
    } else if (Math.abs(delta) < 0.2 && currentWrap.pagesRead >= 100) {
      candidates.push({
        kind:     'momentum_steady',
        // "steady going" dropped — it reads as a pep talk. Just state the observation.
        text:     `Similar rhythm to ${shortMonthLabel(prevWrap.month)}.`,
        strength: 'mild',
      });
    }
  }

  // ── 4. Best month of the year so far ──────────────────────────────────────
  // Framed factually ("more reading days than...") rather than as an achievement badge.
  if (yearlyWrap && yearlyWrap.monthlyBreakdown.length >= 2) {
    const currentMonthPrefix = currentWrap.month;
    const otherMonths        = yearlyWrap.monthlyBreakdown.filter(m => m.month !== currentMonthPrefix);
    const bestOtherDays      = Math.max(0, ...otherMonths.map(m => m.readingDays));

    if (currentWrap.readingDays >= 5 && currentWrap.readingDays > bestOtherDays) {
      candidates.push({
        kind:     'best_month_so_far',
        text:     `More reading days this month than any month this year.`,
        strength: 'notable',
      });
    }
  }

  // ── 5. Year goal context ───────────────────────────────────────────────────
  // Shows where the reader stands vs their goal — observation only, no grade.
  // "On pace for" / "still on track" removed — too productivity-app-like.
  // Both tiers use the same plain format; strength controls display priority.
  if (yearlyGoal && yearlyGoal > 0 && yearlyWrap && yearlyWrap.booksFinished > 0) {
    const doy       = dayOfYear(ref);
    const daysInYr  = isLeapYear(ref.getFullYear()) ? 366 : 365;
    const paceBooks = Math.round((yearlyWrap.booksFinished / doy) * daysInYr);

    if (paceBooks >= yearlyGoal) {
      candidates.push({
        kind:     'year_pace',
        text:     `${yearlyWrap.booksFinished} of ${yearlyGoal} books finished this year.`,
        strength: 'notable',
      });
    } else if (paceBooks >= Math.round(yearlyGoal * 0.7)) {
      candidates.push({
        kind:     'year_pace',
        text:     `${yearlyWrap.booksFinished} of ${yearlyGoal} books finished this year.`,
        strength: 'mild',
      });
    }
  }

  // Return up to 2, notable first, then mild
  return candidates
    .sort((a, b) => (a.strength === 'notable' ? -1 : 1) - (b.strength === 'notable' ? -1 : 1))
    .slice(0, 2);
}
