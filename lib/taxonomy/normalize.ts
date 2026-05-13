// =============================================================================
// Genre input normalization (P0A)
//
// The single legal entry point for resolving a user-saved or chip-emitted
// genre string into a canonical GenreDef. Use this anywhere code reads
// reader_preferences.favorite_genres / avoid_genres or any other free-form
// genre-label source.
//
// Pre-P0A, callers indexed local maps directly (e.g. GENRE_AFFINITY_MAP[label])
// and silently no-op'd on a miss. That class of bug is gone now: misses are
// reported via `__DEV__ console.warn` so they're visible during development
// without affecting production behavior.
// =============================================================================

import { GENRE_DEFS, type GenreDef } from './genres';

/** Canonicalize a label for alias matching: lowercase, collapse whitespace,
 *  strip punctuation we treat as noise. */
function _canonicalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pre-built alias index. Each GenreDef contributes:
//   - every uiLabels entry (edit/intake/cardTag) as an implicit alias
//   - every aliasInputs entry
// Conflicts (same canonical key mapping to two defs) throw at module load.
const _ALIAS_INDEX: Map<string, GenreDef> = (() => {
  const m = new Map<string, GenreDef>();
  for (const def of GENRE_DEFS) {
    const inputs = [
      def.id,
      def.uiLabels.edit,
      def.uiLabels.intake,
      def.uiLabels.cardTag,
      ...def.aliasInputs,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);

    for (const raw of inputs) {
      const key = _canonicalize(raw);
      const prev = m.get(key);
      if (prev && prev.id !== def.id) {
        throw new Error(
          `[taxonomy] alias conflict: "${raw}" maps to both "${prev.id}" and "${def.id}"`,
        );
      }
      m.set(key, def);
    }
  }
  return m;
})();

/**
 * Resolve a genre string (from a chip, DB row, or any free-form source) to
 * its canonical GenreDef. Returns null if no alias matches.
 *
 * Misses are surfaced via `console.warn` in __DEV__ so unmapped labels are
 * visible during development. Production builds stay silent (returns null).
 *
 * Synchronous, no IO. Safe to call in render paths.
 */
export function normalizeGenreInput(label: unknown): GenreDef | null {
  if (typeof label !== 'string' || label.length === 0) return null;
  const key = _canonicalize(label);
  if (key.length === 0) return null;
  const hit = _ALIAS_INDEX.get(key);
  if (hit) return hit;
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.warn(`[taxonomy] unmapped genre label: ${JSON.stringify(label)}`);
  }
  return null;
}

/**
 * Diagnostic: returns the full alias-index size. Used by the validator
 * script to assert no defs were silently elided by a conflict throw.
 */
export function _aliasCount(): number {
  return _ALIAS_INDEX.size;
}
