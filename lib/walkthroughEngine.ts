// ─── In-app walkthrough engine ────────────────────────────────────────────────
//
// Drives the guided tour inside the real app shell after signup.
//
// Step order: home(0) → recommend(1) → library(2) → inbox(3) → done
//
// Tabs are visited left-to-right in physical tab order.
// After 'inbox' completes, _layout.tsx navigates to /(tabs)/search and
// search.tsx shows RecEntryScreen as a contextual setup prompt.
//
// Profile: excluded (sparse for new users; preferences handled by RecEntryScreen).
//
// Readiness gating:
//   Screens call registerWtTarget(key, rect) once their primary content is
//   measured and loaded.  The overlay polls getWtTarget and only shows the
//   coach card + hotspot once the rect is available OR minDelay has elapsed.
//   Library is frozen (cannot be modified), so it relies on minDelay only.
//
// Persistence: AsyncStorage key 'readstack_walkthrough_v1'.

import { createContext, useCallback, useContext, useRef } from 'react';
import { Dimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WtStep = 'home' | 'recommend' | 'library' | 'inbox' | 'done';

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
  spotlightRect:    TargetRect | null;  // fallback when no registered rect
  inScreenHotspot:  { x: number; y: number } | null;  // fallback hotspot
  hotspotAnchor:    'center' | 'left-center';  // how to compute hotspot from measured rect
  minDelay:         number;  // ms to wait if no measured rect is registered yet
};

// ─── Spotlight fallback rects ─────────────────────────────────────────────────
//
// Used only when the screen has not yet called registerWtTarget.
// Library always uses these (frozen screen, cannot add measurement hooks).
// Other screens register real rects — these serve as the dim-only placeholder.

const SW      = Dimensions.get('window').width;
const SH      = Dimensions.get('window').height;
const H_INSET = Math.round(SW * 0.04);

// Home — targets the "Continue Reading" card area below the greeting header
const HOME_RECT: TargetRect = {
  x:      H_INSET,
  y:      Math.round(SH * 0.15),
  width:  SW - H_INSET * 2,
  height: Math.round(SH * 0.22),
};

// Recommend — targets the first rec card in the feed below the header
const RECOMMEND_RECT: TargetRect = {
  x:      H_INSET,
  y:      Math.round(SH * 0.16),
  width:  SW - H_INSET * 2,
  height: Math.round(SH * 0.28),
};

// Library — permanent fallback (screen is frozen, cannot add measurement)
// Targets the book list rows below the filter chip bar
const LIBRARY_RECT: TargetRect = {
  x:      H_INSET,
  y:      Math.round(SH * 0.15),
  width:  SW - H_INSET * 2,
  height: Math.round(SH * 0.28),
};

// Inbox — targets the empty-state card or first inbox item
const INBOX_RECT: TargetRect = {
  x:      H_INSET,
  y:      Math.round(SH * 0.22),
  width:  SW - H_INSET * 2,
  height: Math.round(SH * 0.35),
};

// ─── Fallback hotspot positions ───────────────────────────────────────────────
//
// Used only when no measured rect is available.
// Derived from hotspotAnchor + spotlightRect when a real rect exists.

const HOME_HOTSPOT      = { x: Math.round(SW * 0.17), y: Math.round(SH * 0.26) };
const RECOMMEND_HOTSPOT = { x: Math.round(SW * 0.50), y: Math.round(SH * 0.30) };
const LIBRARY_HOTSPOT   = { x: Math.round(SW * 0.17), y: Math.round(SH * 0.29) };
const INBOX_HOTSPOT     = { x: Math.round(SW * 0.50), y: Math.round(SH * 0.39) };

// ─── Step definitions ─────────────────────────────────────────────────────────

export const WT_DEFS: Record<'home' | 'recommend' | 'library' | 'inbox', WtStepDef> = {

  home: {
    id:              'home',
    tab:             '/',
    title:           'Your reading life',
    body:            'Your active books, pace, and timeline — all in one place. Add a book from Library and it shows up right here.',
    ctaLabel:        'Next \u2192',
    tabIdx:          0,
    cardPos:         'bottom',
    spotlightRect:   HOME_RECT,
    inScreenHotspot: HOME_HOTSPOT,
    hotspotAnchor:   'left-center',
    minDelay:        0,
  },

  recommend: {
    id:              'recommend',
    tab:             '/(tabs)/search',
    title:           'Recommendations',
    body:            'Personalized picks that sharpen with every book you log. Save, dismiss, or explore from any card here.',
    ctaLabel:        'Next \u2192',
    tabIdx:          1,
    cardPos:         'bottom',
    spotlightRect:   RECOMMEND_RECT,
    inScreenHotspot: RECOMMEND_HOTSPOT,
    hotspotAnchor:   'center',
    minDelay:        0,
  },

  library: {
    id:              'library',
    tab:             '/(tabs)/library',
    title:           'Your library',
    body:            'Every book you\u2019ve read, are reading, or want to read. Logging here is what trains the engine \u2014 the more you add, the sharper your picks.',
    ctaLabel:        'Next \u2192',
    tabIdx:          2,
    cardPos:         'bottom',
    spotlightRect:   LIBRARY_RECT,
    inScreenHotspot: LIBRARY_HOTSPOT,
    hotspotAnchor:   'left-center',
    minDelay:        700,
  },

  inbox: {
    id:              'inbox',
    tab:             '/(tabs)/notes',
    title:           'Inbox',
    body:            'When a friend recommends a book, it arrives here with a personal note. You can save it, start reading, or pass.',
    ctaLabel:        'Done \u2192',
    tabIdx:          3,
    cardPos:         'bottom',
    spotlightRect:   INBOX_RECT,
    inScreenHotspot: INBOX_HOTSPOT,
    hotspotAnchor:   'center',
    minDelay:        0,
  },

};

// Step order follows physical left-to-right tab layout.
export const WT_ORDER: WtStep[]         = ['home', 'recommend', 'library', 'inbox', 'done'];
export const WT_OVERLAY_STEPS: WtStep[] = ['home', 'recommend', 'library', 'inbox'];

export function nextWtStep(current: WtStep): WtStep {
  const i = WT_ORDER.indexOf(current);
  return WT_ORDER[Math.min(i + 1, WT_ORDER.length - 1)];
}

// ─── Hotspot position resolver ────────────────────────────────────────────────
//
// Given a step's measured (or fallback) rect and its hotspotAnchor, returns
// the absolute screen position for the InScreenHotspot dot.

export function resolveHotspot(
  def:  WtStepDef,
  rect: TargetRect | null,
): { x: number; y: number } {
  if (!rect) return def.inScreenHotspot ?? { x: SW / 2, y: SH / 2 };
  const cy = rect.y + Math.round(rect.height / 2);
  if (def.hotspotAnchor === 'left-center') {
    // Positions on the cover thumbnail at left edge of the card
    return { x: rect.x + Math.round(rect.height * 0.33), y: cy };
  }
  // center
  return { x: rect.x + Math.round(rect.width / 2), y: cy };
}

// ─── Target registry ──────────────────────────────────────────────────────────
//
// Screens call registerWtTarget('<step>_content', rect) when their primary
// content is measured and ready.  The overlay polls getWtTarget to decide
// when to show the coach card.

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

// ─── Persistence ──────────────────────────────────────────────────────────────

export const WT_STORAGE_KEY = 'readstack_walkthrough_v1';

export async function readWtStep(): Promise<WtStep | null> {
  try {
    const val = await AsyncStorage.getItem(WT_STORAGE_KEY);
    if (
      val === 'home'      ||
      val === 'recommend' ||
      val === 'library'   ||
      val === 'inbox'     ||
      val === 'done'
    ) {
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
export function wtEvt_finished():                                 void { _wt('walkthrough_finished'); }
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
