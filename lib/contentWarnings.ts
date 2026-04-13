// =============================================================================
// Content Warnings — subject → warning mapping
// =============================================================================
// Maps known Open Library subject strings to normalized warning category
// labels. Conservative by design: only maps subjects that clearly signal
// sensitive content, not general genre tags.
//
// Each category carries a `filterKey` that can later be used for user
// preference filtering (e.g. "always collapse violence warnings").
//
// Matching is done with word-boundary anchors to avoid false positives from
// incidental substring sequences (e.g. "war" inside "award", "loss" inside
// "glossary").  Multi-word patterns are matched as whole phrases.
// =============================================================================

export type WarningCategory = {
  label:     string;
  filterKey: string;
};

// Ordered by severity for display purposes.
export const WARNING_CATEGORIES: WarningCategory[] = [
  { label: 'Violence',              filterKey: 'violence'        },
  { label: 'Death & grief',         filterKey: 'death_grief'     },
  { label: 'Sexual content',        filterKey: 'sexual_content'  },
  { label: 'Substance use',         filterKey: 'substance_use'   },
  { label: 'Mental health themes',  filterKey: 'mental_health'   },
  { label: 'Animal harm',           filterKey: 'animal_harm'     },
  { label: 'Abuse & trauma',        filterKey: 'abuse_trauma'    },
  { label: 'Eating disorders',      filterKey: 'eating_disorders'},
  { label: 'Child harm',            filterKey: 'child_harm'      },
];

// Mapping: pattern string → filterKey.
// Only subjects that clearly signal sensitive content are included.
// General genre tags (e.g. "fiction", "fantasy") are never mapped.
// Patterns are compiled into word-boundary regexes at module init.
const SUBJECT_PATTERN_MAP: Array<[string, string]> = [
  // Violence
  ['war',                    'violence'],
  ['battle',                 'violence'],
  ['combat',                 'violence'],
  ['violence',               'violence'],
  ['murder',                 'violence'],
  ['torture',                'violence'],
  ['genocide',               'violence'],
  ['terrorism',              'violence'],
  ['assassination',          'violence'],
  ['brutality',              'violence'],

  // Death & grief
  ['death',                  'death_grief'],
  ['grief',                  'death_grief'],
  ['mourning',               'death_grief'],
  ['terminal illness',       'death_grief'],
  ['suicide',                'death_grief'],
  ['euthanasia',             'death_grief'],
  ['bereavement',            'death_grief'],

  // Sexual content
  ['erotic',                 'sexual_content'],
  ['erotica',                'sexual_content'],
  ['sexual abuse',           'sexual_content'],
  ['sexual assault',         'sexual_content'],
  ['sexual content',         'sexual_content'],
  ['rape',                   'sexual_content'],
  ['pornography',            'sexual_content'],
  ['pornographic',           'sexual_content'],

  // Substance use
  ['drug abuse',             'substance_use'],
  ['drug addiction',         'substance_use'],
  ['alcoholism',             'substance_use'],
  ['substance abuse',        'substance_use'],
  ['narcotics',              'substance_use'],

  // Mental health themes
  ['depression',             'mental_health'],
  ['mental illness',         'mental_health'],
  ['mental health',          'mental_health'],
  ['psychiatric',            'mental_health'],
  ['psychosis',              'mental_health'],
  ['schizophrenia',          'mental_health'],
  ['ptsd',                   'mental_health'],
  ['post-traumatic',         'mental_health'],
  ['self-harm',              'mental_health'],

  // Animal harm
  ['animal cruelty',         'animal_harm'],
  ['animal abuse',           'animal_harm'],
  ['animal harm',            'animal_harm'],
  ['vivisection',            'animal_harm'],

  // Abuse & trauma
  ['domestic abuse',         'abuse_trauma'],
  ['domestic violence',      'abuse_trauma'],
  ['child abuse',            'abuse_trauma'],
  ['human trafficking',      'abuse_trauma'],
  ['slavery',                'abuse_trauma'],
  ['kidnapping',             'abuse_trauma'],
  ['abduction',              'abuse_trauma'],
  ['trauma',                 'abuse_trauma'],

  // Eating disorders
  ['eating disorder',        'eating_disorders'],
  ['anorexia',               'eating_disorders'],
  ['bulimia',                'eating_disorders'],

  // Child harm
  ['pedophilia',             'child_harm'],
  ['child molestation',      'child_harm'],
];

// Precompile each pattern as a word-boundary regex (case-insensitive).
// Word boundaries (\b) prevent incidental substring matches:
//   "war" does not match "award", "loss" does not match "glossary".
// For patterns ending in a suffix wildcard (e.g. "pornograph" to cover
// "pornography", "pornographic"), we anchor only the left side.
const COMPILED_PATTERNS: Array<[RegExp, string]> = SUBJECT_PATTERN_MAP.map(
  ([pattern, key]) => {
    // Escape any special regex chars in the pattern first.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Right-boundary: use \b unless the pattern intentionally lacks a right
    // boundary (denoted by trailing '-' or by "pornograph" style prefix).
    // Here we always use \b on both sides — safe for all patterns in the map.
    return [new RegExp(`\\b${escaped}\\b`, 'i'), key];
  }
);

/**
 * Given a list of Open Library subject strings, returns the set of matched
 * WarningCategory labels (de-duped, ordered by WARNING_CATEGORIES order).
 *
 * Returns an empty array when no subjects match any warning.
 */
export function deriveContentWarnings(subjects: string[]): string[] {
  if (!subjects || subjects.length === 0) return [];

  const matchedKeys = new Set<string>();

  for (const subject of subjects) {
    for (const [regex, filterKey] of COMPILED_PATTERNS) {
      if (regex.test(subject)) {
        matchedKeys.add(filterKey);
      }
    }
  }

  if (matchedKeys.size === 0) return [];

  // Return labels in canonical category order.
  return WARNING_CATEGORIES
    .filter(c => matchedKeys.has(c.filterKey))
    .map(c => c.label);
}

/**
 * Returns true when mapping coverage is genuinely partial — meaning at least
 * one subject was matched by the warning map AND at least one was not.
 * This signals that some subjects were recognized as safe/neutral but others
 * may carry unrecognized sensitive content.
 *
 * Only meaningful when warnings is non-empty (i.e. at least one subject matched).
 */
export function isCoveragePartial(subjects: string[]): boolean {
  if (!subjects || subjects.length === 0) return false;

  let hasMatch = false;
  let hasMiss  = false;

  for (const subject of subjects) {
    let matched = false;
    for (const [regex] of COMPILED_PATTERNS) {
      if (regex.test(subject)) {
        matched = true;
        break;
      }
    }
    if (matched) hasMatch = true;
    else         hasMiss  = true;
    if (hasMatch && hasMiss) return true; // short-circuit once both found
  }

  return hasMatch && hasMiss;
}
