// =============================================================================
// Goodreads CSV Parser + Normalizer
// =============================================================================
// Parses Goodreads export CSVs into structured, staging-ready rows.
// - Handles RFC 4180 quoting (embedded commas, newlines, escaped quotes)
// - Cleans Goodreads' ="..." ISBN encoding
// - Normalizes dates from YYYY/MM/DD to YYYY-MM-DD
// - Tolerant of missing optional columns
// =============================================================================

export type ParsedGoodreadsRow = {
  source_book_id: string;               // "Book Id" from Goodreads
  title: string;
  author: string;
  additional_authors: string | null;
  isbn: string | null;                  // stripped of ="..." wrapper, digits only
  isbn13: string | null;
  publisher: string | null;
  binding: string | null;
  page_count: number | null;
  publication_year: number | null;
  original_publication_year: number | null;
  exclusive_shelf: string;              // 'read' | 'currently-reading' | 'to-read' | custom
  raw_shelves: string[];
  raw_shelf_positions: Record<string, number> | null;
  source_rating: number | null;         // 1–5 or null (0 = unrated in Goodreads)
  date_read: string | null;             // ISO YYYY-MM-DD
  date_added: string | null;            // ISO YYYY-MM-DD
  review_body: string | null;
  review_contains_spoiler: boolean;
  private_note: string | null;
  read_count: number | null;
  owned_copies: number | null;
  raw_data: Record<string, string>;     // verbatim CSV row, preserved intact
};

export type ParseError = {
  rowIndex: number;
  message: string;
};

export type ParseResult = {
  rows: ParsedGoodreadsRow[];
  parseErrors: ParseError[];
  totalRaw: number;
  isGoodreadsExport: boolean;
};

// Columns required to consider a file a Goodreads export.
const REQUIRED_COLUMNS = ['Book Id', 'Title', 'Author', 'Exclusive Shelf'] as const;

// =============================================================================
// RFC 4180 CSV parser
// =============================================================================

function parseCSVAll(text: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuote = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        inQuote = false;
        i++;
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ',') {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\r' && text[i + 1] === '\n') {
        row.push(field);
        field = '';
        result.push(row);
        row = [];
        i += 2;
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        result.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Flush final row
  row.push(field);
  if (row.some(f => f !== '')) result.push(row);

  return result;
}

// =============================================================================
// Field normalizers
// =============================================================================

// Goodreads exports ISBNs as: ="0451524934"  (= prefix + "..." wrapper)
// After CSV parsing the outer quotes are stripped, leaving: ="0451524934"
// Strip the ="..." wrapper, return null for empty/placeholder values.
function cleanISBN(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === '' || s === '=""' || s === '=') return null;
  // Strip ="..." wrapper
  const wrapped = s.match(/^="?([^"]*)"?$/);
  const digits = wrapped ? wrapped[1] : s;
  // Keep only digits (and X for ISBN-10 check digit)
  const clean = digits.replace(/[^0-9Xx]/g, '');
  return clean.length > 0 ? clean : null;
}

// Goodreads dates: YYYY/MM/DD  →  YYYY-MM-DD
function normalizeDate(raw: string): string | null {
  if (!raw || raw.trim() === '') return null;
  const s = raw.trim();
  const slashMatch = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[3].padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function parseIntField(raw: string): number | null {
  if (!raw || raw.trim() === '') return null;
  const n = parseInt(raw.trim(), 10);
  return isNaN(n) ? null : n;
}

function parseShelves(raw: string): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// "shelf (#1), other shelf (#2)" → { shelf: 1, "other shelf": 2 }
function parseShelfPositions(raw: string): Record<string, number> | null {
  if (!raw || raw.trim() === '') return null;
  const result: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const m = part.trim().match(/^(.+?)\s*\(#(\d+)\)$/);
    if (m) result[m[1].trim()] = parseInt(m[2], 10);
  }
  return Object.keys(result).length > 0 ? result : null;
}

function parseSpoiler(raw: string): boolean {
  if (!raw) return false;
  return raw.trim().toLowerCase() === 'true';
}

// Pick a field by name, case-insensitively
function col(row: Record<string, string>, name: string): string {
  // Try exact match first
  if (row[name] !== undefined) return row[name] ?? '';
  // Try case-insensitive
  const key = Object.keys(row).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? (row[key] ?? '') : '';
}

// =============================================================================
// Main export: parseGoodreadsCSV
// =============================================================================

export function parseGoodreadsCSV(text: string): ParseResult {
  const allRows = parseCSVAll(text);

  if (allRows.length < 2) {
    return { rows: [], parseErrors: [{ rowIndex: 0, message: 'File appears to be empty or has no data rows.' }], totalRaw: 0, isGoodreadsExport: false };
  }

  const headers = allRows[0];
  const isGoodreadsExport = REQUIRED_COLUMNS.every(col => headers.includes(col));

  if (!isGoodreadsExport) {
    return {
      rows: [],
      parseErrors: [{
        rowIndex: 0,
        message: `Missing required columns. Expected: ${REQUIRED_COLUMNS.join(', ')}. Found: ${headers.slice(0, 10).join(', ')}${headers.length > 10 ? '…' : ''}.`,
      }],
      totalRaw: allRows.length - 1,
      isGoodreadsExport: false,
    };
  }

  const dataRows = allRows.slice(1);
  const rows: ParsedGoodreadsRow[] = [];
  const parseErrors: ParseError[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const rawArr = dataRows[i];
    // Build raw_data map
    const raw: Record<string, string> = {};
    headers.forEach((h, j) => { raw[h] = rawArr[j] ?? ''; });

    const sourceBookId = col(raw, 'Book Id').trim();
    const title = col(raw, 'Title').trim();
    const author = col(raw, 'Author').trim();

    // Minimal validity check: must have a book ID and title
    if (!sourceBookId) {
      parseErrors.push({ rowIndex: i + 1, message: `Row ${i + 2}: missing Book Id` });
      continue;
    }
    if (!title) {
      parseErrors.push({ rowIndex: i + 1, message: `Row ${i + 2}: missing Title` });
      continue;
    }

    const ratingRaw = parseIntField(col(raw, 'My Rating'));
    const sourceRating = ratingRaw && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;

    rows.push({
      source_book_id: sourceBookId,
      title,
      author,
      additional_authors: col(raw, 'Additional Authors').trim() || null,
      isbn: cleanISBN(col(raw, 'ISBN')),
      isbn13: cleanISBN(col(raw, 'ISBN13')),
      publisher: col(raw, 'Publisher').trim() || null,
      binding: col(raw, 'Binding').trim() || null,
      page_count: parseIntField(col(raw, 'Number of Pages')),
      publication_year: parseIntField(col(raw, 'Year Published')),
      original_publication_year: parseIntField(col(raw, 'Original Publication Year')),
      exclusive_shelf: col(raw, 'Exclusive Shelf').trim() || 'to-read',
      raw_shelves: parseShelves(col(raw, 'Bookshelves')),
      raw_shelf_positions: parseShelfPositions(col(raw, 'Bookshelves with positions')),
      source_rating: sourceRating,
      date_read: normalizeDate(col(raw, 'Date Read')),
      date_added: normalizeDate(col(raw, 'Date Added')),
      review_body: col(raw, 'My Review').trim() || null,
      review_contains_spoiler: parseSpoiler(col(raw, 'Spoiler')),
      private_note: col(raw, 'Private Notes').trim() || null,
      read_count: parseIntField(col(raw, 'Read Count')),
      owned_copies: parseIntField(col(raw, 'Owned Copies')),
      raw_data: raw,
    });
  }

  return {
    rows,
    parseErrors,
    totalRaw: dataRows.length,
    isGoodreadsExport: true,
  };
}
