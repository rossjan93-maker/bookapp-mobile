// =============================================================================
// Cover Credibility Guard
// =============================================================================
//
// Lightweight, zero-network URL validation for book cover images.
// Called before attempting to render any cover so bad / unrelated URLs
// are caught before they hit the image loader.
//
// Design contract:
//   • Pure function — no async, no network, no side effects.
//   • Allowlist-only — anything not in the list is rejected.
//   • Used by CoverThumb to decide whether to attempt the image load.
//   • Used by metadataRepair to log credibility failures.
//
// =============================================================================

// ── Allowed provider domains ──────────────────────────────────────────────────
// Only URLs from these domains are considered credible cover sources.
// Add new providers here when integrating additional metadata APIs.

const ALLOWED_COVER_HOSTS: readonly string[] = [
  // Google Books CDN  (books.google.com/books/content?id=...)
  'books.google.com',
  // Google APIs CDN  (sometimes returned as lh*.googleusercontent.com)
  'books.googleusercontent.com',
  // Open Library covers API
  'covers.openlibrary.org',
  // Goodreads / Amazon CDN (imported Goodreads exports)
  'i.gr-assets.com',
  'images-na.ssl-images-amazon.com',
  'm.media-amazon.com',
  // WorldCat / OCLC
  'contentcafe2.btol.com',
  // LibraryThing
  'covers.librarything.com',
];

// ── Result type ───────────────────────────────────────────────────────────────

export type CoverCredibilityResult =
  | { valid: true }
  | { valid: false; reason: 'null_url' | 'not_https' | 'unparseable' | 'unknown_host' | 'no_path' };

// ── Core validation ───────────────────────────────────────────────────────────

/**
 * Validates that a cover URL is from a known provider and structurally sound.
 * Returns { valid: true } or { valid: false, reason } — never throws.
 *
 * @example
 *   validateCoverUrl('https://books.google.com/books/content?id=xyz-M.jpg')
 *   // → { valid: true }
 *
 *   validateCoverUrl('https://randomcdn.io/image.jpg')
 *   // → { valid: false, reason: 'unknown_host' }
 */
export function validateCoverUrl(url: string | null | undefined): CoverCredibilityResult {
  if (!url) return { valid: false, reason: 'null_url' };

  // Must use HTTPS — reject http:// and protocol-relative //
  if (!url.startsWith('https://')) return { valid: false, reason: 'not_https' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'unparseable' };
  }

  // Must have a non-trivial path (avoids bare domain links like https://books.google.com)
  if (!parsed.pathname || parsed.pathname === '/') {
    return { valid: false, reason: 'no_path' };
  }

  // Hostname must match an allowed host exactly or as a subdomain.
  // e.g. 'lh3.googleusercontent.com' is not currently in the list, so it fails.
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_COVER_HOSTS.some(
    allowed => host === allowed || host.endsWith(`.${allowed}`)
  );
  if (!allowed) return { valid: false, reason: 'unknown_host' };

  return { valid: true };
}

/**
 * Convenience predicate — returns true when the URL passes all credibility checks.
 * Use this in render logic; use validateCoverUrl() when you need the failure reason.
 */
export function isCredibleCoverUrl(url: string | null | undefined): boolean {
  return validateCoverUrl(url).valid;
}

/**
 * Returns the credibility result as a human-readable debug string.
 * Intended for [HEALTH] / [COVER] log lines only.
 */
export function coverCredibilityLabel(url: string | null | undefined): string {
  const r = validateCoverUrl(url);
  if (r.valid) return 'ok';
  return r.reason;
}
