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

## Pending Migrations (need manual apply via Supabase dashboard SQL editor)
- `supabase/migrations/20260413000001_rec_snapshots.sql` — creates `rec_snapshots (user_id, external_id)` PK table storing only rendered explanation + evidence_tags[]. RLS: users manage own rows. Written fire-and-forget on RecCard tap; read by book detail as fallback when session cache is empty.
- `supabase/migrations/20260414000000_user_books_edition_key.sql` — adds `edition_key text` column to `user_books`. Nullable; stores the Open Library edition ID (e.g. "OL12345M") the user has explicitly chosen for their copy. When set, the book detail screen uses this edition's cover and page count instead of the canonical books row values.

## External Dependencies
- **Supabase:** User authentication, PostgreSQL database, Row Level Security.
- **Open Library API:** Primary source for book search and metadata.
- **Google Books API:** Enriches book data with details like language, categories, and ratings.
- **AsyncStorage:** Persistent local caching of recommendation payloads.