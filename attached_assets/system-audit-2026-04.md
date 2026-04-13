# Readstack — System Audit & Handoff Document
*April 2026. Written from a full codebase read. References actual files and flows throughout.*

---

## 1. Product Overview

**What it is.** Readstack is a mobile-first social reading app (Expo/React Native, iOS-first, web-compatible) built around a personalized recommendation engine. The premise is that a reading app should understand you well enough to make genuinely tailored book suggestions — not generic "if you liked X, try Y" lists — and should track your reading life without making you feel like you're doing data entry.

**Current product thesis.** A reading app earns trust by being calm, opinionated, and increasingly accurate over time. Every action the user takes (finishing a book, rating it, tagging traits, importing their Goodreads history) feeds a taste model that surfaces better recommendations without the user ever managing explicit preferences. The app is aware of what the user actually reads, not just what they say they like.

**What makes it different.**
- The recommendation engine is not a tag-matcher. It builds a `TasteProfile` and `ReaderThesis` from actual reading behavior, scores candidates across five orthogonal dimensions (traits, genre affinity, feedback, enrichment signals, metadata quality), runs an integrity layer to suppress wrong series entry points, and classifies every book by its fit relative to the user's center of gravity.
- Content-axis awareness. The app knows the difference between "reading the same genre" and "reading the same emotional register." Trait alignment (e.g., "characters," "twists," "emotional") is independent of genre.
- Calm reading insights. Monthly and yearly wraps are honest about coverage and written in reflective language — not gamified streaks or achievement badges.
- Edition awareness. The book detail screen lets a user select their specific physical copy, anchoring page count, cover art, and reading progress to the edition they're actually holding.

**Key user journeys currently supported.**
1. Goodreads import → immediate library + taste profile bootstrap
2. Manual book search and status tracking (want to read / reading / finished / set aside)
3. Page progress logging → automatic session recording → pacing projection
4. Recommendations feed → rec detail ("Why this book?") → add to library
5. "Will I like this?" — barcode scan or title search → instant fit evaluation
6. Reading Insights screen — monthly calendar, year columns, stats
7. Edition picker — choose specific physical copy per book
8. Series/saga awareness — series badges + series integrity in recs

---

## 2. Tech Stack and Architecture

**Frontend.** React Native (Expo SDK 55), TypeScript, Expo Router (file-based navigation). The app runs on iOS (primary target), Android, and web (Expo Web). Metro is the bundler; the Replit environment has a `metro.config.js` blocklist excluding `.local/` to prevent ENOENT crashes from skills files.

**Backend/database.** Supabase: PostgreSQL with Row Level Security on every table, Supabase Auth (email + Apple + Google social sign-in). No backend server — all queries are direct from the client via the Supabase JS client (`lib/supabase.ts`). Edge Functions exist for account deletion (`supabase/functions/delete-user`).

**External providers.**
- Open Library API — primary source for book metadata: description, subjects, page_count, editions, cover URLs. All OL identifiers stored as `/works/OL{id}W` format.
- Google Books API — secondary source, primarily for cover URLs (higher quality CDN). Rate-limit monitored (`lib/quotaMonitor.ts`). Used with session-level quota tracking stored in AsyncStorage.
- No paid API keys required beyond what the user's Supabase project provides.

**Key libraries.** `@supabase/supabase-js`, `expo-router`, `expo-linear-gradient`, `react-native-safe-area-context`, `@react-native-async-storage/async-storage`, `expo-document-picker`, `@expo/vector-icons`.

**State, navigation, data fetching.**
- Navigation: Expo Router file-based, tabs in `app/(tabs)/`, modal routes in `app/book/[id].tsx`, `app/add-book.tsx`, etc.
- Tab-level state: module-level JS objects (`_libCache`, `_libItems` in `library.tsx`; recommendation cache in `recContext.ts`) that survive tab switches but are cleared on app kill.
- Recommendation session context: `lib/recContext.ts` — a module-level Map keyed by `external_id`. The primary read path for "Why this book?" on the book detail screen. The durable fallback is `rec_snapshots` in Supabase.
- No global state management library (Redux, Zustand, etc.) — all state is component-local or module-level session cache.
- Data fetching: `useEffect` + `supabase.from(...)` throughout. No SWR, React Query, or abstraction layer. Every screen manages its own loading/error states.

**Notable architectural patterns.**
- Provider-agnostic metadata layer (`lib/metadataProvider.ts`): defines `BookMetadataProvider` interface; Google Books and Open Library are adapters. `selectBestCover()` and `deriveMetadataConfidence()` are centralized here.
- Dual-cache for recommendations: session cache (in-memory `Map`) + DB cache (`rec_cache` table, 24h/7d TTL). Cold-start hits DB cache; fresh build writes back to DB.
- Self-healing metadata: every library load triggers `repairBooksMetadata()` on books with missing fields. Book detail also triggers single-book OL repair on open.
- Module-level library cache with explicit invalidation via `tabCache.ts` / `registerCacheClearer()`.
- RLS on every table — all security is at the database layer, not in application code.

---

## 3. Core Data Model

### `books` — shared book catalog
**What:** Canonical book metadata shared across all users. One row per book regardless of how many users have it.
**Source of truth:** Yes — the authoritative record for title, author, cover_url, external_id, page_count, description, subjects.
**Schema (key columns):** `id` (uuid PK), `title`, `author`, `cover_url`, `external_id` (OL `/works/OL...W` or Goodreads `goodreads:{id}`), `page_count`, `description`, `subjects` (text[]), `cover_source` (google_books | open_library), `metadata_confidence` (high | medium | low).
**Written by:** Book search/add flow, Goodreads import executor, `repairBooksMetadata()`, `metadataRepair.ts`.
**Read by:** Every screen. The authoritative display layer for all book metadata.
**Caveat:** `subjects` and `description` were added in later migrations and may be null for older rows. `cover_source` and `metadata_confidence` were added in `20260409000000`.

### `user_books` — per-user reading records
**What:** Each user's relationship to a book — status, page progress, rating, notes, etc.
**Source of truth:** Yes — the authoritative state for a user's reading lifecycle.
**Schema (key columns):** `user_id`, `book_id`, `status` (want_to_read | reading | finished | dnf), `current_page`, `page_count` (per-user override), `rating` (int), `review_body`, `private_note`, `started_at`, `finished_at`, `progress_updated_at`, `taste_tags` (jsonb), `sentiment`, `edition_key` (text, nullable — OL edition ID override).
**Written by:** All status transitions (`transitionStatus()`), page logging (`saveCurrentPage()`), rating/review edits, edition selection.
**Read by:** Library screen (primary), book detail, recommendation exclusion, taste profile computation, series progress.
**Caveat:** `edition_key` requires migration `20260414000000` applied. The DB enum is still `dnf` — the UI renames it "Set Aside" but the stored value stays `dnf`.

### `reading_sessions` — derived session records
**What:** Auto-derived forward-reading sessions. "I read from page A to page B today."
**Source of truth:** Derived (from progress event deltas) — not user-entered directly.
**Schema:** `user_id`, `book_id`, `user_book_id`, `session_date` (text YYYY-MM-DD), `started_page`, `ended_page`, `pages_read`, `duration_minutes` (always null — reserved for v2).
**Written by:** `saveCurrentPage()` in `userBookActions.ts` — whenever a page advances, a session row is written for that calendar date.
**Read by:** Pacing engine, streak computation, reading wraps, stats screen.
**Caveat:** Stored as local calendar date string to avoid timezone ambiguity. `duration_minutes` exists in schema but is always null. Requires migrations `20260411000000` + `20260413000000` applied.

### `reading_progress_events` — raw page log
**What:** Append-only audit trail of every page update, including regressions.
**Source of truth:** Raw log — the source from which sessions are derived.
**Schema (from `20260313000001`):** `user_id`, `user_book_id`, `page_number`, `total_pages`, `created_at`.
**Written by:** `saveCurrentPage()`.
**Read by:** Not surfaced to users directly. Used as audit log and source for session derivation.

### `book_source_links` — provider link audit trail
**What:** Maps each book to its external IDs at each provider.
**Source of truth:** Provider link registry — canonical record of "this book's OL work ID is X, its Google Books ID is Y."
**Schema:** `book_id`, `source` (openlibrary | google_books | goodreads), `source_book_id`, `raw_payload` (jsonb), `last_fetched_at`, `fetch_status`.
**Written by:** `recordProviderLink()` in `metadataProvider.ts`, called during repair.
**Read by:** `loadEditions()` in book detail (looks up OL work ID for edition picker), repair pipeline.

### `rec_cache` — per-user recommendation result cache
**What:** Full scored recommendation set for a user, cached to avoid re-running the expensive pipeline.
**Source of truth:** Cache — invalidated and rebuilt when signals change.
**Schema:** `user_id` (PK), `mode` (deterministic | expert), `rec_set` (jsonb — array of ScoredBook), `reader_thesis` (jsonb), `built_at`, `valid_until`, `signal_snapshot`, `debug_meta`.
**TTL:** Deterministic: 24 hours. Expert: 7 days.
**Written by:** `persistRecCache()` in `recCache.ts` after every pipeline run.
**Read by:** Recommendations feed on load via `loadCachedRecs()`. Invalidated when `shouldRebuild()` detects new signals.

### `rec_candidate_cache` — per-user external candidate pool
**What:** OL-fetched candidate books (external to the user's library) that survived hygiene.
**Source of truth:** Cache — 24h TTL, versioned (`CACHE_VERSION = 'v5:'` in retrieval_reason).
**Schema:** `user_id`, `external_id`, `source`, `retrieval_reason`, `title`, `author`, `subjects`, `page_count`, `cached_at`.
**Written by:** Live OL retrieval pass in `getCandidateBooks()`.
**Read by:** Subsequent recommendation runs as Source B (cached_external), avoiding re-fetching OL.

### `rec_snapshots` — durable explanation evidence
**What:** The rendered explanation sentence and evidence tags for each (user, book) pair that appeared in the rec feed.
**Source of truth:** Durable session bridge — not source of truth, not cache. Specifically the "why this book?" evidence that should survive across sessions.
**Schema:** PK `(user_id, external_id)`, `explanation` (text), `evidence_tags` (text[]), `created_at`, `updated_at`.
**Written by:** `persistRecSnapshot()` fire-and-forget on RecCard tap.
**Read by:** Book detail screen when `recContext` (session cache) is empty.
**Status:** Requires migration `20260413000001` applied.

### `profiles` — user profile
**Schema:** `id` (uuid, references auth.users), `username` (unique), `yearly_reading_goal` (int), `created_at`. Extended by `20260314000001` (first_name, last_name) and `20260313000000` (reader_preferences FK).

### `reader_preferences` — onboarding/diagnosis answers
**What:** Explicit stated preferences from onboarding or preference editing.
**Schema (`20260313000000`):** content_preference_mode, favorite_genres, favorite_authors, min_pages, max_pages, avoid_tropes, etc.

### `rec_entitlements` — expert mode access control
**What:** Per-user entitlement controlling access to expert recommendation mode.
**Schema (`20260318000005`):** `user_id`, `plan` (free | paid), `expert_refreshes_used`, `next_refresh_available_at`.
**Written/read by:** `lib/recEntitlement.ts`. Expert mode requires tier 2+ taste profile AND sufficient entitlement.

### Other tables (schema exists, varying implementation completeness)
- `friendships` — social graph (schema complete, add-friend UI unclear)
- `recommendations` — peer-to-peer rec sharing (schema complete)
- `credibility_events` — credibility scoring when a peer rec leads to a finished book (schema complete, UI unclear)
- `activity_events` — social feed events (schema complete, feed may exist in profile tab)
- `scan_history` — barcode scan results (`20260327000000`)
- `book_enrichment_cache` — Google Books enrichment profiles per external_id (`20260318000004`)
- `rec_feedback` — More-Like-This / less-like-this signals (`20260318000003`)
- `books` content_warnings column — added by `20260413000002`

---

## 4. Metadata / Provider Architecture

**Two-phase repair pipeline.** `lib/metadataRepair.ts` is the core. It takes a list of book IDs, fetches each row to see which fields are missing, then attempts two phases per book:

- Phase 1 — Open Library: attempts to fill `description`, `subjects`, `page_count`, and cover using the OL works API (`fetchOLMeta()`). OL is better for structured metadata and subjects.
- Phase 2 — Google Books: fills or upgrades `cover_url`. Google Books has higher-quality cover images but its subject data is less structured. Called only when OL didn't provide enough.

Fields are never overwritten if already present. The pipeline is column-resilient — it uses try-with-fallback queries for optional columns (`subjects`, `description`, `cover_source`, `metadata_confidence`) that may not exist if migrations are not yet applied.

**Three call sites for repair:**
1. Goodreads import executor — runs after each batch import
2. Library screen load — repairs visible books with any missing field (`repairBooksMetadata()` on the `items` returned by the library query)
3. Book detail self-heal — `fetchOLMeta()` on open for single-book enrichment

**Cover credibility system.** `lib/coverCredibility.ts` — pure function with an allowlist of provider domains: `covers.openlibrary.org`, `books.google.com`, `googleapis.com`, `archive.org`, Goodreads CDN. Any URL not from a whitelisted domain is rejected and falls through to the typographic fallback. This prevents garbage cover URLs from Goodreads imports from being displayed.

**Cover upgrade logic.** `lib/coverUpgrade.ts` — `shouldUpgradeCover()` computes whether a candidate cover from a new provider is worth replacing the current one. Priority: `google_books > open_library > goodreads > null`. Never downgrades.

**Cover cache.** `lib/coverCache.ts` — session-level cache of URLs that have already 404'd. `isCoverUrlKnownFailed()` prevents re-requesting the same failed URL in a session. `markCoverUrlFailed()` is called from `CoverThumb.onError`.

**Edition cover.** `lib/openLibrary.ts` — `fetchEditions()` retrieves up to 50 editions for an OL work, normalizes them, captures `languages` (from OL's `[{key: "/languages/eng"}]` format), and caches per work ID. `rankEditions()` scores by (language preference × 100) + (metadata quality: pageCount/cover/publisher/isbn). The book detail screen shows only preferred-language editions by default with "Show all" affordance.

**Quota monitoring.** `lib/quotaMonitor.ts` — tracks Google Books API calls per day using AsyncStorage (`_gb_quota_record`). Daily limit: 950 calls (conservative vs Google's 1000). Over-limit calls are skipped. `logQuotaSnapshot()` emits a console log with daily usage stats.

**Provider health monitoring.** `lib/providerHealth.ts` — session-level counters for success/failure/rate_limited outcomes per provider. `logProviderHealthSummary()` emits an audit table to the console. In-memory only; cleared on app restart.

**Attribution.** OL covers hosted on `covers.openlibrary.org` — OL requires attribution per their policy. The app does not currently display provider attribution in the UI. This is a known deferred item.

**Current limitations.**
- OL subjects are absent for a significant fraction of books (especially Goodreads imports that haven't been through repair). This limits both smart shelf membership and content warning coverage.
- Google Books quota is session-level in AsyncStorage, not server-side. Multiple devices or fresh installs could each burn 950 calls/day against the same API key.
- OL edition search is capped at 50 editions per work (`limit=50`). Major classics (Hamlet, Pride and Prejudice) may have thousands of editions and the picker will only show the first 50, though `rankEditions()` ensures the best-quality ones surface first.
- No OL provider attribution shown in UI.

---

## 5. Recommendation System

**Architecture overview.** `lib/recommender.ts` (~3,250 lines) is the single most complex module. The pipeline has six distinct phases:

**Phase 1 — Candidate retrieval (`getCandidateBooks()`).** Three sources:
- Source A (catalog): books already in Supabase `books` table that the user hasn't read/shelved, filtered for eligibility.
- Source B (cached_external): `rec_candidate_cache` rows for this user < 24h old and matching `CACHE_VERSION = 'v5:'`. Stale or version-mismatched rows force a live fetch.
- Source C (live OL): multi-anchor OL queries built from three anchor types — genre anchors (top 3 genre affinities → specific OL subject terms), subject anchors (top 3 recurring subjects from 4+ star books), and author anchor (top liked author). Each anchor type runs independent OL `subject.json` or `authors.json` queries.

**Phase 2 — Hygiene (`applyHygiene()`).** Removes: juvenile/children's books, known public-domain classic authors (Austen, Dickens, etc. that tend to dominate OL results), books with critically weak metadata (no subjects + no description + no isbn). Also de-prioritizes non-English books via enrichment when language data is available.

**Phase 3 — Scoring (`scoreBookForUser()`).** Five steps:
1. Preferred-trait alignment — match book traits (from `bookTraits.ts`) against `tasteProfile.preferred_traits`
2. Avoided-trait penalties — penalize books matching `tasteProfile.avoided_traits`
3. Genre affinity — bonus/penalty based on `tasteProfile.genre_affinities`
4. Feedback boost — amplify books matching genres the user has explicitly upvoted (More-Like-This)
5. Enrichment bonus — consensus-trait match and popularity signal from `book_enrichment_cache`

**Phase 4 — Center-of-Gravity fit classification.** `lib/fitClassifier.ts` classifies each scored book as `core_fit`, `adjacent_fit`, `stretch_fit`, or `reject` based on how well the book's detected lane aligns with the user's center of gravity. `core_fit` books get a +0.25 score delta; `reject` books are removed from the visible set.

**Phase 5 — Recommendation Integrity Layer (RIL).** `lib/recommendationIntegrity.ts`. Three rules enforced:
1. Entry-point integrity: a series book at position > 1 is suppressed if the user hasn't established a relationship with that series/author.
2. Series flooding collapse: only the best entry point from each series remains visible.
3. Series labelling: every book is annotated (`series_starter`, `series_continuation`, `series_later_volume`) for UI badge rendering.
Detection priority: curated static catalog (~50 major series in `seriesCatalog.ts`) → OL title regex → description regex. Curated catalog is `confidence: 'high'`; regex matches are `confidence: 'medium'`.

**Phase 6 — Set composition.** Two output buckets: `continuations` (series the user has already started — next unread position) and `discoveries` (starters, standalones, new authors). Author diversity cap: same-author books within the pool get a 4% score reduction per additional book. A maximum of 3 continuation slots is enforced (`CONT_CAP = 3`).

**Expert mode.** `lib/expertRec.ts`. When the user reaches taste tier 2+ AND holds a valid `rec_entitlement`, the expert layer activates. It:
1. Builds a `ReaderThesis` — dominant lanes, exception lanes, center of gravity, anti-preferences, hard truthfulness rules.
2. Judges each candidate against the thesis (`judgeCandidateFit()`).
3. Composes the final set with richer explanation strings.
**Important caveat:** Expert mode is currently deterministic TypeScript heuristics, not an LLM. The function signatures were designed for a future LLM-backed call — `buildReaderThesis()` and `judgeCandidateFit()` can be replaced with a structured prompt call. This is documented in the module header.

**Explanation quality system.** Every rec has an `explanation_quality` field: `strong` (book-specific trait/subject/enrichment match), `acceptable_specific` (author repeat or explicit feedback), `acceptable_generic` (broad lane/genre signal only), or `weak` (no measured alignment). The UI orders recs partly by this quality tier.

**Evidence tags / "Why this?" logic.** `lib/evidencePack.ts` consolidates the full evidence set for expert reasoning. `lib/recContext.ts` stores the rendered explanation and evidence tags in a session-level Map by `external_id`. `lib/recSnapshot.ts` persists this to `rec_snapshots` fire-and-forget on RecCard tap. Book detail reads from session context first; falls back to Supabase snapshot if session is empty.

**Session vs. durable.** Session-only: raw `reasons[]` and `score_breakdown` in memory. Durable: rendered `explanation` string and `evidence_tags[]` in `rec_snapshots`. The session cache is authoritative for the current session; `rec_snapshots` is the cross-session fallback. `rec_snapshots` only works if migration `20260413000001` is applied.

**Where recommendation intelligence surfaces in product.**
- Recommendations tab (home screen doubles as the rec feed — `app/(tabs)/index.tsx`)
- "Why this book?" section in book detail (`app/book/[id].tsx`)
- "Will I like this?" barcode/title scan (`app/scan.tsx`, `lib/scanFitEval.ts`)
- Profile tab shows taste profile tier and label

**Key known limitations.**
- Without `rec_snapshots` migration applied: "Why this book?" only works if the user arrived directly from the rec feed in the current session. Direct navigation to a book's detail page shows no explanation.
- Subjects data coverage is a hard ceiling on recommendation quality. Books without OL subjects get weaker signals.
- Expert mode is heuristic, not LLM — the explanation text reads well but the reasoning depth is bounded by what TypeScript can compute from structured data.
- `FORENSIC_USER_ID` was a hardcoded UUID in `lib/recommender.ts` that activated verbose logging for a specific account. It is now set to `''` (empty string) — the forensic path never fires for any real user.

---

## 6. Reading Progress / Pacing / Insights System

**Page logging.** `saveCurrentPage()` in `lib/userBookActions.ts` is the single write path. It:
1. Updates `user_books.current_page` and `progress_updated_at`.
2. Writes a `reading_progress_events` row (append-only audit log).
3. Derives and writes a `reading_sessions` row if the new page > the old page (forward progress only). The session is keyed by `(user_book_id, session_date)` — same day sessions are upserted to accumulate pages.

**Session date storage.** Stored as a text `YYYY-MM-DD` string using the client's local date. This deliberately avoids timezone ambiguity: a reader who logs pages at 11 PM local time and at midnight is not penalized for a "missed day."

**Three pacing models in `lib/pacing.ts`:**
1. `estimatePaceFinish()` — actual pace (pages read / days elapsed since start). No goal dependency. Returns projected finish date. Used for the "Finish by [date]" line in book detail.
2. `computePagePacing()` — goal-relative, requires `yearly_reading_goal`. Computes actual % vs expected % today; classifies as `ahead`, `on_pace`, or `behind` with ±10pt buffer to prevent flicker.
3. `computeDatePacing()` — goal-relative without page data. Falls back to date-only pacing for books with no page count.

**Read state inference.** `inferReadState()` — `active` (< 14 days since last progress), `paused` (15–60 days), `stalled` (> 60 days). The thresholds are conservative. These states appear as overlay pills on reading books in the library gallery view.

**Streak computation.** `computeStreaks()` in `lib/streaks.ts`. Input: `YYYY-MM-DD` session date strings. Deduplicates (multiple sessions same day = 1 reading day). Current streak is alive if the last reading day is today or yesterday (1-day grace window). Outputs `{current, longest}`.

**Monthly/yearly insights.** `lib/readingWraps.ts` — pure functions, no I/O. `computeMonthlyWrap()` and `computeYearlyWrap()` derive stats from session rows. `ReaderInsight` type produces human-readable insight copy. The Stats screen (`app/stats/index.tsx`, 923 lines) renders month and year views with: reading calendar (color-coded days), year column chart (12 proportional bars), stat rows (pages, reading days, sessions, avg pages/day), and interpretive insight copy.

**What the insights screen currently does.** Month tab: reading calendar for the selected month, key stats, one interpretive line derived from the data (e.g., "Your best reading days are weekends"). Year tab: 12-bar column chart of pages per month, year-level stats, streak info. The screen fetches sessions for the current calendar year via `reading_sessions` and `user_books` (for titles).

**Reflective vs. analytics-driven.** The tone is deliberately reflective. The module comment in `readingWraps.ts` says: "Not gamified." There are no achievement unlocks, badges, or numerical goals beyond the optional yearly book count goal. Insights are derived from real data and acknowledged as honest about data coverage (the session window is typically 90 days for the session-based estimates).

**Known caveats.**
- Sessions before `20260411000000` is applied don't exist. For users who have logged pages before this migration, all historical sessions are missing — streaks and monthly stats start from the migration date.
- `duration_minutes` in `reading_sessions` is always null. Reading time estimates are not possible in the current system.
- `estimatePaceFinish()` uses calendar days since `started_at` — if a user starts a book, ignores it for 30 days, then reads 2 pages, the projected finish date becomes unrealistically distant. `computeSessionPacing()` (requires ≥ 1 session) is more robust but requires the sessions table to be populated.
- Cross-midnight reads: if a user logs "session_date = today" at 11:59 PM and "session_date = tomorrow" at 12:01 AM, both are valid session dates and the streak increment is correct. The issue is that the client determines the local date, which is correct behavior but could be wrong if the device clock is wrong.

---

## 7. Library Architecture

**Data load.** `app/(tabs)/library.tsx` (2,118 lines). Fetches all `user_books` for the current user, joining `books`, ordered by `updated_at DESC` by default. Full library is loaded at once — no pagination. Module-level cache (`_libCache`, `_libItems`) makes tab switch re-renders instant.

**Filter model.** Five status chip filters: `all`, `reading`, `want_to_read`, `finished`, `dnf` (displayed as "Set Aside"). Filters apply as a simple `item.status === filter` predicate. An inline search bar (`searchQuery`) further filters by title/author substring.

**Sort keys.** `recent` (updated_at DESC — default), `newest` (finished_at DESC), `alpha` (title alphabetical).

**Smart shelves.** `components/ShelfRow.tsx` renders a horizontal scroll strip of shelf cards. Data comes from `SHELF_DEFINITIONS` in `lib/shelves.ts`. Active shelves: **Romantasy** (subject intersection of romance + fantasy/paranormal), **Long Reads** (want_to_read + page_count ≥ 400), **Comfort Reads** (finished + rating ≥ 4 or sentiment = 'loved'). Shelves with zero matching books are silently hidden. The shelf filter runs client-side against the full items array — no separate query.

**Subject matching.** `matchesSubjects()` uses word-boundary regex (`/\b{keyword}\b/i`) — not substring `includes()`. This prevents false positives like `"war"` matching `"award"` or `"romance"` matching `"necromancer"`. This is consistent with how `contentWarnings.ts` handles its own subject matching.

**Archive accordion.** Finished books older than the current year are collapsed into a yearly accordion ("2024 — N books"). `expandedYears` state controls which years are open. The accordion renders year groups for all finished books before the current year.

**Gallery view.** `components/LibraryGalleryView.tsx`. Toggleable via a grid icon in the library header; preference persists via AsyncStorage (`libraryViewMode` key). 2-column masonry for reading/finished/dnf; 3-column for want-to-read. Reading books show a progress bar overlay and read-state pill (Active/Paused/Stalled); finished books show a year badge.

**Series badges.** Curated static catalog in `lib/seriesCatalog.ts`. ~50 major series explicitly listed with series positions and OL cover IDs. The library renders "Book N of X" chips on books in the catalog. `findSeriesForBook()` matches by normalized title. Only curated series get badges — regex-detected series from the recommender do not appear in the library.

**Saga system.** Within the static catalog, multi-series mega-arcs (e.g., Robin Hobb's Realm of the Elderlings spanning Farseer → Liveship → Tawny Man → etc.) are modeled as sagas with an ordered series list. The book detail screen shows a saga timeline panel with locked/unlocked states based on the user's reading progress through each sub-series.

**Automatic vs. user-controlled.** Everything is automatic — status transitions, sort, filter, shelf membership. The user controls status (reading / want to read / finished / set aside), rating, taste tags, and page count. No manual shelf management exists. Gallery vs. list view is the only persistent UI preference.

**Known weaknesses.**
- Full library loaded at once — no pagination or lazy loading. Likely fine to ~500 books; will slow above that.
- `subjects` filtering for shelves depends entirely on OL subjects being present. Goodreads-imported books without OL enrichment may never appear in the Romantasy shelf even if they qualify.

---

## 8. Book Detail Screen

**What appears.** `app/book/[id].tsx` (3,215 lines — the largest file in the codebase). In order top to bottom: hero cover backdrop with gradient glow, back button, cover thumbnail, title + author, edition info line, series/saga badge, status chip + action row, reading progress block (pacing, projection, progress bar), "Why this book?" section, content warnings section, description, series/saga timeline panel, taste tagging, review/notes, edit history.

**Edition awareness.** `fetchEditions()` is called once on mount via OL work ID resolution. Editions are stored as `OLEdition[]` in local state after `rankEditions('eng')` sorting. The picker defaults to English-tagged or language-unknown editions; a "Show all editions (N total, including translations)" link reveals the full list. Selecting an edition persists `edition_key` to `user_books` and immediately updates:
- `effectivePageCount` (selected edition's page count, or canonical page count if none)
- `editionCoverUrl` (only when the selected edition has a `coverKey`)
- `progressPct`, `paceEstimate`, `pagePacing.pagesLeft`, finish projection (all derive from `effectivePageCount`)
The publisher "n/a" string is filtered in both the picker rows and the edition info line. Year-only editions (no publisher and no page count) are now excluded from the picker entirely.

**"Why this book?" section.** Reads from `getRecContext()` (session cache) first; falls back to `getRecSnapshot()` (Supabase) when session is empty. Shows the rendered explanation paragraph and evidence tags (e.g., "Characters", "Romantic subplot", "Robin Hobb"). Section hidden entirely when no evidence is available — no empty state. Requires `rec_snapshots` migration for cross-session persistence.

**Content warnings.** `lib/contentWarnings.ts` maps OL subject strings to 9 warning categories (Violence, Death & grief, Sexual content, Substance use, Mental health themes, Animal harm, Abuse & trauma, Eating disorders, Child harm). Uses word-boundary regex matching (`/\b{pattern}\b/i`) — the correct approach. Migration `20260413000002` added a `content_warnings` column to `books`.

**Hero backdrop.** Cover thumbnail at 122×180px centered in a warm gradient (`#f4f0eb → #eee9e2`). Two simulated radial glow layers (inner bloom and outer ring) positioned behind the cover. Bottom fade gradient bleeds into the page background. Google Books covers get a cool blue-tinted glow; OL/other covers get the warm amber glow. Done purely with `View` layers — no `BlurView` or native shadow.

**Back navigation hardening.** `safeBack()` helper uses `useNavigation().canGoBack()`. Falls back to `router.replace('/(tabs)/library')` when the stack is empty (direct URL navigation, hard refresh, deep link). This prevents the crash that occurred with unguarded `router.back()` on empty navigation stacks.

**Known remaining caveats.**
- No persistent "edition pinned" indicator on the detail page. After selecting an edition, the edition info line updates but doesn't visually distinguish "default suggested" from "user-pinned."
- Content warnings depend on OL subjects being present. Low subject coverage = few warnings displayed.

---

## 9. UX / Design System Direction

**Visual language.** Warm editorial palette: `BG #f5f1ec`, `INK #231f1b`, `STONE #6b635c`, `DUST #9e958d`, `SAGE #7b9e7e`, `AMBER #c4956a`, `CREAM #fefcf9`, `BORDER #ede9e4`, `FAINT #c4b5a5`. No cold grays, no pure blacks. The palette reads like aged paper and ink. Typography skews small and tightly spaced — the app feels like a notebook, not a dashboard.

**Design token module.** `lib/tokens.ts` is now the single source of truth for all 10 palette values. Import as `import * as T from '../lib/tokens'`. Existing files use the correct inline hex values; they can be migrated to the token module incrementally.

**Intentionally improved.**
- `CoverThumb` typographic fallback (initials + SAGE accent strip + "NO COVER" micro-label on large surfaces) — feels intentional rather than broken.
- Library ShelfRow layout: auto-height cards, correct label alignment, no overflow clipping.
- Edition picker: language-ranked, quality-ranked, year-only editions excluded, "Show all" safety valve.
- Book detail hero: radial glow simulation is the most polished visual moment in the app.
- Content warnings: word-boundary matching avoids false positives, conservative category list.
- "Why this book?" evidence tags: concrete, scannable, grounded in actual signals.
- Smart shelf subject matching: word-boundary regex prevents false positives.

**Still unresolved.**
- No design token adoption in screen files yet — tokens.ts exists but the 43 files still use inline hex. Can be migrated incrementally.
- Type scale: `fontSize` values range from 7 to 36 across the codebase with no systematic scale. Some typography feels slightly inconsistent between screens.
- The home/rec feed screen and the library screen have different card styles for the same books. Visual language for book cards is not unified.
- No loading skeleton on the book detail screen — if OL enrichment is slow, the description and subjects area just expands in late.
- The rec feed confidence label ("Personalized for you" / "We're learning your taste") appears in the header but its connection to the actual recs is not explicit to the user.

**Calm / premium vs. utility balance.** The app tilts strongly toward calm and editorial. This is a strength for a reflective, reading-focused user but creates a tension with utility features (page logging, quick actions in the library) that need to be fast and frictionless.

---

## 10. Migrations / Manual Steps / Operational Checklist

### ⚠️ UNAPPLIED MIGRATIONS (apply via Supabase dashboard SQL editor)

**1. `supabase/migrations/20260413000001_rec_snapshots.sql`**

```sql
create table if not exists rec_snapshots (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  external_id   text        not null,
  explanation   text,
  evidence_tags text[]      not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, external_id)
);
alter table rec_snapshots enable row level security;
create policy "users manage own rec snapshots"
  on rec_snapshots for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

**Impact if not applied:** "Why this book?" section on book detail only works in the same session as arriving from the rec feed. Direct navigation, app restart, or deep links to book detail show no explanation.

---

**2. `supabase/migrations/20260414000000_user_books_edition_key.sql`**

```sql
ALTER TABLE user_books
  ADD COLUMN IF NOT EXISTS edition_key text;
```

**Impact if not applied:** Edition picker selections silently fail to persist. The UI shows the picker and appears to work, but the chosen edition is never saved to the database. Page count and cover overrides only last for the current session.

---

### Previously required migrations (assumed applied if the app is working)
- `20260411000000_reading_sessions.sql` — reading_sessions table
- `20260413000000_reading_sessions_allow_corrections.sql` — allows session correction events
- `20260413000002_books_content_warnings.sql` — adds content_warnings column to books
- `20260410000000_fix_book_source_links_conflict_key.sql` — conflict key fix for book_source_links
- `20260409000000_provider_link_hardening.sql` — cover_source, metadata_confidence, raw_payload on book_source_links

### Secrets / config
- `SUPABASE_SERVICE_ROLE_KEY` — referenced in the environment as missing. Not needed by the app code (all queries use the anon key + RLS). Required only for server-side admin operations (user deletion edge function).
- No other secrets required. OL is a free unauthenticated API. Google Books is called without an API key (free tier quota via unauthenticated requests).

### Other manual steps
- **OL attribution** — Open Library's terms require attribution. Not currently displayed in the app. Must be added to book detail and/or a settings/about screen before public launch.

---

## 11. Known Bugs / Caveats / Technical Debt

**Active bugs.**
1. No "edition pinned" indicator on book detail after selection. The cover and page count update, but the edition info line looks identical whether showing a user-pinned edition or the default suggested one.
2. `rec_snapshots` and `edition_key` column are not usable until the two pending migrations are applied. The code is complete and correct; the DB is the blocker.

**Pre-existing TS errors (do not touch).** The following files have TypeScript errors that predate recent work and are known: `app/(tabs)/` (various), `app/_layout.tsx`, `app/auth/callback.tsx`, `app/import/`. These compile and run correctly; the errors are type coverage gaps, not runtime issues.

**Fragile areas.**
- `supabase possibly null` is codebase-wide. Many code paths have `if (!supabase) return` guards but the pattern is inconsistent. In practice, `supabase` is always initialized — but a future import path change could expose this.
- Module-level library cache (`_libCache`) is never size-bounded. For a user with 2,000+ books (heavy Goodreads import), holding the full item array in module scope could be a memory concern on older devices.
- `rec_candidate_cache` version string `'v5:'` in `CACHE_VERSION` is a manual constant. If retrieval logic changes and the version is not incremented, stale candidates will be served from cache with no indication.

**Temporary bridges / stopgaps.**
- Expert mode (`lib/expertRec.ts`) is TypeScript heuristics designed to be replaced by an LLM call. The interface is correct and the replacement is a clean swap, but the current output quality is bounded by what `buildReaderThesis()` can derive from structured data without natural language reasoning.
- `displayEdition = selectedEdition ?? editions[0] ?? null` — the fallback to `editions[0]` means the edition info line always shows something even before a user makes an explicit choice. This is a UX convenience, not a real "chosen edition."
- The `reading_sessions_allow_corrections` migration (`20260413000000`) adds `DELETE` to the sessions RLS policy. The correction mechanism is plumbed but there is no UI for it yet.

**Good-enough-for-now decisions.**
- Social layer (friendships, peer recommendations, credibility events, activity events) — schema is complete and RLS policies exist, but the social features are schema-ahead of the UI.
- No offline mode. Everything is live-fetched. A user with no connectivity sees empty states.
- `duration_minutes` in `reading_sessions` is always null. Reading time estimates are not available.

---

## 12. Deferred Backlog / Future Opportunities

### Recommendation system
- Replace `expertRec.ts` heuristics with an LLM structured prompt call. The interface is already designed for this swap (function signatures, input types). This is the single highest-leverage quality improvement.
- User-controlled "More like this" / "Less like this" per book (the `rec_feedback` table exists; UI for in-rec feedback is partially built).
- Recommendation explanation depth — currently one to two sentences. A richer "Why" panel with multiple evidence lines is architecturally ready but not in the current UI.

### Reading insights / wraps
- Year-in-review ("Reading Wrapped") as a shareable image. The pure computation functions are done (`readingWraps.ts`). The visualization layer needs a shareable export.
- Cross-book reading velocity comparison (fastest vs. slowest books by pages/day).
- Genre distribution stats (what percentage of your reading was fantasy vs. mystery this year).

### Library architecture
- User-created shelves (manual shelves — already called out in `shelves.ts` as architecturally ready: "User-created shelves can be appended to SHELF_DEFINITIONS without any architectural changes").
- Pagination or virtual list for large libraries (> 500 books).
- Shelf ordering (Romantasy currently surfaces all statuses; a status-axis sort within a shelf would improve it).

### Book detail
- "Edition pinned" visual indicator — small affordance to confirm the user's selected edition persists.
- OL attribution label on detail screen (required before public launch).

### Social / book clubs
- The peer recommendation system (recommendations table, credibility_events) is schema-complete. The UI for searching friends, sending recs, and receiving recs is the missing layer.
- A "credibility" system (recommenders earn credibility when their recs lead to finished books) is modeled in `credibility_events` — not yet surfaced in the UI.

### Onboarding
- The onboarding flow (`app/onboarding.tsx`, `OnboardingShell`, `OnboardingWalkthrough`, spotlight apertures) is implemented but completeness is unclear. The walkthrough engine (`lib/walkthroughEngine.ts`) and demo components (`WtDemoLibrary`) exist.

### Metadata / providers
- OL subject coverage improvement: a batch job that re-runs OL lookup for all books still missing subjects would immediately improve shelf quality and recommendation signals.
- Google Books quota to server-side tracking — move daily call counting from AsyncStorage (per-device) to Supabase (per-key).

### Production readiness
- Add OL attribution to UI.
- Move Google Books quota tracking to server-side.
- Apply two pending migrations.
- Review social feature completeness (friends, peer recs, activity feed) before marketing the social angle.

---

## 13. Recommended Next Steps

### 1. Apply both pending migrations immediately
**Why:** `rec_snapshots` and `edition_key` are fully built in code and actively called by production paths. Without `rec_snapshots`, "Why this book?" silently degrades to nothing for any non-same-session navigation. Without `edition_key`, edition selection appears to work but never persists. Both are data-loss and feature-correctness issues, not nice-to-haves.
**What before what:** These are zero-dependency steps. Do them now via the Supabase dashboard SQL editor.

### 2. Word-boundary subject matching in `matchesSubjects()` ✅ DONE
`lib/shelves.ts` now uses `/\b{escaped_keyword}\b/i` — not `String.includes()`. This is consistent with how `contentWarnings.ts` has always handled subjects. Smart shelf membership for Romantasy, Long Reads, and Comfort Reads is now accurate.

### 3. Design token module ✅ DONE
`lib/tokens.ts` is created with all 10 palette constants. Existing files use the correct inline values. Migrate screen/component files to the token module incrementally as those files are edited for other reasons.

### 4. Expert mode → LLM replacement
**Why:** This is the single highest-leverage quality improvement available. The `buildReaderThesis()` and `judgeCandidateFit()` functions are TypeScript heuristics that produce structurally correct but reasoning-limited output. The architecture is explicitly designed for this swap — function signatures accept the full evidence pack and return the same output shape an LLM would produce.
**What before what:** After migrations. Requires a decision on which LLM provider (OpenAI structured outputs is the obvious fit for the existing type schema). Entitlement model already exists to gate this to qualifying users.
**Do not touch:** The existing deterministic pipeline — it remains the primary path when expert mode is unavailable.

### 5. OL subject coverage batch repair
**Why:** Subject coverage is the hard ceiling on smart shelf membership and recommendation quality. Goodreads-imported books that haven't gone through OL repair have no subjects — they can't match Romantasy, they produce no content warnings, they carry weak recommendation signals. Running `repairBooksMetadata()` with a broader cap for all user libraries would immediately lift recommendation quality and shelf population without any algorithm changes.
**What before what:** After migrations. Independent of token module and LLM work.
**Scope:** A one-time or periodic script that calls `repairBooksMetadata()` for all `books` rows with `subjects IS NULL`. Can be triggered from a dev button in the app or via a Supabase Edge Function. The repair function already exists and handles failures gracefully.

---

### What explicitly should NOT be touched right now

- **The social layer** (friendships, peer recs, credibility events, activity feed) — schema is complete but the UI completeness is unclear. Risk of partially exposing incomplete social features to users before they're ready.
- **The `dnf` enum value** in the database — the UI shows "Set Aside" everywhere but the stored value is still `dnf`. Renaming the enum requires a migration that re-creates the enum type and updates all references. Defer until there's a clear need.
- **Pagination for the library** — the full-load-at-once approach works fine at current library sizes. Adding pagination before it's a measured performance problem introduces complexity for no current benefit.
- **`duration_minutes` in reading_sessions** — there's no UI for reading time tracking yet. Adding time-based features requires a UI decision first.

---

*End of audit. All section numbers and content correspond to the original 13-section structure requested.*
