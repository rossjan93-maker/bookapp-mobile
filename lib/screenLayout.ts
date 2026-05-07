// Screen layout — single source of truth for top-of-screen padding so every
// route lines up the same way under the device safe area, regardless of
// whether the user is in onboarding, viewing an empty state, or browsing
// fully populated data.
//
// All Expo Router screens here are configured with `headerShown: false`
// (see app/_layout.tsx), so each screen manages its own top inset. Without
// a shared rule this drifted into a mix of:
//   • `paddingTop: insets.top + 16`
//   • `paddingTop: insets.top + 8`
//   • `paddingTop: 56` / `60` (hardcoded — ignores notches)
//   • SafeAreaView with no extra padding (clips on web/Android)
//
// Use `SCREEN_TOP_PADDING` for the constant breathing-room offset and
// `useScreenTopPadding()` for the full computed value (`insets.top + 16`).

import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const SCREEN_TOP_PADDING = 16;

/** Total top padding to apply to a full-screen route's first child. */
export function useScreenTopPadding(): number {
  const insets = useSafeAreaInsets();
  return insets.top + SCREEN_TOP_PADDING;
}
