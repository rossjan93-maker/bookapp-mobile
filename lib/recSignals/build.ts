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
  ShortTermFeedbackSignal,
} from './types';

export type RawPrefsRow = {
  favorite_genres:  string[] | null;
  avoid_genres:     string[] | null;
  reading_styles:   string[] | null;
  favorite_authors: string | null;
  updated_at:       string | null;
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

  const stated: StatedTasteSignal = {
    signalClass:     'stated_durable',
    favoriteGenres:  resolveGenresToAffinityKeys(prefs.favorite_genres ?? []),
    readingStyles:   (prefs.reading_styles ?? []).slice(),
    favoriteAuthors: parseAuthors(prefs.favorite_authors),
    updatedAt:       parseIsoToMs(prefs.updated_at),
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

  return { statedTaste: stated, revealedTaste: revealed, softAvoids, currentIntent, shortTermFeedback };
}
