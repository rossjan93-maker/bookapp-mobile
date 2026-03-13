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
 */

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

/**
 * Returns a short human-readable pacing note for a currently-reading book.
 * Returns null if insufficient data.
 */
export function computePacingNote(
  startedAt: string | null | undefined,
  yearlyGoal: number | null | undefined
): string | null {
  if (!yearlyGoal || yearlyGoal <= 0 || !startedAt) return null;

  const start = new Date(startedAt);
  if (isNaN(start.getTime())) return null;

  const target = targetFinishDate(startedAt, yearlyGoal);
  const daysLeft = Math.ceil(
    (target.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
  );

  if (daysLeft < -14) return 'Behind pace — finish when you can';
  if (daysLeft < 0)   return 'Slightly behind — aim to finish soon';
  if (daysLeft === 0) return 'Finish today to stay on pace';
  if (daysLeft === 1) return 'Finish tomorrow to stay on pace';
  if (daysLeft <= 5)  return `Finish in ${daysLeft} days to stay on pace`;
  return `On pace — target ${shortDate(target)}`;
}

// ---------------------------------------------------------------------------
// Page-based pacing (when page_count is available)
// ---------------------------------------------------------------------------

export type PagePacingResult = {
  percentComplete: number;
  pagesLeft: number;
  targetDate: Date | null;
  pagesPerDayNeeded: number | null;
  /** Ready-to-display line, e.g. "12 pages/day · target Mar 28" */
  note: string;
};

/**
 * Returns rich pacing data when page count is known.
 * Falls back gracefully when startedAt / yearlyGoal are missing.
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
    return { percentComplete: 100, pagesLeft: 0, targetDate: null, pagesPerDayNeeded: 0, note: 'Finished!' };
  }

  if (!startedAt || !yearlyGoal || yearlyGoal <= 0) {
    return {
      percentComplete: pct,
      pagesLeft,
      targetDate: null,
      pagesPerDayNeeded: null,
      note: `${pagesLeft} pages left`,
    };
  }

  const target = targetFinishDate(startedAt, yearlyGoal);
  const daysLeft = Math.max(1, Math.ceil((target.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  const ppd = Math.ceil(pagesLeft / daysLeft);

  return {
    percentComplete: pct,
    pagesLeft,
    targetDate: target,
    pagesPerDayNeeded: ppd,
    note: `${ppd} pages/day · target ${shortDate(target)}`,
  };
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
