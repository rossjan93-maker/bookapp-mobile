/**
 * Pacing helpers for yearly reading goal tracking.
 *
 * Logic:
 *   days_per_book = 365 / yearly_goal
 *   target_finish = started_at + days_per_book
 *   days_left     = target_finish - today
 */

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Returns a short human-readable pacing note for a currently-reading book,
 * or null if insufficient data.
 */
export function computePacingNote(
  startedAt: string | null | undefined,
  yearlyGoal: number | null | undefined
): string | null {
  if (!yearlyGoal || yearlyGoal <= 0 || !startedAt) return null;

  const daysPerBook = 365 / yearlyGoal;
  const start = new Date(startedAt);
  if (isNaN(start.getTime())) return null;

  const target = new Date(start.getTime() + daysPerBook * 24 * 60 * 60 * 1000);
  const today = new Date();
  const daysLeft = Math.ceil((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

  if (daysLeft < -14) return 'Behind pace — finish when you can';
  if (daysLeft < 0)   return `Slightly behind — aim to finish soon`;
  if (daysLeft === 0) return 'Finish today to stay on pace';
  if (daysLeft === 1) return 'Finish tomorrow to stay on pace';
  if (daysLeft <= 5)  return `Finish in ${daysLeft} days to stay on pace`;
  return `On pace — target ${shortDate(target)}`;
}

/**
 * Returns the year-to-date progress note toward the yearly goal.
 * e.g. "7 of 24 books this year (on pace)"
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

  const paceNote = onPace ? 'on pace ✓' : 'behind pace';
  return `${finishedThisYear} of ${yearlyGoal} books this year · ${paceNote}`;
}
