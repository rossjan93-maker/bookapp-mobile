# Book Recommendation App

## Overview
The Book Recommendation App is a React Native mobile application designed to help users discover, track, and share book recommendations. It leverages the Open Library API for book data and Supabase for backend services. The core vision is to create a personalized reading experience, allowing users to send recommendations to friends, manage their reading library, and track reading progress. A unique feature is the "credibility" system, where recommenders gain credibility when their suggested books are finished. The project aims to foster a vibrant community around reading and personalized discovery.

## User Preferences
Not specified.

## System Architecture
The application is built with React Native using Expo Router for navigation and targeting web. Supabase provides the backend, handling authentication, PostgreSQL database management, and Row Level Security (RLS). TypeScript is used for type safety across the application.

**Key Features:**
- **Book Search & Recommendations:** Users can search for books via the Open Library API and send recommendations with personalized notes to friends.
- **Library Management:** Users can track the reading status of books (want_to_read, reading, finished, DNF) and rate books upon completion.
- **Activity Feed:** Displays friend activities such as sent, saved, started, or finished books.
- **Profile:** Users can set yearly reading goals, view their taste profile, see currently reading books, and track reading statistics.
- **Recommendation Engine:**
    - **Taste Profile:** A sophisticated system in `lib/tasteProfile.ts` computes a user's `TasteProfile` based on reading signals (finished books, ratings, taste tags, import history). It categorizes users into Tiers (0-3) based on signal strength and generates hypotheses for taste calibration.
    - **Recommendation Integrity Layer (RIL):** In `lib/recommendationIntegrity.ts`, this layer prevents surfacing later-volume series books out of order, collapses series floods, and labels series books to ensure a coherent recommendation experience.
    - **Center-of-Gravity Fit Classifier:** `lib/fitClassifier.ts` classifies book fit (core, adjacent, stretch, reject) based on multiple signals like author matches, dominant lanes, and market position, providing nuanced explanations for recommendations.
    - **Set Composition Engine:** In `lib/recommender.ts`, a 3-phase engine seeds recommendations by lane, fills with CORE books, and then ADJACENT books, applying continuation discounts and author/lane caps to ensure diverse and relevant sets.
    - **Expert Reasoning Layer:** `lib/expertRec.ts` implements a heuristic-based expert system that builds a `ReaderThesis` and `CandidateJudgment` to compose recommendation sets, structured for potential future LLM integration.
- **Onboarding System (5-phase):**
    - Phase 1 (Walkthrough): `components/OnboardingWalkthrough.tsx` — 4-step Modal overlay with spotlight highlighting each key tab. Fires on first visit to the `(tabs)` layout. Completion stored in AsyncStorage (`readstack_walkthrough_v1`).
    - Phase 2 (Signal collection): `app/onboarding.tsx` — curated grid of 16 popular books across genres; user selects ≥3 they've read, then rates each (Loved/Liked/Okay/Not for me → star ratings 5/4/3/2).
    - Phase 3 (Learning): Animated "Building your taste profile…" screen with pulsing dots and cycling messages; minimum 2.3s; concurrently saves rated books to Supabase and computes recommendation pipeline.
    - Phase 4 (Payoff): Shows 3–5 recommendations from the real `getCandidateBooks` + `getRankedRecs` pipeline with "Based on what you just told us" header and "Want to Read" action.
    - Phase 5 (Contextual tooltips): `components/OnboardingTooltip.tsx` — reusable wrapper component; first-use scan tip in `app/scan.tsx` shows above action buttons on first result.
    - State storage: `profiles.onboarding_completed` (Supabase; migration `20260327000001_onboarding.sql`) determines routing; walkthrough/tooltip state uses AsyncStorage keys.
    - Routing: `app/_layout.tsx` checks `onboarding_completed` after auth; new users → `/onboarding`; existing users → `/`. Defensive error fallback prevents blocking existing users before migration is applied.
- **Barcode Scan / "Will I like this?" Feature:**
    - Entry point: barcode icon button in the top-right of the Recommendations tab header.
    - Screen: `app/scan.tsx` — full scan + result screen (Expo Router stack route `/scan`).
    - On native: `expo-camera` `CameraView` scans EAN-13 / ISBN barcodes. On web: direct manual entry form.
    - Resolution pipeline: Google Books `isbn:` query (primary) + Open Library ISBN search (OL work key + subjects).
    - Manual fallback: title + author search via Google Books.
    - Fit evaluation: `lib/scanFitEval.ts` — reuses `scoreBookForUser`, `computeFitClass`, `computeCenterOfGravity`, `inferConsensusTraits` exactly as the recommendation engine does. Returns a `ScanFitResult` with verdict, 0–100 score, confidence, reasons, and caution.
    - Scan history: `lib/scanHistory.ts` persists every verdict to `scan_history` table (migration `20260327000000_scan_history.sql`).
    - Actions: "Want to Read" upserts to `books` + `user_books` + `persistFeedback('saved')`; "Not for me" and "More like this" persist feedback and update scan history.
    - Low-signal handling: honest low-confidence state shown for tier ≤ 1 users without suppressing the result.
- **UI/UX:**
    - **Color Scheme:** `#faf9f7` for background, `#1c1917` for headings, `#a8a29e` for muted text, and `#57534e` for secondary elements.
    - **CoverThumb Component:** Dynamically displays book covers, falling back to Open Library covers if a direct URL is unavailable.
    - **Defensive Fallbacks:** Critical queries include fallback patterns to ensure the app loads even if database migrations are not fully applied, preventing crashes due to missing columns.

## External Dependencies
- **Supabase:** Used for user authentication, PostgreSQL database, and Row Level Security.
- **Open Library API:** Primary source for book search functionality and metadata.
- **Google Books API:** Used for enriching book data with information like language, categories, and ratings.
- **AsyncStorage:** Used for persistent local caching of recommendation payloads.