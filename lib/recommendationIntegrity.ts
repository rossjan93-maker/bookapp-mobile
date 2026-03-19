// ── Recommendation Integrity Layer (RIL) ────────────────────────────────────
//
// Sits between scoring / CoG classification and the final set-composition
// engine. Enforces editorial correctness rules before any book is surfaced
// to the user.
//
// Pipeline position:
//   candidate retrieval
//   → scoring / fit classification (recommender.ts)
//   → [this module] Recommendation Integrity Layer
//   → composition engine (recommender.ts)
//   → user-facing recs
//
// Rules enforced:
//   1. Entry-point integrity — never recommend a later-volume series book as
//      an entry point to a reader who hasn't established a relationship with
//      that author. Suppress to audit; series starters are clearly labelled.
//   2. Series flooding collapse — when multiple books from the same series
//      are in the pool, keep only the appropriate representative (book 1
//      for new readers; lowest unread volume for established readers).
//   3. Series labelling — annotate every book with its series role so the
//      UI can render editorial cues ("Start here", "Continue the series").
//
// Design principles:
//   - Conservative: when series info is uncertain, pass the book through
//     unchanged. Better to show a slightly-wrong recommendation than to
//     incorrectly suppress a valid one.
//   - General: no hardcoded book or series names. All logic is signal-driven.
//   - Cohort-safe: RIL is a no-op for light/non-dense users (no repeated-
//     author evidence) and for books without detectable series metadata.

import type { ScoredBook, ScoreBreakdown } from './recommender';

// ── Types ──────────────────────────────────────────────────────────────────

export type SeriesLabel =
  | 'series_starter'      // book 1 of a detected series  → "Start here"
  | 'series_continuation' // later volume, user HAS read author → "Continue the series"
  | 'series_later_volume' // later volume, user NOT familiar with author → suppressed

export type SeriesPosition = {
  series_name:     string;
  series_position: number;   // 1 = first book, 2 = second, etc.
};

export type IntegrityLayerResult = {
  visible:             ScoredBook[];  // passed to composition engine
  integritySuppressed: ScoredBook[];  // audit-only; removed from visible set
};

// ── Series position detection ────────────────────────────────────────────────
//
// Attempts to extract (series name, position) from the book's title.
// Open Library frequently includes this in the form:
//   "Words of Radiance (The Stormlight Archive, #2)"
//   "The Well of Ascension (Mistborn, #2)"
//   "House of Earth and Blood (Crescent City, #1)"
//
// When no pattern matches we return null — conservative fallback means the
// book passes through with no series annotation, not suppressed.

const SERIES_RE: RegExp[] = [
  // "(Series Name, #2)" or "(Series Name, #2.5)"   — comma before hash
  /\(([^)]+?),\s*#(\d+(?:\.\d+)?)\)/,
  // "(Series Name #2)" without comma
  /\(([^)]+?)\s#(\d+(?:\.\d+)?)\)/,
  // "(Series Name, Book 2)" or "(Series Name, Vol. 2)"
  /\(([^)]+?),\s*(?:Book|Vol\.?|Volume)\s+(\d+)\)/i,
  // "Title, Book 2" at end of string
  /,\s*(?:Book|Vol\.?|Volume)\s+(\d+)$/i,
];

export function detectSeriesPosition(
  title: string | null | undefined,
): SeriesPosition | null {
  if (!title) return null;

  for (const re of SERIES_RE) {
    const m = title.match(re);
    if (!m) continue;

    // The last two capture groups are always (series_name, position_number)
    // except for the final pattern which only has one group (just position)
    const groups = m.slice(1).filter(Boolean);
    if (groups.length === 2) {
      const pos = parseFloat(groups[1]);
      if (!isNaN(pos) && pos >= 1) {
        return {
          series_name:     groups[0].trim(),
          series_position: Math.floor(pos),
        };
      }
    }
  }
  return null;
}

// ── Series label derivation ──────────────────────────────────────────────────
//
// Given a detected series position and the user's relationship to the author,
// assign the appropriate editorial label.
//
//   series_starter     — position 1: this is the entry point. Always safe to show.
//   series_continuation — position > 1 AND user has read this author before:
//                         valid "next in series" recommendation.
//   series_later_volume — position > 1 AND user has NOT established familiarity:
//                         integrity violation; should be suppressed from visible set.

export function deriveSeriesLabel(
  series: SeriesPosition | null,
  repeated_author_match: boolean,
): SeriesLabel | null {
  if (!series) return null;
  if (series.series_position === 1) return 'series_starter';
  if (repeated_author_match)         return 'series_continuation';
  return 'series_later_volume';
}

// ── Main integrity layer ─────────────────────────────────────────────────────
//
// Runs the full annotation + dedup pass over a scored, CoG-classified pool.
// Returns { visible, integritySuppressed }.
//
// The `visible` list feeds into the composition engine.
// The `integritySuppressed` list is appended to the audit/debug output.
//
// Steps:
//   1. Annotate every book with series info and series_label.
//   2. Group books by (author, series_name) to identify series flooding.
//   3. Within each group: keep the best entry-point, suppress redundant volumes.
//   4. Partition into visible / integritySuppressed.

function rilId(b: ScoredBook): string {
  return b.external_id ?? `${b.author}::${b.title}`;
}

export function applyIntegrityLayer(
  books: ScoredBook[],
  // Reserved for future use (e.g. CoG lane weights to inform priority ordering within a series group)
  _cog?: unknown,
): IntegrityLayerResult {

  // ── Step 1: Annotate ──────────────────────────────────────────────────────
  type Annotated = {
    book:      ScoredBook;
    series:    SeriesPosition | null;
    label:     SeriesLabel | null;
  };

  const annotated: Annotated[] = books.map(book => {
    const series  = detectSeriesPosition(book.title);
    const repeated = !!(book._score_breakdown.repeated_author_match);
    const label   = deriveSeriesLabel(series, repeated);

    // Write annotation into score breakdown for debug visibility
    book._score_breakdown = {
      ...book._score_breakdown,
      series_name:     series?.series_name     ?? null,
      series_position: series?.series_position ?? null,
      series_label:    label,
    } as ScoreBreakdown & {
      series_name?: string | null;
      series_position?: number | null;
      series_label?: SeriesLabel | null;
    };

    return { book, series, label };
  });

  // ── Step 2: Build series group map ────────────────────────────────────────
  // Key: lowercase "author::series_name"
  type SeriesGroup = {
    has_book_1:    boolean;
    best_position: number;       // lowest detected position in this group
    members:       Annotated[];
  };

  const seriesGroups = new Map<string, SeriesGroup>();

  for (const item of annotated) {
    if (!item.series) continue;   // no series detected → not grouped
    const aKey    = item.book.author.toLowerCase();
    const sKey    = item.series.series_name.toLowerCase();
    const groupKey = `${aKey}::${sKey}`;

    if (!seriesGroups.has(groupKey)) {
      seriesGroups.set(groupKey, {
        has_book_1:    false,
        best_position: Infinity,
        members:       [],
      });
    }
    const group = seriesGroups.get(groupKey)!;
    group.members.push(item);
    if (item.series.series_position === 1)       group.has_book_1 = true;
    if (item.series.series_position < group.best_position) {
      group.best_position = item.series.series_position;
    }
  }

  // ── Step 3: Mark books to suppress ────────────────────────────────────────
  const suppressedIds = new Set<string>();

  for (const [, group] of seriesGroups) {
    if (group.members.length <= 1) continue;  // only one book from this series → no dedup

    // Sort members by position ascending so "best" is always the lowest
    group.members.sort(
      (a, b) => (a.series?.series_position ?? 99) - (b.series?.series_position ?? 99)
    );

    const [best, ...rest] = group.members;
    const bestPos = best.series!.series_position;
    const bestRepeated = !!(best.book._score_breakdown.repeated_author_match);

    // Suppress all non-best members when the user hasn't established familiarity
    for (const item of rest) {
      const repeated = !!(item.book._score_breakdown.repeated_author_match);
      if (!repeated) {
        const pos = item.series!.series_position;
        suppressedIds.add(rilId(item.book));
        (item.book._score_breakdown as Record<string, unknown>)['ril_suppressed'] = true;
        (item.book._score_breakdown as Record<string, unknown>)['ril_reason'] =
          `series_dedup: position #${pos} suppressed (best available entry point is #${bestPos})`;
      }
      // If repeated: user is reading through this series → keep with 'series_continuation' label
    }

    // If even the best entry is position > 1 and user hasn't established familiarity
    // with this author, suppress it too (no entry point in the pool, unknown series).
    if (bestPos > 1 && !bestRepeated) {
      suppressedIds.add(rilId(best.book));
      (best.book._score_breakdown as Record<string, unknown>)['ril_suppressed'] = true;
      (best.book._score_breakdown as Record<string, unknown>)['ril_reason'] =
        `series_entry_missing: best available is position #${bestPos}, `
        + `no book 1 in pool, author not established for this reader`;
    }
  }

  // ── Step 4: Partition ─────────────────────────────────────────────────────
  const visible:             ScoredBook[] = [];
  const integritySuppressed: ScoredBook[] = [];

  for (const { book } of annotated) {
    if (suppressedIds.has(rilId(book))) {
      integritySuppressed.push(book);
    } else {
      visible.push(book);
    }
  }

  return { visible, integritySuppressed };
}
