// =============================================================================
// retrieval/branches/revealedAuthors.ts — P2A revealed-author retrieval branch
//
// Wraps the pre-P2A author-anchor logic from getOLCandidates verbatim:
//   - dense path: top 3 from det_lanes.repeated_liked_authors
//   - non-dense path: top 1 from profile.liked_authors
//
// Reason prefixes preserved (`repeated_author:` / `author_anchor:`) so the
// existing trace extraction in getOLCandidates continues to work without
// parsing changes.
// =============================================================================

import type { BranchContext, FetchItem } from '../types';

export function buildRevealedAuthorsBranch(ctx: BranchContext, quota: number): FetchItem[] {
  if (quota <= 0) return [];
  const items: FetchItem[] = [];

  if (ctx.isDense) {
    for (const author of ctx.repeatedAuthors.slice(0, quota)) {
      items.push({
        kind: 'author', value: author,
        reason: `repeated_author:${author}`,
        branch: 'revealedAuthors',
        signalClass: 'revealed_behavioral',
      });
    }
  } else {
    for (const author of ctx.likedAuthors.slice(0, quota)) {
      items.push({
        kind: 'author', value: author,
        reason: `author_anchor:${author}`,
        branch: 'revealedAuthors',
        signalClass: 'revealed_behavioral',
      });
    }
  }

  return items;
}
