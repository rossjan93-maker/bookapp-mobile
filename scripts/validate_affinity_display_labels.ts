#!/usr/bin/env -S npx tsx
// ─────────────────────────────────────────────────────────────────────────────
// validate_affinity_display_labels.ts
//
// Pins two contracts after the Scenario B P3A live-smoke display-label fix:
//
//   1. Exhaustiveness — every AffinityKey union member has a
//      non-empty entry in AFFINITY_DISPLAY_LABELS. TypeScript's
//      `Record<AffinityKey, string>` enforces this at compile time;
//      this validator catches it at CI time so a future widening of
//      `AffinityKey` that forgets to update the map fails loud here
//      rather than only at typecheck.
//
//   2. Anti-leak — running the composer against synthetic stated-taste
//      contributions for each AffinityKey produces visible reason
//      strings that DO NOT contain the raw snake_case key. This is the
//      direct regression pin for the Scenario B "Matches your stated
//      thriller_mystery preference" leak.
//
// Spec reference: P3A Scenario B display-label fix authorization.
// ─────────────────────────────────────────────────────────────────────────────
import {
  AFFINITY_DISPLAY_LABELS,
  affinityDisplayLabel,
  type AffinityKey,
} from '../lib/taxonomy/genres';
import { composeExplanation, deriveBackcompatReasons } from '../lib/explanations/compose';

let failures = 0;
function check(label: string, ok: boolean, hint?: string): void {
  console.log(`  ${ok ? '✔' : '✘'} ${label}${ok ? '' : ` — ${hint}`}`);
  if (!ok) failures++;
}

// Source-of-truth list of every AffinityKey. Adding one here AND in
// `lib/taxonomy/genres.ts` AffinityKey union AND in
// AFFINITY_DISPLAY_LABELS keeps the three in lockstep.
const ALL_AFFINITY_KEYS: readonly AffinityKey[] = [
  'literary',
  'fantasy_scifi',
  'thriller_mystery',
  'romance',
  'horror',
  'memoir_bio',
  'nonfiction',
] as const;

console.log('─ validate_affinity_display_labels — Scenario B copy fix ─');

// ── §1 Exhaustiveness ──────────────────────────────────────────────────────
console.log('\n§1 — exhaustiveness');
for (const key of ALL_AFFINITY_KEYS) {
  const label = AFFINITY_DISPLAY_LABELS[key];
  check(`AFFINITY_DISPLAY_LABELS["${key}"] is a non-empty string`,
    typeof label === 'string' && label.length > 0,
    `got=${JSON.stringify(label)}`);
  check(`affinityDisplayLabel("${key}") returns non-empty`,
    affinityDisplayLabel(key).length > 0);
}

// ── §2 Anti-leak — no snake_case key surfaces in visible copy ─────────────
console.log('\n§2 — no raw snake_case in visible composer copy');
function visibleReasonForStated(key: AffinityKey, kind: 'favorite' | 'softavoid'): string[] {
  // Minimum bundle that triggers phrasingForStated().
  const bundle = {
    score: 0.5,
    fitClass: 'core_fit' as const,
    retrieval: [],
    scoring: [
      {
        phase: 'scoring' as const,
        kind: 'stated_taste_fit' as const,
        value: kind === 'favorite' ? 0.10 : -0.10,
        source: 'stated_taste' as const,
        evidence: { matchedKind: kind, matchedKey: key },
      },
    ],
  };
  const result = composeExplanation(bundle as Parameters<typeof composeExplanation>[0]);
  // Inspect EVERY visible bucket the composer can emit through, not just
  // the backcompat reasons projection: favorite stated-taste lines land
  // in primary/secondary, but softavoid lines land in `cautions` and the
  // raw-key leak risk is identical on both surfaces. The bug we're
  // regression-pinning is at the `phrasingForStated` source, which feeds
  // both branches.
  const lines = [
    ...(result.primary ? [result.primary] : []),
    ...result.secondary,
    ...result.cautions,
    ...result.descriptive,
  ];
  return lines.map(l => l.text);
}
for (const key of ALL_AFFINITY_KEYS) {
  for (const kind of ['favorite', 'softavoid'] as const) {
    const reasons = visibleReasonForStated(key, kind);
    const joined = reasons.join(' || ');
    // Negative: raw snake_case key MUST NOT appear in visible text.
    if (/_/.test(key)) {
      check(`${key} / ${kind}: visible reasons do not contain raw "${key}"`,
        !joined.includes(key),
        `reasons=${JSON.stringify(reasons)}`);
    }
    // Positive: humanised label MUST appear when label exists and the
    // contribution is above the display floor (it is — value=±0.10).
    const label = AFFINITY_DISPLAY_LABELS[key];
    check(`${key} / ${kind}: visible reasons contain humanised label "${label}"`,
      joined.toLowerCase().includes(label.toLowerCase()),
      `reasons=${JSON.stringify(reasons)}`);
  }
}

// ── §3 Specific Scenario B regression pin ─────────────────────────────────
console.log('\n§3 — Scenario B regression pin');
{
  const reasons = visibleReasonForStated('thriller_mystery', 'favorite');
  const joined = reasons.join(' || ');
  check('Scenario B: "thriller_mystery" never appears in visible reasons',
    !joined.includes('thriller_mystery'),
    `reasons=${JSON.stringify(reasons)}`);
  check('Scenario B: "thriller & mystery" appears in visible reasons',
    joined.toLowerCase().includes('thriller & mystery'),
    `reasons=${JSON.stringify(reasons)}`);
}

console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
