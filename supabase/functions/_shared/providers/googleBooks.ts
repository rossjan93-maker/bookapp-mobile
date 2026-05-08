// Deno port of the Google Books lookup subset needed by the reconciler.
// Implements only ISBN search and direct volume-id fetch; mirrors the
// "high-confidence identifiers only" policy from openLibrary.ts.
//
// Uses GOOGLE_BOOKS_API_KEY from Edge Function env when present; falls back
// to unauthenticated requests (1000/day public quota — fine for reconciler
// minute-rate cap of 60/min, since the reconciler runs at most every hour).

import type { CanonicalBookFields, LookupOutcome } from './types.ts';
import { tryAcquire, pauseProvider } from './rateLimiter.ts';

const GB_BASE = 'https://www.googleapis.com/books/v1';
const REQUEST_TIMEOUT_MS = 5000;
const API_KEY = Deno.env.get('GOOGLE_BOOKS_API_KEY') ?? null;

interface GBVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    description?: string;
    categories?: string[];
    publishedDate?: string;
    pageCount?: number;
    imageLinks?: {
      thumbnail?: string;
      smallThumbnail?: string;
      small?: string;
      medium?: string;
      large?: string;
      extraLarge?: string;
    };
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
  };
}

interface GBSearchResponse {
  totalItems?: number;
  items?: GBVolume[];
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function withKey(url: string): string {
  if (!API_KEY) return url;
  return url + (url.includes('?') ? '&' : '?') + `key=${encodeURIComponent(API_KEY)}`;
}

function parseYear(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 1000 && y <= 2100 ? y : null;
}

function bestCover(links: GBVolume['volumeInfo']['imageLinks'] | undefined): string | null {
  if (!links) return null;
  const candidate =
    links.extraLarge || links.large || links.medium || links.small || links.thumbnail || links.smallThumbnail || null;
  if (!candidate) return null;
  // Strip the http: prefix Google sometimes returns; force https.
  return candidate.replace(/^http:\/\//, 'https://');
}

function extractIsbns(ids: GBVolume['volumeInfo']['industryIdentifiers'] | undefined): {
  isbn: string | null;
  isbn13: string | null;
} {
  let isbn: string | null = null;
  let isbn13: string | null = null;
  if (!Array.isArray(ids)) return { isbn, isbn13 };
  for (const id of ids) {
    if (id?.type === 'ISBN_10' && id.identifier && !isbn) isbn = id.identifier;
    if (id?.type === 'ISBN_13' && id.identifier && !isbn13) isbn13 = id.identifier;
  }
  return { isbn, isbn13 };
}

function volumeToFields(v: GBVolume): CanonicalBookFields | null {
  if (!v?.id || !v.volumeInfo) return null;
  const vi = v.volumeInfo;
  const { isbn, isbn13 } = extractIsbns(vi.industryIdentifiers);
  return {
    external_id: `gb:${v.id}`,
    cover_url: bestCover(vi.imageLinks),
    description: vi.description ? vi.description.trim() || null : null,
    subjects: Array.isArray(vi.categories) ? vi.categories.slice(0, 30) : null,
    isbn,
    isbn13,
    publication_year: parseYear(vi.publishedDate),
  };
}

async function fetchVolumeById(volumeId: string): Promise<{
  fields: CanonicalBookFields | null;
  httpStatus: number | null;
  error?: string;
}> {
  const url = withKey(`${GB_BASE}/volumes/${encodeURIComponent(volumeId)}`);
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url);
  } catch (err) {
    const e = err as Error;
    return { fields: null, httpStatus: null, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch_failed') };
  }
  if (resp.status === 429) {
    pauseProvider('google_books');
    return { fields: null, httpStatus: 429, error: 'rate_limited' };
  }
  if (resp.status === 404) return { fields: null, httpStatus: 404, error: 'not_found' };
  if (!resp.ok) return { fields: null, httpStatus: resp.status, error: `http_${resp.status}` };

  let v: GBVolume;
  try {
    v = await resp.json() as GBVolume;
  } catch {
    return { fields: null, httpStatus: resp.status, error: 'parse_failed' };
  }
  const fields = volumeToFields(v);
  if (!fields) return { fields: null, httpStatus: resp.status, error: 'unparseable_volume' };
  return { fields, httpStatus: resp.status };
}

async function searchByIsbn(isbn: string): Promise<{
  fields: CanonicalBookFields | null;
  httpStatus: number | null;
  error?: string;
}> {
  const url = withKey(`${GB_BASE}/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`);
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url);
  } catch (err) {
    const e = err as Error;
    return { fields: null, httpStatus: null, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch_failed') };
  }
  if (resp.status === 429) {
    pauseProvider('google_books');
    return { fields: null, httpStatus: 429, error: 'rate_limited' };
  }
  if (!resp.ok) return { fields: null, httpStatus: resp.status, error: `http_${resp.status}` };

  let body: GBSearchResponse;
  try {
    body = await resp.json() as GBSearchResponse;
  } catch {
    return { fields: null, httpStatus: resp.status, error: 'parse_failed' };
  }
  const v = body.items?.[0];
  if (!v) return { fields: null, httpStatus: resp.status, error: 'not_found' };
  const fields = volumeToFields(v);
  if (!fields) return { fields: null, httpStatus: resp.status, error: 'unparseable_volume' };
  return { fields, httpStatus: resp.status };
}

export async function lookupGoogleBooks(
  kind: 'isbn' | 'isbn13' | 'volume_id',
  identifier: string,
): Promise<LookupOutcome> {
  const start = Date.now();
  if (!tryAcquire('google_books')) {
    return mk(kind, identifier, 'rate_limited', start, null, 'local_bucket_empty', null);
  }

  const r = kind === 'volume_id' ? await fetchVolumeById(identifier) : await searchByIsbn(identifier);

  if (r.error === 'timeout') return mk(kind, identifier, 'timeout', start, r.httpStatus, r.error, null);
  if (r.error === 'rate_limited') return mk(kind, identifier, 'rate_limited', start, r.httpStatus, r.error, null);
  if (r.error === 'not_found' || !r.fields) return mk(kind, identifier, 'not_found', start, r.httpStatus, r.error ?? null, null);
  if (r.error) return mk(kind, identifier, 'provider_error', start, r.httpStatus, r.error, null);
  return mk(kind, identifier, 'success', start, r.httpStatus, null, r.fields);
}

function mk(
  kind: 'isbn' | 'isbn13' | 'volume_id',
  identifier: string,
  status: LookupOutcome['status'],
  start: number,
  httpStatus: number | null,
  error: string | null,
  fields: CanonicalBookFields | null,
): LookupOutcome {
  return {
    provider: 'google_books',
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
