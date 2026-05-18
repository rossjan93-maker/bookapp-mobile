// =============================================================================
// lib/intent/finalGate.ts — Intent Lens Eligibility Stabilization
//
// Pure final visible-deck safety gate. Single architectural chokepoint that
// enforces the locked product invariant:
//
//   If `evaluateBookAgainstIntentLens` returns a hardExclusion for a book
//   under the active Your-Next-Read lens, that book MUST NOT render —
//   regardless of which upstream producer path delivered it (deterministic
//   ranked pool, expert fresh build, Supabase rec_cache hit, AsyncStorage
//   restore, recSession seed, recQueue background append, or the continuation
//   bucket).
//
// Resolution A (chosen): the gate applies to continuations too. A truly-dark
// next-in-series IS hard-excluded under No-dark; user clears the lens to see
// it. This matches the unconditional user-facing promise.
//
// Design rules (do not relax without architectural sign-off):
//   • PURE — no I/O, no module state, no console.* emission. The caller emits
//     the DEV diagnostic; the gate just returns it. Keeps unit-testing trivial
//     and avoids accidental forensic-log fan-out from queue writes.
//   • Inactive intent → return shallow copy of input, `removed=[]`,
//     `diagnostics=null`. Callers can cheaply skip log emission on null.
//   • Active intent → forward-filter (single pass), preserving relative order
//     of survivors verbatim. No sort. No reshuffle.
//   • Never mutate input. `recs` is typed `readonly`. The kept array is a
//     fresh `Array<T>`.
//   • Composes with the policy layer; does NOT re-implement signal matching.
//     Hard-exclusion truth = `verdict.hardExclusions.length > 0` from
//     `evaluateBookAgainstIntentLens`.
//   • Does NOT call `passesIntentHardFilters` — page-count / lane / format
//     hard rules are enforced upstream (and they are not the "specific
//     evidence" eligibility class this gate guarantees).
//
// This module imports nothing about RecCard, the composer, persistence, or
// React state. Any future change here must preserve that isolation.
// =============================================================================

import {
  evaluateBookAgainstIntentLens,
  isIntentActive,
  type NextReadIntent,
  type IntentEligibilityEvidence,
} from '../nextReadIntent';
import {
  classifyMarketPosition,
  type MarketPosition,
} from '../fitClassifier';

// ── Source tags (typed; queue boundary stamps every call) ────────────────────
// Mirrors the existing producer-path tags emitted by INTENT_PRE_RENDER at
// components/RecommendationsFeed.tsx:665 so forensic logs cross-reference
// cleanly. Adding a new producer path requires extending this union.
export type FinalGateSource =
  | 'initQueue_cold_restore'   // bootstrap re-seed from getRecSession()
  | 'initQueue_fresh'          // first pipeline build (empty queue)
  | 'append_into_existing'     // foreground pipeline merge into non-empty queue
  | 'append_background'        // watermark replenish (isBgRefresh=true)
  | 'append_exhaustion';       // exhaustion-bypass reload

// ── Per-removal record (DEV-only diagnostics; never persisted) ───────────────
export type FinalGateRemoval = {
  bookId:         string;
  title:          string;
  hardReason:     string;                       // verdict.hardExclusions[0].reason
  evidenceKind:   string;                       // first evidence.kind
  evidenceDetail: string;                       // first evidence.detail
  marketPosition: MarketPosition | null;
};

// ── Per-call diagnostics (null when intent inactive — caller skips log) ──────
export type FinalGateDiagnostics = {
  source:         FinalGateSource;
  intentTag:      string | null;                // computeIntentTag-equivalent; null when no human label
  inputCount:     number;
  keptCount:      number;
  removedCount:   number;
  removed:        FinalGateRemoval[];
  topKeptTitles:  string[];                     // first 4 (visible window depth)
};

// Minimal book shape the gate needs. Compatible with ScoredBook and any other
// queue-entry book payload that carries subjects + title (+ optional desc /
// form / publish year for market-position classification).
export type GateBook = {
  id?:                 string | null;
  external_id?:        string | null;
  title?:              string | null;
  author?:             string | null;
  subjects?:           string[] | null;
  description?:        string | null;
  book_form?:          string | null;
  first_publish_year?: number | null;
};

// Caller-supplied projector: how to extract the gate-relevant book from the
// queue-entry shape (e.g. `(entry) => entry.book` for QueueEntry, or identity
// for raw ScoredBook arrays). Keeps the gate decoupled from recQueue's
// QueueEntry / ScoredBook types.
export type BookProjector<T> = (item: T) => GateBook;

// Optional caller-supplied market-position resolver. Defaults to
// `classifyMarketPosition` on the projected book. Injectable so validators
// can pin the market position deterministically by fixture id.
export type MarketPosResolver<T> = (item: T, projected: GateBook) => MarketPosition;

const DEFAULT_MARKET_POS: MarketPosResolver<unknown> = (_item, projected) =>
  classifyMarketPosition({
    subjects:           projected.subjects ?? null,
    title:              projected.title ?? null,
    author:             projected.author ?? null,
    book_form:          (projected.book_form as any) ?? null,
    first_publish_year: projected.first_publish_year ?? null,
  });

// Sentinel-shaped lift of a stable identifier for diagnostics.
function bookIdOf(b: GateBook): string {
  return (b.external_id ?? b.id ?? '').toString();
}

function buildRemoval(
  b: GateBook,
  hardReason: string,
  ev: IntentEligibilityEvidence | undefined,
  marketPos: MarketPosition,
): FinalGateRemoval {
  return {
    bookId:         bookIdOf(b),
    title:          (b.title ?? '').toString(),
    hardReason,
    evidenceKind:   ev?.kind ?? 'unknown',
    evidenceDetail: ev?.detail ?? 'no evidence detail',
    marketPosition: marketPos,
  };
}

// ── Public: applyFinalIntentEligibility ──────────────────────────────────────
//
// Returns:
//   { kept, removed, diagnostics }
//
// Contract (locked, enforced by scripts/validate_intent_final_gate.ts):
//   • intent null OR !isIntentActive(intent) →
//       kept       = [...recs]   (shallow copy; input identity NOT returned)
//       removed    = []
//       diagnostics= null
//   • Otherwise, for each rec in input order:
//       verdict = evaluateBookAgainstIntentLens(book, intent, marketPos)
//       if verdict.hardExclusions.length > 0 → remove
//       else                                  → keep
//   • Relative order of kept items preserved verbatim.
//   • Input array is never mutated.
//   • Diagnostics emitted for every active-intent call; the caller chooses
//     whether to log it (DEV-only).
export function applyFinalIntentEligibility<T>(args: {
  recs:          readonly T[];
  intent:        NextReadIntent | null;
  source:        FinalGateSource;
  intentTag?:    string | null;
  projectBook:   BookProjector<T>;
  marketPosOf?:  MarketPosResolver<T>;
}): { kept: T[]; removed: T[]; diagnostics: FinalGateDiagnostics | null } {
  const { recs, intent, source, intentTag = null, projectBook } = args;
  const marketPosOf = args.marketPosOf ?? (DEFAULT_MARKET_POS as MarketPosResolver<T>);

  // Inactive intent: identity-preserving shallow copy, no diagnostics.
  if (intent == null || !isIntentActive(intent)) {
    return { kept: [...recs], removed: [], diagnostics: null };
  }

  const kept:    T[]                 = [];
  const removed: T[]                 = [];
  const removedRecords: FinalGateRemoval[] = [];

  for (const item of recs) {
    const projected = projectBook(item);
    const marketPos = marketPosOf(item, projected);
    const verdict   = evaluateBookAgainstIntentLens(
      {
        subjects:    projected.subjects ?? null,
        title:       projected.title ?? null,
        description: projected.description ?? null,
      },
      intent,
      marketPos,
    );
    if (verdict.hardExclusions.length > 0) {
      removed.push(item);
      const hard = verdict.hardExclusions[0]!;
      removedRecords.push(buildRemoval(projected, hard.reason, hard.evidence[0], marketPos));
    } else {
      kept.push(item);
    }
  }

  // Top kept titles — first 4 (matches VISIBLE_STACK_SIZE).
  const topKeptTitles: string[] = [];
  for (let i = 0; i < Math.min(4, kept.length); i++) {
    const b = projectBook(kept[i]!);
    topKeptTitles.push((b.title ?? '').toString());
  }

  const diagnostics: FinalGateDiagnostics = {
    source,
    intentTag,
    inputCount:   recs.length,
    keptCount:    kept.length,
    removedCount: removed.length,
    removed:      removedRecords,
    topKeptTitles,
  };

  return { kept, removed, diagnostics };
}

// ── DEV-only diagnostic formatter (caller emits via console.log) ─────────────
// Stable single-line representation so production grep workflows do not
// regress when fields are added. Always safe to call (no I/O).
export function formatFinalGateLog(d: FinalGateDiagnostics): string {
  const removedSummary = d.removed
    .map(r => `${r.title} (${r.hardReason}/${r.evidenceKind}: ${r.evidenceDetail})`)
    .join('; ');
  return [
    '[FINAL_GATE]',
    `source=${d.source}`,
    `intentTag=${d.intentTag ?? 'null'}`,
    `kept=${d.keptCount}/${d.inputCount}`,
    `removed=${d.removedCount}`,
    `removedDetails=[${removedSummary}]`,
    `topKept=[${d.topKeptTitles.join(', ')}]`,
  ].join(' | ');
}
