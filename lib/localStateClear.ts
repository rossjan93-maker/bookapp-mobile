// ─── Local onboarding / rec-entry state clear ─────────────────────────────────
//
// Single authoritative place to clear all device-local state that must NOT
// survive across user accounts.  Call this on every SIGNED_OUT event.
//
// Keys intentionally NOT cleared here:
//   recPayloadCache:${userId}  — user-keyed by Supabase UUID.  A different
//                                user (or the same email with a new UUID after
//                                account deletion) will never match the old key,
//                                so it is effectively orphaned and harmless.
//
// Cleared synchronously (fire-and-forget from caller; errors swallowed):
//   readstack_onboarding_stage_v1   — stage machine; must reset for new user
//   readstack_walkthrough_v1        — walkthrough sub-step
//   readstack_rec_entry_v1          — RecEntryScreen seen flag
//   readstack_guided_v1             — legacy guided-tour step (still read on mount)
//   readstack_tooltip_v1_scan_result — scan tooltip
//   readstack_tooltip_v1_*          — any additional OnboardingTooltip flags
//                                     discovered via prefix scan

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ONBOARDING_STAGE_KEY } from './onboardingStage';
import { WT_STORAGE_KEY } from './walkthroughEngine';
import { REC_ENTRY_KEY } from '../components/RecEntryScreen';
import { GUIDED_TOUR_KEY } from '../components/OnboardingWalkthrough';

const SCAN_TOOLTIP_KEY = 'readstack_tooltip_v1_scan_result';
const TOOLTIP_PREFIX   = 'readstack_tooltip_v1_';

export async function clearLocalOnboardingState(): Promise<void> {
  try {
    const fixed: string[] = [
      ONBOARDING_STAGE_KEY,
      WT_STORAGE_KEY,
      REC_ENTRY_KEY,
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
