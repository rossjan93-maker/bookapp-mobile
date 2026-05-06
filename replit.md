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
- `app.json`: Expo configuration, including camera plugin.

## Architecture decisions
- **Hybrid Book Data Retrieval:** Combines Open Library and Google Books API for comprehensive and enriched book metadata.
- **Supabase as BaaS:** Leverages Supabase for authentication, PostgreSQL database, and Row Level Security, simplifying backend development.
- **Edition Awareness:** Allows users to select specific book editions, dynamically updating cover and page count for accurate reading progress, while preserving `current_page`.
- **Three-Pass Subject Enrichment:** Uses Open Library, Google Books, and LLM inference to maximize subject coverage for books, ensuring rich discoverability.
- **Reading Progress Reset Logic:** Implements "reset-to-0 = start over" rule for reading sessions, ensuring stats like monthly pages and streaks accurately reflect current reading efforts.

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