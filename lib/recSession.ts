import type { ScoredBook, QualityGate, RankedRecsResult } from './recommender';
import type { ReaderThesis } from './expertRec';

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
  loadedAt:      number;
};

let _recSession: RecSessionCache | null = null;

export function getRecSession(): RecSessionCache | null {
  return _recSession;
}

export function setRecSession(s: RecSessionCache | null): void {
  _recSession = s;
}

export function clearRecSession(): void {
  _recSession = null;
}
