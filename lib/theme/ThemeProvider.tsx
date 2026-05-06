/**
 * lib/theme/ThemeProvider.tsx
 *
 * App-wide theme context. Mount at the very top of the navigation tree
 * (app/_layout.tsx) so every screen can call `useAppTheme()`.
 *
 * Persistence:
 *   AsyncStorage key = 'readstack:theme:v1'
 *   The provider renders with the default theme immediately and asynchronously
 *   hydrates the stored choice — boot is never blocked, and a corrupt /
 *   missing value safely falls back to the default.
 *
 * Hook contract:
 *   const { theme, themeId, setTheme, isHydrated } = useAppTheme();
 *
 *   - `theme`        — full Theme object (colors, typography, radius, shadow).
 *   - `themeId`      — current id ('north' | 'atelier' | 'kiosk').
 *   - `setTheme(id)` — switch theme; persisted in the background.
 *   - `isHydrated`   — true once AsyncStorage load resolved (informational
 *                      only — the provider already exposes a usable theme
 *                      before this flips).
 */
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_THEME_ID,
  getTheme,
  isThemeId,
  Theme,
  ThemeId,
} from './themes';

const STORAGE_KEY = 'readstack:theme:v1';

type ThemeContextValue = {
  theme:       Theme;
  themeId:     ThemeId;
  setTheme:    (id: ThemeId) => void;
  isHydrated:  boolean;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme:      getTheme(DEFAULT_THEME_ID),
  themeId:    DEFAULT_THEME_ID,
  setTheme:   () => {},
  isHydrated: false,
});

export function useAppTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Convenience hook — returns the colors object only. */
export function useThemeColors(): Theme['colors'] {
  return useContext(ThemeContext).theme.colors;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId,    setThemeId]    = useState<ThemeId>(DEFAULT_THEME_ID);
  const [isHydrated, setIsHydrated] = useState(false);

  // Load persisted theme — non-blocking. The provider already exposes the
  // default theme synchronously, so screens render with North immediately
  // and re-render once the stored choice arrives (typically <50 ms).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (cancelled) return;
        if (raw && isThemeId(raw)) {
          setThemeId(raw);
        } else if (raw) {
          // Stored value is unrecognized (e.g. a theme was removed in a later
          // version). Wipe it so the next read is clean.
          await AsyncStorage.removeItem(STORAGE_KEY);
        }
      } catch (err) {
        console.warn('[THEME] failed to load persisted theme — using default:', err);
      } finally {
        if (!cancelled) setIsHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setTheme = useCallback((id: ThemeId) => {
    if (!isThemeId(id)) {
      console.warn('[THEME] setTheme called with invalid id:', id);
      return;
    }
    setThemeId(id);
    // Persist in the background; failures are logged but never thrown.
    AsyncStorage.setItem(STORAGE_KEY, id).catch(err => {
      console.warn('[THEME] failed to persist theme:', err);
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme:      getTheme(themeId),
    themeId,
    setTheme,
    isHydrated,
  }), [themeId, setTheme, isHydrated]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}
