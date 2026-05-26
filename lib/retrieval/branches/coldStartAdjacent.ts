// =============================================================================
// retrieval/branches/coldStartAdjacent.ts — Cold-Start Retrieval Expansion
//                                            Phase B branch (live for cold_start)
//
// Pulls "one step adjacent" subject anchors for cold-start users whose
// stated favorites map to a populated adjacency entry (Mystery + Thriller
// in the current slice). Phase A shipped the branch production-inert
// (quota=0 everywhere). Phase B (2026-05-21) flips
// BRANCH_QUOTAS.cold_start.coldStartAdjacent to 3 — the first live
// admission. thin and high_signal stay at 0 (high_signal forever, per
// mature-profile invariant).
//
// Branch contract (mirrors statedGenres.ts):
//   - Pure / synchronous.
//   - Reads ADJACENT_RETRIEVAL_ANCHORS keyed by the user's stated favorite
//     GenreId set (via stated favoriteGenres → mapped GenreId).
//   - Soft-avoid defense-in-depth: if a favorite genre's AffinityKey is in
//     softAvoids, that genre's adjacency anchors are skipped (same rule as
//     statedGenres).
//   - Returns `[]` on quota=0 or zero stated favorites or empty adjacency
//     map for every favorite (e.g., Fantasy in Phase A — no adjacency
//     entries yet).
//   - NO popular-book fallback. NO best-seller fallback. NO generic-slop
//     fallback. Empty in → empty out. This is the safety invariant.
//
// Phase B hard constraints (do not weaken without a planning chapter +
// approval; pinned by scripts/validate_cold_start_adjacent.ts):
//   - cold_start quota = 3. thin = 0. high_signal = 0 (mature-profile
//     invariant; locked forever).
//   - No composer / RecCard / queue-boundary-gate / No-dark consumption.
//     Adjacency items flow through the same scoring, lens, and queue-boundary
//     machinery as primary candidates; lens-aware breadth modulation is
//     Phase B.1.
//   - recValidity.VERSION = rcv7 + COLD_START_RETRIEVAL_POLICY_VERSION
//     folded into the hash so cold-start decks built under quota=0
//     (Phase A) are discarded on first foreground after deploy.
//   - Adjacency map covers Mystery + Thriller ONLY this slice.
// =============================================================================

import type { RecRequest } from '../../recRequest';
import {
  ADJACENT_RETRIEVAL_ANCHORS,
  GENRE_DEFS,
  type AffinityKey,
  type GenreId,
} from '../../taxonomy/genres';
import type { FetchItem } from '../types';

/** Map AffinityKey → GenreId(s). The stated taste signal carries
 *  AffinityKeys (the rec-policy-compiled form), but the adjacency map is
 *  keyed by GenreId (the public taxonomy form). This resolver walks
 *  GENRE_DEFS to produce the inverse. Computed once at module load. */
const AFFINITY_TO_GENRE_IDS: Readonly<Record<string, readonly GenreId[]>> = (() => {
  const out: Record<string, GenreId[]> = {};
  for (const def of GENRE_DEFS) {
    const list = out[def.affinityKey] ?? (out[def.affinityKey] = []);
    list.push(def.id);
  }
  return out;
})();

export function buildColdStartAdjacentBranch(req: RecRequest, quota: number): FetchItem[] {
  if (quota <= 0) return [];

  const favorites = req.signals.statedTaste.favoriteGenres;
  if (favorites.length === 0) return [];

  const avoidSet = new Set<AffinityKey>(req.signals.softAvoids.genres);

  const items: FetchItem[] = [];
  const seen = new Set<string>();   // anchor de-dup across favorite genres

  for (const key of favorites) {
    if (items.length >= quota) break;
    if (avoidSet.has(key)) continue;   // defense-in-depth: skip soft-avoided

    // AffinityKey → GenreId(s) → ADJACENT_RETRIEVAL_ANCHORS lookup.
    const genreIds = AFFINITY_TO_GENRE_IDS[key] ?? [];
    for (const gid of genreIds) {
      if (items.length >= quota) break;
      const anchors = ADJACENT_RETRIEVAL_ANCHORS[gid];
      if (!anchors || anchors.length === 0) continue;   // genre has no adjacency yet
      for (const anchor of anchors) {
        if (items.length >= quota) break;
        if (seen.has(anchor)) continue;
        seen.add(anchor);
        items.push({
          kind:        'subject',
          value:       anchor,
          reason:      `cold_start_adjacent:${gid}`,
          branch:      'coldStartAdjacent',
          signalClass: 'stated_durable',
        });
      }
    }
  }
  return items;
}

/** Phase A shadow-evidence helper. Pure projection of what
 *  `buildColdStartAdjacentBranch` WOULD emit at a hypothetical Phase B
 *  quota, WITHOUT touching the live deck. Validator + DEV+FORENSIC log
 *  consume this; production retrieval does NOT. */
export function simulateColdStartAdjacent(req: RecRequest, hypotheticalQuota: number): {
  hypotheticalQuota: number;
  statedGenresUsed:  readonly AffinityKey[];
  anchorsWouldRun:   readonly string[];
  itemsWouldEmit:    readonly FetchItem[];
} {
  const itemsWouldEmit = buildColdStartAdjacentBranch(req, hypotheticalQuota);
  return {
    hypotheticalQuota,
    statedGenresUsed: req.signals.statedTaste.favoriteGenres,
    anchorsWouldRun:  itemsWouldEmit.map(i => i.value),
    itemsWouldEmit,
  };
}
