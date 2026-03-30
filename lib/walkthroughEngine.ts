// ─── In-app walkthrough engine ────────────────────────────────────────────────
//
// Drives the guided tour inside the real app shell after signup.
//
// Step order: 'home' → 'library' → 'recommend' → 'done'
//
// 'home' and 'library' show a spotlight overlay with a focused content-area
// aperture + in-screen hotspot indicator + coach-mark card + pulsing tab ring.
// 'recommend' is handled entirely by RecEntryScreen (no overlay).
// 'done' = walkthrough finished.
//
// Spotlight rects:
//   Each step carries a spotlightRect — an inset rectangle that targets the
//   main content element of that screen (NOT full-width — has horizontal
//   margins so it feels like a focused beam, not a screen filter).
//
// In-screen hotspot:
//   Each step carries an inScreenHotspot { x, y } — the coordinate within
//   the spotlight where a pulsing indicator appears.  It acts as both a
//   visual "look here" signal and a tap target that advances the tour.
//
// Target registration:
//   Screen components can call registerWtTarget(key, rect) after layout.
//   The overlay reads those rects to draw the spotlight aperture.
//   spotlightRect is the fallback when no live registration exists.
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
// Spotlight rects use horizontal insets (SW * 0.04 margin each side) so the
// illuminated area feels like a focused beam on specific content, not a
// wall-to-wall band.
//
// inScreenHotspot is the pulsing dot position within the spotlight area.
// It sits at the vertical midpoint of the spotlight, horizontally centered,
// representing the main element the user should look at.

const SW = Dimensions.get('window').width;
const SH = Dimensions.get('window').height;

const H_INSET = Math.round(SW * 0.04);   // horizontal margin either side
const V_TOP   = Math.round(SH * 0.12);   // top edge of spotlight (below header)

// Home — spotlight on the main feed / currently reading card area
const HOME_SPOT_W = SW - H_INSET * 2;
const HOME_SPOT_H = Math.round(SH * 0.30);
const HOME_RECT: TargetRect = {
  x:      H_INSET,
  y:      V_TOP,
  width:  HOME_SPOT_W,
  height: HOME_SPOT_H,
};
const HOME_HOTSPOT = {
  x: Math.round(SW / 2),
  y: Math.round(V_TOP + HOME_SPOT_H * 0.45),
};

// Library — spotlight on the book list area
const LIB_SPOT_W = SW - H_INSET * 2;
const LIB_SPOT_H = Math.round(SH * 0.32);
const LIBRARY_RECT: TargetRect = {
  x:      H_INSET,
  y:      V_TOP,
  width:  LIB_SPOT_W,
  height: LIB_SPOT_H,
};
const LIBRARY_HOTSPOT = {
  x: Math.round(SW / 2),
  y: Math.round(V_TOP + LIB_SPOT_H * 0.42),
};

// ─── Step definitions ─────────────────────────────────────────────────────────

export const WT_DEFS: Record<'home' | 'library' | 'recommend', WtStepDef> = {
  home: {
    id:              'home',
    tab:             '/',
    title:           'Your reading home',
    body:            "See what you\u2019re reading right now, your recent activity, and your progress all in one place.",
    ctaLabel:        'Next \u2192',
    tabIdx:          0,
    cardPos:         'bottom',
    spotlightRect:   HOME_RECT,
    inScreenHotspot: HOME_HOTSPOT,
  },
  library: {
    id:              'library',
    tab:             '/(tabs)/library',
    title:           'Your library',
    body:            "Every book you\u2019ve read, saved, or are working through. Log progress, mark it finished, add notes.",
    ctaLabel:        'Next \u2192',
    tabIdx:          2,
    cardPos:         'bottom',
    spotlightRect:   LIBRARY_RECT,
    inScreenHotspot: LIBRARY_HOTSPOT,
  },
  recommend: {
    id:              'recommend',
    tab:             '/(tabs)/search',
    title:           'Your picks',
    body:            '',
    ctaLabel:        '',
    tabIdx:          1,
    cardPos:         'bottom',
    spotlightRect:   null,
    inScreenHotspot: null,
  },
};

export const WT_OVERLAY_STEPS: WtStep[] = ['home', 'library'];
export const WT_ORDER: WtStep[]         = ['home', 'library', 'recommend', 'done'];

export function nextWtStep(current: WtStep): WtStep {
  const i = WT_ORDER.indexOf(current);
  return WT_ORDER[Math.min(i + 1, WT_ORDER.length - 1)];
}

// ─── Target registry ──────────────────────────────────────────────────────────
// Screen components register their bounding rects here so the overlay can
// draw precise spotlight apertures that track real layout.

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
// Attach to any View to register its live position with the overlay.
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
export function wtEvt_importCtaShown():                           void { _wt('import_prompt_shown'); }
export function wtEvt_importCtaClicked():                         void { _wt('import_cta_clicked'); }
export function wtEvt_importStarted():                            void { _wt('import_started'); }
export function wtEvt_importCompleted():                          void { _wt('import_completed'); }
export function wtEvt_intakeStarted():                            void { _wt('quick_intake_started'); }
export function wtEvt_intakeCompleted():                          void { _wt('quick_intake_completed'); }
export function wtEvt_intakeSkipped():                            void { _wt('quick_intake_skipped'); }
export function wtEvt_exploreClicked():                           void { _wt('explore_anyway_clicked'); }
export function wtEvt_hotspotTapped(step: WtStep | string):       void { _wt('walkthrough_hotspot_tapped', { step }); }
