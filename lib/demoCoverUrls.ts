/**
 * Deterministic cover image URLs for all demo/onboarding fixture books.
 *
 * Uses Open Library ISBN-based CDN URLs — stable public endpoints backed by
 * the Internet Archive. These do not rotate, expire, or require auth.
 *
 * Format: https://covers.openlibrary.org/b/isbn/{ISBN}-M.jpg
 * -M = medium size (~180px wide), suitable for all card thumbnail slots.
 *
 * Add new demo books here so every screen that shows them gets the same URL
 * without copy-pasting strings.
 */

export const DEMO_COVERS = {
  thursdayMurderClub:  'https://covers.openlibrary.org/b/isbn/9781984880963-M.jpg',
  midnightLibrary:     'https://covers.openlibrary.org/b/isbn/9780525559474-M.jpg',
  projectHailMary:     'https://covers.openlibrary.org/b/isbn/9780593135204-M.jpg',
  songOfAchilles:      'https://covers.openlibrary.org/b/isbn/9781408816073-M.jpg',
  atomicHabits:        'https://covers.openlibrary.org/b/isbn/9780735211292-M.jpg',
} as const;
