(global as any).__DEV__ = false;
// =============================================================================
// scripts/repairSubjectCoverage.ts
// =============================================================================
// Standalone CLI wrapper that replicates lib/subjectRepair.ts logic using a
// plain Node.js Supabase client (bypasses the React Native imports in
// lib/supabase.ts which are incompatible with a Node.js script environment).
//
// Usage:
//   npx ts-node scripts/repairSubjectCoverage.ts [flags]
//
// Flags:
//   --dry-run              Preview enrichment without writing to the database
//   --batch-size <n>       Number of books to process in this run (default: 50)
//   --user-id <uuid>       Restrict repair to one user's library
//
// Examples:
//   npx ts-node scripts/repairSubjectCoverage.ts --dry-run
//   npx ts-node scripts/repairSubjectCoverage.ts --batch-size 20
//   npx ts-node scripts/repairSubjectCoverage.ts --user-id abc123 --dry-run
// =============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { fetchOLMeta, searchOLWork, isOLId } from '../lib/openLibrary';

const LOG = '[SUBJECT_REPAIR]';

// ── CLI flag parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  dryRun:    boolean;
  batchSize: number;
  userId:    string | undefined;
} {
  let dryRun    = false;
  let batchSize = 50;
  let userId: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--batch-size') {
      const raw = argv[++i];
      const v   = parseInt(raw ?? '', 10);
      if (isNaN(v) || v < 1) { console.error(`${LOG} --batch-size requires a positive integer`); process.exit(1); }
      batchSize = v;
    } else if (arg === '--user-id') {
      userId = argv[++i];
      if (!userId) { console.error(`${LOG} --user-id requires a UUID value`); process.exit(1); }
    } else {
      console.error(`${LOG} Unknown flag: ${arg}`);
      process.exit(1);
    }
  }

  return { dryRun, batchSize, userId };
}

// ── Repair logic (mirrors lib/subjectRepair.ts) ───────────────────────────────

type CandidateBook = {
  id:          string;
  title:       string | null;
  author:      string | null;
  external_id: string | null;
  subjects:    string[] | null;
};

type RepairSummary = {
  eligible:       number;
  enriched:       number;
  failed:         number;
  skipped:        number;
  fieldsImproved: number;
};

async function repair(
  client: SupabaseClient,
  opts: { dryRun: boolean; batchSize: number; userId?: string },
): Promise<RepairSummary> {
  const { dryRun, batchSize, userId } = opts;

  const summary: RepairSummary = {
    eligible: 0, enriched: 0, failed: 0, skipped: 0, fieldsImproved: 0,
  };

  // Step 1: resolve book IDs for this user when userId is supplied
  let filterIds: string[] | null = null;
  if (userId) {
    const { data, error } = await client
      .from('user_books')
      .select('book_id')
      .eq('user_id', userId);

    if (error) {
      console.log(`${LOG} user_books query failed — ${error.message}`);
      return summary;
    }

    filterIds = (data ?? []).map((r: { book_id: string }) => r.book_id);

    if (filterIds.length === 0) {
      console.log(`${LOG} user has no books — nothing to repair`);
      return summary;
    }

    console.log(`${LOG} user ${userId.slice(0, 8)}… has ${filterIds.length} book(s) in library`);
  }

  // Step 2: Priority-1 candidates — subjects IS NULL
  let q1 = client
    .from('books')
    .select('id, title, author, external_id, subjects')
    .is('subjects', null);

  if (filterIds) q1 = (q1 as typeof q1).in('id', filterIds);

  const { data: p1Data, error: p1Err } = await (q1 as typeof q1).limit(batchSize);
  if (p1Err) {
    console.log(`${LOG} priority-1 query failed — ${p1Err.message}`);
    return summary;
  }
  const p1: CandidateBook[] = (p1Data ?? []) as CandidateBook[];

  // Step 3: Priority-2 candidates — subjects exists but has < 3 entries
  let p2: CandidateBook[] = [];
  const slots = batchSize - p1.length;

  if (slots > 0) {
    let q2 = client
      .from('books')
      .select('id, title, author, external_id, subjects')
      .not('subjects', 'is', null);

    if (filterIds) q2 = (q2 as typeof q2).in('id', filterIds);

    const { data: p2Raw } = await (q2 as typeof q2).limit(slots * 4);

    p2 = ((p2Raw ?? []) as CandidateBook[])
      .filter(b => Array.isArray(b.subjects) && (b.subjects as string[]).length < 3)
      .slice(0, slots);
  }

  // Step 4: Merge — books with a valid OL external_id float to the top
  const seen = new Set<string>();
  const candidates: CandidateBook[] = [...p1, ...p2]
    .filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; })
    .sort((a, b) => (isOLId(a.external_id) ? 0 : 1) - (isOLId(b.external_id) ? 0 : 1))
    .slice(0, batchSize);

  summary.eligible = candidates.length;
  console.log(
    `${LOG} eligible=${candidates.length} ` +
    `(p1_null=${p1.length} p2_sparse=${p2.length}) ` +
    `dryRun=${dryRun}`,
  );

  // Step 5: Enrich each candidate
  for (const book of candidates) {
    const t = String(book.title  ?? '').trim();
    const a = String(book.author ?? '').trim();
    const currentSubjects: string[] = Array.isArray(book.subjects)
      ? (book.subjects as string[])
      : [];

    // Safety guard — never overwrite subjects already ≥ 3 entries
    if (currentSubjects.length >= 3) {
      summary.skipped++;
      console.log(`${LOG} skip "${t}" — already has ${currentSubjects.length} subjects`);
      continue;
    }

    try {
      let resolvedExtId: string | null = isOLId(book.external_id) ? book.external_id : null;
      let extIdFound = false;

      if (!resolvedExtId && t) {
        console.log(`${LOG} searching OL for "${t}"…`);
        const found = await searchOLWork(t, a);
        if (found) {
          resolvedExtId = found;
          extIdFound    = true;
          console.log(`${LOG} OL work found for "${t}" → ${found}`);
        }
      }

      if (!resolvedExtId) {
        summary.failed++;
        console.log(`${LOG} no OL ID for "${t}" — cannot enrich`);
        continue;
      }

      const ol = await fetchOLMeta(resolvedExtId);

      if (ol.subjects.length === 0) {
        summary.failed++;
        console.log(`${LOG} OL returned 0 subjects for "${t}"`);
        continue;
      }

      const preview = ol.subjects.slice(0, 3).join(', ');
      console.log(
        `${LOG} "${t}" → ${ol.subjects.length} subjects ` +
        `(${preview}${ol.subjects.length > 3 ? '…' : ''})`,
      );

      if (!dryRun) {
        const patch: Record<string, unknown> = { subjects: ol.subjects };
        if (extIdFound) patch.external_id = resolvedExtId;

        const { error } = await client
          .from('books')
          .update(patch)
          .eq('id', book.id);

        if (error) {
          summary.failed++;
          console.log(`${LOG} db update failed for "${t}" — ${error.message}`);
          continue;
        }

        summary.fieldsImproved++;
        if (extIdFound) summary.fieldsImproved++;
      } else {
        summary.fieldsImproved++;
        if (extIdFound) summary.fieldsImproved++;
      }

      summary.enriched++;

    } catch (err) {
      summary.failed++;
      console.log(`${LOG} error processing "${t}" — ${String(err)}`);
    }
  }

  const accounted = summary.enriched + summary.failed + summary.skipped;
  if (accounted < summary.eligible) summary.skipped += summary.eligible - accounted;

  console.log(
    `${LOG} done — ` +
    `eligible=${summary.eligible} ` +
    `enriched=${summary.enriched} ` +
    `failed=${summary.failed} ` +
    `skipped=${summary.skipped} ` +
    `fieldsImproved=${summary.fieldsImproved}` +
    (dryRun ? ' [DRY RUN]' : ''),
  );

  return summary;
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

  const client = createClient(supabaseUrl, anonKey);

  console.log(`${LOG} === Subject Coverage Batch Repair ===`);
  console.log(`${LOG} dryRun=${dryRun}  batchSize=${batchSize}  userId=${userId ?? '(all)'}`);
  if (dryRun) console.log(`${LOG} DRY RUN — no writes will be made\n`);

  const summary = await repair(client, { dryRun, batchSize, userId });

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
