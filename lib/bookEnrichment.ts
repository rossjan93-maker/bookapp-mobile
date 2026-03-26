// =============================================================================
// Book Enrichment — structured enrichment profiles from public metadata
//
// Phase A only: structured metadata from Open Library + Google Books.
// Phase B (discourse/review extraction) is deferred.
//
// ── Architecture ─────────────────────────────────────────────────────────────
//
//  1. inferConsensusTraits()     — deterministic keyword mapping from subjects
//                                  + GB categories + description text
//
//  2. fetchGBEnrichmentData()    — Google Books API: language, categories,
//                                  averageRating, ratingsCount, publishedDate
//
//  3. loadEnrichmentBatch()      — batch DB cache read by external_id
//
//  4. persistEnrichmentBatch()   — batch upsert to book_enrichment_cache
//
//  5. getEnrichmentForCandidates() — checks cache; for uncached candidates
//                                    fetches from GB (top N only); persists.
//
// ── Priority constraint ───────────────────────────────────────────────────────
//  Enrichment is a secondary layer.  It improves explanations and hygiene.
//  It never overrides the user's own behavior signals (ratings, taste tags,
//  diagnosis answers, rec feedback).
//
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

// Minimal book shape used here — avoids circular import with recommender.ts
type BookLike = {
  title:       string;
  author:      string;
  external_id: string | null;
  subjects:    string[] | null;
  description: string | null;
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConsensusTraits = {
  pacing?:             number;  // 0–1
  originality?:        number;
  insight?:            number;
  emotionality?:       number;
  suspense?:           number;
  worldbuilding?:      number;
  literary_prose?:     number;
  practicality?:       number;
  romance_intensity?:  number;
};

export type PopularitySignals = {
  ratings_count?:          number;
  average_rating?:         number;
  review_signal_strength?: number;  // 0–1 normalised
};

export type BookEnrichmentProfile = {
  external_id:        string;
  language?:          string;           // 'en', 'fr', etc.
  first_publish_year?: number;
  consensus_traits:   ConsensusTraits;
  repeated_praise:    string[];         // Phase B — always [] for now
  repeated_risks:     string[];         // Phase B — always [] for now
  comparable_titles:  string[];
  audience_signals:   string[];
  popularity_signals: PopularitySignals;
  source_summary: {
    google_books?: boolean;
    open_library?: boolean;
  };
  cached_at?: string;
};

// ── Enrichment TTL ────────────────────────────────────────────────────────────
// Enrichment is fairly stable — 7 days before we consider it stale.
const ENRICHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Max candidates to enrich per run ─────────────────────────────────────────
// We only enrich the top-N by first-pass score to limit API calls.
const MAX_ENRICH = 20;

// ── Google Books API key ──────────────────────────────────────────────────────
const GB_API_KEY: string | null =
  (typeof process !== 'undefined' &&
   typeof process.env?.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY === 'string' &&
   process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim().length > 0)
    ? process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY.trim()
    : null;

// ── Keyword → ConsensusTraits mapping ────────────────────────────────────────
// Each trait has a list of signal strings.  We count how many appear in the
// text corpus (subjects + categories + description), then normalise to 0–1.

const TRAIT_SIGNAL_MAP: Array<[keyof ConsensusTraits, string[]]> = [
  ['pacing',            ['fast-paced', 'fast paced', 'action-packed', 'page-turner',
                         'quick read', 'fast pace', 'relentless pace', 'thrilling']],
  ['originality',       ['original', 'unique', 'innovative', 'fresh take',
                         'groundbreaking', 'unconventional', 'bold', 'inventive']],
  ['insight',           ['insightful', 'thought-provoking', 'intellectual', 'profound',
                         'wisdom', 'philosophical', 'ideas', 'analytical', 'perspective']],
  ['emotionality',      ['emotional', 'moving', 'touching', 'heartfelt', 'poignant',
                         'deeply felt', 'resonant', 'tender', 'raw emotion']],
  ['suspense',          ['suspense', 'mystery', 'thriller', 'tension', 'cliffhanger',
                         'psychological thriller', 'crime', 'whodunit', 'noir']],
  ['worldbuilding',     ['world-building', 'world building', 'epic', 'immersive world',
                         'richly imagined', 'detailed world', 'fantasy world', 'universe']],
  ['literary_prose',    ['literary', 'prose', 'poetic', 'lyrical', 'beautiful writing',
                         'language', 'writing style', 'eloquent', 'stylish']],
  ['practicality',      ['practical', 'how-to', 'actionable', 'self-help',
                         'guide', 'advice', 'tips', 'steps', 'framework']],
  ['romance_intensity', ['romance', 'romantic', 'love story', 'chemistry',
                         'passion', 'falling in love', 'relationship', 'romantic tension']],
];

function inferConsensusTraits(
  subjects:    string[],
  categories:  string[],
  description: string,
): ConsensusTraits {
  const corpus = [
    ...subjects,
    ...categories,
    description,
  ].join(' ').toLowerCase();

  const traits: ConsensusTraits = {};

  for (const [trait, signals] of TRAIT_SIGNAL_MAP) {
    const hits = signals.filter(s => corpus.includes(s)).length;
    if (hits > 0) {
      // Soft cap: signal saturates at 3 hits
      traits[trait] = +Math.min(1, hits / 3).toFixed(2);
    }
  }

  return traits;
}

// ── Audience signals from subjects + categories ───────────────────────────────

function inferAudienceSignals(subjects: string[], categories: string[]): string[] {
  const corpus = [...subjects, ...categories].join(' ').toLowerCase();
  const signals: string[] = [];

  if (corpus.includes('business') || corpus.includes('economics'))
    signals.push('readers interested in business and economics');
  if (corpus.includes('self-help') || corpus.includes('personal development'))
    signals.push('readers seeking personal growth');
  if (corpus.includes('science') && !corpus.includes('fiction'))
    signals.push('readers who enjoy popular science');
  if (corpus.includes('psychological'))
    signals.push('readers who enjoy psychological depth');
  if (corpus.includes('historical'))
    signals.push('readers who enjoy historical settings');
  if (corpus.includes('literary'))
    signals.push('readers who value literary craftsmanship');
  if (corpus.includes('thriller') || corpus.includes('suspense'))
    signals.push('fans of fast-paced suspense');
  if (corpus.includes('fantasy') || corpus.includes('science fiction'))
    signals.push('fans of speculative fiction');
  if (corpus.includes('memoir') || corpus.includes('biography'))
    signals.push('readers interested in real lives and experiences');

  return signals.slice(0, 4);
}

// ── Google Books enrichment fetch ─────────────────────────────────────────────
// Single API call per book; 2 s timeout.  Fails silently → returns null.

type GBVolumeInfo = {
  language?:       string;
  categories?:     string[];
  averageRating?:  number;
  ratingsCount?:   number;
  publishedDate?:  string;  // '2018' or '2018-03-06'
};

async function fetchGBEnrichmentData(
  title:  string,
  author: string,
): Promise<GBVolumeInfo | null> {
  if (!title.trim()) return null;
  try {
    const keyParam     = GB_API_KEY ? `&key=${GB_API_KEY}` : '';
    const authorPart   = author && !/^unknown/i.test(author)
      ? `+inauthor:${encodeURIComponent(author.slice(0, 35))}`
      : '';
    const url =
      `https://www.googleapis.com/books/v1/volumes` +
      `?q=intitle:${encodeURIComponent(title.slice(0, 50))}${authorPart}` +
      `&maxResults=3&langRestrict=en&printType=books${keyParam}`;

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 2000);
    const res        = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json() as { items?: unknown[] };
    if (!Array.isArray(data.items) || data.items.length === 0) return null;

    // Take the first item that has at least language or rating
    for (const item of data.items) {
      const vi = (item as { volumeInfo?: GBVolumeInfo })?.volumeInfo;
      if (!vi) continue;
      if (vi.language || vi.averageRating || vi.ratingsCount) return vi;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Build full enrichment profile ─────────────────────────────────────────────

function buildEnrichmentProfile(
  externalId: string,
  book:       BookLike,
  gb:         GBVolumeInfo | null,
): BookEnrichmentProfile {
  const subjects   = book.subjects ?? [];
  const categories = gb?.categories ?? [];
  const desc       = book.description ?? '';

  const consensus_traits  = inferConsensusTraits(subjects, categories, desc);
  const audience_signals  = inferAudienceSignals(subjects, categories);

  // Popularity
  const popularity_signals: PopularitySignals = {};
  if (typeof gb?.averageRating === 'number')  popularity_signals.average_rating  = gb.averageRating;
  if (typeof gb?.ratingsCount  === 'number')  popularity_signals.ratings_count   = gb.ratingsCount;
  if (popularity_signals.ratings_count) {
    // Normalise to 0–1 signal strength (saturates at 10k reviews)
    popularity_signals.review_signal_strength =
      +Math.min(1, popularity_signals.ratings_count / 10000).toFixed(2);
  }

  // First publish year
  let first_publish_year: number | undefined;
  if (gb?.publishedDate) {
    const y = parseInt(gb.publishedDate.slice(0, 4), 10);
    if (!isNaN(y) && y > 1000) first_publish_year = y;
  }

  return {
    external_id:       externalId,
    language:          gb?.language ?? undefined,
    first_publish_year,
    consensus_traits,
    repeated_praise:   [],   // Phase B
    repeated_risks:    [],   // Phase B
    comparable_titles: [],
    audience_signals,
    popularity_signals,
    source_summary: {
      google_books:  gb !== null,
      open_library:  subjects.length > 0,
    },
  };
}

// ── DB: batch cache read ──────────────────────────────────────────────────────

type EnrichmentCacheRow = {
  external_id:        string;
  language:           string | null;
  first_publish_year: number | null;
  consensus_traits:   ConsensusTraits | null;
  repeated_praise:    string[] | null;
  repeated_risks:     string[] | null;
  comparable_titles:  string[] | null;
  audience_signals:   string[] | null;
  popularity_signals: PopularitySignals | null;
  source_summary:     { google_books?: boolean; open_library?: boolean } | null;
  cached_at:          string;
};

export async function loadEnrichmentBatch(
  client:      SupabaseClient,
  externalIds: string[],
): Promise<Map<string, BookEnrichmentProfile>> {
  const result = new Map<string, BookEnrichmentProfile>();
  if (externalIds.length === 0) return result;

  try {
    const cutoff = new Date(Date.now() - ENRICHMENT_TTL_MS).toISOString();
    const { data, error } = await client
      .from('book_enrichment_cache')
      .select([
        'external_id', 'language', 'first_publish_year',
        'consensus_traits', 'repeated_praise', 'repeated_risks',
        'comparable_titles', 'audience_signals',
        'popularity_signals', 'source_summary', 'cached_at',
      ].join(', '))
      .in('external_id', externalIds)
      .gte('cached_at', cutoff);

    if (error) return result;   // table not yet created — degrade gracefully

    for (const row of ((data ?? []) as EnrichmentCacheRow[])) {
      result.set(row.external_id, {
        external_id:        row.external_id,
        language:           row.language        ?? undefined,
        first_publish_year: row.first_publish_year ?? undefined,
        consensus_traits:   row.consensus_traits   ?? {},
        repeated_praise:    row.repeated_praise    ?? [],
        repeated_risks:     row.repeated_risks     ?? [],
        comparable_titles:  row.comparable_titles  ?? [],
        audience_signals:   row.audience_signals   ?? [],
        popularity_signals: row.popularity_signals ?? {},
        source_summary:     row.source_summary     ?? {},
        cached_at:          row.cached_at,
      });
    }
  } catch {
    // Degrade gracefully — enrichment is optional
  }

  return result;
}

// ── DB: batch cache write ─────────────────────────────────────────────────────

async function persistEnrichmentBatch(
  client:   SupabaseClient,
  profiles: BookEnrichmentProfile[],
): Promise<void> {
  if (profiles.length === 0) return;
  try {
    const rows = profiles.map(p => ({
      external_id:        p.external_id,
      language:           p.language           ?? null,
      first_publish_year: p.first_publish_year ?? null,
      consensus_traits:   p.consensus_traits,
      repeated_praise:    p.repeated_praise,
      repeated_risks:     p.repeated_risks,
      comparable_titles:  p.comparable_titles,
      audience_signals:   p.audience_signals,
      popularity_signals: p.popularity_signals,
      source_summary:     p.source_summary,
      cached_at:          new Date().toISOString(),
    }));

    await client
      .from('book_enrichment_cache')
      .upsert(rows, { onConflict: 'external_id', ignoreDuplicates: false });
  } catch {
    // Best-effort — enrichment write failure is non-fatal
  }
}

// ── Main: get enrichment for a batch of candidates ────────────────────────────
// Checks cache first.  For uncached candidates, builds a profile immediately
// using subject-based inference (no network call) so the caller is never
// blocked on the Google Books API.  GB API calls run in the background and
// persist richer profiles to the cache for the next pipeline run.
//
// ── Why non-blocking GB calls ────────────────────────────────────────────────
//  On first visit (empty enrichment cache) the old approach blocked the full
//  pipeline while up to MAX_ENRICH GB requests completed (~500–2000 ms).
//  DB-cached enrichment (return visits) is unchanged: one batch read, fast.
//  Subject-based inference (inferConsensusTraits) covers the hygiene and
//  scoring signals most relevant to first-visit quality:
//    • consensus_traits     — from book.subjects (no GB needed)
//    • audience_signals     — from book.subjects (no GB needed)
//    • language             — unknown without GB; hygiene keeps the book (safe)
//    • popularity_signals   — unknown without GB; enrichment_bonus = 0 (safe)
//  GB API enriches language + popularity for the NEXT visit — zero latency cost.

export async function getEnrichmentForCandidates(
  client:     SupabaseClient,
  candidates: BookLike[],
): Promise<Map<string, BookEnrichmentProfile>> {
  // Only enrich candidates that have an external_id (OL key)
  const withKey = candidates.filter(c => !!c.external_id);
  if (withKey.length === 0) return new Map();

  const allExternalIds = withKey.map(c => c.external_id!);

  // Step 1: batch cache read (single DB query — fast on every visit)
  const cached = await loadEnrichmentBatch(client, allExternalIds);

  // Step 2: identify uncached candidates (up to MAX_ENRICH)
  const uncached = withKey
    .filter(c => !cached.has(c.external_id!))
    .slice(0, MAX_ENRICH);

  if (uncached.length === 0) return cached;

  // Step 3: build local-inference profiles immediately for uncached candidates.
  // Uses inferConsensusTraits (subjects-only) — no network call, returns instantly.
  // Language and popularity are unknown at this stage; both degrade safely:
  //   language = undefined  → hygiene keeps the book (conservative, not exclusionary)
  //   popularity = {}       → enrichment_bonus uses 0 (no inflation, no penalty)
  const localProfiles = uncached.map(
    book => buildEnrichmentProfile(book.external_id!, book, null)
  );

  // Step 4: merge DB-cached + local-inference into result (ready immediately)
  const result = new Map(cached);
  for (const p of localProfiles) {
    result.set(p.external_id, p);
  }

  // Step 5: kick off Google Books enrichment in the background (cache warming).
  // This does NOT block the return above. On the next pipeline run for the same
  // candidates, Step 1 will find them in the DB cache and return full profiles.
  Promise.all(
    uncached.map(async (book): Promise<BookEnrichmentProfile> => {
      const gb = await fetchGBEnrichmentData(book.title, book.author);
      return buildEnrichmentProfile(book.external_id!, book, gb);
    })
  ).then(freshProfiles => {
    persistEnrichmentBatch(client, freshProfiles).catch(() => {});
  }).catch(() => {});

  return result;
}
