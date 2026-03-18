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
| `app/(tabs)/library.tsx` | Library: status management, 1–5 rating prompt on finish/DNF |
| `app/(tabs)/notes.tsx` | Inbox / recommendation list |
| `app/(tabs)/profile.tsx` | Profile: goals, stats, taste, currently reading |
| `app/book/[id].tsx` | Book detail: OL metadata, reading progress, pacing, Your History with discreet Edit modal (rating + note), taste-fit gating |
| `app/add-book.tsx` | Manual book-add flow |
| `app/settings.tsx` | Settings hub: name, yearly goal, taste, sign out |
| `app/edit-preferences.tsx` | Taste profile (genres, styles, authors) |
| `lib/displayName.ts` | Display name helper: getDisplayName, getFirstName, getInitial |
| `lib/pacing.ts` | Pacing helpers: date-based + page-based |
| `lib/signals.ts` | Derived signals foundation (completion rate, DNF rate, avg pages/day, rec conversion, rating signals) |
| `lib/tasteProfile.ts` | Recommendation confidence model: tier 0–3, trait/genre affinity scoring, diagnosis answer boosts, hypothesis generation; `buildLikedAnchors()` computes `liked_subjects` (top 8, min freq=2 for dense Goodreads users ≥20 books) and `liked_authors` (up to 5); `GENERIC_OL_SUBJECTS` + `CLASSIC_ANCHOR_NOISE` sets filter noisy/broad anchors; subjects >4 words skipped |
| `lib/bookTraits.ts` | Book trait extraction: `BookForm` type (poetry/short_stories/play/graphic/anthology), `detectBookForm()`, `FORM_TRAIT_BLACKLIST` (e.g. poetry can't receive Characters/Ending/Pacing traits), `FORM_TRAIT_BASE` overrides, `assessMetadataQuality()` returning strong/moderate/weak |
| `lib/recommender.ts` | Full recommendation engine — multi-anchor OL retrieval, `applyHygiene(candidates, enrichmentMap, liked_authors)` (children's, PD authors, non-English, weak metadata — liked authors exempt from PD filter), `scoreBookForUser()` (6 steps: trait alignment capped at STEP1_CAP=0.38, each trait ≤ TRAIT_CONTRIB_CAP=0.14, bookWeight≥0.55 gate, metadata/classic-drift penalty in step 6), `ScoreBreakdown` (trait_alignment, avoided_penalty, genre_bonus, feedback_boost, enrichment_bonus, metadata_penalty, raw_score, final_score, book_form, audit_flags), `PD_AUTHORS` (~80 entries incl. philosophers), `getRankedRecs()`, `getCandidateBooks()` returning `CandidateResult {candidates, enrichmentMap, retrieval_trace}` |
| `lib/recFeedback.ts` | Recommendation feedback helpers: `persistFeedback()`, `loadFeedbackContext()`, `FeedbackContext` — dismissed exclusion + `genreBoosts` in scoring step 4 |
| `lib/bookEnrichment.ts` | Book enrichment layer: `BookEnrichmentProfile` type (consensus_traits, popularity_signals, audience_signals), `inferConsensusTraits()` (keyword mapping from subjects + GB categories + description), `fetchGBEnrichmentData()` (Google Books — language, categories, rating), `loadEnrichmentBatch()` / `persistEnrichmentBatch()` DB cache ops, `getEnrichmentForCandidates()` (cache-first batch fetch) |
| `app/import/diagnosis.tsx` | Imported-user diagnosis flow: auto-generated taste hypotheses + 5 adaptive tradeoff questions |
| `components/CoverThumb.tsx` | Cover image with OL fallback |

## Database Schema Migrations (apply in order)
| File | Contents |
|------|---------|
| `20260311000000_mvp_foundation.sql` | Core tables: profiles, books, user_books, recommendations, credibility_events, activity_events |
| `20260311000001–20260311000005` | RLS policies |
| `20260313000000_reader_preferences.sql` | `reader_preferences` table; makes `books.external_id` nullable |
| `20260313000001_progress_and_pacing.sql` | Adds `page_count` to books; `current_page` + `progress_updated_at` to user_books |
| `20260313000002_reader_signals.sql` | Adds `reading_progress_events` table; `sentiment` + `source` columns on user_books |
| `20260313000003_source_attribution_backfill.sql` | Backfills `source = 'recommendation'` for historical rows via `recommendations.user_book_id` join |
| `20260314000001_profiles_name_fields.sql` | Adds optional `first_name` and `last_name` to profiles |
| `20260314000002_rating_and_feed_event.sql` | Adds `rating integer` to `user_books` and `activity_events`; adds `book_rated` enum value |
| `20260315000000_activity_events_update_policy.sql` | Adds RLS UPDATE policy on `activity_events` so actors can update their own rows (required for finish+rating merge) |
| `20260315000001_goodreads_import_foundation.sql` | Goodreads import schema: import_batches, import_rows, book_source_links, book metadata columns |
| `20260315000002_books_subjects_column.sql` | Adds `subjects text[]` to books for OL subject persistence |
| `20260315000003_goodreads_import_foundation_repair.sql` | Repairs import schema; adds `review_body`, `private_note`, `rating` on import_rows |
| `20260315000004_books_description.sql` | Adds `description text` to books |
| `20260318000000_user_books_taste_tags.sql` | Adds `taste_tags jsonb` to user_books for structured post-finish taste signals |
| `20260318000001_reader_preferences_diagnosis.sql` | Adds `diagnosis_answers jsonb` to reader_preferences for taste-calibration question persistence |
| `20260318000002_rec_candidate_cache.sql` | `rec_candidate_cache` table — per-user cache of externally-retrieved OL recommendation candidates with RLS; 24h TTL; upsert on `(user_id, external_id)` |
| `20260318000003_rec_feedback.sql` | `rec_feedback` table — records Save/Dismiss/MoreLikeThis feedback per `(user_id, book_id)` with RLS; drives dismissed exclusion and genre boost signals in scoring |
| `20260318000004_book_enrichment_cache.sql` | `book_enrichment_cache` table — per-book enrichment profiles (consensus_traits, popularity_signals, language, audience_signals) shared across users; 7-day TTL; upsert on `external_id`; RLS read/write for authenticated users |

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

## Recommendation Confidence System (`lib/tasteProfile.ts`)
`computeTasteProfile(client, userId)` returns a `TasteProfile`:
- **Tier 0** (<5 strong signals): "We're learning your taste"
- **Tier 1** (5–9): "Early read on your taste"
- **Tier 2** (10+): "Personalized for you"
- **Tier 3** (10+ with import + enrichment): "High-confidence recommendations"
- **Strong signal** = finished book with any of: rating, taste_tags, review_body, or source='goodreads'
- `preferred_traits` / `avoided_traits` — scored 0–1 from aggregated taste_tags
- `open_questions` — unresolved questions about the user's taste
- `generateHypotheses(profile)` — generates 3–5 taste hypotheses for diagnosis flow
- `DIAGNOSIS_QUESTIONS` — 5 fixed tradeoff-based adaptive questions

**Learning mode card** appears on Home tab (tier ≤ 1) with signal progress bar and 3 CTAs:
rate a book / add taste tags / import history (or "analyse imports" if already imported).

**Diagnosis flow** (`/import/diagnosis`): hypotheses screen → 5 questions → done screen.
Accessible from learning mode card "Analyse my imports" action. No DB writes (scaffold stage — answers are in-memory).

## Home Palette
`#faf9f7` bg · `#1c1917` headings · `#a8a29e` muted · `#57534e` secondary
