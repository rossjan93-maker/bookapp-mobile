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

import { Image } from 'react-native';

export const DEMO_COVERS = {
  thursdayMurderClub:  'https://covers.openlibrary.org/b/isbn/9781984880963-M.jpg',
  midnightLibrary:     'https://covers.openlibrary.org/b/isbn/9780525559474-M.jpg',
  projectHailMary:     'https://covers.openlibrary.org/b/isbn/9780593135204-M.jpg',
  songOfAchilles:      'https://covers.openlibrary.org/b/isbn/9781408816073-M.jpg',
  atomicHabits:        'https://covers.openlibrary.org/b/isbn/9780735211292-M.jpg',
} as const;

/**
 * Warms the native image cache for all 5 demo cover URLs.
 *
 * Call once when the walkthrough overlay mounts — before any cover
 * is rendered in a focal card — so every CoverThumb hits cache and
 * appears instantly instead of waiting for a cold network fetch.
 *
 * Safe to call multiple times; Image.prefetch is idempotent.
 */
export function prefetchDemoCovers(): void {
  Object.values(DEMO_COVERS).forEach((url) => {
    Image.prefetch(url).catch(() => {});
  });
}
