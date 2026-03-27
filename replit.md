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
- **UI/UX:**
    - **Color Scheme:** `#faf9f7` for background, `#1c1917` for headings, `#a8a29e` for muted text, and `#57534e` for secondary elements.
    - **CoverThumb Component:** Dynamically displays book covers, falling back to Open Library covers if a direct URL is unavailable.
    - **Defensive Fallbacks:** Critical queries include fallback patterns to ensure the app loads even if database migrations are not fully applied, preventing crashes due to missing columns.

## External Dependencies
- **Supabase:** Used for user authentication, PostgreSQL database, and Row Level Security.
- **Open Library API:** Primary source for book search functionality and metadata.
- **Google Books API:** Used for enriching book data with information like language, categories, and ratings.
- **AsyncStorage:** Used for persistent local caching of recommendation payloads.