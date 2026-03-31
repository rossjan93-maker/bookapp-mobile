// ─── Shared personalization-signal check ─────────────────────────────────────
//
// Returns true when the user has meaningful data that will drive recommendations
// (genres, taste answers, finished books).  Used by:
//
//   • _layout.tsx  — to decide whether to show OnboardingImportPrompt
//   • search.tsx   — to decide whether to show RecEntryScreen
//
// Deliberately lightweight: a single supabase query, no heavy scoring logic.

import { supabase } from './supabase';

export async function hasPersonalizationSignal(userId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { data: prefs } = await supabase
      .from('reader_preferences')
      .select('favorite_genres, diagnosis_answers')
      .eq('user_id', userId)
      .maybeSingle();

    if (prefs) {
      const genres  = (prefs.favorite_genres as string[] | null) ?? [];
      const answers = (prefs.diagnosis_answers as Record<string, string> | null) ?? {};
      if (genres.length > 0) return true;
      if (answers.intake_completed === 'true') return true;
      const tasteKeys = Object.keys(answers).filter(
        k => !k.startsWith('b_') && k !== 'intake_completed',
      );
      if (tasteKeys.length > 0) return true;
    }

    const { count } = await supabase
      .from('user_books')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'finished');

    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}
