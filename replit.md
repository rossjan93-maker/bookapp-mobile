# Book Recommendation App

## Overview
The Book Recommendation App is a React Native mobile application designed to help users discover, track, and share book recommendations. It leverages the Open Library API for book data and Supabase for backend services. The core vision is to create a personalized reading experience, allowing users to send recommendations to friends, manage their reading library, and track reading progress. A unique feature is the "credibility" system, where recommenders gain credibility when their suggested books are finished. The project aims to foster a vibrant community around reading and personalized discovery.

## User Preferences
Not specified.

## System Architecture
The application is built with React Native using Expo Router for navigation and targeting web. Supabase provides the backend, handling authentication, PostgreSQL database management, and Row Level Security (RLS). TypeScript is used for type safety across the application.

**Key Features:**
- **Book Search & Recommendations:** Users can search for books via a **hybrid Google Books + Open Library** retrieval system and send recommendations to friends. The "Add to Library" search uses:
  - **Primary source: Google Books** (`EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY`). All user searches fire a Google Books `volumes` query first. GB has significantly better title-search accuracy than OL (e.g., "the lion women of tehran", "fourth win", "silent pati" all return the correct book at position #1).
  - **Secondary source: Open Library** (same multi-variant fan-out as before: up to 5 OL queries in parallel). OL fills in books not well-covered by GB and provides the canonical work keys used as `external_id` in Supabase.
  - **`hybridMerge`**: GB results first, then OL results that don't duplicate a GB book by normalized title+author. Result: GB books are preferred when scores are equal.
  - **Scoring**: `scoreAndFilterBooks` runs once on the merged pool. HIGH/MEDIUM/LOW tiers; HIGH only shown when HIGH exists; LOW never shown; MEDIUM suppressed for short incomplete last tokens.
  - **OL key resolution**: When a user selects a Google Books result, `resolveOLKeyFromIsbn` fires in parallel with the Supabase friends fetch — zero added latency. If OL key is found via ISBN, it replaces the `gb:${volumeId}` tentative key as `externalId` before `handleSend` is called.
  - **Quality gate**: queries with no token ≥ 4 chars show "Keep typing…" without firing any request.
  - **Alias expansion**: `lib/searchAliases.ts` (~50 fandom abbreviations) expands before retrieval; alias-expanded queries bypass the quality gate.
  - **Covers**: GB thumbnails (`https://` enforced) shown for GB results; OL covers as fallback.
  - Implemented in `lib/bookSearch.ts` (shared pipeline: `fetchGoogleBooks`, `resolveOLKeyFromIsbn`, `hybridMerge`, `_dedupKey`, `searchBooks`) and `lib/searchRanking.ts` (`scoreBookResult`, `scoreAndFilterBooks`, `mergeBookResults`).
  - **Both search surfaces** (`app/(tabs)/search.tsx` and `app/add-book.tsx`) use the same `lib/bookSearch.ts` pipeline. There is no separate OL-only search anywhere.
- **Library Management:** Users can track the reading status of books (want_to_read, reading, finished, DNF) and rate books upon completion.
- **Activity Feed:** Displays friend activities such as sent, saved, started, or finished books.
- **Profile:** Users can set yearly reading goals, view their taste profile, see currently reading books, and track reading statistics.
- **Recommendation Engine:**
    - **Taste Profile:** A sophisticated system in `lib/tasteProfile.ts` computes a user's `TasteProfile` based on reading signals (finished books, ratings, taste tags, import history). It categorizes users into Tiers (0-3) based on signal strength and generates hypotheses for taste calibration.
    - **Recommendation Integrity Layer (RIL):** In `lib/recommendationIntegrity.ts`, this layer prevents surfacing later-volume series books out of order, collapses series floods, and labels series books to ensure a coherent recommendation experience.
    - **Center-of-Gravity Fit Classifier:** `lib/fitClassifier.ts` classifies book fit (core, adjacent, stretch, reject) based on multiple signals like author matches, dominant lanes, and market position, providing nuanced explanations for recommendations.
    - **Set Composition Engine:** In `lib/recommender.ts`, a 3-phase engine seeds recommendations by lane, fills with CORE books, and then ADJACENT books, applying continuation discounts and author/lane caps to ensure diverse and relevant sets.
    - **Expert Reasoning Layer:** `lib/expertRec.ts` implements a heuristic-based expert system that builds a `ReaderThesis` and `CandidateJudgment` to compose recommendation sets, structured for potential future LLM integration.
- **Onboarding System (3-step, redesigned for minimum friction):**
    - Architecture: `app/onboarding.tsx` — 3 numbered intake screens + 1 unnumbered payoff. Shared `IntakeState` accumulated across steps. Each step is a self-contained function component. `lib/onboardingAnalytics.ts` fires structured events at every step/action.
    - Step 1/3 — Genres (`'genres'`): Header "What are you drawn to?" — 3-tab strip (Fiction / Nonfiction / Both) at top of same screen, genre chips below that update when tab changes. Fiction split embedded into this screen (not a separate step). Skippable.
    - Step 2/3 — Taste (`'taste'`): 4 binary choice questions (down from 6), one at a time with slide animation, auto-advancing. Kept the 4 highest-signal pairs: emotion_driven/idea_driven, pacing_non_negotiable/ideas_over_pacing, dark_tone/light_tone, literary_leaning/commercial_leaning. Removed originality/craft and challenge/effortless (lowest rec signal). Per-question skip + skip-all.
    - Step 3/3 — Anchor book (`'anchor_book'`): Optional single book search via Google Books (8 results, HTTPS enforced). Framed as "One book that nailed it?" — book saved as finished+5★ after completion. **Rec fetch starts immediately on entering this step** via `useEffect` — user's search interaction (~20-60s) serves as the loading buffer, replacing the passive walkthrough.
    - Payoff — `'payoff'` (no step number): "Here's your first stack" — 5 rec cards rendered directly, skeleton shimmers while loading. Inline contextual teaching strip: "Save what interests you · every action sharpens the next batch." Button: "Start exploring →". No "go to recs tab" redirect pattern.
    - **Removed:** `identity` step (goals/frequency/format — behavioral metadata, minimal rec impact), `avoid` step (negative genre friction), `walkthrough` step (4-panel product tour replaced by loading-as-buffer pattern). Step count: was 4+2 hidden = 6 total; now 3+payoff.
    - Signal persistence: taste answers → `reader_preferences.diagnosis_answers` (ANSWER_BOOSTS keys); `b_fiction_split` → behavioral metadata; genre selections → `favorite_genres`; anchor book → `user_books` as finished+5★. `avoid_genres` saved as `[]` (no avoid step).
    - **Finish later fix:** `handleFinishLater` now navigates immediately via `router.replace('/(tabs)/search')` without awaiting Supabase. Background fire-and-forget saves partial intake + sets `onboarding_completed: true` so user isn't re-routed on next open.
    - ANSWER_BOOSTS in `lib/tasteProfile.ts`: `dark_tone`, `light_tone`, `literary_leaning`, `commercial_leaning`, `emotion_driven`, `idea_driven`, `pacing_non_negotiable`, `ideas_over_pacing`. `applyDiagnosisBoosts` exported.
    - `lib/onboardingAnalytics.ts`: `obStart`, `obStepView`, `obStepComplete`, `obTasteAnswer`, `obTasteSkipped`, `obAnchorBook`, `obFinishLater`, `obComplete`, `obRecSaved` — all log with `[ONBOARDING]` prefix and ISO timestamps.
    - Routing: `app/_layout.tsx` checks `profiles.onboarding_completed` after auth; new users → `/onboarding`; existing users → `/`. Guided tour (GuidedActionBanner) triggers on first visit to recs tab after onboarding.
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

- **Account Lifecycle Layer:**
    - **User self-deletion:** `public.delete_own_account()` SECURITY DEFINER RPC. Fixed in `20260330000000_fix_deletion_and_reset.sql` — the original deletion order missed cross-user `activity_events` (actor_id ≠ deleted_uid) that referenced the user's recommendations, causing FK violation `activity_events_recommendation_id_fkey`. Fix: (1) both `activity_events.recommendation_id` and `credibility_events.recommendation_id` now have `ON DELETE CASCADE`; (2) function pre-deletes all activity/credibility events referencing the user's recommendations (by rec IDs) before deleting recommendations. Correct order: activity_events-by-rec → activity_events-by-actor → credibility_events-by-rec → credibility_events-by-user → recommendations → reader_preferences → user_books → friendships → profiles → auth.users.
    - **Dev/test reset functions** (added in `20260330000000_fix_deletion_and_reset.sql`): `reset_own_onboarding()` clears `onboarding_completed`, genres, diagnosis_answers, rec_feedback/cache — keeps library + account. `reset_own_data_cold()` additionally clears user_books, recommendations, and all activity. Both callable via `supabase.rpc()` from authenticated client. Settings screen has a `__DEV__`-gated Developer section with "Reset Onboarding State" and "Cold Start" buttons; both also clear relevant AsyncStorage keys (`readstack_guided_v1`, `readstack_rec_v1_*`, `readstack_rec_acted_v1_*`).
    - **Admin / dev reset:** Same migration defines `public.admin_reset_account(email, secret)` — callable only from the Supabase dashboard SQL Editor (granted to `service_role` only, not anon/authenticated). Secret stored server-side via `ALTER DATABASE postgres SET app.admin_reset_secret = '...'`. Performs the same full cascade delete by finding the user in `auth.users` by email. Usage: `SELECT public.admin_reset_account('test@example.com', 'your-secret');`
    - **Edge Functions (deployment-ready, not yet deployed):** `supabase/functions/delete-account/index.ts` and `supabase/functions/admin-reset-account/index.ts` implement the same logic as Deno functions for when the Supabase CLI is available. The SQL RPC is the active implementation.
    - **Signup / recovery UX:** `app/(auth)/login.tsx` redesigned with 4 modes: `signin`, `signup`, `forgot` (password reset), `resend` (confirmation email). After ambiguous signup (Supabase returns `user=null` due to anti-enumeration), shows a neutral recovery panel: "If this email is new, we sent a confirmation link. If you already have an account, sign in or reset your password." + 3 action buttons. Sign-in mode has "Forgot your password?" and "Didn't receive a confirmation email?" text links. Both forgot and resend show the same neutral confirmation message regardless of outcome (anti-enumeration). Uses `supabase.auth.resetPasswordForEmail()` and `supabase.auth.resend({ type: 'signup', ... })`.
    - **Delete Account UI:** `app/settings.tsx` Account section has a collapsed "Delete Account…" row. Expanding it shows warning text + TextInput requiring the user to type `DELETE` + Cancel/Confirm buttons. Confirm button only activates when input matches. Runs `delete_own_account()` RPC then `auth.signOut()`.

## External Dependencies
- **Supabase:** Used for user authentication, PostgreSQL database, and Row Level Security.
- **Open Library API:** Primary source for book search functionality and metadata.
- **Google Books API:** Used for enriching book data with information like language, categories, and ratings.
- **AsyncStorage:** Used for persistent local caching of recommendation payloads.

---

## Readstack Systems Contract v1

This is the operating contract for all product and engineering work. It governs all future changes. Read this before designing, patching, or reviewing any feature.

### 1. Core Product Principle

Readstack should feel like a calm, stateful reading app that already understands the user's world and updates quietly in response to their actions. The app should not expose its internal machinery. Users should not watch the system think.

### 2. Global Rules

**2.1 One capability, one implementation**

Any core capability must have one shared implementation, not multiple screen-local versions. This applies to: search, auth/account lifecycle, onboarding step logic, loading/placeholder system, book state mutation, recommendation action handling. If the same capability exists in two places, the default assumption is that it should be shared.

**2.2 Never replace meaningful content with a worse intermediate state**

Once a user has seen real content, the app must not replace it with a spinner, full-screen placeholder, partial teardown, or any visibly worse intermediate state.

Allowed: subtle background refresh, local section refresh indicators, a single stable commit when new content is ready.

Not allowed: loaded cards → skeletons, loaded tab → blank shell, visible content → multiple unstable recomputes.

**2.3 Stale but usable beats blank but "fresh"**

Continuity is more important than theoretical purity. A slightly stale but stable surface is better than a blank or jumpy one.

**2.4 Actions must have explicit semantics**

Every important action must answer: What does this do? What immediate feedback does the user get? What happens next? No overloaded labels. No ambiguous outcomes.

**2.5 The UI must not leak internal phases**

Users must not see multi-step recomputation, partial commits, structural churn, or state machine transitions. The app may do phased work internally. It should commit externally in calm, stable states.

### 3. Shared System Ownership

- **Search:** One shared pipeline across all search surfaces. No screen-specific search behavior unless explicitly documented.
- **Book state:** All status/date/delete/edit behavior through one shared mutation model with history, reversibility, soft delete, and explicit date rules.
- **Loading:** All major loading states use the shared placeholder system and follow the same behavioral rules.
- **Auth/account lifecycle:** Signup, sign-in, resend confirmation, reset password, delete account, and dev reset follow one coherent lifecycle model.

### 4. Loading and Refresh Contract

- **4.1 First cold load:** A screen may use a full placeholder only when no meaningful content has ever been shown in that session.
- **4.2 Warm revisit:** On revisit, the screen should render from cache/snapshot immediately if available.
- **4.3 Background refresh:** If content is already on screen — keep it visible, refresh quietly, commit once stable.
- **4.4 Placeholder design:** Loading UI must preserve final layout, avoid visible reflow, resemble final content, and feel calm and premium. Generic circular spinners are not the default on major surfaces.
- **4.5 No visible churn:** A section must not appear loaded, regress to a skeleton, then reappear differently.

### 5. Navigation Continuity Contract

- **5.1 Tabs should feel persistent:** Switching tabs should feel like moving inside one living app, not re-entering cold screens.
- **5.2 Back navigation preserves context:** Returning from Book Detail to Library or Recommend should preserve scroll position where reasonable, visible content where possible, and the user's sense of place.
- **5.3 Gesture behavior:** Horizontal swipe should be reliable where supported. Vertical scroll wins only when clearly intended.

### 6. Action Feedback Contract

- **6.1 Every primary action gets immediate local feedback:** Save → visible confirmation. More like this → distinct tuning confirmation. Dismiss → explicit dismissal/undo state. Delete → reversible state with clear outcome.
- **6.2 Feedback at the point of interaction:** Do not rely on disconnected global messages when a local, anchored confirmation is possible.
- **6.3 Failure must be legible:** If an optimistic action fails, the user must know, must have a retry or recovery path, and the app must not silently pretend success.

### 7. Search Contract

- **7.1 Accuracy-first:** Prefer correct result or no confident result. Never: confidently wrong result sets.
- **7.2 Retrieval before ranking:** If the right candidate is not in the pool, ranking cannot save it.
- **7.3 One shared pipeline:** All title search surfaces use the same shared engine — normalization, alias expansion, retrieval fan-out, merge/dedupe, scoring, confidence filtering.
- **7.4 Query behavior:** Weak/incomplete query → "keep typing" behavior. Strong query with no confident results → honest no-results state. No junk surfaced just to fill space.

### 8. Onboarding Contract

- **8.1 Teach through action:** The user learns by doing meaningful things, not by tapping through passive description.
- **8.2 Exit semantics must be unambiguous:**
  - "Finish later" exits onboarding now
  - "Skip question" advances only within onboarding
  - "Continue" advances with input
  - These meanings must never overlap.
- **8.3 Early payoff is mandatory:** The user must reach a plausible "this app might get me" moment quickly. No apologetic "warming up" dead zones.

### 9. Book-State and Data Integrity Contract

- **9.1 Truth over convenience:** Unknown dates remain unknown. Do not fabricate dates for yearly counts or timelines.
- **9.2 Status changes must preserve history:** Status edits must not silently overwrite trusted dates or state.
- **9.3 Delete is soft by default:** Removal from library preserves recovery and auditability unless a deliberate hard-delete path exists.
- **9.4 One source of mutation truth:** All book-state changes go through the shared mutation layer, not screen-local writes.

### 10. Surface Contracts

**Home** — Purpose: orient the user in their reading world. Must feel immediately informative and stable on revisit. Forbidden: full cold-looking reload on normal revisit, empty hero state with weak context.

**Recommend** — Purpose: help the user make fast, confident taste-shaping decisions. Must feel fluid, continuous, locally responsive, never structurally erased during refresh. Forbidden: visible deck teardown after content has been shown, gaps/holes after card action, ambiguous action meaning.

**Library** — Purpose: the user's source of truth for their books. Must feel stable, trustworthy, easy to correct. Forbidden: losing edits on return, full-screen reload on normal tab switch after prior load.

**Book Detail** — Purpose: focused truth and action surface for one book. Must feel immediately alive, complete even if enrichment lags, easy to act from. Forbidden: empty or unfinished feeling hero, late metadata causing large layout shifts.

**Onboarding** — Purpose: create belief and establish the first useful loop. Must feel short, clear, directional, never trapped. Forbidden: skip loops, passive explanation screens with no clear consequence.

**Auth** — Purpose: get in, recover access, or leave safely. Must feel clear, secure, standard. Forbidden: ambiguous duplicate-email behavior without recovery path, destructive account actions without clear confirmation.

### 11. Delivery Process for All Future Work

Every non-trivial change must follow this order:
1. Define the product contract
2. Define the specific surface contract
3. Identify the shared system owner
4. Trace the exact live runtime path
5. Patch the smallest correct layer
6. Validate the full user flow, including return path

No patching from screenshots alone when the live path is unclear.

### 12. QA Gate

Before calling a fix done, validate: fresh entry, warm revisit, action taken, return path, error path if relevant, cross-account/session behavior if cache is involved. Flow-level QA matters more than component-level QA.

### 13. Anti-Patterns (No Longer Allowed)

- Multiple implementations of the same core behavior
- Screen-local search logic
- Screen-local mutation logic
- Loaded content regressing to placeholders
- Overloaded action labels
- Hidden failure states
- Visible internal recomputation
- Fixing symptoms without tracing the live path first

### 14. Priority Lens for All Future Work

Evaluate in this order:
1. Does it increase trust?
2. Does it improve continuity?
3. Does it reduce user effort?
4. Does it preserve correctness without exposing machinery?

---

## P0 Performance Fixes (implemented March 2026)

### Fix 1 — Library pagination (`app/(tabs)/library.tsx`)
- `loadBooks()` now fetches first 50 books in Phase 1 (`.range(0, 49)`), paints immediately (< 2s), then silently appends the remainder in a background IIFE (Phase 2: `.range(50, 99999)`).
- `_libLoading` guard is released after Phase 1. Phase 2 uses a `capturedFirst` reference equality guard to abort if a concurrent `loadBooks` call (e.g. pull-to-refresh) has replaced `_libItems`.
- Goodreads flag + cover backfill + metadata repair run in Phase 2 on the full dataset.
- Primary query: includes `current_page`/`page_count`. Fallback query: older schema without those columns. Both used in Phase 1 and Phase 2.
- Target: 16-38 s blank screen → < 2 s first paint regardless of library size.

### Fix 2 — Synchronous volatile rec restore (`lib/recSession.ts`, `app/(tabs)/search.tsx`, `app/(tabs)/_layout.tsx`)
- `RecSessionCache` type and `_recSession` module-level variable moved from `search.tsx` to new `lib/recSession.ts` with `getRecSession()`, `setRecSession()`, `clearRecSession()` exports.
- `app/(tabs)/_layout.tsx` (tab layout) pre-warms `_recSession` from AsyncStorage on mount via a `prewarmRecs()` effect. This runs while the user is on the Home screen, so by the time they tap Recommend, `getRecSession()` returns the cached payload synchronously.
- `useState(() => !getRecSession())` in `search.tsx` initializes `recsLoading=false` when the session is already hot, eliminating the blank window on cold start.
- User-safety: keyed by `userId`, second guard check before `setRecSession` prevents overwriting a session filled by another path. Sign-out clears via `registerCacheClearer`.

### Fix 3 — Google Books fields projection (`lib/bookSearch.ts`, `lib/googleBooks.ts`)
- All Google Books API calls now include a `fields=` query parameter limiting the response to only needed fields (title, authors, imageLinks, industryIdentifiers, pageCount, description where applicable).
- `fetchGoogleBooks` (bookSearch.ts): `fields=items(id,volumeInfo(title,authors,imageLinks,industryIdentifiers,pageCount))`, `maxResults` reduced from 20 → 10.
- `fetchGoogleBooksPageCount` (googleBooks.ts): `fields=items(volumeInfo(title,pageCount))`, `maxResults` reduced from 5 → 3.
- `fetchGoogleBooksCoverUrl` (googleBooks.ts): `fields=items(volumeInfo(title,imageLinks))`, `maxResults` stays at 3.
- `fetchGoogleBooksMetadata` (googleBooks.ts): `fields=items(volumeInfo(title,imageLinks,description,pageCount))`, `maxResults` reduced from 5 → 3.
- Target: 60-80% payload reduction per API call.

### P0.5 — Library Phase 2 stability (`app/(tabs)/library.tsx`)
- `_libPhase1Ids: Set<string>` stamps the IDs rendered in Phase 1.
- `displayedItems` partitions into `p1` (sorted normally) and `p2` (sorted within itself, appended below each status group). Phase 2 items can never appear above Phase 1 items mid-session.
- Boundary is cleared on `loadBooks()` start and on sign-out. Full resort resumes on next pull-to-refresh or cold load.
- Root cause of duplicate-key error: PostgreSQL non-deterministic offset pagination when multiple rows share the same `created_at` (Goodreads batch imports). Fixed by:
  - Adding `id` as a tiebreaker sort column on all four queries (Phase 1 primary, Phase 1 fallback, Phase 2 primary, Phase 2 fallback), making `OFFSET` pagination fully deterministic.
  - Deduplicating `remainder` against `firstBatch` via a `Set` as a safety net.

### Profile tab two-phase load (`app/(tabs)/profile.tsx`)
- **Problem**: 21 parallel Supabase queries held the entire profile page behind the slowest query (~800–1200ms). No skeleton — page "popped in" fully formed.
- **Fix**: Split into Phase 1 (6 fast queries: profile row + 5 COUNT heads) and Phase 2 (15 row fetches + signal/pattern counts). `setLoading(false)` fires after Phase 1 (~400–600ms), making the header + stats + goal bar visible immediately. Phase 2 runs right after and populates friends list, sent recs, prefs, and signals silently.
- **State changes**: `pendingRequests`, `sentRecs`, `acceptedFriends`, `booksThisYear` initialized as `null` (not `[]`) so sections stay hidden while Phase 2 is in flight — prevents premature "No friends yet" / "No recommendations sent yet" flash.
- **Render guards**: friends section renders nothing when `null`; sent recs renders nothing when `null`; pending requests section only renders when non-null AND length > 0; goal expansion shows "Loading…" when `booksThisYear` is null.
- **Revisit behavior unchanged**: tabs are not unmounted in Expo Router so component state (including Phase 2 data) persists across tab switches. Staleness guard (60s) prevents re-fetching Phase 1 on quick revisits. Sign-out registered via `registerCacheClearer`.

### Recommendations "For You" silent empty state (`app/(tabs)/search.tsx`)
- **Root cause**: pipeline returns N recs (quality_gate=passed), but `filterActedOn` removes all of them (user has already dismissed/saved every book in the batch). UI state becomes: `recs=0, recsQualityGate=null, hasRecs=false`. The generic "caught up" card is gated by `!hasAnyTask`, so if any rating/tagging tasks exist the entire For You section renders blank without explanation.
- **Secondary issue**: the exhaustion-triggered replenishment effect (`continuations.length <= 1`) never re-fires on tab revisits because continuations starts at 0 from initial state — no state change, no effect. `tasteProfile` may also still be null when the effect first runs on cold load, silently skipping `reloadRecs`.
- **Fix — `recsExhausted` state**: added to `search.tsx`. Set to `true` in all three filterActedOn commit paths (cache_restore, background_refresh, reload_recs) when `after_count=0 AND before_count>0 AND quality_gate=passed`. Cleared to `false` when any path returns non-zero filtered results.
- **Fix — exhaustion-triggered replenishment effect (bounded retry)**: `useEffect([recsExhausted, tasteProfile?.tier, isBackgroundRefreshing])` calls `reloadRecs` with `{ exhaustionBypass: true }` when `recsExhausted=true`. Bounded by `exhaustionAttemptRef` (max 1 attempt per exhaustion cycle). If the bypass reload also yields zero, logs `[REC_EXHAUSTED_TERMINAL]` and stops — no loop.
- **Fix — upstream exhaustion bypass** (`lib/recommender.ts` + `search.tsx`): When `exhaustionBypass=true`, `reloadRecs` passes `new Set(_actedOnIds)` as `additionalExcludeIds` to `getPersonalizedRecsWithExpert` → `getCandidateBooks` → `getCachedExternalCandidates`. Acted-on books are excluded from all three candidate sources (local catalog, rec_candidate_cache, OL session) before ranking — not just post-filter. Also calls `clearOLSessionCache()` to force a fresh OL fetch. `exhaustionAttemptRef` resets to 0 on any successful commit with `_rrTotal > 0`.
- **Fix — render**: Two explicit states in the For You section, never suppressed by `hasAnyTask`:
  1. `recsExhausted && !hasRecs && (isBackgroundRefreshing || recsLoading)` → "Finding your next picks…" spinner card.
  2. `recsExhausted && !hasRecs && !isBackgroundRefreshing && !recsLoading` → "You're all caught up" card with "Rate a book" CTA.
- **Fix — original caught-up guard**: `!recsExhausted` added to the pre-existing `!hasRecs && !recsQualityGate && !recsLoading && !hasAnyTask && !deckTransitionHint` condition to prevent double-rendering.

### Book Detail enrichment latency (`app/book/[id].tsx`)
Two changes to reduce perceived metadata latency:
1. **Fast-path before `searchOLWork`**: if all four fields (cover, description, subjects, page_count) are already in the DB, cache + return before any network calls. Previously this short-circuit fired AFTER `searchOLWork` had already run.
2. **Early skeleton clear**: if the DB has any of description, subjects, or page_count, apply them to `setOlMeta` and call `setMetaLoading(false)` immediately after the DB fetch (one round-trip, ~300ms). OL/GB then run in the background and patch any remaining gaps as silent in-place updates. Previously the skeleton was held until the end of the full OL+GB chain (~1.5–2.5s).