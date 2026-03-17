// =============================================================================
// debugRepairBook — TEMPORARY single-book forensic repair with full logging
// =============================================================================
// Targets exactly one books row by title + author fragment.  Logs every step
// of the metadata chain so the exact failure point is observable in the
// Settings dev-tools panel.
//
// Remove this file once the Glow row is confirmed fixed.
// =============================================================================

import { supabase }                          from './supabase';
import { isOLId, searchOLWork, fetchOLMeta } from './openLibrary';
import { titleSearchVariants }               from './titleNormalize';
import { gbApiKeyPresent }                   from './googleBooks';

export type DebugRepairResult = {
  log:      string[];
  patch:    Record<string, unknown>;
  finalRow: Record<string, unknown> | null;
};

// Minimum page count considered credible (mirrors googleBooks.ts)
const MIN_CREDIBLE_PAGES = 30;

// Brief sleep for the 429 bounded retry (mirrors googleBooks.ts)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Title-match helper — mirrors the logic in lib/googleBooks.ts exactly.
function cleanTitle(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function significantWords(s: string): string[] {
  return cleanTitle(s).split(' ').filter(w => w.length > 3);
}
const TITLE_MATCH_THRESHOLD = 0.6;
function titleMatches(expected: string, result: string): boolean {
  const expectedClean = cleanTitle(expected);
  const expectedWords = significantWords(expected);
  if (expectedWords.length > 0) {
    const fwdHits = expectedWords.filter(w => cleanTitle(result).includes(w)).length;
    if (fwdHits / expectedWords.length >= TITLE_MATCH_THRESHOLD) return true;
  }
  const resWords = significantWords(result);
  if (resWords.length === 0) return false;
  const revHits = resWords.filter(w => expectedClean.includes(w)).length;
  return revHits / resWords.length >= TITLE_MATCH_THRESHOLD;
}

// 429-aware fetch: one retry after 1.5 s, then gives up.
// Returns rateLimited=true when both the initial call and retry were 429.
type DbgFetchResult =
  | { ok: true;  rateLimited: false; status: number; data: unknown }
  | { ok: false; rateLimited: true;  status: 429 }
  | { ok: false; rateLimited: false; status: number };

async function dbgFetch(url: string): Promise<DbgFetchResult> {
  try {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(1500);
      try {
        const retry = await fetch(url);
        if (retry.status === 429) return { ok: false, rateLimited: true,  status: 429 };
        if (!retry.ok)            return { ok: false, rateLimited: false, status: retry.status };
        return { ok: true, rateLimited: false, status: retry.status, data: await retry.json() };
      } catch {
        return { ok: false, rateLimited: true, status: 429 };
      }
    }
    if (!res.ok) return { ok: false, rateLimited: false, status: res.status };
    return { ok: true, rateLimited: false, status: res.status, data: await res.json() };
  } catch (e: unknown) {
    return { ok: false, rateLimited: false, status: 0 };
  }
}

// Google Books response shape (only the fields we care about)
type GBVolumeInfo = {
  title?:       string;
  authors?:     string[];
  imageLinks?:  { thumbnail?: string; smallThumbnail?: string };
  description?: string;
  pageCount?:   number;
};
type GBItems = Array<{ volumeInfo?: GBVolumeInfo }>;

export async function debugRepairBook(
  titleFragment: string,
  authorFragment: string,
): Promise<DebugRepairResult> {
  const log:   string[] = [];
  const patch: Record<string, unknown> = {};

  const step = (msg: string) => {
    log.push(msg);
    console.log(`[debugRepair] ${msg}`);
  };

  if (!supabase) {
    step('ABORT: supabase client not available');
    return { log, patch, finalRow: null };
  }

  // ── 1. Fetch the target row ──────────────────────────────────────────────
  step(`Searching books for title~="${titleFragment}" author~="${authorFragment}"`);

  const { data: rows, error: fetchErr } = await supabase
    .from('books')
    .select('id, title, author, external_id, isbn13, isbn, cover_url, description, subjects, page_count')
    .ilike('title',  `%${titleFragment}%`)
    .ilike('author', `%${authorFragment}%`)
    .limit(5);

  if (fetchErr) {
    step(`FETCH ERROR: ${fetchErr.message}`);
    return { log, patch, finalRow: null };
  }
  if (!rows || rows.length === 0) {
    step('ABORT: no books row matched — check title/author fragments');
    return { log, patch, finalRow: null };
  }
  if (rows.length > 1) {
    step(`WARNING: ${rows.length} rows matched — using first result`);
  }

  const book   = rows[0] as Record<string, unknown>;
  const bookId = book.id as string;

  step(`Fetched row id=${bookId}`);
  step(`  title        : ${book.title}`);
  step(`  author       : ${book.author}`);
  step(`  external_id  : ${book.external_id ?? 'null'}`);
  step(`  isbn13       : ${book.isbn13 ?? 'null'}`);
  step(`  isbn         : ${book.isbn   ?? 'null'}`);
  step(`  cover_url    : ${book.cover_url ?? 'null'}`);
  step(`  description  : ${book.description ? String(book.description).slice(0, 60) + '…' : 'null'}`);
  step(`  subjects     : ${Array.isArray(book.subjects) ? JSON.stringify(book.subjects) : 'null'}`);
  step(`  page_count   : ${book.page_count ?? 'null'}`);

  const rawExtId = (book.external_id as string | null) ?? null;
  const hasOLId  = isOLId(rawExtId);
  step(`external_id is OL-compatible: ${hasOLId} (value="${rawExtId}")`);

  const hasCover    = !!book.cover_url;
  const hasDesc     = !!book.description;
  const hasSubjects = Array.isArray(book.subjects) && (book.subjects as string[]).length > 0;
  const hasPages    = !!book.page_count;

  step(`Current state — cover:${hasCover} desc:${hasDesc} subjects:${hasSubjects} pages:${hasPages}`);

  if (hasCover && hasDesc && hasSubjects && hasPages) {
    step('All fields already present — nothing to repair');
    return { log, patch, finalRow: book };
  }

  // ── 2. Resolve OL work id ────────────────────────────────────────────────
  let olId: string | null = hasOLId ? rawExtId : null;

  if (!olId && (!hasDesc || !hasSubjects)) {
    const t = String(book.title  ?? '').trim();
    const a = String(book.author ?? '').trim();
    const variants = titleSearchVariants(t);
    step(`OL search: title variants to try: ${JSON.stringify(variants)}`);
    const found = await searchOLWork(t, a);
    if (found) {
      step(`OL search result: FOUND ${found}`);
      olId = found;
    } else {
      step('OL search result: nothing found — title+author not in OL');
    }
  } else if (olId) {
    step(`Using existing OL id: ${olId}`);
  } else {
    step('OL search skipped — description and subjects already present');
  }

  // ── 3. Fetch OL metadata ─────────────────────────────────────────────────
  let foundDesc:     string | null = null;
  let foundSubjects: string[]      = [];
  let foundPages:    number | null = null;

  if (olId) {
    step(`fetchOLMeta("${olId}")`);
    const ol = await fetchOLMeta(olId);
    step(`  OL description : ${ol.description ? ol.description.slice(0, 80) + '…' : 'null'}`);
    step(`  OL subjects    : ${JSON.stringify(ol.subjects)} (count=${ol.subjects.length})`);
    step(`  OL pageCount   : ${ol.pageCount ?? 'null'}`);

    if (!hasDesc     && ol.description)         { foundDesc     = ol.description; step('  → will use OL description'); }
    if (!hasSubjects && ol.subjects.length > 0)  { foundSubjects = ol.subjects;   step('  → will use OL subjects'); }
    if (!hasPages    && ol.pageCount)            { foundPages    = ol.pageCount;  step('  → will use OL pageCount'); }

    if (!ol.description)          step('  OL description absent for this work — source data gap');
    if (ol.subjects.length === 0) step('  OL subjects absent for this work — source data gap');
    if (!ol.pageCount)            step('  OL pageCount absent for this work');
  }

  // ── 4. Google Books — verbose inline trace ───────────────────────────────
  // Replicate the fetchGoogleBooksMetadata strategy loop with full per-step
  // logging so we can see exactly where the GB phase succeeds or fails.
  const needGb = !hasCover || (!hasDesc && !foundDesc) || (!hasPages && !foundPages);
  step(`needGb=${needGb} (hasCover=${hasCover} hasDesc=${hasDesc} foundDesc=${!!foundDesc} hasPages=${hasPages} foundPages=${!!foundPages})`);

  let foundCover: string | null = null;
  let gbHitQuota = false;

  if (needGb) {
    const t      = String(book.title  ?? '').trim();
    const a      = String(book.author ?? '').trim();
    const isbn13 = (book.isbn13 as string | null) ?? null;
    const isbn   = (book.isbn   as string | null) ?? null;

    step('=== Google Books verbose trace ===');
    step(`API key present: ${gbApiKeyPresent ? 'YES — requests will include key' : 'NO — anonymous quota in use (shared per-IP, easily exhausted)'}`);
    if (!gbApiKeyPresent) {
      step('NOTE: to fix quota issues, set EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY as a Replit secret');
    }

    // Build strategies (exact mirror of fetchGoogleBooksMetadata)
    const strategies: Array<{ q: string; skipTitleCheck: boolean; label: string }> = [];
    if (isbn13?.trim()) {
      strategies.push({ q: `isbn:${isbn13.trim()}`, skipTitleCheck: true, label: 'isbn13' });
    } else if (isbn?.trim()) {
      strategies.push({ q: `isbn:${isbn.trim()}`,   skipTitleCheck: true, label: 'isbn' });
    }
    const authorTrimmed = a.slice(0, 40).trim();
    const skipAuthor    = !authorTrimmed || /^unknown\s+author$/i.test(authorTrimmed);
    const variants      = titleSearchVariants(t);
    step(`Title variants: ${JSON.stringify(variants)}`);
    step(`Author: "${authorTrimmed}" | skipAuthor=${skipAuthor}`);
    for (const variant of variants) {
      const parts = [`intitle:${variant.slice(0, 50).trim()}`];
      if (!skipAuthor) parts.push(`inauthor:${authorTrimmed}`);
      strategies.push({ q: parts.join(' '), skipTitleCheck: false, label: `title:"${variant}"` });
    }
    step(`Total GB strategies: ${strategies.length}`);

    // Execute each strategy — stop on success OR rate-limit
    let gbDone = false;
    for (const { q, skipTitleCheck, label } of strategies) {
      if (gbDone || gbHitQuota) break;

      step(`--- Strategy [${label}] ---`);
      step(`  query: "${q}"`);

      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&langRestrict=en&printType=books`;
      const res = await dbgFetch(url);

      if (res.rateLimited) {
        step(`  HTTP 429 RATE LIMIT / QUOTA EXCEEDED (tried once + 1.5 s retry, still 429)`);
        step('  → stopping GB strategy loop: quota exhausted');
        gbHitQuota = true;
        break;
      }

      step(`  HTTP ${res.status} ${res.ok ? 'OK' : 'ERROR'}`);

      if (!res.ok) {
        step('  SKIP — non-OK HTTP response');
        continue;
      }

      const data = res.data as { totalItems?: number; items?: GBItems; error?: { code: number; message: string } };
      if (data.error) {
        step(`  API-level error ${data.error.code}: ${data.error.message}`);
        continue;
      }

      const items: GBItems = data.items ?? [];
      step(`  totalItems=${data.totalItems ?? 0} | returned=${items.length}`);
      if (items.length === 0) {
        step('  SKIP — no items returned');
        continue;
      }

      for (let i = 0; i < Math.min(items.length, 5); i++) {
        const vi = items[i]?.volumeInfo;
        if (!vi) { step(`  [${i}] no volumeInfo — skip`); continue; }

        const candidateTitle  = vi.title ?? '(no title)';
        const candidateAuthor = (vi.authors ?? []).join(', ') || '(no author)';
        const hasThumbnail    = !!(vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail);
        const hasGbDesc       = typeof vi.description === 'string' && vi.description.length > 30;
        const hasGbPages      = typeof vi.pageCount === 'number' && vi.pageCount >= MIN_CREDIBLE_PAGES;

        let matchVerdict = 'SKIP_TITLE_CHECK';
        if (!skipTitleCheck) {
          matchVerdict = titleMatches(t, candidateTitle) ? 'PASS' : 'FAIL';
        }

        step(`  [${i}] title="${candidateTitle}" | author="${candidateAuthor}" | match=${matchVerdict} | thumb=${hasThumbnail} | desc=${hasGbDesc} | pages=${hasGbPages}`);

        if (!skipTitleCheck && matchVerdict === 'FAIL') {
          step('        → rejected by title match');
          continue;
        }

        const thumbnail = vi.imageLinks?.thumbnail ?? vi.imageLinks?.smallThumbnail;

        if (!hasCover && !foundCover && thumbnail) {
          foundCover = thumbnail.replace(/^http:\/\//, 'https://');
          step(`        → ACCEPTED cover_url: "${foundCover}"`);
        }
        if (!hasDesc && !foundDesc && hasGbDesc) {
          foundDesc = vi.description!;
          step(`        → ACCEPTED description: "${foundDesc.slice(0, 100)}…"`);
        }
        if (!hasPages && !foundPages && hasGbPages) {
          foundPages = vi.pageCount!;
          step(`        → ACCEPTED page_count: ${foundPages}`);
        }

        if (foundCover || foundDesc || foundPages) {
          step('        → committing to this item and stopping GB loop');
          gbDone = true;
          break;
        }

        step('        → item has no usable new fields — trying next item');
      }

      if (!gbDone) {
        step('  No usable item found in this strategy — trying next strategy');
      }
    }

    step('=== end Google Books verbose trace ===');

    if (gbHitQuota) {
      step('GB VERDICT: QUOTA/RATE LIMIT — all strategies blocked by HTTP 429');
      step('  Fix: set EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY as a Replit secret and restart the app');
    } else {
      if (!foundCover)  step('GB result: NO cover found from any strategy');
      if (!foundDesc)   step('GB result: NO description found from any strategy');
      if (!foundPages)  step('GB result: NO page_count found from any strategy');
    }
  } else {
    step('Google Books skipped — all needed fields already present');
  }

  // ── 5. Build final patch ─────────────────────────────────────────────────
  if (olId && !hasOLId)          patch.external_id  = olId;
  if (foundCover && !hasCover)   patch.cover_url    = foundCover;
  if (foundDesc  && !hasDesc)    patch.description  = foundDesc;
  if (foundSubjects.length > 0)  patch.subjects     = foundSubjects;
  if (foundPages && !hasPages)   patch.page_count   = foundPages;

  step(`Final patch keys: [${Object.keys(patch).join(', ') || 'NONE'}]`);
  step(`Final patch: ${JSON.stringify(patch, null, 2)}`);

  if (Object.keys(patch).length === 0) {
    if (gbHitQuota) {
      step('Patch is empty — Google Books quota was the blocker; no fields could be fetched');
    } else {
      step('Patch is empty — nothing new found; no DB write performed');
    }
    return { log, patch, finalRow: book };
  }

  // ── 6. Apply DB update ───────────────────────────────────────────────────
  step(`Applying DB update for books.id=${bookId} …`);
  const { error: updateErr, status: updateStatus } = await supabase
    .from('books')
    .update(patch)
    .eq('id', bookId);

  if (updateErr) {
    step(`DB UPDATE ERROR (HTTP ${updateStatus}): code=${updateErr.code} message="${updateErr.message}" details="${updateErr.details ?? ''}"`);
  } else {
    step(`DB update succeeded (HTTP ${updateStatus})`);
  }

  // ── 7. Re-fetch final row to confirm persistence ─────────────────────────
  const { data: finalRows, error: refetchErr } = await supabase
    .from('books')
    .select('id, external_id, isbn13, isbn, cover_url, description, subjects, page_count')
    .eq('id', bookId)
    .limit(1);

  if (refetchErr) {
    step(`Re-fetch ERROR: ${refetchErr.message}`);
  }

  const finalRow = (finalRows?.[0] as Record<string, unknown> | null) ?? null;

  if (finalRow) {
    step('Final DB row after update:');
    step(`  external_id  : ${finalRow.external_id ?? 'null'}`);
    step(`  cover_url    : ${finalRow.cover_url   ?? 'null'}`);
    step(`  description  : ${finalRow.description ? String(finalRow.description).slice(0, 60) + '…' : 'null'}`);
    step(`  subjects     : ${Array.isArray(finalRow.subjects) ? JSON.stringify(finalRow.subjects) : 'null'}`);
    step(`  page_count   : ${finalRow.page_count  ?? 'null'}`);

    const gotCover = !!finalRow.cover_url;
    const gotDesc  = !!finalRow.description;
    if (gotCover && gotDesc) {
      step('VERDICT: cover_url and description now populated ✓');
    } else if (gbHitQuota) {
      step('VERDICT: Google Books quota/rate limit blocked cover/description retrieval');
      step('  → Set EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY secret and restart the app to resolve');
    } else {
      if (!gotCover) step('VERDICT: cover_url still null — see GB trace above for root cause');
      if (!gotDesc)  step('VERDICT: description still null — see GB trace above for root cause');
    }
  } else {
    step('WARNING: could not re-fetch row after update');
  }

  step('=== debugRepairBook complete ===');
  return { log, patch, finalRow };
}
