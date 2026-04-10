// =============================================================================
// Dev Inspector — lightweight operator tooling
// =============================================================================
//
// Exposes inspection functions on window.__rs for use from the browser console
// during development and testing sessions.
//
// Setup (called automatically in library.tsx when __DEV__ is true):
//   ✓ mounted → call site logs: window.__rs.{covers, summaries, credibility, health}
//
// Usage from browser DevTools console:
//   __rs.covers()       — books with no cover_url
//   __rs.summaries()    — books with no description
//   __rs.credibility()  — books whose stored cover URL fails the allowlist check
//   __rs.health()       — provider health counters since last reset
//   __rs.all()          — runs all four in sequence
//
// All functions are no-ops unless running in a dev context.
// No persistence, no DB writes — purely read-only observation.
//
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { validateCoverUrl, coverCredibilityLabel } from './coverCredibility';
import { logProviderHealthSummary } from './providerHealth';

const PREFIX = '[INSPECTOR]';

// ── Shared query helpers ───────────────────────────────────────────────────────

type BookRow = {
  id:           string;
  title:        string | null;
  author:       string | null;
  cover_url:    string | null;
  cover_source: string | null;
  description:  string | null;
};

async function fetchAllBooks(client: SupabaseClient): Promise<BookRow[]> {
  const { data, error } = await client
    .from('books')
    .select('id, title, author, cover_url, cover_source, description')
    .order('title', { ascending: true });

  if (error) {
    console.log(`${PREFIX} fetch error — ${error.message}`);
    return [];
  }
  return (data ?? []) as BookRow[];
}

// ── Individual inspection functions ───────────────────────────────────────────

/**
 * Logs books with no cover_url, grouped by cover_source.
 * Use to find candidates for the repair loop.
 */
export async function inspectMissingCovers(client: SupabaseClient): Promise<void> {
  const all     = await fetchAllBooks(client);
  const missing = all.filter(b => !b.cover_url);

  if (missing.length === 0) {
    console.log(`${PREFIX} covers — no books with missing cover ✓`);
    return;
  }

  console.log(`${PREFIX} covers — ${missing.length} book(s) with no cover_url:`);
  for (const b of missing) {
    console.log(
      `  id=${b.id.slice(0, 8)}  source=${b.cover_source ?? 'null'}  ` +
      `"${(b.title ?? '').slice(0, 50)}" / ${b.author ?? '?'}`,
    );
  }
}

/**
 * Logs books with no description, grouped by whether they have a cover
 * (cover-only books are lower priority to re-fetch).
 */
export async function inspectMissingSummaries(client: SupabaseClient): Promise<void> {
  const all     = await fetchAllBooks(client);
  const missing = all.filter(b => !b.description);

  if (missing.length === 0) {
    console.log(`${PREFIX} summaries — no books with missing description ✓`);
    return;
  }

  const withCover    = missing.filter(b => !!b.cover_url);
  const withoutCover = missing.filter(b => !b.cover_url);

  console.log(
    `${PREFIX} summaries — ${missing.length} book(s) with no description` +
    ` (${withCover.length} have covers, ${withoutCover.length} have neither):`,
  );

  for (const b of missing.slice(0, 20)) {
    const hasCover = b.cover_url ? '✓cover' : '✗cover';
    console.log(
      `  [${hasCover}] id=${b.id.slice(0, 8)}  ` +
      `"${(b.title ?? '').slice(0, 50)}" / ${b.author ?? '?'}`,
    );
  }

  if (missing.length > 20) {
    console.log(`  … and ${missing.length - 20} more`);
  }
}

/**
 * Scans all books whose cover_url is set and checks each against the
 * credibility allowlist. Logs any that would trigger the typographic fallback.
 * This does NOT fire network requests — it's a pure URL pattern check.
 */
export async function inspectCredibilityRejections(client: SupabaseClient): Promise<void> {
  const all          = await fetchAllBooks(client);
  const withCover    = all.filter(b => !!b.cover_url);
  const rejected     = withCover.filter(b => !validateCoverUrl(b.cover_url).valid);

  if (rejected.length === 0) {
    console.log(
      `${PREFIX} credibility — all ${withCover.length} cover URLs pass the allowlist ✓`,
    );
    return;
  }

  console.log(
    `${PREFIX} credibility — ${rejected.length}/${withCover.length} cover URLs` +
    ` fail allowlist (will show typographic fallback):`,
  );

  const byReason: Record<string, BookRow[]> = {};
  for (const b of rejected) {
    const reason = coverCredibilityLabel(b.cover_url);
    (byReason[reason] ??= []).push(b);
  }

  for (const [reason, books] of Object.entries(byReason)) {
    console.log(`  Reason: ${reason} (${books.length} books)`);
    for (const b of books.slice(0, 5)) {
      console.log(
        `    id=${b.id.slice(0, 8)}  source=${b.cover_source ?? 'null'}  ` +
        `url=${(b.cover_url ?? '').slice(0, 60)}  ` +
        `"${(b.title ?? '').slice(0, 40)}"`,
      );
    }
    if (books.length > 5) {
      console.log(`    … and ${books.length - 5} more`);
    }
  }
}

// ── Global registration ────────────────────────────────────────────────────────

/**
 * Mounts all inspection functions on globalThis.__rs for browser console access.
 * Call this once in a dev context (library.tsx useEffect when __DEV__ is true).
 *
 * After mounting:
 *   __rs.covers()       — books with no cover
 *   __rs.summaries()    — books with no description
 *   __rs.credibility()  — covers failing the allowlist
 *   __rs.health()       — provider health counters
 *   __rs.all()          — run all four
 */
export function mountDevInspector(client: SupabaseClient): void {
  const rs = {
    covers:      () => inspectMissingCovers(client),
    summaries:   () => inspectMissingSummaries(client),
    credibility: () => inspectCredibilityRejections(client),
    health:      () => logProviderHealthSummary(),
    all:         async () => {
      await inspectMissingCovers(client);
      await inspectMissingSummaries(client);
      await inspectCredibilityRejections(client);
      logProviderHealthSummary();
    },
  };

  (globalThis as unknown as Record<string, unknown>).__rs = rs;

  console.log(
    `${PREFIX} mounted → __rs.{covers, summaries, credibility, health, all}`,
  );
}
