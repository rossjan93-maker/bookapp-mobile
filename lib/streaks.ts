/**
 * Reading streak computation.
 *
 * A "reading day" is any calendar date that has at least one reading_sessions
 * row with pages_read > 0.  Streak logic uses session_date strings (YYYY-MM-DD)
 * as the unit; time-of-day is deliberately ignored so a reader who logs pages
 * at 11 pm and midnight is not penalised.
 *
 * Rules:
 *   current streak — consecutive reading days ending TODAY or YESTERDAY.
 *                    The grace window prevents a streak from dying at midnight
 *                    simply because the user hasn't opened the app yet.
 *   longest streak — the longest consecutive reading-day run across all time.
 *
 * Anti-inflation guarantees:
 *   - Multiple sessions on the same date count as ONE reading day.
 *   - Sessions with pages_read === 0 are excluded (caller must filter them).
 *   - A streak of 1 is reported as 1 (the UI decides whether to show it).
 */

export type StreakResult = {
  /** Consecutive reading days ending today or yesterday.  0 when no recent activity. */
  current: number;
  /** All-time longest consecutive reading-day run. */
  longest: number;
};

/**
 * Compute current and longest reading streaks.
 *
 * @param dates - YYYY-MM-DD strings from reading_sessions rows where pages_read > 0.
 *                May contain duplicates (multiple sessions same day); they are collapsed.
 *                Need not be sorted; the function sorts internally.
 */
export function computeStreaks(dates: string[]): StreakResult {
  if (!dates.length) return { current: 0, longest: 0 };

  // Deduplicate and sort ascending — each entry represents one reading day.
  const unique = [...new Set(dates)].sort();
  if (!unique.length) return { current: 0, longest: 0 };

  // ── Longest streak ─────────────────────────────────────────────────────────
  // Walk the sorted unique days; extend the run when the gap is exactly 1 day.
  let longest = 1;
  let run = 1;

  for (let i = 1; i < unique.length; i++) {
    const diff = daysBetween(unique[i - 1], unique[i]);
    if (diff === 1) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // ── Current streak ─────────────────────────────────────────────────────────
  // A streak is "alive" only when the most recent reading day is today or
  // yesterday.  A gap ≥ 2 calendar days means the streak has already ended.
  const todayStr     = localDateString(new Date());
  const yesterdayStr = localDateString(new Date(Date.now() - 86_400_000));
  const lastDay      = unique[unique.length - 1];
  const streakAlive  = lastDay === todayStr || lastDay === yesterdayStr;

  if (!streakAlive) return { current: 0, longest };

  // Walk backward from the last day; stop when the gap exceeds 1.
  let current = 1;
  for (let i = unique.length - 2; i >= 0; i--) {
    const diff = daysBetween(unique[i], unique[i + 1]);
    if (diff === 1) {
      current++;
    } else {
      break;
    }
  }

  return { current, longest };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** ISO 8601 date string in local time (YYYY-MM-DD). */
export function localDateString(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Difference in whole calendar days between two YYYY-MM-DD strings (b - a). */
function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000,
  );
}
