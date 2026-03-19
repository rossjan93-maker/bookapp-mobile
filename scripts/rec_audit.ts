/**
 * scripts/rec_audit.ts
 *
 * Forensic single-user recommendation audit.
 * Run with:  npx tsx scripts/rec_audit.ts
 *
 * Produces:
 *   Part 1 — full candidate trace (source, retrieval anchor, scores, penalties)
 *   Part 2 — explicit audit of named problem books
 *   Part 3 — ranking diagnosis in plain English
 *   Part 4 — user profile summary (repeated authors, lanes, center of gravity)
 *   Part 5 — root cause hierarchy + recommended fix order
 */

import { createClient }                   from '@supabase/supabase-js';
import { computeTasteProfile }             from '../lib/tasteProfile';
import {
  getCandidateBooks,
  scoreBookForUser,
  getRankedRecs,
  fitLabel,
  type CandidateBook,
  type ScoredBook,
} from '../lib/recommender';
import {
  getBookTraits,
  detectBookLane,
  detectBookMysterySubtype,
  isPhilosophyOrSpiritual,
  assessMetadataQuality,
} from '../lib/bookTraits';

// ── Config ────────────────────────────────────────────────────────────────────

const AUDIT_USER_ID = '78d5d2c4-d513-4747-b77f-52898c2dd4a8';

const PROBLEM_BOOKS = [
  'casino royale',
  'the big sleep',
  'maus i',
  'maus ii',
  'maus',
  'parable of the sower',
  'v for vendetta',
  'to kill a mockingbird',
  'the sun also rises',
  'anthem',
  'genji monogatari',
  'the tale of genji',
  'autobiography of a yogi',
];

// ── Supabase client ───────────────────────────────────────────────────────────

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌  Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  process.exit(1);
}

const client = createClient(supabaseUrl, supabaseKey);

// ── Helpers ───────────────────────────────────────────────────────────────────

function line(char = '─', n = 80) { return char.repeat(n); }
function h1(title: string)  { console.log('\n' + line('═') + '\n  ' + title + '\n' + line('═')); }
function h2(title: string)  { console.log('\n' + line('─') + '\n  ' + title + '\n' + line('─')); }
function h3(title: string)  { console.log('\n  ▶ ' + title); }
function kv(k: string, v: unknown) {
  const val = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—');
  console.log(`    ${k.padEnd(32)} ${val}`);
}

function isProblemBook(title: string): string | null {
  const tl = title.toLowerCase();
  for (const pb of PROBLEM_BOOKS) {
    if (tl.includes(pb) || pb.includes(tl.slice(0, Math.min(tl.length, 12)))) return pb;
  }
  return null;
}

// ── Fetch supplementary user data ─────────────────────────────────────────────

async function fetchUserBookData(userId: string) {
  const { data: ub } = await client
    .from('user_books')
    .select(`
      rating, status, source, review_body,
      book:books(title, author, subjects, page_count)
    `)
    .eq('user_id', userId)
    .eq('status', 'finished')
    .not('rating', 'is', null)
    .order('rating', { ascending: false });

  type UBRow = {
    rating: number | null;
    status: string;
    source: string;
    review_body: string | null;
    book: { title: string; author: string; subjects: string[] | null; page_count: number | null } | null;
  };

  return ((ub ?? []) as UBRow[]);
}

async function fetchUserSummaryData(userId: string) {
  const { data: ub } = await client
    .from('user_books')
    .select('rating, source, book:books(title, author)')
    .eq('user_id', userId)
    .order('rating', { ascending: false });

  type SRow = {
    rating: number | null;
    source: string;
    book: { title: string; author: string } | null;
  };
  return ((ub ?? []) as SRow[]);
}

// ── Main audit ────────────────────────────────────────────────────────────────

async function runAudit() {
  console.log('\n🔍  Readstack Forensic Recommendation Audit');
  console.log(`    User: ${AUDIT_USER_ID}`);
  console.log(`    Run at: ${new Date().toISOString()}`);

  // ── 1. Load taste profile ─────────────────────────────────────────────────
  console.log('\n[1/5] Computing taste profile…');
  const profile = await computeTasteProfile(client, AUDIT_USER_ID);

  // ── 2. Load supplementary data ────────────────────────────────────────────
  console.log('[2/5] Fetching user book history…');
  const [userBooksRated, userBooksAll] = await Promise.all([
    fetchUserBookData(AUDIT_USER_ID),
    fetchUserSummaryData(AUDIT_USER_ID),
  ]);

  // ── 3. Get candidate pool ─────────────────────────────────────────────────
  console.log('[3/5] Running candidate retrieval pipeline…');
  const { candidates, enrichmentMap, retrieval_trace } =
    await getCandidateBooks(client, AUDIT_USER_ID, profile);

  // ── 4. Score all candidates ───────────────────────────────────────────────
  console.log('[4/5] Scoring all candidates…');
  const scored: ScoredBook[] = candidates.map(book => {
    const enrichment = book.external_id ? enrichmentMap.get(book.external_id) : undefined;
    const result = scoreBookForUser(book, profile, undefined, enrichment);
    return { ...book, ...result };
  });

  scored.sort((a, b) => b.score - a.score);

  // Get ranked (diversity-filtered) set — pass raw candidates; getRankedRecs scores internally
  const ranked = getRankedRecs(candidates, profile, 20, undefined, enrichmentMap, retrieval_trace);

  // ── 5. Output audit ───────────────────────────────────────────────────────
  console.log('[5/5] Generating audit report…\n');

  // ═══════════════════════════════════════════════════════════════════════════
  h1('PART 4: USER PROFILE SUMMARY');
  // ═══════════════════════════════════════════════════════════════════════════

  h2('Evidence counts');
  kv('Total finished books',     profile.evidence.completed_books_count);
  kv('Goodreads imported',       profile.evidence.imported_books_count);
  kv('Rated books',              profile.evidence.rated_books_count);
  kv('Taste-tagged books',       profile.evidence.taste_tag_count);
  kv('Written reviews',          profile.evidence.review_count);
  kv('Diagnosis answers',        profile.evidence.diagnosis_answer_count);
  kv('Strong signal count',      profile.strongSignalCount);
  kv('Confidence tier',          `${profile.tier} — ${profile.label}`);

  h2('Genre affinities (all non-zero, ranked)');
  const sortedAffinities = Object.entries(profile.genre_affinities)
    .sort((a, b) => b[1] - a[1]);
  for (const [genre, score] of sortedAffinities) {
    const bar = score > 0
      ? '█'.repeat(Math.round(score * 20)) + ` +${score.toFixed(3)}`
      : '░'.repeat(Math.round(Math.abs(score) * 20)) + ` ${score.toFixed(3)}`;
    console.log(`    ${genre.padEnd(24)} ${bar}`);
  }

  h2('Preferred traits (top signals)');
  const topPref = Object.entries(profile.preferred_traits)
    .filter(([, v]) => v > 0.1)
    .sort((a, b) => b[1] - a[1]);
  for (const [trait, score] of topPref) {
    console.log(`    ${trait.padEnd(24)} +${score.toFixed(3)}`);
  }

  h2('Avoided traits');
  const topAvoid = Object.entries(profile.avoided_traits)
    .filter(([, v]) => v > 0.05)
    .sort((a, b) => b[1] - a[1]);
  for (const [trait, score] of topAvoid) {
    console.log(`    ${trait.padEnd(24)} -${score.toFixed(3)}`);
  }

  h2('Liked subjects (OL retrieval anchors)');
  console.log('    ' + (profile.liked_subjects.slice(0, 12).join(', ') || '(none)'));

  h2('Liked authors (OL retrieval anchors)');
  console.log('    ' + (profile.liked_authors.slice(0, 10).join(', ') || '(none)'));

  h2('Deterministic lanes');
  const det = profile.det_lanes;
  if (det) {
    kv('is_dense_import',          det.is_dense_import);
    kv('dominant_lanes',           det.dominant_lanes.join(', ') || '(none established)');
    kv('exception_lanes',          det.exception_lanes?.join(', ') || '(none)');
    kv('commercial_prior',         det.commercial_prior?.toFixed(3) ?? 'N/A');
    kv('mystery_subtype',          det.mystery_subtype ?? '(none)');
    kv('repeated_liked_authors',   det.repeated_liked_authors.join(', ') || '(none)');
  } else {
    console.log('    (no det_lanes computed)');
  }

  h2('Repeated highly-rated authors (from user library)');
  const authorCount: Record<string, { count: number; totalRating: number; minRating: number }> = {};
  for (const row of userBooksAll) {
    if (!row.book?.author) continue;
    const a = row.book.author.toLowerCase().trim();
    if (!authorCount[a]) authorCount[a] = { count: 0, totalRating: 0, minRating: 5 };
    authorCount[a].count++;
    if (row.rating !== null) {
      authorCount[a].totalRating += row.rating;
      authorCount[a].minRating = Math.min(authorCount[a].minRating, row.rating);
    }
  }
  const repeatedAuthors = Object.entries(authorCount)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || b[1].totalRating - a[1].totalRating);
  for (const [author, v] of repeatedAuthors.slice(0, 15)) {
    console.log(`    ${author.padEnd(30)} ${v.count}x books | avg rating ${(v.totalRating / v.count).toFixed(1)} | min ${v.minRating}`);
  }

  h2('Top rated books (4★ and above, for center-of-gravity read)');
  const topRated = userBooksRated
    .filter(r => (r.rating ?? 0) >= 4)
    .slice(0, 20);
  for (const r of topRated) {
    if (!r.book) continue;
    console.log(`    [${r.rating}★] ${r.book.title} — ${r.book.author}`);
  }

  h2('Center of gravity diagnosis');
  // Compute genre distribution of top-rated books
  const topRatedGenres: Record<string, number> = {};
  for (const r of topRated) {
    if (!r.book) continue;
    const g = detectGenre({ subjects: r.book.subjects ?? [], title: r.book.title, author: r.book.author, description: null, page_count: r.book.page_count });
    topRatedGenres[g] = (topRatedGenres[g] ?? 0) + 1;
  }
  const sortedTopGenres = Object.entries(topRatedGenres).sort((a, b) => b[1] - a[1]);
  for (const [g, cnt] of sortedTopGenres) {
    console.log(`    ${g.padEnd(24)} ${cnt} books`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  h1('PART 1: RETRIEVAL TRACE');
  // ═══════════════════════════════════════════════════════════════════════════

  h2('Retrieval pipeline summary');
  kv('OL genres queried',         retrieval_trace.top_genres_used.join(', ') || '(none)');
  kv('Top traits used',           retrieval_trace.top_traits_used.join(', ') || '(none)');
  kv('Liked subjects used',       retrieval_trace.liked_subjects_used.join(', ') || '(none)');
  kv('Liked authors queried',     retrieval_trace.liked_authors_used.join(', ') || '(none)');
  kv('OL queries fired',          retrieval_trace.ol_queries.join('\n    ' + ' '.repeat(32)));
  kv('Hygiene excluded',          retrieval_trace.hygiene_excluded);
  kv('Enrichment fetched',        retrieval_trace.enriched_count);
  kv('Dense-import mode',         (retrieval_trace as any).dense_import_mode ?? false);
  kv('Total candidates (post-hygiene)', candidates.length);
  kv('Total scored',              scored.length);

  h2('Source breakdown');
  const sourceCounts = { catalog: 0, cached_external: 0, open_library: 0 };
  for (const c of candidates) {
    sourceCounts[c._source as keyof typeof sourceCounts]++;
  }
  kv('local_catalog',             sourceCounts.catalog);
  kv('cached_external (OL cache)', sourceCounts.cached_external);
  kv('open_library (live)',       sourceCounts.open_library);

  // ═══════════════════════════════════════════════════════════════════════════
  h1('PART 1: FULL CANDIDATE AUDIT TABLE (top 40 by score)');
  // ═══════════════════════════════════════════════════════════════════════════

  const top40 = scored.slice(0, 40);
  const colW = [4, 36, 24, 16, 16, 16, 7, 7, 7, 7, 7, 7, 6];
  const header = ['Rank', 'Title', 'Author', 'Source', 'Lane', 'Subtype', 'Trait', 'Genre', 'Enr', 'Pen', 'Raw', 'Final', 'Fit'];
  console.log('\n  ' + header.map((h, i) => h.padEnd(colW[i])).join(' '));
  console.log('  ' + line('─', 78));

  top40.forEach((b, idx) => {
    const bd        = b._score_breakdown;
    const lane      = detectBookLane(b)            ?? '—';
    const subtype   = detectBookMysterySubtype(b)  ?? '—';
    const isProblem = isProblemBook(b.title)       ? ' ⚠️' : '';
    const inRanked  = ranked.recs.some(r => r.id === b.id || r.title === b.title) ? ' ★' : '';

    const row = [
      String(idx + 1),
      (b.title.slice(0, 34) + isProblem + inRanked).padEnd(colW[1]),
      b.author.slice(0, 22).padEnd(colW[2]),
      b._source.slice(0, 14).padEnd(colW[3]),
      lane.slice(0, 14).padEnd(colW[4]),
      subtype.slice(0, 14).padEnd(colW[5]),
      (bd?.trait_alignment  ?? 0).toFixed(3),
      (bd?.genre_bonus       ?? 0).toFixed(3),
      (bd?.enrichment_bonus  ?? 0).toFixed(3),
      (bd?.metadata_penalty  ?? 0).toFixed(3),
      (bd?.raw_score         ?? 0).toFixed(3),
      b.score.toFixed(3),
      fitLabel(b.score).slice(0, 6),
    ];

    console.log('  ' + row.map((v, i) => i < 2 ? v : String(v).padEnd(colW[i])).join(' '));

    if (b.risks.length > 0) {
      console.log(`       ⚡ RISK: ${b.risks[0]}`);
    }
    if ((b as any)._score_breakdown?.audit_flags?.length > 0) {
      console.log(`       🏷  FLAGS: ${(b as any)._score_breakdown.audit_flags.join(', ')}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  h1('PART 2: NAMED BOOK FORENSICS');
  // ═══════════════════════════════════════════════════════════════════════════

  for (const pb of PROBLEM_BOOKS) {
    const match = scored.find(b => b.title.toLowerCase().includes(pb) || pb.includes(b.title.toLowerCase().slice(0, 10)));
    if (!match) {
      h3(`${pb.toUpperCase()} → NOT IN CANDIDATE POOL`);
      console.log(`    Either filtered by hygiene, already in user's library, or never fetched.`);
      continue;
    }

    h3(`${match.title} by ${match.author} — rank #${scored.indexOf(match) + 1}`);
    const bd        = match._score_breakdown;
    const enrichment = match.external_id ? enrichmentMap.get(match.external_id) : undefined;
    const bt        = getBookTraits(match);
    const lane      = detectBookLane(match);
    const subtype   = detectBookMysterySubtype(match);
    const isPhi     = isPhilosophyOrSpiritual(match);
    const metaQ     = assessMetadataQuality(match);
    const isRanked  = ranked.recs.some(r => r.id === match.id || r.title === match.title);

    kv('Source path',              match._source);
    kv('Retrieval anchor',         match._retrieval_reason ?? '—');
    kv('In final ranked set',      isRanked ? '✅ YES (shown to user)' : '❌ NO (filtered by diversity cap or score)');
    kv('Rank by score',            `#${scored.indexOf(match) + 1} of ${scored.length}`);
    kv('Detected lane',            lane ?? '(none)');
    kv('Detected subtype',         subtype ?? '(none)');
    kv('Is philosophy/spiritual',  isPhi);
    kv('Book form',                bt.bookForm);
    kv('Primary genre',            bt.primaryGenre);
    kv('Metadata quality',         metaQ);
    kv('Subjects',                 (match.subjects ?? []).slice(0, 6).join('; ') || '(none)');
    kv('first_publish_year',       enrichment?.first_publish_year ?? 'unknown');

    console.log('    Score breakdown:');
    kv('  s1 trait alignment',     (bd?.trait_alignment  ?? 0).toFixed(4));
    kv('  s2 avoided penalty',     (bd?.avoided_penalty  ?? 0).toFixed(4));
    kv('  s3 genre bonus',         (bd?.genre_bonus       ?? 0).toFixed(4));
    kv('  s4 feedback boost',      (bd?.feedback_boost    ?? 0).toFixed(4));
    kv('  s5 enrichment bonus',    (bd?.enrichment_bonus  ?? 0).toFixed(4));
    kv('  s6 metadata penalty',    (bd?.metadata_penalty  ?? 0).toFixed(4));
    kv('  raw score',              (bd?.raw_score         ?? 0).toFixed(4));
    kv('  FINAL score',            match.score.toFixed(4));
    kv('  fit label',              fitLabel(match.score));

    if ((bd as any)?.audit_flags?.length > 0) {
      kv('  audit flags',           (bd as any).audit_flags.join(', '));
    }
    if (match.risks.length > 0) {
      kv('  risks',                 match.risks.join('; '));
    }
    if (match.reasons.length > 0) {
      console.log('    Reasons shown to user:');
      for (const r of match.reasons) console.log(`      • ${r}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  h1('PART 3: RANKING DIAGNOSIS — PLAIN ENGLISH');
  // ═══════════════════════════════════════════════════════════════════════════

  h2('Score distribution of candidate pool');
  const buckets = [0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];
  for (let i = 0; i < buckets.length - 1; i++) {
    const hi = buckets[i], lo = buckets[i + 1];
    const cnt = scored.filter(b => b.score >= lo && b.score < hi).length;
    const bar = '█'.repeat(Math.min(cnt, 40));
    console.log(`    [${lo.toFixed(1)}–${hi.toFixed(1)}) ${bar} (${cnt})`);
  }
  const ge06 = scored.filter(b => b.score >= 0.6).length;
  console.log(`\n    Scores ≥ 0.60 (strong fit): ${ge06}`);
  console.log(`    Scores ≥ 0.50 (good fit):   ${scored.filter(b => b.score >= 0.5).length}`);
  console.log(`    Scores ≥ 0.40 (adjacent):   ${scored.filter(b => b.score >= 0.4).length}`);
  console.log(`    Scores < 0.30 (stretch):    ${scored.filter(b => b.score < 0.3).length}`);

  h2('Score compression analysis');
  if (scored.length > 5) {
    const top5 = scored.slice(0, 5);
    const spread = top5[0].score - top5[4].score;
    console.log(`    Top-5 score spread: ${spread.toFixed(4)}`);
    console.log(`    Top-5 scores: ${top5.map(b => b.score.toFixed(3)).join(', ')}`);
    if (spread < 0.08) {
      console.log(`    ⚠️  COMPRESSION DETECTED: Top-5 within ${(spread * 100).toFixed(1)} pts — genre bonus is equalizing disparate books`);
    }
  }

  h2('Step 1 trait alignment analysis');
  const s1vals = scored.map(b => b._score_breakdown?.trait_alignment ?? 0);
  const s1max = Math.max(...s1vals);
  const s1avg = s1vals.reduce((a, b) => a + b, 0) / s1vals.length;
  console.log(`    Max trait contribution: ${s1max.toFixed(4)}`);
  console.log(`    Avg trait contribution: ${s1avg.toFixed(4)}`);
  if (s1max < 0.25) {
    console.log(`    ⚠️  LOW TRAIT HEADROOM: max trait score is ${s1max.toFixed(4)} (cap is 0.38)`);
    console.log(`       → Broad trait overlap is equalizing books that shouldn't be equal`);
  }

  h2('Step 3 genre bonus dominance');
  const s3same = scored.filter(b => Math.abs((b._score_breakdown?.genre_bonus ?? 0) - 0.22) < 0.01).length;
  console.log(`    Books getting max genre bonus (0.22): ${s3same} of ${scored.length}`);
  if (s3same > scored.length * 0.4) {
    console.log(`    ⚠️  GENRE BONUS SATURATION: >40% of candidates get the same +0.22 bonus`);
    console.log(`       → Genre affinity is too blunt; it doesn't distinguish within-genre quality`);
  }

  h2('Penalty effectiveness');
  const noPenalty   = scored.filter(b => (b._score_breakdown?.metadata_penalty ?? 0) === 0).length;
  const withPenalty = scored.length - noPenalty;
  console.log(`    Books with ≥1 penalty applied: ${withPenalty}`);
  console.log(`    Books with 0 penalty:          ${noPenalty}`);
  const flagged = scored.filter(b => ((b as any)._score_breakdown?.audit_flags?.length ?? 0) > 0);
  console.log(`    Books with audit flags:        ${flagged.length}`);
  for (const f of flagged.slice(0, 10)) {
    console.log(`      [${f.score.toFixed(3)}] ${f.title} → ${(f as any)._score_breakdown.audit_flags.join(', ')}`);
  }

  h2('Final ranked set (shown to user, diversity-filtered)');
  console.log(`    Ranked set size: ${ranked.recs.length} / limit 20`);
  for (const r of ranked.recs) {
    const lane = detectBookLane(r) ?? '—';
    const subtype = detectBookMysterySubtype(r) ?? '—';
    const isProblem = isProblemBook(r.title) ? ' ⚠️ PROBLEM BOOK' : '';
    console.log(`    [${r.score.toFixed(3)}] ${r.title} — ${r.author}${isProblem}`);
    console.log(`           source:${r._source}  lane:${lane}  subtype:${subtype}`);
    if (r.risks.length) console.log(`           ⚡ ${r.risks[0]}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  h1('PART 5: ROOT CAUSE HIERARCHY + FIX RECOMMENDATIONS');
  // ═══════════════════════════════════════════════════════════════════════════

  h2('Diagnosis');

  // Diagnose each failure mode
  const catalogBooks = scored.filter(b => b._source === 'catalog');
  const olBooks      = scored.filter(b => b._source !== 'catalog');
  const catalogTop10 = scored.slice(0, 10).filter(b => b._source === 'catalog');
  const problemBooksInTop20 = scored.slice(0, 20).filter(b => isProblemBook(b.title));

  kv('Local catalog books in candidate pool',  catalogBooks.length);
  kv('OL / cached books in candidate pool',   olBooks.length);
  kv('Catalog books in top-10',               catalogTop10.length);
  kv('Problem books in top-20',               problemBooksInTop20.length);

  for (const b of problemBooksInTop20) {
    const flags = (b as any)._score_breakdown?.audit_flags ?? [];
    const penalty = b._score_breakdown?.metadata_penalty ?? 0;
    console.log(`\n    ⚠️  "${b.title}" at rank #${scored.indexOf(b) + 1}, score ${b.score.toFixed(3)}`);
    console.log(`       Penalties applied: ${Math.abs(penalty).toFixed(3)} (flags: ${flags.join(', ') || 'NONE'})`);
    if (flags.length === 0 && penalty === 0) {
      console.log(`       ROOT CAUSE: No penalty fired. Check subtype detection + threshold.`);
    }
  }

  // Determine dominant problem
  const noLaneEstablished = !det?.dominant_lanes || det.dominant_lanes.length === 0;
  const broadTraitOverlap = s1avg > 0.25;
  const genreBoostSat     = s3same > scored.length * 0.4;
  const manyProbInTop20   = problemBooksInTop20.length > 2;

  console.log('\n  Root cause ranking (most → least impactful):');

  const causes: [boolean, string, string][] = [
    [manyProbInTop20 && !noLaneEstablished,
     'LANE PENALTIES NOT FIRING',
     'dominant_lanes gate preventing subtype penalties — FIXED in this session (verify)'],
    [noLaneEstablished,
     'NO DOMINANT LANE ESTABLISHED',
     'det_lanes.dominant_lanes=[] → lane-aware scoring unavailable; penalties still needed'],
    [genreBoostSat,
     'GENRE BONUS SATURATION',
     '>40% of candidates get the exact same +0.22 genre bonus, equalizing strong/weak fits'],
    [broadTraitOverlap,
     'BROAD TRAIT OVERLAP',
     'preferred_traits spread too wide; STEP1_CAP not distinguishing best-fit books'],
    [catalogTop10.length > 5,
     'CATALOG BOOKS DOMINATING',
     'local catalog has too many old/niche books competing; OL retrieval not providing enough modern alternatives'],
    [olBooks.length < 15,
     'THIN OL CANDIDATE POOL',
     'Not enough OL candidates fetched; top-3 genre retrieval was too narrow'],
    [true,
     'METADATA QUALITY VARIANCE',
     'Local catalog books vary widely in subject/description quality; scoring disadvantages books with weak metadata'],
  ];

  let rank = 1;
  for (const [active, name, explanation] of causes) {
    if (active) {
      console.log(`\n  #${rank++} — ${name}`);
      console.log(`      ${explanation}`);
    }
  }

  console.log('\n  Recommended fix order (smallest change, highest leverage):');
  console.log('  1. Verify today\'s session fixes: unconditional 7b penalties, year filter, Ayn Rand exclusion');
  console.log('  2. Expand OL retrieval genres (done: affinities > 0.4 now included)');
  console.log('  3. If genre bonus saturation confirmed: add within-genre era bonus (pre/post-2000 split)');
  console.log('  4. If trait scores are compressed: lower TRAIT_THRESHOLD from 0.28 → 0.20 for dense users');
  console.log('  5. If catalog books still dominate: cap catalog candidates at 40% of total pool');
  console.log('  6. If commercial fiction still missing: explicitly query "contemporary fiction" + "book club fiction" OL subjects');

  console.log('\n' + line('═'));
  console.log('  Audit complete.');
  console.log(line('═') + '\n');
}

// ── Import detectGenre (needed for center of gravity) ─────────────────────────
import { detectGenre } from '../lib/bookTraits';

runAudit().catch(err => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
