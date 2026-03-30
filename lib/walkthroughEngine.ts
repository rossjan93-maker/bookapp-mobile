// ─── In-app walkthrough engine ────────────────────────────────────────────────
//
// Drives the guided tour inside the real app shell after signup.
//
// Step order: 'home' → 'library' → 'recommend' → 'done'
//
// 'home' and 'library' show a spotlight overlay with a real content-area
// aperture + coach-mark card + pulsing tab ring.
// 'recommend' is handled entirely by RecEntryScreen (no overlay).
// 'done' = walkthrough finished.
//
// Target registration:
//   Screen components can call registerWtTarget(key, rect) after layout.
//   The overlay reads those rects to draw the spotlight aperture.
//   Each step also carries a fallback spotlightRect (computed from screen
//   dimensions) so the overlay always has something to show even if no
//   component has registered yet.
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
  id:             WtStep;
  tab:            string | null;
  title:          string;
  body:           string;
  ctaLabel:       string;
  tabIdx:         number;
  cardPos:        'top' | 'bottom';
  spotlightRect:  TargetRect | null;   // null = full-screen dim (no aperture)
};

// ─── Fixed-layout spotlight rects ─────────────────────────────────────────────
// These cover the main content area of each screen.
// The WalkthroughOverlay will use registered targets in preference to these
// once a screen component calls registerWtTarget().

const SW = Dimensions.get('window').width;
const SH = Dimensions.get('window').height;

// Home content area — below the header, covers ~40% of screen height
const HOME_RECT: TargetRect = {
  x:      0,
  y:      Math.round(SH * 0.10),
  width:  SW,
  height: Math.round(SH * 0.42),
};

// Library content area — same region
const LIBRARY_RECT: TargetRect = {
  x:      0,
  y:      Math.round(SH * 0.10),
  width:  SW,
  height: Math.round(SH * 0.44),
};

// ─── Step definitions ─────────────────────────────────────────────────────────

export const WT_DEFS: Record<'home' | 'library' | 'recommend', WtStepDef> = {
  home: {
    id:            'home',
    tab:           '/',
    title:         'Your reading home',
    body:          "Track what you\u2019re reading, see recent activity, and keep up with your progress \u2014 all in one place.",
    ctaLabel:      'Next \u2192',
    tabIdx:        0,
    cardPos:       'bottom',
    spotlightRect: HOME_RECT,
  },
  library: {
    id:            'library',
    tab:           '/(tabs)/library',
    title:         'Your library',
    body:          "Every book you\u2019ve read, saved, or are working through. Log progress, mark it finished, take notes.",
    ctaLabel:      'Next \u2192',
    tabIdx:        2,
    cardPos:       'bottom',
    spotlightRect: LIBRARY_RECT,
  },
  recommend: {
    id:            'recommend',
    tab:           '/(tabs)/search',
    title:         'Your picks',
    body:          '',
    ctaLabel:      '',
    tabIdx:        1,
    cardPos:       'bottom',
    spotlightRect: null,
  },
};

export const WT_OVERLAY_STEPS: WtStep[] = ['home', 'library'];
export const WT_ORDER: WtStep[]         = ['home', 'library', 'recommend', 'done'];

export function nextWtStep(current: WtStep): WtStep {
  const i = WT_ORDER.indexOf(current);
  return WT_ORDER[Math.min(i + 1, WT_ORDER.length - 1)];
}

// ─── Target registry ──────────────────────────────────────────────────────────
// Components register their bounding rects here so the overlay can draw
// precise spotlight apertures.  Module-level map — no React state needed.

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

// ─── useWalkthroughTarget hook ────────────────────────────────────────────────
// Use this in any screen component to register a live element's position.
// The overlay will prefer this over the fallback spotlightRect.
//
// Usage:
//   const { ref, onLayout } = useWalkthroughTarget('home_content');
//   <View ref={ref} onLayout={onLayout}> ... </View>

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
export function wtEvt_importCtaShown():                           void { _wt('import_cta_shown'); }
export function wtEvt_importCtaClicked():                         void { _wt('import_cta_clicked'); }
export function wtEvt_importStarted():                            void { _wt('import_started'); }
export function wtEvt_importCompleted():                          void { _wt('import_completed'); }
export function wtEvt_intakeStarted():                            void { _wt('quick_intake_started'); }
export function wtEvt_intakeCompleted():                          void { _wt('quick_intake_completed'); }
export function wtEvt_intakeSkipped():                            void { _wt('quick_intake_skipped'); }
export function wtEvt_exploreClicked():                           void { _wt('explore_anyway_clicked'); }
