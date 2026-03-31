import AsyncStorage from '@react-native-async-storage/async-storage';

export type OnboardingStage = 'walkthrough' | 'final_setup' | 'done';

export const ONBOARDING_STAGE_KEY = 'readstack_onboarding_stage_v1';

export async function readOnboardingStage(): Promise<OnboardingStage | null> {
  try {
    const val = await AsyncStorage.getItem(ONBOARDING_STAGE_KEY);
    if (val === 'walkthrough' || val === 'final_setup' || val === 'done') {
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
