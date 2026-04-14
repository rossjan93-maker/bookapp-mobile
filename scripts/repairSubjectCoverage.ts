(global as any).__DEV__ = false;
// =============================================================================
// scripts/repairSubjectCoverage.ts
// =============================================================================
// CLI wrapper around lib/subjectRepair.ts.
// Creates a plain Node.js Supabase client and injects it via the `client` option
// so the shared repair function runs without its React Native app imports.
//
// Usage:
//   npx ts-node scripts/repairSubjectCoverage.ts [flags]
//
// Flags (both --flag value and --flag=value forms are accepted):
//   --dry-run              Preview enrichment without writing to the database
//   --batch-size=<n>       Number of books to process in this run (default: 50)
//   --user-id=<uuid>       Restrict repair to one user's library
//
// Examples:
//   npx ts-node scripts/repairSubjectCoverage.ts --dry-run
//   npx ts-node scripts/repairSubjectCoverage.ts --batch-size=20
//   npx ts-node scripts/repairSubjectCoverage.ts --user-id=abc123 --dry-run
//   npx ts-node scripts/repairSubjectCoverage.ts --batch-size 20 --user-id abc123
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
} {
  let dryRun    = false;
  let batchSize = 50;
  let userId: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const raw = argv[i];

    // Split --flag=value into ['--flag', 'value']
    const eqIdx = raw.indexOf('=');
    const flag  = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const inline = eqIdx >= 0 ? raw.slice(eqIdx + 1) : null;

    if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--batch-size') {
      const raw2 = inline ?? argv[++i];
      const v    = parseInt(raw2 ?? '', 10);
      if (isNaN(v) || v < 1) { console.error(`${LOG} --batch-size requires a positive integer`); process.exit(1); }
      batchSize = v;
    } else if (flag === '--user-id') {
      const val = inline ?? argv[++i];
      if (!val) { console.error(`${LOG} --user-id requires a UUID value`); process.exit(1); }
      userId = val;
    } else {
      console.error(`${LOG} Unknown flag: ${raw}`);
      process.exit(1);
    }
  }

  return { dryRun, batchSize, userId };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function run() {
  const { dryRun, batchSize, userId } = parseArgs(process.argv);

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const anonKey     = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

  if (!supabaseUrl || !anonKey) {
    console.error(`${LOG} Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`);
    process.exit(1);
  }

  // Create a plain Node.js client and inject it so lib/subjectRepair.ts does
  // not need to import lib/supabase.ts (which pulls in react-native / AsyncStorage).
  const client = createClient(supabaseUrl, anonKey);

  console.log(`${LOG} === Subject Coverage Batch Repair ===`);
  console.log(`${LOG} dryRun=${dryRun}  batchSize=${batchSize}  userId=${userId ?? '(all)'}`);
  if (dryRun) console.log(`${LOG} DRY RUN — no writes will be made\n`);

  const summary = await repairSubjectCoverage({ dryRun, batchSize, userId, client });

  console.log(`\n${LOG} ── Summary ──────────────────────────────────────────`);
  console.log(`${LOG}   eligible       : ${summary.eligible}`);
  console.log(`${LOG}   enriched       : ${summary.enriched}`);
  console.log(`${LOG}   failed         : ${summary.failed}`);
  console.log(`${LOG}   skipped        : ${summary.skipped}`);
  console.log(`${LOG}   fieldsImproved : ${summary.fieldsImproved}`);
  if (dryRun) console.log(`${LOG}   (no changes written — dry run)`);
  console.log(`${LOG} ─────────────────────────────────────────────────────\n`);

  if (summary.eligible === 0) {
    console.log(`${LOG} Nothing to repair — all books already have subjects.`);
  }
}

run().catch(err => {
  console.error(`${LOG} Fatal error:`, err);
  process.exit(1);
});
