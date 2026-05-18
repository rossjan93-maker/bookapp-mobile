// lib/evidence/bookEvidence.ts
// ─────────────────────────────────────────────────────────────────────────────
// BookEvidence Batch B (P4 hygiene) — typed book-side evidence layer.
//
// `deriveBookEvidence(book)` is the sole classifier entry point. It builds the
// canonical corpora (semantic + surface) once, runs every signal axis against
// them once, and returns a frozen, observational evidence object that:
//
//   • `getBookTraits` (via classifyXFromEvidence projections) consumes to
//     produce typed BookTraits — byte-identical to the previous behavior.
//   • `evaluateBookAgainstIntentLens` consumes to produce the No-dark verdict
//     — byte-identical IntentEligibilityVerdict shape and evidence strings.
//
// Out of scope (Batch C territory):
//   • intensity / emotionalWeight axes
//   • length / form / genre (handled upstream by detectBookForm / detectGenre /
//     classifyLength — not evidence-graph members)
//   • numeric scoring or normalization
// ─────────────────────────────────────────────────────────────────────────────

import {
  TONE_DARK, TONE_LIGHT,
  PACE_FAST, PACE_SLOW,
  COMPLEXITY_ACCESSIBLE, COMPLEXITY_LITERARY, COMPLEXITY_DENSE,
  DARK_SIGNALS, DOMESTIC_SUSPENSE_SUPPORT_SIGNALS,
  countMatchesDetailed,
  firstSignalMatch,
} from './signals';

export type BookEvidenceInput = {
  subjects?:    string[] | null;
  title?:       string   | null;
  description?: string   | null;
  page_count?:  number   | null;
};

export type AxisMatch = {
  readonly specificCount:  number;
  readonly broadCount:     number;
  readonly firstSpecific:  string | null;
  readonly firstBroad:     string | null;
};

export type PhraseMatch = {
  readonly phrase:  string | null;
  readonly matched: boolean;
};

export type BookEvidence = {
  readonly input: {
    readonly subjects:    readonly string[];
    readonly title:       string;
    readonly description: string;
    readonly pageCount:   number | null;
  };

  // Canonical corpora. Both pre-built once per book.
  //   semantic — `${subjects.join(' ')} ${description}` (matches the prior
  //              `buildSemanticCorpus` in lib/bookTraits.ts). NOT lowercased
  //              at build time; matchers are case-insensitive.
  //   surface  — `[...subjects, title].join(' ').toLowerCase()` (matches the
  //              prior `buildCorpus` in lib/nextReadIntent.ts).
  readonly corpus: {
    readonly semantic: string;
    readonly surface:  string;
  };

  // Per-axis match counts (computed against the SEMANTIC corpus — matches
  // the prior trait-classifier consumption).
  readonly toneDark:             AxisMatch;
  readonly toneLight:            AxisMatch;
  readonly paceFast:             AxisMatch;
  readonly paceSlow:             AxisMatch;
  readonly complexityAccessible: AxisMatch;
  readonly complexityLiterary:   AxisMatch;
  readonly complexityDense:      AxisMatch;

  // No-dark hard-exclusion evidence (curated DARK_SIGNALS, computed against
  // the SURFACE corpus — matches the prior `evaluateBookAgainstIntentLens`
  // consumption).
  readonly darkPhrasal: PhraseMatch;

  // Same DARK_SIGNALS pass but against the SEMANTIC corpus. Stored for
  // Batch C / shadow-mode calibration; NOT consumed by any runtime today.
  readonly darkPhrasalSemantic: PhraseMatch;

  // Domestic-suspense market-position coupled rule support phrase
  // (computed against the SURFACE corpus — matches the prior consumption).
  readonly domesticSuspenseSupport: PhraseMatch;
};

function buildSemanticCorpus(subjects: readonly string[], description: string): string {
  return `${subjects.join(' ')} ${description}`;
}

function buildSurfaceCorpus(subjects: readonly string[], title: string): string {
  return [...subjects, title].join(' ').toLowerCase();
}

function axisMatch(corpus: string, set: Parameters<typeof countMatchesDetailed>[1]): AxisMatch {
  const r = countMatchesDetailed(corpus, set);
  return Object.freeze({
    specificCount: r.specificCount,
    broadCount:    r.broadCount,
    firstSpecific: r.firstSpecific,
    firstBroad:    r.firstBroad,
  });
}

function phraseMatch(corpus: string, set: Parameters<typeof firstSignalMatch>[1]): PhraseMatch {
  const phrase = firstSignalMatch(corpus, set);
  return Object.freeze({ phrase, matched: phrase !== null });
}

/**
 * Build the canonical BookEvidence object for `book`. Pure function —
 * deterministic, no module state, safe to call repeatedly. The returned
 * object (and its nested objects) is frozen.
 */
export function deriveBookEvidence(book: BookEvidenceInput | null | undefined): BookEvidence {
  const subjects    = Object.freeze([...((book?.subjects ?? []))]);
  const title       = book?.title       ?? '';
  const description = book?.description ?? '';
  const pageCount   = book?.page_count ?? null;

  const semantic = buildSemanticCorpus(subjects, description);
  const surface  = buildSurfaceCorpus(subjects, title);

  return Object.freeze({
    input: Object.freeze({
      subjects,
      title,
      description,
      pageCount,
    }),
    corpus: Object.freeze({ semantic, surface }),

    toneDark:             axisMatch(semantic, TONE_DARK),
    toneLight:            axisMatch(semantic, TONE_LIGHT),
    paceFast:             axisMatch(semantic, PACE_FAST),
    paceSlow:             axisMatch(semantic, PACE_SLOW),
    complexityAccessible: axisMatch(semantic, COMPLEXITY_ACCESSIBLE),
    complexityLiterary:   axisMatch(semantic, COMPLEXITY_LITERARY),
    complexityDense:      axisMatch(semantic, COMPLEXITY_DENSE),

    darkPhrasal:             phraseMatch(surface,  DARK_SIGNALS),
    darkPhrasalSemantic:     phraseMatch(semantic, DARK_SIGNALS),
    domesticSuspenseSupport: phraseMatch(surface,  DOMESTIC_SUSPENSE_SUPPORT_SIGNALS),
  });
}
