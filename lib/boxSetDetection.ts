// =============================================================================
// boxSetDetection — identify multi-volume bundles and resolve to single volumes
// =============================================================================
//
// User reading history may include "box set", "omnibus", or "complete works"
// editions whose covers misrepresent the row as if a single combined product
// were a real reading milestone. The completed-books row should reflect actual
// individual volumes the reader finished, not grouped products.
//
// Strategy:
//   1. Detect bundle titles via a conservative set of unambiguous patterns.
//      A false positive removes a real cover, so the patterns must be tight.
//   2. When a bundle is detected, attempt to resolve a representative
//      individual-volume cover from the curated SERIES_CATALOG. This is
//      best-effort and only succeeds when author + title hints align.
//   3. When resolution fails, callers should render a clean typographic
//      placeholder (CoverThumb already does this when given no URL).
//
// The catalog lookup is deliberately offline / synchronous — no network calls
// in the render path. The catalog already stores hand-verified canonical
// `olCoverId` values per series volume, which makes for stable, fast lookups.
// =============================================================================

import { getAllSeriesCatalog } from './seriesCatalog';

// ── Detection ────────────────────────────────────────────────────────────────

// Conservative bundle-title patterns. Each pattern alone is enough to flag a
// title — they are unambiguous in practice for English-language Goodreads /
// OpenLibrary metadata.
const BUNDLE_PATTERNS: RegExp[] = [
  /\bbox(ed)?\s*set\b/i,                                      // "Box Set", "Boxed Set", "Boxset"
  /\bomnibus\b/i,                                             // "Omnibus"
  /\bbundle\b/i,                                              // "3-Book Bundle"
  /\bbooks?\s*\d+\s*[-\u2013\u2014]\s*\d+\b/i,                // "Books 1-3", "Book 1–7"
  /\bvolumes?\s*\d+\s*[-\u2013\u2014]\s*\d+\b/i,              // "Volumes 1-5"
  /\b\d+[-\s]*book\b/i,                                       // "8-Book", "3 book"
  /\bcomplete\s+(series|collection|works|trilogy|saga|novels|stories|chronicles)\b/i,
];

export type BookHint = {
  title:       string | null | undefined;
  page_count?: number | null;
};

/**
 * Returns true when the title strongly suggests a multi-volume bundle.
 * Conservative on purpose: a false positive removes a real cover from the row.
 */
export function isBoxSet(book: BookHint): boolean {
  const title = (book.title ?? '').trim();
  if (!title) return false;
  return BUNDLE_PATTERNS.some(re => re.test(title));
}

// ── Canonical-volume cover resolution ────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function authorMatches(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Attempt to find a canonical individual-volume cover URL for a book the
 * caller has already identified as a bundle. Returns null when no curated
 * series matches by author + lexical title overlap, or when the match is
 * ambiguous.
 *
 * Match rule: a series entry qualifies when (a) its first listed book's
 * author matches the bundle's author, and (b) the series displayName (or
 * its catalog key) appears as a substring of the bundle title once both
 * sides have been normalized to lowercase alphanumeric tokens.
 *
 * When several entries qualify (common with same-author universes like
 * "Mistborn" → multiple subseries), the entry whose matched name is the
 * longest substring wins — i.e. the most specific series name. If two or
 * more entries tie at the longest length, this function returns null and
 * lets the caller render a clean placeholder rather than risk surfacing
 * the wrong volume's cover.
 *
 * The first ordered book's `olCoverId` is used as the representative
 * volume, since "Book 1" is the natural single-volume stand-in.
 */
export function resolveIndividualVolumeCover(book: {
  title:  string | null | undefined;
  author: string | null | undefined;
}): string | null {
  const title  = (book.title ?? '').trim();
  const author = (book.author ?? '').trim();
  if (!title || !author) return null;

  const titleNorm = normalize(title);
  if (!titleNorm) return null;

  const catalog = getAllSeriesCatalog();

  let bestLength      = 0;
  let bestCover: string | null = null;
  let bestTieCount    = 0;

  for (const [key, entry] of Object.entries(catalog)) {
    const first = entry.orderedBooks[0];
    if (!first) continue;
    if (!authorMatches(author, first.author)) continue;
    if (typeof first.olCoverId !== 'number') continue;

    const candidates = [entry.displayName, key]
      .map(normalize)
      .filter(Boolean);
    const matched = candidates.filter(c => titleNorm.includes(c));
    if (matched.length === 0) continue;

    const longest = Math.max(...matched.map(c => c.length));

    if (longest > bestLength) {
      bestLength   = longest;
      bestCover    = `https://covers.openlibrary.org/b/id/${first.olCoverId}-M.jpg`;
      bestTieCount = 1;
    } else if (longest === bestLength) {
      bestTieCount += 1;
    }
  }

  // Ambiguous match → safer to render a clean placeholder than to guess.
  return bestTieCount === 1 ? bestCover : null;
}
