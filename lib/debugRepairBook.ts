// =============================================================================
// debugRepairBook — TEMPORARY single-book forensic repair with full logging
// =============================================================================
// Targets exactly one books row by title + author fragment.  Logs every step
// of the metadata chain so the exact failure point is observable in the
// console / Metro bundler output.
//
// Remove this file once the Glow row is confirmed fixed.
// =============================================================================

import { supabase }                from './supabase';
import { isOLId, searchOLWork, fetchOLMeta } from './openLibrary';
import { fetchGoogleBooksMetadata }           from './googleBooks';
import { titleSearchVariants }                from './titleNormalize';

export type DebugRepairResult = {
  log:    string[];
  patch:  Record<string, unknown>;
  finalRow: Record<string, unknown> | null;
};

export async function debugRepairBook(
  titleFragment: string,
  authorFragment: string,
): Promise<DebugRepairResult> {
  const log: string[] = [];
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

  const book = rows[0] as Record<string, unknown>;
  const bookId = book.id as string;

  step(`Fetched row id=${bookId}`);
  step(`  title        : ${book.title}`);
  step(`  author       : ${book.author}`);
  step(`  external_id  : ${book.external_id ?? 'null'}`);
  step(`  isbn13       : ${book.isbn13 ?? 'null'}`);
  step(`  isbn         : ${book.isbn ?? 'null'}`);
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

    if (!hasDesc     && ol.description)         { foundDesc     = ol.description;  step('  → will use OL description'); }
    if (!hasSubjects && ol.subjects.length > 0)  { foundSubjects = ol.subjects;     step('  → will use OL subjects'); }
    if (!hasPages    && ol.pageCount)            { foundPages    = ol.pageCount;    step('  → will use OL pageCount'); }

    if (!ol.description) step('  OL description absent for this work — source data gap');
    if (ol.subjects.length === 0) step('  OL subjects absent for this work — source data gap');
    if (!ol.pageCount)   step('  OL pageCount absent — will try editions scan / Google Books');
  }

  // ── 4. Fetch Google Books metadata ───────────────────────────────────────
  const needGb = !hasCover || (!hasDesc && !foundDesc) || (!hasPages && !foundPages);
  if (needGb) {
    const t      = String(book.title  ?? '').trim();
    const a      = String(book.author ?? '').trim();
    const isbn13 = (book.isbn13 as string | null) ?? null;
    const isbn   = (book.isbn   as string | null) ?? null;
    step(`fetchGoogleBooksMetadata("${t}", isbn13=${isbn13 ?? 'null'}, isbn=${isbn ?? 'null'})`);
    const gb = await fetchGoogleBooksMetadata({ isbn13, isbn, title: t, author: a });
    step(`  GB cover_url   : ${gb.cover_url ?? 'null'}`);
    step(`  GB description : ${gb.description ? gb.description.slice(0, 80) + '…' : 'null'}`);
    step(`  GB page_count  : ${gb.page_count ?? 'null'}`);

    if (!hasCover               && gb.cover_url)   { patch.cover_url   = gb.cover_url;   step('  → will use GB cover_url'); }
    if (!hasDesc  && !foundDesc && gb.description) { foundDesc         = gb.description; step('  → will use GB description'); }
    if (!hasPages && !foundPages && gb.page_count)  { foundPages        = gb.page_count;  step('  → will use GB page_count'); }

    if (!gb.cover_url)   step('  GB cover absent — no usable cover found from any source');
    if (!gb.description) step('  GB description absent — no usable description from any source');
  } else {
    step('Google Books skipped — cover + desc + pages all resolved');
  }

  // ── 5. Build patch ───────────────────────────────────────────────────────
  if (olId && !hasOLId)  patch.external_id  = olId;
  if (foundDesc)         patch.description  = foundDesc;
  if (foundSubjects.length > 0) patch.subjects = foundSubjects;
  if (foundPages && !hasPages)  patch.page_count = foundPages;

  step(`Final patch: ${JSON.stringify(patch)}`);

  if (Object.keys(patch).length === 0) {
    step('Patch is empty — nothing new was found; no DB write needed');
    return { log, patch, finalRow: book };
  }

  // ── 6. Apply DB update ───────────────────────────────────────────────────
  step(`Applying DB update for id=${bookId} …`);
  const { error: updateErr } = await supabase
    .from('books')
    .update(patch)
    .eq('id', bookId);

  if (updateErr) {
    step(`DB UPDATE ERROR: ${updateErr.message}`);
  } else {
    step('DB update succeeded');
  }

  // ── 7. Fetch final row ───────────────────────────────────────────────────
  const { data: finalRows } = await supabase
    .from('books')
    .select('id, external_id, isbn13, isbn, cover_url, description, subjects, page_count')
    .eq('id', bookId)
    .limit(1);

  const finalRow = (finalRows?.[0] as Record<string, unknown> | null) ?? null;

  if (finalRow) {
    step('Final DB row:');
    step(`  external_id  : ${finalRow.external_id ?? 'null'}`);
    step(`  cover_url    : ${finalRow.cover_url ?? 'null'}`);
    step(`  description  : ${finalRow.description ? String(finalRow.description).slice(0, 60) + '…' : 'null'}`);
    step(`  subjects     : ${Array.isArray(finalRow.subjects) ? JSON.stringify(finalRow.subjects) : 'null'}`);
    step(`  page_count   : ${finalRow.page_count ?? 'null'}`);
  } else {
    step('WARNING: could not re-fetch row after update');
  }

  step('=== debugRepairBook complete ===');
  return { log, patch, finalRow };
}
