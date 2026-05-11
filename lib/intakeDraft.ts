// ─── Intake draft persistence ─────────────────────────────────────────────────
//
// Persists the in-progress state of the "Pick genres" intake flow
// (RecEntryScreen) so a user who quits the app mid-question doesn't lose
// their selections on cold-restart.
//
// Pairs with the 'intake_active' onboarding stage in lib/onboardingStage.ts:
//   - onboarding-import writes stage='intake_active' before navigating to
//     /onboarding-questions
//   - the routing guard in _layout.tsx routes any cold-restart with
//     stage='intake_active' back to /onboarding-questions
//   - RecEntryScreen reads the draft on mount and resumes from the last
//     completed phase, restoring selected genres and taste answers
//   - on completion or skip, the draft is cleared and stage moves to 'done'
//
// Per-user keying ensures account switches on the same device cannot leak
// one user's draft into another's session.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'readstack_intake_draft_v1_';

export type IntakePhase = 'intake_genres' | 'intake_avoid' | 'intake_outcome' | 'intake_taste' | 'intake_anchor';

export type IntakeDraft = {
  phase:        IntakePhase;
  fictionSplit: 'fiction' | 'nonfiction' | 'both';
  likedGenres:  string[];
  avoidGenres:  string[];
  tasteAnswers: Record<string, string>;
  // anchorBook is intentionally not persisted — it's only set on the final
  // step which immediately calls saveQuickIntake; persisting it would leak
  // a stale Google-Books id across cold restarts.
  updatedAt:    number;
};

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export async function readIntakeDraft(userId: string): Promise<IntakeDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IntakeDraft>;
    if (
      (parsed.phase === 'intake_genres' || parsed.phase === 'intake_avoid' || parsed.phase === 'intake_outcome' || parsed.phase === 'intake_taste' || parsed.phase === 'intake_anchor') &&
      Array.isArray(parsed.likedGenres) &&
      typeof parsed.tasteAnswers === 'object'
    ) {
      // Backward-compat: pre-UX-3A drafts have no avoidGenres field. Default to
      // [] so a user mid-flow at release time resumes cleanly without losing
      // their liked-genre / taste-answer selections.
      return {
        phase:        parsed.phase,
        fictionSplit: parsed.fictionSplit === 'fiction' || parsed.fictionSplit === 'nonfiction' ? parsed.fictionSplit : 'both',
        likedGenres:  parsed.likedGenres as string[],
        avoidGenres:  Array.isArray(parsed.avoidGenres) ? (parsed.avoidGenres as string[]) : [],
        tasteAnswers: (parsed.tasteAnswers ?? {}) as Record<string, string>,
        updatedAt:    typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeIntakeDraft(userId: string, draft: Omit<IntakeDraft, 'updatedAt'>): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify({ ...draft, updatedAt: Date.now() }));
  } catch {
    // Non-blocking — draft loss on cold restart is the exact bug we're
    // mitigating, but a single failed write should never break the live flow.
  }
}

export async function clearIntakeDraft(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(userId));
  } catch {}
}
