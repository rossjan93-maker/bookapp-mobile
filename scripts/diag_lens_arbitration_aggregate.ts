// =============================================================================
// scripts/diag_lens_arbitration_aggregate.ts
//
// READ-ONLY aggregator for `[LENS_ARBITRATION]` shadow logs captured per
// `docs/runbook_lens_arbitration_observation.md`. Consumes per-scenario log
// files; emits the markdown report described in the user request.
//
// This is the smallest fallback when the live recommender cannot be invoked
// headlessly from Node (see `docs/diag_lens_arbitration_blocker_2026-05-19.md`).
// It does NOT run the recommender, does NOT touch Supabase, does NOT mutate
// any state. It only parses log lines you have already captured from a
// FORENSIC_USER_ID-gated dev session and produces per-scenario tables +
// aggregates + a threshold-based decision recommendation.
//
// Usage:
//   npx tsx scripts/diag_lens_arbitration_aggregate.ts \
//     --S0 .local/lens_arb_logs/2026-05-19_S0_baseline.log \
//     --S1 .local/lens_arb_logs/2026-05-19_S1_light.log \
//     --S2 .local/lens_arb_logs/2026-05-19_S2_palate.log \
//     --S3 .local/lens_arb_logs/2026-05-19_S3_less-dark.log \
//     --S4 .local/lens_arb_logs/2026-05-19_S4_fast.log \
//     --out docs/diag_lens_arbitration_observation_2026-05-19.md
//
// Each log file is the raw stdout/console of a dev session — the script
// extracts lines beginning with `[LENS_ARBITRATION] {…json…}` and ignores
// everything else. Order in the file = order in the deck (rank 1..10).
//
// What the report covers (from the [LENS_ARBITRATION] payload):
//   rank, title, durable_taste_fit, lens_fit, taste_fit_but_lens_mismatch,
//   intensity bucket, emotional_weight bucket, steering_mode, lens_active,
//   lens_kind, would_eject_under_mood_first, lens_fit_alternative_nearby,
//   AND per-scenario aggregates: n_tlm, n_wem, lfa_any, slot1_tlm,
//   classifier_miss_rate.
//
// What this report does NOT cover (require a separate capture or a small
// DEV-log extension — see blocker doc):
//   author, visible reason, tone/pace/complexity confidences,
//   market_position, finalGate hardExclusion reason.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';

type Line = {
  // Phase 1 core payload (12 keys):
  r: number; t: string; dtf: boolean;
  lf: 'match' | 'neutral' | 'mismatch';
  tlm: boolean; int: string; wt: string;
  sm: 'taste_first' | 'balanced' | 'mood_first';
  la: boolean; lk: string;
  wem: boolean; lfa: boolean;
  // Phase 1.1 observation-assist additions (7 keys, all optional for
  // backward compatibility with logs captured before Phase 1.1 shipped):
  au?: string;
  vr?: string;
  tn?: string;
  pc?: string;
  cx?: string;
  mp?: string | null;
  fg?: string | null;
};

const SCENARIOS = ['S0', 'S1', 'S2', 'S3', 'S4'] as const;
type ScenarioId = typeof SCENARIOS[number];
const SCENARIO_LABELS: Record<ScenarioId, string> = {
  S0: 'Baseline (no lens)',
  S1: 'Light & accessible',
  S2: 'Short & light / palate cleanser',
  S3: 'Less dark',
  S4: 'Fast-paced / immersive',
};

function parseArgs(): { inputs: Partial<Record<ScenarioId, string>>; out: string; combined: string | null } {
  const argv = process.argv.slice(2);
  const inputs: Partial<Record<ScenarioId, string>> = {};
  let out = `docs/diag_lens_arbitration_observation_${new Date().toISOString().slice(0, 10)}.md`;
  let combined: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out = argv[++i]; continue; }
    if (a === '--combined') { combined = argv[++i]; continue; }
    const m = a.match(/^--(S[0-4])$/);
    if (m) { inputs[m[1] as ScenarioId] = argv[++i]; continue; }
  }
  return { inputs, out, combined };
}

// Parse the combined JSON capture format emitted by the browser-console
// snippet documented in `docs/runbook_lens_arbitration_observation.md` §3.
// Shape: { S0: Line[], S1: Line[], ..., S4: Line[] }. Keys not in the
// SCENARIOS list are ignored. Each Line must already match the [LENS_ARBITRATION]
// payload shape — no console-prefix stripping needed because the snippet
// captures the parsed object, not the raw log line.
function parseCombinedFile(file: string): Record<ScenarioId, Line[]> {
  const out: Record<ScenarioId, Line[]> = { S0: [], S1: [], S2: [], S3: [], S4: [] };
  if (!fs.existsSync(file)) {
    console.error(`  ⚠ missing combined file: ${file}`);
    return out;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`  ⚠ unparseable combined JSON in ${file}: ${(err as Error).message}`);
    return out;
  }
  for (const sid of SCENARIOS) {
    const rows = parsed?.[sid];
    if (Array.isArray(rows)) {
      out[sid] = (rows as Line[]).sort((a, b) => a.r - b.r);
    }
  }
  return out;
}

function parseLogFile(file: string): Line[] {
  if (!fs.existsSync(file)) {
    console.error(`  ⚠ missing log file: ${file}`);
    return [];
  }
  const lines: Line[] = [];
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  for (const l of raw) {
    const m = l.match(/\[LENS_ARBITRATION\]\s+(\{.+\})\s*$/);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]) as Line;
      lines.push(obj);
    } catch {
      console.error(`  ⚠ unparseable [LENS_ARBITRATION] line in ${file}: ${l.slice(0, 100)}`);
    }
  }
  return lines.sort((a, b) => a.r - b.r);
}

type Aggregates = {
  n_tlm: number;
  n_wem: number;
  lfa_any: boolean;
  slot1_tlm: boolean;
  classifier_miss_rate: number;
  steering_mode: string;
  lens_kind: string;
  lens_active: boolean;
  n_lines: number;
};

function aggregate(lines: Line[]): Aggregates {
  const n_tlm = lines.filter(l => l.tlm).length;
  const n_wem = lines.filter(l => l.wem).length;
  const lfa_any = lines.some(l => l.lfa);
  const slot1 = lines.find(l => l.r === 1);
  const slot1_tlm = slot1?.tlm ?? false;
  const isUnk = (s: string) => /^unknown\//.test(s);
  const classifierMisses = lines.filter(l => isUnk(l.int) && isUnk(l.wt)).length;
  const classifier_miss_rate = lines.length === 0 ? 0 : classifierMisses / lines.length;
  return {
    n_tlm, n_wem, lfa_any, slot1_tlm,
    classifier_miss_rate,
    steering_mode: lines[0]?.sm ?? '(none)',
    lens_kind:     lines[0]?.lk ?? '(none)',
    lens_active:   lines[0]?.la ?? false,
    n_lines: lines.length,
  };
}

function formatScenarioTable(id: ScenarioId, lines: Line[], agg: Aggregates): string {
  const BT = '`'; // backtick — cannot appear unescaped inside a template literal
  const smWarn = agg.steering_mode !== 'balanced' ? ` ⚠ runbook expects ${BT}balanced${BT}` : '';
  const linesWarn = agg.n_lines !== 10 ? ' ⚠ expected 10' : '';
  const header = [
    `### ${id} · ${SCENARIO_LABELS[id]}`,
    ``,
    `- **Lines parsed:** ${agg.n_lines}${linesWarn}`,
    `- **Steering mode (${BT}sm${BT}):** ${BT}${agg.steering_mode}${BT}${smWarn}`,
    `- **Lens active (${BT}la${BT}):** ${agg.lens_active}`,
    `- **Lens kind (${BT}lk${BT}):** ${BT}${agg.lens_kind}${BT}`,
    ``,
  ].join('\n');

  if (lines.length === 0) {
    return header + '_No `[LENS_ARBITRATION]` lines found in input — see blocker doc §C for capture steps._\n';
  }

  const cols = ['r', 'title', 'dtf', 'lf', 'tlm', 'int', 'wt', 'wem', 'lfa'];
  const rows = lines.map(l => [
    String(l.r),
    `${BT}${(l.t || '').replace(/`/g, '\\`').slice(0, 28)}${BT}`,
    l.dtf ? '✓' : '·',
    l.lf,
    l.tlm ? '✗' : '·',
    l.int,
    l.wt,
    l.wem ? '✗' : '·',
    l.lfa ? '✓' : '·',
  ]);
  const table = [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');

  // Phase 1.1 — second table for the observation-assist fields. Rendered
  // only when at least one row has any of them (logs captured before
  // Phase 1.1 shipped will silently omit this block).
  const hasAssist = lines.some(l => l.au !== undefined || l.vr !== undefined || l.tn !== undefined || l.pc !== undefined || l.cx !== undefined || l.mp !== undefined || l.fg !== undefined);
  let assistTable = '';
  if (hasAssist) {
    const cols2 = ['r', 'au', 'vr', 'tn', 'pc', 'cx', 'mp', 'fg'];
    const rows2 = lines.map(l => [
      String(l.r),
      `${BT}${(l.au ?? '').replace(/`/g, '\\`').slice(0, 28)}${BT}`,
      `${BT}${(l.vr ?? '').replace(/`/g, '\\`').slice(0, 80)}${BT}`,
      l.tn ?? '·',
      l.pc ?? '·',
      l.cx ?? '·',
      l.mp ?? '·',
      l.fg ?? '·',
    ]);
    assistTable = '\n\n_Observation-assist fields (Phase 1.1):_\n\n'
      + [
          `| ${cols2.join(' | ')} |`,
          `| ${cols2.map(() => '---').join(' | ')} |`,
          ...rows2.map(r => `| ${r.join(' | ')} |`),
        ].join('\n');
  }

  const aggBlock = [
    ``,
    `**Aggregates**`,
    `- \`n_tlm\` = **${agg.n_tlm}** / ${agg.n_lines}`,
    `- \`n_wem\` = **${agg.n_wem}** / ${agg.n_lines}`,
    `- \`lfa_any\` = **${agg.lfa_any}**`,
    `- \`slot1_tlm\` = **${agg.slot1_tlm}**`,
    `- \`classifier_miss_rate\` = **${(agg.classifier_miss_rate * 100).toFixed(0)}%** (both ${BT}int${BT} and ${BT}wt${BT} are ${BT}unknown/unk${BT})`,
    ``,
  ].join('\n');

  return header + table + assistTable + aggBlock;
}

function decide(allAgg: Record<ScenarioId, Aggregates>): { verdict: string; rationale: string[] } {
  const lensActive: ScenarioId[] = (['S1', 'S2', 'S3', 'S4'] as ScenarioId[]).filter(id => allAgg[id]?.lens_active);
  const tlmHighScenarios = lensActive.filter(id => allAgg[id] && allAgg[id].n_tlm >= 4).length;
  const wemAnyScenario   = lensActive.some(id => allAgg[id] && allAgg[id].n_wem >= 2);
  const slot1Anywhere    = lensActive.some(id => allAgg[id]?.slot1_tlm);
  const lfaScenarios     = lensActive.filter(id => allAgg[id]?.lfa_any).length;
  const avgClassifierMiss = lensActive.length === 0 ? 0
    : lensActive.reduce((s, id) => s + (allAgg[id]?.classifier_miss_rate ?? 0), 0) / lensActive.length;
  const tlmLowEverywhere = lensActive.every(id => (allAgg[id]?.n_tlm ?? 0) <= 1);
  const noEjections      = lensActive.every(id => (allAgg[id]?.n_wem ?? 0) === 0);
  const noSlot1Anywhere  = lensActive.every(id => !(allAgg[id]?.slot1_tlm));

  const rationale: string[] = [];

  // Insufficient input — be explicit, do not invent a verdict.
  const allEmpty = SCENARIOS.every(id => (allAgg[id]?.n_lines ?? 0) === 0);
  if (allEmpty) {
    return {
      verdict: '**Inconclusive — no scenario logs were parsed.** Re-run the capture per runbook §1–§3 before re-running this aggregator.',
      rationale: ['All five inputs were missing or empty.'],
    };
  }
  if (lensActive.length === 0) {
    return {
      verdict: '**Inconclusive — none of S1–S4 had an active lens** (`la === false` in every input). Confirm the lens was actually applied per runbook §2 `lk` substring check.',
      rationale: ['No lens-active scenario captured; the comparison the runbook needs is unavailable.'],
    };
  }

  // Calibration-first rule fires BEFORE proceed — silent classifier
  // invalidates the proceed signal.
  if (avgClassifierMiss > 0.35) {
    rationale.push(`Average classifier miss rate across lens-active scenarios is ${(avgClassifierMiss * 100).toFixed(0)}% (> 35% threshold).`);
    rationale.push('A high miss rate means `tlm` / `wem` are being computed against silent BookEvidence axes; arbitration math built on that will eject books on absence of evidence, not presence of conflict.');
    return {
      verdict: '**2. Calibrate BookEvidence first.** Do NOT open Phase 2 planning yet. Widen `INTENSITY_*` / `EMOTIONAL_WEIGHT_*` SignalSets (Batch C slice C1 candidate) and/or extend description-derivation corpus, then re-observe.',
      rationale,
    };
  }

  // Retrieval-expansion rule fires next — if alternatives never exist,
  // arbitration cannot find them.
  if (lfaScenarios <= 1 && tlmHighScenarios >= 1) {
    rationale.push(`Only ${lfaScenarios} of ${lensActive.length} lens-active scenarios show \`lfa_any === true\`, yet \`n_tlm ≥ 4\` in ${tlmHighScenarios} scenario(s).`);
    rationale.push('Disagreement is present but no lens-friendly alternatives exist in deck positions 11–25. Phase 2 arbitration cannot promote what was never retrieved.');
    return {
      verdict: '**3. Expand retrieval first.** Do NOT open Phase 2 planning yet. Widen branch-planner anchors / quotas for lens-active branches (or relax `LIKED_SUBJECT_AVOID_GUARDS` under specific lenses), then re-observe.',
      rationale,
    };
  }

  // Proceed-to-Phase-2 rule.
  if (tlmHighScenarios >= 2 && wemAnyScenario && slot1Anywhere) {
    rationale.push(`\`n_tlm ≥ 4\` in ${tlmHighScenarios} of ${lensActive.length} lens-active scenarios (demand).`);
    rationale.push(`At least one scenario has \`n_wem ≥ 2\` (supply: alternatives the recommender already produced).`);
    rationale.push('At least one scenario shows the #1 slot as taste-fit-but-lens-mismatch (highest-cost failure mode).');
    return {
      verdict: '**1. Proceed to Phase 2 steering planning.** Both demand (`n_tlm`) and supply (`n_wem`) signals are present. Address the architect caveat (validator hardening — runbook §7) as a Phase 2 pre-req.',
      rationale,
    };
  }

  // Defer rule — everything quiet.
  if (tlmLowEverywhere && noSlot1Anywhere && noEjections) {
    rationale.push('`n_tlm` ≤ 1 in every lens-active scenario; the lens is already steering the visible top-10.');
    rationale.push('No `slot1_tlm` in any scenario; the highest-cost failure mode is absent.');
    rationale.push('No `wem` in any scenario; arbitration would have no alternative to promote.');
    return {
      verdict: '**4. Defer steering UI.** Keep the diagnostic in place. Archive this report alongside `docs/runbook_lens_arbitration_observation.md`.',
      rationale,
    };
  }

  // Mixed signal.
  rationale.push(`tlmHighScenarios=${tlmHighScenarios}, wemAny=${wemAnyScenario}, slot1Any=${slot1Anywhere}, lfaScenarios=${lfaScenarios}, avgMiss=${(avgClassifierMiss * 100).toFixed(0)}%.`);
  return {
    verdict: '**Inconclusive / mixed signal.** Re-run observation on a second test account whose durable taste leans further from the scenario lens (runbook §5 "Inconclusive" branch). Capture cold-cache rebuilds before deciding.',
    rationale,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
const { inputs, out, combined } = parseArgs();

const combinedRows: Record<ScenarioId, Line[]> = combined
  ? parseCombinedFile(combined)
  : { S0: [], S1: [], S2: [], S3: [], S4: [] };

const parsed: Record<ScenarioId, Line[]> = { S0: [], S1: [], S2: [], S3: [], S4: [] };
const agg: Record<ScenarioId, Aggregates> = {} as any;
for (const id of SCENARIOS) {
  const file = inputs[id];
  // Per-scenario --S{n} flags take precedence over --combined entries for
  // the same scenario, so a partial re-capture can override the combined
  // file without re-running every scenario.
  const lines = file ? parseLogFile(file) : combinedRows[id];
  parsed[id] = lines;
  agg[id] = aggregate(lines);
  const src = file ? path.basename(file) : (combined && lines.length > 0 ? `${path.basename(combined)}#${id}` : '(no file)');
  console.log(`  ${id}: ${src} → ${lines.length} line(s)`);
}

const decision = decide(agg);

const date = new Date().toISOString().slice(0, 10);
const sections: string[] = [];
sections.push(`# [LENS_ARBITRATION] Observation Report — ${date}`);
sections.push('');
sections.push(`Generated by \`scripts/diag_lens_arbitration_aggregate.ts\` from logs captured per \`docs/runbook_lens_arbitration_observation.md\`. Read-only. Aggregates only \`[LENS_ARBITRATION]\` lines from the input files; does NOT invoke the recommender, does NOT touch Supabase.`);
sections.push('');
sections.push('## Executive summary');
sections.push('');
sections.push(decision.verdict);
sections.push('');
sections.push('**Rationale**');
for (const r of decision.rationale) sections.push(`- ${r}`);
sections.push('');
sections.push('## Per-scenario detail');
sections.push('');
for (const id of SCENARIOS) {
  sections.push(formatScenarioTable(id, parsed[id], agg[id]));
  sections.push('');
}
sections.push('## Field-coverage note');
sections.push('');
sections.push('The `[LENS_ARBITRATION]` payload after Phase 1.1 carries 19 keys: 12 Phase-1 core fields (`r, t, dtf, lf, tlm, int, wt, sm, la, lk, wem, lfa`) plus 7 observation-assist fields (`au, vr, tn, pc, cx, mp, fg`). The assist fields are emitted as shadow-only diagnostic context and rendered in a second per-scenario table beneath the core table. Pre-Phase-1.1 logs are still accepted — the assist table is omitted when no row carries any assist field, so the original-shape report is byte-identical for older captures. `fg` reflects the in-process intent filter (`_intent_trace.excluded_by`); queue-boundary `finalGate` runs AFTER the log fires, so hard-excluded books never appear in the top-10 and `fg` is typically `null` on visible rows.');
sections.push('');
sections.push('## Honest limits of `wem` and `lfa`');
sections.push('');
sections.push('Both are Pattern-A pure derivations (runbook §4):');
sections.push('- `wem` can **overstate** ejectability (low-leaning candidates in 11–25 may themselves be low-scoring on durable taste).');
sections.push('- `wem` can **understate** Phase-2 impact (it cannot see candidates retrieval dropped before slot 25).');
sections.push('- A `lf === \'mismatch\'` verdict on a book with `int = unknown/unk` AND `wt = unknown/unk` is a classifier miss, not a real mismatch. The `classifier_miss_rate` aggregate above flags this.');
sections.push('');
sections.push('## Decision-thresholds reference');
sections.push('');
sections.push('See `docs/runbook_lens_arbitration_observation.md` §5. This script encodes the same thresholds verbatim (Calibrate first → Expand retrieval first → Proceed → Defer; in that order, first-match-wins).');

const outAbs = path.resolve(out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, sections.join('\n') + '\n', 'utf8');
console.log(`\n  ✓ wrote ${out}`);
console.log(`\n  verdict: ${decision.verdict.split('\n')[0]}`);
