// =============================================================================
// Open Library — metadata fetch helper
// =============================================================================
// fetchOLMeta — fetches description, subjects, and page_count from a
// /works/{OLID}.json endpoint.  Falls back to scanning editions for page_count
// when the work-level value is absent or implausibly small.
//
// Shared by:
//   - lib/metadataRepair.ts  (import-time and library-time batch repair)
//   - app/book/[id].tsx      (single-book self-healing on Book Detail open)
// =============================================================================

export type OLMeta = {
  description: string | null;
  subjects:    string[];
  pageCount:   number | null;
};

// Returns true when id is a valid Open Library works identifier (/works/OL...).
// Use this to distinguish OL ids from Goodreads-prefixed values written by the
// old import path (goodreads:{id}) or any other non-OL external_id format.
export function isOLId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith('/works/OL');
}

// Searches Open Library by title + author and returns the best matching works key
// (e.g. "/works/OL37620917W").  Used when a books row has no external_id — common
// for Goodreads-imported books where the OL identifier was never populated.
// Returns null on any network/parse failure or when no result is found.
export async function searchOLWork(
  title:  string,
  author: string,
): Promise<string | null> {
  if (!title.trim()) return null;
  try {
    const t = encodeURIComponent(title.trim().slice(0, 80));
    const a = encodeURIComponent(author.trim().slice(0, 60));
    const url =
      `https://openlibrary.org/search.json` +
      `?title=${t}&author=${a}&limit=3&fields=key,title`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.docs) || data.docs.length === 0) return null;
    const first = data.docs[0];
    return typeof first.key === 'string' && first.key.startsWith('/works/')
      ? first.key
      : null;
  } catch {
    return null;
  }
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
