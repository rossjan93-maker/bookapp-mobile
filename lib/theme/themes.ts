// =============================================================================
// lib/theme/themes.ts
//
// Theme registry — single source of truth for Readstack's selectable visual
// themes. Each theme is a flat semantic-token bag so consumers never need to
// know which raw color a value resolves to.
//
// HOW TO ADD A NEW THEME
//   1. Add a new entry to THEMES below with id + all required semantic tokens.
//   2. (Optional) Add it to the visible picker in components/ThemePickerCard.tsx.
//   3. That's it — no other file changes required.
//
// SOURCE OF VALUES
//   `north`   — attached_assets/tokens.north_*.json
//   `atelier` — attached_assets/tokens.atelier_*.json
//   `kiosk`   — synthesized from the brief (no token JSON shipped); warm
//               cream paper, near-black ink, brick/orange accent, ochre soft.
//
// SEMANTIC vs RAW
//   We deliberately expose semantic roles (`accent`, `surface`, `textPrimary`)
//   rather than the raw palette names from the JSON files (`ember`, `cognac`,
//   `paperDeep`). Screens read meaning, not pigment.
// =============================================================================

export type ThemeId = 'north' | 'atelier' | 'kiosk';

export type ThemeColors = {
  /** App-wide page background. */
  appBackground:    string;
  /** Generic surface (cards on the page background). */
  surface:          string;
  /** Surface that needs to read as elevated above `surface`. */
  surfaceElevated:  string;
  /** Card background — usually the same as `surface` but separable. */
  cardBackground:   string;
  /** Primary text. Must pass AA on `appBackground` + `surface`. */
  textPrimary:      string;
  /** Secondary text — labels, secondary copy. */
  textSecondary:    string;
  /** Muted / placeholder text. */
  textMuted:        string;
  /** Hairline borders on cards / dividers between rows. */
  border:           string;
  /** Inner dividers (lighter than `border`). */
  divider:          string;
  /** Primary accent — for one-per-view emphasis (CTAs, key numerals). */
  accent:           string;
  /** Tinted accent surface — pills, chips, highlight strips. */
  accentSoft:       string;
  /** Text color that pairs with `accent` as a fill (e.g. on a button). */
  accentText:       string;
  /** Secondary accent — sparingly used. */
  accentAlt:        string;
  /** Success / positive state. */
  success:          string;
  /** Warning / caution state. */
  warning:          string;
  /** Destructive / error state. */
  danger:           string;
  /** Filled portion of progress bars. */
  progressFill:     string;
  /** Track / unfilled portion of progress bars. */
  progressTrack:    string;
  /** Active tab tint. */
  tabActive:        string;
  /** Inactive tab tint. */
  tabInactive:      string;
  /** Tab bar background. */
  tabBar:           string;
  /** Pill / chip default background. */
  pillBackground:   string;
  /** Input field background. */
  inputBackground:  string;
};

export type ThemeTypography = {
  /** Display / editorial titles. Falls back to platform serif if unavailable. */
  displayFamily:  string | undefined;
  /** Body, labels, buttons, inputs. */
  bodyFamily:     string | undefined;
  /** Optional mono font for meta labels. */
  monoFamily:     string | undefined;
  /** Italic accent family — pull-quotes, single-word emphasis. */
  italicFamily:   string | undefined;
  /** Default heading weight. */
  headingWeight:  '300' | '400' | '500' | '600' | '700' | '800';
  /** Default body weight. */
  bodyWeight:     '300' | '400' | '500' | '600';
};

export type ThemeRadius = {
  card:  number;
  pill:  number;
  input: number;
  sm:    number;
  md:    number;
  lg:    number;
  xl:    number;
};

export type ThemeShadow = {
  /** React Native style object — already split into iOS shadow + Android elevation. */
  card:     {
    shadowColor:   string;
    shadowOffset:  { width: number; height: number };
    shadowOpacity: number;
    shadowRadius:  number;
    elevation:     number;
  };
  floating: {
    shadowColor:   string;
    shadowOffset:  { width: number; height: number };
    shadowOpacity: number;
    shadowRadius:  number;
    elevation:     number;
  };
};

export type Theme = {
  id:               ThemeId;
  name:             string;
  shortDescription: string;
  mood:             string;
  /** Whether the theme is dark — drives StatusBar style + a few contrast nudges. */
  isDark:           boolean;
  /** "light" or "dark" — pass directly to expo-status-bar. */
  statusBarStyle:   'light' | 'dark';
  colors:           ThemeColors;
  typography:       ThemeTypography;
  radius:           ThemeRadius;
  shadow:           ThemeShadow;
};

// ─── Shared scalar tokens (radius / spacing) ─────────────────────────────────
// All three themes use the same radius scale per the JSON files.
const RADIUS: ThemeRadius = {
  card:  14,
  pill:  999,
  input: 12,
  sm:    8,
  md:    12,
  lg:    14,
  xl:    18,
};

// React Native cannot consume CSS shadow strings — the JSON values are
// translated into iOS shadow*/Android elevation pairs here.
function makeShadow(opacity: number, elevation: number): ThemeShadow {
  return {
    card: {
      shadowColor:   '#000',
      shadowOffset:  { width: 0, height: 6 },
      shadowOpacity: opacity * 0.5,
      shadowRadius:  14,
      elevation,
    },
    floating: {
      shadowColor:   '#000',
      shadowOffset:  { width: 0, height: 16 },
      shadowOpacity: opacity,
      shadowRadius:  28,
      elevation:     elevation + 6,
    },
  };
}

// ─── NORTH — editorial restraint, warm paper ─────────────────────────────────
// Default theme. Closest to the existing Readstack look so existing screens
// that still read raw `lib/tokens.ts` constants stay coherent.
const NORTH: Theme = {
  id:               'north',
  name:             'North',
  shortDescription: 'Editorial restraint, warm paper',
  mood:             'Warm neutral, quiet, bookish',
  isDark:           false,
  statusBarStyle:   'dark',
  colors: {
    appBackground:    '#F4EFE6',
    surface:          '#FBF7EE',
    surfaceElevated:  '#FFFFFF',
    cardBackground:   '#FBF7EE',
    textPrimary:      '#15110C',
    textSecondary:    '#5C544A',
    textMuted:        '#9E958D',
    border:           'rgba(21,17,12,0.13)',
    divider:          'rgba(21,17,12,0.07)',
    accent:           '#A64426',
    accentSoft:       '#F2DAD0',
    accentText:       '#FBF7EE',
    accentAlt:        '#5D6B4A',
    success:          '#5D6B4A',
    warning:          '#C18B2C',
    danger:           '#B91C1C',
    progressFill:     '#A64426',
    progressTrack:    'rgba(21,17,12,0.10)',
    tabActive:        '#15110C',
    tabInactive:      '#9E958D',
    tabBar:           '#FBF7EE',
    pillBackground:   '#EDE6D6',
    inputBackground:  '#FBF7EE',
  },
  typography: {
    displayFamily: undefined,   // Fraunces — not bundled; falls back to platform serif
    bodyFamily:    undefined,   // Geist — not bundled; system sans
    monoFamily:    undefined,
    italicFamily:  undefined,
    headingWeight: '700',
    bodyWeight:    '400',
  },
  radius: RADIUS,
  shadow: makeShadow(0.22, 4),
};

// ─── ATELIER — quiet luxury, dark cognac ─────────────────────────────────────
const ATELIER: Theme = {
  id:               'atelier',
  name:             'Atelier',
  shortDescription: 'Quiet luxury, dark cognac',
  mood:             'Intimate reading room, premium dark mode',
  isDark:           true,
  statusBarStyle:   'light',
  colors: {
    appBackground:    '#0E0D0B',
    surface:          '#161412',
    surfaceElevated:  '#1F1C18',
    cardBackground:   '#161412',
    textPrimary:      '#ECE5D6',
    textSecondary:    '#B8AE9A',
    textMuted:        '#7A715F',
    border:           'rgba(255,255,255,0.08)',
    divider:          'rgba(255,255,255,0.05)',
    accent:           '#D4A574',
    accentSoft:       'rgba(212,165,116,0.16)',
    accentText:       '#0E0D0B',
    accentAlt:        '#C46A3A',
    success:          '#9CB084',
    warning:          '#D4A574',
    danger:           '#E07A6A',
    progressFill:     '#D4A574',
    progressTrack:    'rgba(255,255,255,0.10)',
    tabActive:        '#ECE5D6',
    tabInactive:      '#7A715F',
    tabBar:           '#0E0D0B',
    pillBackground:   '#1F1C18',
    inputBackground:  '#1F1C18',
  },
  typography: {
    displayFamily: undefined,   // Cormorant Garamond — italic display deferred
    bodyFamily:    undefined,   // Manrope — not bundled
    monoFamily:    undefined,
    italicFamily:  undefined,
    headingWeight: '500',       // Lighter weight for editorial feel
    bodyWeight:    '400',
  },
  radius: RADIUS,
  shadow: makeShadow(0.6, 6),
};

// ─── KIOSK — newsstand confidence, brick + ochre ─────────────────────────────
// Synthesized from the brief (no JSON file shipped). Bold sans editorial
// energy: warm cream paper, near-black ink, brick/orange accent, ochre soft.
const KIOSK: Theme = {
  id:               'kiosk',
  name:             'Kiosk',
  shortDescription: 'Newsstand confidence, bold + bright',
  mood:             'Graphic, energetic, contemporary',
  isDark:           false,
  statusBarStyle:   'dark',
  colors: {
    appBackground:    '#F4ECDA',
    surface:          '#FCF6E8',
    surfaceElevated:  '#FFFFFF',
    cardBackground:   '#FCF6E8',
    textPrimary:      '#1A1612',
    textSecondary:    '#4A4239',
    textMuted:        '#8C7F6E',
    border:           'rgba(26,22,18,0.16)',
    divider:          'rgba(26,22,18,0.08)',
    accent:           '#C0392B',
    accentSoft:       '#F6E0BA',
    accentText:       '#FCF6E8',
    accentAlt:        '#E5B449',
    success:          '#3F7D3F',
    warning:          '#E5B449',
    danger:           '#C0392B',
    progressFill:     '#C0392B',
    progressTrack:    'rgba(26,22,18,0.12)',
    tabActive:        '#1A1612',
    tabInactive:      '#8C7F6E',
    tabBar:           '#FCF6E8',
    pillBackground:   '#F6E0BA',
    inputBackground:  '#FCF6E8',
  },
  typography: {
    displayFamily: undefined,
    bodyFamily:    undefined,
    monoFamily:    undefined,
    italicFamily:  undefined,
    headingWeight: '800',       // Bolder weight matches the newsstand mood
    bodyWeight:    '500',
  },
  radius: RADIUS,
  shadow: makeShadow(0.18, 3),
};

// ─── Registry ────────────────────────────────────────────────────────────────
export const THEMES: Record<ThemeId, Theme> = {
  north:   NORTH,
  atelier: ATELIER,
  kiosk:   KIOSK,
};

/** Order in which themes appear in the Settings picker. */
export const THEME_ORDER: ThemeId[] = ['north', 'atelier', 'kiosk'];

/** Default theme — also the safe fallback if persisted id is unknown. */
export const DEFAULT_THEME_ID: ThemeId = 'north';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (value === 'north' || value === 'atelier' || value === 'kiosk');
}

export function getTheme(id: ThemeId): Theme {
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
}
