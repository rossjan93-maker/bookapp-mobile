// Deno port of the Open Library lookup subset needed by the reconciler.
// Intentionally NOT a full port of lib/openLibrary.ts — only the high-
// confidence identifier paths (ISBN, ISBN13, works key) are implemented.
// Title+author search ("phase 3") is deliberately omitted from P1.5b-1
// per the approved plan; it would require a confidence-scoring layer to
// avoid false-positive auto-verification on common titles.

import type { CanonicalBookFields, LookupOutcome } from './types.ts';
import { tryAcquire, pauseProvider } from './rateLimiter.ts';

const OL_BASE = 'https://openlibrary.org';
const REQUEST_TIMEOUT_MS = 5000;

interface OLBibKeysEntry {
  url?: string;
  details?: {
    isbn_10?: string[];
    isbn_13?: string[];
    publish_date?: string;
    number_of_pages?: number;
    works?: Array<{ key?: string }>;
    title?: string;
    authors?: Array<{ name?: string }>;
  };
}

interface OLWork {
  key?: string;
  title?: string;
  description?: string | { value?: string };
  subjects?: string[];
  first_publish_date?: string;
  covers?: number[];
  authors?: Array<{ author?: { key?: string } }>;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractDescription(d: OLWork['description']): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.trim() || null;
  if (typeof d === 'object' && typeof d.value === 'string') return d.value.trim() || null;
  return null;
}

function parseYear(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 1000 && y <= 2100 ? y : null;
}

/**
 * Resolve an ISBN (10 or 13) → OL works key via /api/books?bibkeys=ISBN:...
 * Returns the canonical works key (e.g. /works/OL12345W) or null if not found.
 */
export async function resolveISBNToWorksKey(
  isbn: string,
): Promise<{ worksKey: string | null; httpStatus: number | null; error?: string }> {
  const url = `${OL_BASE}/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=details`;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url);
  } catch (err) {
    const e = err as Error;
    return { worksKey: null, httpStatus: null, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch_failed') };
  }
  if (resp.status === 429) {
    pauseProvider('open_library');
    return { worksKey: null, httpStatus: 429, error: 'rate_limited' };
  }
  if (!resp.ok) return { worksKey: null, httpStatus: resp.status, error: `http_${resp.status}` };

  let json: Record<string, OLBibKeysEntry>;
  try {
    json = await resp.json();
  } catch {
    return { worksKey: null, httpStatus: resp.status, error: 'parse_failed' };
  }
  const entry = json[`ISBN:${isbn}`];
  const worksRaw = entry?.details?.works?.[0]?.key ?? null;
  // Validate shape — only accept canonical /works/OL<digits>W form.
  if (worksRaw && /^\/works\/OL\d+W$/.test(worksRaw)) {
    return { worksKey: worksRaw, httpStatus: resp.status };
  }
  return { worksKey: null, httpStatus: resp.status };
}

/**
 * Fetch the works metadata for an OL works key. Combined with the ISBN
 * resolver above, this gives us the canonical title/author/description/
 * subjects for a verified row.
 */
export async function fetchWorksMetadata(
  worksKey: string,
): Promise<{ fields: CanonicalBookFields | null; httpStatus: number | null; error?: string }> {
  if (!/^\/works\/OL\d+W$/.test(worksKey)) {
    return { fields: null, httpStatus: null, error: 'invalid_works_key' };
  }
  const url = `${OL_BASE}${worksKey}.json`;
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url);
  } catch (err) {
    const e = err as Error;
    return { fields: null, httpStatus: null, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch_failed') };
  }
  if (resp.status === 429) {
    pauseProvider('open_library');
    return { fields: null, httpStatus: 429, error: 'rate_limited' };
  }
  if (resp.status === 404) return { fields: null, httpStatus: 404, error: 'not_found' };
  if (!resp.ok) return { fields: null, httpStatus: resp.status, error: `http_${resp.status}` };

  let work: OLWork;
  try {
    work = await resp.json() as OLWork;
  } catch {
    return { fields: null, httpStatus: resp.status, error: 'parse_failed' };
  }

  const coverId = Array.isArray(work.covers) ? work.covers.find((n) => typeof n === 'number' && n > 0) : null;
  const fields: CanonicalBookFields = {
    external_id: worksKey,
    cover_url: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
    description: extractDescription(work.description),
    subjects: Array.isArray(work.subjects) ? work.subjects.slice(0, 50) : null,
    original_publication_year: parseYear(work.first_publish_date),
  };
  return { fields, httpStatus: resp.status };
}

/**
 * Top-level lookup helper used by the reconciler. Acquires a rate-limit
 * token before making the network call; returns a normalized LookupOutcome.
 */
export async function lookupOpenLibrary(
  kind: 'isbn' | 'isbn13' | 'works_key',
  identifier: string,
): Promise<LookupOutcome> {
  const start = Date.now();
  if (!tryAcquire('open_library')) {
    return {
      provider: 'open_library',
      lookup_kind: kind,
      identifier,
      status: 'rate_limited',
      latency_ms: 0,
      http_status: null,
      error_detail: 'local_bucket_empty',
      conflict_field: null,
      fields: null,
    };
  }

  let worksKey: string | null = null;
  let httpStatus: number | null = null;

  if (kind === 'works_key') {
    worksKey = identifier;
  } else {
    const r = await resolveISBNToWorksKey(identifier);
    httpStatus = r.httpStatus;
    if (r.error === 'timeout') {
      return mkOutcome(kind, identifier, 'timeout', start, httpStatus, r.error, null);
    }
    if (r.error === 'rate_limited') {
      return mkOutcome(kind, identifier, 'rate_limited', start, httpStatus, r.error, null);
    }
    if (!r.worksKey) {
      return mkOutcome(kind, identifier, 'not_found', start, httpStatus, r.error ?? null, null);
    }
    worksKey = r.worksKey;
  }

  // Need a second token for the works fetch.
  if (kind !== 'works_key' && !tryAcquire('open_library')) {
    return mkOutcome(kind, identifier, 'rate_limited', start, httpStatus, 'local_bucket_empty', null);
  }

  const w = await fetchWorksMetadata(worksKey!);
  if (w.error === 'timeout') {
    return mkOutcome(kind, identifier, 'timeout', start, w.httpStatus, w.error, null);
  }
  if (w.error === 'rate_limited') {
    return mkOutcome(kind, identifier, 'rate_limited', start, w.httpStatus, w.error, null);
  }
  if (w.error === 'not_found' || !w.fields) {
    return mkOutcome(kind, identifier, 'not_found', start, w.httpStatus, w.error ?? null, null);
  }
  if (w.error) {
    return mkOutcome(kind, identifier, 'provider_error', start, w.httpStatus, w.error, null);
  }
  return mkOutcome(kind, identifier, 'success', start, w.httpStatus, null, w.fields);
}

function mkOutcome(
  kind: 'isbn' | 'isbn13' | 'works_key',
  identifier: string,
  status: LookupOutcome['status'],
  start: number,
  httpStatus: number | null,
  error: string | null,
  fields: CanonicalBookFields | null,
): LookupOutcome {
  return {
    provider: 'open_library',
    lookup_kind: kind,
    identifier,
    status,
    latency_ms: Date.now() - start,
    http_status: httpStatus,
    error_detail: error ? error.slice(0, 500) : null,
    conflict_field: null,
    fields,
  };
}
