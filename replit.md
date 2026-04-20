# Book Recommendation App

## Overview
The Book Recommendation App is a React Native mobile application designed to help users discover, track, and share book recommendations. It integrates the Open Library API for book data and Supabase for backend services. The primary goal is to create a personalized reading experience, allowing users to send recommendations to friends, manage their reading library, and monitor reading progress. A distinctive feature is a "credibility" system where recommenders gain credibility when their suggested books are finished. The project aims to cultivate a dynamic community focused on reading and personalized discovery.

## User Preferences
Not specified.

## System Architecture
The application is developed using React Native with Expo Router for navigation. Supabase provides backend infrastructure, including authentication, PostgreSQL database, and Row Level Security (RLS). TypeScript ensures type safety.

**Key Features & Design Principles:**
- **Book Search & Recommendations:** Hybrid Google Books + Open Library retrieval. Recommendations can be sent to friends, featuring a sophisticated engine with taste profiles, a Recommendation Integrity Layer (RIL), Center-of-Gravity Fit Classifier, and Set Composition Engine.
- **Library Management:** Track reading status (want to read, reading, finished, set aside), rate books, and capture "set aside" (DNF) reasons. Supports a **Gallery View** (`components/LibraryGalleryView.tsx`) toggled by a grid icon in the library header; preference persists via AsyncStorage (`libraryViewMode` key). Gallery groups books by status with 2-column masonry for reading/finished/set-aside and 3-column for want-to-read. Reading books show a progress bar overlay and read-state pill (Active/Paused/Stalled); finished books show a year badge.
- **Activity Feed & Profile:** Displays friend activities, allows setting yearly reading goals, viewing taste profiles, and tracking reading statistics with combined monthly/yearly insights.
- **Reading Progress & Pacing:** Tracks reading sessions, calculates current and longest streaks, infers read states (active, paused, stalled), and projects finish dates based on reading pace.
- **Edition Awareness:** Book detail shows current edition metadata (publisher · year · pages). When multiple editions are detected via Open Library's Works API, a "Change edition" affordance appears; tapping opens a bottom sheet picker. Selecting an edition persists `edition_key` to `user_books`, updates the displayed cover, and recalculates reading progress using the edition's page count. `current_page` is never modified — only the denominator changes. Results are cached per work to avoid redundant network calls.
- **Onboarding & Walkthrough:** Two-phase flow including a cinematic intro and a guided in-app tour with spotlight apertures and coach marks.
- **Barcode Scan / "Will I like this?"**: Evaluate book fit by scanning barcodes or manually entering ISBNs.
- **UI/UX:** Uses a warm editorial color palette with defensive fallbacks and dynamic cover display. Ensures safe area handling for device notches/Dynamic Islands across all tab screens.
- **Account Lifecycle:** Manages user self-deletion, developer/test account resets, and a redesigned signup/recovery flow, including Supabase Edge Functions.
- **Social Sign-In:** Integrates Google and Apple sign-in with user-friendly error messages.
- **Goodreads Import:** Provides multi-path acquisition for Goodreads CSVs (web file picker, native document picker, paste-from-browser) into a unified processing pipeline.
- **Metadata Architecture:** Provider-agnostic layer (`metadataProvider.ts`) defines canonical book metadata shapes, handles cover selection, and derives metadata confidence. Includes a self-healing two-phase Open Library → Google Books repair system (`metadataRepair.ts`).
- **Analytics Surface:** Dedicated "Reading Insights" screen (`app/stats/index.tsx`) with month/year segment tabs, showing reading calendars, year columns, and key statistics. Home screen integrates a compact "Reading Insights" card.
- **Reflective Insights Layer:** `readingWraps.ts` library provides pure functions for computing monthly and yearly reading wraps, including derived `ReaderInsight` for display.
- **Core Product Principle:** The app should be calm, stateful, and understand the user, operating without exposing its internal machinery.
- **Global Rules:** Emphasizes single implementations for core capabilities, preventing UI from leaking internal phases, and preferring stale but usable content over blank.
- **Contracts:** Detailed contracts for loading, refresh, navigation continuity, action feedback, search, onboarding, book-state integrity, and surface-specific behaviors (Home, Library, etc.).

## Design Token Module
`lib/tokens.ts` is the single source of truth for the 10-colour Readstack palette. Import as `import * as T from '../lib/tokens'` (adjust path depth as needed). Named exports: `BG`, `INK`, `STONE`, `DUST`, `SAGE`, `SAGE_BG`, `AMBER`, `CREAM`, `BORDER`, `FAINT`. Screen and component files can be migrated to this module incrementally; the token values are identical to the inline hex strings they replace.

## Subject Matching
`matchesSubjects()` in `lib/shelves.ts` uses word-boundary regex (`\b...\b`) — not substring `includes()`. This applies to smart shelf filtering (Romantasy, Long Reads, Comfort Reads). `contentWarnings.ts` uses the same approach with pre-compiled COMPILED_PATTERNS. Never revert either to `includes()`.

## Edition Filter
`fetchEditions()` in `lib/openLibrary.ts` requires `pageCount OR publisher` (not just `year`). Year-only OL editions are excluded from the picker.

## Forensic Debug Gate
`FORENSIC_USER_ID` in `lib/recommender.ts` is set to `''` (empty string). The forensic audit path (`__DEV__ && userId === FORENSIC_USER_ID`) therefore never fires. To enable for local debugging, set it to a specific UUID temporarily — never commit a real UUID here.

## Pending Migrations (need manual apply via Supabase dashboard SQL editor)
- `supabase/migrations/20260413000001_rec_snapshots.sql` — creates `rec_snapshots (user_id, external_id)` PK table storing only rendered explanation + evidence_tags[]. RLS: users manage own rows. Written fire-and-forget on RecCard tap; read by book detail as fallback when session cache is empty.
- `supabase/migrations/20260414000000_user_books_edition_key.sql` — adds `edition_key text` column to `user_books`. Nullable; stores the Open Library edition ID (e.g. "OL12345M") the user has explicitly chosen for their copy. When set, the book detail screen uses this edition's cover and page count instead of the canonical books row values.

## Subject Coverage
Three-pass enrichment pipeline brings 304-book catalog to 81.6% rich-subject coverage (≥3 subjects):
1. **Open Library** (`scripts/repairSubjectCoverage.ts`) — primary pass
2. **Google Books** (integrated into `lib/subjectRepair.ts`) — fallback when OL returns 0 subjects
3. **LLM inference** (`scripts/inferSubjectsLLM.ts`) — `gpt-4o-mini` with an 80-term curated vocabulary for books that both providers miss; provenance tracked in `book_source_links` with `source='llm_inference'`

Final state (April 2026): NULL=5 (no description, permanently unreachable), Sparse(1-2)=51, Rich(≥3)=248, 81.6% coverage.

## Maintenance Scripts
- **`scripts/repairSubjectCoverage.ts`** — Batch repair for books with missing or sparse subjects. Two-provider pipeline: Open Library first, then Google Books fallback when OL returns 0 subjects. Uses service-role key to bypass RLS. Summary shows `enrichedByOL` and `enrichedByGB` counters. Flags: `--dry-run`, `--batch-size=<n>`, `--user-id=<uuid>`, `--after-id=<uuid>` (cursor). Run with `npx tsx scripts/repairSubjectCoverage.ts`.
- **`lib/sessionSegment.ts`** — Reset-aware session segmentation. Exports `activeSegment(rows)` which returns only rows AFTER the most-recent reset-to-0 (a negative-delta row whose `started_page + pages_read === 0`). Used by `lib/pacing.ts` (computeMonthlyStats), `lib/readingWraps.ts` (aggregatePeriod, computeYearHeatmap) so monthly pages, reading days, session count, streak window, and the year heatmap all honor the product rule "reset-to-0 = start over": pages reset away don't count, and re-reads from 0 begin a fresh contribution baseline.
- **`scripts/backfillSessionCorrections.ts`** — One-time repair for users whose `reading_sessions` log was corrupted by pre-migration silent reset failures (orphan forward rows whose sum exceeds `current_page`). Append-only: inserts a single synthetic correction row per affected book dated today, with `pages_read = current_page − sum_before` so raw sums realign. Books where `sum < current_page` are reported but not auto-fixed. Dry-run by default; pass `--apply` to write. Reversibility log written to `.local/backfill-logs/`. Required flag: `--user-id=<uuid>`. Run with `npx tsx scripts/backfillSessionCorrections.ts --user-id=<uuid>`.
- **`scripts/deduplicateBooks.ts`** — Detects and merges duplicate book rows (same normalised title+author). Selects a canonical row by metadata quality score (OL work ID, subject count, description length, confidence), migrates all FK dependents (user_books, reading_sessions, import_rows), and deletes orphan rows. FK dependencies handled: user_books.book_id, reading_sessions.book_id, import_rows.user_book_id (nulled), import_rows.matched_book_id (remapped). Flags: `--dry-run`, `--verbose`. Run with `npx tsx scripts/deduplicateBooks.ts --dry-run` before every live run.
- **`scripts/inferSubjectsLLM.ts`** — Third-pass LLM subject enrichment for books that OL and Google Books could not enrich. Uses `gpt-4o-mini` with `lib/subjectVocabulary.ts` (80-term curated list); out-of-vocab terms are filtered before writing. Writes inferred subjects to `books.subjects` and provenance to `book_source_links (source='llm_inference')`. Idempotent (skips books already inferred). Flags: `--dry-run`, `--batch-size=<n>`, `--include-sparse` (also enrich 1-2 subject books), `--force` (re-infer even if already done), `--min-description=<n>` (default 100). Override model with `LLM_MODEL` env var. Run with `npx tsx scripts/inferSubjectsLLM.ts`.

## Duplicate Prevention
`lib/goodreadsExecutor.ts` includes a title+author dedup guard (added after the book_source_links check, before the book insert loop). When a Goodreads import would create a new book row, it first normalises the title and first author and checks the entire catalog. If a matching row is found, it reuses that book ID — preventing duplicate rows that arise from re-imports or from the same book appearing under multiple Goodreads edition IDs.

## External Dependencies
- **Supabase:** User authentication, PostgreSQL database, Row Level Security.
- **Open Library API:** Primary source for book search and metadata.
- **Google Books API:** Enriches book data with details like language, categories, and ratings.
- **AsyncStorage:** Persistent local caching of recommendation payloads.