// =============================================================================
// retrieval/branches/statedGenres.ts — P2A statedGenres retrieval branch
//
// THE central P2A fix. Pre-P2A, dense users (≥2 dominant lanes OR ≥3 repeated
// authors) had their stated favorite_genres silently ignored at retrieval —
// the dense bypass at lib/recommender.ts:1095 used only repeated_authors +
// dominant_lanes for OL queries. After P1 this was visible (scoring saw the
// stated prefs) but pointless when no candidate from those lanes ever entered
// the pool.
//
// This branch always runs whenever the user has ≥1 mapped favorite_genre,
// regardless of density. Soft-avoid handling: a favorite that also appears
// in soft-avoids is dropped at anchor selection (defense-in-depth — signal-
// level avoid-precedence in lib/recPolicy.computeStatedTasteContribution
// already wins on the scoring side, but skipping the OL fetch saves a
// network call and preserves quota for non-conflicted favorites).
// =============================================================================

import type { RecRequest } from '../../recRequest';
import { AFFINITY_RETRIEVAL_SUBJECTS, type RetrievalAffinityKey } from '../../taxonomy/genres';
import type { FetchItem } from '../types';

export function buildStatedGenresBranch(req: RecRequest, quota: number): FetchItem[] {
  if (quota <= 0) return [];

  const favorites = req.signals.statedTaste.favoriteGenres;
  if (favorites.length === 0) return [];

  const avoidSet = new Set<string>(req.signals.softAvoids.genres);

  const items: FetchItem[] = [];
  for (const key of favorites) {
    if (items.length >= quota) break;
    if (avoidSet.has(key)) continue;  // defense-in-depth: don't retrieve a soft-avoided favorite

    const anchor = AFFINITY_RETRIEVAL_SUBJECTS[key as RetrievalAffinityKey]
      ?? AFFINITY_RETRIEVAL_SUBJECTS.general;
    const [s1, s2] = anchor;

    // Reason prefix is `stated_genre:` (new). The trace extraction in
    // getOLCandidates is updated in the P2A recommender edit to include this
    // prefix in top_genres_used alongside the legacy `genre:` prefix.
    items.push({
      kind: 'subject', value: s1,
      reason: `stated_genre:${key}`,
      branch: 'statedGenres',
      signalClass: 'stated_durable',
    });
    if (items.length < quota && s2) {
      items.push({
        kind: 'subject', value: s2,
        reason: `stated_genre:${key}`,
        branch: 'statedGenres',
        signalClass: 'stated_durable',
      });
    }
  }
  return items;
}
