// ─── Import onboarding state persistence ──────────────────────────────────────
//
// Shared persistence helpers for the final onboarding import step.
// The UI lives at app/onboarding-import.tsx (a first-class route).
//
// AsyncStorage key: readstack_import_ob_v1
//   null          — default; walkthrough not yet completed
//   'pending'     — walkthrough done, decision not yet made
//                   → app redirects to /onboarding-import on any mount
//   'importing'   — user tapped Import (mid-flow or abandoned)
//                   → never redirect again; import accessible via Settings
//   'dismissed'   — user chose "Not right now" or quick questions
//                   → never redirect again
//   'completed'   — import finished successfully
//                   → never redirect again

import AsyncStorage from '@react-native-async-storage/async-storage';

export const IMPORT_OB_KEY = 'readstack_import_ob_v1';

export type ImportObState = 'pending' | 'importing' | 'dismissed' | 'completed';

export async function getImportObState(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(IMPORT_OB_KEY);
  } catch {
    return null;
  }
}

export async function setImportObState(val: ImportObState): Promise<void> {
  try {
    await AsyncStorage.setItem(IMPORT_OB_KEY, val);
  } catch {}
}
