// ─── Local onboarding / rec-entry state clear ─────────────────────────────────
//
// Single authoritative place to clear device-local state that must NOT survive
// across user accounts on the same device.  Call this on every SIGNED_OUT.
//
// Keys intentionally NOT cleared here:
//   recPayloadCache:${userId}            — user-keyed by Supabase UUID; a new
//                                          user (new UUID) never matches the
//                                          old key, so it orphans harmlessly.
//   readstack_rec_entry_v1_${userId}     — RecEntryScreen seen flag, now user-
//                                          scoped.  A new UUID never finds the
//                                          old key, so delete+recreate on same
//                                          device is handled automatically.
//                                          Clearing on ordinary sign-out would
//                                          regress "Explore anyway" users who
//                                          have no personalization signal.
//
// Cleared on every SIGNED_OUT (errors swallowed; caller is fire-and-forget):
//   readstack_onboarding_stage_v1   — stage machine; must reset for new user
//   readstack_walkthrough_v1        — walkthrough sub-step
//   readstack_guided_v1             — legacy guided-tour step (still read on mount)
//   readstack_tooltip_v1_scan_result — scan tooltip
//   readstack_tooltip_v1_*          — any additional OnboardingTooltip flags
//                                     discovered via prefix scan

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ONBOARDING_STAGE_KEY } from './onboardingStage';
import { WT_STORAGE_KEY } from './walkthroughEngine';
import { GUIDED_TOUR_KEY } from '../components/OnboardingWalkthrough';

const SCAN_TOOLTIP_KEY = 'readstack_tooltip_v1_scan_result';
const TOOLTIP_PREFIX   = 'readstack_tooltip_v1_';

export async function clearLocalOnboardingState(): Promise<void> {
  try {
    const fixed: string[] = [
      ONBOARDING_STAGE_KEY,
      WT_STORAGE_KEY,
      GUIDED_TOUR_KEY,
      SCAN_TOOLTIP_KEY,
    ];

    // Sweep any additional tooltip keys created dynamically by OnboardingTooltip
    const allKeys     = await AsyncStorage.getAllKeys();
    const tooltipKeys = allKeys.filter(k => k.startsWith(TOOLTIP_PREFIX));

    const merged = Array.from(new Set([...fixed, ...tooltipKeys]));
    await AsyncStorage.multiRemove(merged);

    if (__DEV__) console.log('[LOCAL_STATE_CLEAR] cleared', merged.length, 'key(s):', merged);
  } catch (e) {
    if (__DEV__) console.warn('[LOCAL_STATE_CLEAR] failed — non-critical:', e);
  }
}
