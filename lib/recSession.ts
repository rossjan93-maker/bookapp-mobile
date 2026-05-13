import type { ScoredBook, QualityGate, RankedRecsResult } from './recommender';
import type { ReaderThesis } from './expertRec';
import { assertCurrent } from './recValidity';

// ── Shared rec session cache ───────────────────────────────────────────────────
//
// Moved out of search.tsx so _layout.tsx can pre-populate it from AsyncStorage
// before the Recommend tab is ever mounted.  This eliminates the ~200ms blank
// window on cold start (app restart) by making the session cache hot before the
// user navigates to Recommend.
//
// The cache is user-keyed: setRecSession() stores the userId, and getRecSession()
// is always compared against the authenticated user ID before use.  clearRecSession()
// is called on sign-out via registerCacheClearer in search.tsx.
//
// P0B: each session entry carries a `configHash` (from lib/recValidity.ts).
// `getRecSessionFor(currentHash)` is the strict accessor — on mismatch it
// clears and returns null, forcing a rebuild via the existing pipeline path.
// `getRecSession()` remains as the legacy raw accessor for read-only consumers
// (HomeShortlist, book detail status-change clears) that don't need the gate.

export type RecSessionCache = {
  userId:        string;
  recs:          ScoredBook[];
  continuations: ScoredBook[];
  discoveries:   ScoredBook[];
  meta:          RankedRecsResult['meta'];
  recMode:       'deterministic' | 'expert';
  readerThesis:  ReaderThesis | null;
  qualityGate:   QualityGate | null;
  isFreePreview: boolean;
  signalCount:   number;
  /** P0B recommendation-config identity. Optional because the cold-start
   *  prewarm restore path in (tabs)/_layout.tsx (out of scope for this batch)
   *  populates the session without a hash. `getRecSessionFor` treats missing
   *  as a mismatch, so a hashless session is invalidated on first strict read. */
  configHash?:   string;
  loadedAt:      number;
};

let _recSession: RecSessionCache | null = null;

export function getRecSession(): RecSessionCache | null {
  return _recSession;
}

/**
 * P0B strict accessor. Returns the cached session ONLY if its `configHash`
 * matches the supplied current hash. On mismatch (including missing stored
 * hash), the session is cleared in-place and null is returned so the caller
 * falls into the existing rebuild branch.
 */
export function getRecSessionFor(currentHash: string): RecSessionCache | null {
  if (!_recSession) return null;
  const check = assertCurrent(_recSession.configHash, currentHash);
  if (!check.valid) {
    if (__DEV__) console.log('[REC_SESSION] config_mismatch — invalidating',
      `| reason=${check.reason}`,
      `| stored=${_recSession.configHash ?? 'absent'}`,
      `| current=${currentHash}`,
    );
    _recSession = null;
    return null;
  }
  return _recSession;
}

export function setRecSession(s: RecSessionCache | null): void {
  _recSession = s;
}

export function clearRecSession(): void {
  _recSession = null;
}
