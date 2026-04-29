// =============================================================================
// Open Library — metadata fetch helper
// =============================================================================
// fetchOLMeta — fetches description, subjects, and page_count from a
// /works/{OLID}.json endpoint.  Falls back to scanning editions for page_count
// when the work-level value is absent or implausibly small.
//
// fetchEditions — fetches all known editions for a work, normalized to a
// consistent shape for the edition picker.  Results are cached per work ID
// to avoid redundant network calls within a session.
//
// Shared by:
//   - lib/metadataRepair.ts  (import-time and library-time batch repair)
//   - app/book/[id].tsx      (single-book self-healing on Book Detail open)
// =============================================================================

import { titleSearchVariants } from './titleNormalize';

export type OLMeta = {
  description: string | null;
  subjects:    string[];
  pageCount:   number | null;
};

// Normalized shape for a single Open Library edition.
// editionKey is the bare OL edition ID (e.g. "OL12345M"), not the full /books/ path.
// coverKey is the same as editionKey when the edition has covers — used to build
// the OLID-based cover URL: covers.openlibrary.org/b/olid/{coverKey}-M.jpg
// languages is a list of BCP-style language codes extracted from OL's
// [{key: "/languages/eng"}] array.  Empty array means OL carries no language
// metadata for this edition — treated as potentially English (not excluded).
export type OLEdition = {
  editionKey: string;
  publisher:  string | null;
  year:       string | null;
  pageCount:  number | null;
  isbn:       string | null;
  coverKey:   string | null;
  languages:  string[];
};

/**
 * Rank editions by language preference and metadata quality.
 *
 * Scoring (higher = better):
 *   +100  language matches preferLang (or edition has no language data — treated
 *         as ambiguous/English rather than excluded)
 *   +10   has page count
 *   + 8   has cover
 *   + 4   has publisher (non-"n/a")
 *   + 2   has ISBN
 *
 * The 100-point language bonus ensures every preferred-language edition
 * outranks every foreign-language edition regardless of quality.
 * Within each language tier, editions sort by descending quality score.
 */
export function rankEditions(
  editions: OLEdition[],
  preferLang = 'eng',
): OLEdition[] {
  function score(ed: OLEdition): number {
    const langMatch =
      ed.languages.length === 0 || ed.languages.includes(preferLang) ? 100 : 0;
    const pub = ed.publisher?.toLowerCase().trim();
    const hasPublisher = !!pub && pub !== 'n/a' && pub !== 'na';
    const quality =
      (ed.pageCount               ? 10 : 0) +
      (ed.coverKey                ?  8 : 0) +
      (hasPublisher               ?  4 : 0) +
      (ed.isbn                    ?  2 : 0);
    return langMatch + quality;
  }
  return [...editions].sort((a, b) => score(b) - score(a));
}

// Module-level editions cache keyed by OL work ID (e.g. "OL37620917W").
// Cleared on JS context restart (app kill / hard reload).  Max 40 entries
// is enough to avoid GC pressure — LRU eviction not needed at this scale.
const _editionsCache = new Map<string, OLEdition[]>();
const EDITIONS_MAX   = 40;

// Returns true when id is a valid Open Library works identifier (/works/OL...).
// Use this to distinguish OL ids from Goodreads-prefixed values written by the
// old import path (goodreads:{id}) or any other non-OL external_id format.
export function isOLId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith('/works/OL');
}

// Searches Open Library by title + author and returns the best matching works key
// (e.g. "/works/OL37620917W").  Used when a books row has no external_id — common
// for Goodreads-imported books where the OL identifier was never populated.
//
// Tries multiple title variants in order (original → series-stripped → colon-stripped)
// so that Goodreads titles like "Glow (The Plated Prisoner, #4)" still resolve even
// though OL indexes the work as just "Glow".  Stops at the first variant that returns
// a result.  Returns null on any network/parse failure or when no variant matches.
export async function searchOLWork(
  title:  string,
  author: string,
): Promise<string | null> {
  if (!title.trim()) return null;

  const variants = titleSearchVariants(title);
  const a = encodeURIComponent(author.trim().slice(0, 60));

  for (const variant of variants) {
    try {
      const t   = encodeURIComponent(variant.trim().slice(0, 80));
      const url = `https://openlibrary.org/search.json?title=${t}&author=${a}&limit=3&fields=key,title`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data.docs) || data.docs.length === 0) continue;
      const first = data.docs[0];
      if (typeof first.key === 'string' && first.key.startsWith('/works/')) {
        return first.key;
      }
    } catch {
      // network error for this variant — try next
    }
  }

  return null;
}

export function extractOLID(externalId: string): string | null {
  const m = externalId.match(/\/works\/(OL\w+)/);
  return m ? m[1] : null;
}

export async function fetchOLMeta(externalId: string): Promise<OLMeta> {
  const olid = extractOLID(externalId);
  if (!olid) return { description: null, subjects: [], pageCount: null };

  try {
    const res = await fetch(`https://openlibrary.org/works/${olid}.json`);
    if (!res.ok) return { description: null, subjects: [], pageCount: null };
    const data = await res.json();

    let description: string | null = null;
    if (typeof data.description === 'string')       description = data.description;
    else if (data.description?.value)               description = data.description.value;

    const subjects: string[] = Array.isArray(data.subjects)
      ? (data.subjects as string[]).slice(0, 8)
      : [];

    let pageCount: number | null =
      typeof data.number_of_pages === 'number' ? data.number_of_pages : null;

    // Work-level page count is often missing or wrong. Scan editions as fallback.
    if (!pageCount || pageCount < 30) {
      try {
        const edRes = await fetch(
          `https://openlibrary.org/works/${olid}/editions.json?limit=50`,
        );
        if (edRes.ok) {
          const edData = await edRes.json();
          const pages: number[] = [];
          if (Array.isArray(edData.entries)) {
            for (const ed of edData.entries) {
              const np = ed.number_of_pages;
              if (typeof np === 'number' && np >= 30) pages.push(np);
            }
          }
          if (pages.length > 0) {
            pages.sort((a, b) => a - b);
            pageCount = pages[Math.floor(pages.length / 2)]; // median
          }
        }
      } catch {
        // edition scan failure is not fatal
      }
    }

    const crediblePageCount =
      pageCount != null && pageCount >= 30 ? pageCount : null;

    return { description, subjects, pageCount: crediblePageCount };
  } catch {
    return { description: null, subjects: [], pageCount: null };
  }
}

/**
 * Fetch editions for an OL work and return a normalized list.
 * Results are cached per work ID for the lifetime of the JS context.
 *
 * Fetches the first 50 editions via the OL editions endpoint.  This covers
 * the vast majority of works — only extremely prolific classics (e.g. Hamlet)
 * have more than 50 distinct editions with useful metadata.  The cap is a
 * deliberate trade-off between coverage and latency; increase limit if the
 * product needs broader coverage for multi-edition books.
 *
 * Returns an empty array when:
 *  - externalId is not a valid OL works ID
 *  - the editions endpoint fails or returns no parseable entries
 *  - all editions lack page count, publisher, and year (unusable)
 */
export async function fetchEditions(externalId: string): Promise<OLEdition[]> {
  const olid = extractOLID(externalId);
  if (!olid) return [];

  const cached = _editionsCache.get(olid);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://openlibrary.org/works/${olid}/editions.json?limit=50`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data.entries)) return [];

    const editions: OLEdition[] = [];

    for (const ed of data.entries) {
      // Edition key: strip the "/books/" prefix → bare ID like "OL12345M"
      const rawKey = typeof ed.key === 'string' ? ed.key : null;
      if (!rawKey) continue;
      const editionKey = rawKey.replace(/^\/books\//, '');

      // Page count — must be credible (≥ 30)
      const pageCount =
        typeof ed.number_of_pages === 'number' && ed.number_of_pages >= 30
          ? ed.number_of_pages
          : null;

      // Publisher — first entry in the publishers array
      const publisher =
        Array.isArray(ed.publishers) && typeof ed.publishers[0] === 'string'
          ? (ed.publishers[0] as string)
          : null;

      // Year — extract 4-digit year from publish_date string (e.g. "2001", "June 2001")
      let year: string | null = null;
      if (typeof ed.publish_date === 'string') {
        const m = (ed.publish_date as string).match(/\d{4}/);
        if (m) year = m[0];
      }

      // ISBN — prefer ISBN-13, fall back to ISBN-10
      const isbn =
        Array.isArray(ed.isbn_13) && typeof ed.isbn_13[0] === 'string'
          ? (ed.isbn_13[0] as string)
          : Array.isArray(ed.isbn_10) && typeof ed.isbn_10[0] === 'string'
          ? (ed.isbn_10[0] as string)
          : null;

      // Cover — use the edition key for OLID-based cover URL when covers exist
      const hasCover = Array.isArray(ed.covers) && ed.covers.length > 0 && (ed.covers[0] as number) > 0;
      const coverKey = hasCover ? editionKey : null;

      // Languages — OL sends [{key: "/languages/eng"}, ...]; extract bare codes.
      // Editions with no languages array are treated as unknown (not excluded).
      const languages: string[] = Array.isArray(ed.languages)
        ? (ed.languages as { key?: string }[])
            .map(l => (typeof l.key === 'string' ? l.key.replace('/languages/', '') : ''))
            .filter(Boolean)
        : [];

      // Only include editions that give the picker something useful to show:
      // a page count, a publisher name, OR a cover image. The cover-only case
      // is critical for the "change cover" flow — many real editions have only
      // a cover plus year/ISBN, and rejecting them used to leave the picker
      // with just a few results even for popular books.  A year alone is still
      // insufficient (would render as a bare "1998" row), so we keep that out.
      if (!pageCount && !publisher && !coverKey) continue;

      editions.push({ editionKey, publisher, year, pageCount, isbn, coverKey, languages });
    }

    // Cache the result (evict oldest entry when full)
    if (_editionsCache.size >= EDITIONS_MAX) {
      const firstKey = _editionsCache.keys().next().value;
      if (firstKey !== undefined) _editionsCache.delete(firstKey);
    }
    _editionsCache.set(olid, editions);

    return editions;
  } catch {
    return [];
  }
}
