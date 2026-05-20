/**
 * Diagnostic — Cold-Start Adjacent Candidate Capture (read-only)
 *
 * For each Phase A Mystery+Thriller adjacency anchor in
 * `ADJACENT_RETRIEVAL_ANCHORS`, fetch the top-N Open Library candidates
 * (subject endpoint) and classify each against:
 *  - overlap with sibling primary `thriller_mystery` anchors
 *    (would Phase B retrieval just retread primary territory?)
 *  - BookEvidence C1 intensity / emotional-weight buckets
 *    (does the anchor return material the lens classifier can read?)
 *  - domestic-suspense saturation signal (the original Phase B motivation)
 *  - generic/popular-slop signal (no subjects, only 'fiction', mega edition_count)
 *
 * **Phase A invariants preserved.** This script:
 *  - does NOT modify any production behavior;
 *  - does NOT touch `BRANCH_QUOTAS.coldStartAdjacent` (still 0 everywhere);
 *  - does NOT consume or write to the live OL fetch path used by retrieval;
 *  - does NOT bump `recValidity` (stays rcv6);
 *  - does NOT commit a populated `FORENSIC_USER_ID`;
 *  - writes a single Markdown report to `.local/` (gitignored).
 *
 * Run: `npx tsx scripts/diag_cold_start_adjacent_candidates.ts`
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ADJACENT_RETRIEVAL_ANCHORS,
  AFFINITY_RETRIEVAL_SUBJECTS,
  GENRE_DEFS,
} from '../lib/taxonomy/genres';
import {
  INTENSITY_HIGH, INTENSITY_LOW,
  EMOTIONAL_WEIGHT_HIGH, EMOTIONAL_WEIGHT_LOW,
} from '../lib/evidence/signals';

const TOP_N            = 8;
const POLITENESS_MS    = 350;
const OUT_DIR          = '.local';
const OUT_FILE         = 'cold_start_adjacent_evidence_report.md';
const UA               = 'Readstack-Diag/0.1 (cold-start-adjacent evidence capture)';

// Sibling primary subjects under the shared thriller_mystery AffinityKey.
// Anything Phase B would retrieve that already lives here is "overlap" — i.e.,
// Phase A's main job (diversification away from primary saturation) didn't move.
const PRIMARY_SIBLING_SUBJECTS = new Set<string>([
  ...GENRE_DEFS.filter(g => g.affinityKey === 'thriller_mystery')
    .flatMap(g => g.olSubjects),
  ...AFFINITY_RETRIEVAL_SUBJECTS.thriller_mystery,
].map(s => s.toLowerCase()));

// Domestic-suspense saturation = the exact pool the original Lens Arbitration
// capture saw oversampled. Phase B is justified ONLY if adjacency anchors pull
// material OUT of this pool, not deeper into it.
const DOMESTIC_SUSPENSE_TAGS = new Set<string>([
  'domestic suspense', 'domestic thriller',
  'psychological thriller', 'psychological suspense',
]);

type OLDoc = {
  key?: string;
  title?: string;
  author_name?: string[];
  subject?: string[];
  first_publish_year?: number;
  edition_count?: number;
};

type Classified = {
  anchor:                string;
  title:                 string;
  author:                string;
  workKey:               string;
  firstYear:             number | null;
  editionCount:          number;
  subjectSampleCsv:      string;            // first 8 subjects, comma-separated
  overlapPrimary:        boolean;
  overlapTags:           string[];
  c1IntensityVerdict:    string;            // e.g. low(spec=1,broad=2)
  c1WeightVerdict:       string;
  isLikelyLowOrLight:    boolean;
  domesticSuspenseSat:   boolean;
  slopRisk:              boolean;
  slopReasons:           string[];
};

function wordBoundaryMatchCount(haystack: string, needles: readonly string[]): number {
  let n = 0;
  for (const needle of needles) {
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(haystack)) n++;
  }
  return n;
}

function bucketVerdict(specCount: number, broadCount: number, side: 'high'|'low'): string {
  // Mirror BookEvidence C1 partition-by-specificity-at-authoring rule:
  //   ≥1 specific OR ≥2 broad → strong-on-side
  //   single broad           → unknown (anti-escalation)
  const strong = specCount >= 1 || broadCount >= 2;
  if (!strong) return `unknown(spec=${specCount},broad=${broadCount})`;
  return `${side}(spec=${specCount},broad=${broadCount})`;
}

function classifyAxis(
  haystack: string,
  highSet:  readonly string[],
  lowSet:   readonly string[],
  highBroad: readonly string[],
  lowBroad:  readonly string[],
): string {
  const hSpec = wordBoundaryMatchCount(haystack, highSet);
  const hBroad = wordBoundaryMatchCount(haystack, highBroad);
  const lSpec = wordBoundaryMatchCount(haystack, lowSet);
  const lBroad = wordBoundaryMatchCount(haystack, lowBroad);
  const hStrong = hSpec >= 1 || hBroad >= 2;
  const lStrong = lSpec >= 1 || lBroad >= 2;
  if (hStrong && lStrong) return `medium(h_spec=${hSpec},h_broad=${hBroad},l_spec=${lSpec},l_broad=${lBroad})`;
  if (hStrong) return bucketVerdict(hSpec, hBroad, 'high');
  if (lStrong) return bucketVerdict(lSpec, lBroad, 'low');
  return `unknown(h=${hSpec}+${hBroad},l=${lSpec}+${lBroad})`;
}

function detectSlop(doc: OLDoc, subjects: string[]): { risk: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (subjects.length === 0) reasons.push('no_subjects');
  const onlyGeneric = subjects.length > 0 && subjects.every(s =>
    ['fiction', 'literature', 'novel', 'novels', 'english fiction'].includes(s.toLowerCase()));
  if (onlyGeneric) reasons.push('only_generic_fiction_tag');
  if ((doc.edition_count ?? 0) > 200 && subjects.length <= 2) reasons.push('mega_editions_thin_subjects');
  if (!doc.title || !doc.author_name || doc.author_name.length === 0) reasons.push('missing_title_or_author');
  return { risk: reasons.length > 0, reasons };
}

async function fetchAnchorTopN(anchor: string, n: number): Promise<OLDoc[]> {
  const subj = encodeURIComponent(anchor);
  // OL search endpoint by subject; we keep this distinct from the production
  // retrieval path (which uses fetchOLByAffinity / subject-name normalization).
  const url =
    `https://openlibrary.org/search.json?subject=${subj}` +
    `&limit=${n}` +
    `&fields=key,title,author_name,subject,first_publish_year,edition_count` +
    `&sort=editions`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    console.warn(`[diag] anchor=${anchor} HTTP ${res.status}`);
    return [];
  }
  const data = await res.json() as { docs?: OLDoc[] };
  return Array.isArray(data.docs) ? data.docs : [];
}

function classifyDoc(anchor: string, doc: OLDoc): Classified {
  const subjects = (doc.subject ?? []).map(s => s.toLowerCase());
  const subjectSample = subjects.slice(0, 8);
  const haystack = subjectSample.join(' | ');
  const overlap = subjectSample.filter(s => PRIMARY_SIBLING_SUBJECTS.has(s));
  const dsHit   = subjectSample.some(s => DOMESTIC_SUSPENSE_TAGS.has(s));
  const intensity = classifyAxis(haystack,
    INTENSITY_HIGH.specific, INTENSITY_LOW.specific,
    INTENSITY_HIGH.broad,    INTENSITY_LOW.broad);
  const weight    = classifyAxis(haystack,
    EMOTIONAL_WEIGHT_HIGH.specific, EMOTIONAL_WEIGHT_LOW.specific,
    EMOTIONAL_WEIGHT_HIGH.broad,    EMOTIONAL_WEIGHT_LOW.broad);
  const isLight = intensity.startsWith('low(') || weight.startsWith('low(');
  const slop = detectSlop(doc, subjects);
  return {
    anchor,
    title:               doc.title ?? '(untitled)',
    author:              (doc.author_name ?? [])[0] ?? '(unknown)',
    workKey:             doc.key ?? '',
    firstYear:           doc.first_publish_year ?? null,
    editionCount:        doc.edition_count ?? 0,
    subjectSampleCsv:    subjectSample.join(', '),
    overlapPrimary:      overlap.length > 0,
    overlapTags:         overlap,
    c1IntensityVerdict:  intensity,
    c1WeightVerdict:     weight,
    isLikelyLowOrLight:  isLight,
    domesticSuspenseSat: dsHit,
    slopRisk:            slop.risk,
    slopReasons:         slop.reasons,
  };
}

function md(rows: Classified[]): string {
  const byAnchor = new Map<string, Classified[]>();
  for (const r of rows) {
    if (!byAnchor.has(r.anchor)) byAnchor.set(r.anchor, []);
    byAnchor.get(r.anchor)!.push(r);
  }
  const lines: string[] = [];
  lines.push('# Cold-Start Adjacent — Shadow Evidence Report');
  lines.push('');
  lines.push(`_Generated by \`scripts/diag_cold_start_adjacent_candidates.ts\` · diagnostic-only · production unchanged._`);
  lines.push('');
  lines.push('Anchors are the Phase A Mystery + Thriller `ADJACENT_RETRIEVAL_ANCHORS`. ' +
    `Top-${TOP_N} OL candidates per anchor (sorted by edition count). ` +
    'Classification reuses C1 SignalSets directly so this report and the live ' +
    'BookEvidence classifier speak the same vocabulary.');
  lines.push('');
  lines.push('## Per-anchor summary');
  lines.push('');
  lines.push('| Anchor | N | Overlap-w-primary | Domestic-suspense saturation | Likely low/light | Slop risk |');
  lines.push('|---|---|---|---|---|---|');
  for (const [anchor, group] of byAnchor) {
    const n = group.length;
    const olp = group.filter(g => g.overlapPrimary).length;
    const dss = group.filter(g => g.domesticSuspenseSat).length;
    const llt = group.filter(g => g.isLikelyLowOrLight).length;
    const slp = group.filter(g => g.slopRisk).length;
    lines.push(`| \`${anchor}\` | ${n} | ${olp}/${n} | ${dss}/${n} | ${llt}/${n} | ${slp}/${n} |`);
  }
  lines.push('');
  lines.push('## Per-candidate detail');
  lines.push('');
  for (const [anchor, group] of byAnchor) {
    lines.push(`### Anchor: \`${anchor}\``);
    lines.push('');
    lines.push('| Title | Author | Yr | Editions | Overlap | DS-sat | C1 intensity | C1 weight | Likely-light | Slop | Subjects (sample) |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of group) {
      const t = (r.title.length > 38 ? r.title.slice(0, 36) + '…' : r.title).replace(/\|/g, '\\|');
      const a = (r.author.length > 22 ? r.author.slice(0, 20) + '…' : r.author).replace(/\|/g, '\\|');
      const subj = r.subjectSampleCsv.replace(/\|/g, '\\|');
      lines.push(
        `| ${t} | ${a} | ${r.firstYear ?? '?'} | ${r.editionCount} | ` +
        `${r.overlapPrimary ? '⚠️ '+r.overlapTags.join('/') : '—'} | ` +
        `${r.domesticSuspenseSat ? '⚠️' : '—'} | ${r.c1IntensityVerdict} | ${r.c1WeightVerdict} | ` +
        `${r.isLikelyLowOrLight ? '✅' : '—'} | ${r.slopRisk ? '⚠️ '+r.slopReasons.join('/') : '—'} | ${subj} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Aggregate rollup');
  lines.push('');
  const total = rows.length;
  const olp   = rows.filter(r => r.overlapPrimary).length;
  const dss   = rows.filter(r => r.domesticSuspenseSat).length;
  const llt   = rows.filter(r => r.isLikelyLowOrLight).length;
  const slp   = rows.filter(r => r.slopRisk).length;
  const unkI  = rows.filter(r => r.c1IntensityVerdict.startsWith('unknown')).length;
  const unkW  = rows.filter(r => r.c1WeightVerdict.startsWith('unknown')).length;
  lines.push(`- Total candidates: ${total}`);
  lines.push(`- Overlap with sibling primary subjects: ${olp}/${total} (${pct(olp,total)})`);
  lines.push(`- Domestic-suspense saturation hits: ${dss}/${total} (${pct(dss,total)})`);
  lines.push(`- Likely low/light by C1 classifier: ${llt}/${total} (${pct(llt,total)})`);
  lines.push(`- Slop risk: ${slp}/${total} (${pct(slp,total)})`);
  lines.push(`- C1 intensity \`unknown\` rate: ${unkI}/${total} (${pct(unkI,total)})`);
  lines.push(`- C1 weight \`unknown\` rate: ${unkW}/${total} (${pct(unkW,total)})`);
  return lines.join('\n') + '\n';
}

function pct(n: number, d: number): string {
  if (d === 0) return '0%';
  return `${Math.round((n/d)*100)}%`;
}

async function main() {
  console.log('[diag] cold-start adjacent candidate capture starting');
  console.log('[diag] Phase A invariant: BRANCH_QUOTAS.*.coldStartAdjacent =',
    '0 (production-inert); this script does not touch production retrieval.');
  const anchorsToProbe: Array<[string, readonly string[]]> = [
    ['mystery',  ADJACENT_RETRIEVAL_ANCHORS.mystery],
    ['thriller', ADJACENT_RETRIEVAL_ANCHORS.thriller],
  ];
  const all: Classified[] = [];
  for (const [gid, anchors] of anchorsToProbe) {
    for (const anchor of anchors) {
      console.log(`[diag] anchor: ${gid} → "${anchor}" (fetching top-${TOP_N})`);
      try {
        const docs = await fetchAnchorTopN(anchor, TOP_N);
        for (const doc of docs) all.push(classifyDoc(anchor, doc));
      } catch (e) {
        console.warn(`[diag] anchor "${anchor}" failed:`, (e as Error).message);
      }
      await new Promise(r => setTimeout(r, POLITENESS_MS));
    }
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, OUT_FILE);
  fs.writeFileSync(outPath, md(all), 'utf-8');
  console.log(`[diag] report written: ${outPath} (${all.length} candidates)`);
}

main().catch(e => { console.error('[diag] FATAL', e); process.exit(2); });
