// =============================================================================
// boxSetDetection — identify multi-volume bundles, resolve to single volumes,
//                   and surface the series identity used for visual linking
// =============================================================================
//
// The completed-books row needs three things from each book it renders:
//   1. Whether the entry is a box set / omnibus / multi-volume bundle.
//      Bundle covers misrepresent the row as if a grouped product were a
//      real reading milestone.
//   2. A clean cover to show in place of a bundle cover — ideally the
//      canonical first individual volume from the curated SERIES_CATALOG,
//      or null (so CoverThumb falls back to its typographic placeholder).
//   3. The canonical series name so adjacent books from the same series
//      can be visually linked into a single editorial cluster.
//
// Detection strategy (conservative — false positives drop a real cover):
//   • Pattern detection on the title (box set / omnibus / "Books N-M" / …)
//   • Bare series-name detection: if the title (normalized) exactly equals
//     a curated series displayName or catalog key for the same author,
//     treat it as a bundle (e.g. an entry just called "Mistborn Trilogy"
//     or "The Lord of the Rings" is almost always the omnibus, not a
//     single volume).
//
// Catalog matching is offline / synchronous — no network calls in the
// render path. Ambiguity is treated as "unknown": when two curated
// series tie at the longest substring length, the resolver returns null
// so the caller renders a placeholder rather than a wrong volume cover.
// =============================================================================

import {
  getAllSeriesCatalog,
  findSeriesForBook,
  type SeriesCatalogEntry,
} from './seriesCatalog';

// ── Series-suffix extraction ─────────────────────────────────────────────────
//
// Goodreads-style imports often label individual volumes with a trailing
// "(Series Name, #N)" suffix — e.g. "Glint (The Plated Prisoner, #2)".
// Many of those records arrive with the wrong cover URL: the import
// service substitutes a box-set / compilation cover (and, in practice,
// the SAME image is reused across several volumes of the same series).
// When the suffix names a curated series we know about, we trust the
// catalog over the imported cover and substitute the canonical
// single-volume artwork — or a placeholder when the catalog has no
// cover for that volume — never the original (potentially box-set) URL.

/**
 * Pulls "(Series Name, #N)" / "(Series Name #N)" / "(Series Name, Book N)"
 * from the end of a title. Returns null when no recognizable volume
 * marker is present (parentheticals like "(Hardcover edition)" or
 * "(2007)" do not qualify because they have no #N).
 */
function extractSeriesSuffix(
  title: string,
): { series: string; volume: number } | null {
  const m = title.match(/\(([^()]+?)[,\s]+(?:#\s*(\d+)|book\s+(\d+))\)\s*$/i);
  if (!m) return null;
  const seriesRaw = m[1].trim();
  // Must contain at least one letter — guards against pure-number parens.
  if (!/[a-z]/i.test(seriesRaw)) return null;
  const volStr = m[2] ?? m[3];
  if (!volStr) return null;
  return { series: seriesRaw, volume: parseInt(volStr, 10) };
}

/**
 * Look up a curated series by the parenthetical name found in a title.
 * Strips a leading "the " on both sides so "The Plated Prisoner" matches
 * a catalog entry stored as "The Plated Prisoner" or "Plated Prisoner".
 * Author must agree with the curated first-volume author.
 */
function findCatalogEntryBySeriesName(
  seriesNameFromTitle: string,
  author:              string,
): { key: string; entry: SeriesCatalogEntry } | null {
  const stripThe = (s: string) => s.replace(/^the\s+/, '').trim();
  const target = stripThe(normalize(seriesNameFromTitle));
  if (!target) return null;

  for (const [key, entry] of Object.entries(getAllSeriesCatalog())) {
    const first = entry.orderedBooks[0];
    if (!first) continue;
    if (!authorMatches(author, first.author)) continue;

    const candidates = [entry.displayName, key]
      .map(s => stripThe(normalize(s)))
      .filter(Boolean);

    if (candidates.includes(target)) {
      return { key, entry };
    }
  }
  return null;
}

// ── Detection patterns ───────────────────────────────────────────────────────

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
 * Conservative on purpose: a false positive removes a real cover.
 */
export function isBoxSet(book: BookHint): boolean {
  const title = (book.title ?? '').trim();
  if (!title) return false;
  return BUNDLE_PATTERNS.some(re => re.test(title));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function authorMatches(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function coverUrlForOlId(olCoverId: number | undefined): string | null {
  return typeof olCoverId === 'number'
    ? `https://covers.openlibrary.org/b/id/${olCoverId}-M.jpg`
    : null;
}

// ── Catalog matching ─────────────────────────────────────────────────────────

type CatalogMatch = {
  seriesName: string;
  coverUrl:   string | null;
};

/**
 * Walks the curated catalog and finds the entry whose normalized
 * displayName / key is the longest substring of the (normalized) title,
 * scoped to entries where the first ordered book's author matches.
 *
 * Returns null when no entry matches, or when two or more entries tie
 * at the longest substring length (ambiguous → safer to surface no
 * suggestion at all).
 */
function findCatalogBundleMatch(
  title:  string,
  author: string,
): CatalogMatch | null {
  const titleNorm = normalize(title);
  if (!titleNorm || !author) return null;

  let bestLength   = 0;
  let bestMatch:   CatalogMatch | null = null;
  let bestTieCount = 0;

  for (const [key, entry] of Object.entries(getAllSeriesCatalog())) {
    const first = entry.orderedBooks[0];
    if (!first) continue;
    if (!authorMatches(author, first.author)) continue;

    const candidates = [entry.displayName, key]
      .map(normalize)
      .filter(Boolean);
    const matched = candidates.filter(c => titleNorm.includes(c));
    if (matched.length === 0) continue;

    const longest = Math.max(...matched.map(c => c.length));

    if (longest > bestLength) {
      bestLength   = longest;
      bestMatch    = { seriesName: key, coverUrl: coverUrlForOlId(first.olCoverId) };
      bestTieCount = 1;
    } else if (longest === bestLength) {
      bestTieCount += 1;
    }
  }

  return bestTieCount === 1 ? bestMatch : null;
}

// Canonical bundle suffixes that callers may append to a series name when
// logging an omnibus edition with no other bundle keywords (e.g.
// "Mistborn Trilogy", "The Lord of the Rings Saga"). Stripping the suffix
// lets the bare-name matcher line up with catalog keys like "Mistborn".
const BUNDLE_SUFFIX_RE =
  /\s+(trilogy|duology|tetralogy|quartet|quintet|saga|series|collection|chronicles|cycle|omnibus)$/i;

/**
 * Bare-series-name match: the title (normalized — optionally with a
 * canonical bundle suffix like "Trilogy" stripped) exactly equals the
 * catalog displayName or key for an entry whose first book's author
 * matches. Catches bundle entries that use no bundle keywords
 * (e.g. just "Mistborn Trilogy" or "The Lord of the Rings") and pairs
 * them with the series so we can substitute the canonical first-volume
 * cover and group them visually.
 *
 * Critical false-positive guard: many curated series have a Book 1
 * whose title is identical to the series displayName ("Shadow and Bone",
 * "A Court of Thorns and Roses", etc.). When the input title exactly
 * matches any individual volume in the candidate series, we treat it
 * as that volume — not a bundle — and skip the match.
 */
function findBareSeriesNameMatch(
  title:  string,
  author: string,
): CatalogMatch | null {
  const titleNorm = normalize(title);
  if (!titleNorm || !author) return null;

  const stripped     = title.replace(BUNDLE_SUFFIX_RE, '').trim();
  const strippedNorm = normalize(stripped);

  // Collect every catalog entry that exact-matches (with or without
  // canonical bundle suffix). If more than one entry qualifies for the
  // same author, the input is ambiguous and we return null so the caller
  // renders a clean placeholder rather than guessing the wrong series.
  const hits: CatalogMatch[] = [];

  for (const [key, entry] of Object.entries(getAllSeriesCatalog()) as Array<
    [string, SeriesCatalogEntry]
  >) {
    const first = entry.orderedBooks[0];
    if (!first) continue;
    if (!authorMatches(author, first.author)) continue;

    // False-positive guard: prefer the individual-volume path when the
    // input title is literally one of the books in this series.
    const isIndividualVolume = entry.orderedBooks.some(
      b => normalize(b.title) === titleNorm,
    );
    if (isIndividualVolume) continue;

    const names = [entry.displayName, key]
      .map(normalize)
      .filter(Boolean);

    const hit =
      names.includes(titleNorm) ||
      (strippedNorm.length > 0 && strippedNorm !== titleNorm && names.includes(strippedNorm));

    if (hit) {
      hits.push({ seriesName: key, coverUrl: coverUrlForOlId(first.olCoverId) });
    }
  }

  return hits.length === 1 ? hits[0] : null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Backward-compatible: returns just the canonical first-volume cover URL
 * for a book the caller has already identified as a bundle. Prefer
 * `resolveBookDisplay` for new code.
 */
export function resolveIndividualVolumeCover(book: {
  title:  string | null | undefined;
  author: string | null | undefined;
}): string | null {
  const title  = (book.title ?? '').trim();
  const author = (book.author ?? '').trim();
  if (!title || !author) return null;
  return findCatalogBundleMatch(title, author)?.coverUrl ?? null;
}

export type BookDisplay = {
  /** Canonical series key from SERIES_CATALOG, or null if unknown / not in a series. */
  seriesName: string | null;
  /** Cover URL to render. Null → CoverThumb falls back to typographic placeholder. */
  coverUrl:   string | null;
  /**
   * External id passed to CoverThumb. For bundles this is forced to null so
   * CoverThumb cannot derive an OL cover from the bundle's work id. For
   * individual volumes the original external_id is preserved.
   */
  externalId: string | null;
  /**
   * True when the input represents a multi-volume bundle (box set, omnibus,
   * "Books N-M", or a bare series-name title that matches a bundle edition).
   * False for individual volumes (including ones whose cover was overridden
   * via series-suffix catalog lookup). Callers use this to keep bundles from
   * being absorbed into adjacent same-series clusters in editorial rows.
   */
  isBundle:   boolean;
};

/**
 * Single source of truth for what the completed-books row should show
 * for a given book — both the cover URL and the series identity used
 * for visual grouping.
 *
 * Resolution order:
 *   1. Bare series-name match (e.g. title is exactly "Mistborn Trilogy").
 *      Treated as a bundle even without bundle keywords; cover replaced
 *      with the first volume's canonical cover (or placeholder if
 *      unavailable), and series identity returned for grouping.
 *   2. Pattern-detected bundle (box set / omnibus / "Books N-M" / …).
 *      Same treatment as (1), with catalog lookup by author + longest
 *      substring match.
 *   3. Individual volume. The original cover_url and external_id are
 *      preserved; series identity is enriched via findSeriesForBook so
 *      adjacent same-series volumes can still be grouped.
 */
export function resolveBookDisplay(book: {
  title:        string | null | undefined;
  author:       string | null | undefined;
  page_count?:  number | null;
  cover_url:    string | null;
  external_id:  string | null;
}): BookDisplay {
  const title  = (book.title ?? '').trim();
  const author = (book.author ?? '').trim();

  // 0) Title encodes "(Series Name, #N)" suffix. Trust the curated catalog
  //    over the imported cover — Goodreads-style imports routinely return
  //    box-set / compilation art for individual volumes (Plated Prisoner is
  //    a known case where Glint #2 and Gleam #3 share the same wrong cover).
  //    If the catalog has the right olCoverId, substitute it; otherwise
  //    fall back to a placeholder rather than risk showing a bundle cover.
  if (title && author) {
    const suffix = extractSeriesSuffix(title);
    if (suffix) {
      const catalog = findCatalogEntryBySeriesName(suffix.series, author);
      if (catalog) {
        const idx = suffix.volume - 1;
        const vol = catalog.entry.orderedBooks[idx];
        return {
          seriesName: catalog.key,
          coverUrl:   vol?.olCoverId ? coverUrlForOlId(vol.olCoverId) : null,
          externalId: null,
          isBundle:   false,
        };
      }
    }
  }

  // 1) Bare series-name title — almost always the bundle edition.
  if (title && author) {
    const bare = findBareSeriesNameMatch(title, author);
    if (bare) {
      return {
        seriesName: bare.seriesName,
        coverUrl:   bare.coverUrl,
        externalId: null,
        isBundle:   true,
      };
    }
  }

  // 2) Pattern-detected bundle.
  if (isBoxSet({ title, page_count: book.page_count })) {
    const matched = title && author ? findCatalogBundleMatch(title, author) : null;
    return {
      seriesName: matched?.seriesName ?? null,
      coverUrl:   matched?.coverUrl ?? null,
      externalId: null,
      isBundle:   true,
    };
  }

  // 3) Individual volume — keep original cover, enrich with series name.
  const found = title && author ? findSeriesForBook(title, author) : null;
  return {
    seriesName: found?.seriesName ?? null,
    coverUrl:   book.cover_url,
    externalId: book.external_id,
    isBundle:   false,
  };
}
