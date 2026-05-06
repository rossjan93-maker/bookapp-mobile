/**
 * Intent matcher — Batch 4.
 *
 * Lightweight, local rule-based parser that turns a free-text query like
 * "mystery", "short fantasy", or "something light" into structured signals
 * (subject keywords, page-count bounds, a free-text fallback) that can be
 * matched against a saved book's metadata.
 *
 * No model calls. No network. Deterministic and cheap so it can run on
 * every keystroke against a few hundred Want-to-Read items.
 *
 * Extending the vocabulary: append to INTENT_VOCAB. Each entry maps a set of
 * trigger phrases (matched as whole words, case-insensitive) to either:
 *   - subject keywords (matched against book.subjects via word-boundary regex)
 *   - a page-count bound (pageMax / pageMin)
 * Multiple intents may fire from one query; results are AND-combined.
 *
 * If no intent words match, the original query degrades to a free-text
 * substring search across title/author/subjects so users always get the
 * "search by typing" affordance.
 */

import { matchesSubjects, type BookItem } from './shelves';

export type IntentSignal =
  | { kind: 'subjects'; keywords: string[]; reason: string }
  | { kind: 'pageMax';  pages: number;       reason: string }
  | { kind: 'pageMin';  pages: number;       reason: string }
  | { kind: 'free';     text: string;        reason: string };

type ProducedSignal =
  | { kind: 'subjects'; keywords: string[]; reason?: string }
  | { kind: 'pageMax';  pages: number;       reason?: string }
  | { kind: 'pageMin';  pages: number;       reason?: string }
  | { kind: 'free';     text: string;        reason?: string };

type VocabEntry = {
  triggers: string[];                                  // whole-word matches
  produces: ProducedSignal;
};

const INTENT_VOCAB: VocabEntry[] = [
  // ── genre / subject ─────────────────────────────────────────────────────
  { triggers: ['mystery', 'mysteries', 'whodunit'],
    produces: { kind: 'subjects', keywords: ['mystery', 'detective', 'crime', 'whodunit'], reason: 'mystery' } },
  { triggers: ['thriller', 'thrillers', 'suspense'],
    produces: { kind: 'subjects', keywords: ['thriller', 'suspense', 'psychological'], reason: 'thriller' } },
  { triggers: ['romance', 'romances', 'romantic'],
    produces: { kind: 'subjects', keywords: ['romance', 'romantic', 'love stories'], reason: 'romance' } },
  { triggers: ['fantasy', 'fantasies'],
    produces: { kind: 'subjects', keywords: ['fantasy', 'magic', 'epic', 'romantasy', 'supernatural'], reason: 'fantasy' } },
  { triggers: ['scifi', 'sci-fi', 'science fiction', 'sf'],
    produces: { kind: 'subjects', keywords: ['science fiction', 'space', 'dystopian', 'cyberpunk'], reason: 'sci-fi' } },
  { triggers: ['horror'],
    produces: { kind: 'subjects', keywords: ['horror', 'gothic', 'supernatural'], reason: 'horror' } },
  { triggers: ['historical'],
    produces: { kind: 'subjects', keywords: ['historical', 'historical fiction'], reason: 'historical' } },
  { triggers: ['literary'],
    produces: { kind: 'subjects', keywords: ['literary fiction', 'literary', 'character-driven'], reason: 'literary' } },
  { triggers: ['memoir', 'memoirs', 'biography', 'autobiography'],
    produces: { kind: 'subjects', keywords: ['memoir', 'biography', 'autobiography', 'personal narrative'], reason: 'memoir / biography' } },
  { triggers: ['nonfiction', 'non-fiction'],
    produces: { kind: 'subjects', keywords: ['nonfiction', 'non-fiction', 'history', 'science', 'essays'], reason: 'nonfiction' } },
  { triggers: ['ya', 'young adult'],
    produces: { kind: 'subjects', keywords: ['young adult', 'ya'], reason: 'young adult' } },

  // ── mood / tone ─────────────────────────────────────────────────────────
  { triggers: ['light', 'lighthearted', 'light-hearted', 'cozy', 'cosy', 'feel good', 'feelgood'],
    produces: { kind: 'subjects', keywords: ['humor', 'humour', 'comedy', 'cozy', 'romance', 'feel-good'], reason: 'light / cozy' } },
  { triggers: ['dark'],
    produces: { kind: 'subjects', keywords: ['gothic', 'horror', 'noir', 'bleak', 'psychological', 'tragedy'], reason: 'dark' } },
  { triggers: ['funny', 'humor', 'humour', 'humorous', 'comedic', 'comedy'],
    produces: { kind: 'subjects', keywords: ['humor', 'humour', 'comedy', 'comic', 'satire'], reason: 'funny' } },
  { triggers: ['sad', 'tearjerker', 'heartbreaking'],
    produces: { kind: 'subjects', keywords: ['grief', 'tragedy', 'loss', 'melancholy'], reason: 'emotional / sad' } },
  { triggers: ['epic'],
    produces: { kind: 'subjects', keywords: ['epic', 'saga', 'high fantasy'], reason: 'epic' } },

  // ── pacing / length ─────────────────────────────────────────────────────
  { triggers: ['fast paced', 'fast-paced', 'fastpaced', 'page turner', 'page-turner', 'pageturner'],
    produces: { kind: 'subjects', keywords: ['thriller', 'action', 'suspense'], reason: 'fast-paced' } },
  { triggers: ['short'],
    produces: { kind: 'pageMax', pages: 250, reason: 'short (≤250 pages)' } },
  { triggers: ['long', 'chunky', 'doorstopper'],
    produces: { kind: 'pageMin', pages: 500, reason: 'long (≥500 pages)' } },
];

/** Tokenize the query and find every vocabulary entry it triggers. */
export function parseIntent(query: string): IntentSignal[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const signals: IntentSignal[] = [];
  const fired   = new Set<VocabEntry>();

  for (const entry of INTENT_VOCAB) {
    for (const trig of entry.triggers) {
      const escaped = trig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(q)) {
        if (!fired.has(entry)) {
          fired.add(entry);
          const produced = entry.produces;
          signals.push({ ...produced, reason: produced.reason ?? trig } as IntentSignal);
        }
        break;
      }
    }
  }

  // Free-text fallback: only if NO structured intent fired, so a query like
  // "fantasy" doesn't also do a noisy substring match for "fantasy" in titles.
  if (signals.length === 0) {
    signals.push({ kind: 'free', text: q, reason: `"${query.trim()}"` });
  }

  return signals;
}

export type IntentMatch = { matched: boolean; reasons: string[] };

/**
 * Returns whether this book satisfies *all* structured signals (AND).
 *   - subjects signals require a word-boundary subject hit
 *   - pageMax / pageMin require a known page_count
 *   - free signals do title/author/subjects substring
 *
 * `reasons` collects the human-readable chip text for each signal that
 * actually contributed to the match.
 */
export function matchBookToIntent(book: BookItem, signals: IntentSignal[]): IntentMatch {
  if (signals.length === 0) return { matched: true, reasons: [] };

  const reasons: string[] = [];
  for (const sig of signals) {
    if (sig.kind === 'subjects') {
      if (!matchesSubjects(book, sig.keywords)) return { matched: false, reasons: [] };
      reasons.push(sig.reason);
    } else if (sig.kind === 'pageMax') {
      const pc = book.book?.page_count;
      if (typeof pc !== 'number' || pc > sig.pages) return { matched: false, reasons: [] };
      reasons.push(sig.reason);
    } else if (sig.kind === 'pageMin') {
      const pc = book.book?.page_count;
      if (typeof pc !== 'number' || pc < sig.pages) return { matched: false, reasons: [] };
      reasons.push(sig.reason);
    } else if (sig.kind === 'free') {
      const t = (book.book?.title  ?? '').toLowerCase();
      const a = (book.book?.author ?? '').toLowerCase();
      const subjList = (() => {
        const raw = book.book?.subjects;
        if (!raw) return '';
        return Array.isArray(raw) ? raw.join(' ').toLowerCase() : String(raw).toLowerCase();
      })();
      if (!t.includes(sig.text) && !a.includes(sig.text) && !subjList.includes(sig.text)) {
        return { matched: false, reasons: [] };
      }
      reasons.push(sig.reason);
    }
  }
  return { matched: true, reasons };
}

/**
 * Diagnostic helper used by empty states — were any structured signals page-
 * count-dependent? If so and most saved books lack page_count, the UI can
 * surface "metadata is limited" rather than "no matches".
 */
export function signalsRequireMetadata(signals: IntentSignal[]): { needsPageCount: boolean; needsSubjects: boolean } {
  return {
    needsPageCount: signals.some(s => s.kind === 'pageMax' || s.kind === 'pageMin'),
    needsSubjects:  signals.some(s => s.kind === 'subjects'),
  };
}
