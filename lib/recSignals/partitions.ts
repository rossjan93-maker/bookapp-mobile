// =============================================================================
// recSignals/partitions.ts — P4A Signal Partition Contract
//
// Read-layer partition helpers that classify already-captured user inputs
// (reading_styles, diagnosis_answers) into durable-taste vs current/session-
// intent buckets. NO behavior change in P4A: the helpers expose typed
// partitions alongside the existing raw arrays. Existing consumers
// (applyStyleBoosts, applyDiagnosisBoosts in lib/tasteProfile.ts) keep
// reading the raw, unchanged data — they are NOT rewired here.
//
// Why a separate module (not inlined in build.ts):
//   - The canonical partition lists are referenced by both the signal
//     builder AND the validator (scripts/validate_signal_partition.ts);
//     a single source of truth prevents drift.
//   - P4B (book-trait foundation) and P4C (current_intent contribution
//     emission) will read these same lists; isolating them now means
//     those later edits do not have to touch the signal builder again.
//
// Hard-rule (validator-enforced): every reading_style chip declared in
// app/edit-preferences.tsx STYLES belongs to EXACTLY ONE partition. No
// style may appear in both; no style may appear in neither.
// =============================================================================

// ── Reading-style partition ──────────────────────────────────────────────────
//
// Mirrors the STYLES array in app/edit-preferences.tsx (10 chips). Partition
// reflects the durable-vs-current-intent diagnosis in replit.md §"Durable
// taste vs current intent":
//   • intent chips describe a momentary mood / pace / tone preference that
//     a reader may toggle session-to-session (Fast-paced today, Slow-burn
//     next week). These should NOT be applied as persistent trait priors
//     once P4C wires them as typed current_intent contributions — but
//     until then, applyStyleBoosts continues to consume them durably for
//     back-compat (zero behavior change in P4A).
//   • durable chips describe an enduring craft preference (prose density,
//     character-vs-plot orientation, reflective stance) that is reasonable
//     to apply as a long-running trait prior.

export const READING_STYLE_INTENT_LABELS: readonly string[] = [
  'Fast-paced',
  'Slow-burn',
  'Light read',
  'Dark themes',
  'Funny / Witty',
  'Action-packed',
] as const;

export const READING_STYLE_DURABLE_LABELS: readonly string[] = [
  'Character-driven',
  'Plot-driven',
  'Dense prose',
  'Reflective',
] as const;

/** Canonical full list — kept in sync with app/edit-preferences.tsx STYLES. */
export const READING_STYLE_ALL_LABELS: readonly string[] = [
  ...READING_STYLE_DURABLE_LABELS,
  ...READING_STYLE_INTENT_LABELS,
] as const;

const _INTENT_SET  = new Set<string>(READING_STYLE_INTENT_LABELS);
const _DURABLE_SET = new Set<string>(READING_STYLE_DURABLE_LABELS);

export type ReadingStylePartition = {
  durable: readonly string[];
  intent:  readonly string[];
  /** Styles present in storage but absent from both partitions (telemetry only). */
  unknown: readonly string[];
};

/**
 * Partition a user's stored reading_styles array into durable vs intent
 * buckets. Unknown labels (e.g. a future chip we haven't classified, or a
 * legacy chip removed from the UI) are kept in `unknown` for telemetry —
 * NOT silently merged into either partition.
 */
export function partitionReadingStyles(styles: readonly string[]): ReadingStylePartition {
  const durable: string[] = [];
  const intent:  string[] = [];
  const unknown: string[] = [];
  const seenD = new Set<string>();
  const seenI = new Set<string>();
  const seenU = new Set<string>();
  for (const s of styles) {
    if (_DURABLE_SET.has(s)) {
      if (!seenD.has(s)) { seenD.add(s); durable.push(s); }
    } else if (_INTENT_SET.has(s)) {
      if (!seenI.has(s)) { seenI.add(s); intent.push(s); }
    } else {
      if (!seenU.has(s)) { seenU.add(s); unknown.push(s); }
    }
  }
  return { durable, intent, unknown };
}

// ── Diagnosis-answer partition ───────────────────────────────────────────────
//
// Quick-taste captures both intent-shaped answers (purpose-of-reading-now,
// pacing-mood, tone-mood, what-grips-now) and durable-shaped answers
// (fic_nonfic_split). Today every answer is persisted to
// reader_preferences.diagnosis_answers and applied as a persistent trait
// prior via applyDiagnosisBoosts (lib/tasteProfile.ts:256-270). That is
// the inverse of the locked P1 model for the intent-shaped subset.
//
// P4A introduces a back-compat-safe read-layer discriminator. The writer
// (components/RecEntryScreen.tsx) is NOT changed in P4A — so every
// existing AND every newly-captured row continues to land without an
// explicit intentScope key and is therefore classified `durable / legacy`.
// classifyDiagnosisAnswers() honors an explicit `intentScope` key if a
// future writer adds it; otherwise defaults to legacy/durable.
//
// Behavior contract for P4A:
//   - applyDiagnosisBoosts in lib/tasteProfile.ts continues to consume the
//     full raw answers map. ZERO change to its inputs.
//   - The typed signal exposes the partition for forward consumers
//     (P4B trait foundation, P4C contribution emission).

// Canonical key names match the quick-taste writer in
// components/RecEntryScreen.tsx (intake question ids + saveQuickIntake):
//   q_outcome     — UX-3C "what are you here for" / reading purpose
//   q_pacing      — pacing mood right now
//   q_tone        — tone mood right now (dark / light)
//   q_what_grips  — what grips the reader right now
// Durable answers use `b_` prefix (e.g. b_fiction_split = fiction/nonfiction
// split). Read-only legacy audit on 2026-05-16 confirmed the production
// reader_preferences row uses exactly these key names.
export const DIAGNOSIS_INTENT_KEYS: readonly string[] = [
  'q_outcome',
  'q_pacing',
  'q_tone',
  'q_what_grips',
] as const;

const _INTENT_KEY_SET = new Set<string>(DIAGNOSIS_INTENT_KEYS);

export type DiagnosisIntentScope = 'session' | 'durable';

export type DiagnosisClassification = {
  intentScope:    DiagnosisIntentScope;
  /** true when the source row lacked an explicit intentScope discriminator. */
  legacy:         boolean;
  /** Subset matching DIAGNOSIS_INTENT_KEYS — answers we consider intent-shaped. */
  intentShaped:   Readonly<Record<string, string>>;
  /** All other keys (e.g. fic_nonfic_split) — answers we consider durable taste. */
  durableShaped:  Readonly<Record<string, string>>;
  /**
   * Full unsplit answers map exactly as stored. Existing consumers
   * (applyDiagnosisBoosts) read this so the contract addition is
   * behavior-neutral.
   */
  raw:            Readonly<Record<string, string>>;
};

/**
 * Classify a stored diagnosis_answers jsonb into intent-shaped vs durable
 * partitions and resolve the intentScope discriminator.
 *
 * Resolution order for intentScope:
 *   1. Explicit `intentScope` key in the jsonb (future writer convention).
 *   2. Absent → `'durable'` with legacy=true (back-compat for every row
 *      written before this P4A contract landed).
 *
 * Empty / null / non-object input returns an empty classification with
 * intentScope='durable', legacy=true.
 */
export function classifyDiagnosisAnswers(
  answers: unknown,
): DiagnosisClassification {
  const empty: DiagnosisClassification = {
    intentScope:   'durable',
    legacy:        true,
    intentShaped:  Object.freeze({}),
    durableShaped: Object.freeze({}),
    raw:           Object.freeze({}),
  };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return empty;
  }
  const obj = answers as Record<string, unknown>;
  const rawScope = obj.intentScope;
  let intentScope: DiagnosisIntentScope = 'durable';
  let legacy = true;
  if (rawScope === 'session' || rawScope === 'durable') {
    intentScope = rawScope;
    legacy = false;
  }

  const intentShaped: Record<string, string> = {};
  const durableShaped: Record<string, string> = {};
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'intentScope') continue;             // discriminator, not an answer
    if (typeof v !== 'string') continue;           // tolerate noise without crashing
    raw[k] = v;
    if (_INTENT_KEY_SET.has(k)) intentShaped[k] = v;
    else                        durableShaped[k] = v;
  }
  return {
    intentScope,
    legacy,
    intentShaped:  Object.freeze(intentShaped),
    durableShaped: Object.freeze(durableShaped),
    raw:           Object.freeze(raw),
  };
}
