import AsyncStorage from '@react-native-async-storage/async-storage';

// Stages, in order:
//   walkthrough   - the multi-card onboarding tour
//   final_setup   - on the import / pick-genres / skip choice screen
//   intake_active - inside the "Pick genres" flow (genres → taste → anchor),
//                   guarantees a cold-restart user is routed back to
//                   /onboarding-questions to finish what they started
//   done          - all onboarding complete; main app is the home
export type OnboardingStage = 'walkthrough' | 'final_setup' | 'intake_active' | 'done';

export const ONBOARDING_STAGE_KEY = 'readstack_onboarding_stage_v1';

export async function readOnboardingStage(): Promise<OnboardingStage | null> {
  try {
    const val = await AsyncStorage.getItem(ONBOARDING_STAGE_KEY);
    if (val === 'walkthrough' || val === 'final_setup' || val === 'intake_active' || val === 'done') {
      return val as OnboardingStage;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeOnboardingStage(stage: OnboardingStage): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_STAGE_KEY, stage);
  } catch {}
}
