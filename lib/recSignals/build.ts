// =============================================================================
// recSignals/build.ts — compile typed signals from raw inputs (P1)
//
// Pure / synchronous. Caller is responsible for the IO (fetching prefs row,
// loading TasteProfile). This separation keeps the signal layer testable and
// keeps async fetch concerns inside lib/recRequest.ts.
// =============================================================================

import type { AffinityKey } from '../taxonomy/genres';
import { normalizeGenreInput } from '../taxonomy/normalize';
import type { TasteProfile } from '../tasteProfile';
import type {
  Signals,
  StatedTasteSignal,
  RevealedTasteSignal,
  SoftAvoidSignal,
  CurrentIntentSignal,
  DiagnosisAnswersSignal,
  ShortTermFeedbackSignal,
} from './types';
import { partitionReadingStyles, classifyDiagnosisAnswers } from './partitions';

export type RawPrefsRow = {
  favorite_genres:  string[] | null;
  avoid_genres:     string[] | null;
  reading_styles:   string[] | null;
  favorite_authors: string | null;
  updated_at:       string | null;
  /**
   * P4A: jsonb column from reader_preferences. Shape is an open record of
   * answer-key → answer-value strings, plus an optional `intentScope`
   * discriminator. Null when the column is absent or empty.
   */
  diagnosis_answers?: Record<string, unknown> | null;
};

function resolveGenresToAffinityKeys(labels: readonly string[]): AffinityKey[] {
  const out: AffinityKey[] = [];
  const seen = new Set<AffinityKey>();
  for (const label of labels) {
    const def = normalizeGenreInput(label);
    if (!def) continue;            // unmappable labels: telemetered by normalize, dropped here
    if (seen.has(def.affinityKey)) continue;
    seen.add(def.affinityKey);
    out.push(def.affinityKey);
  }
  return out;
}

function parseIsoToMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function parseAuthors(s: string | null): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0 && !/^unknown/i.test(a));
}

export function buildSignals(opts: {
  profile:  TasteProfile;
  prefsRow: RawPrefsRow | null;
  intent?:  unknown | null;
  feedback?: unknown | null;
}): Signals {
  const prefs = opts.prefsRow ?? {
    favorite_genres: [], avoid_genres: [], reading_styles: [], favorite_authors: null, updated_at: null,
  };

  const rawStyles = (prefs.reading_styles ?? []).slice();
  const stylePartition = partitionReadingStyles(rawStyles);
  const stated: StatedTasteSignal = {
    signalClass:          'stated_durable',
    favoriteGenres:       resolveGenresToAffinityKeys(prefs.favorite_genres ?? []),
    readingStyles:        rawStyles,
    readingStylesDurable: stylePartition.durable,
    readingStylesIntent:  stylePartition.intent,
    readingStylesUnknown: stylePartition.unknown,
    favoriteAuthors:      parseAuthors(prefs.favorite_authors),
    updatedAt:            parseIsoToMs(prefs.updated_at),
  };

  const revealed: RevealedTasteSignal = {
    signalClass: 'revealed_behavioral',
    profile:     opts.profile,
  };

  const softAvoids: SoftAvoidSignal = {
    signalClass: 'soft_avoid',
    genres:      resolveGenresToAffinityKeys(prefs.avoid_genres ?? []),
    updatedAt:   parseIsoToMs(prefs.updated_at),
  };

  const currentIntent: CurrentIntentSignal | undefined =
    opts.intent != null
      ? { signalClass: 'current_intent', payload: opts.intent }
      : undefined;

  const shortTermFeedback: ShortTermFeedbackSignal | undefined =
    opts.feedback != null
      ? { signalClass: 'short_term_feedback', payload: opts.feedback }
      : undefined;

  // P4A: typed diagnosis-answer surface. Always emitted when the prefs row
  // is present (even if empty), so downstream consumers can rely on shape
  // rather than null-checking. Behavior-neutral: applyDiagnosisBoosts in
  // lib/tasteProfile.ts continues to read the raw jsonb directly.
  let diagnosisAnswers: DiagnosisAnswersSignal | undefined;
  if (opts.prefsRow != null) {
    const cls = classifyDiagnosisAnswers(prefs.diagnosis_answers ?? null);
    diagnosisAnswers = {
      signalClass:   'current_intent',
      intentScope:   cls.intentScope,
      legacy:        cls.legacy,
      intentShaped:  cls.intentShaped,
      durableShaped: cls.durableShaped,
      raw:           cls.raw,
    };
  }

  return { statedTaste: stated, revealedTaste: revealed, softAvoids, currentIntent, diagnosisAnswers, shortTermFeedback };
}
