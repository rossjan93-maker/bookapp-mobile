// =============================================================================
// Recommender — candidate retrieval + ranking
//
// Architecture (two-phase):
//
//   Phase 1 — Retrieval (async, two sources in parallel):
//     getLocalCandidates(client, userId)
//       → DB books passing eligibility filter (subjects/description/isbn present)
//       → also returns readIds and readExternalIds for subsequent OL filtering
//
//     getOLCandidates(profile, readExternalIds, localExternalIds)
//       → Live OL subject-search for the user's top liked genres
//       → Excludes books already in user's library or already in local candidates
//
//     Both are merged by getCandidateBooks(client, userId, profile)
//
//   Phase 2 — Ranking (pure sync):
//     scoreBookForUser(book, profile)   → trait alignment + genre affinity
//     getRankedRecs(candidates, profile) → score → sort → diversity cap
//
// What makes a book recommendation-eligible (local DB):
//   • subjects is not null and has at least 1 entry   → OL-classified book
//   • OR description is not null and non-trivial      → enriched book detail page
//   • OR isbn is not null                              → came from Goodreads import
//                                                        (known published book)
//   Books that entered only via recommendation-send (title+author+cover_url only)
//   are excluded because they have none of these three signals.
//
// No schema change is required — eligibility is deterministic from existing columns.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TasteProfile }  from './tasteProfile';
import { getBookTraits }       from './bookTraits';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateSource = 'local_db' | 'open_library';

export type CandidateBook = {
  id:                 string;   // DB UUID for local_db, 'ol:<key>' for open_library
  title:              string;
  author:             string;
  cover_url:          string | null;
  external_id:        string | null;  // Open Library /works/OL... key
  subjects:           string[] | null;
  page_count:         number | null;
  description:        string | null;
  // ── Retrieval debug fields ─────────────────────────────────────────────────
  _source:            CandidateSource;
  _retrieval_reason:  string;         // e.g. 'local:eligible', 'ol:subject:mystery'
};

export type ScoredBook = CandidateBook & {
  score:      number;
  confidence: 'low' | 'medium' | 'high';
  reasons:    string[];
  risks:      string[];
  // ── Ranking debug fields ───────────────────────────────────────────────────
  _debug: {
    pool_size: number;   // total candidates before ranking
    rank:      number;   // 1-based rank within scored pool
  };
};

// ── Fit label helpers (used by the UI) ────────────────────────────────────────

export function fitLabel(score: number): string {
  if (score > 0.50) return 'Strong fit';
  if (score > 0.28) return 'Good match';
  return 'Worth exploring';
}

export function fitColor(score: number): string {
  if (score > 0.50) return '#16a34a';
  if (score > 0.28) return '#2563eb';
  return '#78716c';
}

// ── Genre → Open Library subject mapping ──────────────────────────────────────
// Two OL subjects per genre for broader coverage.

const GENRE_OL_SUBJECTS: Record<string, [string, string]> = {
  fantasy_scifi:    ['fantasy',          'science fiction'],
  thriller_mystery: ['mystery',          'thriller'],
  romance:          ['romance',          'love stories'],
  horror:           ['horror',           'ghost stories'],
  memoir_bio:       ['biography',        'autobiography'],
  nonfiction:       ['nonfiction',       'self-help'],
  literary:         ['literary fiction', 'fiction'],
  general:          ['fiction',          'contemporary fiction'],
};

// ── OL subject fetcher ────────────────────────────────────────────────────────
// Fetches up to `limit` books for a given OL subject string.
// Times out after 3s — returns [] on any error or slow response.

type OLDoc = {
  key?:                     string;
  title?:                   string;
  author_name?:             string[];
  cover_i?:                 number;
  number_of_pages_median?:  number;
  subject?:                 string[];
};

async function fetchOLSubject(
  subject: string,
  limit = 20,
  retrieval_reason: string,
): Promise<CandidateBook[]> {
  try {
    const url =
      `https://openlibrary.org/search.json` +
      `?subject=${encodeURIComponent(subject)}` +
      `&fields=key,title,author_name,cover_i,number_of_pages_median,subject` +
      `&limit=${limit}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const json = await res.json() as { docs?: OLDoc[] };

    return (json.docs ?? [])
      .filter(doc => doc.key && doc.title)
      .map((doc): CandidateBook => ({
        id:                `ol:${doc.key}`,
        title:             doc.title ?? '',
        author:            doc.author_name?.[0] ?? 'Unknown author',
        cover_url:         doc.cover_i
                             ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
                             : null,
        external_id:       doc.key ?? null,
        subjects:          doc.subject?.slice(0, 20) ?? null,
        page_count:        typeof doc.number_of_pages_median === 'number'
                             ? doc.number_of_pages_median
                             : null,
        description:       null,
        _source:           'open_library',
        _retrieval_reason: retrieval_reason,
      }));
  } catch {
    return [];
  }
}

// ── Local DB retrieval ────────────────────────────────────────────────────────
// Returns eligibility-filtered local DB books plus the user's existing ID sets.

type LocalResult = {
  candidates:      CandidateBook[];
  readIds:         Set<string>;    // DB UUIDs — for local candidate exclusion
  readExternalIds: Set<string>;    // OL /works/OL... keys — for OL candidate exclusion
};

async function getLocalCandidates(
  client: SupabaseClient,
  userId: string,
): Promise<LocalResult> {
  // Fetch user's existing books (both ID and external_id for dual exclusion)
  const { data: userBooks } = await client
    .from('user_books')
    .select('book_id, book:books(external_id)')
    .eq('user_id', userId);

  type UBRow = { book_id: string; book: { external_id: string | null } | null };
  const ubRows = (userBooks ?? []) as UBRow[];

  const readIds         = new Set(ubRows.map(r => r.book_id));
  const readExternalIds = new Set(
    ubRows.map(r => r.book?.external_id).filter((x): x is string => !!x)
  );

  // Quality-eligible local books:
  //   • subjects present  → classified by Open Library
  //   • description present → enriched via book detail page
  //   • isbn present       → imported from Goodreads (published book)
  // Books inserted only via recommendation-send (title+author+cover_url) fail
  // all three checks and are excluded automatically.
  const { data: dbBooks } = await client
    .from('books')
    .select('id, title, author, cover_url, external_id, subjects, page_count, description, isbn')
    .or('subjects.not.is.null,description.not.is.null,isbn.not.is.null')
    .limit(120);

  type DBBook = {
    id: string; title: string; author: string; cover_url: string | null;
    external_id: string | null; subjects: string[] | null; page_count: number | null;
    description: string | null; isbn: string | null;
  };

  const candidates: CandidateBook[] = ((dbBooks ?? []) as DBBook[])
    .filter(b => !readIds.has(b.id))
    .filter(b => {
      // Subjects array must have at least one real entry
      if (b.subjects && b.subjects.length > 0) return true;
      // Description must be non-trivial (> 30 chars)
      if (b.description && b.description.trim().length > 30) return true;
      // ISBN presence alone is sufficient (Goodreads-imported published book)
      if (b.isbn) return true;
      return false;
    })
    .map((b): CandidateBook => ({
      id:                b.id,
      title:             b.title,
      author:            b.author,
      cover_url:         b.cover_url,
      external_id:       b.external_id,
      subjects:          b.subjects,
      page_count:        b.page_count,
      description:       b.description,
      _source:           'local_db',
      _retrieval_reason: 'local:eligible',
    }));

  return { candidates, readIds, readExternalIds };
}

// ── OL genre-matched retrieval ────────────────────────────────────────────────
// Fetches books from OL for the user's top liked genres.
// Deduplicates against both the user's library and local DB candidates.

async function getOLCandidates(
  profile: TasteProfile,
  readExternalIds: Set<string>,
  localExternalIds: Set<string>,
): Promise<CandidateBook[]> {
  const affinities  = profile.genre_affinities ?? {};
  const diagAnswers = profile.evidence.diagnosis_answer_count;

  // Liked genres: positive affinity, sorted descending
  let likedGenres = Object.entries(affinities)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([genre]) => genre)
    .slice(0, 2);

  // Fallback when affinities are empty (early-stage profile):
  // Use preferred trait keys to guess genre appetite, then fall back to general
  if (likedGenres.length === 0) {
    const pref = profile.preferred_traits;
    if ((pref['Insight'] ?? 0) + (pref['Evidence'] ?? 0) > 0.4) likedGenres = ['nonfiction', 'memoir_bio'];
    else if ((pref['Suspense'] ?? 0) + (pref['Pacing'] ?? 0) > 0.5) likedGenres = ['thriller_mystery'];
    else if ((pref['Worldbuilding'] ?? 0) > 0.4) likedGenres = ['fantasy_scifi'];
    else likedGenres = ['fiction' in GENRE_OL_SUBJECTS ? 'literary' : 'general'];
  }

  // Build fetch list: up to 2 subjects per genre, max 4 total
  const toFetch: Array<{ subject: string; reason: string }> = [];
  for (const genre of likedGenres) {
    const [s1, s2] = GENRE_OL_SUBJECTS[genre] ?? ['fiction', 'general fiction'];
    const reason = `ol:genre:${genre}`;
    if (toFetch.length < 4) toFetch.push({ subject: s1, reason });
    if (toFetch.length < 4) toFetch.push({ subject: s2, reason });
    if (toFetch.length >= 4) break;
  }

  // Parallel fetch — individual failures return [] via fetchOLSubject's catch
  const resultSets = await Promise.all(
    toFetch.map(({ subject, reason }) => fetchOLSubject(subject, 20, reason))
  );

  // Deduplicate by external_id, exclude user's library and local DB candidates
  const exclude = new Set([...readExternalIds, ...localExternalIds]);
  const seen    = new Set<string>();
  const merged: CandidateBook[] = [];

  for (const set of resultSets) {
    for (const book of set) {
      const key = book.external_id ?? book.id;
      if (seen.has(key) || exclude.has(key)) continue;
      seen.add(key);
      merged.push(book);
    }
  }

  return merged;
}

// ── Combined retrieval ────────────────────────────────────────────────────────

export async function getCandidateBooks(
  client: SupabaseClient,
  userId: string,
  profile: TasteProfile,
): Promise<CandidateBook[]> {
  // Run local DB retrieval first (fast — one DB query)
  const local = await getLocalCandidates(client, userId);

  const localExternalIds = new Set(
    local.candidates.map(c => c.external_id).filter((x): x is string => !!x)
  );

  // OL retrieval guided by the user's genre affinities
  const olCandidates = await getOLCandidates(profile, local.readExternalIds, localExternalIds);

  // OL candidates first so genre-matched books score against well-classified subjects;
  // local candidates supplement (they may have richer description/isbn data)
  return [...olCandidates, ...local.candidates];
}

// ── Scoring (pure) ────────────────────────────────────────────────────────────

export function scoreBookForUser(
  book: CandidateBook,
  profile: TasteProfile,
): Pick<ScoredBook, 'score' | 'confidence' | 'reasons' | 'risks'> {
  const bt         = getBookTraits(book);
  const pref       = profile.preferred_traits;
  const avoid      = profile.avoided_traits;
  const affinities = profile.genre_affinities ?? {};
  const reasons: string[] = [];
  const risks:   string[] = [];
  let score = 0;

  // 1. Preferred trait alignment
  const prefMatches: string[] = [];
  for (const [trait, userWeight] of Object.entries(pref)) {
    const bookWeight = bt.traits[trait] ?? 0;
    const contribution = userWeight * bookWeight;
    if (contribution > 0.22) {
      prefMatches.push(trait.toLowerCase());
      score += contribution;
    }
  }
  if (prefMatches.length >= 2) {
    reasons.push(`Aligns with your preference for ${prefMatches.slice(0, 2).join(' and ')}`);
  } else if (prefMatches.length === 1) {
    reasons.push(`Matches your appreciation for ${prefMatches[0]}`);
  }

  // 2. Avoided trait penalties
  const avoidHits: string[] = [];
  for (const [trait, penalty] of Object.entries(avoid)) {
    const bookWeight = bt.traits[trait] ?? 0;
    const contribution = penalty * bookWeight; // penalty < 0
    if (contribution < -0.18) {
      avoidHits.push(trait.toLowerCase());
      score += contribution;
    }
  }
  if (avoidHits.length > 0) {
    risks.push(`Leans toward ${avoidHits[0]} — which hasn't worked well for you`);
  }

  // 3. Genre affinity bonus / penalty
  if (bt.primaryGenre) {
    const affinity = affinities[bt.primaryGenre] ?? 0;
    if (affinity > 0.5) {
      score += 0.28;
      if (reasons.length < 2) reasons.push(`Fits a genre you consistently enjoy`);
    } else if (affinity > 0.2) {
      score += 0.12;
    } else if (affinity < -0.35) {
      score -= 0.22;
      if (risks.length < 1) {
        const label = bt.primaryGenre.replace('_', '/');
        risks.push(`You've had mixed results with ${label} before`);
      }
    }
  }

  const finalScore = Math.max(0, Math.min(1, score));

  let confidence: 'low' | 'medium' | 'high';
  if (profile.tier >= 3 && finalScore > 0.42) {
    confidence = 'high';
  } else if (profile.tier >= 2 && finalScore > 0.22) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    score:      +finalScore.toFixed(3),
    confidence,
    reasons:    [...new Set(reasons)].slice(0, 2),
    risks:      [...new Set(risks)].slice(0, 1),
  };
}

// ── Ranked recs (pure) ────────────────────────────────────────────────────────

export function getRankedRecs(
  candidates: CandidateBook[],
  profile: TasteProfile,
  limit = 5,
): ScoredBook[] {
  if (candidates.length === 0) return [];

  const poolSize = candidates.length;

  const scored = candidates.map(book => ({
    ...book,
    ...scoreBookForUser(book, profile),
    _debug: { pool_size: poolSize, rank: 0 },
  }));

  scored.sort((a, b) => b.score - a.score);

  // Diversity: max 2 books per primary genre
  const genreCount: Record<string, number> = {};
  const diverse: ScoredBook[] = [];
  let globalRank = 0;

  for (const book of scored) {
    globalRank++;
    const genre = getBookTraits(book).primaryGenre ?? 'general';
    const count = genreCount[genre] ?? 0;
    if (count < 2) {
      diverse.push({ ...book, _debug: { pool_size: poolSize, rank: globalRank } });
      genreCount[genre] = count + 1;
    }
    if (diverse.length >= limit) break;
  }

  return diverse;
}

// ── Convenience async wrapper ─────────────────────────────────────────────────

export async function getPersonalizedRecs(
  client: SupabaseClient,
  userId: string,
  profile: TasteProfile,
  limit = 5,
): Promise<ScoredBook[]> {
  const candidates = await getCandidateBooks(client, userId, profile);
  return getRankedRecs(candidates, profile, limit);
}
