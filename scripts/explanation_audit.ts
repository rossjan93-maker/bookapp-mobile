/**
 * scripts/explanation_audit.ts
 *
 * Audits the actual explanation text surfaced to users for the ranked For You feed.
 * Simulates buildExplanation() from RecCard.tsx (without React dependency) so the
 * output is exactly what appears on each card.
 *
 * Run with: npx tsx scripts/explanation_audit.ts
 */

// Polyfill Expo globals for Node.js execution context
(global as any).__DEV__ = false;

import { createClient }     from '@supabase/supabase-js';
import { computeTasteProfile } from '../lib/tasteProfile';
import {
  getCandidateBooks,
  getRankedRecs,
  type ScoredBook,
} from '../lib/recommender';

// ── Config ────────────────────────────────────────────────────────────────────

const AUDIT_USER_ID = '78d5d2c4-d513-4747-b77f-52898c2dd4a8';
const FEED_LIMIT    = 20;

// ── Supabase client ───────────────────────────────────────────────────────────
// Prefers SUPABASE_SERVICE_ROLE_KEY (bypasses RLS — required to read user data
// from a Node.js script).  Falls back to the publishable anon key, which works
// only if RLS grants anon read for the tables being queried.
//
// To set the service role key without committing it:
//   export SUPABASE_SERVICE_ROLE_KEY="<your-key>"
//   npx tsx scripts/explanation_audit.ts

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const srk         = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey     = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const supabaseKey = srk || anonKey;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌  Missing EXPO_PUBLIC_SUPABASE_URL and credentials.');
  console.error('    Set SUPABASE_SERVICE_ROLE_KEY (preferred) or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  process.exit(1);
}

if (srk) {
  console.log('🔑  Using service role key — RLS bypassed');
} else {
  console.warn('⚠️   Using anon key — RLS is active; user data may be empty.');
  console.warn('    Set SUPABASE_SERVICE_ROLE_KEY to run a real audit.');
}

const client = createClient(supabaseUrl, supabaseKey);

// ── Simulated buildExplanation() ─────────────────────────────────────────────
// Exact replication of the logic in components/RecCard.tsx (without React).

type DeterministicLane =
  | 'romantasy' | 'scifi_fantasy' | 'modern_suspense' | 'romance'
  | 'contemporary_fiction' | 'memoir_nonfiction' | 'literary' | 'horror';

const EXPLANATION_LANE_LABELS: Record<DeterministicLane, string> = {
  romantasy:            'romantic fantasy',
  scifi_fantasy:        'fantasy and speculative fiction',
  modern_suspense:      'psychological suspense',
  romance:              'emotionally driven romance',
  contemporary_fiction: 'contemporary fiction',
  memoir_nonfiction:    'narrative nonfiction',
  literary:             'literary fiction',
  horror:               'dark atmospheric fiction',
};

const GENERIC_LANE_REASONS = new Set([
  'Feels adjacent to the fantasy series you repeatedly complete',
  'Fits your pattern of emotionally driven contemporary fiction',
  'Matches the twisty, readable suspense you rate highly',
  'Sits close to the narrative nonfiction you consistently enjoy',
  'Aligns with the literary fiction that appears in your reading history',
  'Fits the speculative fiction you return to most often',
  'Similar to the emotionally driven romance you rate highly',
  'Fits the horror fiction you have consistently enjoyed',
]);

const GENERIC_COG_EXPLANATIONS = new Set([
  'Feels closest to the romantic fantasy series you return to most',
  'Fits the fantasy and speculative fiction you return to most',
  'Matches the twisty, readable suspense you return to most often',
  'Aligns with the emotionally driven romance you consistently enjoy',
  'Feels close to the contemporary, character-driven fiction you consistently enjoy',
  'Sits at the heart of the narrative nonfiction you read most',
  'Aligns with the literary fiction you consistently pick up',
  'Fits the dark, atmospheric fiction you return to consistently',
  'Strongly aligned with your most repeated reading patterns',
  'A reasonable next read that sits near your reading center',
  'A reasonable match based on your reading patterns',
]);

function stripAuthorPrefix(reason: string, author: string): string {
  const prefix = `By ${author}, `;
  if (reason.startsWith(prefix)) return reason.slice(prefix.length);
  if (reason.toLowerCase().startsWith(prefix.toLowerCase())) return reason.slice(prefix.length);
  return reason;
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function rewriteReasonText(raw: string, laneLabel: string | null): string | null {
  if (raw === 'Fits a genre you consistently enjoy') {
    return laneLabel ? `A natural fit for your taste in ${laneLabel}.` : null;
  }
  const alignsM = raw.match(/^Aligns with your preference for (.+)$/i);
  if (alignsM) return `Strong match for ${alignsM[1].toLowerCase()}.`;

  const appreciationM = raw.match(/^Matches your appreciation for (.+)$/i);
  if (appreciationM) return `Strong ${appreciationM[1].toLowerCase()} — a quality you consistently rate highly.`;

  const readersM = raw.match(/^Readers note strong (.+?) — which fits your profile$/i);
  if (readersM) {
    const TRAIT_QUALITY: Record<string, string> = {
      pacing:            'its pace',
      suspense:          'its tension',
      emotionality:      'its emotional depth',
      worldbuilding:     'its world-building',
      literary_prose:    'its prose',
      insight:           'its insight',
      originality:       'its originality',
      romance_intensity: 'its romantic intensity',
      practicality:      'its practical value',
    };
    const traitKey = readersM[1].toLowerCase();
    const quality  = TRAIT_QUALITY[traitKey] ?? `its ${traitKey}`;
    return `Readers especially praise ${quality} — a quality you consistently rate highly.`;
  }

  const subjectM = raw.match(/^Covers themes of (.+) that appear in books you've loved$/i);
  if (subjectM) return `Covers themes of ${subjectM[1]} that appear in books you've loved.`;

  const fallsM = raw.match(/^Falls within (.+?) — a genre you consistently enjoy$/i);
  if (fallsM) return laneLabel ? `A natural fit for your taste in ${laneLabel}.` : 'A genre you love.';

  const themesM = raw.match(/^Themes? \((.+?)\) align with your reading history$/i);
  if (themesM) return `Themes of ${themesM[1]} run through it.`;

  const touchesM = raw.match(/^Touches on (.+?), which occasionally appears in your reading$/i);
  if (touchesM) return laneLabel ? `Fits your taste in ${laneLabel}.` : null;

  return raw;
}

function naturalArticle(name: string): string {
  if (/^(a|an)\s+/i.test(name)) return name;
  if (/^the\s+/i.test(name))    return `the ${name.replace(/^the\s+/i, '')}`;
  return `the ${name}`;
}

function simulateBuildExplanation(book: ScoredBook): string | null {
  const bd = book._score_breakdown as any;
  if (!bd) return null;

  // Saga / series
  if (bd.saga_label && bd.saga_name) {
    switch (bd.saga_label) {
      case 'saga_entry':        return `Begin where ${naturalArticle(bd.saga_name)} saga starts.`;
      case 'saga_continuation': return `Continue ${naturalArticle(bd.saga_name)} saga.`;
      case 'saga_next_series':  return `Next chapter of ${naturalArticle(bd.saga_name)} saga.`;
    }
  }
  if (bd.series_position != null && bd.series_name) {
    const pos = bd.series_position, name = bd.series_name;
    if (pos === 1) return `Start with book one of ${naturalArticle(name)}.`;
    const maxRead = bd.series_max_read ?? null;
    if (maxRead != null && maxRead > 0) {
      return bd.series_is_contiguous
        ? `Continue ${naturalArticle(name)} series — book ${pos}`
        : `Continue ${naturalArticle(name)} series`;
    }
  }

  const laneLabel = bd.book_lane
    ? (EXPLANATION_LANE_LABELS[bd.book_lane as DeterministicLane] ?? null)
    : null;

  const r0 = book.reasons.length > 0 ? book.reasons[0] : null;
  const r1 = book.reasons.length > 1 ? book.reasons[1] : null;

  const r0IsGeneric = r0 !== null && (
    GENERIC_LANE_REASONS.has(r0) || GENERIC_COG_EXPLANATIONS.has(r0)
  );

  // Prefer r1 when r0 is generic
  if (r0IsGeneric && r1 !== null) {
    const specific  = capitalize(stripAuthorPrefix(r1, book.author));
    const rewritten = rewriteReasonText(specific, laneLabel);
    if (rewritten != null) return rewritten;
  }

  // Prefer r0 when specific
  if (r0 !== null && !r0IsGeneric) {
    const cleaned   = capitalize(stripAuthorPrefix(r0, book.author));
    const rewritten = rewriteReasonText(cleaned, laneLabel);
    if (rewritten != null) return rewritten;
  }

  // Author loyalty
  const authorCount = bd.author_books_read ?? 0;
  if (authorCount >= 5) return `Deep into ${book.author}'s catalog — this fits your pattern.`;
  if (authorCount >= 2) {
    return laneLabel
      ? `Consistent ${laneLabel} from an author you keep returning to.`
      : `Another strong read from ${book.author}.`;
  }

  // Generic last resort
  if (r0 !== null) {
    if (r0IsGeneric) return laneLabel ? `A strong fit for your taste in ${laneLabel}.` : null;
    const cleaned = capitalize(stripAuthorPrefix(r0, book.author));
    return rewriteReasonText(cleaned, laneLabel);
  }

  return null;
}

// ── Quality classifier ────────────────────────────────────────────────────────

const STRONG_PATTERNS = [
  /strong match for/i,
  /strong .+ — a quality/i,
  /readers especially praise/i,
  /covers themes of .+ that appear/i,
  /a consistent favorite/i,
  /an author you.ve returned to/i,
  /author you keep returning to/i,
  /deep into .+'s catalog/i,
  /continue .+ series/i,
  /start with book one/i,
  /begin where .+ saga/i,
  /continue .+ saga/i,
  /themes of .+ run through/i,
];

const WEAK_PATTERNS = [
  /^a strong fit for your taste in/i,
  /^a natural fit for your taste in/i,
  /^a reasonable/i,
  /more literary and prestige-driven/i,
  /step outside your main lane, worth exploring/i,
  /a step outside your usual lane/i,
  /sits near your reading center/i,
];

function classifyExplanation(text: string | null): 'STRONG' | 'ACCEPTABLE' | 'WEAK' | 'NULL' {
  if (!text) return 'NULL';
  if (STRONG_PATTERNS.some(p => p.test(text))) return 'STRONG';
  if (WEAK_PATTERNS.some(p => p.test(text)))   return 'WEAK';
  return 'ACCEPTABLE';
}

// ── BEFORE simulation (pre-change logic) ─────────────────────────────────────
// Simulates old buildExplanation() to show what text WOULD have been shown.

function simulateOldBuildExplanation(book: ScoredBook): string | null {
  const bd = book._score_breakdown as any;
  if (!bd) return null;

  if (bd.saga_label && bd.saga_name) {
    switch (bd.saga_label) {
      case 'saga_entry':        return `Begin where ${naturalArticle(bd.saga_name)} saga starts.`;
      case 'saga_continuation': return `Continue ${naturalArticle(bd.saga_name)} saga.`;
      case 'saga_next_series':  return `Next chapter of ${naturalArticle(bd.saga_name)} saga.`;
    }
  }
  if (bd.series_position != null && bd.series_name) {
    const pos = bd.series_position, name = bd.series_name;
    if (pos === 1) return `Start with book one of ${naturalArticle(name)}.`;
    const maxRead = bd.series_max_read ?? null;
    if (maxRead != null && maxRead > 0) {
      return bd.series_is_contiguous
        ? `Continue ${naturalArticle(name)} series — book ${pos}`
        : `Continue ${naturalArticle(name)} series`;
    }
  }

  const laneLabel = bd.book_lane
    ? (EXPLANATION_LANE_LABELS[bd.book_lane as DeterministicLane] ?? null)
    : null;

  // Old logic: LANE_REASON in r0 → try r1
  const r0 = book.reasons.length > 0 ? book.reasons[0] : null;
  const r1 = book.reasons.length > 1 ? book.reasons[1] : null;
  const hasLaneReason0 = r0 !== null && GENERIC_LANE_REASONS.has(r0);

  if (r1 !== null && hasLaneReason0) {
    const specific  = capitalize(stripAuthorPrefix(r1, book.author));
    const rewritten = rewriteReasonText(specific, laneLabel);
    if (rewritten != null) return rewritten;
  }

  // Old: author loyalty fires before r0
  const authorCount = bd.author_books_read ?? 0;
  if (authorCount >= 5) return `Deep into ${book.author}'s catalog — this fits your pattern.`;
  if (authorCount >= 2) return `Another strong read from ${book.author}.`;

  // Old: core_fit + laneLabel shortcut fires before r0
  if (bd.fit_class === 'core_fit' && laneLabel) {
    return `A strong fit for your taste in ${laneLabel}.`;
  }

  // Old: r0 as-is
  if (r0 !== null) {
    const raw = capitalize(stripAuthorPrefix(r0, book.author));
    return rewriteReasonText(raw, laneLabel);
  }

  return null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function line(char = '─', n = 80) { return char.repeat(n); }
function h1(t: string) { console.log('\n' + line('═') + '\n  ' + t + '\n' + line('═')); }
function h2(t: string) { console.log('\n' + line('─') + '\n  ' + t + '\n' + line('─')); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n🔍  Readstack Explanation Quality Audit');
  console.log(`    User: ${AUDIT_USER_ID}`);
  console.log(`    Run at: ${new Date().toISOString()}`);

  console.log('\n[1/3] Computing taste profile…');
  const profile = await computeTasteProfile(client, AUDIT_USER_ID);

  console.log('[2/3] Running candidate retrieval + ranking…');
  const { candidates, enrichmentMap, retrieval_trace } =
    await getCandidateBooks(client, AUDIT_USER_ID, profile);

  const ranked = getRankedRecs(candidates, profile, FEED_LIMIT, undefined, enrichmentMap, retrieval_trace);
  const recs = ranked.recs;

  console.log(`[3/3] Auditing ${recs.length} ranked cards…\n`);

  // ── Profile summary ───────────────────────────────────────────────────────
  h1('USER PROFILE');
  const det = profile.det_lanes;
  console.log(`  Dominant lanes: ${det?.dominant_lanes.join(', ') || '(none)'}`);
  console.log(`  Repeated authors: ${det?.repeated_liked_authors.join(', ') || '(none)'}`);
  console.log(`  Top genre affinities: ${
    Object.entries(profile.genre_affinities)
      .filter(([, v]) => v > 0.3)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}(${v.toFixed(2)})`)
      .join(', ')
  }`);
  console.log(`  Confidence tier: ${profile.tier} — ${profile.label}`);

  // ── Card-by-card audit ────────────────────────────────────────────────────
  h1('CARD-BY-CARD EXPLANATION AUDIT');

  const counts = { STRONG: 0, ACCEPTABLE: 0, WEAK: 0, NULL: 0 };
  const changedCards: { rank: number; title: string; before: string; after: string }[] = [];

  for (let i = 0; i < recs.length; i++) {
    const book = recs[i];
    const bd   = book._score_breakdown as any;
    const rank = i + 1;

    const newText  = simulateBuildExplanation(book);
    const oldText  = simulateOldBuildExplanation(book);
    const quality  = classifyExplanation(newText);
    counts[quality]++;

    // Pipeline classifier result (authoritative — comes from classifyExplanationQuality()
    // in recommender.ts and is stored in _score_breakdown.explanation_quality).
    const pipelineEQ: string = bd?.explanation_quality ?? 'unset';

    const changed = newText !== oldText;
    if (changed) changedCards.push({ rank, title: book.title, before: oldText ?? '(null)', after: newText ?? '(null)' });

    const qlLabel = (q: string) =>
      q === 'STRONG' || q === 'strong'       ? '✅ STRONG    '
      : q === 'ACCEPTABLE' || q === 'acceptable' ? '🔵 ACCEPTABLE'
      : q === 'NULL'                              ? '⬛ NULL       '
      : q === 'unset'                             ? '⚪ UNSET      '
      :                                            '🔴 WEAK      ';
    const deltaIcon = changed ? ' ↑' : '';

    console.log(`\n  #${String(rank).padEnd(2)} [${book.score.toFixed(3)}] ${book.title}`);
    console.log(`      Author: ${book.author}`);
    console.log(`      fit_class: ${bd?.fit_class ?? '—'}  lane: ${bd?.book_lane ?? '—'}  rep_author: ${bd?.repeated_author_match ? 'yes' : 'no'}  author_reads: ${bd?.author_books_read ?? 0}`);
    console.log(`      reasons[0]: ${book.reasons[0] ?? '(none)'}`);
    console.log(`      reasons[1]: ${book.reasons[1] ?? '(none)'}`);
    console.log(`      pipeline eq: ${qlLabel(pipelineEQ)}  (classifier in recommender.ts)`);
    console.log(`      audit sim:   ${qlLabel(quality)}${deltaIcon}  "${newText ?? '(null)'}"`);
    if (changed) {
      console.log(`                   BEFORE: "${oldText ?? '(null)'}"`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  h1('SUMMARY');

  h2('Explanation quality distribution');
  console.log(`  ✅ STRONG:     ${counts.STRONG}  cards`);
  console.log(`  🔵 ACCEPTABLE: ${counts.ACCEPTABLE}  cards`);
  console.log(`  🔴 WEAK:       ${counts.WEAK}  cards`);
  console.log(`  ⬛ NULL:        ${counts.NULL}  cards`);
  console.log(`\n  Total: ${recs.length} cards`);
  console.log(`  Improvement rate: ${changedCards.length} cards changed from old logic`);

  if (changedCards.length > 0) {
    h2('Before → After (changed cards only)');
    for (const c of changedCards) {
      console.log(`\n  #${c.rank} ${c.title}`);
      console.log(`    BEFORE: "${c.before}"`);
      console.log(`    AFTER:  "${c.after}"`);
    }
  }

  h2('Weak / Null cards — need attention');
  const needsWork = recs.filter((b, i) => {
    const q = classifyExplanation(simulateBuildExplanation(b));
    return q === 'WEAK' || q === 'NULL';
  });
  if (needsWork.length === 0) {
    console.log('  ✅ None — all cards have acceptable or strong explanations.');
  } else {
    for (const b of needsWork) {
      const bd = b._score_breakdown as any;
      console.log(`\n  ${b.title} — ${b.author}`);
      console.log(`    fit_class: ${bd?.fit_class}  lane: ${bd?.book_lane}  score: ${b.score.toFixed(3)}`);
      console.log(`    reasons: ${JSON.stringify(b.reasons)}`);
      console.log(`    text: "${simulateBuildExplanation(b)}"`);
    }
  }

  h2('Repeating explanation patterns');
  const textCounts: Record<string, number> = {};
  for (const b of recs) {
    const t = simulateBuildExplanation(b) ?? '(null)';
    textCounts[t] = (textCounts[t] ?? 0) + 1;
  }
  const repeating = Object.entries(textCounts).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  if (repeating.length === 0) {
    console.log('  ✅ No explanation text repeats across cards.');
  } else {
    for (const [text, count] of repeating) {
      console.log(`  ×${count}  "${text}"`);
    }
  }

  h2('Full reasons[] diagnostic (all ranked cards)');
  for (const b of recs) {
    const bd = b._score_breakdown as any;
    console.log(`\n  ${b.title}`);
    console.log(`    fit_class=${bd?.fit_class}  lane=${bd?.book_lane}  fit_expl="${b.reasons[0] ?? ''}"`);
    if (b.reasons[1]) console.log(`    trait_reason="${b.reasons[1]}"`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
