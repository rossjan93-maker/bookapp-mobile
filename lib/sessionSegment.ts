/**
 * Reset-aware session segmentation.
 *
 * Product semantics ("reset to 0 = start over"):
 *   - When a user resets a book's progress to page 0, all prior reading inside
 *     the period is considered "undone" — it no longer contributes to monthly
 *     pages, reading days, session count, or heatmap activity.
 *   - Pages re-read AFTER the reset begin counting again from a baseline of 0.
 *   - This rule applies inside any aggregation window (month, year, trailing
 *     365-day heatmap).  The window only ever cares about the user's CURRENT
 *     reading run for the book.
 *
 * Definition of a "reset-to-0" row:
 *   pages_read < 0  AND  started_page + pages_read === 0
 *
 *   That is — a correction row whose ended_page lands exactly at page 0.
 *   Partial rollbacks (e.g. 100 → 50) are NOT resets; they are ordinary
 *   corrections handled by the upstream cap formula.
 *
 * activeSegment() returns the chronologically-latest contiguous slice of
 * the input rows that the user is still "inside".  If the input contains
 * any reset-to-0 row, it returns the rows that come strictly AFTER the
 * latest such row.  If there are none, it returns the input unchanged.
 *
 * Sort order matches every other aggregator in the codebase:
 *   primary:   session_date ascending  (lex sort works because format is YYYY-MM-DD)
 *   secondary: stable insertion order for ties on the same calendar date
 *
 * Pure function.  No side effects.  Safe to call on the result of itself
 * (idempotent — a slice that contains no resets returns itself).
 */

export type SegmentableRow = {
  session_date: string;
  pages_read: number;
  started_page?: number;
};

/** True when this row represents the user resetting their progress to page 0. */
export function isResetToZero(row: SegmentableRow): boolean {
  if (row.pages_read >= 0) return false;
  const started = row.started_page ?? 0;
  return started + row.pages_read === 0;
}

/**
 * Slice the row set to only the rows AFTER the most recent reset-to-0.
 * When no reset-to-0 exists in the input, returns the input as-is (sorted
 * deterministically so callers can rely on chronological order downstream).
 */
export function activeSegment<T extends SegmentableRow>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const sorted = [...rows].sort((a, b) =>
    a.session_date.localeCompare(b.session_date),
  );
  let lastResetIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (isResetToZero(sorted[i])) lastResetIdx = i;
  }
  if (lastResetIdx === -1) return sorted;
  return sorted.slice(lastResetIdx + 1);
}
