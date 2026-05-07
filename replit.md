# Book Recommendation App

The Book Recommendation App helps users discover, track, and share personalized book recommendations, fostering a community around reading.

## Run & Operate
- `npm run dev:device`: Run the app on a device for JS-only changes.
- `npm run build:android:dev` / `build:ios:beta`: Build native app for Android/iOS.
- **Environment Variables:** `LLM_MODEL` (for `inferSubjectsLLM.ts`).
- **Required ENV vars**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OPEN_LIBRARY_API_KEY`, `GOOGLE_BOOKS_API_KEY`. (Implicit from `Supabase` and external APIs used).
- **Pending Migrations**:
    - `supabase/migrations/20260413000001_rec_snapshots.sql`
    - `supabase/migrations/20260414000000_user_books_edition_key.sql`
    - `supabase/migrations/20260506000000_user_books_paused_at.sql`
    - `supabase/migrations/20260506000001_user_shelves.sql`
    - `supabase/migrations/20260507000000_rating_half_star.sql`
    - `supabase/migrations/20260507000001_user_books_year_goal.sql`
    (Need manual application via Supabase dashboard SQL editor.)

## Stack
- **Frameworks:** React Native, Expo Router
- **Runtime Versions:** Node.js (implicit via `package.json`), React Native (implicit via `package.json`), Expo (implicit via `package.json`)
- **ORM:** Supabase (PostgreSQL)
- **Validation:** TypeScript
- **Build Tool:** Expo

## Where things live
- `lib/tokens.ts`: Design token source of truth (color palette).
- `supabase/migrations/*.sql`: Database schema migrations.
- `lib/shelves.ts`: Smart shelf filtering logic (`matchesSubjects`).
- `lib/contentWarnings.ts`: Content warning matching logic.
- `lib/metadataProvider.ts`: Canonical book metadata shapes and cover selection.
- `lib/metadataRepair.ts`: Open Library → Google Books metadata repair system.
- `app/book/[id].tsx`: Book detail screen.
- `app/stats/index.tsx`: "Reading Insights" screen.
- `lib/readingWraps.ts`: Library for computing monthly and yearly reading wraps.
- `docs/google-signin.md`: Google Sign-In configuration and troubleshooting.
- `docs/dev-testing.md`: Device testing workflow.
- `components/LibraryGalleryView.tsx`: Library gallery view component.
- `lib/socialAuth.ts`: Social authentication helper.
- `app/auth/callback.tsx`: OAuth callback handler.
- `lib/openLibrary.ts`: Open Library API interactions.
- `lib/recommender.ts`: Recommender system (contains `FORENSIC_USER_ID`).
- `lib/sessionSegment.ts`: Reset-aware session segmentation.
- `lib/pacing.ts`: Reading pacing calculations.
- `scripts/repairSubjectCoverage.ts`: Script for batch subject repair.
- `scripts/inferSubjectsLLM.ts`: Script for LLM-based subject inference.
- `lib/subjectVocabulary.ts`: Curated subject vocabulary for LLM inference.
- `scripts/backfillSessionCorrections.ts`: Script for backfilling session corrections.
- `scripts/deduplicateBooks.ts`: Script for deduplicating book rows.
- `lib/goodreadsExecutor.ts`: Goodreads import logic, including deduplication.
- `app.json`: Expo configuration, including camera plugin and explicit iOS `NSCameraUsageDescription` (defense-in-depth on top of the expo-camera plugin's auto-generated key).
- `docs/ios-testflight-checklist.md`: TestFlight QA checklist (auth, deep links, layout, native modules) — run before each beta.
- `lib/customShelves.ts`: User-managed shelves CRUD (single source of truth for `user_shelves` / `user_shelf_books` mutations).
- `lib/intentMatcher.ts`: Mood/intent vocabulary + `parseIntent` / `matchBookToIntent` for the Want-to-Read filter.
- `components/ShelfRow.tsx`: Renders smart shelves + custom shelves + "+ New shelf" tile.
- `components/ShelfPickerSheet.tsx`: Bottom sheet for toggling a book's shelf membership; supports inline create.
- `components/RecommendBookSheet.tsx`: Sender-side sheet for recommending a finished book to a friend (loads accepted friendships, optional ≤200-char note, native Share fallback). Inserts into `recommendations` + `activity_events` mirroring the existing pattern in `app/(tabs)/search.tsx` `handleSend`.
- `components/HalfStarRating.tsx`: Reusable half-star rating control + read-only `StarDisplay` + `ratingToSentiment` (≥4.5 loved / ≥3.5 liked / ≥2.5 okay / else not_for_me) + `formatRating`. Single source of truth for all rating UI (library inline, book detail post-finish + edit, search rate card, home feed display).

## Architecture decisions
- **Hybrid Book Data Retrieval:** Combines Open Library and Google Books API for comprehensive and enriched book metadata.
- **Supabase as BaaS:** Leverages Supabase for authentication, PostgreSQL database, and Row Level Security, simplifying backend development.
- **Edition Awareness:** Allows users to select specific book editions, dynamically updating cover and page count for accurate reading progress, while preserving `current_page`.
- **Three-Pass Subject Enrichment:** Uses Open Library, Google Books, and LLM inference to maximize subject coverage for books, ensuring rich discoverability.
- **Reading Progress Reset Logic:** Implements "reset-to-0 = start over" rule for reading sessions, ensuring stats like monthly pages and streaks accurately reflect current reading efforts.
- **Explicit Paused State:** `user_books.paused_at` lets readers self-mark a 'reading' book as Paused (toggle in book detail's Reading Progress card). `inferReadState` returns 'paused' immediately when `pausedAt` is set, overriding the inactivity heuristic. `transitionStatus` always clears `paused_at` so it can never outlive the status it was set under.
- **Single Green System (sage):** All greens flow through `SAGE`, `SAGE_BG`, `SAGE_DEEP`, `SAGE_INK` in `lib/tokens.ts`. Never reintroduce raw Tailwind greens (`#15803d`, `#16a34a`, `#166534`) or hand-rolled `#2f6f3a` literals — import the token instead. `SAGE_INK` is reserved for sparing emphasis on top of `SAGE_BG`.
- **Reading Progress motion (home):** The yearly-goal bar (`progressAnim`) eases from 0 → live pct on mount and on goal change; the streak flame (`flameAnim`) loops a subtle scale pulse only when `streakValue > 0`. Both refs live in `app/(tabs)/index.tsx` near the top of the component — keep timing/easing in sync if either is touched.
- **Recommendation rationale variants:** `components/RecCard.tsx` builds card explanations from variant *pools* (4 phrasings each for aligns / appreciation / reader-trait / subject / lane-fallback / theme-tail; 3 for author-loyalty). A FNV-1a hash of `book.id + pattern-tag` deterministically picks one variant — same card always shows the same sentence (snapshot-stable), but consecutive cards rotate. Banned phrasings (`"you gravitate toward"`, `"because you liked"`) are absent from every pool. When `reasons[0]` is a *trait* signal AND `reasons[1]` is a *theme* signal, `buildExplanation` joins them via `_themeTailFor` so two distinct kinds of evidence surface in one sentence.
- **Custom shelves alongside smart shelves:** `user_shelves` (named, per-user, unique-by-lower(name)) + `user_shelf_books` (CASCADE on shelf delete only — books always survive). `ShelfRow` renders both kinds identically; `activeShelf` in `library.tsx` resolves smart-first then falls back to `userShelves`. All mutations go through `lib/customShelves.ts` so duplicate handling (23505 → friendly error / idempotent add) stays consistent. Long-press a custom shelf chip → confirm-delete; long-press a library row → `ShelfPickerSheet`.
- **For-You intent chips → hard rules (not just soft boosts):** `handleApplyIntent` in `components/RecommendationsFeed.tsx` derives `hard` filters and `exclude` rules from the chip selections in addition to setting `soft` preferences. Soft boosts in `lib/nextReadIntent.ts` use `SOFT_BOOST = 0.12` per signal capped at ±0.30 (raised from the original 0.04 / ±0.05 cap, which was too small to actually reorder books at typical 0.5–1.0 score ranges — users perceived "filter does nothing"). Same cap applied to `MOOD_BOOST` and `totalBoost` in `lib/recommender.ts`. Mapping: `tone='light'`/`intensity='low'`/`mood='light_fun'`/`mood='palate_cleanser'` → `exclude.avoid_dark`; `mood='light_fun'` → `exclude.avoid_literary`; `mood='palate_cleanser'` → `hard.max_page_count=400` (intentionally NOT `standalone_only` — would empty the pool for series-heavy libraries). `tone='dark'` always wins over the avoid_dark mappings so a user who explicitly picks dark + low intensity doesn't get an empty list. `pace`, `tone='dark'`, `intensity='high'`, and the remaining moods stay soft-only because there's no clean hard-filter equivalent.
- **Want-to-Read intent matching (deterministic, local):** `lib/intentMatcher.ts` parses queries like "short fantasy" or "fast paced" into AND-combined `IntentSignal`s (subjects via `matchesSubjects`, page bounds, free-text fallback). Runs on every keystroke — no model calls. `signalsRequireMetadata` powers an honest empty state that distinguishes "no matches" from "your saved books lack the metadata to answer this query yet".
- **Recommend-from-finished quick action:** `app/book/[id].tsx` shows a sage "Recommend to a friend" button inside the Your History card only when `localStatus === 'finished'`. Opens `RecommendBookSheet`, which reuses the existing `recommendations` table (no migration), inserts `status='sent'` + `activity_events` row of type `recommendation_sent` (recipient sees it via `RecsInboxSheet`). Pre-loads prior sends of this book to flag "Already recommended" per friend (RLS still blocks true duplicates if the user retries — surfaced as friendly error). Native `Share.share` fallback always available, even with zero friends. Intentionally deferred: DMs, friend discovery from this surface, deep links, push notifications.
- **Half-star ratings + finish-prompt visibility:** `user_books.rating` and `activity_events.rating` are `numeric(3,1)` constrained to `{0.5, 1, 1.5, …, 5}` (migration `20260507000000_rating_half_star.sql`). All rating UIs route through `HalfStarRating` so left-half = N−0.5 / right-half = N is consistent. Library's `filteredItems` keeps a row visible whenever `pendingFeedback?.userBookId === i.id` even if the row's new status no longer matches the active chip — without this, marking a book Finished from the "Reading" filter made the row disappear before the inline rating prompt could render. Sentiment thresholds are centralized in `ratingToSentiment` so library + book detail + search stay in lock-step.

- **Author bibliography excludes box sets / omnibuses:** `fetchAuthorBibliography` (lib/openLibrary.ts) filters every doc through `isBoxSet({ title })` from `lib/boxSetDetection.ts` before adding it to `entries`. Box sets, omnibuses, "Books N–M", and "X-Book Bundle" titles are pure repackaging of works already listed in the same response (e.g. Lucy Foley's 2023 3-book boxset duplicates titles already in her bibliography), so excluding them at the query layer keeps the sheet a clean list of distinct works. Done at the query layer (not in `AuthorBibliographySheet.tsx`) so every consumer of the bibliography sees the same de-bundled list. If a future bundle ever ships with genuinely new material, that material would still appear via its own non-bundle title elsewhere in the OL response.
- **Author bibliography is OL-catalog-only, not OL-ratings:** `fetchAuthorBibliography` (lib/openLibrary.ts) resolves the requested name to a canonical OL author key via `search/authors.json` and queries `search.json?author_key=…` so we don't get unrelated authors who merely share a name (the old `?author=…` query is fuzzy — Lucy Foley returned 1940s/1970s books by other Foleys). A second strict `author_name` normalized-equality guard runs on every doc as a backstop for cases where the canonical key still has co-credits. Falls back to the old `?author=` filter only if author lookup fails. The `rating`/`ratingCount` fields on `AuthorBibliographyEntry` are kept on the type for back-compat but always set to `null`; `AuthorBibliographySheet.tsx` never reads them — the "By rating" sort, the OL star badge, and the rating-weighted hero-cover ranking were all removed. Hero covers now rank by recency. Footer attribution explicitly says "Catalog from Open Library" without mentioning ratings, because Readstack's ratings are sourced from app users (`user_books.rating`).
- **Priority filter chip (library):** `app/(tabs)/library.tsx` exposes `'priority'` as a `FilterKey` alongside the status chips. Selecting it filters `items` to rows where `year_goal_year === currentYear` (membership in this year's stack). Finished books are intentionally retained in the priority view (unlike the home-screen strip which excludes them) so the reader can see what's already done vs still queued for the year in one place. Count badge wires through `statusCounts.priority`. The chip slot sits second (right after `All`) so it's the most-prominent non-status surface; routes accept `?initialFilter=priority` for deep links. Empty-state copy points the user back to the book-detail toggle.
- **Year-goal stack (per-book, per-year):** `user_books.year_goal_year integer` (nullable, check 2000–2100, partial index on `(user_id, year_goal_year) where year_goal_year is not null`) lets readers earmark specific library books for the current calendar year's reading goal. Stored as an integer (not boolean) so the historical signal survives year rollover — a book stacked for 2026 stays marked as 2026 even after 2027 begins, and the home screen treats `year_goal_year !== currentYear` as "not currently stacked" without destroying the value. Mutations go through `setYearGoal()` in `lib/userBookActions.ts` (schema-tolerant: 42703/PGRST204 → friendly "migration not yet applied" error). Home (`app/(tabs)/index.tsx`) loads the stack via `loadYearStack(uid)` filtered to `status in ('reading','want_to_read')` (finished books already roll into `booksThisYear`) and renders a horizontal strip of faded covers (24×36, opacity 0.55 for want_to_read / 0.85 for reading, tight `gap: -6` overlap, max 8 visible + "+N more") flush below the yearly progress bar; tap any cover → book detail. A small italic caption beneath sums remaining pages (`page_count - current_page` for reading, full `page_count` for want_to_read). Toggle UI lives in `app/book/[id].tsx` as a sage chip-style row above the Reading Progress card, visible whenever `isReading || localStatus === 'want_to_read'` — disappears once finished/dnf so the chip is never stale. The book-detail user_books select cascades through 4 column-set fallbacks (year_goal_year + paused_at + edition_key → drop year_goal_year → drop paused_at → drop edition_key) so the screen still renders on stale Supabase projects missing any of these columns.
- **Rec quick-actions on book detail (saved-from-rec flow):** When the user opens a book from the For-You feed (`recCtx != null`) AND the book is not yet saved (`!userBookId`), `app/book/[id].tsx` renders a sage-tinted "What do you think?" card directly above "Why this book?" with four actions: **Want to Read**, **Add to <year> stack** (saves to want_to_read AND sets `year_goal_year = currentYear` in one call), **More like this**, **Not for me**. After the action commits the card collapses into a small confirmation row so the panel doesn't double-fire. The save path goes through `lib/saveBookFromRec.ts` (creates the books row by external_id if missing, then upserts user_books with the requested fields, schema-tolerant: 42703/PGRST204 → retries without `year_goal_year`). All four actions also fire `persistFeedback` (`saved` / `more_like_this` / `dismissed`) so future ranking learns from the action; `clearRecSession()` is called so the next home-tab focus reruns the pipeline. **Auto-add-on-more-like-this preference** lives in AsyncStorage at `readstack_mlt_autoadd_pref_v1` (`'always' | 'ask' | null`), managed via `lib/mltAutoaddPref.ts`. First MLT tap (pref=null) → modal asks once: "Yes always / Yes just this time (ask me each time) / No, just record more like this". Subsequent taps with pref='ask' → smaller per-tap confirmation modal. With pref='always', the silent path saves to Want-to-Read and records MLT feedback in one go. The MLT feedback event is recorded regardless of the save choice — declining the save only suppresses the want_to_read upsert.
- **Content-warning taxonomy (two-tier):** `lib/contentWarnings.ts` exports `deriveContentWarningsDetailed(subjects, description?) → ContentWarning[]` with `confidence: 'specific' | 'broad'` and an optional `parent` family. Subject matches → `specific`; description-only matches → `broad` (rendered with softer "may include" preface in book/[id]). Specific sub-labels (Sexual violence, War violence, Murder, Graphic violence, Domestic abuse, Self-harm, Suicide, Addiction, Grief, PTSD, Child abuse) suppress their broad parent when both match, so the UI never shows "Violence" alongside "Sexual violence". DB still stores labels as `string[]`; confidence is re-derived on read.

## Product
- **Book Discovery & Recommendations:** Personalized recommendations with a credibility system for recommenders.
- **Library Management:** Track reading status, rate books, and manage reading goals with a customizable gallery view.
- **Reading Progress Tracking:** Monitor reading streaks, pace, and projected finish dates.
- **Social Features:** Share recommendations, view friend activity, and import Goodreads data.
- **Edition Specificity:** Choose specific book editions for accurate tracking.
- **Barcode Scanning:** "Will I like this?" feature via barcode or ISBN input.
- **Personalized Insights:** "Reading Insights" screen with detailed statistics and year wraps.

## User preferences
_Populate as you build_

## Gotchas
- **Design Tokens:** Only use `SAGE_*` tokens for green colors; avoid reintroducing bright Tailwind-style greens.
- **Subject Matching:** Always use word-boundary regex (`\b...\b`) for subject and content warning matching, not `includes()`.
- **OAuth Race Condition:** The shared OAuth helper in `lib/socialAuth.ts` is critical to prevent "invalid grant" errors during social sign-in.
- **Forensic Debug Gate:** `FORENSIC_USER_ID` is `''` by default; set a specific UUID temporarily for local debugging but *never commit a real UUID*.
- **Edition Filter:** `fetchEditions()` requires `pageCount OR publisher` (not just `year`) for Open Library edition filtering.
- **Goodreads Import Deduplication:** Title+author dedup guard in `lib/goodreadsExecutor.ts` is crucial to prevent duplicate book rows.
- **Native Changes:** For native/plugin changes, always run `npm run build:android:dev` (or equivalent) instead of just reloading.

## Pointers
- **Supabase Docs:** [https://supabase.com/docs](https://supabase.com/docs)
- **Open Library API:** [https://openlibrary.org/developers/api](https://openlibrary.org/developers/api)
- **React Native Docs:** [https://reactnative.dev/docs](https://reactnative.dev/docs)
- **Expo Docs:** [https://docs.expo.dev/](https://docs.expo.dev/)
- **TypeScript Handbook:** [https://www.typescriptlang.org/docs/handbook/intro.html](https://www.typescriptlang.org/docs/handbook/intro.html)
- **Google Sign-In Configuration:** `docs/google-signin.md`
- **Device Testing Workflow:** `docs/dev-testing.md`