# Provider Attribution — Internal Note

**Status**: Working draft. Review before any public beta announcement.  
**Last updated**: April 2026  
**Author**: Engineering

---

## What data we display

| Field | Source | Display surface |
|---|---|---|
| Cover image | Google Books CDN (`books.google.com`) | Library, rec cards, book detail, series strip |
| Cover image | Open Library (`covers.openlibrary.org`) | Same surfaces, lower priority |
| Description (summary) | Google Books API (`volumeInfo.description`) | Book detail, rec card explanation |
| Description (summary) | Open Library Works API (`/works/{OLID}.json`) | Book detail when GB has none |
| Page count | Google Books API (`volumeInfo.pageCount`) | Book detail |
| Page count | Open Library editions scan (median) | Book detail when GB has none |
| Subjects / genres | Open Library Works API (`subjects` array) | Internally, for scoring — not displayed yet |

---

## What we store

In the `books` table:
- `cover_url` — direct CDN URL (Google Books `books.google.com` or OL `covers.openlibrary.org`)
- `description` — raw text, no HTML, truncated by caller
- `page_count` — integer
- `subjects` — string array from OL
- `cover_source` — `'google_books'` | `'open_library'` | `'goodreads'` | null
- `metadata_confidence` — `'high'` | `'medium'` | `'low'`

In the `book_source_links` table:
- `source` — `'google_books'`
- `source_book_id` — real GB volume ID (e.g. `XfFvDwAAQBAJ`)
- `raw_payload` — full GB API response item (for audit / reprocessing)
- `fetch_status` — `'success'` | `'failed'` | `'rate_limited'`

**No Open Library raw payloads are stored** — OL data is fetched as-needed and
only scalar fields (description, subjects, page_count) are written to `books`.

---

## Google Books — attribution requirements

**Terms**: https://developers.google.com/books/terms  
**Key obligations**:

1. **"Powered by Google" branding** is required when displaying search results
   sourced from the Books API. The requirement specifically covers *search result
   listings*. Our use-case is metadata enrichment of books the user has already
   imported, not a book-discovery search UI.

2. **Logo display**: The ToS says "display the Google Books logo or 'Google
   Books' text link" in any UI where Books API content is *primary*.

3. **Data portability**: Fetched content must not be used to replicate or
   substitute for the Google Books catalogue in a way that competes with it.

**Our read of the risk**:
- We use the API for silent enrichment (covers, descriptions, page counts).
  The user never sees "search Google Books" or a list of GB results.
- We display a cover from `books.google.com` — the image itself carries no
  attribution requirement (it's a CDN URL).
- The description is displayed without any Google branding.

**Unresolved / to decide before public launch**:
- Add a "Book data from Google Books" footnote on the Book Detail screen.
  This is the lowest-friction path to compliance.
- If the app ever adds a book-search feature that shows GB results directly,
  the full "Powered by Google" badge requirement kicks in immediately.
- Consult a lawyer if the app reaches 1,000+ active users before adding
  the attribution footnote.

---

## Open Library — attribution requirements

**Terms**: https://openlibrary.org/dev/docs/api  
**License**: CC BY (data), CC0 (some metadata)  
**Key obligations**:

- Attribution preferred but not legally required for CC0 datasets.
- OL requests that API users "be respectful" of their servers and not hammer
  the API. No formal rate limit is stated.
- Description text sourced from OL may itself be under a publisher copyright
  (OL just hosts it). We don't validate the provenance of each description.

**Our read of the risk**:
- Low legal risk for the description / subjects / page_count fields.
- The cover image CDN (`covers.openlibrary.org`) is public. No attribution needed.
- Be respectful: no more than 1 OL request per second, never in tight loops.
  The current repair loop is already bounded to 50 books per call and is
  single-threaded (sequential `await`).

**Unresolved**:
- Some OL description text is scraped from publisher-provided blurbs.
  In theory, using it in a user-facing product carries a minor copyright risk.
  In practice, every reading app does this and there is no known enforcement.

---

## Risks / constraints summary

| Risk | Severity | Mitigation |
|---|---|---|
| GB "Powered by Google" branding absent | Medium (policy) | Add "Data from Google Books" footnote to Book Detail before public launch |
| GB API quota exhausted (1,000/day anon) | Low–Medium | `quotaMonitor.ts` tracks daily usage; `EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY` env var raises quota |
| GB description copyright | Very low | Standard industry practice; enrichment use case |
| OL description copyright (publisher blurbs) | Very low | No known enforcement |
| GB CDN URL instability | Low | `coverUpgrade.ts` ensures only ISBN-matched GB covers are stored; `coverCache.ts` prevents re-attempt on failure |

---

## Close-out checklist before public launch

- [ ] Add "Book data from Google Books" text link on Book Detail (required by ToS)
- [ ] Set `EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY` in production secrets (raises quota to ~1M/day)
- [ ] Apply `20260410000000_fix_book_source_links_conflict_key.sql` migration manually in prod Supabase
- [ ] Verify `quotaMonitor.ts` daily counter resets correctly across midnight in production
- [ ] Review OL description quality — consider switching to `first_sentence` display if full blurbs raise concerns
