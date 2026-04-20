/**
 * Pacing, read-state inference, and session-based projected finish.
 *
 * Sections:
 *   A. ReadState — infers active / paused / stalled from recency
 *   B. Session-based pacing — estimates pace + projected finish from real sessions
 *   C. Date-based pacing (goal-relative, existing)
 *   D. Page-based pacing (goal-relative, existing)
 *   E. Momentum helpers (existing)
 *   F. Completed-book pace metrics (existing)
 *   G. Year-to-date goal progress (existing)
 */

import { activeSegment } from './sessionSegment';

// =============================================================================
// A. Read-state inference
// =============================================================================

/**
 * The inferred momentum state of a currently-reading book.
 *
 * These are orthogonal to the shelf label (status = 'reading').  A book can be
 * labelled "reading" for months with no actual page progress — the read state
 * surfaces that gap with honest, non-punitive language.
 *
 * Thresholds (conservative — do not label stalled prematurely):
 *   active  — progress_updated_at within the last 14 calendar days
 *   paused  — 15 – 60 days since last progress update
 *   stalled — > 60 days since last progress update OR the book has been
 *             in "reading" status for > 60 days with no page progress at all
 *
 * Non-reading statuses pass through directly so callers can use a single type.
 */
export type ReadState =
  | 'active'
  | 'paused'
  | 'stalled'
  | 'finished'
  | 'dnf'
  | 'want_to_read';

const ACTIVE_THRESHOLD_DAYS  = 14;
const PAUSED_THRESHOLD_DAYS  = 60;

/**
 * Infer the read state of a single user_books row.
 *
 * For currently-reading books the anchor for recency is:
 *   1. progress_updated_at  (best — reflects actual page updates)
 *   2. started_at           (fallback — book was moved to "reading" but no page logged yet)
 *
 * If neither anchor is available the book is treated as active (just started).
 */
export function inferReadState(params: {
  status:            string;
  progressUpdatedAt: string | null | undefined;
  startedAt:         string | null | undefined;
  currentPage:       number | null | undefined;
}): ReadState {
  const { status, progressUpdatedAt, startedAt, currentPage } = params;

  if (status === 'finished')     return 'finished';
  if (status === 'dnf')         return 'dnf';
  if (status === 'want_to_read') return 'want_to_read';

  // status === 'reading'
  const anchor = progressUpdatedAt ?? startedAt;
  if (!anchor) return 'active'; // brand-new start, no data yet

  const daysSince = Math.floor((Date.now() - new Date(anchor).getTime()) / 86_400_000);

  // Special case: book in "reading" with no page logged and started long ago.
  // Use the started_at anchor — it is the only signal we have.
  if (!currentPage && !progressUpdatedAt && startedAt) {
    const daysSinceStart = Math.floor((Date.now() - new Date(startedAt).getTime()) / 86_400_000);
    if (daysSinceStart > PAUSED_THRESHOLD_DAYS) return 'stalled';
    if (daysSinceStart > ACTIVE_THRESHOLD_DAYS) return 'paused';
    return 'active';
  }

  if (daysSince <= ACTIVE_THRESHOLD_DAYS) return 'active';
  if (daysSince <= PAUSED_THRESHOLD_DAYS) return 'paused';
  return 'stalled';
}

/** Human-readable label for a read state in UI context. */
export function readStateLabel(state: ReadState): string {
  switch (state) {
    case 'active':       return 'Active';
    case 'paused':       return 'Paused';
    case 'stalled':      return 'Stalled';
    case 'finished':     return 'Finished';
    case 'dnf':          return 'Did not finish';
    case 'want_to_read': return 'Want to read';
  }
}

// =============================================================================
// B. Session-based pacing (uses real reading_sessions data)
// =============================================================================

export type SessionRow = {
  session_date: string; // YYYY-MM-DD
  pages_read:   number;
};

export type SessionPacingResult = {
  /** Actual reading velocity: total pages read / calendar days since first session. */
  pagesPerDay: number;
  /** Pages remaining in the book. */
  pagesLeft: number;
  /** Projected finish date at the current velocity. */
  estimatedFinish: Date;
  /**
   * Confidence in this estimate:
   *   strong   — ≥ 5 sessions (reliable pattern)
   *   moderate — 3 – 4 sessions (emerging pattern)
   *   weak     — 1 – 2 sessions (very early, treat as directional only)
   */
  strength: 'strong' | 'moderate' | 'weak';
};

/**
 * Estimate reading pace and projected finish from real session history.
 *
 * Uses the calendar-day rate (total pages / calendar days since first session)
 * rather than "pages per reading day" — this gives an honest estimate that
 * automatically accounts for non-reading days without requiring the caller to
 * model reading frequency separately.
 *
 * Returns null when:
 *   - No sessions with positive pages_read
 *   - Page count or current page are unavailable
 *   - Book is already finished (pagesLeft === 0)
 *   - First session was less than 12 h ago (too little signal)
 */
export function computeSessionPacing(
  sessions:    SessionRow[],
  currentPage: number,
  pageCount:   number,
): SessionPacingResult | null {
  if (!sessions.length || pageCount <= 0 || currentPage <= 0) return null;

  // Only count sessions with actual forward progress.
  const activeSessions = sessions.filter(s => s.pages_read > 0);
  if (!activeSessions.length) return null;

  const totalPages = activeSessions.reduce((sum, s) => sum + s.pages_read, 0);
  if (totalPages <= 0) return null;

  // Calendar days elapsed from the earliest session date to today.
  const dates      = activeSessions.map(s => s.session_date).sort();
  const firstDate  = new Date(dates[0]);
  const msElapsed  = Date.now() - firstDate.getTime();
  if (msElapsed < 12 * 60 * 60 * 1000) return null; // < 12 h — too new

  const calendarDaysElapsed = Math.max(1, msElapsed / 86_400_000);
  const pagesPerDay         = totalPages / calendarDaysElapsed;
  if (pagesPerDay <= 0) return null;

  const pagesLeft = Math.max(0, pageCount - currentPage);
  if (pagesLeft === 0) return null;

  const daysToFinish   = pagesLeft / pagesPerDay;
  const estimatedFinish = new Date(Date.now() + daysToFinish * 86_400_000);

  const strength: 'strong' | 'moderate' | 'weak' =
    activeSessions.length >= 5 ? 'strong' :
    activeSessions.length >= 3 ? 'moderate' : 'weak';

  return {
    pagesPerDay:     Math.round(pagesPerDay * 10) / 10,
    pagesLeft,
    estimatedFinish,
    strength,
  };
}

/**
 * Compact display string for a projected finish date.
 * Omits the year when it matches the current year.
 *
 * e.g. "Apr 29" or "Jan 3, 2027"
 */
export function formatProjectedFinish(date: Date): string {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Pacing helpers for yearly reading goal tracking.
 *
 * Two models:
 *  - Date-based: uses start date + yearly goal; no page data needed.
 *  - Page-based:  uses current_page + page_count; gives pages/day target.
 *
 * Shared logic:
 *   days_per_book  = 365 / yearly_goal
 *   target_finish  = started_at + days_per_book
 *   days_left      = target_finish - today
 *
 * Pacing states (page-based only):
 *   ahead    — actual % complete > expected % complete + 10 pts
 *   on_pace  — within ±10 pts of expected
 *   behind   — actual % complete < expected % complete - 10 pts
 */

export type PacingState = 'ahead' | 'on_pace' | 'behind';

export function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Compute the target finish Date for one book given a yearly goal. */
export function targetFinishDate(
  startedAt: string,
  yearlyGoal: number
): Date {
  const daysPerBook = 365 / yearlyGoal;
  return new Date(new Date(startedAt).getTime() + daysPerBook * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Date-based pacing (no page count)
// ---------------------------------------------------------------------------

export type DatePacingResult = {
  note: string;
  state: PacingState;
};

/**
 * Date-based pacing with a real pacing state.
 * No page data is required — state is derived purely from time elapsed vs target.
 * Returns null if insufficient data (no goal or no startedAt).
 *
 * State mapping:
 *   behind   — target date has already passed (daysLeft < 0)
 *   on_pace  — target date is still in the future
 * (ahead cannot be determined honestly without page data)
 */
export function computeDatePacing(
  startedAt: string | null | undefined,
  yearlyGoal: number | null | undefined
): DatePacingResult | null {
  if (!yearlyGoal || yearlyGoal <= 0 || !startedAt) return null;

  const start = new Date(startedAt);
  if (isNaN(start.getTime())) return null;

  const target   = targetFinishDate(startedAt, yearlyGoal);
  const daysLeft = Math.ceil((target.getTime() - Date.now()) / 86_400_000);

  const state: PacingState = daysLeft < 0 ? 'behind' : 'on_pace';

  let note: string;
  if (daysLeft < -14)  note = 'Behind pace — finish when you can';
  else if (daysLeft < 0)   note = 'Slightly behind — aim to finish soon';
  else if (daysLeft === 0) note = 'Finish today to stay on pace';
  else if (daysLeft === 1) note = 'Finish tomorrow to stay on pace';
  else if (daysLeft <= 5)  note = `Finish in ${daysLeft} days to stay on pace`;
  else                     note = `On pace — target ${shortDate(target)}`;

  return { note, state };
}

/**
 * Returns just the human-readable pacing note (backward-compat wrapper).
 * Prefer computeDatePacing() when you also need the state.
 */
export function computePacingNote(
  startedAt: string | null | undefined,
  yearlyGoal: number | null | undefined
): string | null {
  return computeDatePacing(startedAt, yearlyGoal)?.note ?? null;
}

// ---------------------------------------------------------------------------
// Page-based pacing (when page_count is available)
// ---------------------------------------------------------------------------

export type PagePacingResult = {
  percentComplete: number;
  pagesLeft: number;
  targetDate: Date | null;
  pagesPerDayNeeded: number | null;
  /** ahead / on_pace / behind relative to the expected reading pace today */
  state: PacingState;
  /** Ready-to-display compact line for chips, e.g. "On pace · Mar 28" */
  note: string;
};

/**
 * Returns rich pacing data when page count is known.
 * Falls back gracefully when startedAt / yearlyGoal are missing.
 *
 * Pacing state is computed by comparing:
 *   actual % complete  vs.  expected % complete today
 * where expected = (days_since_start / days_per_book) × 100
 *
 * A ±10 percentage-point buffer avoids flickering between states.
 */
export function computePagePacing(
  currentPage: number,
  pageCount: number,
  startedAt: string | null | undefined,
  yearlyGoal: number | null | undefined
): PagePacingResult {
  const pct = pageCount > 0 ? Math.min(100, Math.round((currentPage / pageCount) * 100)) : 0;
  const pagesLeft = Math.max(0, pageCount - currentPage);

  if (pagesLeft === 0) {
    return {
      percentComplete: 100,
      pagesLeft: 0,
      targetDate: null,
      pagesPerDayNeeded: 0,
      state: 'on_pace',
      note: 'Finished!',
    };
  }

  if (!startedAt || !yearlyGoal || yearlyGoal <= 0) {
    return {
      percentComplete: pct,
      pagesLeft,
      targetDate: null,
      pagesPerDayNeeded: null,
      state: 'on_pace',
      note: `${pagesLeft} pages left`,
    };
  }

  const target         = targetFinishDate(startedAt, yearlyGoal);
  const msLeft         = target.getTime() - Date.now();
  const rawDaysLeft    = Math.ceil(msLeft / 86_400_000); // can be ≤ 0 when overdue
  const daysLeft       = Math.max(1, rawDaysLeft);       // clamped for ppd math
  const ppd            = Math.ceil(pagesLeft / daysLeft);

  // ── Determine pacing state ──
  // Compare actual reading progress % to the expected % by today.
  const start          = new Date(startedAt);
  const daysPerBook    = 365 / yearlyGoal;
  const daysSinceStart = Math.max(0, (Date.now() - start.getTime()) / 86_400_000);
  const expectedPct    = Math.min(100, (daysSinceStart / daysPerBook) * 100);

  let state: PacingState;
  if (pct >= expectedPct + 10) {
    state = 'ahead';
  } else if (pct >= expectedPct - 10) {
    state = 'on_pace';
  } else {
    state = 'behind';
  }

  // ── Compact chip note ──
  // ahead:    "Ahead of pace · target Mar 29"
  // on_pace:  "On pace · 18 pages/day"
  // behind:   "32 pages/day · 4 days left"  (or "finish soon" when overdue)
  let note: string;
  if (state === 'ahead') {
    note = `Ahead of pace · ${shortDate(target)}`;
  } else if (state === 'on_pace') {
    note = `On pace · ${ppd} pages/day`;
  } else {
    // behind
    if (rawDaysLeft >= 2) {
      note = `${ppd} pages/day · ${rawDaysLeft} days left`;
    } else if (rawDaysLeft === 1) {
      note = `${ppd} pages/day · 1 day left`;
    } else {
      note = `${ppd} pages/day · finish soon`;
    }
  }

  return {
    percentComplete: pct,
    pagesLeft,
    targetDate: target,
    pagesPerDayNeeded: ppd,
    state,
    note,
  };
}

// ---------------------------------------------------------------------------
// Momentum helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable "last updated" string for a reading progress timestamp.
 *   "Updated today"
 *   "Updated 2 days ago"
 *   "Updated 1 week ago"
 */
export function formatLastUpdated(progressUpdatedAt: string | null | undefined): string | null {
  if (!progressUpdatedAt) return null;
  const updated = new Date(progressUpdatedAt);
  if (isNaN(updated.getTime())) return null;
  const daysDiff = Math.floor((Date.now() - updated.getTime()) / 86_400_000);
  if (daysDiff === 0) return 'Updated today';
  if (daysDiff === 1) return 'Updated 1 day ago';
  if (daysDiff < 7)  return `Updated ${daysDiff} days ago`;
  const weeks = Math.floor(daysDiff / 7);
  return weeks === 1 ? 'Updated 1 week ago' : `Updated ${weeks} weeks ago`;
}

/**
 * Estimates actual reading pace and projected finish date.
 * Uses real reading data (pages read / days elapsed since start) — NOT yearly goal.
 *
 * Returns null when insufficient data:
 *   - No startedAt, no pages read yet, < 12h of data, or already finished
 */
export function estimatePaceFinish(
  currentPage: number,
  pageCount: number,
  startedAt: string | null | undefined,
): { pagesLeft: number; pagesPerDay: number; estimatedFinish: Date } | null {
  if (!startedAt || currentPage <= 0 || pageCount <= 0) return null;
  const start = new Date(startedAt);
  if (isNaN(start.getTime())) return null;
  const daysElapsed = (Date.now() - start.getTime()) / 86_400_000;
  if (daysElapsed < 0.5) return null;
  const pagesPerDay = currentPage / daysElapsed;
  if (pagesPerDay <= 0) return null;
  const pagesLeft = Math.max(0, pageCount - currentPage);
  if (pagesLeft === 0) return null;
  const daysToFinish = pagesLeft / pagesPerDay;
  return {
    pagesLeft,
    pagesPerDay: Math.round(pagesPerDay * 10) / 10,
    estimatedFinish: new Date(Date.now() + daysToFinish * 86_400_000),
  };
}

// ---------------------------------------------------------------------------
// Completed-book pace metrics
// ---------------------------------------------------------------------------

export type BookPaceResult = {
  daysToFinish: number;
  pagesPerDay: number;
};

/**
 * Compute pace for a single completed book.
 * Returns null when started_at, finished_at, or page_count are missing/invalid.
 * Same-day finishes are treated as 1 day minimum.
 */
export function computeBookPace(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  pageCount: number | null | undefined,
): BookPaceResult | null {
  if (!startedAt || !finishedAt || !pageCount || pageCount <= 0) return null;
  const start  = new Date(startedAt);
  const finish = new Date(finishedAt);
  if (isNaN(start.getTime()) || isNaN(finish.getTime())) return null;
  const daysToFinish = Math.max(1, Math.round((finish.getTime() - start.getTime()) / 86_400_000));
  const pagesPerDay  = Math.round(pageCount / daysToFinish);
  if (pagesPerDay <= 0) return null;
  return { daysToFinish, pagesPerDay };
}

/**
 * Compact chip string for a completed book.
 * e.g. "18 ppd · 6 days" or "24 ppd · 1 day"
 */
export function formatPaceChip(pagesPerDay: number, daysToFinish: number): string {
  const dayStr = daysToFinish === 1 ? '1 day' : `${daysToFinish} days`;
  return `${pagesPerDay} ppd · ${dayStr}`;
}

/**
 * Compute the user's average pages/day across all completed books with valid data.
 * Returns null when fewer than 2 books have valid pace data (too little signal).
 */
export function computeUserAvgPace(
  books: Array<{ started_at?: string | null; finished_at?: string | null; pageCount?: number | null }>
): number | null {
  const rates: number[] = [];
  for (const b of books) {
    const result = computeBookPace(b.started_at, b.finished_at, b.pageCount);
    if (result) rates.push(result.pagesPerDay);
  }
  if (rates.length < 2) return null;
  return Math.round(rates.reduce((sum, r) => sum + r, 0) / rates.length);
}

// ---------------------------------------------------------------------------
// Monthly reading stats (used by home screen + future reading wraps)
// ---------------------------------------------------------------------------

export type MonthlyStats = {
  /** Total pages logged this calendar month. */
  pagesThisMonth: number;
  /** Distinct reading days this calendar month. */
  readingDaysThisMonth: number;
  /** Number of individual sessions logged this month. */
  sessionsThisMonth: number;
};

/**
 * Aggregate session-level reading stats for the current calendar month.
 *
 * Designed to be the base data layer for monthly and yearly reading wraps.
 *
 * Correction model — when a user reduces or resets page progress, a negative
 * pages_read row is inserted into reading_sessions.  This function uses a
 * net-sum model so those corrections are reflected in all three metrics:
 *
 *   pagesThisMonth      — sum of ALL rows (positive + negative).  Clamped to
 *                         0 because a negative net total is not meaningful to
 *                         display (it means the user corrected more than they
 *                         actually read this month).
 *
 *   readingDaysThisMonth — count of calendar dates where the net total across
 *                         all rows for that date is > 0.  A day that was
 *                         entirely corrected away (net ≤ 0) is not counted.
 *
 *   sessionsThisMonth   — count of forward (positive) rows only; correction
 *                         rows are infrastructure, not discrete reading events.
 *
 * @param sessions — rows from reading_sessions (may cover 90 days or more;
 *                   may include negative correction rows)
 * @param today    — override for testing; defaults to new Date()
 */
export function computeMonthlyStats(
  sessions: Array<{
    session_date:   string;
    pages_read:     number;
    started_page?:  number;
    user_book_id?:  string;
  }>,
  currentPageByBook?: Record<string, number | null>,
  today?: Date,
): MonthlyStats {
  const ref         = today ?? new Date();
  const monthPrefix = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
  const monthRows   = sessions.filter(s => s.session_date.startsWith(monthPrefix));

  // ── Group rows by book for per-book reconciliation ────────────────────────
  // See lib/readingWraps.ts → aggregatePeriod for the full rationale.
  // Brief: each book's contribution is capped at (current_page − started_page
  // of its first session this month) so books rolled back to a lower position
  // (or zero) no longer inflate this month's totals.  Books not present in
  // the lookup fall back to the legacy net-sum model.
  const rowsByBook: Record<string, typeof monthRows> = {};
  const noBookRows: typeof monthRows = [];
  for (const r of monthRows) {
    if (r.user_book_id) {
      if (!rowsByBook[r.user_book_id]) rowsByBook[r.user_book_id] = [];
      rowsByBook[r.user_book_id].push(r);
    } else {
      noBookRows.push(r);
    }
  }

  let pagesThisMonth   = 0;
  let sessionsThisMonth = 0;
  const activeBookIds  = new Set<string>();
  // Per-book "active segment" — rows after the most recent reset-to-0 in
  // this month.  Used downstream for reading-day and session counting so
  // every metric agrees on the same set of "still counts" rows.
  const activeRowsByBook: Record<string, typeof monthRows> = {};

  for (const [bookId, bookRows] of Object.entries(rowsByBook)) {
    // Reset-aware segmentation: drop pre-reset rows for this book in this
    // month.  See lib/sessionSegment.ts for the rule.  When the book had a
    // reset-to-0 inside the month, only post-reset rows are eligible to
    // contribute pages, reading days, or session count.
    const active = activeSegment(bookRows);
    activeRowsByBook[bookId] = active;
    const netSessions = active.reduce((sum, r) => sum + r.pages_read, 0);
    const cp = currentPageByBook?.[bookId];

    let contribution: number;
    if (cp == null) {
      contribution = Math.max(0, netSessions);
    } else if (active.length < bookRows.length) {
      // Reset happened this month — baseline is unconditionally 0 inside the
      // active segment.  Cap contribution at current_page (the maximum the
      // user could possibly have re-read since the reset).
      contribution = Math.max(0, Math.min(netSessions, cp));
    } else {
      // No reset this month — anchor the cap on the first POSITIVE-delta row
      // in the segment.  Negative rows (organic partial corrections, or
      // synthetic backfill rows from scripts/backfillSessionCorrections.ts)
      // carry a started_page that reflects the pre-correction position, not
      // where the user began reading this period.  Falls back to the first
      // row when no positive-delta row exists (period contains only
      // corrections — contribution is correctly clamped to 0).
      const firstForward = active.find((r) => r.pages_read > 0) ?? active[0];
      const firstStartedPage = firstForward.started_page ?? 0;
      contribution = Math.max(0, Math.min(netSessions, cp - firstStartedPage));
    }

    pagesThisMonth += contribution;
    if (contribution > 0) {
      activeBookIds.add(bookId);
      sessionsThisMonth += active.filter((r) => r.pages_read > 0).length;
    }
  }

  // Unbooked rows: legacy fallback — sum net, count positive
  const unbookedNet = Math.max(0, noBookRows.reduce((s, r) => s + r.pages_read, 0));
  pagesThisMonth   += unbookedNet;
  sessionsThisMonth += noBookRows.filter(r => r.pages_read > 0).length;

  // ── Reading days: dates where any active book has net > 0 ─────────────────
  // Uses the per-book ACTIVE SEGMENT only — pre-reset reading days are
  // intentionally excluded so the count agrees with the contribution math.
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
  const readingDaysThisMonth = Object.values(dateNetByActive).filter(n => n > 0).length;

  return { pagesThisMonth, readingDaysThisMonth, sessionsThisMonth };
}

// ---------------------------------------------------------------------------
// Year-to-date goal progress
// ---------------------------------------------------------------------------

/**
 * Returns the year-to-date progress line toward the yearly goal.
 * e.g. "7 of 24 books this year · on pace ✓"
 */
export function computeGoalProgress(
  finishedThisYear: number,
  yearlyGoal: number | null | undefined
): string | null {
  if (!yearlyGoal || yearlyGoal <= 0) return null;

  const today = new Date();
  const dayOfYear = Math.floor(
    (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / (24 * 60 * 60 * 1000)
  );
  const expectedByNow = Math.floor((dayOfYear / 365) * yearlyGoal);
  const onPace = finishedThisYear >= expectedByNow;

  return `${finishedThisYear} of ${yearlyGoal} books this year · ${onPace ? 'on pace ✓' : 'behind pace'}`;
}
