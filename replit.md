# Book Recommendation App

React Native mobile app built with Expo Router + Supabase.

## Tech Stack
- **Framework:** React Native (Expo Router, web target)
- **Backend:** Supabase (auth, PostgreSQL, RLS)
- **Language:** TypeScript

## Core Flows
- Users search books (Open Library API), send recommendations with notes to friends
- Inbox (Notes tab): accept recommendations → adds to library
- Library tab: track reading status (want_to_read → reading → finished / dnf)
- Activity feed: events from friends (sent, saved, started, finished)
- Profile: yearly reading goal, taste profile, Currently Reading, stats
- Credibility: finishing a recommended book awards the recommender a credibility event

## Lifecycle
`recommendations` → `user_books` → `activity_events` → `credibility_events`

## Key Files
| File | Purpose |
|------|---------|
| `app/(tabs)/index.tsx` | Activity feed |
| `app/(tabs)/library.tsx` | Library: status management, sentiment feedback |
| `app/(tabs)/notes.tsx` | Inbox / recommendation list |
| `app/(tabs)/profile.tsx` | Profile: goals, stats, taste, currently reading |
| `app/book/[id].tsx` | Book detail: OL metadata, reading progress, pacing |
| `app/add-book.tsx` | Manual book-add flow |
| `app/edit-preferences.tsx` | Taste profile (genres, styles, authors) |
| `lib/pacing.ts` | Pacing helpers: date-based + page-based |
| `lib/signals.ts` | Derived signals foundation (completion rate, DNF rate, avg pages/day, rec conversion) |
| `components/CoverThumb.tsx` | Cover image with OL fallback |

## Database Schema Migrations (apply in order)
| File | Contents |
|------|---------|
| `20260311000000_mvp_foundation.sql` | Core tables: profiles, books, user_books, recommendations, credibility_events, activity_events |
| `20260311000001–20260311000005` | RLS policies |
| `20260313000000_reader_preferences.sql` | `reader_preferences` table; makes `books.external_id` nullable |
| `20260313000001_progress_and_pacing.sql` | Adds `page_count` to books; `current_page` + `progress_updated_at` to user_books |
| `20260313000002_reader_signals.sql` | Adds `reading_progress_events` table; `sentiment` + `source` columns on user_books |

## Defensive Fallbacks
Library, profile, and notes queries include try-with-fallback patterns — they attempt queries with new columns (page_count, current_page, source, sentiment) and silently fall back to column-safe queries if migrations haven't been applied yet. This means the app always loads.

## Key Design Notes
- `CoverThumb`: accepts `url` (DB cover_i URL) OR `externalId` for OL fallback (`/w/olid/{OLID}-M.jpg`)
- `books.external_id`: Nullable (manual books = null, OL books = `/works/OLxxxxW`)
- Progress bar null safety: always guard `progressPct ?? 0`
- Supabase join type casting: use `as unknown as MyType[]` to avoid TS false positives
- FK hints required for ambiguous joins (see scratchpad in conversation history)
- `useFocusEffect` imported from `expo-router`, `useCallback` from React

## Reader Signals Foundation (`lib/signals.ts`)
`computeReadingSignals(client, userId)` returns:
- `completionRate` — finished / (finished + dnf)
- `dnfRate` — dnf / (finished + dnf)
- `avgPagesPerDay` — derived from `reading_progress_events` timeline
- `recConversionRate` — recs received that became finished

Not yet surfaced in UI — data foundation only.

## Home Palette
`#faf9f7` bg · `#1c1917` headings · `#a8a29e` muted · `#57534e` secondary
