# File Inventory — "Where things live"

Moved out of `replit.md` on 2026-05-14 to keep the live operating reference compact. The few files needed for next-phase execution context are mirrored back into `replit.md` under `## Where things live`. This doc is the full inventory.

## lib/
- `lib/tokens.ts` — color palette / design tokens.
- `lib/screenLayout.ts` — `useScreenTopPadding()` (`insets.top + 16`); single source of truth for top-of-screen padding on `headerShown:false` routes.
- `lib/shelves.ts` — smart-shelf filtering (`matchesSubjects`).
- `lib/customShelves.ts` — `user_shelves` / `user_shelf_books` CRUD.
- `lib/contentWarnings.ts` — content-warning matching + two-tier confidence.
- `lib/metadataProvider.ts` — canonical book metadata + cover selection.
- `lib/metadataRepair.ts` — Open Library → Google Books repair.
- `lib/openLibrary.ts` — Open Library API + author bibliography.
- `lib/recommender.ts` — recommender (contains `FORENSIC_USER_ID`); P2 B1 post-EXP_QUALITY re-promotion of reserved stated pick lives here.
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
- `lib/tasteReadoutCopy.ts` — pure copy assembly for the post-intake "Here's what we heard" surface (humanizers, hedged summary/chip builders, thin-state detection, FS-5a synthesis). Also owns `humanizeGenreKey`. No IO.
- `lib/traitCopy.ts` — FX-1 trait humanization (`humanizeTraitKey`, `composeTraitPhrase` with `PAIR_TABLE`, `rehumanizeReasonPhrase`).
- `lib/mltAutoaddPref.ts` — AsyncStorage pref for "more like this" auto-add.
- `lib/subjectVocabulary.ts` — curated subject vocab for LLM inference.
- `lib/recSession.ts` / `lib/recQueue.ts` / `lib/recPayloadCache.ts` — three deck-state stores; share P0B `configHash` (carried as optional field; strict accessors `getRecSessionFor` / `assertQueueConfig` / `loadRecPayload(opts.currentConfigHash)` self-invalidate on mismatch).
- `lib/recValidity.ts` — P0B deck-validity helper. `computeRecConfigHash` (versioned `rcv1`, normalized over `favorite_genres` / `avoid_genres` / `reading_styles` / `favorite_authors`), `assertCurrent`, `loadCurrentConfigHash`. Single source of truth for "does this stored deck still belong to the user's current rec config?".
- `lib/recPolicy.ts` — all policy constants: `STATED_TASTE_POLICY`, `BRANCH_QUOTAS`, `EDIT_CAUSE_BRANCH_BOOST`, `STATED_RESERVATION_POLICY` (incl. `allowAdjacentForCauses` for P2 Fix A), `LIKED_SUBJECT_AVOID_GUARDS`, `SOFT_AVOID_RETRIEVAL_MULTIPLIER`.
- `lib/recRequest.ts` — `RecRequest` compiler + `BuildCause` union + `setPendingBuildCause`/`consumePendingBuildCause`.
- `lib/recSignals/types.ts` + `lib/recSignals/build.ts` — typed signal contract (`SignalClass` union, aggregate `Signals`, pure `buildSignals(...)`).
- `lib/composition/statedReservation.ts` — top-slate reservation; AND-gates retrieval provenance + scoring provenance.
- `lib/retrieval/branchPlanner.ts` — P2A planner.
- `lib/retrieval/types.ts` — `BranchContext`, `RetrievalPlan`, `FetchItem`.
- `lib/retrieval/branches/statedGenres.ts` / `revealedAuthors.ts` / `revealedLanes.ts` — branch modules.
- `lib/retrieval/softAvoidLocal.ts` — P2C local-catalog soft-avoid demotion (`applyLocalSoftAvoidFilter` + `classifyCandidateAvoidKey`).
- `lib/taxonomy/genres.ts` — P0A canonical genre taxonomy (21 `GenreDef`s; `EDIT_GENRE_IDS` / `INTAKE_FICTION_IDS` / `INTAKE_NONFICTION_IDS`; `editLabel` / `intakeLabel` helpers; `AFFINITY_RETRIEVAL_SUBJECTS` + `getRetrievalSubjects`).
- `lib/taxonomy/normalize.ts` — `normalizeGenreInput()` — only legal entry for resolving free-form genre labels to a `GenreDef`. Misses → `__DEV__ console.warn`.

## scripts/
- `scripts/validate_taxonomy.ts` — npx-tsx integrity check (every chip + 17 legacy/alias probes); exit 0/1.
- `scripts/validate_rec_validity.ts` — npx-tsx integrity check for `recValidity` (hash determinism + tolerance + per-field uniqueness + `assertCurrent` semantics + prior-bug-class invalidation + P0B.1 persisted-payload restore gate); exit 0/1.
- `scripts/validate_rec_request.ts` — npx-tsx integrity check for `RecRequest` compiler + signal building; exit 0/1.
- `scripts/validate_retrieval_planner.ts` — npx-tsx integrity check for `branchPlanner` (branch order, quotas, edit-cause boost, soft-avoid intersection, P2C cases); exit 0/1.
- `scripts/validate_stated_reservation.ts` — npx-tsx integrity check for `pickStatedReservation` (cause gate, favorites gate, AND-gate, adjacent-fit allow-list); exit 0/1.
- `scripts/repairSubjectCoverage.ts`, `scripts/inferSubjectsLLM.ts`, `scripts/backfillSessionCorrections.ts`, `scripts/deduplicateBooks.ts` — maintenance scripts.

## app/
- `app/_layout.tsx` — root Stack (`headerShown:false`), bootstrap context, onboarding bridge.
- `app/(tabs)/_layout.tsx` — tab layout; cold-start prewarm restore now config-gates `loadRecPayload`.
- `app/book/[id].tsx` — book detail (rating UI, paused toggle, year-stack toggle, recommend-to-friend, rec quick-actions card).
- `app/(tabs)/index.tsx` — home (yearly progress bar, year-stack strip, streak flame; mounts HomeShortlist above Reading Now).
- `app/(tabs)/library.tsx` — library w/ smart + custom shelves, Priority filter chip.
- `app/(tabs)/search.tsx` — Discover/For-You tab.
- `app/stats/index.tsx` — Reading Insights.
- `app/onboarding.tsx`, `app/onboarding-import.tsx`, `app/onboarding-questions.tsx` — onboarding flow.
- `app/taste-readout.tsx` — post-intake "Here's what we heard" route.
- `app/edit-preferences.tsx` — Reading Taste editor; calls 3-store manual clear after save (defense-in-depth post-P0B); sets pending `explicit_preference_edit` BuildCause.
- `app/legal.tsx` — Help & Legal (placeholder URLs marked `TODO(beta-launch)`).

## components/
- `components/CoverThumb.tsx` — every cover surface (3D treatment, `flat` opt-out).
- `components/HalfStarRating.tsx` — `HalfStarRating`, `StarDisplay`, `ratingToSentiment`, `formatRating`.
- `components/RecCard.tsx` — for-you card + rationale variant pools + `UndoToast` + `LearningToast`. P3 will rewire rationale assembly to consume contribution arrays.
- `components/RecommendationsFeed.tsx` — for-you feed + intent chips (`handleApplyIntent`) + V2 toast wiring; bootstrap path that runs `runPipeline`.
- `components/RecommendBookSheet.tsx` — recommend-finished-to-friend sheet.
- `components/TasteReadout.tsx` — pure presentational "Here's what we heard" view.
- `components/HomeShortlist.tsx` — V4 top-of-Home next-read surface; read-only consumer of `getRecSession()` + `loadActedOnIds()`.
- `components/RecEntryScreen.tsx` — quick-intake (genres → avoid → outcome → taste → anchor); chip lists derive from P0A taxonomy ID lists.
- `components/ShelfRow.tsx` / `ShelfPickerSheet.tsx` — shelf chips + add-to-shelf bottom sheet.
- `components/LibraryGalleryView.tsx` — library gallery view.

## Other
- `app.json` — Expo config (camera plugin + explicit iOS `NSCameraUsageDescription`).
- `docs/google-signin.md`, `docs/dev-testing.md`, `docs/ios-testflight-checklist.md`, `docs/catalog_subsystem.md`, `docs/p1_5b_1_reconciler_runbook.md`, `docs/p1_5b_2_surface_audit.md`, `docs/p1_5b_3_dedup_audit.md`, `docs/recently_shipped.md`.
