// ─── Seeded starter picks ────────────────────────────────────────────────────
//
// A small hand-curated set of broadly-appealing books shown ONLY to zero-signal
// users (tier < 1 AND library_size === 0) on the For-You tab so they have
// something concrete to tap instead of a wall of CTAs.
//
// Strict invariants — DO NOT relax without re-running the verification query:
//
//   1. Every entry must already exist in the production `books` catalog with
//      provenance_state = 'verified'.
//   2. external_id must be canonical Open Library `/works/OL...W` format
//      (no goodreads:, no gb:, no onboarding_isbn_*).
//   3. id, title, author, cover_url, page_count are baked in at build time
//      so the strip renders without any network fetch.
//
// Behavior contract:
//   - These picks are NOT recommendations. They never enter the recommender
//     pipeline, never affect feedback signals, never affect taste profile.
//   - Tap → routes to /book/[id] using the catalog UUID directly. Standard
//     book-detail flow takes over from there (Want-to-Read, Add to stack, etc).
//   - The strip header is labelled "Popular starting points · Not personalized
//     yet" so the contract is unambiguous to the user.
//
// Verified against production catalog 2026-05-10.
// Re-validate quarterly (P2 follow-up) in case any row drifts out of
// 'verified' state. If a row is ever missing or its provenance flips, the
// whole strip stays standing — we render only the rows that exist when tapped
// (the navigation target uses the baked id directly).

export type SeededPick = {
  id:          string;   // books.id (UUID, stable)
  external_id: string;   // /works/OL...W canonical
  title:       string;
  author:      string;
  cover_url:   string;
  page_count:  number;
  lane:        'literary' | 'fantasy' | 'romance' | 'sci_fi' | 'nonfiction' | 'thriller';
};

export const SEEDED_PICKS: ReadonlyArray<SeededPick> = [
  {
    id:          '3b0160a9-f5de-426d-90f4-ddd1e7c682f4',
    external_id: '/works/OL18766691W',
    title:       'Where the Crawdads Sing',
    author:      'Delia Owens',
    cover_url:   'https://covers.openlibrary.org/b/isbn/9780735224292-M.jpg',
    page_count:  432,
    lane:        'literary',
  },
  {
    id:          '8585d1cf-41ad-4de3-8160-35fe3982c9eb',
    external_id: '/works/OL17332479W',
    title:       'Six of Crows',
    author:      'Leigh Bardugo',
    cover_url:   'https://covers.openlibrary.org/b/id/12667417-M.jpg',
    page_count:  512,
    lane:        'fantasy',
  },
  {
    id:          '6bcd81ef-5cea-47df-84ad-393df97aaa4c',
    external_id: '/works/OL20734329W',
    title:       'Beach Read',
    author:      'Emily Henry',
    cover_url:   'https://covers.openlibrary.org/b/isbn/9780451491992-M.jpg',
    page_count:  384,
    lane:        'romance',
  },
  {
    id:          '517ad99e-a4c0-45d0-9cbd-875c6e1145d3',
    external_id: '/works/OL21745884W',
    title:       'Project Hail Mary',
    author:      'Andy Weir',
    cover_url:   'https://books.google.com/books/content?id=GrYsEAAAQBAJ&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api',
    page_count:  496,
    lane:        'sci_fi',
  },
  {
    id:          'ae451461-08b7-4452-9adc-0b025e981ed1',
    external_id: '/works/OL17930368W',
    title:       'Atomic Habits',
    author:      'James Clear',
    cover_url:   'https://books.google.com/books/content?id=WmqyDwAAQBAJ&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api',
    page_count:  322,
    lane:        'nonfiction',
  },
  {
    id:          '061645b9-96b2-4e03-b055-73006f57a186',
    external_id: '/works/OL16239762W',
    title:       'Gone Girl',
    author:      'Gillian Flynn',
    cover_url:   'https://covers.openlibrary.org/b/isbn/9780307588371-M.jpg',
    page_count:  497,
    lane:        'thriller',
  },
];
