// ─── In-app walkthrough engine ────────────────────────────────────────────────
//
// Drives the guided tour that runs inside the real app shell after signup.
// The user sees the live tabs; this overlay highlights each area in turn.
//
// Step order: 'home' → 'library' → 'recommend' → 'done'
//
// 'home' and 'library' show a spotlight overlay + coach-mark card.
// 'recommend' is handled entirely by RecEntryScreen (no overlay needed).
// 'done' = walkthrough finished.
//
// Persistence: AsyncStorage key 'readstack_walkthrough_v1'.
// Existing users whose key is absent get 'done' (no tour).

import { createContext, useContext } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WtStep = 'home' | 'library' | 'recommend' | 'done';

export type WtStepDef = {
  id:       WtStep;
  tab:      string | null;
  title:    string;
  body:     string;
  ctaLabel: string;
  tabIdx:   number;           // 0–4 tab-bar index (for pulsing ring)
  cardPos:  'top' | 'bottom';
};

// ─── Step definitions ─────────────────────────────────────────────────────────

export const WT_DEFS: Record<'home' | 'library' | 'recommend', WtStepDef> = {
  home: {
    id:       'home',
    tab:      '/',
    title:    'Your reading home',
    body:     "Track what you\u2019re reading, see recent activity, and keep up with your progress \u2014 all in one place.",
    ctaLabel: 'Next \u2192',
    tabIdx:   0,
    cardPos:  'bottom',
  },
  library: {
    id:       'library',
    tab:      '/(tabs)/library',
    title:    'Your library',
    body:     "Every book you\u2019ve read, saved, or are working through. Log progress, mark it finished, take notes.",
    ctaLabel: 'Next \u2192',
    tabIdx:   2,
    cardPos:  'bottom',
  },
  recommend: {
    id:       'recommend',
    tab:      '/(tabs)/search',
    title:    'Your picks',           // shown only if overlay were to render (it doesn\u2019t)
    body:     '',
    ctaLabel: '',
    tabIdx:   1,
    cardPos:  'bottom',
  },
};

// Steps that render the spotlight overlay
export const WT_OVERLAY_STEPS: WtStep[] = ['home', 'library'];

export const WT_ORDER: WtStep[] = ['home', 'library', 'recommend', 'done'];

export function nextWtStep(current: WtStep): WtStep {
  const i = WT_ORDER.indexOf(current);
  return WT_ORDER[Math.min(i + 1, WT_ORDER.length - 1)];
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export const WT_STORAGE_KEY = 'readstack_walkthrough_v1';

export async function readWtStep(): Promise<WtStep | null> {
  try {
    const val = await AsyncStorage.getItem(WT_STORAGE_KEY);
    if (val === 'home' || val === 'library' || val === 'recommend' || val === 'done') {
      return val as WtStep;
    }
    // Key absent = existing user who never saw the new walkthrough → skip it
    return null;
  } catch {
    return null;
  }
}

export async function writeWtStep(step: WtStep): Promise<void> {
  try {
    await AsyncStorage.setItem(WT_STORAGE_KEY, step);
  } catch {}
}

// ─── Context ──────────────────────────────────────────────────────────────────

export type WalkthroughCtx = {
  wtStep:  WtStep | null;   // null = still loading from AsyncStorage
  advance: () => void;      // move to the next step (+ navigate to its tab)
  skip:    () => void;      // jump directly to 'done'
};

export const WalkthroughContext = createContext<WalkthroughCtx>({
  wtStep:  null,
  advance: () => {},
  skip:    () => {},
});

export function useWalkthrough(): WalkthroughCtx {
  return useContext(WalkthroughContext);
}

// ─── Analytics ───────────────────────────────────────────────────────────────
// Wire to PostHog / Amplitude by replacing _wt() body.

function _wt(event: string, extra: Record<string, unknown> = {}): void {
  console.log(`[WT] ${event}`, { ...extra, ts: new Date().toISOString() });
}

export function wtEvt_started():                                  void { _wt('walkthrough_started'); }
export function wtEvt_stepViewed(step: WtStep):                   void { _wt('walkthrough_step_viewed',    { step }); }
export function wtEvt_stepCompleted(step: WtStep):                void { _wt('walkthrough_step_completed', { step }); }
export function wtEvt_skipped(at: WtStep):                        void { _wt('walkthrough_skipped',        { at }); }
export function wtEvt_finished():                                 void { _wt('walkthrough_finished'); }
export function wtEvt_recStepReached():                           void { _wt('walkthrough_rec_step_reached'); }
export function wtEvt_importCtaShown():                           void { _wt('walkthrough_import_cta_shown'); }
export function wtEvt_importCtaClicked():                         void { _wt('walkthrough_import_cta_clicked'); }
export function wtEvt_intakeStarted():                            void { _wt('walkthrough_quick_intake_started'); }
export function wtEvt_intakeSkipped():                            void { _wt('walkthrough_quick_intake_skipped'); }
export function wtEvt_exploreClicked():                           void { _wt('walkthrough_explore_anyway_clicked'); }
