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
 * Active shelves: Romantasy, Long Reads, Comfort Reads.
 * Shelves that mirror an existing status chip (reading / dnf) are intentionally
 * excluded — shelves earn their space by crossing axes the chips cannot.
 * Shelves with 0 matching books are silently dropped by ShelfRow.
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
 * Word-boundary subject matcher for a book's subjects field.
 * subjects may be a text[] from Postgres (arrives as string[]) or a
 * legacy comma-separated string. Returns true if ANY of the provided
 * keywords match as a whole word (or whole phrase) in ANY subject string.
 *
 * Uses \b anchors on both sides to prevent false positives from incidental
 * substring sequences — e.g. "war" does not match "award", "romance" does
 * not match "necromancer". Multi-word keywords (e.g. "love stories") are
 * matched as complete phrases using word boundaries on the outer edges only.
 *
 * Special regex characters in keywords are escaped before compilation so
 * "self-harm" (contains a hyphen) works correctly.
 */
export function matchesSubjects(item: BookItem, keywords: string[]): boolean {
  const raw = item.book?.subjects;
  if (!raw) return false;

  const subjectList: string[] = Array.isArray(raw)
    ? raw
    : String(raw).split(/[,;|]+/).map(s => s.trim()).filter(Boolean);

  return keywords.some(kw => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex   = new RegExp(`\\b${escaped}\\b`, 'i');
    return subjectList.some(s => regex.test(s));
  });
}

export const SHELF_DEFINITIONS: ShelfDefinition[] = [
  {
    id: 'romantasy',
    label: 'Romantasy',
    filter: item =>
      matchesSubjects(item, ['romance', 'romantic', 'love stories']) &&
      matchesSubjects(item, ['fantasy', 'magic', 'supernatural', 'paranormal']),
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
