import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Reader Signals — derived-feature foundation for future adaptive intelligence
// =============================================================================

export type ReadingSignals = {
  completionRate: number | null;      // finished / (finished + dnf),  0–1
  dnfRate: number | null;             // dnf / (finished + dnf),        0–1
  avgPagesPerDay: number | null;      // derived from progress event history
  recConversionRate: number | null;   // recs received that became finished, 0–1
};

// -----------------------------------------------------------------------------
// computeAvgPagesPerDay — pure helper, reusable outside the full signal pass
// -----------------------------------------------------------------------------
export function computeAvgPagesPerDay(
  events: Array<{ user_book_id: string; page: number; created_at: string }>,
): number | null {
  if (events.length < 2) return null;

  const byBook = new Map<string, Array<{ page: number; created_at: string }>>();
  for (const e of events) {
    if (!byBook.has(e.user_book_id)) byBook.set(e.user_book_id, []);
    byBook.get(e.user_book_id)!.push(e);
  }

  const velocities: number[] = [];
  for (const evts of byBook.values()) {
    if (evts.length < 2) continue;
    const first = evts[0];
    const last  = evts[evts.length - 1];
    const days  =
      (new Date(last.created_at).getTime() - new Date(first.created_at).getTime()) /
      86_400_000;
    if (days >= 1 && last.page > first.page) {
      velocities.push((last.page - first.page) / days);
    }
  }

  if (velocities.length === 0) return null;
  return Math.round(velocities.reduce((a, b) => a + b, 0) / velocities.length);
}

// -----------------------------------------------------------------------------
// computeReadingSignals — full async pass for background analytics use
// -----------------------------------------------------------------------------
export async function computeReadingSignals(
  client: SupabaseClient,
  userId: string,
): Promise<ReadingSignals> {
  const [finishedRes, dnfRes, progressRes, recTotalRes, recConvertedRes] = await Promise.all([
    client
      .from('user_books')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'finished'),
    client
      .from('user_books')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'dnf'),
    client
      .from('reading_progress_events')
      .select('user_book_id, page, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true }),
    client
      .from('recommendations')
      .select('*', { count: 'exact', head: true })
      .eq('to_user_id', userId),
    client
      .from('recommendations')
      .select('*', { count: 'exact', head: true })
      .eq('to_user_id', userId)
      .eq('status', 'finished'),
  ]);

  const finished = finishedRes.count ?? 0;
  const dnf      = dnfRes.count ?? 0;
  const resolved = finished + dnf;

  const completionRate = resolved > 0 ? +(finished / resolved).toFixed(2) : null;
  const dnfRate        = resolved > 0 ? +(dnf      / resolved).toFixed(2) : null;

  const avgPagesPerDay = computeAvgPagesPerDay(
    (progressRes.data ?? []) as Array<{ user_book_id: string; page: number; created_at: string }>,
  );

  const totalRecs     = recTotalRes.count ?? 0;
  const convertedRecs = recConvertedRes.count ?? 0;
  const recConversionRate = totalRecs > 0 ? +(convertedRecs / totalRecs).toFixed(2) : null;

  return { completionRate, dnfRate, avgPagesPerDay, recConversionRate };
}

// =============================================================================
// Source Completion — compares completion rate for self-picked vs recommended
// =============================================================================

export type SourceCompletion = {
  selfRate:     number | null;  // finished / (finished + dnf) for self_added books
  recRate:      number | null;  // finished / (finished + dnf) for recommendation books
  selfResolved: number;         // self_added finished + dnf total
  recResolved:  number;         // recommendation finished + dnf total
};

// -----------------------------------------------------------------------------
// computeSourceCompletion — pure function, accepts raw counts
// -----------------------------------------------------------------------------
export function computeSourceCompletion(
  selfFinished: number,
  selfDnf:      number,
  recFinished:  number,
  recDnf:       number,
): SourceCompletion {
  const selfResolved = selfFinished + selfDnf;
  const recResolved  = recFinished  + recDnf;
  return {
    selfRate:     selfResolved > 0 ? selfFinished / selfResolved : null,
    recRate:      recResolved  > 0 ? recFinished  / recResolved  : null,
    selfResolved,
    recResolved,
  };
}

// -----------------------------------------------------------------------------
// sourceCompletionInsight — returns one editorial sentence or null
//
// Threshold rules:
//   - Both buckets must have ≥ 3 resolved books (finished + dnf) to compare
//   - At least 10 percentage points absolute difference to state a direction
//   - Within 10 pp: "almost as often" language (no directional claim)
// -----------------------------------------------------------------------------
export function sourceCompletionInsight(sc: SourceCompletion): string | null {
  const { selfRate, recRate, selfResolved, recResolved } = sc;

  if (selfRate === null || recRate === null) return null;
  if (selfResolved < 3 || recResolved < 3) return null;

  const diff = selfRate - recRate; // positive → self better, negative → rec better

  if (Math.abs(diff) < 0.10) {
    return "Recommendations are landing almost as often as your own picks.";
  }
  if (diff >= 0.10) {
    return "You finish self-picked books more often than recommended ones.";
  }
  return "You finish recommended books more often than your own picks — your friends know your taste.";
}

// =============================================================================
// Rating signals — explicit user taste model foundation
// =============================================================================

export type RatingSignals = {
  avgRating:        number | null;   // mean rating across all rated books, 1–5
  ratedCount:       number;          // how many books have an explicit rating
  lovedCount:       number;          // rating = 5
  notForMeCount:    number;          // rating <= 2
};

// -----------------------------------------------------------------------------
// computeRatingSignals — fetch and derive the user's explicit taste signals
// -----------------------------------------------------------------------------
export async function computeRatingSignals(
  client: SupabaseClient,
  userId: string,
): Promise<RatingSignals> {
  const { data } = await client
    .from('user_books')
    .select('rating')
    .eq('user_id', userId)
    .not('rating', 'is', null);

  const ratings = (data ?? []).map((r: { rating: number }) => r.rating);
  if (ratings.length === 0) {
    return { avgRating: null, ratedCount: 0, lovedCount: 0, notForMeCount: 0 };
  }

  const sum          = ratings.reduce((a: number, b: number) => a + b, 0);
  const avgRating    = +( sum / ratings.length).toFixed(2);
  const lovedCount   = ratings.filter((r: number) => r === 5).length;
  const notForMeCount = ratings.filter((r: number) => r <= 2).length;

  return { avgRating, ratedCount: ratings.length, lovedCount, notForMeCount };
}

// =============================================================================
// Directional trust — compares landing rate in each direction between two users
// =============================================================================

// -----------------------------------------------------------------------------
// directionalTrustInsight — for Friend Detail screen
//
// Threshold rules:
//   - Both directions need ≥ 3 sent to compare (otherwise asymmetric data)
//   - At least 10 percentage points absolute difference to state a direction
//   - Within 10 pp: "similar rate" — no directional claim
// -----------------------------------------------------------------------------
export function directionalTrustInsight(
  recsSentToMe:   number,
  iFinished:      number,
  recsSentToThem: number,
  theyFinished:   number,
  friendFirstName: string,
): string | null {
  if (recsSentToMe < 3 || recsSentToThem < 3) return null;

  const inRate  = iFinished   / recsSentToMe;
  const outRate = theyFinished / recsSentToThem;
  const diff    = inRate - outRate;

  if (Math.abs(diff) < 0.10) {
    return "Both directions are landing at a similar rate.";
  }
  if (diff >= 0.10) {
    return `${friendFirstName}'s recommendations land more often for you than yours do for them.`;
  }
  return `Your recommendations are landing more often for ${friendFirstName} than theirs are for you.`;
}
