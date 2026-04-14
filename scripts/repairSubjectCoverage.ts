(global as any).__DEV__ = false;
// =============================================================================
// scripts/repairSubjectCoverage.ts
// =============================================================================
// CLI wrapper around lib/subjectRepair.ts.
//
// Creates a Supabase client and injects it via opts.client so the shared repair
// function runs without React Native imports.  For maintenance runs that touch
// all books (no --user-id), use the service-role key so writes pass RLS.
//
// Auth strategy (checked in order):
//   1. SUPABASE_SERVICE_ROLE_KEY — service-role client, bypasses RLS (recommended
//      for global runs that update books not owned by an authenticated session)
//   2. EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY — anon client, suitable for
//      user-scoped runs where the target book IDs are already known
//
// Cursor-based pagination:
//   Each run prints "Next cursor: <id>" at the end.  Pass that id as
//   --after-id=<id> on the next invocation to continue from where this run
//   stopped — including past books that failed or were skipped.
//
// Usage:
//   npx ts-node scripts/repairSubjectCoverage.ts [flags]
//
// Flags (both --flag value and --flag=value forms are accepted):
//   --dry-run              Preview enrichment without writing to the database
//   --batch-size=<n>       Number of books to process per run (default: 50)
//   --user-id=<uuid>       Restrict repair to one user's library
//   --after-id=<uuid>      Cursor: only process books with id > this value
//
// Examples:
//   npx ts-node scripts/repairSubjectCoverage.ts --dry-run
//   npx ts-node scripts/repairSubjectCoverage.ts --batch-size=20
//   npx ts-node scripts/repairSubjectCoverage.ts --user-id=abc123 --dry-run
//   npx ts-node scripts/repairSubjectCoverage.ts --after-id=<lastId from prev run>
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { repairSubjectCoverage } from '../lib/subjectRepair';

const LOG = '[SUBJECT_REPAIR]';

// ── CLI flag parsing ──────────────────────────────────────────────────────────
// Supports both space-separated (--flag value) and equals-separated (--flag=value).

function parseArgs(argv: string[]): {
  dryRun:    boolean;
  batchSize: number;
  userId:    string | undefined;
  afterId:   string | undefined;
} {
  let dryRun    = false;
  let batchSize = 50;
  let userId: string | undefined;
  let afterId: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const raw    = argv[i];
    const eqIdx  = raw.indexOf('=');
    const flag   = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const inline = eqIdx >= 0 ? raw.slice(eqIdx + 1) : null;

    if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--batch-size') {
      const raw2 = inline ?? argv[++i];
      const v    = parseInt(raw2 ?? '', 10);
      if (isNaN(v) || v < 1) {
        console.error(`${LOG} --batch-size requires a positive integer`);
        process.exit(1);
      }
      batchSize = v;
    } else if (flag === '--user-id') {
      const val = inline ?? argv[++i];
      if (!val) {
        console.error(`${LOG} --user-id requires a UUID value`);
        process.exit(1);
      }
      userId = val;
    } else if (flag === '--after-id') {
      const val = inline ?? argv[++i];
      if (!val) {
        console.error(`${LOG} --after-id requires a UUID value`);
        process.exit(1);
      }
      afterId = val;
    } else {
      console.error(`${LOG} Unknown flag: ${raw}`);
      process.exit(1);
    }
  }

  return { dryRun, batchSize, userId, afterId };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function run() {
  const { dryRun, batchSize, userId, afterId } = parseArgs(process.argv);

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anonKey     = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

  if (!supabaseUrl) {
    console.error(`${LOG} Missing EXPO_PUBLIC_SUPABASE_URL`);
    process.exit(1);
  }

  // Prefer service-role key so writes bypass RLS for global maintenance runs.
  // Fall back to anon key for user-scoped runs where --user-id is supplied.
  const authKey  = serviceKey || anonKey;
  const keyLabel = serviceKey ? 'service-role' : 'anon';

  if (!authKey) {
    console.error(
      `${LOG} No auth key found. Set SUPABASE_SERVICE_ROLE_KEY (recommended for global runs) ` +
      `or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.`,
    );
    process.exit(1);
  }

  if (!serviceKey && !userId) {
    console.warn(
      `${LOG} WARNING: Running global repair with anon key — writes may fail RLS. ` +
      `Set SUPABASE_SERVICE_ROLE_KEY for maintenance runs without --user-id.`,
    );
  }

  // Inject a plain Node.js client so lib/subjectRepair.ts does not need to
  // import lib/supabase.ts (which pulls in react-native / AsyncStorage).
  const client = createClient(supabaseUrl, authKey);

  console.log(`${LOG} === Subject Coverage Batch Repair ===`);
  console.log(
    `${LOG} auth=${keyLabel}  dryRun=${dryRun}  batchSize=${batchSize}  ` +
    `userId=${userId ?? '(all)'}  afterId=${afterId ?? '(start)'}`,
  );
  if (dryRun) console.log(`${LOG} DRY RUN — no writes will be made\n`);

  const summary = await repairSubjectCoverage({ dryRun, batchSize, userId, afterId, client });

  console.log(`\n${LOG} ── Summary ──────────────────────────────────────────`);
  console.log(`${LOG}   eligible       : ${summary.eligible}`);
  console.log(`${LOG}   enriched       : ${summary.enriched}`);
  console.log(`${LOG}     ↳ via OL     : ${summary.enrichedByOL}`);
  console.log(`${LOG}     ↳ via GB     : ${summary.enrichedByGB}`);
  console.log(`${LOG}   failed         : ${summary.failed}`);
  console.log(`${LOG}   skipped        : ${summary.skipped}`);
  console.log(`${LOG}   fieldsImproved : ${summary.fieldsImproved}`);
  if (dryRun) console.log(`${LOG}   (no changes written — dry run)`);
  console.log(`${LOG} ─────────────────────────────────────────────────────`);

  if (summary.lastId) {
    console.log(`${LOG}   Next cursor    : --after-id=${summary.lastId}`);
  }
  console.log();

  if (summary.eligible === 0) {
    console.log(`${LOG} Nothing to repair — all books already have subjects (or cursor is past end).`);
  }
}

run().catch(err => {
  console.error(`${LOG} Fatal error:`, err);
  process.exit(1);
});
