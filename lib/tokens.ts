// =============================================================================
// Design tokens — single source of truth for the Readstack colour palette.
//
// Usage:
//   import * as T from '../lib/tokens';
//   // or for deeper nesting:
//   import * as T from '../../lib/tokens';
//
//   const styles = StyleSheet.create({
//     container: { backgroundColor: T.BG },
//     label:     { color: T.INK },
//   });
//
// All values are opaque hex strings — no opacity variants are included here.
// For semi-transparent surfaces, use StyleSheet opacity or rgba() inline.
// =============================================================================

/** Page / screen background — warm off-white */
export const BG      = '#f5f1ec';

/** Primary text — near-black ink */
export const INK     = '#231f1b';

/** Secondary / label text — warm mid-grey */
export const STONE   = '#6b635c';

/** Tertiary / placeholder text — warm light-grey */
export const DUST    = '#9e958d';

/** Accent — muted sage green (primary brand green; used for borders, bars, accents) */
export const SAGE    = '#7b9e7e';

/** Sage tint background — for pills, chips, and highlight surfaces */
export const SAGE_BG = '#eaf1ea';

/** Deep sage — the only “strong” green in the palette. Use for big numerals,
 *  status text, primary progress-bar fills, and any green text on a light
 *  background. Replaces every bright Tailwind-style green (#15803d, #16a34a,
 *  #166534, #4d7f52) so the app reads as one coherent green system. */
export const SAGE_DEEP = '#2f6f3a';

/** Sage ink — the deepest green in the palette. Reserved for sparing emphasis
 *  on top of SAGE_BG (e.g. supporting copy inside a sage notice strip) where
 *  SAGE_DEEP would compete with primary text. Do NOT use for ordinary body
 *  text or as a substitute for INK. */
export const SAGE_INK  = '#3d5e42';

/** Warm amber — for ratings, highlights, and cover glows */
export const AMBER   = '#c4956a';

/** Surface — near-white cream for cards and modals */
export const CREAM   = '#fefcf9';

/** Dividers and borders — warm light rule */
export const BORDER  = '#ede9e4';

/** Faint rule / very subtle background tint */
export const FAINT   = '#c4b5a5';
