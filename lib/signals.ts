import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Reader Signals — derived-feature foundation for future adaptive intelligence
// =============================================================================
// These functions compute lightweight behavioral signals from raw event data.
// Nothing is surfaced in the UI yet; this layer exists so the data can be
// queried reliably once the feature set evolves.
// =============================================================================

export type ReadingSignals = {
  completionRate: number | null;      // finished / (finished + dnf),  0–1
  dnfRate: number | null;             // dnf / (finished + dnf),        0–1
  avgPagesPerDay: number | null;      // derived from progress event history
  recConversionRate: number | null;   // recs received that became finished, 0–1
};

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

  // Completion / DNF rates
  const finished = finishedRes.count ?? 0;
  const dnf      = dnfRes.count ?? 0;
  const resolved = finished + dnf;

  const completionRate = resolved > 0 ? +(finished / resolved).toFixed(2) : null;
  const dnfRate        = resolved > 0 ? +(dnf      / resolved).toFixed(2) : null;

  // Average pages/day — computed per book from the progress event timeline
  let avgPagesPerDay: number | null = null;

  if (progressRes.data && progressRes.data.length >= 2) {
    const byBook = new Map<string, Array<{ page: number; created_at: string }>>();

    for (const e of progressRes.data) {
      if (!byBook.has(e.user_book_id)) byBook.set(e.user_book_id, []);
      byBook.get(e.user_book_id)!.push(e);
    }

    const velocities: number[] = [];

    for (const events of byBook.values()) {
      if (events.length < 2) continue;
      const first = events[0];
      const last  = events[events.length - 1];
      const days  = (new Date(last.created_at).getTime() - new Date(first.created_at).getTime()) / 86_400_000;

      if (days >= 1 && last.page > first.page) {
        velocities.push((last.page - first.page) / days);
      }
    }

    if (velocities.length > 0) {
      avgPagesPerDay = Math.round(
        velocities.reduce((a, b) => a + b, 0) / velocities.length,
      );
    }
  }

  // Recommendation conversion rate
  const totalRecs     = recTotalRes.count ?? 0;
  const convertedRecs = recConvertedRes.count ?? 0;
  const recConversionRate = totalRecs > 0 ? +(convertedRecs / totalRecs).toFixed(2) : null;

  return { completionRate, dnfRate, avgPagesPerDay, recConversionRate };
}
