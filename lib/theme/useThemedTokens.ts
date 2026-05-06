/**
 * lib/theme/useThemedTokens.ts
 *
 * Bridge hook that re-shapes the active theme into the legacy `lib/tokens.ts`
 * key names (BG, INK, SAGE, …). The point is to enable a fast, low-risk
 * migration of existing screens — most of which use inline color literals —
 * by swapping the literal hex string for a `T.BG`-style reference and
 * adding a single `const T = useThemedTokens()` at the top of the component.
 *
 * Mapping rules (semantic intent preserved):
 *   BG          → appBackground
 *   CARD        → cardBackground
 *   SURFACE     → surface
 *   INK         → textPrimary       (cream on dark themes, near-black on light)
 *   STONE       → textSecondary
 *   DUST        → textMuted
 *   FAINT       → textMuted
 *   BORDER      → border
 *   DIVIDER     → divider
 *   SAGE        → accent            ← legacy "sage green" becomes the active
 *   SAGE_DEEP   → accent              accent (cognac in Atelier, brick in
 *   SAGE_BG     → accentSoft          Kiosk). This is the entire point — the
 *   SAGE_INK    → accent              app's "primary brand colour" follows
 *   AMBER       → accentAlt           the user's theme choice.
 *   ACCENT_TXT  → accentText
 *   PILL        → pillBackground
 *   INPUT_BG    → inputBackground
 *   PROGRESS_*  → progressFill / progressTrack
 *   TAB_*       → tabActive / tabInactive / tabBar
 *
 * Returns a memoized object so re-renders only happen when the theme changes.
 */
import { useMemo } from 'react';
import { useThemeColors } from './ThemeProvider';

export type ThemedTokens = {
  BG:             string;
  CARD:           string;
  SURFACE:        string;
  SURFACE_HI:     string;
  INK:            string;
  STONE:          string;
  DUST:           string;
  FAINT:          string;
  BORDER:         string;
  DIVIDER:        string;
  SAGE:           string;
  SAGE_DEEP:      string;
  SAGE_BG:        string;
  SAGE_INK:       string;
  AMBER:          string;
  ACCENT_TXT:     string;
  PILL:           string;
  INPUT_BG:       string;
  PROGRESS_FILL:  string;
  PROGRESS_TRACK: string;
  TAB_ACTIVE:     string;
  TAB_INACTIVE:   string;
  TAB_BAR:        string;
  SUCCESS:        string;
  WARNING:        string;
  DANGER:         string;
};

export function useThemedTokens(): ThemedTokens {
  const c = useThemeColors();
  return useMemo<ThemedTokens>(() => ({
    BG:             c.appBackground,
    CARD:           c.cardBackground,
    SURFACE:        c.surface,
    SURFACE_HI:     c.surfaceElevated,
    INK:            c.textPrimary,
    STONE:          c.textSecondary,
    DUST:           c.textMuted,
    FAINT:          c.textMuted,
    BORDER:         c.border,
    DIVIDER:        c.divider,
    SAGE:           c.accent,
    SAGE_DEEP:      c.accent,
    SAGE_BG:        c.accentSoft,
    SAGE_INK:       c.accent,
    AMBER:          c.accentAlt,
    ACCENT_TXT:     c.accentText,
    PILL:           c.pillBackground,
    INPUT_BG:       c.inputBackground,
    PROGRESS_FILL:  c.progressFill,
    PROGRESS_TRACK: c.progressTrack,
    TAB_ACTIVE:     c.tabActive,
    TAB_INACTIVE:   c.tabInactive,
    TAB_BAR:        c.tabBar,
    SUCCESS:        c.success,
    WARNING:        c.warning,
    DANGER:         c.danger,
  }), [c]);
}
