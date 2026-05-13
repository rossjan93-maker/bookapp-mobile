// =============================================================================
// recValidity.ts — P0B Recommendation deck-validity helper
//
// Owns the single source of truth for "is this stored deck state still valid
// for the user's current recommendation configuration?"
//
// Inputs (recommendation-config-relevant preference fields, P0B scope):
//   - favorite_genres
//   - avoid_genres
//   - reading_styles
//   - favorite_authors
//
// Output: a stable string hash carried by all three deck-state stores
// (recPayloadCache, recSession, recQueue). On read, each store calls
// `assertCurrent(stored, current)` and self-invalidates on mismatch.
//
// Forward compatibility (P1):
//   - This helper deliberately does NOT couple to TasteProfile, the recommender
//     pipeline, signal counts, intent state, recMode, or expert plan flags.
//     Those are runtime/pipeline-state concerns — already covered by the
//     existing `computeRecFingerprint` in recPayloadCache.ts which gates
//     prewarm dedup, not restore.
//   - When P1's RecRequest lands, RecRequest.configHash will replace the
//     `string` produced here. The store-side `assertCurrent` API is
//     value-agnostic — swapping the producer is a one-line change at every
//     call site, with no validity-store rewrite.
//   - The version prefix (`rcv1`) lets P1 force-invalidate every pre-P1 deck
//     by bumping to `rcv2` (or by switching to RecRequest's hash directly).
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

const VERSION = 'rcv1';

export type RecConfigInputs = {
  favorite_genres:  readonly string[];
  avoid_genres:     readonly string[];
  reading_styles:   readonly string[];
  favorite_authors: string | null;
};

export type ValidityCheck =
  | { valid: true;  reason: 'match' }
  | { valid: false; reason: 'no_stored_hash' | 'config_mismatch' };

// ── Hash producer ─────────────────────────────────────────────────────────────
//
// Deterministic, order-insensitive, case-insensitive, whitespace-tolerant.
// Two callers with the same logical preferences (regardless of selection
// order, capitalization, or surrounding whitespace) produce the same hash.

function normalizeList(arr: readonly string[] | null | undefined): string {
  if (!arr || arr.length === 0) return '';
  return arr
    .map(s => (s ?? '').trim().toLowerCase())
    .filter(s => s.length > 0)
    .slice()
    .sort()
    .join(',');
}

function normalizeAuthorsString(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .split(',')
    .map(a => a.trim().toLowerCase())
    .filter(a => a.length > 0)
    .sort()
    .join(',');
}

export function computeRecConfigHash(inputs: RecConfigInputs): string {
  return [
    VERSION,
    `fg:${normalizeList(inputs.favorite_genres)}`,
    `ag:${normalizeList(inputs.avoid_genres)}`,
    `rs:${normalizeList(inputs.reading_styles)}`,
    `fa:${normalizeAuthorsString(inputs.favorite_authors)}`,
  ].join('|');
}

// ── Comparison ────────────────────────────────────────────────────────────────

export function assertCurrent(
  stored:  string | null | undefined,
  current: string,
): ValidityCheck {
  if (!stored)              return { valid: false, reason: 'no_stored_hash' };
  if (stored !== current)   return { valid: false, reason: 'config_mismatch' };
  return                            { valid: true,  reason: 'match' };
}

// ── Async loader ──────────────────────────────────────────────────────────────
//
// Convenience wrapper for callers that have a SupabaseClient + userId and
// want the current hash without manually fetching reader_preferences.
// Returns the empty-config hash on any error (never throws); a missing prefs
// row simply produces the hash for "all empty arrays / null author" — which
// is itself a valid stable identity.

export async function loadCurrentConfigHash(
  client: SupabaseClient,
  userId: string,
): Promise<string> {
  try {
    const { data } = await client
      .from('reader_preferences')
      .select('favorite_genres, avoid_genres, reading_styles, favorite_authors')
      .eq('user_id', userId)
      .maybeSingle();
    return computeRecConfigHash({
      favorite_genres:  data?.favorite_genres  ?? [],
      avoid_genres:     data?.avoid_genres     ?? [],
      reading_styles:   data?.reading_styles   ?? [],
      favorite_authors: data?.favorite_authors ?? null,
    });
  } catch {
    return computeRecConfigHash({
      favorite_genres:  [],
      avoid_genres:     [],
      reading_styles:   [],
      favorite_authors: null,
    });
  }
}
