# Book Recommendation App

Readstack helps users discover, track, and share personalized book recommendations.

## Run & Operate
- `npm run dev:device` — JS-only changes on device.
- `npm run build:android:dev` / `build:ios:beta` — native build.
- **Required env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OPEN_LIBRARY_API_KEY`, `GOOGLE_BOOKS_API_KEY`. Optional: `LLM_MODEL` (for `inferSubjectsLLM.ts`).
- **Migrations** live in `supabase/migrations/`. Latest applied/verified: `20260516000000_import_rows_user_book_id_set_null.sql` (FK promoted to `ON DELETE SET NULL`; constraint shape verified in Supabase 2026-05-16). Apply newer files via Supabase dashboard SQL editor in filename order.

## Stack
React Native + Expo Router, Supabase (Postgres + Auth + RLS), TypeScript, Expo build.

---

## Current focus — Recommendation Architecture Refinement

The Recommendation Architecture Spec is **locked**. Readstack operates under a dual-plane strategy:

1. **Free / core — Recommendation Control Plane.** Trustworthy, responsive to explicit input, structurally coherent, explanation-faithful, testable, cache-safe. Basic correctness is **not** paywalled.
2. **Paid / premium — Semantic Intelligence Plane.** Reader thesis, book intelligence, semantic cross-genre retrieval, bounded AI reranking, "surprising but right" discovery, advanced next-read decision sessions, taste evolution insights.

### Strategic thesis (locked)
- Free Readstack must be genuinely good — correct taxonomy, explicit-pref responsiveness, honest avoid behavior, robust deck invalidation, coherent explanations are **never** paywalled.
- Paid Readstack monetizes deeper intelligence, not basic correctness.
- The Semantic Intelligence Plane plugs into Control Plane interfaces (signal slots, branch registry, contribution sources). No recommender rewrite at the free/paid boundary.

### Pre-beta gates
- **Required before external beta:** P0A + P0A.1 + P0B + P1 + P2, plus P3 minimum (zero false-attribution reasons in fixture replay).
- **Required before paid beta:** full P3, plus P4 (Semantic Intelligence foundation) and P5 (premium discovery engine).
- Quotas, score caps, decay half-life, slot-reservation rules are **calibration hypotheses** owned by `lib/recPolicy.ts` — tunable without architectural change.

---

## Phase status (Recommendation Architecture)

**Current state.** `recValidity.VERSION = rcv6`. Final visible-deck Intent Lens gate enforced at the queue boundary (`lib/intent/finalGate.ts`). Composer admits three P4C kinds (`tone_fit`, `pace_fit`, `series_continuation_fit`) into visible `book.reasons[]` under per-kind gates; the other four P4C kinds (`current_intent_fit`, `complexity_fit`, `avoidance_conflict`, `not_right_now_risk`) remain suppressed. BookEvidence Batch C slice C0 ships `intensity` + `emotionalWeight` as **shadow-mode-only** AxisMatch fields on `BookEvidence` — observed via a top-10-deck `[BOOK_EVIDENCE_C]` DEV log, never consumed by any gate, ranking input, composer reason, or RecCard surface. Validator suite (11 scripts) is the load-bearing acceptance gate for hard-exclusion + explanation-faithfulness + shadow-axis-isolation contracts; see "Operating standard" below.

| Phase | Status | Pointer |
|---|---|---|
| P0A / P0A.1 · canonical taxonomy + retrieval fold-in | ✅ shipped | `lib/taxonomy/genres.ts`, `normalize.ts`, `getRetrievalSubjects` |
| P0B / P0B.1 · deck-validity configHash | ✅ shipped | `lib/recValidity.ts`; manual 3-store clear in `app/edit-preferences.tsx` retained as defense-in-depth |
| P1 · signal contract + non-zero stated-pref floor | ✅ shipped | `lib/recPolicy.ts` `STATED_TASTE_POLICY` + `lib/recRequest.ts` + `lib/recSignals/` |
| P2A · branch planner | ✅ shipped | `lib/retrieval/branchPlanner.ts`, branch modules, `BRANCH_QUOTAS`, `EDIT_CAUSE_BRANCH_BOOST` |
| P2B / P2B.1 · top-slate reservation + provenance AND-gate | ✅ shipped | `lib/composition/statedReservation.ts` |
| P2C · soft-avoid retrieval deprioritization | ✅ shipped | `softAvoidedTopGenres()`, `LIKED_SUBJECT_AVOID_GUARDS`, `lib/retrieval/softAvoidLocal.ts` |
| Phase 2 product acceptance | ✅ product accepted — 2026-05-14 | live: pref edit visibly shifts top slate. Detail → `docs/recently_shipped.md` |
| Phase 1 closeout (auth / onboarding / intake / import) | ✅ product accepted — 2026-05-16 | OAuth standalone-browser warm boot; Goodreads 273-row replay clean; migration `20260516000000_import_rows_user_book_id_set_null.sql` applied/verified. Detail → `docs/recently_shipped.md` |
| P3A · contribution-grounded ranking + explanation faithfulness | ✅ product accepted — 2026-05-16 | Composer-backed `book.reasons[]` is production default; `recValidity.VERSION = rcv4` at acceptance. Detail → `docs/recently_shipped.md` |
| P4C.1 · limited ranking influence (7 P4C kinds, ±0.20/±0.30 caps) | ✅ product accepted — 2026-05-18 | `recValidity.VERSION = rcv5`. Composer suppression unchanged at this batch; visible copy byte-identical pre-P4D. Detail → `docs/recently_shipped.md` (+ follow-ups #5/#6/#7) |
| BookEvidence Batch A · shared evidence signal map | ✅ shipped — 2026-05-18 | `lib/evidence/signals.ts` extracted from `nextReadIntent.ts`; word-boundary matching; `recValidity.VERSION = rcv5` unchanged. Detail → `docs/recently_shipped.md` |
| Intent Lens Eligibility Stabilization (Option D + Resolution A) | ✅ accepted and closed — 2026-05-18 | `lib/intent/finalGate.ts` — final visible-deck gate at queue boundary; gate applies to continuations too (truly-dark next-in-series IS excluded under No-dark). Validator `scripts/validate_intent_final_gate.ts` is primary acceptance gate for future hard-exclusion work. Detail → `docs/recently_shipped.md` |
| P4D-followup · persistent rec cache lens-bypass closeout | ✅ shipped — 2026-05-18 | Writer + reader symmetric guard against restoring lens-tagged decks. Detail → `docs/recently_shipped.md` |
| Forensic DEV log cleanup | ✅ shipped — 2026-05-18 | Removed 11 path-by-path `[INTENT_*]` traces; kept `[FINAL_GATE]`, `[FINAL_GATE_LEAK]`, `[PERSIST_CACHE] skip_lens_tagged` / `lens_tagged_payload`. Detail → `docs/recently_shipped.md` |
| **P4D · narrow composer admission** | ✅ **product accepted — 2026-05-18** (validator-authoritative) | Composer admits `tone_fit` / `pace_fit` / `series_continuation_fit` into visible `book.reasons[]` under strict gates. **Still suppressed**: `current_intent_fit`, `complexity_fit`, `avoidance_conflict`, `not_right_now_risk` (absent from PRIMARY/SECONDARY_PRIORITY — structurally unreachable). Tone/pace gates: `sum > 0`, `Math.abs(sum) ≥ DISPLAY_FLOORS[kind]` (0.04), `evidence.book{Tone,Pace}Confidence === 'specific'`, `evidence.signedEligible === true`, `evidence.match === 'match'`. Series gate: above floor, `evidence.priorReadCount > 0`, `evidence.continuesPrior === true`. SECONDARY_PRIORITY runs after PRIMARY, MAX_SECONDARY=1 — no displacement of legacy `stated_taste_fit` / `behavioral_fit` / `feedback_fit`. Phrasings: "Lighter/Darker tone, in line with your current intent" / "Faster pace/Slow-burn pacing, in line with your current intent" / "Next in {seriesName}". `recValidity.VERSION = rcv6`. Pinned by `validate_explanation_faithfulness §P4D-1..§P4D-7`. Follow-up live gate (when fresh signed-in onboarded state is available): confirm a `tone=light`+`energy=light_fun` lens surfaces an admitted P4D reason with `bookToneConfidence === 'specific'` evidence. Full acceptance prose → `docs/recently_shipped.md`. |
| P4 · semantic intelligence foundation | ⏳ future | hard-avoid UI + storage lands here; first opportunity to retire the legacy reasons builder. **BookEvidence Batches B + C** scheduled as P4 hygiene (below). |
| BookEvidence Batch B · typed `deriveBookEvidence` classifier entry point | ✅ shipped — 2026-05-18 | `lib/evidence/bookEvidence.ts` is the sole classifier entry point; `getBookTraits` + `evaluateBookAgainstIntentLens` both consume it; tone/pace/complexity signal constants migrated out of `bookTraits.ts` into `lib/evidence/signals.ts` as exported `SignalSet`s with the `partitionBySpecificity` rule pre-applied at authoring time. Byte-identical behavior pinned by `scripts/validate_book_evidence.ts` (222 assertions, §1–§9). `recValidity.VERSION = rcv6` unchanged. Contract-only acceptance (no UI surface). Detail → `docs/recently_shipped.md` |
| BookEvidence Batch C · slice C0 — shadow-mode `intensity` + `emotionalWeight` | ✅ shipped — 2026-05-18 (contract-only) | `lib/evidence/signals.ts` ships `INTENSITY_HIGH/LOW` + `EMOTIONAL_WEIGHT_HIGH/LOW` SignalSets under the partitionBySpecificity-at-authoring rule (phrasal=specific, single-token=broad). `lib/evidence/bookEvidence.ts` BookEvidence gains four optional AxisMatch fields (`intensityHigh`, `intensityLow`, `emotionalWeightHigh`, `emotionalWeightLow`), populated by `deriveBookEvidence` against the SEMANTIC corpus. `lib/recommender.ts` emits one `[BOOK_EVIDENCE_C]` DEV log line per book in the top-10 visible deck only (bucket projection: `spec≥1 → spec; broad≥2 → broad; conflicting strong → medium/broad; else unknown`). **Observation-only** — no ranking, composer, RecCard, or No-dark consumption. Pinned by `scripts/validate_book_evidence_intensity.ts` (122 assertions, §1 authoring rule / §2 shape / §3 12-fixture matrix / §4 bucket invariants / §5 carry-forward diagonal / §6 memoir-trap / §7 grief-class single-broad isolation) + `scripts/validate_no_dark_isolation.ts` (73 assertions: source-grep `finalGate.ts` + `evaluateBookAgainstIntentLens` avoid_dark branch + composer/RecCard surface for zero refs to new axes; 7×4 fixture-replay byte-identity on `hardExclusions`). `recValidity.VERSION = rcv6` unchanged. Detail → `docs/recently_shipped.md`. **Slice C1+ (admission into ranking/composer) requires its own approval.** |

Verbose prose for every shipped phase lives in `docs/recently_shipped.md`. Catalog subsystem history (P0 / P0.5 / P1.5a/b series) lives in `docs/catalog_subsystem.md`. Full file inventory lives in `docs/file_inventory.md`.

### Validator suite (current; load-bearing for acceptance)
11 scripts under `scripts/`, all required green before any acceptance:
- `validate_intent_final_gate` — queue-boundary hard-exclusion invariant (primary gate for hard-exclusion work)
- `validate_intent_lens` — Intent Lens hard-exclusion fixture matrix (13 fixtures × 4 lenses; 52 hardExclusion assertions)
- `validate_p4c_limited_ranking` — per-kind ±0.20 / stack ±0.30 caps + stated-taste floor protection
- `validate_intent_contribution`, `validate_tone_pace_fit`, `validate_series_continuation` — upstream P4C signed-eligibility derivation
- `validate_explanation_faithfulness` — composer purity, suppressed-kinds structural invariant, P4D-1..P4D-7 (load-bearing for P4D)
- `validate_book_evidence` — Batch B byte-identity contract (222 assertions, §1–§9)
- `validate_book_evidence_intensity` — Batch C slice C0 shadow-mode `intensity` + `emotionalWeight` contract (122 assertions; 12-fixture × 2-axis matrix + memoir-trap + grief-class single-broad isolation)
- `validate_no_dark_isolation` — Batch C slice C0 invariant: `finalGate.ts` + `evaluateBookAgainstIntentLens` avoid_dark branch + composer/RecCard contain ZERO refs to `intensity` / `emotionalWeight`; 7×4 fixture-replay hardExclusions byte-identity (73 assertions)
- `validate_rec_validity` — `recValidity.VERSION = rcv6` hash determinism + assertCurrent semantics
- `validate_rec_payload_cache_lens` — lens-tagged cache discard contract

Sibling validators retained but not in the active acceptance loop: `validate_taxonomy`, `validate_rec_request`, `validate_retrieval_planner`, `validate_stated_reservation` (pre-existing `__DEV__` errors in two of these are unrelated to current batches; do not gate acceptance).

### Hard invariants (do not weaken without a planning-first chapter)
- **Intent Lens final gate** (`lib/intent/finalGate.ts`) applies to ALL producer paths (cold restore, fresh build, foreground/background append, exhaustion bypass) AND to both buckets (discoveries + continuations — Resolution A). Pinned by `validate_intent_final_gate §7` catch test.
- **No-dark / Less-dark / temporary lens semantics**: lens is session-only, never persisted, never durable. No-dark hard-excludes; Less-dark bounded-demotes only (never hard-removes). Pinned by `validate_intent_final_gate §3` + `validate_intent_lens §10`.
- **No title blacklists outside fixtures.** Title-specific exclusions live only in validator fixtures, never in runtime code paths.
- **BookEvidence Batch C slice C0 is shadow-mode only.** `intensity` / `emotionalWeight` axes are populated on `BookEvidence` but MUST NOT feed any No-dark gate, ranking input, composer reason, or RecCard surface. Slice C1+ (admission into ranking / composer copy) requires its own planning chapter + approval. Pinned by `validate_no_dark_isolation`. (Batch B shipped 2026-05-18; Batch C C0 shipped 2026-05-18.)
- **recValidity stays rcv6** for any non-scoring-shape change. Bump only when contribution shape changes.

### Known open quality issues (not blocking P3)
- **`Business` chip → broad `nonfiction` retrieval anchors** — Per P0A `affinityKey`, `Business` (and `Self-Help`, `History`, `Politics`, `Science`, `Reference`, `Health`) all collapse to `nonfiction`, whose `AFFINITY_RETRIEVAL_SUBJECTS` are `popular science` + `popular nonfiction`. Sub-affinity granularity is P4 territory (book intelligence / appeal vectors); do NOT spot-patch by adding business-only anchors before then.
- **BuildCause browser-refresh persistence** — `setPendingBuildCause` is module-state only. A hard browser refresh between save and For-You nav loses the cause and the rebuild runs as `session_open`. Documented for when we revisit cross-session cause persistence.

### Parked / explicitly deferred
- **Sentry / analytics instrumentation** — out of scope across the current stream.
- **Author chips / stated-author model** — `lib/tasteProfile.ts:711-726` mixed-provenance merge stays until P1-style signal provenance lands for authors.
- **MLT auto-add settings UI** — `lib/mltAutoaddPref.ts` AsyncStorage pref exists; no settings-screen toggle.
- **B3 Goodreads import-success routing polish** — current routing acceptable.
- **Hard avoid ("never recommend X") UI + storage** — ships in P4 with finalized storage decision.
- **V1A anchor-book name acknowledgement** — TasteReadout intentionally LLM-free and unnamed.
- **V4 thin-state proxy** — `librarySize = currentReads.length + yearStack.length` (acceptable trade-off; swap to `tasteProfile.tier` later if Home loads it).
- **V4 shortlist reasons use `reasons[0]`** (raw, not V3 `buildExplanation`); tap-through writes `evidenceTags: []`.
- **Skip → "let me browse" destination UX** — routing passes (no bounce), but the destination is a second setup-choice screen rather than the browsable Tier-0 For You surface. Defer to cold-start redesign; not a beta blocker.
- **Preference-edit responsiveness polish (Scenario D note, 2026-05-16).** After saving a Reading Taste edit, the Profile pills do not update instantaneously and the For You deck is slow (but eventually correct) to reflect the edit. Did NOT block P3A product acceptance — deck did rebuild and reasons were faithful — but the lag is user-visible. Likely candidates: Profile screen consumes a stale `tasteProfile` snapshot (no subscription to the edit event), and the For You rebuild waits on the next focus/refresh cycle instead of being triggered by `BuildCause=explicit_preference_edit` synchronously. Treat as responsiveness/state-sync polish, not a recommender correctness bug. Out of scope for P3B; schedule as its own small batch.
- **Current Intent Layer follow-up (post-P3A).** Quick-taste onboarding captures more than genres — reading purpose / escape, tone, pacing, light-vs-heavy, "less of X" avoids, anchor-book picks. Today's composer reasons reflect mostly genre / stated-category signals; tone / pacing / intent inputs influence retrieval and scoring (`handleApplyIntent` → soft / hard / exclude rules) but do NOT produce typed `ScoreContribution[]` entries the composer can cite as evidence. Acceptable for P3A scope (no contribution evidence to faithfully cite). Required follow-up before P3 closes fully: (1) audit every quick-taste answer and map which surface — retrieval / scoring / ranking / explanation — it currently affects; (2) any input the Taste Readout shows the user must either influence the first deck OR be clearly disclosed as "early signal, will improve"; (3) pace / tone / intent must become first-class scoring + explanation signals (mapped to `current_intent` signal class per the locked P1 signal contract), not onboarding decoration. Do NOT implement Current Intent Layer changes inside the P3A live-smoke remediation stream — schedule as its own batch after P3A is product accepted.

### Import follow-up backlog (Phase 1 closeout, non-blocking)
Tracked here so they don't get re-discovered as bugs during P3:
- "Already in Readstack" copy → rename to "Matched in our catalog" (or similar) — current copy reads as if the *user* already has the book.
- Import result summary should distinguish Goodreads CSV rows vs. unique catalog books (273 → 271 reads as data loss without the explanation).
- Import progress loader uses synthetic stages — eventually wire to real per-stage signals (parse / stage / match / fetch / link).
- Taste Readout evidence composition still needs refinement (over-weights single-book signals on imported users).
- For You "Currently Reading" continuation bucket label is misleading when the user has 30+ in-flight books — rename later (not before P3).

---

## Operating standard — phase acceptance protocol

For all major recommender / Control Plane / Semantic Intelligence phases, the required execution sequence is (all five steps required; step 4 vs. step 5 is a *form* choice, not an opt-out):

1. **Architecture mapping** — explicit contract, interface boundaries, expected behavioral delta over the prior phase.
2. **Implementation** — code merged on green typecheck.
3. **Local contract validators** — script(s) under `scripts/validate_*.ts` that prove the unit contract synthetically; must exit 0 before phase is "shipped". Current suite: `validate_taxonomy`, `validate_rec_validity`, `validate_rec_request`, `validate_retrieval_planner`, `validate_stated_reservation`.
4. **End-to-end acceptance evidence** — either (a) a fixture-replay validator that exercises the multi-stage pipeline (retrieval → scoring → composition → display) and asserts the user-visible promise on canonical fixtures, OR (b) a consolidated end-to-end trace from an instrumented live session showing the same. Mandatory for any phase whose promise crosses pipeline stages.
5. **Live smoke test** — actual app run reproducing the user-facing scenario. **Mandatory** for phases with a visible UI/deck promise. Optional (but recommended) for purely contract-level phases whose step-4 fixture replay already exercises the user-visible promise.

**Status vocabulary (load-bearing):**
- **"shipped"** — code merged + all relevant validators (step 3) green. Necessary, not sufficient.
- **"product accepted"** — end-user promise demonstrated. Visible-UI phases require a passing step 5 live smoke (step 4 alone is not enough). Contract-only phases may rely on a passing step 4 fixture replay.

Phase status table above uses both terms intentionally. A phase may sit "shipped" for multiple iterations before reaching "product accepted". Validators going green is **not** acceptance; it is a precondition. (Origin story — Phase 2 sat shipped/green for ~24 hours while the user-visible promise still failed because no validator covered the cross-stage reservation-survival path — lives in `docs/recently_shipped.md`.) Mirrored in `roadmap-q2.md` §5G.

---

## Recommendation Architecture (locked blueprint — concise)

Live operating reference for the architecture P0A→P6 implements.

- **Canonical taxonomy** (P0A): `lib/taxonomy/genres.ts` is the single source of truth for `GenreDef { id, uiLabels{edit/intake/cardTag/aliasInputs}, affinityKey, olSubjects, laneTag, fictionality }`. Adding a chip without a `GenreDef` becomes a typecheck failure. `normalizeGenreInput()` is the only legal entry of genre strings.
- **Typed signal provenance** (P1): six classes — `stated_durable`, `revealed_behavioral`, `soft_avoid`, `hard_avoid` (reserved), `current_intent`, `short_term_feedback`. Each carries source + confidence + decay policy + retrieval/ranking/explanation eligibility.
- **`RecRequest` compiler** (P1): single typed object compiling all signals + policy + `BuildCause` + `configHash` + `schemaVersion`. `BuildCause ∈ { session_open, manual_refresh, explicit_preference_edit, intent_apply, intent_clear, feedback_action, onboarding_completion }`.
- **Deck validity** (P0B): `configHash` carried by all three stores (`recPayloadCache`, `recSession`, `recQueue`); central `lib/recValidity.ts` `assertCurrent()` check at every read.
- **Branch-based retrieval** (P2): `lib/retrieval/branchPlanner.ts` always runs `revealed_lanes`, `revealed_authors`, `stated_genres`, `stated_authors`, `intent`, `exploration`, `feedback` branches. **`stated_genres` quota is never zero while the user has any mapped favorite_genre** — including dense users. Soft avoid deprioritizes within branches; hard avoid (P4) is global pre-branch exclusion.
- **Stated reservation** (P2B/P2B.1, post-acceptance shape): `lib/composition/statedReservation.ts` AND-gates retrieval provenance (`_retrieval_reason.startsWith('stated_genre:')`) AND scoring provenance (`audit_flags` contains `stated_favorite:<key>` AND `stated_taste > 0`). `STATED_RESERVATION_POLICY.allowAdjacentForCauses` widens fit-class eligibility for `explicit_preference_edit`. After EXP_QUALITY composed.sort, the reserved pick is re-promoted to index 0 (P2 B1) so the AND-gate verdict is not erased by a reservation-blind sort.
- **Contribution-grounded ranking** (P3, next): scoring produces typed `ScoreContribution[] { source, kind, value, evidence }`. Components: `behavioral_fit`, `stated_taste_fit` (+0.05 floor at all tiers), `intent_fit`, `quality_reliability`, `feedback_fit`, `novelty_diversity`, `soft_avoid_penalty`, `repetition_suppression`, `hygiene_floor`.
- **Explanation faithfulness** (P3): `lib/explanations/compose.ts` reads contributions. **No reason emitted without a corresponding positive contribution above a per-kind floor.** Slate diversity guard rejects 3rd instance of same `kind` in top-4 unless no alternative.
- **Quality gates** (CI from introducing phase): A1 zero-unmapped-labels (P0A), A2 configHash invalidates all 3 stores (P0B), A3 pref edit changes RecRequest (P1), A4–A6 retrieval/top-4 deltas including dense (P2), A7 soft avoid in retrieval+ranking (P2), A8 zero false-attribution reasons (P3 minimum), A9 slate diversity (P3 full), A10 BuildCause propagation (P1).
- **Semantic Intelligence hooks** kept open in Control Plane so P4–P6 plug in additively: `RecRequest.signals` is open record; branch registry accepts `semantic_appeal` (disabled-by-default in free); contribution model accepts `semantic_rerank` and `premium_evidence_match` sources.

---

## Where things live

The full file inventory lives in `docs/file_inventory.md`. The few files genuinely needed for next-phase (P3) execution context:

- `lib/recommender.ts` — recommender (contains `FORENSIC_USER_ID`); P3 scoring contributions and EXP_QUALITY sort/re-promotion site.
- `lib/recPolicy.ts` — all policy constants (stated taste, branch quotas, edit-cause boost, stated reservation including `allowAdjacentForCauses`).
- `lib/recRequest.ts` / `lib/recSignals/` — typed signal contract; P3 contribution arrays attach here.
- `lib/composition/statedReservation.ts` — top-slate reservation AND-gate.
- `lib/retrieval/branchPlanner.ts` + `lib/retrieval/branches/*` — branch planner and branch modules.
- `lib/recValidity.ts` — configHash producer + restore gate.
- `lib/taxonomy/genres.ts` + `lib/taxonomy/normalize.ts` — canonical taxonomy + sole legal entry point.
- `components/RecCard.tsx` — for-you card; explanation surface that P3 will rewire.
- `components/RecommendationsFeed.tsx` — for-you feed; bootstrap path that runs the pipeline.
- `app/edit-preferences.tsx` — Reading Taste editor (manual 3-store clear retained as defense-in-depth).
- `scripts/validate_taxonomy.ts`, `scripts/validate_rec_validity.ts`, `scripts/validate_rec_request.ts`, `scripts/validate_retrieval_planner.ts`, `scripts/validate_stated_reservation.ts` — current validator suite. P3 introduces an explanation-faithfulness validator + an end-to-end fixture replay (per the operating standard above).

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
- **Priority filter chip:** `app/(tabs)/library.tsx` exposes `'priority'` second (after `All`). Finished books retained in this view. Routes accept `?initialFilter=priority`.
- **Reading-progress motion (home):** yearly-goal bar (`progressAnim`) eases 0 → live pct; streak flame (`flameAnim`) loops a subtle scale pulse only when `streakValue > 0`.

### For-You feed / recommendations
- **For-You intent chips → hard rules + soft boosts:** `handleApplyIntent` in `RecommendationsFeed.tsx` derives `hard` filters and `exclude` rules in addition to `soft` prefs. Soft / mood boosts use `0.12` per signal capped at `±0.30`. Mapping: `tone='light' | intensity='low' | mood∈{light_fun,palate_cleanser}` → `exclude.avoid_dark`; `mood='light_fun'` → `exclude.avoid_literary`; `mood='palate_cleanser'` → `hard.max_page_count=400`. `tone='dark'` always wins over avoid_dark.
- **Want-to-Read intent matching:** `lib/intentMatcher.ts` parses queries like "short fantasy" into AND-combined `IntentSignal`s. Runs locally on every keystroke; `signalsRequireMetadata` powers an honest empty state.
- **Recommendation rationale variants:** `RecCard.tsx` builds explanations from variant pools (4 phrasings each for aligns_v2/appreciation_v2/reader-trait/subject/lane-fallback/theme-tail; 3 for author-loyalty + author-anchor `_RATED`/`_NEUTRAL`). FNV-1a hash of `book.id + pattern-tag` deterministically picks one. Banned phrasings (`"you gravitate toward"`, `"because you liked"`, `"you loved"`, `"perfect for you"`, `"consistently"`, `"always"`, `"most"`) absent from every pool. **P3 will rewire the rationale-source side of this from variant pools toward contribution-grounded copy templates.**
- **Rec quick-actions card (saved-from-rec):** when `recCtx != null && !userBookId`, `app/book/[id].tsx` shows a sage card above "Why this book?" with Want to Read / Add to {year} stack / More like this / Not for me. Save path is `lib/saveBookFromRec.ts`. Every action also fires `persistFeedback`. The MLT-auto-add preference (`'always' | 'ask' | null`) lives in AsyncStorage via `lib/mltAutoaddPref.ts`; first MLT tap asks once.
- **Recommend-from-finished:** sage button in book detail Your-History card when `localStatus === 'finished'`. Reuses the existing `recommendations` table; inserts `status='sent'` + `activity_events` row. Native `Share.share` fallback always available.
- **Cold-start seeded strip is non-personalized by contract:** `lib/seededPicks.ts` is a hardcoded array (no network fetch) shown only when the For-You tier-`<1` branch sees `librarySize === 0`. Strip header always reads "POPULAR STARTING POINTS · Not personalized yet". Three invariants for any future seed entry: (a) `provenance_state='verified'` in production catalog, (b) canonical `/works/OL…W` `external_id`, (c) baked-in `id`/`title`/`author`/`cover_url`/`page_count`. Tap routes through standard `/book/[id]` and never calls `persistFeedback`. Strip never appears for users with even one `user_books` row. Re-validate the 6 seed external_ids quarterly.
- **Three-store deck-state invariant (post-P0B):** `recSession` (in-memory), `recQueue` (in-memory `_queue` + `_pendingDismiss`), `recPayloadCache` (AsyncStorage) all carry `configHash` and self-invalidate on mismatch. Manual three-store clear in `app/edit-preferences.tsx` retained as defense-in-depth.

### Author / bibliography
- **Author bibliography (OL-catalog-only, de-bundled):** `fetchAuthorBibliography` resolves the name to a canonical OL author key via `search/authors.json` then queries `search.json?author_key=…` (the old `?author=…` query was fuzzy); a strict `author_name` normalized-equality guard runs as backstop. Falls back to `?author=` if author lookup fails. Every doc filtered through `isBoxSet({ title })` from `lib/boxSetDetection.ts`. **No OL ratings** — Readstack ratings come from `user_books.rating`. Hero covers rank by recency.

## Product
Discovery & recommendations (with recommender credibility), library management (status, ratings, goals, gallery view), reading progress (streaks, pace, projected finish), social (sharing, friend activity, Goodreads import), edition specificity, barcode "Will I like this?", reading insights / year wraps.

## Beta-readiness
Batches 1-3 shipped 2026-05-10 (`app/legal.tsx`, Help & Legal in `app/settings.tsx`, `app.json` build metadata, fail-loud `saveCurrentPage`, cold-start JWT self-healing, "POPULAR STARTING POINTS" strip). Full detail in git history. **Placeholder launch URLs** (`https://readstack.co/{privacy,terms}`, mailbox `hello@readstack.co`) — grep `TODO(beta-launch)` before public launch. `NSPhotoLibraryUsageDescription` intentionally NOT added.

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
- **Goodreads dedup:** title+author guard in `lib/goodreadsExecutor.ts` prevents duplicate book rows. Both stager and executor strip parenthetical/colon/dash subtitle suffixes before keying ("Royal Assassin (Farseer Trilogy, #2)" ↔ "Royal Assassin"); without it, series-suffixed Goodreads titles silently miss the catalog match. Catalog dedup remains P1.5a-gated (`provenance_state IN ('verified','legacy') OR provenance_inserted_by = userId`) — do not widen the gate.
- **Goodreads import persistence (2026-05-15 fix, accepted 2026-05-16):** bulk inserts to `books` and `user_books` are atomic per PG statement, so a single failing row used to drop the whole 100-row chunk. Executor now re-keys bulk results by normalised title+author (RLS-silent-filter safe), per-row fallback on chunk failure, `.upsert({onConflict:'user_id,book_id', ignoreDuplicates:true})` for user_books, counter increments only after post-fetch confirms a real `user_books.id`, intra-batch duplicate-collapsed rows demoted to `resolution='skipped'`, `matched_book_id` written back from executor recovery. Validator: `scripts/validate_goodreads_import_persistence.ts`. Live 273-row replay clean. Full root-cause + fix detail in `docs/recently_shipped.md`.
- **`import_rows.user_book_id` FK is `ON DELETE SET NULL` (migration `20260516000000`, applied/verified 2026-05-16):** deleting a single imported `user_books` row nulls out `import_rows.user_book_id` instead of raising `23503 import_rows_user_book_id_fkey`. The audit row is preserved (resolution / matched_book_id / raw_data intact) so "this CSV line was imported, the resulting library entry was later removed" stays queryable. The pre-existing explicit `DELETE FROM import_rows WHERE user_id = v_uid` step in `delete_own_account` / `admin_reset_account` / `reset_own_data_cold` (migration `20260515000000`, applied) is kept as defence-in-depth — do **not** remove it; correctness of those functions should not couple to schema state.
- **Native changes:** run `npm run build:android:dev` (or iOS equivalent), not just a JS reload.
- **Top-of-screen padding:** new full-screen routes must use `useScreenTopPadding()` — never bare `SafeAreaView` (no-op on web/Android) and never hardcoded `paddingTop: 56/60`.
- **Friend-request ingress is RPC-only:** direct INSERT on `friendships` is REVOKED. All sends route through `sendFriendRequest()` in `lib/friendshipActions.ts` → `public.send_friend_request(p_addressee_id)` SECURITY DEFINER RPC. RPC enforces no-self, addressee-exists, canonical-pair dedup, and per-requester pending cap of 50 (raises SQLSTATE 53400 with prefix `FRIEND_REQUEST_PENDING_CAP_EXCEEDED`). Cap is race-safe via `pg_advisory_xact_lock(hashtext(v_uid::text))`. INSERT is wrapped in an exception block that catches `unique_violation` and re-raises as `FRIEND_REQUEST_DUPLICATE`. Cancel / decline / unfriend route through `deleteFriendship()` (plain DELETE; RLS allows either party to delete). **Never re-add a direct INSERT policy on `friendships` — it would bypass the cap.**
- **`current_page` validation is fail-loud:** column-level CHECK enforces `current_page >= 0`; trigger `_user_books_validate_current_page` raises `CURRENT_PAGE_EXCEEDS_PAGE_COUNT` (SQLSTATE 23514) when `current_page > books.page_count` (only when both are known). Code that writes `current_page` must clamp upstream — the trigger does NOT clamp silently.
- **Catalog gotchas (Books INSERT guardrail, reconciler service-role key, attempt-count semantics, terminal classification, lock primitive, mergeFields invariant, multi-column UPDATE atomicity):** see `docs/catalog_subsystem.md` §7-§13.
- **User-text length CHECK constraints:** `recommendations.note <= 2000`, `user_books.review_body <= 10000`, `user_books.private_note <= 5000`, `book_club_comments.body <= 2000`. Violations are SQLSTATE 23514.
- **Metro `FallbackWatcher` ENOENT crash (dev-environment noise):** workflow can die seconds after the first bundle with `ENOENT … watch '.local/skills/.old-delegation-*'`. Race between Metro's recursive `fs.watch()` and the agent runtime cleaning up its own temp dirs. Not an app/catalog/runtime issue; native dev/prod builds unaffected. Remediation: restart the workflow.
- **Genre labels:** every genre string entering scoring/blending MUST go through `normalizeGenreInput()` from `lib/taxonomy/normalize.ts` (P0A). Never re-introduce a local `Record<string, …>` keyed on display labels — P0A exists specifically to prevent that silent-drop class. New chip surfaces derive their lists from `EDIT_GENRE_IDS` / `INTAKE_FICTION_IDS` / `INTAKE_NONFICTION_IDS` (typed `GenreId[]`).
- **Reservation pin survives EXP_QUALITY sort (P2 B1):** in `lib/recommender.ts` immediately after the EXP_QUALITY `composed.sort(...)`, a re-promotion block splices `reservation.pick` back to index 0 if it exists. **Do not delete this block** when refactoring scoring — it enforces the P2B contract that the AND-gate reservation verdict is not erased by the reservation-blind quality sort. When P3 contribution-grounded ranking lets stated picks earn 'strong' organically, this becomes a silent no-op without removal.

## Pointers
- Supabase: https://supabase.com/docs
- Open Library: https://openlibrary.org/developers/api
- React Native: https://reactnative.dev/docs
- Expo: https://docs.expo.dev/
- TypeScript: https://www.typescriptlang.org/docs/handbook/intro.html
- Google Sign-In setup: `docs/google-signin.md`
- Device testing: `docs/dev-testing.md`
- Recommender history: `docs/recently_shipped.md`
- File inventory: `docs/file_inventory.md`
- Roadmap & phase-acceptance protocol: `roadmap-q2.md` §5G
