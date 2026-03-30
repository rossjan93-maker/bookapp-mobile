// ─── In-app walkthrough engine ────────────────────────────────────────────────
//
// Drives the guided tour inside the real app shell after signup.
//
// Step order: 'home' → 'recommend' → 'library' → 'done'
//
// This order follows the physical left-to-right tab layout (tabs 0 → 1 → 2):
//   home (tab 0) → recommend (tab 1) → library (tab 2) → done
//
// All three steps show a spotlight overlay + coach card + in-screen hotspot.
// After 'library' completes, _layout.tsx navigates to the Recommend tab and
// search.tsx shows RecEntryScreen (import / intake / explore) as a
// contextual setup prompt.
//
// Inbox: acknowledged in the Recommend step body copy — no dedicated step.
// Profile: excluded (empty for new users, self-explanatory).
//
// Target registration:
//   Screen components call registerWtTarget(key, rect) after layout.
//   spotlightRect in each def is the always-available fallback.
//
// Persistence: AsyncStorage key 'readstack_walkthrough_v1'.

import { createContext, useCallback, useContext, useRef } from 'react';
import { Dimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WtStep = 'home' | 'library' | 'recommend' | 'done';

export type TargetRect = {
  x:      number;
  y:      number;
  width:  number;
  height: number;
};

export type WtStepDef = {
  id:               WtStep;
  tab:              string | null;
  title:            string;
  body:             string;
  ctaLabel:         string;
  tabIdx:           number;
  cardPos:          'top' | 'bottom';
  spotlightRect:    TargetRect | null;
  inScreenHotspot:  { x: number; y: number } | null;
};

// ─── Spotlight rects + hotspot positions ──────────────────────────────────────
//
// Each rect targets a specific named product element, not just a proportional
// band of screen height.  Horizontal insets (SW * 0.04) ensure the spotlight
// looks focused rather than wall-to-wall.
//
// Hotspot coords correspond to where a cover thumbnail / card element would
// typically appear on each screen — left-center for list items, center for cards.

const SW      = Dimensions.get('window').width;
const SH      = Dimensions.get('window').height;
const H_INSET = Math.round(SW * 0.04);

// Home — targets the "currently reading" card area
// Positioned below the greeting header (~y=13%), covers one card height (~26%)
const HOME_RECT: TargetRect = {
  x:      H_INSET,
  y:      Math.round(SH * 0.13),
  width:  SW - H_INSET * 2,
  height: Math.round(SH * 0.26),
};
// Hotspot at the left-center of the card — where the book cover thumbnail lives
const HOME_HOTSPOT = {
  x: Math.round(SW * 0.17),
  y: Math.round(SH * 0.26),
};

// Recommend — targets the rec card feed area
// Positioned below the Recommend header (~y=13%), covers first 1–2 rec cards (~28%)
const RECOMMEND_RECT: TargetRect = {
  x:      H_INSET,
  y:      Math.round(SH * 0.13),
  width:  SW - H_INSET * 2,
  height: Math.round(SH * 0.28),
};
// Hotspot centered on the rec card area (where first card cover would be)
const RECOMMEND_HOTSPOT = {
  x: Math.round(SW * 0.5),
  y: Math.round(SH * 0.27),
};

// Library — targets the book list rows area
// Positioned below the filter chips (~y=18%), covers first visible rows (~30%)
const LIBRARY_RECT: TargetRect = {
  x:      H_INSET,
  y:      Math.round(SH * 0.18),
  width:  SW - H_INSET * 2,
  height: Math.round(SH * 0.30),
};
// Hotspot at the left-center of the first book row — where the cover thumbnail is
const LIBRARY_HOTSPOT = {
  x: Math.round(SW * 0.17),
  y: Math.round(SH * 0.30),
};

// ─── Step definitions ─────────────────────────────────────────────────────────

export const WT_DEFS: Record<'home' | 'library' | 'recommend', WtStepDef> = {

  home: {
    id:              'home',
    tab:             '/',
    title:           'Your reading life',
    body:            'Active reads, progress, and pace \u2014 all at a glance. This is where you check in on what you\u2019re reading right now.',
    ctaLabel:        'Next \u2192',
    tabIdx:          0,
    cardPos:         'bottom',
    spotlightRect:   HOME_RECT,
    inScreenHotspot: HOME_HOTSPOT,
  },

  recommend: {
    id:              'recommend',
    tab:             '/(tabs)/search',
    title:           'Your picks',
    body:            'Personalized recommendations that get sharper the more you read. Friends can also send you picks \u2014 those arrive in your Inbox.',
    ctaLabel:        'Next \u2192',
    tabIdx:          1,
    cardPos:         'bottom',
    spotlightRect:   RECOMMEND_RECT,
    inScreenHotspot: RECOMMEND_HOTSPOT,
  },

  library: {
    id:              'library',
    tab:             '/(tabs)/library',
    title:           'Your library',
    body:            'Every book you\u2019ve read, saved, or are working through. Logging here is what teaches the engine what you like.',
    ctaLabel:        'Done \u2192',
    tabIdx:          2,
    cardPos:         'bottom',
    spotlightRect:   LIBRARY_RECT,
    inScreenHotspot: LIBRARY_HOTSPOT,
  },

};

// Step order follows physical tab order (tab 0 → tab 1 → tab 2 → done).
// No zigzag.
export const WT_ORDER: WtStep[]         = ['home', 'recommend', 'library', 'done'];
export const WT_OVERLAY_STEPS: WtStep[] = ['home', 'recommend', 'library'];

export function nextWtStep(current: WtStep): WtStep {
  const i = WT_ORDER.indexOf(current);
  return WT_ORDER[Math.min(i + 1, WT_ORDER.length - 1)];
}

// ─── Target registry ──────────────────────────────────────────────────────────

const _targets = new Map<string, TargetRect>();

export function registerWtTarget(key: string, rect: TargetRect): void {
  if (rect.width > 0 && rect.height > 0) {
    _targets.set(key, rect);
  }
}

export function getWtTarget(key: string): TargetRect | undefined {
  return _targets.get(key);
}

export function clearWtTargets(): void {
  _targets.clear();
}

export function useWalkthroughTarget(key: string) {
  const viewRef = useRef<any>(null);
  const onLayout = useCallback(() => {
    viewRef.current?.measureInWindow((x: number, y: number, width: number, height: number) => {
      registerWtTarget(key, { x, y, width, height });
    });
  }, [key]);
  return { ref: viewRef, onLayout };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export const WT_STORAGE_KEY = 'readstack_walkthrough_v1';

export async function readWtStep(): Promise<WtStep | null> {
  try {
    const val = await AsyncStorage.getItem(WT_STORAGE_KEY);
    if (val === 'home' || val === 'library' || val === 'recommend' || val === 'done') {
      return val as WtStep;
    }
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
  wtStep:  WtStep | null;
  advance: () => void;
  skip:    () => void;
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

function _wt(event: string, extra: Record<string, unknown> = {}): void {
  console.log(`[WT] ${event}`, { ...extra, ts: new Date().toISOString() });
}

export function wtEvt_started():                                  void { _wt('walkthrough_started'); }
export function wtEvt_stepViewed(step: WtStep | string):          void { _wt('walkthrough_step_viewed',    { step }); }
export function wtEvt_stepCompleted(step: WtStep | string):       void { _wt('walkthrough_step_completed', { step }); }
export function wtEvt_skipped(at: WtStep | string):               void { _wt('walkthrough_skipped',        { at }); }
export function wtEvt_finished():                                  void { _wt('walkthrough_finished'); }
export function wtEvt_recStepReached():                           void { _wt('recommendations_step_reached'); }
export function wtEvt_importCtaShown():                           void { _wt('import_prompt_shown'); }
export function wtEvt_importCtaClicked():                         void { _wt('import_cta_clicked'); }
export function wtEvt_importStarted():                            void { _wt('import_started'); }
export function wtEvt_importCompleted():                          void { _wt('import_completed'); }
export function wtEvt_intakeStarted():                            void { _wt('quick_intake_started'); }
export function wtEvt_intakeCompleted():                          void { _wt('quick_intake_completed'); }
export function wtEvt_intakeSkipped():                            void { _wt('quick_intake_skipped'); }
export function wtEvt_exploreClicked():                           void { _wt('explore_anyway_clicked'); }
export function wtEvt_hotspotTapped(step: WtStep | string):       void { _wt('walkthrough_hotspot_tapped', { step }); }
