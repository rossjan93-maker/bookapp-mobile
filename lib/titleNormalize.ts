// =============================================================================
// titleSearchVariants — canonical-title normalization for metadata lookup
// =============================================================================
// Goodreads titles frequently contain series/edition suffixes that external
// metadata APIs do not index by.  Searching with the full Goodreads title often
// returns 0 results even when the bare title works fine.
//
// This helper derives search-only variants from an original title while keeping
// the original untouched in the database and UI.
//
// Rules (applied in order, duplicates discarded):
//   1. Original title as-is                 — always first
//   2. Strip trailing parenthetical/bracket — "Glow (The Plated Prisoner, #4)" → "Glow"
//   3. Strip subtitle after colon           — "Dune: The Duke of Caladan" → "Dune"
//
// Example variants for "Glow (The Plated Prisoner, #4)":
//   ["Glow (The Plated Prisoner, #4)", "Glow"]
//
// Example variants for "Mistborn: The Final Empire (Mistborn, #1)":
//   ["Mistborn: The Final Empire (Mistborn, #1)", "Mistborn: The Final Empire", "Mistborn"]
// =============================================================================

export function titleSearchVariants(title: string): string[] {
  const raw = title.trim();
  if (!raw) return [];

  const seen  = new Set<string>();
  const push  = (v: string) => { const s = v.trim(); if (s && !seen.has(s)) { seen.add(s); variants.push(s); } };
  const variants: string[] = [];

  // 1. Original title (always first).
  push(raw);

  // 2. Strip trailing parenthetical / bracket suffix.
  //    Matches the LAST "(…)" or "[…]" group at the end of the string.
  const stripped = raw.replace(/\s*[\(\[][^\(\)\[\]]*[\)\]]\s*$/, '').trim();
  push(stripped);

  // 3. Strip subtitle after the first colon.
  //    Apply to both the original and the parenthetical-stripped variant.
  [raw, stripped].forEach(v => {
    const colon = v.indexOf(':');
    if (colon > 0) push(v.slice(0, colon));
  });

  return variants;
}
