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
//     by bumping to `rcv4` (or by switching to RecRequest's hash directly).
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { COLD_START_RETRIEVAL_POLICY_VERSION } from './recPolicy';

// P3A-6-C (2026-05-16): bumped rcv1 → rcv4 alongside the
// COMPOSER_REASONS_PROJECTION_ENABLED flip in lib/explanations/projection.ts.
// Persisted `PersistedRecPayload.recs[].reasons[]` survives up to 2h via
// `recPayloadCache`; the bump force-invalidates any pre-flip payload so the
// For-You surface never mixes legacy + composer-derived reason strings after
// deploy. All three deck-state stores (recPayloadCache, recSession,
// recQueue) self-invalidate on mismatch via `assertCurrent`.
//
// P4C.1 (2026-05-16): bumped rcv4 → rcv5 to force-invalidate decks scored
// under the pre-P4C.1 (observe-only) regime. Persisted payloads contain
// `score` and ordering computed without the new P4 intent stack
// (`_score_breakdown.p4_intent_stack`); restoring those into a UI now wired
// to expect P4C.1 ordering would expose a stale-vs-live mix on the first
// session-open after deploy. Composer output remains byte-identical (P4C
// kinds stay suppressed in `not_yet_emitted`), so the bump is purely
// score/order-driven, not reason-text-driven.
// rcv6 (2026-05-18) — P4D narrow composer admission lands. tone_fit,
// pace_fit, and series_continuation_fit may now produce visible
// composer-backed reasons[] lines under strict per-kind gates
// (specific confidence + signedEligible + above floor; match-only for
// tone/pace; priorReadCount > 0 for series). Bumped from rcv5 to
// invalidate any persisted recPayloadCache that still carries
// pre-P4D reasons[] (the visible text surface can now include lines
// the legacy builder never emitted).
// rcv7 (2026-05-21) — Cold-Start Retrieval Expansion · Phase B lands.
// BRANCH_QUOTAS.cold_start.coldStartAdjacent flips 0 → 3 — the first
// live admission of adjacency candidates. Any persisted cold-start deck
// written under rcv6 was built under quota=0 (no adjacency) and must
// be discarded so the next foreground produces a deck that includes
// the new branch's contribution. Belt-and-suspenders: the explicit
// COLD_START_RETRIEVAL_POLICY_VERSION constant is also folded into the
// hash below so any future cold-start policy change invalidates caches
// without needing a separate VERSION bump.
// rcv8 (2026-05-26) — Phase B.0 Tier-Definition Cleanup lands.
// `ConfidenceMode` union split 3 → 4: `cold_start` retired as a value;
// `zero_signal` + `sparse_onboarding` replace it; `thin` + `high_signal`
// unchanged at the type level. The live `coldStartAdjacent=3` quota
// re-keys from `cold_start` (effectively unreachable) onto both new
// tier-0 modes. Any persisted deck tagged with an rcv7 hash was scored
// inside a recommender that thought `confidenceMode` could be
// `'cold_start'`; that string is no longer in the union. Force-invalidate
// at the hash layer so every device discards its cache and rebuilds on
// next foreground rather than relying on consumer-side defensive coding.
// rcv9 (2026-06-22) — rawTier fix. recRequest.ts now passes
// profile.rawTier (computed from the UNBOOSTED strongSignalCount) into
// confidenceModeForTier instead of the boosted profile.tier. Before this
// fix, fresh intake-only users with no library were classified as `thin`
// (tier=1 after boost) instead of `sparse_onboarding` (rawTier=0,
// intakeBoosted=true), giving them quota=0 cold-start adjacency instead
// of quota=3. The boosted `tier` field still feeds all scoring, copy,
// and UI paths unchanged. Any deck persisted under rcv8 was built with
// the wrong ConfidenceMode for intake users and must be discarded.
const VERSION = 'rcv9';

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
    `csrp:${COLD_START_RETRIEVAL_POLICY_VERSION}`,
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
