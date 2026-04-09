// ─── Onboarding: lightweight intake questions ──────────────────────────────────
//
// Arrived at from /onboarding-import when the user taps "Answer a few questions".
// onboarding-import calls completeOnboarding() and writes stage='done' before
// navigating here, so the routing guard is already disarmed.
//
// This route renders RecEntryScreen starting at the 'intake_genres' phase,
// skipping the three-option entry screen the user already saw.
//
// When the user completes or skips the questions, we:
//   1. Write onboarding_completed=true to the DB (belt-and-suspenders)
//   2. Replace with /(tabs) — they land at the main app

import { SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { RecEntryScreen } from '../components/RecEntryScreen';
import { supabase } from '../lib/supabase';

async function markOnboardingComplete(): Promise<void> {
  if (!supabase) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      await supabase
        .from('profiles')
        .update({ onboarding_completed: true })
        .eq('id', session.user.id);
    }
  } catch {
    // Non-blocking — local stage='done' already gates future logins correctly.
  }
}

export default function OnboardingQuestionsPage() {
  const router = useRouter();

  async function handleDone() {
    // Await the DB write so onboarding_completed=true is durable before
    // navigating away.  markOnboardingComplete() catches its own errors, so
    // this never throws — awaiting it simply ensures the Supabase call is
    // dispatched and completes (or the client times out) before we navigate.
    // Without await, a fast background → foreground switch can silently drop
    // the write, leaving onboarding_completed=false for cross-device logins.
    await markOnboardingComplete();
    // Land on the Recommendations tab so the user immediately sees their picks
    // (or the first-load deck-assembling state) — not a blank home screen.
    router.replace('/(tabs)/search' as any);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
      <RecEntryScreen
        initialPhase="intake_genres"
        onDone={handleDone}
      />
    </SafeAreaView>
  );
}
