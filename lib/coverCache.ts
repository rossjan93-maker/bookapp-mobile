// =============================================================================
// Cover Cache — session-level outcome memoisation
// =============================================================================
//
// Two module-level Sets live for the lifetime of the JS bundle (i.e. one app
// session).  They prevent redundant work without any network calls or database
// writes.
//
// 1. failedDerivedCoverUrls
//    CoverThumb constructs OL cover URLs from externalId / editionKey when no
//    stored url is available.  The derived URL may 404 (OL has no image for that
//    edition).  Once we know a derived URL is dead we record it here so any
//    re-render of the same book skips the attempt entirely and goes straight to
//    the typographic fallback.  This fires most often during scroll recycling.
//
// 2. coverAttemptedBookIds
//    metadataRepair calls Google Books for every book with cover_url=null.
//    When GB returns nothing (or OL returned nothing) we mark the book id here.
//    Subsequent repair passes — triggered by library load, book-detail open, etc.
//    — skip the book until the app is restarted.  Books that genuinely have no
//    cover online stop causing API round-trips per session.
//
// Neither set is persisted.  A fresh app start gets a clean slate, which is
// correct — providers update their data over time and a new session should retry.
//
// =============================================================================

// ── 1. Derived-URL failure cache ─────────────────────────────────────────────

const failedDerivedCoverUrls = new Set<string>();

/** Call from CoverThumb onError when a derived (non-stored) OL URL fails. */
export function markCoverUrlFailed(url: string): void {
  failedDerivedCoverUrls.add(url);
}

/**
 * Returns true when this derived URL already failed to load in this session.
 * CoverThumb should treat the URL as null when this returns true.
 */
export function isCoverUrlKnownFailed(url: string): boolean {
  return failedDerivedCoverUrls.has(url);
}

// ── 2. Repair-attempt deduplication cache ────────────────────────────────────

const coverAttemptedBookIds = new Set<string>();

/**
 * Called by metadataRepair after a full provider pass returned no cover for
 * a book.  Prevents the same book from triggering GB/OL calls again this session.
 */
export function markCoverAttempted(bookId: string): void {
  coverAttemptedBookIds.add(bookId);
}

/**
 * Returns true when a cover lookup for this book already ran (and failed) in
 * this session.  metadataRepair skips these books entirely.
 */
export function wasCoverAttempted(bookId: string): boolean {
  return coverAttemptedBookIds.has(bookId);
}

// ── Stats / reset (dev / testing) ────────────────────────────────────────────

export function coverCacheStats(): { failedUrls: number; attemptedBooks: number } {
  return {
    failedUrls:     failedDerivedCoverUrls.size,
    attemptedBooks: coverAttemptedBookIds.size,
  };
}

export function resetCoverCache(): void {
  failedDerivedCoverUrls.clear();
  coverAttemptedBookIds.clear();
}
