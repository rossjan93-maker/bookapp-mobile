/**
 * Session-level cache for recommendation context.
 *
 * Written when a user taps a RecCard (before navigation to book detail).
 * Read on book detail mount to render the "Why this book?" section.
 *
 * Intentionally ephemeral — not persisted, lives only in the JS runtime.
 * Keyed by the book's Open Library external_id (e.g. "/works/OL123456W").
 */

export type RecContext = {
  explanation:  string | null;
  evidenceTags: string[];
};

const _cache = new Map<string, RecContext>();

export function setRecContext(externalId: string, ctx: RecContext): void {
  if (!externalId) return;
  _cache.set(externalId, ctx);
}

export function getRecContext(externalId: string): RecContext | null {
  if (!externalId) return null;
  return _cache.get(externalId) ?? null;
}
