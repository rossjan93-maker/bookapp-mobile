// ─── Local onboarding / rec-entry state clear ─────────────────────────────────
//
// Single authoritative place to clear device-local state that must NOT survive
// across user accounts on the same device.  Call this on every SIGNED_OUT and
// on account deletion.
//
// Strategy: sweep ALL AsyncStorage keys that start with the 'readstack_'
// namespace prefix and remove them in one call.  This is safe and future-proof:
//
//   Non-user-scoped keys (must always be cleared for a brand-new account):
//     readstack_onboarding_stage_v1       — onboarding stage machine
//     readstack_walkthrough_v1            — walkthrough sub-step position
//     readstack_guided_v1                 — legacy guided-tour step
//     readstack_tooltip_v1_scan_result    — scan tooltip seen flag
//     readstack_tooltip_v1_*              — any other OnboardingTooltip flags
//     readstack_import_ob_v1              — import onboarding seen flag
//                                          (written by a prior app version;
//                                           may exist on device even if no
//                                           current code writes it)
//
//   User-scoped keys (safe to clear — new UUID means new key on next login):
//     readstack_rec_entry_v1_${userId}    — RecEntryScreen seen flag
//     readstack_rec_entry_v1              — bare (unscoped) legacy shape;
//                                          may exist on device from before
//                                          user-scoping was introduced
//     readstack_rec_v1_${userId}          — rec payload cache
//     readstack_rec_acted_v1_${userId}    — acted-on rec IDs cache
//
// Any future key written under the 'readstack_' namespace is covered
// automatically without needing to edit this file.

import AsyncStorage from '@react-native-async-storage/async-storage';

const NAMESPACE_PREFIX = 'readstack_';

export async function clearLocalOnboardingState(): Promise<void> {
  try {
    const allKeys  = await AsyncStorage.getAllKeys();
    const toClear  = allKeys.filter(k => k.startsWith(NAMESPACE_PREFIX));

    if (toClear.length === 0) {
      if (__DEV__) console.log('[LOCAL_STATE_CLEAR] no readstack_ keys found — nothing to clear');
      return;
    }

    await AsyncStorage.multiRemove(toClear);

    if (__DEV__) console.log('[LOCAL_STATE_CLEAR] cleared', toClear.length, 'key(s):', toClear);
  } catch (e) {
    if (__DEV__) console.warn('[LOCAL_STATE_CLEAR] failed — non-critical:', e);
  }
}
