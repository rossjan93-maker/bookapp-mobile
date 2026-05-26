// =============================================================================
// split_combined_capture.ts
//
// READ-ONLY converter: takes a combined capture JSON produced by
// `scripts/browser_console_capture_snippet.js` (see
// docs/operator_runbook_phase_b_capture.md) and writes the 5 per-scenario
// `.log` files that `scripts/diag_lens_arbitration_aggregate.ts` consumes.
//
// Why a splitter instead of teaching the aggregator the combined format:
// the aggregator is the load-bearing diagnostic and its CLI shape is
// already pinned in multiple docs + tooling. The combined JSON is purely
// an operator-convenience export; this splitter restores the canonical
// input shape without touching the aggregator.
//
// Usage:
//   npx tsx scripts/split_combined_capture.ts \
//     .local/lens_arb_logs/readstack_phase_b_capture_YYYY-MM-DD.json \
//     [--out-dir .local/lens_arb_logs] \
//     [--date YYYY-MM-DD]
//
// Output (with default flags):
//   .local/lens_arb_logs/<date>_S0_baseline.log
//   .local/lens_arb_logs/<date>_S1_light.log
//   .local/lens_arb_logs/<date>_S2_palate.log
//   .local/lens_arb_logs/<date>_S3_less-dark.log
//   .local/lens_arb_logs/<date>_S4_fast.log
//
// Also prints the exact aggregator command to paste next.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';

type Bucket = {
  startedAt?: string;
  lensArb:   string[];
  coldStart: string[];
  bookEv:    string[];
  finalGate: string[];
  rawLines:  string[];
};
type Capture = {
  schema:     string;
  capturedAt: string;
  exportedAt: string;
  scenarios:  Record<string, Bucket>;
};

const SCENARIO_SUFFIX: Record<string, string> = {
  S0: 'baseline',
  S1: 'light',
  S2: 'palate',
  S3: 'less-dark',
  S4: 'fast',
};

function parseFlag(name: string): string | undefined {
  const pre = `--${name}=`;
  const eqHit = process.argv.find(a => a.startsWith(pre));
  if (eqHit) return eqHit.slice(pre.length);
  // Also accept `--name value` (space-separated).
  const idx = process.argv.indexOf(`--${name}`);
  if (idx > -1 && idx + 1 < process.argv.length) {
    const next = process.argv[idx + 1];
    if (!next.startsWith('--')) return next;
  }
  return undefined;
}

const inputArg = process.argv[2];
if (!inputArg || inputArg.startsWith('--')) {
  console.error('Usage: npx tsx scripts/split_combined_capture.ts <capture.json> [--out-dir DIR] [--date YYYY-MM-DD]');
  process.exit(2);
}
const inputPath = path.resolve(inputArg);
if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(2);
}

const raw = fs.readFileSync(inputPath, 'utf8');
let cap: Capture;
try {
  cap = JSON.parse(raw) as Capture;
} catch (e) {
  console.error('Failed to parse capture JSON:', (e as Error).message);
  process.exit(2);
}
if (!cap.schema?.startsWith('readstack_phase_b_capture/')) {
  console.warn(`[warn] schema=${cap.schema} (expected readstack_phase_b_capture/v1)`);
}

const outDir = path.resolve(parseFlag('out-dir') ?? '.local/lens_arb_logs');
const date   = parseFlag('date') ?? new Date().toISOString().slice(0, 10);
fs.mkdirSync(outDir, { recursive: true });

const outPaths: Record<string, string> = {};
const summary: string[] = [];

for (const id of ['S0', 'S1', 'S2', 'S3', 'S4'] as const) {
  const bucket = cap.scenarios[id];
  const suffix = SCENARIO_SUFFIX[id];
  const outPath = path.join(outDir, `${date}_${id}_${suffix}.log`);
  if (!bucket || !bucket.rawLines || bucket.rawLines.length === 0) {
    fs.writeFileSync(outPath, '');
    summary.push(`  ${id} → ${outPath}  (empty — scenario not captured)`);
    outPaths[id] = outPath;
    continue;
  }
  fs.writeFileSync(outPath, bucket.rawLines.join('\n') + '\n');
  outPaths[id] = outPath;
  summary.push(
    `  ${id} → ${outPath}\n` +
    `       lensArb=${bucket.lensArb.length}  ` +
    `coldStart=${bucket.coldStart.length}  ` +
    `bookEv=${bucket.bookEv.length}  ` +
    `finalGate=${bucket.finalGate.length}`
  );
}

console.log(`[split] read ${inputPath}`);
console.log(`[split] capturedAt=${cap.capturedAt}  exportedAt=${cap.exportedAt}`);
console.log(`[split] wrote 5 per-scenario log files to ${outDir}:`);
console.log(summary.join('\n'));
console.log(`\n[split] next command:\n`);
console.log(
  `npx tsx scripts/diag_lens_arbitration_aggregate.ts \\\n` +
  `  --S0 ${outPaths.S0} \\\n` +
  `  --S1 ${outPaths.S1} \\\n` +
  `  --S2 ${outPaths.S2} \\\n` +
  `  --S3 ${outPaths.S3} \\\n` +
  `  --S4 ${outPaths.S4} \\\n` +
  `  --out docs/diag_phase_b_observation_${date}.md\n`
);
