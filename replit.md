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