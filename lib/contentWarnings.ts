// =============================================================================
// Content Warnings — subject (and optional description) → warning mapping
// =============================================================================
// Maps Open Library subjects (and, when available, the book description) to
// normalised warning labels. The taxonomy is two-tier:
//
//   • Specific labels   — narrow, evidence-backed (e.g. "Sexual violence",
//     "War violence", "Self-harm", "Addiction"). Rendered as direct labels.
//   • Broad labels      — fall-backs when evidence is weak or generic
//     (e.g. "Violence", "Sexual content", "Mental health themes").
//     Rendered with softer "may include" copy.
//
// Confidence rules:
//   • Specific patterns matched in subjects   → 'specific'
//   • Broad   patterns matched in subjects    → 'specific'
//                                               (subjects are curated tags;
//                                                presence is reliable evidence)
//   • Patterns matched only in the description → 'broad'
//                                               (description prose is noisier)
//
// Matching uses word-boundary regex to avoid false positives ("war" must not
// match "award"). Multi-word patterns are matched as whole phrases.
//
// Conservative by design: only patterns that clearly signal sensitive content
// are included. Generic genre terms ("fiction", "fantasy") never map.
// =============================================================================

export type WarningConfidence = 'specific' | 'broad';

export type ContentWarning = {
  /** Human-readable warning label. */
  label:      string;
  /** filterKey is stable across versions; safe for user filter persistence. */
  filterKey:  string;
  /** 'specific' = direct evidence; 'broad' = render with softening copy. */
  confidence: WarningConfidence;
  /** Family/parent broad warning (e.g. 'Violence' for 'Graphic violence').
   *  Used to suppress the broad label when a more specific one is present. */
  parent?:    string;
};

// Severity-ordered display order for the broad/parent labels.
// Specific sub-labels render under their parent's section in this same order.
const PARENT_ORDER = [
  'violence',
  'death_grief',
  'sexual_content',
  'substance_use',
  'mental_health',
  'animal_harm',
  'abuse_trauma',
  'eating_disorders',
  'child_harm',
] as const;

// =============================================================================
// Pattern taxonomy
// Each entry: pattern → { filterKey, label, parent? }
// `parent` indicates a specific sub-label within a broader family.
// =============================================================================

type PatternRule = {
  pattern: string;
  filterKey: string;
  label:    string;
  parent?:  string;
};

const SUBJECT_RULES: PatternRule[] = [
  // ── Violence (broad + specifics) ──────────────────────────────────────────
  { pattern: 'violence',           filterKey: 'violence',          label: 'Violence' },
  { pattern: 'brutality',          filterKey: 'violence',          label: 'Violence' },

  { pattern: 'graphic violence',   filterKey: 'violence_graphic',  label: 'Graphic violence', parent: 'violence' },
  { pattern: 'gore',               filterKey: 'violence_graphic',  label: 'Graphic violence', parent: 'violence' },
  { pattern: 'gory',               filterKey: 'violence_graphic',  label: 'Graphic violence', parent: 'violence' },
  { pattern: 'torture',            filterKey: 'violence_graphic',  label: 'Graphic violence', parent: 'violence' },

  { pattern: 'war',                filterKey: 'violence_war',      label: 'War violence',     parent: 'violence' },
  { pattern: 'battle',             filterKey: 'violence_war',      label: 'War violence',     parent: 'violence' },
  { pattern: 'combat',             filterKey: 'violence_war',      label: 'War violence',     parent: 'violence' },
  { pattern: 'genocide',           filterKey: 'violence_war',      label: 'War violence',     parent: 'violence' },
  { pattern: 'warfare',            filterKey: 'violence_war',      label: 'War violence',     parent: 'violence' },

  { pattern: 'murder',             filterKey: 'violence_murder',   label: 'Murder',           parent: 'violence' },
  { pattern: 'assassination',      filterKey: 'violence_murder',   label: 'Murder',           parent: 'violence' },
  { pattern: 'serial killer',      filterKey: 'violence_murder',   label: 'Murder',           parent: 'violence' },
  { pattern: 'terrorism',          filterKey: 'violence_murder',   label: 'Murder',           parent: 'violence' },

  // ── Death & grief (broad + specifics) ─────────────────────────────────────
  { pattern: 'death',              filterKey: 'death_grief',       label: 'Death & grief' },
  { pattern: 'mourning',           filterKey: 'death_grief',       label: 'Death & grief' },
  { pattern: 'bereavement',        filterKey: 'death_grief',       label: 'Death & grief' },
  { pattern: 'terminal illness',   filterKey: 'death_grief',       label: 'Death & grief' },
  { pattern: 'euthanasia',         filterKey: 'death_grief',       label: 'Death & grief' },

  { pattern: 'grief',              filterKey: 'death_grief_grief', label: 'Grief',            parent: 'death_grief' },
  { pattern: 'loss of a loved',    filterKey: 'death_grief_grief', label: 'Grief',            parent: 'death_grief' },

  { pattern: 'suicide',            filterKey: 'mental_health_suicide', label: 'Suicide',     parent: 'mental_health' },

  // ── Sexual content (broad + specifics) ────────────────────────────────────
  { pattern: 'sexual content',     filterKey: 'sexual_content',    label: 'Sexual content' },
  { pattern: 'erotic',             filterKey: 'sexual_content',    label: 'Sexual content' },
  { pattern: 'erotica',            filterKey: 'sexual_content',    label: 'Sexual content' },
  { pattern: 'pornography',        filterKey: 'sexual_content',    label: 'Sexual content' },
  { pattern: 'pornographic',       filterKey: 'sexual_content',    label: 'Sexual content' },

  { pattern: 'sexual violence',    filterKey: 'sexual_violence',   label: 'Sexual violence',  parent: 'sexual_content' },
  { pattern: 'sexual assault',     filterKey: 'sexual_violence',   label: 'Sexual violence',  parent: 'sexual_content' },
  { pattern: 'sexual abuse',       filterKey: 'sexual_violence',   label: 'Sexual violence',  parent: 'sexual_content' },
  { pattern: 'rape',               filterKey: 'sexual_violence',   label: 'Sexual violence',  parent: 'sexual_content' },

  // ── Substance use (broad + specifics) ─────────────────────────────────────
  { pattern: 'substance abuse',    filterKey: 'substance_use',     label: 'Substance use' },
  { pattern: 'narcotics',          filterKey: 'substance_use',     label: 'Substance use' },

  { pattern: 'addiction',          filterKey: 'substance_addiction', label: 'Addiction',     parent: 'substance_use' },
  { pattern: 'drug abuse',         filterKey: 'substance_addiction', label: 'Addiction',     parent: 'substance_use' },
  { pattern: 'drug addiction',     filterKey: 'substance_addiction', label: 'Addiction',     parent: 'substance_use' },
  { pattern: 'alcoholism',         filterKey: 'substance_addiction', label: 'Addiction',     parent: 'substance_use' },

  // ── Mental health (broad + specifics) ─────────────────────────────────────
  { pattern: 'mental health',      filterKey: 'mental_health',     label: 'Mental health themes' },
  { pattern: 'mental illness',     filterKey: 'mental_health',     label: 'Mental health themes' },
  { pattern: 'depression',         filterKey: 'mental_health',     label: 'Mental health themes' },
  { pattern: 'psychiatric',        filterKey: 'mental_health',     label: 'Mental health themes' },
  { pattern: 'psychosis',          filterKey: 'mental_health',     label: 'Mental health themes' },
  { pattern: 'schizophrenia',      filterKey: 'mental_health',     label: 'Mental health themes' },

  { pattern: 'self-harm',          filterKey: 'mental_health_selfharm', label: 'Self-harm',  parent: 'mental_health' },
  { pattern: 'self harm',          filterKey: 'mental_health_selfharm', label: 'Self-harm',  parent: 'mental_health' },

  { pattern: 'ptsd',               filterKey: 'mental_health_ptsd', label: 'PTSD',           parent: 'mental_health' },
  { pattern: 'post-traumatic',     filterKey: 'mental_health_ptsd', label: 'PTSD',           parent: 'mental_health' },

  // ── Animal harm ───────────────────────────────────────────────────────────
  { pattern: 'animal cruelty',     filterKey: 'animal_harm',       label: 'Animal harm' },
  { pattern: 'animal abuse',       filterKey: 'animal_harm',       label: 'Animal harm' },
  { pattern: 'animal harm',        filterKey: 'animal_harm',       label: 'Animal harm' },
  { pattern: 'vivisection',        filterKey: 'animal_harm',       label: 'Animal harm' },

  // ── Abuse & trauma (broad + specifics) ────────────────────────────────────
  { pattern: 'trauma',             filterKey: 'abuse_trauma',      label: 'Abuse & trauma' },
  { pattern: 'human trafficking',  filterKey: 'abuse_trauma',      label: 'Abuse & trauma' },
  { pattern: 'slavery',            filterKey: 'abuse_trauma',      label: 'Abuse & trauma' },
  { pattern: 'kidnapping',         filterKey: 'abuse_trauma',      label: 'Abuse & trauma' },
  { pattern: 'abduction',          filterKey: 'abuse_trauma',      label: 'Abuse & trauma' },

  { pattern: 'domestic abuse',     filterKey: 'abuse_domestic',    label: 'Domestic abuse',   parent: 'abuse_trauma' },
  { pattern: 'domestic violence',  filterKey: 'abuse_domestic',    label: 'Domestic abuse',   parent: 'abuse_trauma' },
  { pattern: 'emotional abuse',    filterKey: 'abuse_emotional',   label: 'Emotional abuse',  parent: 'abuse_trauma' },

  // ── Eating disorders ──────────────────────────────────────────────────────
  { pattern: 'eating disorder',    filterKey: 'eating_disorders',  label: 'Eating disorders' },
  { pattern: 'anorexia',           filterKey: 'eating_disorders',  label: 'Eating disorders' },
  { pattern: 'bulimia',            filterKey: 'eating_disorders',  label: 'Eating disorders' },

  // ── Child harm (broad + specifics) ────────────────────────────────────────
  { pattern: 'child abuse',        filterKey: 'child_abuse',       label: 'Child abuse',      parent: 'child_harm' },
  { pattern: 'child molestation',  filterKey: 'child_abuse',       label: 'Child abuse',      parent: 'child_harm' },
  { pattern: 'pedophilia',         filterKey: 'child_abuse',       label: 'Child abuse',      parent: 'child_harm' },

  { pattern: 'child death',        filterKey: 'child_death',       label: 'Child death',      parent: 'child_harm' },
];

// Family-level (broad parent) labels per filterKey. Description-only matches
// are intentionally downgraded to the broad parent — narrative prose is too
// noisy to assert a *specific* sub-label like "Sexual violence" from a single
// matched phrase. Subject-tag evidence is required for specific sub-labels.
const PARENT_LABELS: Record<string, { filterKey: string; label: string }> = {
  violence:         { filterKey: 'violence',         label: 'Violence'              },
  death_grief:      { filterKey: 'death_grief',      label: 'Death & grief'         },
  sexual_content:   { filterKey: 'sexual_content',   label: 'Sexual content'        },
  substance_use:    { filterKey: 'substance_use',    label: 'Substance use'         },
  mental_health:    { filterKey: 'mental_health',    label: 'Mental health themes'  },
  abuse_trauma:     { filterKey: 'abuse_trauma',     label: 'Abuse & trauma'        },
  eating_disorders: { filterKey: 'eating_disorders', label: 'Eating disorders'      },
  child_harm:       { filterKey: 'child_harm',       label: 'Child harm'            },
};

// Description-only patterns are restricted to a small set of clearly-signalling
// phrases. The description is prose, so:
//   • confidence is downgraded to 'broad', AND
//   • specific sub-label rules are *rewritten* to emit their parent's label
//     (e.g. "rape" in description → "Sexual content (broad)", not
//      "Sexual violence (broad)") so a noisy single-phrase match can never
//     surface a sharp accusation.
const DESC_RULES: PatternRule[] = SUBJECT_RULES
  .filter(r =>
    // Only the most unambiguous phrases — single-word verbs like "war" or
    // "death" trigger far too easily in narrative prose.
    [
      'sexual assault', 'sexual abuse', 'rape', 'sexual violence',
      'self-harm', 'self harm', 'suicide',
      'domestic abuse', 'domestic violence', 'emotional abuse',
      'child abuse', 'child death',
      'addiction', 'drug addiction', 'alcoholism',
      'eating disorder', 'anorexia', 'bulimia',
      'human trafficking', 'kidnapping',
      'genocide', 'graphic violence', 'torture',
    ].includes(r.pattern)
  )
  .map(r => {
    // If the pattern has a parent family, rewrite to emit the parent label
    // rather than the specific sub-label. Patterns with no parent (e.g.
    // 'kidnapping' → 'abuse_trauma' family-level) pass through unchanged.
    if (r.parent && PARENT_LABELS[r.parent]) {
      const p = PARENT_LABELS[r.parent];
      return { pattern: r.pattern, filterKey: p.filterKey, label: p.label };
    }
    return r;
  });

// =============================================================================
// Compilation
// =============================================================================

type CompiledRule = { regex: RegExp; rule: PatternRule };

function compileRules(rules: PatternRule[]): CompiledRule[] {
  return rules.map(rule => {
    const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { regex: new RegExp(`\\b${escaped}\\b`, 'i'), rule };
  });
}

const SUBJECT_COMPILED = compileRules(SUBJECT_RULES);
const DESC_COMPILED    = compileRules(DESC_RULES);

// =============================================================================
// Public API
// =============================================================================

/**
 * Detailed derivation — returns one ContentWarning per matched filterKey,
 * de-duplicated, with confidence (`specific` from subjects, `broad` from
 * description-only matches), and broad parents suppressed when a specific
 * sub-label of the same family is also present.
 *
 * Ordering: parent families in PARENT_ORDER, specifics first within a family.
 */
export function deriveContentWarningsDetailed(
  subjects: string[],
  description?: string | null,
): ContentWarning[] {
  const matched = new Map<string, ContentWarning>();

  // Pass 1 — subjects (high confidence).
  for (const subject of subjects ?? []) {
    if (!subject) continue;
    for (const { regex, rule } of SUBJECT_COMPILED) {
      if (matched.has(rule.filterKey)) continue;
      if (regex.test(subject)) {
        matched.set(rule.filterKey, {
          label:      rule.label,
          filterKey:  rule.filterKey,
          confidence: 'specific',
          parent:     rule.parent,
        });
      }
    }
  }

  // Pass 2 — description (downgraded confidence). Only adds keys not already
  // matched from subjects, and never upgrades confidence.
  if (description) {
    const desc = description;
    for (const { regex, rule } of DESC_COMPILED) {
      if (matched.has(rule.filterKey)) continue;
      if (regex.test(desc)) {
        matched.set(rule.filterKey, {
          label:      rule.label,
          filterKey:  rule.filterKey,
          confidence: 'broad',
          parent:     rule.parent,
        });
      }
    }
  }

  if (matched.size === 0) return [];

  // Suppress a broad parent when a specific child of the same family is also
  // present. e.g. if 'Sexual violence' matched, drop the bare 'Sexual content'.
  const presentParents = new Set<string>();
  for (const w of matched.values()) {
    if (w.parent) presentParents.add(w.parent);
  }
  for (const [key, w] of [...matched.entries()]) {
    // A "broad parent" warning is one whose own filterKey IS in PARENT_ORDER
    // (i.e. it's the family-level label, not a sub-specific). Drop it when a
    // specific sub-label exists for that family.
    if ((PARENT_ORDER as readonly string[]).includes(w.filterKey) && presentParents.has(w.filterKey)) {
      matched.delete(key);
    }
  }

  // Order: by parent family in PARENT_ORDER, with specifics before the broad
  // parent within each family (broad will only survive when no specific did).
  const out = [...matched.values()];
  out.sort((a, b) => {
    const fa = a.parent ?? a.filterKey;
    const fb = b.parent ?? b.filterKey;
    const ia = PARENT_ORDER.indexOf(fa as typeof PARENT_ORDER[number]);
    const ib = PARENT_ORDER.indexOf(fb as typeof PARENT_ORDER[number]);
    if (ia !== ib) return ia - ib;
    // Specifics first within a family.
    const sa = a.parent ? 0 : 1;
    const sb = b.parent ? 0 : 1;
    return sa - sb;
  });
  return out;
}

/**
 * Backward-compatible string-array variant. Use this when the caller just
 * needs labels (e.g. DB persistence in `books.content_warnings text[]`).
 *
 * Note: confidence is dropped. Prefer `deriveContentWarningsDetailed` for
 * any UI rendering that wants softer copy on weak evidence.
 */
export function deriveContentWarnings(subjects: string[], description?: string | null): string[] {
  return deriveContentWarningsDetailed(subjects, description).map(w => w.label);
}

/**
 * True when at least one subject matched the warning map AND at least one
 * subject was unmatched. Indicates the mapping may be incomplete for this
 * book's subject list. Only meaningful when warnings are non-empty.
 */
export function isCoveragePartial(subjects: string[]): boolean {
  if (!subjects || subjects.length === 0) return false;

  let hasMatch = false;
  let hasMiss  = false;

  for (const subject of subjects) {
    let matched = false;
    for (const { regex } of SUBJECT_COMPILED) {
      if (regex.test(subject)) { matched = true; break; }
    }
    if (matched) hasMatch = true;
    else         hasMiss  = true;
    if (hasMatch && hasMiss) return true;
  }
  return hasMatch && hasMiss;
}

// =============================================================================
// Legacy taxonomy export (kept for any downstream filter-key consumer).
// =============================================================================
export type WarningCategory = { label: string; filterKey: string };
export const WARNING_CATEGORIES: WarningCategory[] = [
  { label: 'Violence',              filterKey: 'violence'         },
  { label: 'Death & grief',         filterKey: 'death_grief'      },
  { label: 'Sexual content',        filterKey: 'sexual_content'   },
  { label: 'Substance use',         filterKey: 'substance_use'    },
  { label: 'Mental health themes',  filterKey: 'mental_health'    },
  { label: 'Animal harm',           filterKey: 'animal_harm'      },
  { label: 'Abuse & trauma',        filterKey: 'abuse_trauma'     },
  { label: 'Eating disorders',      filterKey: 'eating_disorders' },
  { label: 'Child harm',            filterKey: 'child_harm'       },
];
