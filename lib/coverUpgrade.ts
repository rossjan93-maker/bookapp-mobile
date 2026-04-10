// =============================================================================
// Cover Upgrade Policy
// =============================================================================
//
// Defines when an existing cover on a book should be replaced with a
// newly-fetched candidate from a different (or higher-confidence) source.
//
// Design philosophy:
//   Conservative — cover churn is disruptive.  When in doubt, keep what's there.
//   The burden of proof is on the candidate: it must be meaningfully better,
//   not merely from a different source.
//
// Rule summary:
//   ┌──────────────────────┬──────────────────────────────────────────────┐
//   │ Current cover source  │ Candidate source / confidence needed to win  │
//   ├──────────────────────┼──────────────────────────────────────────────┤
//   │ google_books + high  │ Never upgrade — already at best possible      │
//   │ google_books + med   │ Never upgrade — lateral move within provider  │
//   │ google_books + low   │ Allow GB high-confidence upgrade only          │
//   │ open_library         │ Allow google_books ISBN-matched upgrade        │
//   │ goodreads            │ Allow google_books ISBN-matched upgrade        │
//   │ null / unknown       │ Always accept any cover (new cover is better  │
//   │                      │ than none)                                     │
//   └──────────────────────┴──────────────────────────────────────────────┘
//
// The upgrade gate is intentionally tight:
//   • Only ISBN-matched GB covers (confidence='high') can trigger an upgrade.
//   • Title-only matches ('medium'/'low') never replace an existing cover.
//   • Goodreads CDN links are treated as the lowest quality that still exists.
//   • Open Library covers are trusted but superseded by ISBN-matched GB covers.
//
// =============================================================================

export type CoverSource = 'google_books' | 'open_library' | 'goodreads' | null;
export type ConfidenceTier = 'high' | 'medium' | 'low';

// ── Source quality ranking ─────────────────────────────────────────────────────
// Used to compare current vs. candidate source quality independently of
// metadata_confidence (which describes how the match was found, not which
// source is inherently better).

const SOURCE_RANK: Record<string, number> = {
  google_books: 3,    // highest — stable CDN, high-resolution
  open_library: 2,    // good — community-maintained, variable resolution
  goodreads:    1,    // lowest — third-party CDN, may 404 without notice
};

function sourceRank(source: string | null): number {
  if (!source) return 0;
  return SOURCE_RANK[source] ?? 0;
}

// ── Upgrade decision ───────────────────────────────────────────────────────────

export type UpgradeCandidate = {
  url:        string | null;
  source:     CoverSource;
  confidence: ConfidenceTier;
};

export type UpgradeDecision =
  | { upgrade: false; reason: string }
  | { upgrade: true;  reason: string };

/**
 * Decide whether to replace the current stored cover with a newly-fetched
 * candidate.
 *
 * @param currentSource      - cover_source value in the books table (null = no cover)
 * @param currentConfidence  - metadata_confidence in the books table (null = unknown)
 * @param candidate          - newly-fetched cover to evaluate
 *
 * @returns UpgradeDecision — always returns the reason for auditability.
 *
 * @example
 *   // Goodreads import cover gets upgraded by ISBN-matched GB cover
 *   shouldUpgradeCover('goodreads', null, { source: 'google_books', confidence: 'high', url: '...' })
 *   // → { upgrade: true, reason: 'goodreads→google_books ISBN match' }
 *
 *   // Existing GB high-confidence cover is never replaced
 *   shouldUpgradeCover('google_books', 'high', { source: 'google_books', confidence: 'high', url: '...' })
 *   // → { upgrade: false, reason: 'already at peak: google_books/high' }
 */
export function shouldUpgradeCover(
  currentSource:     CoverSource | string | null,
  currentConfidence: ConfidenceTier | string | null,
  candidate:         UpgradeCandidate,
): UpgradeDecision {
  // ── Guard: candidate must have a valid URL ──────────────────────────────────
  if (!candidate.url) {
    return { upgrade: false, reason: 'candidate has no URL' };
  }

  // ── Guard: candidate source must be known ───────────────────────────────────
  if (!candidate.source) {
    return { upgrade: false, reason: 'candidate source unknown' };
  }

  // ── No existing cover — always accept ──────────────────────────────────────
  if (!currentSource) {
    return { upgrade: true, reason: 'no existing cover' };
  }

  // ── Already at peak — google_books + high confidence ───────────────────────
  if (currentSource === 'google_books' && currentConfidence === 'high') {
    return { upgrade: false, reason: 'already at peak: google_books/high' };
  }

  // ── Lateral GB move (gb → gb, not a higher confidence) ────────────────────
  if (currentSource === 'google_books' && candidate.source === 'google_books') {
    // Allow only if upgrading from low confidence to high
    if (currentConfidence !== 'low' || candidate.confidence !== 'high') {
      return { upgrade: false, reason: 'lateral google_books move — skipping' };
    }
    return { upgrade: true, reason: 'google_books low→high confidence upgrade' };
  }

  // ── Candidate source is lower or equal rank — never downgrade ──────────────
  const candidateRank = sourceRank(candidate.source);
  const currentRank   = sourceRank(currentSource);
  if (candidateRank <= currentRank) {
    return {
      upgrade: false,
      reason:  `candidate source (${candidate.source}) not higher rank than current (${currentSource})`,
    };
  }

  // ── Higher-rank candidate — only allow ISBN-matched (confidence=high) ───────
  // Title-only matches are not reliable enough to justify replacing an existing cover.
  if (candidate.confidence !== 'high') {
    return {
      upgrade: false,
      reason:  `candidate source is higher rank but confidence is ${candidate.confidence} (need high)`,
    };
  }

  // ── All gates passed — upgrade approved ────────────────────────────────────
  return {
    upgrade: true,
    reason:  `${currentSource}→${candidate.source} ISBN-matched upgrade`,
  };
}

/**
 * Quick predicate for use in conditional guards.
 */
export function willUpgrade(
  currentSource:     CoverSource | string | null,
  currentConfidence: ConfidenceTier | string | null,
  candidate:         UpgradeCandidate,
): boolean {
  return shouldUpgradeCover(currentSource, currentConfidence, candidate).upgrade;
}
