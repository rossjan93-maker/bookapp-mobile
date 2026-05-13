# Book Recommendation App

Readstack helps users discover, track, and share personalized book recommendations.

## Run & Operate
- `npm run dev:device` — JS-only changes on device.
- `npm run build:android:dev` / `build:ios:beta` — native build.
- **Required env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OPEN_LIBRARY_API_KEY`, `GOOGLE_BOOKS_API_KEY`. Optional: `LLM_MODEL` (for `inferSubjectsLLM.ts`).
- **Migrations** live in `supabase/migrations/`. Latest applied: `20260512000000_p1_5b_1_verification_reconciler.sql`. Apply newer files via Supabase dashboard SQL editor in filename order.

## Stack
React Native + Expo Router, Supabase (Postgres + Auth + RLS), TypeScript, Expo build.

---

## Current focus — Recommendation Architecture Refinement

The revised Recommendation Architecture Spec is **locked**. Readstack now operates under a dual-plane strategy:

1. **Free / core — Recommendation Control Plane.** Trustworthy, responsive to explicit input, structurally coherent, explanation-faithful, testable, cache-safe. Basic correctness is **not** paywalled.
2. **Paid / premium — Semantic Intelligence Plane.** Reader thesis, book intelligence, semantic cross-genre retrieval, bounded AI reranking, "surprising but right" discovery, advanced next-read decision sessions, taste evolution insights.

### Implementation sequence (in order)
- **P0A** — Canonical genre taxonomy integrity (single source of truth; zero silent unmapped labels)
- **P0A.1** — Recommender retrieval-side map fold-in (recommender consults the same taxonomy)
- **P0B** — Full deck-validity / configHash invalidation (payload + session + queue stores)
- **P1** — Signal/control contract (`RecRequest`, typed signals, **non-zero stated-pref floor at all tiers**)
- **P2** — Retrieval responsiveness / branch planner (visible deck shift after pref edit, dense users included)
- **P3** — Score contributions + explanation faithfulness (reasons cite real contributions)

**Honest scope note:** P0A alone does **not** fix the tier-2+ silent-zeroing of explicit prefs. That ships in P1, with retrieval responsiveness landing in P2. P0A delivers correctness for cold/thin users and unblocks every later phase.

### Strategic thesis (locked)
- **Free Readstack must be genuinely good.** Correct taxonomy, explicit-preference responsiveness, honest avoid behavior, robust deck invalidation, and coherent explanations are **never** paywalled.
- **Paid Readstack monetizes deeper intelligence**, not basic correctness: reader thesis, book intelligence (appeal vectors + closed-vocabulary descriptors), semantic retrieval, bounded AI reranking, premium evidence-cited explanations, decision sessions, taste evolution.
- **Architectural commitment:** the Semantic Intelligence Plane plugs into Control Plane interfaces (signal slots, branch registry, contribution sources). No recommender rewrite at the free/paid boundary.

### Pre-beta gates
- **Required before external beta:** P0A + P0A.1 + P0B + P1 + P2, plus P3 minimum (zero false-attribution reasons in fixture replay).
- **Required before paid beta:** full P3, plus P4 (Semantic Intelligence foundation) and P5 (premium discovery engine).
- Quotas, score caps, decay half-life, slot-reservation rules are **calibration hypotheses** owned by `lib/recPolicy.ts` (to be created in P1) — tunable without architectural change.

---

## Recently shipped — summarized

Compressed reference for completed work. Full diffs in git history; expand a cluster with `git log -p -- <path>`.

- **First-session value loop V1–V4** — shipped 2026-05-11 (commits `4dc580d`, `498ddf3`, `51da9b0`, `a31c840`, `5a7737a`). UI/copy-only on existing handlers + existing `TasteProfile`. V1A Taste Readout (`app/taste-readout.tsx` + `components/TasteReadout.tsx` + `lib/tasteReadoutCopy.ts`); V2 Visible Learning Toasts (`RecCard` `LearningToast`); V3 Anchored Explanations (`buildAnchoredExplanation` in `RecCard`); V4 Home Shortlist (`components/HomeShortlist.tsx`, read-only consumer of `getRecSession()`). No recommender / scoring / ranking / retrieval / persistence / schema / LLM / OL / GBooks / metadata changes. Home does **not** fetch or generate recommendations. Active caveats preserved below.
- **UX Correction Sprint UX-1A → UX-3F.1** — shipped 2026-05-12. Thin-profile copy gating in RecCard variant pools (UX-1A SAFE/HISTORY split via `isHistoryRich(tp)` + `_pickGated`); MLT clarity copy on RecCard + book-detail rec quick-actions modal (UX-1B); HomeShortlist visual restraint with collapsed peek pill (UX-1C); two-line learning toasts with accent stripes (UX-2); avoid-genres intake step (UX-3A) + readout chips (UX-3B); reading-outcome `q_outcome` intake step (UX-3C); `q_style` → `q_tone` swap (UX-3D); outcome+tone surfaced as readout chips (UX-3E); RecCard author-anchor trust hardening — `ANCHOR_AUTHOR_POOL` split into `_RATED` / `_NEUTRAL` per `det_lanes.repeated_liked_authors` provenance (UX-3F.1). Author chip / stated-author model in `lib/tasteProfile.ts` mixed-provenance merge **remains parked** until signal semantics land in P1.
- **FS-5a Taste Readout synthesis copy** — shipped 2026-05-13. `lib/tasteReadoutCopy.ts` `buildIntakeSynthesis` produces a synthesized "You're pointing Readstack toward…" sentence for intake-only users with rich signals; gates on ≥1 rich signal from {valid `q_outcome`, non-flexible `q_tone`, ≥1 avoid genre, fast pacing, ≥2 liked genres}; history-rich path unchanged. Copy-only.
- **FX-1 RecCard trait-explanation humanization** — shipped 2026-05-13. New `lib/traitCopy.ts` (`humanizeTraitKey`, `composeTraitPhrase` with 18-entry `PAIR_TABLE`, `rehumanizeReasonPhrase` for legacy cache rebuild). `lib/recommender.ts:1538` reasons-assembly site now uses `composeTraitPhrase(...)` instead of raw `' and '` join. RecCard `ALIGNS_POOL_*` / `APPRECIATION_POOL_*` templates refreshed; pool tags bumped to `_v2` to flush old hash slots. HomeShortlist benefits automatically (reads `book.reasons[0]` raw). No scoring/ranking/retrieval change.
- **Profile save-trust fixes (Reading Taste / recQueue / Home name+goal)** — shipped earlier in stream. `app/edit-preferences.tsx` save now calls `clearRecSession()` + `clearRecQueue()` + `void clearRecPayload(userId)` before back-nav so the For-You deck rebuilds against new prefs. Root cause was module-level `_queue` in `lib/recQueue.ts` surviving `clearRecSession()`, causing stale visible head. **This manual three-store clear becomes redundant once P0B ships** (configHash invalidation), but is retained as defense-in-depth for one release.
- **Catalog subsystem (P0 / P0.5 / P1.5a / P1.5b-1 / -1.1 / -2 / -3)** — see `docs/catalog_subsystem.md` and runbooks. Verification reconciler deployed + scheduled (latest applied migration).
- **P0A Canonical genre taxonomy** — shipped 2026-05-13. New `lib/taxonomy/genres.ts` (21 `GenreDef`s with `id` / `uiLabels{edit,intake,cardTag}` / `aliasInputs` / `affinityKey` / `olSubjects` / `fictionality`; ordered ID lists `EDIT_GENRE_IDS` / `INTAKE_FICTION_IDS` / `INTAKE_NONFICTION_IDS` typed as `GenreId[]` so a stray label fails typecheck) + `lib/taxonomy/normalize.ts` (`normalizeGenreInput()` — single legal entry point; case-insensitive, whitespace-collapsed alias index built at module load with conflict-throw; misses surface via `__DEV__ console.warn`). Three consumers rewired: `app/edit-preferences.tsx` chip list now `EDIT_GENRE_IDS.map(editLabel)`; `components/RecEntryScreen.tsx` `FICTION_GENRES` / `NONFICTION_GENRES` derived from `INTAKE_*_IDS.map(intakeLabel)`; `lib/tasteProfile.ts` tier ≤ 1 blend at line ~754 replaces inline `GENRE_AFFINITY_MAP` / `GENRE_SUBJECTS_MAP` with `normalizeGenreInput(label)?.{affinityKey,olSubjects}`. Six previously silent-dropped edit-preferences labels (`History`, `Biography`, `Business`, `Science`, `Poetry`, `Classic`) plus alias variants (`Biography & Memoir`, `Science & Nature`, `Sci-Fi`/`Sci-fi & fantasy`/`Science Fiction`, `Nonfiction`/`Non-Fiction`) now resolve. **Tier ≤ 1 gate intentionally unchanged** — tier-2+ explicit-preference responsiveness is P1 (signal contract) + P2 (branch planner); do NOT spot-patch by widening the gate. Recommender retrieval-side genre map fold-in is P0A.1 (recommender does not currently read `favorite_genres`/`avoid_genres` directly — only via tasteProfile, so safe to defer). Integrity guarded by `scripts/validate_taxonomy.ts` (run via `npx tsx`; covers all 35 chips + 17 legacy/alias probes; exit 0/1). No jest/vitest setup exists in this project — script substitutes for `tests/taxonomy.test.ts`.

### V1–V4 known limitations still relevant
- **No authenticated / on-device UX walkthrough yet** — V1-V4 verified statically (typecheck + truth-table probes + banned-phrase audits). Cold-start onboarding → For You → Home tap-through has not been walked end-to-end with a live account.
- **V1A: anchor-book name acknowledgement deferred** — TasteReadout doesn't name a specific 4★+ anchor ("because you liked *X*"). Intentional to keep V1A LLM-free and avoid over-personalization on thin profiles.
- **V4: thin-state proxy is heuristic** — `librarySize = currentReads.length + yearStack.length`. A user with many finished books but zero in-progress + zero year-stack sees "Build your shortlist" instead of "Your shortlist is waiting." Acceptable trade-off; swap in `tasteProfile.tier` later if Home loads it for another reason.
- **V4: shortlist reasons use `reasons[0]`, not the polished V3 `buildExplanation` output** — keeps Home dependency-free.
- **V4: tap-through writes `evidenceTags: []`** — Home doesn't compute the full evidence-tag array; detail "Why this book?" still gets the explanation string but less rich than tapping from For You.

### Parked / explicitly deferred
- **Sentry / analytics instrumentation** — out of scope across the current stream. Do not add until that constraint is lifted.
- **Author chips / stated-author model** — `lib/tasteProfile.ts:711-726` merge of stated `favorite_authors` with rated authors remains in place; recommender still consumes `liked_authors` as anchor candidates. Parked until P1 signal-provenance work cleans this up. UX-3F.1 closed only the RecCard copy overclaim.
- **MLT auto-add settings UI** — `lib/mltAutoaddPref.ts` AsyncStorage pref exists; no settings-screen toggle (parked).
- **B3 Goodreads import-success routing polish** — current routing acceptable.
- **Hard avoid ("never recommend X") UI + storage** — designed in spec (signal class slot reserved); ships in P4 with finalized storage decision.

---

## Recommendation Architecture (locked blueprint — concise)

Live operating reference for the architecture P0A→P6 implements. Full spec lives in chat history (architecture revision turn).

- **Canonical taxonomy** (P0A): `lib/taxonomy/genres.ts` will be the single source of truth for `GenreDef { id, uiLabels{edit/intake/cardTag/aliasInputs}, affinityKey, olSubjects, laneTag, fictionality }`. Same pattern slated for traits (P1) and subjects (P4). Adding a chip without a `GenreDef` becomes a typecheck failure. `normalizeGenreInput()` is the only legal entry of genre strings; misses go to a telemetry sink.
- **Typed signal provenance** (P1): six classes — `stated_durable`, `revealed_behavioral`, `soft_avoid`, `hard_avoid` (reserved), `current_intent`, `short_term_feedback`. Each carries source + confidence + decay policy + retrieval/ranking/explanation eligibility. `TasteProfile` becomes a derived view; signals are primary.
- **`RecRequest` compiler** (P1): single typed object compiling all signals + policy + `BuildCause` + `configHash` + `schemaVersion`. Replaces hidden tier gates (tier becomes one input to `policy.confidenceMode`, not a load-bearing branch). `BuildCause ∈ { session_open, manual_refresh, explicit_preference_edit, intent_apply, intent_clear, feedback_action, onboarding_completion }` — `explicit_preference_edit` triggers one-session top-4 slot reservation for stated-branch candidates that clear the quality floor.
- **Deck validity** (P0B): `configHash` carried by all three stores (`recPayloadCache`, `recSession`, `recQueue`); central `lib/recValidity.ts` `assertCurrent()` check at every read. Mismatch invalidates that store. Manual clears become redundant.
- **Branch-based retrieval** (P2): `lib/retrieval/branchPlanner.ts` always runs `revealed_lanes`, `revealed_authors`, `stated_genres`, `stated_authors`, `intent`, `exploration`, `feedback` branches with quotas keyed off `policy.confidenceMode` and `BuildCause`. **`stated_genres` quota is never zero while user has any mapped favorite_genre** — including dense users. Soft avoid deprioritizes within branches; hard avoid (P4) is global pre-branch exclusion.
- **Contribution-grounded ranking** (P3): scoring produces typed `ScoreContribution[] { source, kind, value, evidence }`. Components: `behavioral_fit`, `stated_taste_fit` (**+0.05 floor at all tiers**, decay by row `updated_at`), `intent_fit`, `quality_reliability`, `feedback_fit`, `novelty_diversity`, `soft_avoid_penalty`, `repetition_suppression`, `hygiene_floor`. All cap values are policy.
- **Explanation faithfulness** (P3): `lib/explanations/compose.ts` reads contributions. **No reason emitted without a corresponding positive contribution above a per-kind floor.** Provenance dictates copy template (stated vs revealed vs intent vs feedback). Slate diversity guard rejects 3rd instance of same `kind` in top-4 unless no alternative. FX-1 humanization survives but cannot misrepresent.
- **Quality gates** (CI from introducing phase): A1 zero-unmapped-labels (P0A), A2 configHash invalidates all 3 stores (P0B), A3 pref edit changes RecRequest (P1), A4–A6 retrieval/top-4 deltas including dense (P2), A7 soft avoid in retrieval+ranking (P2), A8 zero false-attribution reasons (P3 minimum), A9 slate diversity (P3 full), A10 BuildCause propagation (P1).
- **Semantic Intelligence hooks** (kept open in Control Plane so P4–P6 plug in additively): `RecRequest.signals` is open record (room for `reader_thesis`); branch registry accepts `semantic_appeal` as one more entry (disabled-by-default in free); contribution model accepts `semantic_rerank` and `premium_evidence_match` sources; explanation layer reads kinds (premium kinds plug in).

---

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
- `lib/tasteReadoutCopy.ts` — pure copy assembly for the post-intake "Here's what we heard" surface (humanizers, hedged summary/chip builders, thin-state detection, FS-5a synthesis). Also owns `humanizeGenreKey`. No IO.
- `lib/traitCopy.ts` — FX-1 trait humanization (`humanizeTraitKey`, `composeTraitPhrase` with `PAIR_TABLE`, `rehumanizeReasonPhrase`).
- `lib/mltAutoaddPref.ts` — AsyncStorage pref for "more like this" auto-add.
- `lib/subjectVocabulary.ts` — curated subject vocab for LLM inference.
- `lib/recSession.ts` / `lib/recQueue.ts` / `lib/recPayloadCache.ts` — three deck-state stores; will share `configHash` after P0B.
- `lib/taxonomy/genres.ts` — P0A canonical genre taxonomy (21 `GenreDef`s; `EDIT_GENRE_IDS` / `INTAKE_FICTION_IDS` / `INTAKE_NONFICTION_IDS`; `editLabel` / `intakeLabel` helpers). Single source of truth for chip labels + `affinityKey` + `olSubjects`.
- `lib/taxonomy/normalize.ts` — `normalizeGenreInput()` — only legal entry for resolving free-form genre labels to a `GenreDef`. Misses → `__DEV__ console.warn`.
- `scripts/validate_taxonomy.ts` — npx-tsx integrity check (every chip + 17 legacy/alias probes); exit 0/1.
- `app/_layout.tsx` — root Stack (`headerShown:false`), bootstrap context, onboarding bridge.
- `app/book/[id].tsx` — book detail (rating UI, paused toggle, year-stack toggle, recommend-to-friend, rec quick-actions card).
- `app/(tabs)/index.tsx` — home (yearly progress bar, year-stack strip, streak flame; mounts HomeShortlist above Reading Now).
- `app/(tabs)/library.tsx` — library w/ smart + custom shelves, Priority filter chip.
- `app/(tabs)/search.tsx` — Discover/For-You tab.
- `app/stats/index.tsx` — Reading Insights.
- `app/onboarding.tsx`, `app/onboarding-import.tsx`, `app/onboarding-questions.tsx` — onboarding flow.
- `app/taste-readout.tsx` — post-intake "Here's what we heard" route.
- `app/edit-preferences.tsx` — Reading Taste editor (currently calls 3-store manual clear after save; redundant after P0B ships).
- `app/legal.tsx` — Help & Legal (placeholder URLs marked `TODO(beta-launch)`).
- `components/CoverThumb.tsx` — every cover surface (3D treatment, `flat` opt-out).
- `components/HalfStarRating.tsx` — `HalfStarRating`, `StarDisplay`, `ratingToSentiment`, `formatRating`.
- `components/RecCard.tsx` — for-you card + rationale variant pools + `UndoToast` + `LearningToast`.
- `components/RecommendationsFeed.tsx` — for-you feed + intent chips (`handleApplyIntent`) + V2 toast wiring.
- `components/RecommendBookSheet.tsx` — recommend-finished-to-friend sheet.
- `components/TasteReadout.tsx` — pure presentational "Here's what we heard" view.
- `components/HomeShortlist.tsx` — V4 top-of-Home next-read surface; read-only consumer of `getRecSession()` + `loadActedOnIds()`.
- `components/RecEntryScreen.tsx` — quick-intake (genres → avoid → outcome → taste → anchor); chip lists currently duplicated with `lib/tasteProfile.ts` maps (P0A consolidates).
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
- **Year-goal stack (per book, per year):** `user_books.year_goal_year` is a nullable integer (check 2000–2100, partial index where not null). Mutations: `setYearGoal()` in `lib/userBookActions.ts` (schema-tolerant: 42703/PGRST204 → friendly error). Home strip on `app/(tabs)/index.tsx` loads via `loadYearStack(uid)` filtered to `status in ('reading','want_to_read')`. **Reading is implicit** — three places enforce: book-detail toggle only renders when `localStatus === 'want_to_read'`; `loadYearStack` selects `or('status.eq.reading,and(status.eq.want_to_read,year_goal_year.eq.${y})')`; library Priority filter treats `status === 'reading'` as priority too. Book-detail user_books select cascades through 4 column-set fallbacks for stale Supabase projects.
- **Priority filter chip:** `app/(tabs)/library.tsx` exposes `'priority'` second (after `All`). Finished books retained in this view (vs. home strip which excludes them). Routes accept `?initialFilter=priority`.
- **Reading-progress motion (home):** yearly-goal bar (`progressAnim`) eases 0 → live pct on mount and on goal change; streak flame (`flameAnim`) loops a subtle scale pulse only when `streakValue > 0`. Both refs near top of `app/(tabs)/index.tsx`.

### For-You feed / recommendations
- **For-You intent chips → hard rules + soft boosts:** `handleApplyIntent` in `RecommendationsFeed.tsx` derives `hard` filters and `exclude` rules in addition to `soft` prefs. Soft / mood boosts use `0.12` per signal capped at `±0.30`. Mapping: `tone='light' | intensity='low' | mood∈{light_fun,palate_cleanser}` → `exclude.avoid_dark`; `mood='light_fun'` → `exclude.avoid_literary`; `mood='palate_cleanser'` → `hard.max_page_count=400` (intentionally NOT `standalone_only`). `tone='dark'` always wins over avoid_dark.
- **Want-to-Read intent matching:** `lib/intentMatcher.ts` parses queries like "short fantasy" into AND-combined `IntentSignal`s. Runs locally on every keystroke; `signalsRequireMetadata` powers an honest empty state.
- **Recommendation rationale variants:** `RecCard.tsx` builds explanations from variant pools (4 phrasings each for aligns_v2/appreciation_v2/reader-trait/subject/lane-fallback/theme-tail; 3 for author-loyalty + author-anchor `_RATED`/`_NEUTRAL`). FNV-1a hash of `book.id + pattern-tag` deterministically picks one. Banned phrasings (`"you gravitate toward"`, `"because you liked"`, `"you loved"`, `"perfect for you"`, `"consistently"`, `"always"`, `"most"`) absent from every pool.
- **Rec quick-actions card (saved-from-rec):** when `recCtx != null && !userBookId`, `app/book/[id].tsx` shows a sage card above "Why this book?" with Want to Read / Add to {year} stack / More like this / Not for me. Save path is `lib/saveBookFromRec.ts`. Every action also fires `persistFeedback`. The MLT-auto-add preference (`'always' | 'ask' | null`) lives in AsyncStorage via `lib/mltAutoaddPref.ts`; first MLT tap asks once.
- **Recommend-from-finished:** sage button in book detail Your-History card when `localStatus === 'finished'`. Reuses the existing `recommendations` table; inserts `status='sent'` + `activity_events` row. Native `Share.share` fallback always available.
- **Cold-start seeded strip is non-personalized by contract:** `lib/seededPicks.ts` is a hardcoded array (no network fetch) shown only when the For-You tier-`<1` branch sees `librarySize === 0`. Strip header always reads "POPULAR STARTING POINTS · Not personalized yet". Three invariants for any future seed entry: (a) `provenance_state='verified'` in production catalog, (b) canonical `/works/OL…W` `external_id`, (c) baked-in `id`/`title`/`author`/`cover_url`/`page_count`. Tap routes through standard `/book/[id]` and never calls `persistFeedback`. Strip never appears for users with even one `user_books` row. P2: re-validate the 6 seed external_ids quarterly.
- **Three-store deck-state invariant (current, pre-P0B):** `recSession` (in-memory), `recQueue` (in-memory `_queue` + `_pendingDismiss`), `recPayloadCache` (AsyncStorage). Any user-pref-mutation surface that wants the next deck rebuild to honor the new prefs MUST call `clearRecSession()` + `clearRecQueue()` + `void clearRecPayload(userId)` before back-nav. **This invariant goes away with P0B** (configHash mismatch self-invalidates each store on read); manual clears retained as defense-in-depth for one release post-P0B.

### Author / bibliography
- **Author bibliography (OL-catalog-only, de-bundled):** `fetchAuthorBibliography` resolves the name to a canonical OL author key via `search/authors.json` then queries `search.json?author_key=…` (the old `?author=…` query was fuzzy — Lucy Foley returned 1940s/1970s books by other Foleys); a strict `author_name` normalized-equality guard runs as backstop. Falls back to `?author=` if author lookup fails. Every doc filtered through `isBoxSet({ title })` from `lib/boxSetDetection.ts`. **No OL ratings** — Readstack ratings come from `user_books.rating`. Hero covers rank by recency.

## Product
Discovery & recommendations (with recommender credibility), library management (status, ratings, goals, gallery view), reading progress (streaks, pace, projected finish), social (sharing, friend activity, Goodreads import), edition specificity, barcode "Will I like this?", reading insights / year wraps.

## Beta-readiness
**Beta-readiness Batches 1-3 shipped (2026-05-10)** — see git history for full diffs:
- **B1:** `app/legal.tsx` + Help & Legal in `app/settings.tsx` + `app.json` build metadata. **Placeholder URLs** at `https://readstack.co/{privacy,terms}` and mailbox `hello@readstack.co` — replace before public launch (grep `TODO(beta-launch)`). `NSPhotoLibraryUsageDescription` was intentionally NOT added.
- **B2 / B4 / B6:** `saveCurrentPage` in `lib/userBookActions.ts` validates page input fail-loud (also see Gotchas); cold-start JWT fast-path in `app/_layout.tsx` writes `onboardingStage='done'` for self-healing.
- **B3 / B5:** cold-start "POPULAR STARTING POINTS" strip — see "Cold-start seeded strip" architecture bullet. `RecEntryScreen.tsx` third CTA is "Browse popular books →".

### Pre-submission backlog (must clear before App Store / Play submission)
1. Stand up live pages at `https://readstack.co/privacy` and `https://readstack.co/terms` (publicly reachable, no auth wall).
2. Confirm `hello@readstack.co` mailbox exists and is monitored.
3. Mirror the privacy URL into App Store Connect metadata.
4. Bump `ios.buildNumber` (currently `"1"`) and `android.versionCode` (currently `1`) on every TestFlight / Play upload.
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
- **Genre labels:** every genre string entering scoring/blending MUST go through `normalizeGenreInput()` from `lib/taxonomy/normalize.ts` (P0A). Never re-introduce a local `Record<string, …>` keyed on display labels — P0A exists specifically to prevent that silent-drop class. New chip surfaces derive their lists from `EDIT_GENRE_IDS` / `INTAKE_FICTION_IDS` / `INTAKE_NONFICTION_IDS` (typed `GenreId[]`). Tier-2+ explicit-pref zeroing is a separate bug (the `tier <= 1` gate at `lib/tasteProfile.ts:~754`) — fixes in P1 + P2; do not widen the gate as a spot-patch.

## Pointers
- Supabase: https://supabase.com/docs
- Open Library: https://openlibrary.org/developers/api
- React Native: https://reactnative.dev/docs
- Expo: https://docs.expo.dev/
- TypeScript: https://www.typescriptlang.org/docs/handbook/intro.html
- Google Sign-In setup: `docs/google-signin.md`
- Device testing: `docs/dev-testing.md`
