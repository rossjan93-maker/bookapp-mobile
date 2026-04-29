// =============================================================================
// Canonical cover URL resolver — single source of truth for which cover image
// to display for any (book, optional user_book) pair across every surface
// (Home, Library, Detail, Inbox, Recommendations, friends' shelves, etc.).
//
// Why this exists
// ---------------
// Before this module existed, each surface picked its own precedence:
//   - Home / Library / Inbox: book.cover_url, then external_id-derived OL URL
//   - Book Detail: editionCoverUrl > coverUrl > enrichedCoverUrl
//
// Only the Book Detail screen ever read user_books.edition_key. So when a
// reader explicitly chose a different cover edition on the detail screen, the
// pick was respected on Detail but ignored everywhere else, producing the
// "different covers across surfaces" trust bug reported in testing.
//
// Resolution order (highest priority first)
//   1. user_books.edition_key              → covers.openlibrary.org/b/olid
//      The user's explicit choice always wins.
//   2. books.cover_url                     → whatever provider URL was
//      stored when the book was first ingested (GB thumbnail, OL URL,
//      manual upload, etc.). This is the canonical default.
//   3. books.external_id (`/works/OLxxxW`) → covers.openlibrary.org/w/olid
//      Last-ditch derivation when no explicit URL is stored.
//   4. null  → caller (CoverThumb) renders the typographic fallback.
//
// Usage
//   import { resolveDisplayCover } from '../lib/coverResolver';
//   <CoverThumb
//     url={resolveDisplayCover({ cover_url, external_id, edition_key })}
//     externalId={external_id}
//     editionKey={edition_key}
//     title={title}
//   />
//
// Passing both `url` and `editionKey` is intentional: CoverThumb's internal
// fallback to `editionKey` is preserved, and `url` short-circuits derivation
// when set, giving us deterministic precedence regardless of which path
// CoverThumb takes internally.
// =============================================================================

export type CoverInputs = {
  cover_url?:   string | null;
  external_id?: string | null;
  edition_key?: string | null;
};

const OL_OLID_RE = /^OL\d+M$/;

export function resolveDisplayCover(inputs: CoverInputs): string | null {
  const { cover_url, external_id, edition_key } = inputs;

  // 1. User's explicit edition pick — highest priority.
  if (edition_key && OL_OLID_RE.test(edition_key)) {
    return `https://covers.openlibrary.org/b/olid/${edition_key}-M.jpg`;
  }

  // 2. Canonical stored URL on the books row.
  if (cover_url && cover_url.length > 0) return cover_url;

  // 3. Derive from /works/OLxxxW external_id as a last resort.
  if (external_id) {
    const m = external_id.match(/\/works\/(OL\w+)/);
    if (m) return `https://covers.openlibrary.org/w/olid/${m[1]}-M.jpg`;
  }

  return null;
}
