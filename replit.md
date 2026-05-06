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
    (Need manual application via Supabase dashboard SQL editor.)

## Stack
- **Frameworks:** React Native, Expo Router
- **Runtime Versions:** Node.js (implicit via `package.json`), React Native (implicit via `package.json`), Expo (implicit via `package.json`)
- **ORM:** Supabase (PostgreSQL)
- **Validation:** TypeScript
- **Build Tool:** Expo

## Where things live
- `lib/tokens.ts`: Legacy design token source of truth (flat color constants — North palette). Still used by ~200 callsites; kept stable for backward compatibility.
- `lib/theme/themes.ts`: Theme registry (North/Atelier/Kiosk) — semantic tokens (`appBackground`, `surface`, `accent`, `accentAlt`, …) keyed by `ThemeId`. Single source of truth for selectable themes.
- `lib/theme/ThemeProvider.tsx`: App-wide theme context (`useAppTheme`, `useThemeColors`); persists choice to `AsyncStorage` key `readstack:theme:v1`. Non-blocking load, safe fallback to default.
- `components/ThemePickerCard.tsx`: Settings → Appearance picker UI (radio-card with mini palette + sample tile per theme).
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
- **Want-to-Read intent matching (deterministic, local):** `lib/intentMatcher.ts` parses queries like "short fantasy" or "fast paced" into AND-combined `IntentSignal`s (subjects via `matchesSubjects`, page bounds, free-text fallback). Runs on every keystroke — no model calls. `signalsRequireMetadata` powers an honest empty state that distinguishes "no matches" from "your saved books lack the metadata to answer this query yet".
- **Recommend-from-finished quick action:** `app/book/[id].tsx` shows a sage "Recommend to a friend" button inside the Your History card only when `localStatus === 'finished'`. Opens `RecommendBookSheet`, which reuses the existing `recommendations` table (no migration), inserts `status='sent'` + `activity_events` row of type `recommendation_sent` (recipient sees it via `RecsInboxSheet`). Pre-loads prior sends of this book to flag "Already recommended" per friend (RLS still blocks true duplicates if the user retries — surfaced as friendly error). Native `Share.share` fallback always available, even with zero friends. Intentionally deferred: DMs, friend discovery from this surface, deep links, push notifications.
- **Selectable visual themes (architecture-first):** `lib/theme/themes.ts` exposes a `Theme` shape (semantic `colors`, `typography`, `radius`, `shadow`) and a registry of three themes — `north` (default; mirrors current look), `atelier` (dark cognac), `kiosk` (newsstand brick + ochre, synthesized — no JSON shipped). `ThemeProvider` wraps the Stack in `app/_layout.tsx` and persists the user's choice via AsyncStorage (`readstack:theme:v1`); `useAppTheme()` / `useThemeColors()` are the consumption hooks. The Settings → Appearance section renders `ThemePickerCard` for switching. **Crucially, `lib/tokens.ts` is left intact** — the 200+ existing callsites still resolve to the North palette and switching themes only affects code that opts into `useAppTheme()`. Progressive migration of screens/components to semantic tokens is the path forward; do not bulk-rewrite tokens.ts. Custom font families are intentionally `undefined` in `ThemeTypography` (no `useFonts` / `expo-font` setup yet) — RN falls back to platform serif/sans; only `headingWeight` / `bodyWeight` differ per theme until fonts are bundled. Atelier sets `statusBarStyle: 'light'`.
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