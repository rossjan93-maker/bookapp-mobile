// =============================================================================
// explanations/compose.ts — P3A-4 internal explanation composer
//
// Pure / synchronous / read-only function that takes a contribution bundle
// (retrieval + scoring contributions, the typed output of P3A-2 + P3A-3)
// and returns a structured ExplanationOutput. No I/O, no randomness, no
// dependency on the recommender module — just contributions in, lines out.
//
// IMPORTANT — P3A-4 scope:
//   - This module is NOT wired into RecCard, RecommendationsFeed, the
//     for-you payload, or `book.reasons[]` anywhere in production yet.
//   - The composer is gated by DISPLAY_FLOORS (in lib/scoring/contributions.ts)
//     and the faithfulness rules below. Its output is consumed only by
//     scripts/validate_explanation_faithfulness.ts in this batch.
//   - P3A-5+ will introduce a derived `reasons[]` projection from the
//     composer output (per D5 backward-compat) and rewire RecCard.
//
// Faithfulness rules enforced (per locked P3A-4 spec):
//   A. Causal contribution explanation
//        → requires an eligible POSITIVE scoring contribution whose
//          absolute value is ≥ DISPLAY_FLOORS[kind].
//   B. Descriptive fit
//        → allowed only as kind='descriptive' (never 'causal'); does not
//          claim personal causation.
//   C. Risk / caution
//        → emitted from NEGATIVE scoring contributions whose absolute
//          value is ≥ DISPLAY_FLOORS[kind] (soft_avoid_penalty,
//          hygiene_floor). Never surfaced as a positive reason.
//   D. quality_reliability
//        → may emit a DESCRIPTIVE line only (never causal personal-taste
//          language).
//
// Evidence-limitation enforcement (per P3A-3 audit):
//   - stated_taste_fit may cite specific matched stated key
//     (source=stated_favorite:<key> / stated_softavoid:<key>) when
//     evidence.matchedKind+matchedKey is present.
//   - behavioral_fit (trait_alignment + genre_affinity) is aggregate
//     today; emits a generic causal line only (no specific
//     trait/genre/subject naming) until per-component attribution is
//     retained in _score_breakdown (P3A-5+ scoring-side refactor).
//   - feedback_fit is aggregate; emits a generic causal line.
//   - hygiene_floor cautions cite audit_subflags conservatively
//     (no fabricated specificity).
//   - intent_fit / novelty_diversity / repetition_suppression are not
//     emitted today (no breakdown field).
//   - Retrieval-only contributions (no matching scoring contribution
//     above floor) NEVER produce a causal line. Recorded in debug.
// =============================================================================

import { DISPLAY_FLOORS } from '../scoring/contributions';
import type {
  RetrievalContribution,
  ScoringContribution,
} from '../scoring/contributions';
import { affinityDisplayLabel } from '../taxonomy/genres';

// ── Input ────────────────────────────────────────────────────────────────────
export type ExplanationBundle = {
  /** retrieval-phase contributions attached by P3A-2 (one per
   *  _retrieval_reasons[] entry, in arrival order). */
  retrieval: readonly RetrievalContribution[];
  /** scoring-phase contributions attached by P3A-3 (derived from
   *  _score_breakdown; zero/absent components produce no entry). */
  scoring:   readonly ScoringContribution[];
};

// ── Output ───────────────────────────────────────────────────────────────────
/** kind = which faithfulness class this line belongs to:
 *   - causal      : justified by a scoring contribution above its floor
 *   - descriptive : metadata-only descriptor; never claims personal causation
 *   - caution     : risk / drift / soft-avoid penalty
 *   - generic     : quality / popularity descriptor; never personal-taste
 */
export type ExplanationLineKind = 'causal' | 'descriptive' | 'caution' | 'generic';

export type ExplanationLine = {
  kind:        ExplanationLineKind;
  /** Stable internal source token; the validator and (later) RecCard
   *  rewire read this to pick a phrasing pool. Never surfaced as-is. */
  source:      string;
  /** Internal phrasing — NOT user-facing copy in P3A-4. The RecCard
   *  rewire in P3A-5+ will replace these with the existing variant pools
   *  for backward compatibility with current visible copy. */
  text:        string;
  /** Free-form evidence payload mirrored from the underlying scoring
   *  contribution. Empty for descriptive/generic lines. */
  evidence?:   Record<string, unknown>;
  /** Reference back to the scoring contribution that justifies this line
   *  (kind + signed value), so the validator can prove faithfulness. */
  scoringRef?: { kind: ScoringContribution['kind']; value: number };
};

export type ExplanationOutput = {
  /** Strongest causal/generic line, if any qualifies. Always either a
   *  causal or generic line — descriptive/caution lines never become
   *  primary (they ride alongside). */
  primary?:    ExplanationLine;
  /** Additional causal/generic lines beyond primary, in priority order.
   *  Capped at 1 to mirror today's RecCard reasons[] cap (max 2 total). */
  secondary:   ExplanationLine[];
  /** Caution / risk lines from negative scoring contributions above
   *  their absolute-value floor. Capped at 1 to mirror today's
   *  RecCard risks[] cap. */
  cautions:    ExplanationLine[];
  /** Pure descriptive lines (e.g. quality/popularity) that ride alongside
   *  but never imply causation. Capped at 1. */
  descriptive: ExplanationLine[];
  /** Internal observability surface for the faithfulness validator. */
  debug: {
    /** Distinct scoring-contribution kinds that produced an emitted line. */
    emittedKinds:     string[];
    /** Distinct scoring-contribution kinds that were above floor but
     *  suppressed (e.g. because the priority cap was hit). */
    aboveFloorKinds:  string[];
    /** Distinct retrieval-only sources (no matching scoring contribution
     *  above floor). Recorded so the validator can prove that a candidate
     *  retrieved by `stated_genre:thriller_mystery` but with zero
     *  stated_taste_fit contribution does NOT get a "based on your
     *  thriller preference" causal line. */
    retrievalOnly:    string[];
    /** Reasons a contribution was filtered out, for debugging. */
    suppressed:       string[];
  };
};

// ── Phrasing helpers ─────────────────────────────────────────────────────────
//
// Internal text only; NOT user-facing in P3A-4. RecCard rewire in P3A-5+
// will swap these for the existing variant pools so visible copy is
// unchanged. The strings deliberately avoid the banned phrasings listed in
// replit.md (`"you gravitate toward"`, `"because you liked"`, `"you loved"`,
// `"perfect for you"`, `"consistently"`, `"always"`, `"most"`).

function phrasingForStated(value: number, ev?: Record<string, unknown>): string {
  const key = (ev?.matchedKey as string | undefined) ?? '';
  const kind = (ev?.matchedKind as string | undefined) ?? '';
  // Visible copy uses the humanised display label per AffinityKey; the
  // raw internal key is preserved on `evidence.matchedKey` for audit /
  // debug / downstream contribution accounting. Scenario B live smoke
  // (2026-05-16) surfaced `"Matches your stated thriller_mystery
  // preference"` as user-visible — fixed by routing through
  // affinityDisplayLabel(). Fallback to the generic phrasing only when
  // the lookup yields empty, never to a vague copy when a label exists.
  const label = affinityDisplayLabel(key);
  if (kind === 'favorite' && label) return `Matches your stated ${label} preference`;
  if (kind === 'softavoid' && label) return `Leans into ${label}, which you've marked to see less of`;
  return value > 0 ? 'Matches a preference you stated' : 'Leans into a category you said to see less of';
}

function phrasingForBehavioral(source?: string): string {
  // Aggregate-only today — generic phrasing per the P3A-3 evidence audit.
  if (source === 'genre_affinity') return 'Fits a genre that has worked for you';
  return 'Aligns with your reading patterns';
}

function phrasingForFeedback(): string {
  return 'Similar to books you asked for more of';
}

function phrasingForQuality(): string {
  // Descriptive / generic only — NEVER personal-taste language.
  return 'Highly rated by other readers';
}

function phrasingForSoftAvoid(): string {
  return 'Leans into traits you have asked to avoid';
}

// ── P4D phrasings ────────────────────────────────────────────────────────────
//
// Narrow composer admission for the three P4C kinds with strong, real
// evidence: tone_fit, pace_fit, series_continuation_fit. All phrasings stay
// conservative — no `"you want"`, `"you'll love"`, `"perfect for you"` or
// other absolute-claim language (per replit.md banned phrasings + the P4D
// spec). The user-facing line names the trait, not the inferred desire.
//
// Admission gates are enforced in the switch cases below, NOT here. Each
// helper assumes the gate has already passed (value above floor, evidence
// is `specific` confidence, match==='match', signedEligible===true). The
// composer remains pure / synchronous; ranking/scoring/composition unchanged.

function phrasingForToneFit(ev?: Record<string, unknown>): string {
  const bookTone = (ev?.bookTone as string | undefined) ?? '';
  // userTone is the matched-on side; bookTone === userTone here (gate).
  if (bookTone === 'light') return 'Lighter tone, in line with your current intent';
  if (bookTone === 'dark')  return 'Darker tone, in line with your current intent';
  return 'Tone fits your current intent';
}

function phrasingForPaceFit(ev?: Record<string, unknown>): string {
  const bookPace = (ev?.bookPace as string | undefined) ?? '';
  if (bookPace === 'fast') return 'Faster pace, in line with your current intent';
  if (bookPace === 'slow') return 'Slow-burn pacing, in line with your current intent';
  return 'Pacing fits your current intent';
}

function phrasingForSeriesContinuation(ev?: Record<string, unknown>): string {
  const name = (ev?.seriesName as string | undefined) ?? '';
  // P4C emit guarantees seriesName + priorReadCount > 0 when the
  // contribution exists at all, so we can name the series directly. Avoid
  // any "you'll love" / "you've been waiting" absolute-claim language —
  // just describe the position relative to what the user has finished.
  if (name) return `Next in ${name}`;
  return 'Continues a series you have started';
}

function phrasingForHygiene(subflags: readonly string[]): string {
  // Conservative: surface the named drift subflag if present, but do not
  // fabricate specifics beyond the audit list.
  const pri = subflags.find(f =>
       f === 'noir_drift' || f === 'noir_drift_confirmed'
    || f === 'spy_drift' || f === 'philosophy_drift'
    || f === 'literary_drift' || f === 'graphic_format');
  if (pri === 'noir_drift' || pri === 'noir_drift_confirmed') return 'Hard-boiled noir — different feel from your usual reads';
  if (pri === 'spy_drift')        return 'Classic spy / adventure — older feel than your usual reads';
  if (pri === 'philosophy_drift') return 'Philosophical or spiritual focus — different territory from your usual reads';
  if (pri === 'literary_drift')   return 'Leans more literary than your strongest recurring reads';
  if (pri === 'graphic_format')   return 'Graphic novel format — a different reading medium';
  if (subflags.includes('weak_metadata')) return 'Limited metadata — fit estimate is approximate';
  return 'Some signals don\u2019t quite match your usual reads';
}

// ── Composer ─────────────────────────────────────────────────────────────────
const PRIMARY_PRIORITY: ScoringContribution['kind'][] = [
  'stated_taste_fit',
  'behavioral_fit',
  'feedback_fit',
];

// ── P4D — narrow composer admission ─────────────────────────────────────────
// Three P4C kinds eligible for composer-backed visible explanations under
// strict gates (enforced in lineFor() below). Iterated AFTER
// PRIMARY_PRIORITY so they cannot displace stated_taste_fit / behavioral_fit
// / feedback_fit from the primary slot — they only fill the secondary slot
// (or become primary if no PRIMARY kind cleared its floor, e.g. cold-start
// users with a strong tone/pace intent on a confident-tone book).
//
// Ordering by evidence strength: series_continuation_fit cites a named
// real-read prior, tone_fit/pace_fit cite a current intent + specific book
// trait. complexity_fit, current_intent_fit, avoidance_conflict, and
// not_right_now_risk remain suppressed in this batch (see switch cases).
const SECONDARY_PRIORITY: ScoringContribution['kind'][] = [
  'series_continuation_fit',
  'tone_fit',
  'pace_fit',
];

const MAX_SECONDARY = 1;
const MAX_CAUTIONS  = 1;
const MAX_DESCRIPTIVE = 1;

export function composeExplanation(bundle: ExplanationBundle): ExplanationOutput {
  const causal: ExplanationLine[]      = [];
  const cautions: ExplanationLine[]    = [];
  const descriptive: ExplanationLine[] = [];

  const aboveFloorKinds       = new Set<string>();
  /** Kinds that actually produced a causal-or-generic (non-caution) line.
   *  Used by the retrievalOnly gate below — a retrieval source is NOT
   *  "covered" by a kind whose only above-floor aggregate was negative
   *  (which surfaces as a caution, not as causal coverage). */
  const causalCoverageKinds   = new Set<string>();
  const emittedKinds          = new Set<string>();
  const suppressed: string[]  = [];

  // ── Walk scoring contributions ────────────────────────────────────────────
  // Group by kind so multiple behavioral_fit entries (trait + genre) coalesce
  // into one line — current breakdown does not retain per-component
  // attribution beyond the source string anyway.
  const byKind = new Map<ScoringContribution['kind'], ScoringContribution[]>();
  for (const c of bundle.scoring) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind)!.push(c);
  }

  function lineFor(kind: ScoringContribution['kind']): ExplanationLine | null {
    const entries = byKind.get(kind);
    if (!entries || entries.length === 0) return null;
    const floor   = DISPLAY_FLOORS[kind];
    const sum     = entries.reduce((a, c) => a + c.value, 0);
    if (Math.abs(sum) < floor) {
      suppressed.push(`${kind}:below_floor(|${sum.toFixed(3)}|<${floor})`);
      return null;
    }
    aboveFloorKinds.add(kind);

    switch (kind) {
      case 'stated_taste_fit': {
        if (sum > 0) {
          const ev = entries.find(e => e.value > 0)?.evidence;
          return {
            kind: 'causal', source: 'stated_taste_fit',
            text: phrasingForStated(sum, ev),
            evidence: ev, scoringRef: { kind, value: sum },
          };
        }
        // Negative stated_taste means a soft-avoid stated match drove the
        // score down. Surface as caution, NOT as a positive reason.
        const evNeg = entries.find(e => e.value < 0)?.evidence;
        return {
          kind: 'caution', source: 'stated_taste_fit_negative',
          text: phrasingForStated(sum, evNeg),
          evidence: evNeg, scoringRef: { kind, value: sum },
        };
      }
      case 'behavioral_fit': {
        if (sum <= 0) {
          suppressed.push(`${kind}:non_positive_aggregate`);
          return null;
        }
        // Aggregate today — generic phrasing only (no per-trait specifics).
        const sourceHint = entries.find(e => e.source === 'genre_affinity')
          ? 'genre_affinity'
          : 'preferred_traits+liked_subjects';
        return {
          kind: 'causal', source: 'behavioral_fit',
          text: phrasingForBehavioral(sourceHint),
          scoringRef: { kind, value: sum },
        };
      }
      case 'feedback_fit': {
        if (sum <= 0) {
          suppressed.push(`${kind}:non_positive_aggregate`);
          return null;
        }
        return {
          kind: 'causal', source: 'feedback_fit',
          text: phrasingForFeedback(),
          scoringRef: { kind, value: sum },
        };
      }
      case 'quality_reliability': {
        if (sum <= 0) {
          suppressed.push(`${kind}:non_positive_aggregate`);
          return null;
        }
        // Generic/descriptive only — NEVER causal personal-taste language.
        return {
          kind: 'generic', source: 'quality_reliability',
          text: phrasingForQuality(),
          scoringRef: { kind, value: sum },
        };
      }
      case 'soft_avoid_penalty': {
        if (sum >= 0) return null;
        return {
          kind: 'caution', source: 'soft_avoid_penalty',
          text: phrasingForSoftAvoid(),
          scoringRef: { kind, value: sum },
        };
      }
      case 'hygiene_floor': {
        if (sum >= 0) return null;
        // Surface audit_subflags as evidence (already filtered by P3A-3).
        const subflags = (entries[0]?.evidence as { audit_subflags?: string[] } | undefined)?.audit_subflags ?? [];
        return {
          kind: 'caution', source: 'hygiene_floor',
          text: phrasingForHygiene(subflags),
          evidence: { audit_subflags: subflags },
          scoringRef: { kind, value: sum },
        };
      }
      case 'intent_fit':
      case 'novelty_diversity':
      case 'repetition_suppression':
      // ── P4D-suppressed P4C kinds (still observe-only) ─────────────────
      // These four kinds remain suppressed in this batch:
      //   - current_intent_fit is a paired-coverage signal, not a
      //     standalone book attribute; surfacing it would overclaim.
      //   - complexity_fit's user-side signal is durable-only today;
      //     no current-intent surface exists yet.
      //   - avoidance_conflict + not_right_now_risk are negative-only
      //     and need a dedicated caution surface (not a positive
      //     reason). Held until that surface lands.
      case 'current_intent_fit':
      case 'complexity_fit':
      case 'avoidance_conflict':
      case 'not_right_now_risk':
        suppressed.push(`${kind}:not_yet_emitted`);
        return null;

      // ── P4D-admitted P4C kinds (narrow first pass) ────────────────────
      // Each gate independently enforces: (a) above-floor value (already
      // checked above via DISPLAY_FLOORS), (b) positive aggregate (no
      // mismatch / negative variant slips through as a "reason"),
      // (c) `specific` book confidence (no broad/unknown traits), AND
      // (d) `signedEligible === true` on the underlying contribution
      // evidence (a live session signal — durable chip or session q_* /
      // chip:* source, never legacy alone). Faithfulness rules in
      // replit.md + the P4D spec are enforced here.
      case 'tone_fit': {
        if (sum <= 0) { suppressed.push(`${kind}:non_positive_aggregate`); return null; }
        const ev = entries.find(e => e.value > 0)?.evidence ?? entries[0]?.evidence;
        const conf       = (ev?.bookToneConfidence as string | undefined);
        const eligible   = ev?.signedEligible === true;
        const match      = (ev?.match as string | undefined);
        if (conf !== 'specific' || !eligible || match !== 'match') {
          suppressed.push(`${kind}:gate_failed(conf=${conf},eligible=${eligible},match=${match})`);
          return null;
        }
        return {
          kind: 'causal', source: 'tone_fit',
          text: phrasingForToneFit(ev),
          evidence: ev, scoringRef: { kind, value: sum },
        };
      }
      case 'pace_fit': {
        if (sum <= 0) { suppressed.push(`${kind}:non_positive_aggregate`); return null; }
        const ev = entries.find(e => e.value > 0)?.evidence ?? entries[0]?.evidence;
        const conf     = (ev?.bookPaceConfidence as string | undefined);
        const eligible = ev?.signedEligible === true;
        const match    = (ev?.match as string | undefined);
        if (conf !== 'specific' || !eligible || match !== 'match') {
          suppressed.push(`${kind}:gate_failed(conf=${conf},eligible=${eligible},match=${match})`);
          return null;
        }
        return {
          kind: 'causal', source: 'pace_fit',
          text: phrasingForPaceFit(ev),
          evidence: ev, scoringRef: { kind, value: sum },
        };
      }
      case 'series_continuation_fit': {
        if (sum <= 0) { suppressed.push(`${kind}:non_positive_aggregate`); return null; }
        const ev = entries.find(e => e.value > 0)?.evidence ?? entries[0]?.evidence;
        const priorReadCount = ev?.priorReadCount;
        const continuesPrior = ev?.continuesPrior;
        if (typeof priorReadCount !== 'number' || priorReadCount <= 0
            || continuesPrior !== true) {
          suppressed.push(`${kind}:gate_failed(prior=${priorReadCount},cont=${continuesPrior})`);
          return null;
        }
        return {
          kind: 'causal', source: 'series_continuation_fit',
          text: phrasingForSeriesContinuation(ev),
          evidence: ev, scoringRef: { kind, value: sum },
        };
      }
    }
  }

  // ── Build the four buckets in priority order ──────────────────────────────
  for (const kind of PRIMARY_PRIORITY) {
    const line = lineFor(kind);
    if (line && (line.kind === 'causal' || line.kind === 'generic')) {
      causal.push(line);
      emittedKinds.add(kind);
      causalCoverageKinds.add(kind);
    } else if (line && line.kind === 'caution') {
      cautions.push(line);
      emittedKinds.add(kind);
    }
  }
  // P4D — admit the narrow P4C kinds AFTER the legacy primary three so
  // they fill the secondary slot (cap MAX_SECONDARY=1 still applies
  // below). They become primary only when no PRIMARY_PRIORITY kind
  // cleared its floor (e.g. cold-start user with a strong tone/pace
  // intent on a confident-tone book) — preserves "explanation never
  // empty when an above-floor positive contribution exists".
  for (const kind of SECONDARY_PRIORITY) {
    const line = lineFor(kind);
    if (line && line.kind === 'causal') {
      causal.push(line);
      emittedKinds.add(kind);
      // NOT added to causalCoverageKinds — these kinds do not "cover"
      // a retrieval source (e.g. stated_genre retrieval is still
      // retrieval-only when only tone_fit clears its floor).
    }
  }
  {
    const qLine = lineFor('quality_reliability');
    if (qLine) {
      if (qLine.kind === 'generic') {
        descriptive.push(qLine);
        emittedKinds.add('quality_reliability');
        // quality_reliability is generic-only and never personal-taste —
        // intentionally NOT added to causalCoverageKinds, so it does not
        // suppress retrieval-only audit entries.
      }
    }
  }
  for (const kind of ['soft_avoid_penalty', 'hygiene_floor'] as const) {
    const line = lineFor(kind);
    if (line && line.kind === 'caution') {
      cautions.push(line);
      emittedKinds.add(kind);
    }
  }

  // ── Apply caps ────────────────────────────────────────────────────────────
  const primary    = causal[0];
  const secondary  = causal.slice(1, 1 + MAX_SECONDARY);
  const cappedCaut = cautions.slice(0, MAX_CAUTIONS);
  const cappedDesc = descriptive.slice(0, MAX_DESCRIPTIVE);

  // ── Retrieval-only audit ──────────────────────────────────────────────────
  // A retrieval source is "retrieval-only" when it had no matching scoring
  // contribution above floor that could have produced a causal line. This
  // is the structural proof that a candidate retrieved by
  // `stated_genre:thriller_mystery` but scored with zero stated_taste_fit
  // contribution does NOT emit "based on your thriller preference".
  const retrievalOnly: string[] = [];
  for (const r of bundle.retrieval) {
    // A retrieval source is "covered" only when the corresponding scoring
    // kind actually produced a causal/generic line — NOT when it merely
    // had an above-floor aggregate (which could be a negative caution).
    const couldHaveBeenCausal =
         (r.source === 'statedGenres'    && causalCoverageKinds.has('stated_taste_fit'))
      || (r.source === 'revealedLanes'   && causalCoverageKinds.has('behavioral_fit'))
      || (r.source === 'revealedAuthors' && causalCoverageKinds.has('behavioral_fit'));
    if (!couldHaveBeenCausal) retrievalOnly.push(r.reason);
  }

  return {
    primary,
    secondary,
    cautions: cappedCaut,
    descriptive: cappedDesc,
    debug: {
      emittedKinds:    [...emittedKinds],
      aboveFloorKinds: [...aboveFloorKinds],
      retrievalOnly,
      suppressed,
    },
  };
}

// ── Backward-compat projection (internal / test-only) ────────────────────────
//
// Per D5 (locked decision): RecCard / HomeShortlist / cache-restore paths
// consume `book.reasons[]` directly. P3A-5+ will replace the existing
// reasons[] population with a derived projection from composer output. This
// helper is the SHAPE of that projection — exposed here for the P3A-4
// faithfulness validator to prove the projection is non-breaking. It is
// NOT wired anywhere in production in this batch.
export function deriveBackcompatReasons(out: ExplanationOutput): string[] {
  const lines: ExplanationLine[] = [];
  if (out.primary) lines.push(out.primary);
  for (const s of out.secondary) lines.push(s);
  return lines.map(l => l.text);
}
