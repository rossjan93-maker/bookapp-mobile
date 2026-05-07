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

export type AuthorReleaseOrder = {
  position: number;        // 1-indexed position of this title within the author's releases
  total:    number;        // total distinct titles by the author with a known year
};

// Pulls an author's catalog from Open Library (search.json?author=…), dedupes
// titles, sorts by first_publish_year ascending, then locates the supplied
// title to compute "Nth release of M". Used by the Add-to-Library confirm
// card when the static series catalog has nothing for this book — gives the
// user useful "where does this fit in the author's bibliography?" context.
//
// Heuristics:
//  - Uses author= (not author_key=) because we only have the display name.
//    OL exact-matches on tokenized name; close enough for our purposes.
//  - Filters to docs whose first_publish_year is a 4-digit integer; titles
//    without a year can't be ranked and would muddy the count.
//  - Filters to language=eng when the OL doc carries a language list, so a
//    Lucy Foley title isn't ranked alongside translated foreign editions
//    that OL counts as separate works.
//  - Dedupes by lowercased, punctuation-stripped title — OL has many
//    re-issues / collected-edition rows that share a title.
//  - Returns null when this title doesn't appear in the catalog OR the
//    catalog has < 2 entries (no useful ordering signal for a 1-book author).
const _authorOrderCache = new Map<string, AuthorReleaseOrder | null>();
export async function fetchAuthorReleaseOrder(
  author: string,
  title: string,
): Promise<AuthorReleaseOrder | null> {
  const cacheKey = `${author.toLowerCase()}|${title.toLowerCase()}`;
  if (_authorOrderCache.has(cacheKey)) return _authorOrderCache.get(cacheKey) ?? null;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const url =
      `https://openlibrary.org/search.json?author=${encodeURIComponent(author)}` +
      `&fields=key,title,first_publish_year,language&limit=100&sort=old`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) { _authorOrderCache.set(cacheKey, null); return null; }
    const data = await res.json() as {
      docs?: { title?: string; first_publish_year?: number; language?: string[] }[];
    };
    const docs = data.docs ?? [];
    const seen = new Set<string>();
    const releases: { title: string; year: number }[] = [];
    for (const d of docs) {
      if (typeof d.title !== 'string' || typeof d.first_publish_year !== 'number') continue;
      // Skip non-English when language metadata is present and excludes English.
      if (Array.isArray(d.language) && d.language.length > 0 && !d.language.includes('eng')) continue;
      const key = d.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      releases.push({ title: d.title, year: d.first_publish_year });
    }
    if (releases.length < 2) { _authorOrderCache.set(cacheKey, null); return null; }
    releases.sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));
    const targetKey = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const idx = releases.findIndex(r =>
      r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === targetKey,
    );
    if (idx < 0) { _authorOrderCache.set(cacheKey, null); return null; }
    const result: AuthorReleaseOrder = { position: idx + 1, total: releases.length };
    _authorOrderCache.set(cacheKey, result);
    return result;
  } catch {
    _authorOrderCache.set(cacheKey, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
  // ── Tiered sort, covers-first ───────────────────────────────────────────────
  // The previous additive scoring let pageCount (+10) outrank coverKey (+8),
  // so a blank-cover edition with a page count would sort above a cover-bearing
  // edition without one. The user-visible result was the "Change cover" sheet
  // leading with white squares — exactly the opposite of its purpose.
  //
  // We now sort by hard tiers in this priority order:
  //   1. Preferred language          (English > non-English)
  //   2. Has cover                   (real cover > no cover)
  //   3. Has publisher (non-"n/a")
  //   4. Has page count
  //   5. Has ISBN
  //   6. Page count desc (deterministic tiebreaker)
  //
  // A single missing cover can never push an edition above a cover-bearing
  // one within the same language tier.
  function langTier(ed: OLEdition): number {
    return ed.languages.length === 0 || ed.languages.includes(preferLang) ? 1 : 0;
  }
  function hasPublisher(ed: OLEdition): boolean {
    const pub = ed.publisher?.toLowerCase().trim();
    return !!pub && pub !== 'n/a' && pub !== 'na';
  }

  const sorted = [...editions].sort((a, b) => {
    if (langTier(b)            !== langTier(a))            return langTier(b) - langTier(a);
    if (!!b.coverKey           !== !!a.coverKey)           return (b.coverKey ? 1 : 0) - (a.coverKey ? 1 : 0);
    if (hasPublisher(b)        !== hasPublisher(a))        return (hasPublisher(b) ? 1 : 0) - (hasPublisher(a) ? 1 : 0);
    if (!!b.pageCount          !== !!a.pageCount)          return (b.pageCount ? 1 : 0) - (a.pageCount ? 1 : 0);
    if (!!b.isbn               !== !!a.isbn)               return (b.isbn ? 1 : 0) - (a.isbn ? 1 : 0);
    return (b.pageCount ?? 0) - (a.pageCount ?? 0);
  });

  // ── Dedup near-identical editions ──────────────────────────────────────────
  // OL frequently lists the same physical printing under multiple work-edition
  // rows that differ only in trivial metadata (extra/no ISBN, slightly different
  // year, or alternate ISBN-10/13 pair). We collapse on (publisher|year|pages)
  // and keep the first occurrence — which, after the tiered sort above, is
  // already the one with the best cover/publisher signal. This noticeably
  // shortens the picker list and removes the "three identical Penguin
  // paperbacks" clutter users complained about.
  const seen = new Set<string>();
  const deduped: OLEdition[] = [];
  for (const ed of sorted) {
    const pub  = ed.publisher?.toLowerCase().trim() ?? '';
    const year = ed.year                            ?? '';
    const pg   = ed.pageCount                       ?? '';
    // Only dedup when at least one identifying field is present, otherwise
    // we'd collapse every "publisher: null, year: null, pages: null" row into
    // a single entry and lose legitimate differing covers.
    if (!pub && !year && !pg) {
      deduped.push(ed);
      continue;
    }
    const key = `${pub}|${year}|${pg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ed);
  }
  return deduped;
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

// ─── ISBN → edition OLID resolution ──────────────────────────────────────────
// Used by the scan flow to attach a specific edition to user_books.edition_key
// after the user saves a scanned book. The ISBN they scanned IS the edition
// they hold, so this is the highest-trust edition signal we'll ever get for
// that reader → that book — without it, the cover precedence falls back to
// books.cover_url, which is the canonical work-level cover and may not match
// the physical copy in the user's hand.
//
// OL has a redirect endpoint (https://openlibrary.org/isbn/{isbn}) and a JSON
// endpoint (https://openlibrary.org/isbn/{isbn}.json). The JSON endpoint
// returns the edition document whose `key` is `/books/OL...M` — the OLID we
// store in user_books.edition_key.
//
// Returns null on any failure: the caller should leave edition_key untouched
// and let the cover precedence chain fall back to the work-level cover.
export async function resolveISBNToEditionKey(isbn: string): Promise<string | null> {
  const cleaned = isbn.replace(/[-\s]/g, '');
  if (!cleaned) return null;
  // Quick shape check — avoid wasting a network call on obvious garbage.
  if (!/^(?:97[89]\d{10}|\d{9}[\dXx])$/.test(cleaned)) return null;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(
      `https://openlibrary.org/isbn/${cleaned}.json`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const data = await res.json() as { key?: string };
    if (typeof data.key !== 'string') return null;
    const m = data.key.match(/\/books\/(OL\w+M)/);
    return m ? m[1] : null;
  } catch (err) {
    console.warn('[openLibrary] resolveISBNToEditionKey failed for', cleaned, ':', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
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
