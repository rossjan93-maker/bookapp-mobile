# Book Recommendation App

Readstack helps users discover, track, and share personalized book recommendations.

## Run & Operate
- `npm run dev:device` — JS-only changes on device.
- `npm run build:android:dev` / `build:ios:beta` — native build.
- **Required env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OPEN_LIBRARY_API_KEY`, `GOOGLE_BOOKS_API_KEY`. Optional: `LLM_MODEL` (for `inferSubjectsLLM.ts`).
- **Migrations** live in `supabase/migrations/`. Latest applied: `20260512000000_p1_5b_1_verification_reconciler.sql` (reconciler deployed + scheduled). Apply newer files in that folder via the Supabase dashboard SQL editor in filename order.

## Stack
React Native + Expo Router, Supabase (Postgres + Auth + RLS), TypeScript, Expo build.

## Current focus — first-session value loop (V1-V4) — **all shipped 2026-05-11**
The first-session value loop is complete. All four batches were UI/copy-only on top of existing handlers and existing TasteProfile data — **no LLM, no recommender (scoring / ranking / retrieval / persistence) changes, no schema / migrations, no auth, no Sentry, no native config, no Open Library / Google Books / metadata-repair touches.** Sentry remains parked for this stream. See `### First-session value loop (V1-V4)` under Architecture decisions for compressed per-batch references and known limitations. Full implementation detail lives in git history (commits 4dc580d, 498ddf3, 51da9b0, a31c840, 5a7737a).

### UX Correction Sprint — UX-3B Avoid-genres surfaced in TasteReadout **shipped 2026-05-12**
Mirrors the UX-3A intake signal back to the user as "Less of: {genre}" chips on the post-intake "Here's what we heard" surface — purely informational, **no recommender claim** (UX-3F deferred). Touched files: `app/taste-readout.tsx` (extends `reader_preferences` select to `'favorite_genres, avoid_genres'`, new `avoidGenres` state, passes to TasteReadout), `components/TasteReadout.tsx` (new optional `avoidGenres?: string[]` prop, defaults to `[]` for backward-compat with any other caller, threads into `buildChips`), `lib/tasteReadoutCopy.ts` (new pure selector `topAvoidGenres(avoidGenres, favoriteGenres, n=2)` — humanizes via existing `humanizeGenreKey`, dedupes by lowercase, **filters out anything the user also marked as a liked-genre** so a contradictory DB row can't render a "Loves Horror / Less of: Horror" pair; `buildChips` gains optional `avoidGenres: string[] = []` arg and inserts the new chips between preferred-traits and the existing high-confidence avoided-traits, kind `'avoided'` so the existing warm-neutral chip styling in TasteReadout already renders them correctly; chip cap bumped 4→5 so the new signal doesn't crowd out authors). **Empty `avoid_genres` renders nothing new.** Existing thin-state, hedging, summary, learning-line, and CTA paths unchanged. **Untouched:** intake (UX-3A), schema, migrations, recommender scoring/ranking/retrieval, TasteProfile computation, `topAvoidedTraits` (still tier-3-confidence-gated), `isThinReadout` (intake-only avoid-genres alone shouldn't graduate a user out of thin state). Typecheck stayed at baseline 179.

### UX Correction Sprint — UX-3A Avoid-genres intake step **shipped 2026-05-12**
Adds a fourth onboarding-intake calibration step between liked-genres and the 3 taste questions, so non-import users finally write a non-empty `reader_preferences.avoid_genres`. **UI/copy + persistence only — no recommender (scoring/ranking/retrieval) wiring.** That's UX-3F (deferred). Touched files: `components/RecEntryScreen.tsx` (new `IntakeAvoid` component, `IntakeState.avoidGenres: string[]`, new `'intake_avoid'` Phase between `intake_genres` and `intake_taste`, `handleAvoidContinue`, `saveQuickIntake` now writes `avoid_genres: intake.avoidGenres` instead of hardcoded `[]`, `handleSkipIntake` save-gate also fires when `avoidGenres.length > 0`, StepDots bumped 3→4 across all three intake screens), `lib/intakeDraft.ts` (`IntakePhase` adds `'intake_avoid'`, `IntakeDraft` adds `avoidGenres: string[]`, `readIntakeDraft` defaults `avoidGenres = []` for pre-UX-3A drafts so mid-flow users resume cleanly with no loss of liked-genres / taste-answers). **Avoid-pool UX:** reuses the same `getGenres(intake.fictionSplit)` pool the user just picked liked-from, **filtered to exclude their liked picks** so they can't contradict themselves in one sitting. **Skip behavior:** "Skip this →" continues with `avoidGenres = []`; "Skip all →" mirrors the existing IntakeTaste/IntakeGenres skip-all path through `handleSkipIntake('avoid')`. **Untouched:** TasteReadout (UX-3B), recommender scoring (UX-3F), schema, migrations, `favorite_genres` capture, `diagnosis_answers` shape, anchor-book write path, `b_fiction_split`, intake-draft KEY_PREFIX (`_v1_` retained — backward-compat handled in the reader). Copy: title "Anything you usually skip?" / subtitle "Pick anything you'd rather not see. You can skip this." Typecheck stayed at baseline 179.

### UX Correction Sprint — UX-2 Learning toast overtness **shipped 2026-05-12**
Live testing showed the V2 single-line `LearningToast` was too easy to miss — users were tapping Save / More-Like-This / Dismiss and not registering that Readstack had received their signal. UX-2 is a UI/copy-only pass on `components/RecCard.tsx` (toast components) and `components/RecommendationsFeed.tsx` (toast payload + 2 callers). **`LearningToast` is now two lines** (headline + subline) with a 3pt sage left-accent stripe (`tone: 'positive'`); `UndoToast` is also two lines with a muted-grey left-accent stripe (`tone: 'negative'` semantically) and explicit "We'll show fewer books like this." subline. Duration bumped **2400ms → 3000ms** to accommodate two-line read time. **Copy:** Save → "Saved to Want to Read." / "We'll use this as a positive signal."; MLT (genre-aware) → "Tuned toward more {genre} picks." / "This teaches Readstack without saving the book."; MLT (fallback) → "Tuned your picks using this signal." / "Not saved to your library."; Dismiss (UndoToast) → "Noted — fewer like \"X\"" / "We'll show fewer books like this." `accessibilityLiveRegion="polite"` + `accessibilityLabel` (concatenates headline + subline) added to LearningToast. **Untouched:** `genreBoosts` math, `dismissedIds`, `savedIds`, `removeFromQueue`, `trackActedOn`, `trackActedOnPending`, `commitActedOn`, `replenishIfNeeded`, `persistFeedback`, `setFeedbackCtx`, `runPipeline`, `setRecSession`, `getPendingDismiss`, `setPendingDismiss`, `DISMISS_UNDO_MS`, the books/user_books write path inside `handleSave`, the dismiss undo timer, and the parent's `!dismissPending && learningToast` render guard (UndoToast still wins when both could appear). The deferred "Picks tuning" near-deck visual state was intentionally skipped per spec ("If this requires more complexity than expected, skip it and just improve the toast.") — the two-line toast + accent stripe is sufficient on its own. Typecheck stayed at baseline 179.

### UX Correction Sprint — UX-1C HomeShortlist visual restraint **shipped 2026-05-12**
Visual-only restraint pass on `components/HomeShortlist.tsx` (no behavior change, no `app/(tabs)/index.tsx` touch). **Hot state** now defaults to a ~64pt collapsed peek pill (overlapping mini-covers 30×44 with -10 left-margin overlap + "{N} picks ready" / "Open your next-read shortlist" + chevron). Tap expands inline (LayoutAnimation 220ms easeInEaseOut) to the existing 3-card layout, which now also exposes a "Hide" affordance alongside "See all ›". Expand state is `useState`-only (session-scoped, resets on remount; no AsyncStorage). **Cold/thin states** compressed from a ~120pt sage card to a ~44pt single-line pill ("Your shortlist is waiting" / "Add a few books to unlock picks" + "See picks ›" / "Add a book ›"). Section bottom-margin reduced 32→24. **Untouched:** `getRecSession`, `loadActedOnIds`, `setRecContext`, `deriveState`, the hot/cold/thin/hidden state machine, the 2h freshness window, the race-guard on `actedOnReadyUid`, the `librarySize === 0` thin proxy, and the tap-through `setRecContext + router.push` mirror of `RecCard.handleCardPress`. No new fetches, no recommender calls. Typecheck stayed at baseline 179.

### UX Correction Sprint — UX-1B "More Like This" clarity **shipped 2026-05-12**
Copy-only clarification of two divergent MLT surfaces (no behavior change). **Surface A (For-You feed, `RecCard.tsx` MLT button + `RecommendationsFeed.handleMoreLikeThis` toast):** added `accessibilityHint="Teaches the app, does not save this book."`, added "Tune · not saved" subline under the button label, retuned confirm overlay to "Got it — we'll tune toward this / Not saved to your library", and rewrote the learning toast to "Tuned toward more {genre} picks. Not saved to your library." (genre-aware) / "Tuned your picks using this signal. Not saved to your library." (fallback). **Surface B (book-detail rec quick-actions modal in `app/book/[id].tsx`):** modal title is now "Save this book too?", body explains that MLT can tune recs OR also save to Want to Read. First-tap choices reordered to surface the per-tap path first ("Save to Want to Read + tune future picks" → ask, "Just tune future picks" → ask, "Always save + tune (don't ask again)" → always). Per-tap modal mirrors the two non-always choices. **Critical:** `_commitMoreLikeThis`, `handleRecMoreLikeThis`, `setMltAutoaddPref`, `persistFeedback`, `genreBoosts` math, `removeFromQueue`, `trackActedOn`, `replenishIfNeeded`, and `clearRecSession` were NOT touched — this is purely copy + accessibility + a button subline. Typecheck stayed at baseline 179. **Known divergence:** Surface A never saves; Surface B saves by default unless the user picks "Just tune future picks". Both surfaces now state the post-tap save state truthfully. The MLT auto-add pref is settable only via the first-tap modal (no settings-screen toggle — still parked).

### UX Correction Sprint — UX-1A Trust Restoration **shipped 2026-05-12**
Thin-profile copy gating for the older (non-V3) explanation paths in `RecCard.tsx`. Each variant pool now has a `_SAFE` peer (no behavior claim) and a `_HISTORY` peer (current copy with implied-history phrasing). Gate is `isHistoryRich(tp) = tp != null && tp.tier >= 2 && tp.confidence !== 'low'`; `_pickGated()` selects the SAFE pool by default. `tasteProfile` is now threaded through `rewriteReasonText`, `_themeTailFor`, the author-loyalty path, and the lane-fallback last-resort path (4 call sites in `buildExplanation`). Source-file copy in `lib/expertRec.ts` and `lib/recommender.ts` was NOT touched — every implied-history string they produce reaches RecCard via reasons[] and is rewritten through the now-gated rewriter; per-render audit confirmed zero leak. SAFE pools verified zero banned-thin AND zero V3-universal phrases across 30 sampled renderings; HISTORY pools verified zero V3-universal phrases. Typecheck stayed at baseline 179. UX Correction Sprint Issues 2/3/4/5 (intake redesign, MLT clarity, learning toast, HomeShortlist) remain parked — see audit doc.

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

### First-session value loop (V1-V4) — shipped, compressed reference
All four batches are UI/copy-only on existing handlers + existing `TasteProfile` data. No recommender / scoring / ranking / retrieval / persistence / schema / LLM / OL / GBooks / metadata changes. Home does **not** fetch or generate recommendations. Full diffs in git history; expand a bullet by `git log -p -- <file>`.

- **V1A Taste Readout (`app/taste-readout.tsx` + `components/TasteReadout.tsx` + `lib/tasteReadoutCopy.ts`):** post-intake "Here's what we heard" surface. Reached from quick-intake completion and Goodreads import-success "Go to Discover" (Library path unchanged). Reads `TasteProfile` + `reader_preferences.favorite_genres` only. Hedging contract: tier 0/1 framing is always hedged; tier 2+ uses confident framing **only when the anchor is derived** (lane / `genre_affinities`) — intake-fallback anchors stay hedged regardless of tier. Avoided-trait chips gated on `confidence === 'high'`; author chip gated on `liked_authors.length >= 2`. Failure-tolerant → thin-state on any load error. CTA `router.replace('/(tabs)/search')`.
- **V2 Visible Learning Toasts (`components/RecCard.tsx` `LearningToast` + `humanizeGenreKey` in `lib/tasteReadoutCopy.ts`):** Save / More-Like-This / Dismiss each fire a single-slot toast acknowledging the signal ("Saved — we'll use this to sharpen your picks." / "Got it — leaning toward more {genre} picks." / "Noted — fewer like \"X\""). Genre-aware via `getBookTraits().primaryGenre`. Single-slot dedup, mutually exclusive with `dismissPending`, auto-dismiss 2400ms. Fires alongside existing `persistFeedback` / `setFeedbackCtx` writes — no persistence or `genreBoosts` math changes.
- **V3 Anchored Explanations (`buildAnchoredExplanation` in `components/RecCard.tsx`):** runs **between specific-reasons[0] and the author-loyalty / generic fallbacks** in `buildExplanation`. Evidence hierarchy A→D: liked-author / repeated-liked-author → dominant lane → `genre_affinities[lane] >= 0.4` (boundary inclusive; negatives ignored) → ≥1 subject overlap (`ANCHOR_NOISE_SUBJECTS` filtered: fiction/nonfiction/literature/general/novel/novels/book). Hedging: `confidence === 'low'` OR `tier < 2` routes lane+subject through `HEDGED_*` pools and downgrades 2-subject → hedged 1-subject; **author tier is never hedged**. 7 variant pools, FNV-1a-deterministic per `(book.id, pattern-tag)`. Author-pool copy is intentionally conservative — `liked_authors` per `buildLikedAnchors` includes single-4★ authors, so phrasings like "returned to" / "consistently reward" / "most consistent" are kept out of pools to avoid overclaim. Banned phrasings ("you loved" / "you will love" / "perfect for you" / "consistently" / "always" / "most") absent — verified across 204 sampled renderings. Threaded via optional `tasteProfile` prop on `RecCard`.
- **V4 Home Shortlist (`components/HomeShortlist.tsx`, mounted in `app/(tabs)/index.tsx` above Reading Now):** read-only consumer of `getRecSession()` (sync, in-memory). **Never calls `runPipeline` / `getPersonalizedRecsWithExpert` / `triggerRecPrewarm` / `setRecSession` / `clearRecSession`** — never triggers a fetch from Home. Four states in `deriveState`: **hot** (fresh user-matched session w/ ≥1 unacted pick → up to 3 compact cards: cover + title + author + optional `reasons[0]` one-liner) / **cold** (no/wrong/stale session, 2h TTL via `loadedAt` mirrors `recPayloadCache.TTL_MS` → "Your shortlist is waiting" → `/(tabs)/search`) / **thin** (cold AND `librarySize === 0` → "Build your shortlist" → `/add-book`) / **hidden** (pool exists but all picks in `loadActedOnIds` → silent, no nag). Race-guarded: `hot` only renders once `actedOnReadyUid === userId`; acted-on resets on userId change. Tap mirrors `RecCard.handleCardPress`: `setRecContext(externalId, { explanation, evidenceTags: [] })` then `router.push('/book/[id]', …)`. Re-derives on `useFocusEffect`.

**V1-V4 known limitations (still relevant for future work):**
- **No authenticated / on-device UX test yet** — V1-V4 verified statically (typecheck + truth-table probes + banned-phrase audits + workflow-clean checks). Real-device flows (cold-start onboarding → For You → Home tap-through) have not been walked through end-to-end with a live account.
- **V1A: anchor-book acknowledgement by name deferred** — TasteReadout grounds in derived lane / genre_affinities / intake genres, but does not name a specific 4★+ anchor book ("because you liked *X*"). Intentional, to keep V1A LLM-free and avoid over-personalization on thin profiles.
- **V4: thin-state proxy is heuristic** — `librarySize = currentReads.length + yearStack.length`. A user with many finished/rated books but zero in-progress + zero year-stack would see "Build your shortlist" instead of "Your shortlist is waiting." Acceptable trade-off vs. adding a TasteProfile fetch on Home; swap in `tasteProfile.tier` later if Home loads it for another reason.
- **V4: shortlist reasons use `reasons[0]`, not the polished V3 `buildExplanation` output** — keeps Home dependency-free; compact card UI also has no room for the longer hedged copy.
- **V4: tap-through writes `evidenceTags: []`** — Home doesn't compute the full evidence-tag array (RecCard's `buildEvidenceTags` is internal). Detail "Why this book?" still gets the explanation string, just less rich than tapping from For You.

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
