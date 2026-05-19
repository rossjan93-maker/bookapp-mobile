// =============================================================================
// scripts/diag_taste_vs_lens_c0_report.ts
//
// DIAGNOSTIC ONLY. Not a validator. Not part of the acceptance loop.
// Does NOT touch product code, ranking, scoring, composer, RecCard, finalGate,
// No-dark, or recValidity. Adds no signal phrases. Reads existing classifier
// outputs and prints a report.
//
// Purpose: produce the taste-vs-lens × C0 observation report against the
// four observed decks for a Mystery/Thriller-favorited test user, using ACTUAL
// `deriveBookEvidence` + `getBookTraits` output (not predicted labels).
//
// Inputs: 10 hand-curated `BookEvidenceInput` fixtures based on the public
// metadata for the observed titles (subjects + description). Inputs are
// curated; CLASSIFIER OUTPUTS ARE REAL — that's the point of this report.
// A future live-data run (Supabase fetch by title) would supersede the
// fixture inputs; the classifier call shape stays identical.
//
// Run:
//   npx tsx scripts/diag_taste_vs_lens_c0_report.ts > docs/diag_taste_vs_lens_c0_report.md
//
// =============================================================================

import { deriveBookEvidence } from '../lib/evidence/bookEvidence';
import { getBookTraits } from '../lib/bookTraits';
import {
  emptyIntent,
  evaluateBookAgainstIntentLens,
  type NextReadIntent,
} from '../lib/nextReadIntent';
import type { MarketPosition } from '../lib/fitClassifier';

// ── Fixture: Mystery/Thriller user's observed decks ──────────────────────────
// Each fixture carries:
//   - bibliographic identifiers (title, author) — display only
//   - classifier inputs (subjects, description, page_count) — curated from
//     public OL/GBooks metadata snippets, NOT live-fetched
//   - market_position — assigned per fitClassifier.ts taxonomy, display + the
//     `evaluateBookAgainstIntentLens` market_position-only exclusion gate
//   - durableTasteFit — the user-side judgment: does Mystery/Thriller pick this?
//
// Title-specific judgments here are DIAGNOSTIC FIXTURES, not product logic.

type Fixture = {
  title:           string;
  author:          string;
  subjects:        string[];
  description:     string;
  page_count:      number | null;
  market_position: MarketPosition;
  durableTasteFit: 'core' | 'adjacent' | 'off_lane';
};

const FIXTURES: Fixture[] = [
  // ── Baseline / Fast-paced decks ────────────────────────────────────────────
  {
    title:  'Sometimes I Lie',
    author: 'Alice Feeney',
    subjects: ['psychological thriller', 'thriller', 'suspense', 'mystery', 'fiction'],
    description: 'My name is Amber Reynolds. There are three things you should know about me. 1. I\'m in a coma. 2. My husband doesn\'t love me anymore. 3. Sometimes I lie. A page-turner with a propulsive, taut narrative voice.',
    page_count:      288,
    market_position: 'domestic_suspense',
    durableTasteFit: 'core',
  },
  {
    title:  'Verity',
    author: 'Colleen Hoover',
    subjects: ['romantic suspense', 'thriller', 'psychological thriller', 'fiction'],
    description: 'Lowen Ashleigh accepts the job offer of a lifetime: to complete the remaining books of a successful injured author, Verity Crawford. What she discovers — a marriage in crisis, dark family secrets, and a disturbing manuscript — leaves her breathless.',
    page_count:      336,
    market_position: 'domestic_suspense',
    durableTasteFit: 'core',
  },
  {
    title:  'The Perfect Marriage',
    author: 'Jeneva Rose',
    subjects: ['legal thriller', 'thriller', 'mystery', 'suspense'],
    description: 'Sarah Morgan is a successful and powerful defense attorney. When her husband is accused of murder, she must defend him. A taut legal thriller about a marriage in crisis.',
    page_count:      304,
    market_position: 'domestic_suspense',
    durableTasteFit: 'core',
  },
  {
    title:  'Never Lie',
    author: 'Freida McFadden',
    subjects: ['psychological thriller', 'thriller', 'mystery', 'suspense'],
    description: 'A young married couple is stranded at a remote mansion. They uncover audio tapes from a disappeared psychiatrist. A relentlessly paced page-turner.',
    page_count:      304,
    market_position: 'domestic_suspense',
    durableTasteFit: 'core',
  },

  // ── Light & accessible deck ────────────────────────────────────────────────
  {
    title:  'The Thursday Murder Club',
    author: 'Richard Osman',
    subjects: ['cozy mystery', 'mystery', 'fiction', 'humor'],
    description: 'In a peaceful retirement village, four unlikely friends meet weekly to investigate cold cases. When a brutal killing takes place on their doorstep, the Thursday Murder Club find themselves in the middle of their first live case. A feel-good, gentle, cozy mystery.',
    page_count:      400,
    market_position: 'cozy_detective',
    durableTasteFit: 'core',
  },
  {
    title:  'Gone Girl',
    author: 'Gillian Flynn',
    subjects: ['psychological thriller', 'thriller', 'mystery', 'suspense', 'noir'],
    description: 'On the morning of their fifth wedding anniversary, Nick Dunne\'s wife Amy disappears. A marriage in crisis becomes a taut, propulsive descent into deception and betrayal.',
    page_count:      432,
    market_position: 'domestic_suspense',
    durableTasteFit: 'core',
  },
  {
    title:  'Everything I Never Told You',
    author: 'Celeste Ng',
    subjects: ['literary fiction', 'family secrets', 'family saga', 'coming of age', 'fiction'],
    description: 'Lydia is dead. But they don\'t know this yet. A quiet, understated meditation on family secrets, grief and loss, intergenerational trauma, and the immigrant experience in 1970s Ohio.',
    page_count:      297,
    market_position: 'literary_prestige',
    durableTasteFit: 'adjacent',
  },
  {
    title:  'The Silent Patient',
    author: 'Alex Michaelides',
    subjects: ['psychological thriller', 'thriller', 'mystery', 'suspense'],
    description: 'Alicia Berenson shoots her husband five times and then never speaks again. Theo Faber is the criminal psychotherapist determined to make her talk. A pulse-pounding, page-turner of a psychological thriller.',
    page_count:      323,
    market_position: 'domestic_suspense',
    durableTasteFit: 'core',
  },

  // ── Short & light + No dark deck ───────────────────────────────────────────
  {
    title:  'The Maid',
    author: 'Nita Prose',
    subjects: ['cozy mystery', 'mystery', 'fiction'],
    description: 'Molly Gray is a hotel maid who finds a wealthy guest dead in his bed. A feel-good, gentle, cozy mystery with quirky charm and a quiet warmth.',
    page_count:      304,
    market_position: 'cozy_detective',
    durableTasteFit: 'core',
  },
  {
    title:  'In Love',
    author: 'Amy Bloom',
    subjects: ['memoir', 'biography', 'nonfiction'],
    description: 'A memoir of loss. Amy Bloom\'s husband Brian was diagnosed with early-onset Alzheimer\'s. This is a quiet meditation on mortality, grief and loss, marriage in crisis, and the choice to die well. Understated, gentle prose.',
    page_count:      240,
    market_position: 'memoir_nonfiction',
    durableTasteFit: 'off_lane',
  },
];

// ── Lens fixtures ────────────────────────────────────────────────────────────
// These mirror what `handleApplyIntent` produces in the app for each visible
// lens chip. No new lens shapes invented.

function lensBaseline(): NextReadIntent {
  return emptyIntent();
}
function lensLightFun(): NextReadIntent {
  const i = emptyIntent();
  i.soft.tone          = 'light';
  i.soft.readingEnergy = 'light_fun';
  return i;
}
function lensFastPaced(): NextReadIntent {
  const i = emptyIntent();
  i.soft.pace          = 'fast';
  i.soft.readingEnergy = 'immersive';
  return i;
}
function lensShortLightPlusNoDark(): NextReadIntent {
  const i = emptyIntent();
  i.soft.tone          = 'light';
  i.soft.readingEnergy = 'palate_cleanser';
  i.hard.max_page_count = 300;
  i.exclude.avoid_dark  = true;
  return i;
}
function lensLessDark(): NextReadIntent {
  const i = emptyIntent();
  i.soft.intensity = 'low';
  return i;
}

type LensSpec = { key: string; label: string; intent: NextReadIntent };
const LENSES: LensSpec[] = [
  { key: 'baseline',    label: 'Baseline / no lens',         intent: lensBaseline() },
  { key: 'light_fun',   label: 'Light & accessible',         intent: lensLightFun() },
  { key: 'fast_paced',  label: 'Fast-paced / immersive',     intent: lensFastPaced() },
  { key: 'short_light', label: 'Short & light + No dark',    intent: lensShortLightPlusNoDark() },
  { key: 'less_dark',   label: 'Less dark',                  intent: lensLessDark() },
];

// ── Per-book × per-lens evaluation ───────────────────────────────────────────

type Row = {
  title:                  string;
  author:                 string;
  lensKey:                string;
  lensLabel:              string;
  durableTasteFit:        Fixture['durableTasteFit'];
  marketPosition:         MarketPosition;
  tone:                   string;
  toneConfidence:         string;
  pace:                   string;
  paceConfidence:         string;
  complexity:             string;
  complexityConfidence:   string;
  intensityBucket:        string;
  intensityFirstPhrase:   string;
  emotionalWeightBucket:  string;
  emotionalWeightPhrase:  string;
  finalGateHardExclude:   boolean;
  hardReasons:            string[];
  softDemotions:          string[];
  lensFitVerdict:         'match' | 'neutral' | 'mismatch';
  mismatchTasteVsLens:    boolean;
  issueType:              string;
};

function bucketFromAxisMatch(hi: { specificCount: number; broadCount: number }, lo: { specificCount: number; broadCount: number }): { bucket: string; firstPhrase: string } {
  // Projection rule identical to the [BOOK_EVIDENCE_C] DEV log + intensity validator:
  //   spec≥1 → spec; broad≥2 → broad; conflicting strong both poles → medium/broad;
  //   else unknown.
  const hiStrong = hi.specificCount >= 1 || hi.broadCount >= 2;
  const loStrong = lo.specificCount >= 1 || lo.broadCount >= 2;
  if (hiStrong && loStrong) return { bucket: 'medium', firstPhrase: '<conflicting>' };
  if (hiStrong) {
    const spec = hi.specificCount >= 1;
    return { bucket: spec ? 'high/spec' : 'high/broad', firstPhrase: (spec ? '' : '') + ((hi as any).firstSpecific || (hi as any).firstBroad || '') };
  }
  if (loStrong) {
    const spec = lo.specificCount >= 1;
    return { bucket: spec ? 'low/spec' : 'low/broad', firstPhrase: (spec ? '' : '') + ((lo as any).firstSpecific || (lo as any).firstBroad || '') };
  }
  return { bucket: 'unknown', firstPhrase: '' };
}

function classifyLensFit(
  lensKey:    string,
  tone:       string,
  pace:       string,
  intensityBucket:      string,
  emotionalWeightBucket: string,
): 'match' | 'neutral' | 'mismatch' {
  if (lensKey === 'baseline')    return 'neutral';
  if (lensKey === 'light_fun') {
    if (tone === 'light')        return 'match';
    if (tone === 'dark')         return 'mismatch';
    if (emotionalWeightBucket.startsWith('high')) return 'mismatch';
    return 'neutral';
  }
  if (lensKey === 'fast_paced') {
    if (pace === 'fast')         return 'match';
    if (pace === 'slow')         return 'mismatch';
    return 'neutral';
  }
  if (lensKey === 'short_light') {
    if (tone === 'dark')         return 'mismatch';
    if (emotionalWeightBucket.startsWith('high')) return 'mismatch';
    if (tone === 'light' && intensityBucket.startsWith('low')) return 'match';
    return 'neutral';
  }
  if (lensKey === 'less_dark') {
    if (intensityBucket.startsWith('low'))  return 'match';
    if (intensityBucket.startsWith('high')) return 'mismatch';
    if (tone === 'dark')                    return 'mismatch';
    return 'neutral';
  }
  return 'neutral';
}

function classifyIssue(
  lensKey:             string,
  durableTasteFit:     Fixture['durableTasteFit'],
  lensFitVerdict:      'match' | 'neutral' | 'mismatch',
  finalGateHardExclude: boolean,
  intensityBucket:     string,
  emotionalWeightBucket: string,
  tone:                string,
  toneConfidence:      string,
): string {
  if (lensKey === 'baseline') return 'n/a';
  if (lensFitVerdict === 'match') return 'none';
  if (finalGateHardExclude)       return 'finalGate-excluded (cannot reach deck)';

  // Lens-mismatch but in deck. Diagnose:
  const tasteWantsIt = durableTasteFit === 'core';
  const classifierSawWeight = emotionalWeightBucket.startsWith('high');
  const classifierSawDarkTone = tone === 'dark' && toneConfidence === 'specific';

  if (lensFitVerdict === 'mismatch' && tasteWantsIt) {
    if (classifierSawWeight || classifierSawDarkTone) {
      return 'classifier correct but not used (ranking arbitration: taste overpowers lens)';
    }
    // Classifier didn't catch — but did the user-visible reason still make sense?
    if (intensityBucket === 'unknown' && emotionalWeightBucket === 'unknown') {
      return 'classifier underfiring (metadata/corpus gap or signal-set gap)';
    }
    return 'classifier partial + ranking arbitration';
  }
  if (lensFitVerdict === 'mismatch' && !tasteWantsIt) {
    // Lens-mismatch book that taste did NOT pick — it was promoted by adjacency / lane logic.
    // The lens should have demoted it; failure mode is UI-semantics-adjacent.
    return 'UI semantics underdefined (lens does not override adjacent-lane promotion)';
  }
  if (lensFitVerdict === 'neutral') return 'inconclusive (lens neutral on this book)';
  return 'inconclusive';
}

// ── Run ──────────────────────────────────────────────────────────────────────

const rows: Row[] = [];

for (const lens of LENSES) {
  for (const fx of FIXTURES) {
    const evidence = deriveBookEvidence({
      subjects:    fx.subjects,
      title:       fx.title,
      description: fx.description,
      page_count:  fx.page_count,
    });
    const traits = getBookTraits({
      subjects:    fx.subjects,
      title:       fx.title,
      author:      fx.author,
      description: fx.description,
      page_count:  fx.page_count,
    });
    const intensity = bucketFromAxisMatch(evidence.intensityHigh, evidence.intensityLow);
    const weight    = bucketFromAxisMatch(evidence.emotionalWeightHigh, evidence.emotionalWeightLow);
    const verdict   = evaluateBookAgainstIntentLens(
      { subjects: fx.subjects, title: fx.title, description: fx.description },
      lens.intent,
      fx.market_position,
    );
    const lensFitVerdict = classifyLensFit(
      lens.key,
      traits.tone ?? 'balanced',
      traits.pace ?? 'medium',
      intensity.bucket,
      weight.bucket,
    );
    const finalGateHardExclude = verdict.hardExclusions.length > 0;
    const hardReasons   = verdict.hardExclusions.map(h => h.reason);
    const softDemotions = verdict.softDemotions.map(s => s.reason);
    const mismatchTasteVsLens = (fx.durableTasteFit === 'core') && (lensFitVerdict === 'mismatch') && (lens.key !== 'baseline');
    const issueType = classifyIssue(
      lens.key,
      fx.durableTasteFit,
      lensFitVerdict,
      finalGateHardExclude,
      intensity.bucket,
      weight.bucket,
      traits.tone ?? 'balanced',
      traits.toneConfidence ?? 'unknown',
    );

    rows.push({
      title:                 fx.title,
      author:                fx.author,
      lensKey:               lens.key,
      lensLabel:             lens.label,
      durableTasteFit:       fx.durableTasteFit,
      marketPosition:        fx.market_position,
      tone:                  traits.tone ?? 'balanced',
      toneConfidence:        traits.toneConfidence ?? 'unknown',
      pace:                  traits.pace ?? 'medium',
      paceConfidence:        traits.paceConfidence ?? 'unknown',
      complexity:            traits.complexity ?? 'medium',
      complexityConfidence:  traits.complexityConfidence ?? 'unknown',
      intensityBucket:       intensity.bucket,
      intensityFirstPhrase:  intensity.firstPhrase,
      emotionalWeightBucket: weight.bucket,
      emotionalWeightPhrase: weight.firstPhrase,
      finalGateHardExclude,
      hardReasons,
      softDemotions,
      lensFitVerdict,
      mismatchTasteVsLens,
      issueType,
    });
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

function md(s: string) { return s.replace(/\|/g, '\\|'); }

const header = `# Diagnostic Report — Taste-vs-Lens × BookEvidence C0 (actual classifier output)

**Generated by:** \`scripts/diag_taste_vs_lens_c0_report.ts\` (diagnostic-only; no product code change).
**Scope:** ${FIXTURES.length} hand-curated \`BookEvidenceInput\` fixtures × ${LENSES.length} lens fixtures = ${rows.length} per-book × per-lens evaluations.
**Inputs:** \`subjects\` and \`description\` curated from public OL/GBooks metadata snippets for each title (titles are diagnostic fixtures, not product logic).
**Outputs (the load-bearing columns):** \`deriveBookEvidence(...)\` + \`getBookTraits(...)\` + \`evaluateBookAgainstIntentLens(...)\` — these are **real classifier outputs**, not predicted labels.
**Hard constraints honored:** no product code touched, no ranking/scoring/composer/RecCard/finalGate/No-dark change, no signal-list additions, no \`recValidity.VERSION\` bump.

`;

let body = '';
for (const lens of LENSES) {
  body += `## Lens: ${lens.label} (\`${lens.key}\`)\n\n`;
  body += `| Title | Author | Market pos | Durable taste | Tone / conf | Pace / conf | Complexity / conf | Intensity (bucket / phrase) | Emotional weight (bucket / phrase) | Lens fit | finalGate hard exclude? | Hard reasons | Soft demotions | Taste-fit but lens-mismatch? | Issue type |\n`;
  body += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  const lensRows = rows.filter(r => r.lensKey === lens.key);
  for (const r of lensRows) {
    body += `| ${md(r.title)} | ${md(r.author)} | ${r.marketPosition} | ${r.durableTasteFit} | ${r.tone} / ${r.toneConfidence} | ${r.pace} / ${r.paceConfidence} | ${r.complexity} / ${r.complexityConfidence} | ${r.intensityBucket} ${r.intensityFirstPhrase ? `(${md(r.intensityFirstPhrase)})` : ''} | ${r.emotionalWeightBucket} ${r.emotionalWeightPhrase ? `(${md(r.emotionalWeightPhrase)})` : ''} | ${r.lensFitVerdict} | ${r.finalGateHardExclude ? 'YES' : 'no'} | ${r.hardReasons.join(', ') || '—'} | ${r.softDemotions.join(', ') || '—'} | ${r.mismatchTasteVsLens ? 'YES' : 'no'} | ${md(r.issueType)} |\n`;
  }
  // Per-lens summary
  const total       = lensRows.length;
  const matches     = lensRows.filter(r => r.lensFitVerdict === 'match').length;
  const mismatches  = lensRows.filter(r => r.lensFitVerdict === 'mismatch').length;
  const tasteFitMismatches = lensRows.filter(r => r.mismatchTasteVsLens).length;
  const hardExcluded       = lensRows.filter(r => r.finalGateHardExclude).length;
  body += `\n**Lens summary:** ${matches}/${total} match · ${mismatches}/${total} mismatch · ${tasteFitMismatches}/${total} **taste-fit-but-lens-mismatch** · ${hardExcluded}/${total} hard-excluded by finalGate.\n\n`;
}

// ── Overall %s ──
const nonBaseline = rows.filter(r => r.lensKey !== 'baseline');
const nbTotal     = nonBaseline.length;
const nbMismatch  = nonBaseline.filter(r => r.mismatchTasteVsLens).length;
const pct         = nbTotal === 0 ? 0 : (100 * nbMismatch / nbTotal);

// Classifier accuracy assessment: in the cases the user would call "wrong",
// did C0 + tone classifier provide *some* usable evidence?
const wrongCases   = nonBaseline.filter(r => r.mismatchTasteVsLens);
const classifierCaught = wrongCases.filter(r =>
  r.emotionalWeightBucket.startsWith('high')
  || (r.tone === 'dark' && r.toneConfidence === 'specific')
).length;
const catchRate    = wrongCases.length === 0 ? 0 : (100 * classifierCaught / wrongCases.length);

const overall = `## Overall metrics

- **Total per-book × per-lens evaluations:** ${rows.length}
- **Non-baseline evaluations:** ${nbTotal}
- **Taste-fit-but-lens-mismatch rate (non-baseline):** ${nbMismatch}/${nbTotal} = **${pct.toFixed(1)}%**
- **Classifier catch rate on the mismatched set:** ${classifierCaught}/${wrongCases.length} = **${catchRate.toFixed(1)}%**
  (How often did C0 \`emotionalWeight=high\` OR tone \`dark/specific\` *correctly flag* a book the user-side judgment marked as lens-mismatch? Higher = classifier is doing its job; lower = signal-list calibration gap.)

`;

process.stdout.write(header + body + overall);
