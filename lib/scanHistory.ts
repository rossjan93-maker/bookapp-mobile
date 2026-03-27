// =============================================================================
// scanHistory — persistence helpers for scan_history table
//
// Keeps scan results so users can revisit past verdicts and so the app can
// surface a history list in future.
//
// All calls fail silently: history is a best-effort supplement and must
// never block the scan result screen.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScanFitResult }  from './scanFitEval';

export type ScanHistoryRow = {
  id:           string;
  isbn:         string;
  title:        string;
  author:       string;
  cover_url:    string | null;
  external_id:  string | null;
  score:        number | null;
  verdict:      string | null;
  confidence:   string | null;
  reasons:      string[];
  caution:      string | null;
  action_taken: string | null;
  low_signal:   boolean;
  scanned_at:   string;
};

// ── Persist a scan result ─────────────────────────────────────────────────────
// Returns the new scan_history row ID so the caller can later update
// action_taken without a second lookup.

export async function persistScan(
  client: SupabaseClient,
  userId: string,
  result: ScanFitResult,
): Promise<string | null> {
  try {
    const { data, error } = await client
      .from('scan_history')
      .insert({
        user_id:     userId,
        isbn:        result.book.isbn || result.book.title,
        title:       result.book.title,
        author:      result.book.author,
        cover_url:   result.book.cover_url,
        external_id: result.external_id,
        score:       +result.score.toFixed(3),
        verdict:     result.verdict,
        confidence:  result.confidence,
        reasons:     result.reasons,
        caution:     result.caution,
        low_signal:  result.low_signal,
      })
      .select('id')
      .single();

    if (error) return null;
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

// ── Record the action taken after showing a result ───────────────────────────

export async function updateScanAction(
  client:      SupabaseClient,
  scanId:      string,
  actionTaken: 'saved' | 'dismissed' | 'more_like_this',
): Promise<void> {
  try {
    await client
      .from('scan_history')
      .update({ action_taken: actionTaken })
      .eq('id', scanId);
  } catch {
    // best-effort
  }
}

// ── Load recent scan history for a user ──────────────────────────────────────

export async function loadScanHistory(
  client: SupabaseClient,
  userId: string,
  limit  = 20,
): Promise<ScanHistoryRow[]> {
  try {
    const { data } = await client
      .from('scan_history')
      .select('*')
      .eq('user_id', userId)
      .order('scanned_at', { ascending: false })
      .limit(limit);

    return (data ?? []) as ScanHistoryRow[];
  } catch {
    return [];
  }
}
