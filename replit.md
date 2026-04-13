# Book Recommendation App

## Overview
The Book Recommendation App is a React Native mobile application designed to help users discover, track, and share book recommendations. It integrates the Open Library API for book data and Supabase for backend services. The primary goal is to create a personalized reading experience, allowing users to send recommendations to friends, manage their reading library, and monitor reading progress. A distinctive feature is a "credibility" system where recommenders gain credibility when their suggested books are finished. The project aims to cultivate a dynamic community focused on reading and personalized discovery.

## User Preferences
Not specified.

## System Architecture
The application is developed using React Native with Expo Router for navigation and web compatibility. Supabase provides the backend infrastructure, including authentication, PostgreSQL database management, and Row Level Security (RLS). TypeScript ensures type safety throughout the application.

**Metadata Architecture (Phase 1 — Provider-Agnostic Layer):**
- `lib/metadataProvider.ts` — canonical provider abstraction. Defines `BookMetadataProvider` interface, `ProviderBookResult` (normalized canonical shape), `CoverState` (explicit fallback signal), `GoogleBooksProvider` (first adapter implementation), `recordProviderLink()` (upsert to book_source_links), `selectBestCover()` (ranked cover selection), `deriveMetadataConfidence()` (isbn13 > title+author > low).
- `lib/metadataRepair.ts` — self-healing two-phase OL→GB repair. Now writes `cover_source`, `metadata_confidence`, records provider links to `book_source_links`, uses `selectBestCover` for cover selection, logs all repair activity with `[REPAIR]` prefix.
- `lib/bookEnrichment.ts` — cache-aware enrichment pipeline. Now logs cache hits/misses (`[ENRICHMENT]` prefix) and GB background fetch outcomes.
- `lib/googleBooks.ts` — isolated GB API functions (unchanged — no app code imports GB directly; all access goes through metadataRepair or bookEnrichment).
- Schema: `books.cover_source` (text), `books.metadata_confidence` (text check: high/medium/low), `book_source_links.raw_payload` (jsonb), `book_source_links.last_fetched_at` (timestamptz), `book_source_links.fetch_status` (text check: success/failed/rate_limited). Migration: `supabase/migrations/20260409000000_provider_link_hardening.sql`.

**Phase 4 Wrap UI + Evidence Tags + DNF Refinement (complete):**
- **`app/wrap/month.tsx`** — Monthly wrap screen. Params: `month` (YYYY-MM). Fetches its own `reading_sessions` + book lookup. Shows: pages read (hero), stat rows (reading days, avg pages/day, longest session, streak-in-month, session count, books active), most-read book callout (only when >1 book active), "See all of YEAR →" link to yearly wrap. Sparse state: quiet "Nothing logged in [month]" copy.
- **`app/wrap/year.tsx`** — Yearly wrap screen. Params: `year` (YYYY). Fetches sessions + `booksFinished` from full-year user_books query. Shows: books finished (hero), summary stat rows (pages, reading days, avg, streak), monthly rhythm bar chart (reading days per month, relative width bars, sage green), most active month callout. Sparse state handled.
- **Entry points wired into home screen**:
  - `"This month →"` quiet link below `ReaderInsightCard` — appears only when `currentMonthWrap.pagesRead > 0 || readingDays > 0`; routes to `/wrap/month?month=YYYY-MM`
  - `"View YEAR →"` quiet link at bottom-right of yearly goal section; routes to `/wrap/year?year=YYYY`; always visible when yearlyGoal is set
- **`components/RecCard.tsx`** — Evidence tags system:
  - `buildEvidenceTags(book: ScoredBook): string[]` — derives up to 2 compact tag labels from `_score_breakdown` fields and `reasons[]` array. Priority: author affinity (`author_books_read >= 2` → `"Author you read"`) > trait match (`trait_alignment >= 0.25` + trait in reasons → e.g. `"Pacing"`, `"Emotional depth"`, `"Prose"`, `"World-building"`) > theme overlap (`"Theme overlap"` when subject-match reason present) > feedback signal (`"Your feedback"` when `feedback_boost > 0`).
  - `EvidenceTagsRow({ tags })` — renders chips below the prose explanation. Stone-bordered, warm BG, 10px text. Returns null when `tags.length === 0`.
  - Old "Author match" purple `VariantBadge` removed — superseded by evidence tags.
  - `TRAIT_TAG_MAP` maps raw trait names to display labels (9 traits covered).
- **`app/(tabs)/library.tsx`** — DNF softened throughout:
  - `STATUS_LABELS.dnf` → `'Set aside'` (was `'DNF'`)
  - `STATUS_BADGE.dnf` → warm neutral `{ bg: '#f0ece6', text: '#7d6f63' }` (was alarm red `#fee2e2/#b91c1c`)
  - Filter tab → `'Set aside'`
  - Empty state → `'Nothing set aside'` / `'Sometimes a book isn\'t the right fit for now.'` (was `'No abandoned books'` / `'DNF is always a valid call.'`)
  - Both action buttons (`DangerButton`) in reading and want-to-read rows → `"Set aside"` (was `"DNF"`)
  - DB status value `'dnf'` unchanged — purely display-layer rename.
  - `DnfReasonChips` copy and options unchanged (already well-tuned).

**Phase 3 Reflective Insights Layer (complete):**
- **`lib/readingWraps.ts`** — new pure-function library, zero I/O, fully testable. Exports:
  - `WrapSession` (input type — flat session with optional user_book_id)
  - `WrapBookRef` (title/author stub for book-level aggregations)
  - `MonthBreakdown` (per-month totals used inside YearlyWrap)
  - `MonthlyWrap` — pagesRead, readingDays, sessionCount, avgPagesPerReadingDay, longestSessionPages, booksActive, topBook (with book lookup), longestStreakInMonth
  - `YearlyWrap` — year, booksFinished (accurate, from user_books query), pagesRead/readingDays/sessionCount (session-window derived, may undercount early months), monthlyBreakdown, mostActiveMonth (with label), longestStreak, avgPagesPerReadingDay
  - `computeMonthlyWrap(allSessions, month, bookLookup?)` — calendar-scoped monthly summary
  - `computeYearlyWrap(allSessions, year, booksFinished, bookLookup?)` — year-scoped summary, single-pass monthly aggregation
  - `ReaderInsight` + `InsightKind` types — display-ready insight records (kind, text, strength: notable|mild)
  - `deriveInsights(currentWrap, prevWrap, yearlyWrap, yearlyGoal, today?)` → up to 2 prioritised `ReaderInsight[]`. Computes: consistency rate (reading days vs days elapsed), session depth (avg pages/day), month-over-month momentum (normalized pace delta vs prev month), best-month-so-far check (vs other months in yearlyBreakdown), year-pace-toward-goal (projected books vs goal). Notable insights sort first; returns empty array if data is too sparse.
- **`app/(tabs)/index.tsx`** — wired wrap computation from already-loaded state:
  - `allSessions: WrapSession[]` — useMemo flattening `sessionsByBook` with `user_book_id` attached
  - `bookLookup: Record<userBookId, WrapBookRef>` — useMemo from `booksThisYear + currentReads` (no extra fetch)
  - `currentMonthWrap`, `prevMonthWrap` — useMemo monthly wraps for current and prior calendar month
  - `yearlyWrap` — useMemo from allSessions + booksThisYear.length
  - `insights: ReaderInsight[]` — useMemo from deriveInsights; empty when not enough data
  - `ReaderInsightCard` component — renders up to 2 insights as calm bullet-point lines below `StreakPill`. Stone `#6b635c` text, dust dot `#c4b5a5`, 12px/lh18 type. Returns null when empty.
- **Data coverage note**: session window is 90 days; `yearlyWrap.booksFinished` is accurate (from full-year user_books query); session-derived yearly totals may undercount months earlier than 90 days ago. Noted in type-level JSDoc.
- **Intentionally deferred**: wrap UI screens (monthly/yearly summary card), yearly wrap "top book" (requires wider session history query), sharing/export, historical multi-year comparison.

**Phase 2 Social Reading Depth (in progress):**
- **DNF reason capture** (`app/(tabs)/library.tsx`): When a book is marked DNF, a `DnfReasonChips` component replaces the star-rating prompt. Four soft, reflective reason chips: "Not for me", "Wrong time", "Life got in the way", "Too slow / dense". Reason stored as `taste_tags.dnf_reason` (jsonb column — no schema change). `saveDnfReason()` merges with existing `taste_tags` to preserve liked/disliked tags. On subsequent library loads, stored reason shown italicised below DNF book date ("Not for me" etc.) using `DNF_REASON_LABELS` map. `taste_tags` column added to all four `user_books` select queries and to `UserBook` type.
- **Forecast confidence polish** (`app/(tabs)/index.tsx`): `HeroReadCard` now accepts `pacingStrength?: 'strong' | 'moderate' | 'weak'` prop. Forecast label adapts: weak → `"~Apr 11 · early days"` in `#b8aca0` (light/uncertain); moderate → `"Finish ~Apr 11"` in stone `#9e958d`; strong → `"Finish ~Apr 11"` in darker `#6b635c` (confident). Pacing strength comes from `computeSessionPacing().strength`.
- **Stronger streak surface** (`app/(tabs)/index.tsx`): `StreakPill` now shows two lines: (1) active streak with optional "best: N" suffix when longest ≥ 7 and is materially higher; (2) "N reading days this month" shown separately when ≥ 3 monthly days. Threshold for streak display unchanged (≥ 2 days). Tone: reflective, not gamified.
- **Monthly stats foundation** (`lib/pacing.ts`): `computeMonthlyStats(sessions, today?)` → `MonthlyStats` type (`pagesThisMonth`, `readingDaysThisMonth`, `sessionsThisMonth`). Designed as the data layer for monthly/yearly reading wraps. `HomeSnapshot` carries `longestStreak` + `monthlyStats`; both computed in `loadSessionData` and cached. `StreakPill` consumes `monthlyStats.readingDaysThisMonth`.
- **Console log cleanup**: All `[SESSION]` logs in `lib/userBookActions.ts` and `[taste_tags]` logs in `library.tsx` are now gated behind `__DEV__`.

**Phase 1 Reading Progress / Pacing Depth (complete — pending migration apply):**
- `lib/streaks.ts` — `computeStreaks()` (current streak + longest streak from session dates; grace window allows yesterday-ending streaks); `localDateString()` (YYYY-MM-DD local date, avoids UTC drift). `StreakPill` shown on Home when current streak ≥ 2 days.
- `lib/pacing.ts` extended — `ReadState` type (`active` ≤14 days / `paused` 15–60 days / `stalled` >60 days); `inferReadState()` (uses `progress_updated_at` or `started_at` fallback); `SessionRow` type; `computeSessionPacing()` (session-based pace from reading_sessions; strength: strong ≥5 / moderate 3–4 / weak 1–2; uses calendar-day rate for honest estimates); `formatProjectedFinish()` (human-readable finish projection).
- `lib/userBookActions.ts` — `saveCurrentPage()` now auto-derives a `reading_sessions` row on forward progress: `session_date` = local YYYY-MM-DD string, pages_read = delta, duration_minutes null (no timer). Regressions skip session creation but still log to progress_events.
- `lib/devInspector.ts` — `__rs.pacing(userBookId)` and `__rs.streaks()` exposed for developer inspection.
- `supabase/migrations/20260411000000_reading_sessions.sql` — `reading_sessions` table (user_id, book_id, user_book_id, session_date, started_page, ended_page, pages_read, duration_minutes); RLS + two indexes. **Needs manual apply in Supabase dashboard.**
- Home screen: `HomeSnapshot` carries `sessionsByBook` + `currentStreak`; `HeroReadCard` shows session-based projected finish + read state; `StreakPill` renders below Reading Now cards.
- Library screen: reading cards now use `inferReadState()` — shows "Stalled — been a while" (amber) or "Paused for now" (stone) instead of the previous raw `isStale` check.
- Recommendation classifier: `classifyExplanationQuality()` takes `traitAlignment` (4th param); `SINGLE_TRAIT_STRONG_FLOOR = 0.25` constant gates single-trait STRONG vs `acceptable_specific`.

**Key Features:**
- **Book Search & Recommendations:** Users can search for books using a hybrid Google Books + Open Library retrieval system. Recommendations can be sent to friends.
- **Library Management:** Users can track reading status (want to read, reading, finished, DNF) and rate completed books.
- **Activity Feed:** Displays friend activities such as sent, saved, started, or finished books.
- **Profile:** Users can set yearly reading goals, view their taste profile, see currently reading books, and track reading statistics.
- **Recommendation Engine:** Incorporates a taste profile system, a Recommendation Integrity Layer (RIL) to manage series and floods, a Center-of-Gravity Fit Classifier for nuanced book fit classification, and a Set Composition Engine for diverse recommendations. An Expert Reasoning Layer is designed for potential LLM integration.
- **Onboarding + In-App Walkthrough System:** Features a two-phase flow including a cinematic intro and a guided in-app tour with spotlight apertures and coach marks.
- **Barcode Scan / "Will I like this?" Feature:** Allows users to scan book barcodes (or manually enter ISBNs on web) to receive a fit evaluation based on their taste profile.
- **UI/UX:** Uses a warm editorial color palette — BG `#f5f1ec` (ivory), INK `#231f1b` (warm ink), STONE `#6b635c`, DUST `#9e958d`, SAGE `#7b9e7e`, CARD_SURFACE `#fefcf9`, BORDER `#ede9e4`. Includes a `CoverThumb` component for dynamic cover display. Defensive fallbacks are implemented for critical queries. Full palette applied across auth (login.tsx), onboarding (onboarding.tsx, onboarding-import.tsx), and walkthrough overlay (CoachCard). Status panels use parchment `#f5ede0`/`#d8c9b4` replacing former clinical green/amber tones.
- **Tab Safe Area:** All five tab screens handle the device safe area (notch / Dynamic Island) via `TabScreenHeader` (`components/TabScreenHeader.tsx`) which calls `useSafeAreaInsets().top` internally. Home and Profile use `useSafeAreaInsets` directly in their padding. Hardcoded `paddingTop: 24/48` values are removed from all tab screens. The Library, Inbox, and For You screens use `TabScreenHeader` with a title + optional right-action slot; the "Library", "Inbox", and "Recommendations" 28px redundant titles are removed from scroll content.
- **Account Lifecycle Layer:** Manages user self-deletion, developer/test account resets, and a redesigned signup/recovery user experience. Includes deployment-ready Supabase Edge Functions for account management.
- **Social Sign-In:** Google (expo-auth-session + expo-web-browser, works on all platforms) and Apple (expo-apple-authentication, iOS only, native sheet) sign-in. Both flows integrate with existing onboarding/auth guard via supabase.auth.onAuthStateChange. Social buttons appear above email/password form in login.tsx with "or" divider. Error messages are user-friendly (no raw API errors). Apple button is platform-conditional (shown only on iOS). Requires Supabase provider configuration for each provider to activate.
- **Goodreads Import — Multi-path Acquisition:** Solves mobile dead-end and inline-CSV rendering problem. Three acquisition paths all feed the same `processCSVText()` pipeline: (1) web file picker (existing), (2) native document picker via `expo-document-picker` + `expo-file-system` — replaces the old "go to a web browser" dead end on iOS/Android, (3) paste-from-browser text area — handles cases where Goodreads renders CSV inline as page text (user selects all, copies, pastes). The "Import pasted text" button is disabled until meaningful text is present; the paste box highlights its border when text is entered. Step 4 instruction copy updated to explain both paths. On error/reset, paste state is cleared.

**Design Principles (Readstack Systems Contract v1):**
- **Core Product Principle:** The app should be calm, stateful, and understand the user, operating without exposing its internal machinery.
- **Global Rules:** Emphasizes single implementations for core capabilities, avoidance of replacing meaningful content with worse intermediate states, preference for stale but usable content over blank but "fresh," explicit action semantics, and preventing UI from leaking internal phases.
- **Shared System Ownership:** Defines shared pipelines for search, book state, loading, and authentication/account lifecycle.
- **Loading and Refresh Contract:** Specifies rules for first cold load, warm revisits, background refresh, placeholder design, and avoiding visible churn.
- **Navigation Continuity Contract:** Focuses on persistent tab behavior, preserving context on back navigation, and reliable gesture behavior.
- **Action Feedback Contract:** Requires immediate local feedback for primary actions, feedback at the point of interaction, and legible failure states.
- **Search Contract:** Prioritizes accuracy, emphasizes retrieval before ranking, mandates a single shared pipeline, and defines query behavior for weak and strong queries.
- **Onboarding Contract:** Focuses on teaching through action, unambiguous exit semantics, and providing early payoff.
- **Book-State and Data Integrity Contract:** Stresses truth over convenience for dates, preservation of history for status changes, soft deletion by default, and a single source of mutation truth.
- **Surface Contracts:** Defines the purpose and forbidden anti-patterns for Home, Recommend, Library, Book Detail, Onboarding, and Auth screens.
- **Delivery Process for All Future Work:** Outlines a structured process for implementing non-trivial changes, starting from defining product/surface contracts and tracing live runtime paths.
- **QA Gate:** Specifies validation criteria focusing on flow-level QA.
- **Anti-Patterns:** Lists behaviors no longer allowed, such as multiple implementations of core behavior, screen-local logic, and loaded content regressing to placeholders.
- **Priority Lens:** Establishes a hierarchy for evaluating future work: trust, continuity, user effort, and correctness without exposing machinery.

## External Dependencies
- **Supabase:** Used for user authentication, PostgreSQL database, and Row Level Security.
- **Open Library API:** Primary source for book search functionality and metadata.
- **Google Books API:** Used for enriching book data with details like language, categories, and ratings.
- **AsyncStorage:** Used for persistent local caching of recommendation payloads.