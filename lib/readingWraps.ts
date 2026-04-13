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

// =============================================================================
// A. Shared types
// =============================================================================

/**
 * A single reading session row, optionally enriched with the user_book_id so
 * per-book aggregations work.  This is the canonical input shape accepted by
 * all wrap functions.
 */
export type WrapSession = {
  session_date: string;   // 'YYYY-MM-DD' local date
  pages_read: number;     // always > 0 in practice (callers may include 0; filtered internally)
  user_book_id?: string;  // omit if not available — book-level stats degrade gracefully
};

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

  /** Total pages logged this month (all sessions with pages_read > 0). */
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
 * @param allSessions  Flat WrapSession array (typically 90-day window; filtered internally).
 * @param month        'YYYY-MM' prefix of the month to summarise.
 * @param bookLookup   Optional map from user_book_id → title/author for topBook resolution.
 */
export function computeMonthlyWrap(
  allSessions: WrapSession[],
  month: string,
  bookLookup?: Record<string, WrapBookRef>,
): MonthlyWrap {
  const rows = allSessions.filter(
    s => s.session_date.startsWith(month) && s.pages_read > 0,
  );

  const pagesRead      = rows.reduce((sum, s) => sum + s.pages_read, 0);
  const readingDaySet  = new Set(rows.map(s => s.session_date));
  const readingDays    = readingDaySet.size;
  const sessionCount   = rows.length;

  const avgPagesPerReadingDay = readingDays > 0
    ? Math.round(pagesRead / readingDays)
    : null;

  const longestSessionPages = rows.length > 0
    ? Math.max(...rows.map(r => r.pages_read))
    : null;

  // ── Per-book aggregations ───────────────────────────────────────────────────
  const pagesByBook: Record<string, number> = {};
  for (const r of rows) {
    if (r.user_book_id) {
      pagesByBook[r.user_book_id] = (pagesByBook[r.user_book_id] ?? 0) + r.pages_read;
    }
  }
  const booksActive = Object.keys(pagesByBook).length;

  let topBook: MonthlyWrap['topBook'] = null;
  if (bookLookup && booksActive > 0) {
    const topEntry = Object.entries(pagesByBook).sort(([, a], [, b]) => b - a)[0];
    if (topEntry) {
      const [topId, topPages] = topEntry;
      const ref = bookLookup[topId];
      if (ref) topBook = { ...ref, pagesRead: topPages, userBookId: topId };
    }
  }

  // ── Streak within this month only ──────────────────────────────────────────
  const datesInMonth         = [...readingDaySet].sort();
  const { current, longest } = computeStreaks(datesInMonth);
  const longestStreakInMonth  = Math.max(current, longest);

  return {
    month,
    pagesRead,
    readingDays,
    sessionCount,
    avgPagesPerReadingDay,
    longestSessionPages,
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
): YearlyWrap {
  const yearPrefix = String(year);
  const yearRows   = allSessions.filter(
    s => s.session_date.startsWith(yearPrefix) && s.pages_read > 0,
  );

  // ── Totals ─────────────────────────────────────────────────────────────────
  const pagesRead    = yearRows.reduce((sum, s) => sum + s.pages_read, 0);
  const allDates     = [...new Set(yearRows.map(s => s.session_date))].sort();
  const readingDays  = allDates.length;
  const sessionCount = yearRows.length;
  const avgPagesPerReadingDay = readingDays > 0
    ? Math.round(pagesRead / readingDays)
    : null;

  // ── Monthly breakdown ──────────────────────────────────────────────────────
  // Single-pass aggregation: accumulate totals per month prefix.
  const monthPagesMap: Record<string, number>    = {};
  const monthDaySetMap: Record<string, Set<string>> = {};
  const monthSessionMap: Record<string, number>  = {};

  for (const r of yearRows) {
    const m = r.session_date.slice(0, 7); // 'YYYY-MM'
    monthPagesMap[m]    = (monthPagesMap[m] ?? 0) + r.pages_read;
    monthSessionMap[m]  = (monthSessionMap[m] ?? 0) + 1;
    if (!monthDaySetMap[m]) monthDaySetMap[m] = new Set();
    monthDaySetMap[m].add(r.session_date);
  }

  const monthlyBreakdown: MonthBreakdown[] = Object.keys(monthPagesMap)
    .sort()
    .map(m => ({
      month:        m,
      pagesRead:    monthPagesMap[m],
      readingDays:  monthDaySetMap[m]?.size ?? 0,
      sessionCount: monthSessionMap[m] ?? 0,
    }));

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
  const { current, longest } = computeStreaks(allDates);
  const longestStreak = Math.max(current, longest);

  return {
    year,
    booksFinished,
    pagesRead,
    readingDays,
    sessionCount,
    avgPagesPerReadingDay,
    monthlyBreakdown,
    mostActiveMonth,
    longestStreak,
  };
}

// =============================================================================
// D. Reader insights
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
    } else if (currentWrap.readingDays >= 5) {
      candidates.push({
        kind:     'consistency',
        text:     `${currentWrap.readingDays} reading days so far this month.`,
        strength: 'mild',
      });
    }
  }

  // ── 2. Session depth ───────────────────────────────────────────────────────
  // Only surface when avg is meaningful (≥ 15 pages per reading day).
  if (currentWrap.avgPagesPerReadingDay && currentWrap.avgPagesPerReadingDay >= 15 && currentWrap.readingDays >= 3) {
    candidates.push({
      kind:     'session_depth',
      text:     `Averaging ${currentWrap.avgPagesPerReadingDay} pages per reading day this month.`,
      strength: 'mild',
    });
  }

  // ── 3. Month-over-month momentum ───────────────────────────────────────────
  // Compare normalised pace (pages-per-reading-day) to avoid end-of-month bias.
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
        text:     `Reading pace is up from ${shortMonthLabel(prevWrap.month)}.`,
        strength: 'notable',
      });
    } else if (Math.abs(delta) < 0.2 && currentWrap.pagesRead >= 100) {
      candidates.push({
        kind:     'momentum_steady',
        text:     `Similar pace to ${shortMonthLabel(prevWrap.month)} — steady going.`,
        strength: 'mild',
      });
    }
  }

  // ── 4. Best month of the year so far ──────────────────────────────────────
  if (yearlyWrap && yearlyWrap.monthlyBreakdown.length >= 2) {
    const currentMonthPrefix = currentWrap.month;
    const otherMonths        = yearlyWrap.monthlyBreakdown.filter(m => m.month !== currentMonthPrefix);
    const bestOtherDays      = Math.max(0, ...otherMonths.map(m => m.readingDays));

    if (currentWrap.readingDays >= 5 && currentWrap.readingDays > bestOtherDays) {
      candidates.push({
        kind:     'best_month_so_far',
        text:     `Most active reading month of the year so far.`,
        strength: 'notable',
      });
    }
  }

  // ── 5. Year-pace toward goal ───────────────────────────────────────────────
  if (yearlyGoal && yearlyGoal > 0 && yearlyWrap && yearlyWrap.booksFinished > 0) {
    const doy      = dayOfYear(ref);
    const daysInYr = isLeapYear(ref.getFullYear()) ? 366 : 365;
    const paceBooks = Math.round((yearlyWrap.booksFinished / doy) * daysInYr);

    if (paceBooks >= yearlyGoal) {
      candidates.push({
        kind:     'year_pace',
        text:     `On pace for ${paceBooks} books this year — goal is ${yearlyGoal}.`,
        strength: 'notable',
      });
    } else if (paceBooks >= Math.round(yearlyGoal * 0.7)) {
      candidates.push({
        kind:     'year_pace',
        text:     `${yearlyWrap.booksFinished} of ${yearlyGoal} books finished — still on track.`,
        strength: 'mild',
      });
    }
  }

  // Return up to 2, notable first, then mild
  return candidates
    .sort((a, b) => (a.strength === 'notable' ? -1 : 1) - (b.strength === 'notable' ? -1 : 1))
    .slice(0, 2);
}
