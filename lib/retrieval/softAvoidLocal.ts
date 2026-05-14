// =============================================================================
// retrieval/softAvoidLocal.ts — P2C local-candidate soft-avoid filter
//
// Pure helpers for retrieval-side soft-avoid handling on locally-sourced
// candidates (catalog rows from getLocalCandidates + the catalog-exhaustion
// fallback scan). The branch planner only sees OL retrieval; local catalog
// candidates bypass it entirely. Pre-P2C this meant a user with a soft-
// avoided AffinityKey still saw a full catalog draw of that genre.
//
// "Demote, not exclude" — soft avoid is a bias, not a hard filter (hard
// avoid is P4 territory). The filter keeps `ceil(N * (1 - multiplier))`
// of the soft-avoided candidates, sliced from the head of the input list
// (deterministic — no shuffle — so re-running the pipeline produces the
// same pool).
//
// Subject → AffinityKey resolution uses LIKED_SUBJECT_AVOID_GUARDS from
// lib/recPolicy.ts so the curated-substring vocabulary lives in one place.
// =============================================================================

import { LIKED_SUBJECT_AVOID_GUARDS, SOFT_AVOID_RETRIEVAL_MULTIPLIER } from '../recPolicy';
import type { AffinityKey } from '../taxonomy/genres';

/** Returns the FIRST soft-avoided AffinityKey whose guard substrings match
 *  any of the candidate's subjects. Returns null when no soft-avoided key
 *  matches, or when inputs are empty/null. Pure / synchronous. */
export function classifyCandidateAvoidKey(
  subjects:   readonly string[] | null | undefined,
  softAvoids: readonly AffinityKey[],
): AffinityKey | null {
  if (!subjects || subjects.length === 0) return null;
  if (!softAvoids || softAvoids.length === 0) return null;

  const lowered = subjects
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map(s => s.toLowerCase());
  if (lowered.length === 0) return null;

  for (const key of softAvoids) {
    const guards = LIKED_SUBJECT_AVOID_GUARDS[key];
    if (!guards || guards.length === 0) continue;
    for (const guard of guards) {
      const g = guard.toLowerCase();
      if (lowered.some(s => s.includes(g))) return key;
    }
  }
  return null;
}

export type LocalSoftAvoidResult<T> = {
  /** Surviving candidates in original order — non-avoided first, plus
   *  ceil(N*(1-multiplier)) of the soft-avoided ones. */
  kept:         T[];
  /** Number of soft-avoided candidates dropped (informational, surfaced
   *  via RankedRecsResult.meta.soft_avoid_retrieval). */
  demotedCount: number;
};

/** Demotes — does NOT exclude — local candidates whose subjects classify
 *  into a soft-avoided AffinityKey. Keeps `ceil(N * (1 - multiplier))` of
 *  them, deterministically sliced from the head of the input. Non-avoided
 *  candidates pass through unchanged in their original positions. */
export function applyLocalSoftAvoidFilter<T>(
  candidates: readonly T[],
  softAvoids: readonly AffinityKey[],
  classify:   (b: T) => readonly string[] | null | undefined,
): LocalSoftAvoidResult<T> {
  if (candidates.length === 0 || softAvoids.length === 0) {
    return { kept: [...candidates], demotedCount: 0 };
  }

  // First pass: classify each candidate as avoided or not.
  const flagged = candidates.map(c => ({
    book:    c,
    avoided: classifyCandidateAvoidKey(classify(c), softAvoids) !== null,
  }));

  const avoidedCount = flagged.filter(f => f.avoided).length;
  if (avoidedCount === 0) {
    return { kept: [...candidates], demotedCount: 0 };
  }

  // Keep ceil(N * (1 - multiplier)) of the avoided. With multiplier=0.5
  // and N=6 → keep 3, drop 3. Sliced from the head of the input order so
  // determinism is preserved across runs (no shuffle).
  const keepAvoided = Math.ceil(avoidedCount * (1 - SOFT_AVOID_RETRIEVAL_MULTIPLIER));
  let avoidedSeen = 0;
  const kept: T[] = [];
  for (const f of flagged) {
    if (!f.avoided) {
      kept.push(f.book);
      continue;
    }
    if (avoidedSeen < keepAvoided) {
      kept.push(f.book);
    }
    avoidedSeen += 1;
  }

  return { kept, demotedCount: avoidedCount - keepAvoided };
}
