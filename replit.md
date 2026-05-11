# Book Recommendation App

Readstack helps users discover, track, and share personalized book recommendations.

## Run & Operate
- `npm run dev:device` — JS-only changes on device.
- `npm run build:android:dev` / `build:ios:beta` — native build.
- **Required env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OPEN_LIBRARY_API_KEY`, `GOOGLE_BOOKS_API_KEY`. Optional: `LLM_MODEL` (for `inferSubjectsLLM.ts`).
- **Migrations** live in `supabase/migrations/`. Latest applied: `20260512000000_p1_5b_1_verification_reconciler.sql` (reconciler deployed + scheduled). Apply newer files in that folder via the Supabase dashboard SQL editor in filename order.

## Stack
React Native + Expo Router, Supabase (Postgres + Auth + RLS), TypeScript, Expo build.

## Current focus — first-session value loop (V1-V4 batches)
The active workstream is making the first 5 minutes show the user what Readstack is for and that it's learning. **Hard constraints for every batch in this stream: no LLM, no recommender / scoring / retrieval changes, no DB tables / migrations, no auth, no Sentry, no native config, no Open Library / Google Books / metadata-repair touches.** Pure UI/copy on top of existing handlers and existing TasteProfile data.
- **V1A Taste Readout** — shipped 2026-05-11 (see architecture bullet).
- **V2 Visible Learning Toasts** — shipped 2026-05-11 (see architecture bullet).
- **V3 Anchored explanations** — shipped 2026-05-11 (see architecture bullet).
- **V4 Home shortlist** — shipped 2026-05-11 (see architecture bullet).

### Parked / explicitly deferred
- **Sentry / analytics instrumentation:** out of scope for V1-V4 by user direction. Do not add until that constraint is lifted.
- **B3 Goodreads import-success routing polish:** parked; current routing is acceptable.
- **MLT auto-add settings UI:** the AsyncStorage pref (`lib/mltAutoaddPref.ts`) exists, but a settings-screen toggle is not built — parked.

## Where things live
- `lib/tokens.ts` — color palette / design tokens.
- `lib/screenLayout.ts` — `useScreenTopPadding()` (`insets.top + 16`); single source of truth for top-of-screen padding on `headerShown:false` routes.
- `lib/shelves.ts` — smart-shelf filtering (`matchesSubjects`).
- `lib/customShelves.ts` — `user_shelves` / `user_shelf_books` CRUD.
- `lib/contentWarnings.ts` — content-warning matching + two-tier confidence.
- `lib/metadataProvider.ts` — canonical book metadata + cover selection.
- `lib/metadataRepair.ts` — Open Library → Google Books repair.
- `lib/openLibrary.ts` — Open Library API + author bibliography.
- `lib/recommender.ts` — recommender (contains `FORENSIC_USER_ID`).
- `lib/nextReadIntent.ts` — soft-boost / mood-boost weights for the For-You feed.
- `lib/intentMatcher.ts` — Want-to-Read intent parser (`parseIntent` / `matchBookToIntent`).
- `lib/sessionSegment.ts` — reset-aware session segmentation.
- `lib/pacing.ts` — reading pacing.
- `lib/readingWraps.ts` — monthly / yearly wrap aggregation.
- `lib/socialAuth.ts` — shared OAuth helper.
- `lib/friendshipActions.ts` — `sendFriendRequest()` (RPC wrapper) + `deleteFriendship()`.
- `lib/goodreadsExecutor.ts` — Goodreads import + dedup.
- `lib/userBookActions.ts` — `setYearGoal()` and other user_books mutations.
- `lib/saveBookFromRec.ts` — save-from-rec path (creates books row by external_id, upserts user_books).
- `lib/seededPicks.ts` — hardcoded 6-book starter strip (verified rows only) shown to zero-library / zero-signal users on the For-You tab.
- `lib/tasteReadoutCopy.ts` — pure copy assembly for the post-intake "Here's what we heard" surface (humanizers, hedged summary/chip builders, thin-state detection). Also owns `humanizeGenreKey` reused by V2 learning toasts. No IO.
- `lib/mltAutoaddPref.ts` — AsyncStorage pref for "more like this" auto-add.
- `lib/subjectVocabulary.ts` — curated subject vocab for LLM inference.
- `app/_layout.tsx` — root Stack (`headerShown:false`), bootstrap context, onboarding bridge.
- `app/book/[id].tsx` — book detail (rating UI, paused toggle, year-stack toggle, recommend-to-friend, rec quick-actions card).
- `app/(tabs)/index.tsx` — home (yearly progress bar, year-stack strip, streak flame).
- `app/(tabs)/library.tsx` — library w/ smart + custom shelves, Priority filter chip.
- `app/(tabs)/search.tsx` — Discover/For-You tab.
- `app/stats/index.tsx` — Reading Insights.
- `app/onboarding.tsx`, `app/onboarding-import.tsx`, `app/onboarding-questions.tsx` — onboarding flow.
- `app/taste-readout.tsx` — post-intake "Here's what we heard" route. Reached from quick-intake completion and Goodreads import success "Go to Discover"; CTA `router.replace`s into `/(tabs)/search`. The import-success "Go to Library" path is unchanged.
- `app/legal.tsx` — Help & Legal screen (placeholder URLs marked `TODO(beta-launch)`).
- `components/CoverThumb.tsx` — every cover surface (3D treatment, `flat` opt-out).
- `components/HalfStarRating.tsx` — `HalfStarRating`, `StarDisplay`, `ratingToSentiment`, `formatRating`.
- `components/RecCard.tsx` — for-you card + rationale variant pools + `UndoToast` + `LearningToast` (V2).
- `components/RecommendationsFeed.tsx` — for-you feed + intent chips (`handleApplyIntent`) + V2 toast wiring.
- `components/RecommendBookSheet.tsx` — recommend-finished-to-friend sheet.
- `components/TasteReadout.tsx` — pure presentational "Here's what we heard" view.
- `components/HomeShortlist.tsx` — V4 top-of-Home next-read surface; read-only consumer of `getRecSession()` + `loadActedOnIds()`.
- `components/ShelfRow.tsx` / `ShelfPickerSheet.tsx` — shelf chips + add-to-shelf bottom sheet.
- `components/LibraryGalleryView.tsx` — library gallery view.
- `scripts/repairSubjectCoverage.ts`, `scripts/inferSubjectsLLM.ts`, `scripts/backfillSessionCorrections.ts`, `scripts/deduplicateBooks.ts` — maintenance scripts.
- `app.json` — Expo config (camera plugin + explicit iOS `NSCameraUsageDescription`).
- `docs/google-signin.md`, `docs/dev-testing.md`, `docs/ios-testflight-checklist.md`, `docs/catalog_subsystem.md`.

## Architecture decisions

### Foundation
- **Hybrid metadata:** Open Library + Google Books, three-pass subject enrichment (OL → GBooks → LLM).
- **Supabase as BaaS:** Auth + Postgres + RLS.
- **Edition awareness:** users pick a specific edition; cover + page count update, `current_page` is preserved.
- **Reset-to-0 = start over:** session segmentation in `lib/sessionSegment.ts` keeps streak / monthly-pages honest.
- **Single sage system:** all greens via `SAGE`, `SAGE_BG`, `SAGE_DEEP`, `SAGE_INK` in `lib/tokens.ts`. Never hand-roll greens.
- **Top-of-screen padding centralized:** every full-screen route applies `useScreenTopPadding()`.
- **Cover 3D treatment:** every cover renders through `components/CoverThumb.tsx`; pass `flat` when the parent supplies elevation.
- **Catalog subsystem (write protection, provenance, reconciler, cross-user filtering):** see `docs/catalog_subsystem.md` (P0 / P0.5 / P1.5a / P1.5b-1 / P1.5b-1.1 / P1.5b-2 / P1.5b-3 + backlog). Companion docs: `docs/p1_5b_1_reconciler_runbook.md`, `docs/p1_5b_2_surface_audit.md`, `docs/p1_5b_3_dedup_audit.md`. Read before touching `books` writes, the verification reconciler, or any cross-user catalog surface.
- **Content-warning taxonomy (two-tier):** `deriveContentWarningsDetailed(subjects, description?) → ContentWarning[]` with `confidence: 'specific' | 'broad'` and optional `parent`. Subject matches → specific; description-only → broad ("may include" preface). Specific sub-labels suppress their broad parent. DB stores `string[]`; confidence is re-derived on read.

### Library / status / progress
- **Explicit paused state:** `user_books.paused_at` overrides the inactivity heuristic in `inferReadState`. `transitionStatus` always clears it.
- **Half-star ratings:** `user_books.rating` and `activity_events.rating` are `numeric(3,1)` constrained to `{0.5,1,…,5}`. All rating UI uses `HalfStarRating`; sentiment thresholds in `ratingToSentiment` (≥4.5 loved / ≥3.5 liked / ≥2.5 okay / else not_for_me).
- **Custom shelves alongside smart shelves:** `user_shelves` (unique by `lower(name)`) + `user_shelf_books` (CASCADE on shelf delete only — books survive). Mutations route through `lib/customShelves.ts`.
- **Year-goal stack (per book, per year):** `user_books.year_goal_year` is a nullable integer (check 2000–2100, partial index where not null) so the historical signal survives year rollover. Mutations: `setYearGoal()` in `lib/userBookActions.ts` (schema-tolerant: 42703/PGRST204 → friendly error). Home strip on `app/(tabs)/index.tsx` loads via `loadYearStack(uid)` filtered to `status in ('reading','want_to_read')`. **Reading is implicit** — three places enforce this together: (1) the book-detail toggle only renders when `localStatus === 'want_to_read'`; (2) `loadYearStack` selects `or('status.eq.reading,and(status.eq.want_to_read,year_goal_year.eq.${y})')`; (3) library Priority filter treats `status === 'reading'` as priority too. Book-detail user_books select cascades through 4 column-set fallbacks so the screen renders on stale Supabase projects.
- **Priority filter chip:** `app/(tabs)/library.tsx` exposes `'priority'` second (after `All`). Finished books are intentionally retained in this view (vs. the home strip which excludes them). Routes accept `?initialFilter=priority`.
- **Reading-progress motion (home):** yearly-goal bar (`progressAnim`) eases 0 → live pct on mount and on goal change; streak flame (`flameAnim`) loops a subtle scale pulse only when `streakValue > 0`. Both refs near the top of `app/(tabs)/index.tsx` — keep timing/easing in sync.

### For-You feed / recommendations
- **For-You intent chips → hard rules + soft boosts:** `handleApplyIntent` in `RecommendationsFeed.tsx` derives `hard` filters and `exclude` rules in addition to `soft` prefs. Soft / mood boosts use `0.12` per signal capped at `±0.30`. Mapping: `tone='light' | intensity='low' | mood∈{light_fun,palate_cleanser}` → `exclude.avoid_dark`; `mood='light_fun'` → `exclude.avoid_literary`; `mood='palate_cleanser'` → `hard.max_page_count=400` (intentionally NOT `standalone_only` — would empty series-heavy libraries). `tone='dark'` always wins over avoid_dark.
- **Want-to-Read intent matching:** `lib/intentMatcher.ts` parses queries like "short fantasy" into AND-combined `IntentSignal`s. Runs locally on every keystroke; `signalsRequireMetadata` powers an honest empty state.
- **Recommendation rationale variants:** `RecCard.tsx` builds explanations from variant pools (4 phrasings each for aligns/appreciation/reader-trait/subject/lane-fallback/theme-tail; 3 for author-loyalty). FNV-1a hash of `book.id + pattern-tag` deterministically picks one. Banned phrasings (`"you gravitate toward"`, `"because you liked"`) absent from every pool.
- **Rec quick-actions card (saved-from-rec):** when `recCtx != null && !userBookId`, `app/book/[id].tsx` shows a sage card above "Why this book?" with Want to Read / Add to {year} stack / More like this / Not for me. Save path is `lib/saveBookFromRec.ts`. Every action also fires `persistFeedback`. The MLT-auto-add preference (`'always' | 'ask' | null`) lives in AsyncStorage via `lib/mltAutoaddPref.ts`; first MLT tap asks once.
- **Recommend-from-finished:** sage button in book detail Your-History card when `localStatus === 'finished'`. Reuses the existing `recommendations` table; inserts `status='sent'` + `activity_events` row. Native `Share.share` fallback always available.
- **Cold-start seeded strip is non-personalized by contract:** `lib/seededPicks.ts` is a hardcoded array (no network fetch) shown only when the For-You tier-`<1` branch sees `librarySize === 0`. Strip header always reads "POPULAR STARTING POINTS · Not personalized yet". Three invariants for any future seed entry: (a) `provenance_state='verified'` in production catalog, (b) canonical `/works/OL…W` `external_id`, (c) baked-in `id`/`title`/`author`/`cover_url`/`page_count`. Tap routes through standard `/book/[id]` and never calls `persistFeedback`. Strip never appears for users with even one `user_books` row. P2: re-validate the 6 seed external_ids quarterly.

### Author / bibliography
- **Author bibliography (OL-catalog-only, de-bundled):** `fetchAuthorBibliography` resolves the name to a canonical OL author key via `search/authors.json` then queries `search.json?author_key=…` (the old `?author=…` query was fuzzy — Lucy Foley returned 1940s/1970s books by other Foleys); a strict `author_name` normalized-equality guard runs as backstop. Falls back to `?author=` if author lookup fails. Every doc filtered through `isBoxSet({ title })` from `lib/boxSetDetection.ts`. **No OL ratings** — Readstack ratings come from `user_books.rating`. Hero covers rank by recency.

### First-session value loop (V1-V4)
- **Home shortlist (Batch V4, shipped 2026-05-11):** top-of-Home "Your next-read shortlist" section in `app/(tabs)/index.tsx`, rendered above Reading Now. Read-only consumer of the existing rec cache via `getRecSession()` (sync, in-memory) — **never calls `runPipeline` / `getPersonalizedRecsWithExpert` / `triggerRecPrewarm` / `setRecSession` / `clearRecSession`**, never triggers a recommendation fetch from Home. Four states derived in `components/HomeShortlist.tsx`'s `deriveState`: (1) **hot** — fresh `recSession.discoveries` (or `recs` fallback) with ≥1 unacted pick, renders up to 3 compact cards (cover + title + author + optional one-line reason from `reasons[0]`); (2) **cold** — no session / userId mismatch / `Date.now() - loadedAt > 2h` (mirrors `recPayloadCache` TTL), renders "Your shortlist is waiting · Head to For You" → CTA `/(tabs)/search`; (3) **thin** — same conditions as cold AND `librarySize === 0` (proxy = `currentReads.length + yearStack.length`, avoids adding a TasteProfile fetch on Home), renders "Build your shortlist · Add or rate a few books" → CTA `/add-book`; (4) **hidden** — pool exists but every pick is in `loadActedOnIds` (silent hide, per spec — no nag). Acted-on filter reads AsyncStorage via `loadActedOnIds(userId)` (read-only, fail-soft to empty Set). Tap-through mirrors `RecCard.handleCardPress`: writes `setRecContext(external_id, { explanation, evidenceTags: [] })` synchronously, then `router.push('/book/[id]', …)` — preserves "Why this book?" continuity on detail screen. Re-derives on `useFocusEffect` so picks newly written by For You appear when the user returns to Home, without any new fetch.
- **Anchored explanations (Batch V3, shipped 2026-05-11):** UI/copy-only path inside `buildExplanation` (`components/RecCard.tsx`) that grounds the rec card subline in the reader's *own* signals (from `TasteProfile`) when safe evidence exists. New helper `buildAnchoredExplanation(book, tasteProfile)` runs **between the specific-reasons[0] pass and the existing author-loyalty / generic-fallback paths** — so book-specific trait/CoG reasons still win, but generic lane fallbacks get replaced with user-anchored copy. Returns `null` when evidence is thin → existing fallback path unchanged. **No new DB reads, no new candidates, no scoring/ranking/persistence/schema changes, no LLM.** Internal evidence hierarchy (strongest first): (A) `book.author` ∈ `liked_authors` or `det_lanes.repeated_liked_authors` (case+ws-insensitive normalize), (B) `book._score_breakdown.book_lane` ∈ `det_lanes.dominant_lanes`, (C) `genre_affinities[lane] >= 0.4` (boundary inclusive; negative affinities ignored), (D) ≥1 subject overlap between `book.subjects` and `liked_subjects` (lowercase-trim equality, `ANCHOR_NOISE_SUBJECTS = {fiction, nonfiction, literature, general, novel, novels, book}` filtered out). Hedging contract: when `confidence === 'low'` OR `tier < 2`, lane/subject tiers route through `HEDGED_ANCHOR_*_POOL` ("Early signal — …" / "Starting from your taste so far …") and the 2-subject form downgrades to the hedged 1-subject form; **author tier is never hedged** (a 4+★ author is unambiguous evidence at any tier). 7 variant pools (3-3-3-3-3-2-2 entries) selected via FNV-1a `_pickVariant(pool, book.id, tag)` for stable per-card phrasing + per-pattern rotation. Banned phrasings absent. **Author-pool copy is intentionally evidence-conservative** — `liked_authors` per `lib/tasteProfile.ts` `buildLikedAnchors` includes any author with even one 4★+ finished book, so phrasings like "returned to" / "consistently reward" / "most consistent" are kept out of the pool to avoid overclaim on single-book matches; copy reads true for both single-book and `repeated_liked_authors` matches. Threaded as a new optional `tasteProfile` prop on `RecCard`, passed from both `<RecCard>` render sites in `RecommendationsFeed.tsx` (which already had the value).
- **Visible learning toasts (Batch V2, shipped 2026-05-11):** UI/copy-only acknowledgement of recommender feedback actions. Save and More-Like-This trigger a new `LearningToast` (`components/RecCard.tsx`) — "Saved — we'll use this to sharpen your picks." / "Got it — leaning toward more {genre} picks." (genre-aware via `getBookTraits().primaryGenre` + `humanizeGenreKey`, generic fallback otherwise). Dismiss reuses the existing `UndoToast` with copy retuned to "Noted — fewer like \"X\"" so the learning ack and Undo affordance share one surface. Single-slot dedup: parent owns `learningToast` state + timer ref + sequence counter; new actions clear/replace prior toast, never stack. `LearningToast` is hidden whenever `dismissPending` is set (mutually exclusive). **No persistence, scoring, schema, or `genreBoosts` math changes** — fires alongside existing `persistFeedback` / `setFeedbackCtx` writes. Auto-dismiss at 2400ms. `humanizeGenreKey` table extended with `fantasy_scifi`, `memoir_bio`, and `literary` upgraded to `'Literary fiction'` so the toast matches `lib/bookTraits.ts` `detectGenre` keys.
- **Taste Readout (Batch V1A, shipped 2026-05-11):** post-intake "Here's what we heard" surface at `/taste-readout`. Reached from quick-intake completion (`app/onboarding-questions.tsx`) and Goodreads import success → "Go to Discover" (`app/import/goodreads.tsx`); the import-success "Go to Library" path is unchanged. Reads `TasteProfile` + `reader_preferences.favorite_genres` only — **no LLM, no `ReaderThesis`, no new tables, no migrations**. Hedging contract: tier 0/1 use "Your starting picture" / "Early signal" framing; tier 2+ use confident "You read X with a clear pattern" framing **only when the anchor is derived** (lane or `genre_affinities`). When the anchor falls back to intake `favorite_genres[0]`, copy is hedged regardless of tier ("You told us you lean toward X"). Avoided-trait chips render only when `profile.confidence === 'high'`; author chip renders only when `liked_authors.length >= 2`. `isThinReadout` (no derived data, no intake genres) → renders `THIN_READOUT_COPY`. Failure-tolerant — any load error collapses to thin-state. CTA does `router.replace('/(tabs)/search')`.

## Product
Discovery & recommendations (with recommender credibility), library management (status, ratings, goals, gallery view), reading progress (streaks, pace, projected finish), social (sharing, friend activity, Goodreads import), edition specificity, barcode "Will I like this?", reading insights / year wraps.

## Beta-readiness
**Beta-readiness Batches 1-3 shipped (2026-05-10)** — see git history for full diffs:
- **B1:** `app/legal.tsx` + Help & Legal in `app/settings.tsx` + `app.json` build metadata. **Placeholder URLs** at `https://readstack.co/{privacy,terms}` and mailbox `hello@readstack.co` — replace before public launch (grep `TODO(beta-launch)`). `NSPhotoLibraryUsageDescription` was intentionally NOT added.
- **B2 / B4 / B6:** `saveCurrentPage` in `lib/userBookActions.ts` validates page input fail-loud (also see Gotchas); cold-start JWT fast-path in `app/_layout.tsx` writes `onboardingStage='done'` for self-healing.
- **B3 / B5:** cold-start "POPULAR STARTING POINTS" strip — see "Cold-start seeded strip" architecture bullet. `RecEntryScreen.tsx` third CTA is "Browse popular books →".

### Pre-submission backlog (must clear before App Store / Play submission)
1. Stand up live pages at `https://readstack.co/privacy` and `https://readstack.co/terms` (publicly reachable, no auth wall).
2. Confirm `hello@readstack.co` mailbox exists and is monitored (used by Help & Legal → Contact support / Report a bug, plus Settings → Send feedback).
3. Mirror the privacy URL into App Store Connect metadata (consistency check between in-app link and store listing).
4. Bump `ios.buildNumber` (currently `"1"`) and `android.versionCode` (currently `1`) on every TestFlight / Play upload — Apple/Google reject duplicate build numbers.
5. *(Optional polish)* Add a "copy email to clipboard" affordance in the mailto-fallback `Alert` (`app/legal.tsx` + `app/settings.tsx`).

## Gotchas
- **Greens:** only `SAGE_*` tokens. No raw Tailwind greens (`#15803d`, `#16a34a`, `#166534`) or hand-rolled `#2f6f3a`.
- **Subject / content-warning matching:** word-boundary regex (`\b...\b`), never `includes()`.
- **OAuth race:** the shared helper in `lib/socialAuth.ts` is critical to prevent "invalid grant" on social sign-in.
- **Forensic gate:** `FORENSIC_USER_ID` must stay `''` in commits.
- **Edition filter:** `fetchEditions()` requires `pageCount OR publisher` (not just `year`).
- **Goodreads dedup:** title+author guard in `lib/goodreadsExecutor.ts` prevents duplicate book rows.
- **Native changes:** run `npm run build:android:dev` (or iOS equivalent), not just a JS reload.
- **Top-of-screen padding:** new full-screen routes must use `useScreenTopPadding()` — never bare `SafeAreaView` (no-op on web/Android) and never hardcoded `paddingTop: 56/60`.
- **Friend-request ingress is RPC-only:** direct INSERT on `friendships` is REVOKED. All sends route through `sendFriendRequest()` in `lib/friendshipActions.ts` → `public.send_friend_request(p_addressee_id)` SECURITY DEFINER RPC. RPC enforces no-self, addressee-exists, canonical-pair dedup, and per-requester pending cap of 50 (raises SQLSTATE 53400 with prefix `FRIEND_REQUEST_PENDING_CAP_EXCEEDED`). Cap is race-safe via `pg_advisory_xact_lock(hashtext(v_uid::text))`. INSERT is wrapped in an exception block that catches `unique_violation` and re-raises as `FRIEND_REQUEST_DUPLICATE`. The classifier in `lib/friendshipActions.ts` uses SQLSTATE codes (23505, 53400, 23503) as fallbacks. Cancel / decline / unfriend route through `deleteFriendship()` (plain DELETE; RLS allows either party to delete). **Never re-add a direct INSERT policy on `friendships` — it would bypass the cap.**
- **`current_page` validation is fail-loud:** column-level CHECK enforces `current_page >= 0`; trigger `_user_books_validate_current_page` raises `CURRENT_PAGE_EXCEEDS_PAGE_COUNT` (SQLSTATE 23514) when `current_page > books.page_count` (only when both are known). Code that writes `current_page` must clamp upstream — the trigger does NOT clamp silently.
- **Catalog gotchas (Books INSERT guardrail, reconciler service-role key, attempt-count semantics, terminal classification, lock primitive, mergeFields invariant, multi-column UPDATE atomicity):** see `docs/catalog_subsystem.md` §7-§13.
- **User-text length CHECK constraints:** `recommendations.note <= 2000`, `user_books.review_body <= 10000`, `user_books.private_note <= 5000`, `book_club_comments.body <= 2000`. Violations are SQLSTATE 23514.
- **Metro `FallbackWatcher` ENOENT crash (dev-environment noise):** the workflow can die seconds after the first bundle with `ENOENT … watch '.local/skills/.old-delegation-*'`. Race between Metro's recursive `fs.watch()` and the agent runtime cleaning up its own temp dirs — `metro.config.js`'s `resolver.blockList` doesn't filter `FallbackWatcher._watchdir`. Not an app/catalog/runtime issue; native dev/prod builds unaffected. Remediation: restart the workflow. **P2:** install `watchman` via Nix (touches `replit.nix` only).

## Pointers
- Supabase: https://supabase.com/docs
- Open Library: https://openlibrary.org/developers/api
- React Native: https://reactnative.dev/docs
- Expo: https://docs.expo.dev/
- TypeScript: https://www.typescriptlang.org/docs/handbook/intro.html
- Google Sign-In setup: `docs/google-signin.md`
- Device testing: `docs/dev-testing.md`
