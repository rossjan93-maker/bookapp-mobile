/**
 * Shelf definitions — single source of truth for all smart-shelf logic.
 *
 * Each ShelfDefinition contains:
 *   id       — stable identifier used for state and keys
 *   label    — display name shown on the shelf card
 *   filter   — receives a BookItem and returns true if it belongs on this shelf
 *
 * User-created shelves can be appended to SHELF_DEFINITIONS without any
 * architectural changes — the ShelfRow component and library screen both
 * derive everything dynamically from this array.
 *
 * Shelves that mirror an existing status chip (reading / dnf) are intentionally
 * excluded — shelves earn their space by crossing axes the chips cannot.
 */

export type BookItem = {
  status: string;
  rating?: number | null;
  sentiment?: string | null;
  book: {
    title: string;
    author: string;
    cover_url: string | null;
    external_id: string;
    page_count?: number | null;
    subjects?: string[] | string | null;
  } | null;
};

export type ShelfDefinition = {
  id: string;
  label: string;
  filter: (item: BookItem) => boolean;
};

/**
 * Case-insensitive partial-match helper for a book's subjects field.
 * subjects may be a text[] from Postgres (arrives as string[]) or a
 * legacy comma-separated string. Returns true if ANY of the provided
 * keywords appear as a substring of ANY subject string.
 */
export function matchesSubjects(item: BookItem, keywords: string[]): boolean {
  const raw = item.book?.subjects;
  if (!raw) return false;

  const subjectList: string[] = Array.isArray(raw)
    ? raw
    : String(raw).split(/[,;|]+/).map(s => s.trim()).filter(Boolean);

  const lower = subjectList.map(s => s.toLowerCase());
  return keywords.some(kw => lower.some(s => s.includes(kw.toLowerCase())));
}

export const SHELF_DEFINITIONS: ShelfDefinition[] = [
  {
    id: 'quick_wins',
    label: 'Quick Wins',
    filter: item =>
      item.status === 'want_to_read' &&
      typeof item.book?.page_count === 'number' &&
      item.book.page_count > 0 &&
      item.book.page_count <= 250,
  },
  {
    id: 'long_reads',
    label: 'Long Reads',
    filter: item =>
      item.status === 'want_to_read' &&
      typeof item.book?.page_count === 'number' &&
      item.book.page_count >= 400,
  },
  {
    id: 'romantasy',
    label: 'Romantasy',
    filter: item =>
      // Romance side: covers "Romance", "Paranormal romance", "Romantic suspense",
      // "Love stories" (OL's most common romance subject tag), "Romantic fantasy"
      matchesSubjects(item, ['romance', 'romantic', 'love stories']) &&
      // Fantasy side: covers "Fantasy fiction" (OL's primary fantasy tag),
      // "Magic", "Supernatural", "Paranormal" (all common in romantasy books)
      matchesSubjects(item, ['fantasy', 'magic', 'supernatural', 'paranormal']),
  },
  {
    id: 'nonfiction_ideas',
    label: 'Nonfiction & Ideas',
    filter: item =>
      matchesSubjects(item, [
        'self-help',
        'self help',
        'psychology',
        'business',
        'personal development',
        'productivity',
        'nonfiction',
        'non-fiction',
      ]),
  },
  {
    id: 'comfort_reads',
    label: 'Comfort Reads',
    filter: item =>
      item.status === 'finished' &&
      (
        (typeof item.rating === 'number' && item.rating >= 4) ||
        item.sentiment === 'loved'
      ),
  },
];
