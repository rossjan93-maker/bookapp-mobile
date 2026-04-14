(global as any).__DEV__ = false;
// =============================================================================
// scripts/inferSubjectsLLM.ts
// =============================================================================
// Third-pass subject enrichment using LLM inference.
//
// Run after repairSubjectCoverage.ts (Open Library + Google Books passes).
// Targets books where:
//   - subjects IS NULL                    (or sparse with --include-sparse)
//   - description is present AND >= 100 chars
//   - NOT already inferred (idempotent — tracks via book_source_links)
//
// Provider:
//   OpenAI chat completions via OPENAI_API_KEY environment variable.
//   Override the model with LLM_MODEL (default: gpt-4o-mini).
//   Any OpenAI-compatible key works — including the Replit AI Integration.
//
// Idempotency:
//   A book_source_links row (source='llm_inference') is written on every
//   successful inference. Re-running the script skips books that already
//   have this row.  Use --force to re-infer and overwrite existing results.
//
// Auth:
//   Reads SUPABASE_SERVICE_ROLE_KEY for write access (bypasses RLS).
//   Falls back to EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY for anon access.
//
// Usage:
//   npx tsx scripts/inferSubjectsLLM.ts [flags]
//
// Flags:
//   --dry-run              Preview what would be inferred — no writes
//   --batch-size=<n>       Max books to process (default 50)
//   --include-sparse       Also process books with 1-2 existing subjects
//   --force                Re-infer even if book_source_links entry exists
//   --min-description=<n>  Min description chars (default 100)
// =============================================================================

import { createClient }        from '@supabase/supabase-js';
import { inferSubjectsFromLLM, MIN_DESC_CHARS } from '../lib/subjectInference';

const LOG = '[LLM_INFER]';

// ── CLI flag parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  dryRun:         boolean;
  batchSize:      number;
  includeSparse:  boolean;
  force:          boolean;
  minDescription: number;
} {
  let dryRun         = false;
  let batchSize      = 50;
  let includeSparse  = false;
  let force          = false;
  let minDescription = MIN_DESC_CHARS;

  for (let i = 2; i < argv.length; i++) {
    const raw   = argv[i];
    const eqIdx = raw.indexOf('=');
    const flag  = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw;
    const val   = eqIdx >= 0 ? raw.slice(eqIdx + 1) : null;

    if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--include-sparse') {
      includeSparse = true;
    } else if (flag === '--force') {
      force = true;
    } else if (flag === '--batch-size') {
      const v = parseInt(val ?? argv[++i] ?? '', 10);
      if (isNaN(v) || v < 1) { console.error(`${LOG} --batch-size requires a positive integer`); process.exit(1); }
      batchSize = v;
    } else if (flag === '--min-description') {
      const v = parseInt(val ?? argv[++i] ?? '', 10);
      if (isNaN(v) || v < 0) { console.error(`${LOG} --min-description requires a non-negative integer`); process.exit(1); }
      minDescription = v;
    } else {
      console.error(`${LOG} Unknown flag: ${raw}`);
      process.exit(1);
    }
  }

  return { dryRun, batchSize, includeSparse, force, minDescription };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

type BookRow = {
  id:          string;
  title:       string | null;
  author:      string | null;
  description: string | null;
  subjects:    string[] | null;
  isbn13:      string | null;
  isbn:        string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAlreadyInferred(
  db: any,
  bookIds: string[],
): Promise<Set<string>> {
  if (bookIds.length === 0) return new Set();
  const { data, error } = await db
    .from('book_source_links')
    .select('book_id')
    .eq('source', 'llm_inference')
    .in('book_id', bookIds);
  if (error) {
    console.warn(`${LOG} could not check existing inferences — ${error.message}`);
    return new Set();
  }
  return new Set((data ?? []).map((r: { book_id: string }) => r.book_id));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeProviderLink(
  db:       any,
  bookId:   string,
  model:    string,
  subjects: string[],
  status:   'success' | 'failed',
  dryRun:   boolean,
): Promise<void> {
  if (dryRun) return;
  // source_book_id must be stable and unique per book for this provider.
  // Since LLM has no external ID, we use "book:<uuid>" as a sentinel.
  const { error } = await db
    .from('book_source_links')
    .upsert({
      book_id:         bookId,
      source:          'llm_inference',
      source_book_id:  `book:${bookId}`,
      raw_payload:     { model, inferred_subjects: subjects },
      last_fetched_at: new Date().toISOString(),
      fetch_status:    status,
    }, {
      onConflict:       'book_id,source',
      ignoreDuplicates: false,
    });
  if (error) {
    console.warn(`${LOG} book_source_links upsert failed for ${bookId} — ${error.message}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function run() {
  const { dryRun, batchSize, includeSparse, force, minDescription } = parseArgs(process.argv);

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anonKey     = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
  const authKey     = serviceKey || anonKey;
  const keyLabel    = serviceKey ? 'service-role' : 'anon';

  if (!supabaseUrl || !authKey) {
    console.error(`${LOG} Missing EXPO_PUBLIC_SUPABASE_URL or auth key`);
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      `${LOG} Missing OPENAI_API_KEY — set it via the environment secrets manager.\n` +
      `${LOG} For Replit AI Integration (no personal key needed), use the OpenAI blueprint.`,
    );
    process.exit(1);
  }

  const db = createClient(supabaseUrl, authKey);

  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

  console.log(`${LOG} === LLM Subject Inference ===`);
  console.log(
    `${LOG} auth=${keyLabel}  dryRun=${dryRun}  batchSize=${batchSize}  ` +
    `includeSparse=${includeSparse}  force=${force}  ` +
    `minDesc=${minDescription}  model=${model}`,
  );
  if (dryRun) console.log(`${LOG} DRY RUN — no writes will be made\n`);

  // ── Step 1: fetch candidates ─────────────────────────────────────────────
  // Priority 1: null subjects
  const { data: p1Data, error: p1Err } = await db
    .from('books')
    .select('id, title, author, description, subjects, isbn13, isbn')
    .is('subjects', null)
    .not('description', 'is', null)
    .order('id', { ascending: true })
    .limit(batchSize * 3); // over-fetch so we can filter by description length

  if (p1Err) {
    console.error(`${LOG} priority-1 query failed — ${p1Err.message}`);
    process.exit(1);
  }

  let candidates: BookRow[] = ((p1Data ?? []) as BookRow[])
    .filter(b => (b.description ?? '').length >= minDescription);

  // Priority 2: sparse subjects (1-2) when --include-sparse is set
  if (includeSparse && candidates.length < batchSize) {
    const slots = batchSize - candidates.length;
    const { data: p2Data, error: p2Err } = await db
      .from('books')
      .select('id, title, author, description, subjects, isbn13, isbn')
      .not('subjects', 'is', null)
      .not('description', 'is', null)
      .order('id', { ascending: true })
      .limit(batchSize * 5);

    if (p2Err) {
      console.error(`${LOG} priority-2 query failed — ${p2Err.message}`);
      process.exit(1);
    }

    const sparse = ((p2Data ?? []) as BookRow[])
      .filter(b =>
        Array.isArray(b.subjects) &&
        b.subjects.length < 3 &&
        (b.description ?? '').length >= minDescription,
      )
      .slice(0, slots);

    candidates = [...candidates, ...sparse];
  }

  candidates = candidates.slice(0, batchSize);

  // ── Step 2: idempotency filter ───────────────────────────────────────────
  const alreadyInferred = force
    ? new Set<string>()
    : await fetchAlreadyInferred(db, candidates.map(b => b.id));

  const eligible         = candidates.filter(b => !alreadyInferred.has(b.id));
  const skippedAlready   = candidates.length - eligible.length;
  const totalNoDesc      = ((p1Data ?? []) as BookRow[]).filter(b => (b.description ?? '').length < minDescription).length;

  console.log(
    `${LOG} candidates=${candidates.length}  ` +
    `eligible=${eligible.length}  ` +
    `skipped_already_done=${skippedAlready}  ` +
    `skipped_no_description=${totalNoDesc}`,
  );

  if (eligible.length === 0) {
    console.log(`${LOG} Nothing to infer — all candidates already processed.`);
    console.log(`${LOG} Use --force to re-infer, or --include-sparse for sparse books.`);
    return;
  }

  // ── Step 3: infer and write ───────────────────────────────────────────────
  let inferred         = 0;
  let failed           = 0;
  let skippedThinDesc  = 0;
  let totalInputTokens = 0;
  let totalOutputTokens= 0;

  for (const book of eligible) {
    const t = String(book.title  ?? '').trim();
    const a = String(book.author ?? '').trim();
    const d = String(book.description ?? '').trim();

    if (d.length < minDescription) {
      skippedThinDesc++;
      console.log(`${LOG} skip "${t}" — description too short (${d.length} chars)`);
      continue;
    }

    console.log(`${LOG} inferring "${t}" (${d.length} chars)…`);

    const result = await inferSubjectsFromLLM(t, a, d);

    if (!result) {
      failed++;
      console.log(`${LOG} inference returned nothing for "${t}"`);
      await writeProviderLink(db, book.id, model, [], 'failed', dryRun);
      continue;
    }

    totalInputTokens  += result.inputTokens;
    totalOutputTokens += result.outputTokens;

    const preview = result.subjects.slice(0, 3).join(', ');
    console.log(
      `${LOG} inferred "${t}" [${book.subjects?.length ?? 0} → ${result.subjects.length}] ` +
      `(${preview}${result.subjects.length > 3 ? '…' : ''}) ` +
      `[${result.inputTokens}+${result.outputTokens} tok]`,
    );

    if (!dryRun) {
      const { error: writeErr } = await db
        .from('books')
        .update({ subjects: result.subjects })
        .eq('id', book.id);

      if (writeErr) {
        failed++;
        console.log(`${LOG} db write failed for "${t}" — ${writeErr.message}`);
        continue;
      }

      await writeProviderLink(db, book.id, result.model, result.subjects, 'success', dryRun);
    }

    inferred++;
  }

  // ── Step 4: summary ──────────────────────────────────────────────────────
  const totalBooks = 304; // approximate known catalog size for coverage %
  const estInputCost  = (totalInputTokens  / 1_000_000) * 0.15; // gpt-4o-mini input
  const estOutputCost = (totalOutputTokens / 1_000_000) * 0.60; // gpt-4o-mini output
  const estTotalCost  = estInputCost + estOutputCost;

  console.log(`\n${LOG} ── Summary ────────────────────────────────────────────`);
  console.log(`${LOG}   candidates           : ${candidates.length}`);
  console.log(`${LOG}   eligible             : ${eligible.length}`);
  console.log(`${LOG}   inferred             : ${inferred}`);
  console.log(`${LOG}   failed               : ${failed}`);
  console.log(`${LOG}   skipped_already_done : ${skippedAlready}`);
  console.log(`${LOG}   skipped_no_desc      : ${totalNoDesc}`);
  console.log(`${LOG}   tokens used          : ${totalInputTokens} in + ${totalOutputTokens} out`);
  console.log(`${LOG}   estimated cost       : $${estTotalCost.toFixed(4)} (gpt-4o-mini pricing)`);
  if (dryRun) console.log(`${LOG}   (no changes written — dry run)`);
  console.log(`${LOG} ────────────────────────────────────────────────────────`);

  if (inferred === 0 && failed === eligible.length) {
    console.log(`\n${LOG} All inference attempts failed. Check OPENAI_API_KEY and model availability.`);
  }
}

run().catch(err => {
  console.error(`${LOG} Fatal error:`, err);
  process.exit(1);
});
