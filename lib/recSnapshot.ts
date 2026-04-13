/**
 * Durable persistence layer for recommendation evidence.
 *
 * Stores only the rendered user-facing output — the explanation sentence and
 * the evidence tag array. No raw recommender internals (score_breakdown,
 * reasons arrays, lane weights) are persisted.
 *
 * The session cache in lib/recContext.ts is still the primary read source
 * on a fresh tap-through from the rec feed. This module handles:
 *   - Writing a durable copy to rec_snapshots on tap (fire-and-forget)
 *   - Reading that copy back when the session cache is empty
 *
 * Both operations are best-effort and fail silently — the session cache and
 * graceful fallback (prefs CTA or hidden section) handle all error cases.
 */

import { supabase } from './supabase';
import type { RecContext } from './recContext';

/**
 * Persist recommendation evidence to rec_snapshots.
 * Called fire-and-forget from RecCard on tap — do not await.
 */
export async function persistRecSnapshot(
  externalId: string,
  ctx: RecContext,
): Promise<void> {
  if (!externalId) return;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('rec_snapshots').upsert(
      {
        user_id:       user.id,
        external_id:   externalId,
        explanation:   ctx.explanation,
        evidence_tags: ctx.evidenceTags,
        updated_at:    new Date().toISOString(),
      },
      { onConflict: 'user_id,external_id' },
    );
  } catch {
    // Fire-and-forget: session cache already written, swallow DB errors silently.
  }
}

/**
 * Read a persisted recommendation evidence snapshot from Supabase.
 * Returns null if no snapshot exists or if the query fails.
 * Used by the book detail screen when the session cache is empty.
 */
export async function getRecSnapshot(
  userId: string,
  externalId: string,
): Promise<RecContext | null> {
  if (!userId || !externalId) return null;
  try {
    const { data } = await supabase
      .from('rec_snapshots')
      .select('explanation, evidence_tags')
      .eq('user_id', userId)
      .eq('external_id', externalId)
      .single();
    if (!data) return null;
    return {
      explanation:  data.explanation ?? null,
      evidenceTags: data.evidence_tags ?? [],
    };
  } catch {
    return null;
  }
}
