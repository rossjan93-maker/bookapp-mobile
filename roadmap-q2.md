# Readstack Planning Roadmap

## 1. Strategic thesis

### Core product thesis
Readstack should become the best book-specific decision environment, not a thin “ask AI what to read” wrapper.

The product should function as a durable system of record for:
- reader identity
- taste
- reading history
- progress
- recommendation context
- feedback loops
- eventually, semantic reader intelligence

### AI agents vs apps framing
Do not treat “AI agents replacing apps” as a reason to stop building Readstack.

Agents may become the concierge.  
Readstack should remain the hotel.

The app should become more valuable in an AI-native world because it owns:
- persistent reader memory
- trustworthy taste modeling
- progress-aware recommendations
- series continuity
- spoiler-safe social context
- strong browsing and decision UX
- structured recommendation evidence

### Product return loop
The core habit loop remains:

1. Import or add books
2. Understand reader taste
3. Recommend stronger next reads
4. Explain why
5. User acts
6. System learns
7. User comes back because the next decision feels easier and better

The recurring product question:
> What will make them come back?

---

# 2. Monetization and architecture split

## Free/Core: Recommendation Control Plane
Free Readstack must be genuinely useful, trustworthy, and responsive.

Do **not** paywall:
- recommender correctness
- preference responsiveness
- avoid/skip behavior
- coherent explanations
- cache freshness
- basic personalized recommendations
- learning from saves/skips/More Like This
- core next-read controls

The free system must:
- honor user inputs
- avoid silent dropped signals
- generate coherent recommendations
- visibly respond to preference changes
- explain itself honestly

## Paid/Premium: Semantic Intelligence Plane
Paid Readstack monetizes deeper intelligence, not basic correctness.

Premium north star:
> Find me a book I never would have thought to choose, then make me believe you’re right.

Premium capabilities may include:
- AI-generated reader thesis
- richer book intelligence
- semantic cross-genre retrieval
- “surprising but right” recommendations
- bounded AI reranking
- deeper evidence-backed explanations
- advanced next-read decision sessions
- taste-evolution insights over time

---

# 3. Long-horizon product mountaintop

Readstack may begin as a book-specific decision product, but the long-horizon Path 3 remains important:

> Readstack could eventually expand into a broader AI decision/taste layer across books, podcasts, courses, articles, films, and other consumption choices.

This is not the immediate focus.  
It is the mountain in the distance that should influence architectural optionality.

---

# 4. Current top-level priority stack

## Active now
1. Recommendation Architecture Refinement
2. ~~Finish P2 retrieval responsiveness workstream~~ ✅ product accepted 2026-05-14
3. ~~Phase 1 closeout — auth / onboarding / intake / import / account-data-lifecycle~~ ✅ accepted 2026-05-16 (see §5C-bis); FK migration `20260516000000` applied/verified 2026-05-16
4. P3A contribution-grounded ranking + explanation faithfulness (next active workstream — D1–D5 approved, gated on FK migration applied; not yet started)
5. Then retest recommendation responsiveness and explanation quality in-app
6. Then resume first-session wow work and broader UX roadmap

## Ordered roadmap after current recommender architecture work
1. Retest recommendation responsiveness and explanation quality in-app under the new architecture
2. FS-5b Taste Readout animated/reasoning reveal
3. Decide whether FS-5c optional grounded teaser/book-preview is still needed
4. FS-6 chip-band demotion if readout hierarchy still needs it
5. Pull-to-refresh cross-app audit and implementation
6. Your Next Read filter architecture and expansion
7. Revisit author chips / stated-author model only after signal semantics are clean
8. Resume parked Sentry/telemetry work when ready
9. Replit context hygiene / replit.md trim at the next natural pause if not already completed

---

# 5. Recommendation Architecture Refinement — Active Workstream

## Why this workstream exists
The recommender audit revealed that explicit Reading Taste preferences could be silently neutralized by:

- UI taxonomy mismatch
- tier gating that zeroed explicit preferences for high-signal users
- dense-user retrieval bypassing stated preferences
- avoid genres acting too weakly
- stale deck-state vulnerabilities
- missing separation between durable taste and current intent

This workstream is now the highest-priority product architecture effort.

---

## 5A. Locked architecture blueprint

### Recommendation Control Plane
The free/core recommendation system must include:

1. Canonical taxonomy
2. Typed signal provenance
3. `RecRequest` compiler
4. `BuildCause`
5. config/deck validity across all deck state
6. branch-based retrieval
7. contribution-grounded ranking
8. explanation faithfulness
9. deterministic quality gates

### Semantic Intelligence Plane
The premium system eventually adds:

1. Book Intelligence Layer
2. Reader Thesis
3. Semantic retrieval branch
4. Bounded AI reranker
5. Premium cross-evidence explanations
6. Advanced decision sessions
7. Taste evolution insights

---

## 5B. Control Plane phase status

### P0A — Canonical Genre Taxonomy Integrity ✅ shipped
Goal:
- eliminate silent unmapped genre labels
- create one canonical genre truth across UI + taste-profile computation

What shipped:
- `lib/taxonomy/genres.ts`
- `lib/taxonomy/normalize.ts`
- Edit Preferences genre chips now derive from taxonomy
- Onboarding intake genre chips now derive from taxonomy
- `tasteProfile` reads saved genre labels through normalization
- validator script added

What this fixed:
- History
- Biography
- Business
- Science
- Poetry
- Classic
- key aliases like Biography & Memoir and Sci-Fi family variants

What it did **not** fix:
- tier-2+ explicit preference responsiveness
- deck-shift guarantees

---

### P0A.1 — Retrieval-Side Taxonomy Fold-In ✅ shipped
Goal:
- remove duplicated standard-mode retrieval subject maps
- fold them into canonical taxonomy-backed retrieval structure

What shipped:
- taxonomy now owns standard affinity retrieval subjects
- `lib/recommender.ts` standard-mode retrieval now delegates to taxonomy helper
- retrieval validator extended
- dense deterministic-lane map intentionally remains separate because it is not a genre taxonomy concept

What remains separate by design:
- `DENSE_LANE_OL_SUBJECTS`
- concepts like:
  - romantasy
  - contemporary_fiction
  - modern_suspense
  - memoir_nonfiction

---

### P0B — Full Deck Validity / Config Invalidation ✅ shipped
Goal:
- recommendation deck state should self-invalidate when recommendation-relevant config changes
- eliminate reliance on every save path remembering to manually clear stale caches

What shipped:
- new `configHash` concept separate from older runtime fingerprinting
- central validity helper
- recSession validity checks
- recQueue validity checks
- stale queue-head bug structurally blocked
- multiple race conditions found and fixed

---

### P0B.1 — Persisted Restore Closure ✅ shipped
Goal:
- reject stale persisted recommendation payloads at their actual restore entry points

What shipped:
- cold-start restore path config-gated
- prewarm payloads now hash-stamped
- TOCTOU race fixed in prewarm writes
- restored sessions inherit validated hash
- persisted restore validator extended

P0B outcome:
> Stale recommendation decks are now invalid across payload/session/queue state, rather than merely relying on write-path clears.

---

### P1 — Control-Plane Signal Contract + Nonzero Stated-Preference Influence ✅ shipped
Goal:
- introduce `RecRequest` v1
- introduce typed stated/avoid signal classes
- introduce `BuildCause`
- make explicit preferences matter for high-signal users at scoring time

What shipped:
- `lib/recPolicy.ts`
- `lib/recRequest.ts`
- typed rec signal modules
- explicit preference edit build cause propagation
- recommender scoring path consumes `RecRequest`

Key behavior now live:
- stated favorite genres receive a guaranteed positive scoring floor even for tier 2+ users
- stated avoid genres receive a guaranteed negative scoring floor even for tier 2+ users
- the old “explicit prefs can have zero impact for high-signal users” failure is closed at the scoring layer

What remains deferred:
- retrieval responsiveness
- guaranteed visible deck shift
- branch planner
- top-slate reservation

---

## 5C. P2 — Retrieval Responsiveness Workstream

### Why P2 matters
P1 means:
> “Your explicit preferences score books differently.”

P2 must deliver:
> “Your explicit preferences visibly change what books enter the candidate pool and can surface in the deck.”

---

## P2 preflight conclusion
Replit correctly identified that P2 should be split.

### P2A — Branch Planner + Stated Retrieval + Dense-Bypass Replacement
Goal:
- stated favorite genres always enter candidate retrieval, including for dense/high-signal users
- dense behavior becomes one branch among several, rather than a hard bypass that erases stated preferences
- branch metadata/provenance becomes inspectable

Expected work:
- branch planner infrastructure
- statedGenres branch
- revealedLanes branch
- revealedAuthors branch
- policy-based branch priorities/quotas
- recommender retrieval orchestration delegates to planner

Important:
- no top-slate reservation yet
- no intent branch formalization yet
- no P3 scoring contributions yet

---

### P2B — BuildCause-Aware Top-Slate Reservation
Goal:
- after `explicit_preference_edit`, guarantee that at least one quality-clearing stated-branch candidate can surface in the top slate

Why separate:
- top-slate composition lives in a separate composition engine
- this is a surgical slate assembly task, not retrieval planner infrastructure

Expected behavior:
- if a user changes taste to History/Biography
- and at least one strong History/Biography candidate exists
- the rebuilt top slate should visibly reflect that edit

---

### P2C — Soft-Avoid Retrieval Deprioritization ✅ shipped
Goal:
- soft avoids must affect retrieval, not only ranking

What shipped:
- branch trigger extended to dense AND sparse paths (`softAvoidedTopGenres()`)
- curated `LIKED_SUBJECT_AVOID_GUARDS` table in `lib/recPolicy.ts`
- `lib/retrieval/softAvoidLocal.ts` demotes (never excludes) local catalog candidates by `SOFT_AVOID_RETRIEVAL_MULTIPLIER`
- `RetrievalTrace.soft_avoid_retrieval` surfaces in meta

Soft avoid means:
> “Show me less of this,” not “hard exclude this forever.”

---

### Deferred from P2
Intent branch formalization remains deferred because current intent behavior is post-retrieval filtering/reranking, not true retrieval. Formalizing it prematurely would be architectural noise.

---

### Phase 2 product acceptance ✅ 2026-05-14
P2A + P2B + P2B.1 reached "shipped" (validators green) on 2026-05-13; P2C followed on 2026-05-14. Phase 2 nonetheless did **not** reach product acceptance until later that same day, after three additional fixes:

1. **Cache-hit retrieval_reason normalization** — `stripCacheVersion()` in `lib/recommender.ts` strips the cache `v5:` prefix at restore source so AND-gate `startsWith('stated_genre:')` matches cache-restored rows.
2. **Fix A — adjacent-fit reservation widening** — `STATED_RESERVATION_POLICY.allowAdjacentForCauses: ['explicit_preference_edit']` lets `pickStatedReservation` accept `adjacent_fit` candidates after explicit edits (the user's revealed lane hasn't caught up to the just-saved edit yet).
3. **B1 — post-sort re-promotion of the reserved pick** — immediately after the EXP_QUALITY `composed.sort(...)`, splice `reservation.pick` back to index 0. The reservation AND-gate verdict was being erased by a reservation-blind quality sort that judged cache-restored stated picks on metadata richness.

Live acceptance: Reading Taste edit (Business + Mystery favorites) → save → For You. **"Darkly dreaming Dexter" appeared as slot 1.** Pre-beta gate "P2 retrieval responsiveness; visible deck shift after pref edit, dense users included" met. Full archived narrative in `docs/recently_shipped.md` § "Phase 2 product-acceptance arc".

---

## 5C-bis. Phase 1 closeout — auth / onboarding / intake / import ✅ accepted 2026-05-16

Captured as a roadmap milestone because P3A is gated on it. Five workstreams reached product acceptance:

1. **Google OAuth standalone-browser warm boot** — 10-second "Almost there…" false-freeze fixed; no token-lock warning; new Google users route into onboarding promptly.
2. **Final setup → quick taste check** — opens immediately, progresses through intake, Taste Readout appears, "See my picks" routes into For You without bounce.
3. **Quick taste → For You handoff** — completed-intake users no longer transiently see the Tier-0 "POPULAR STARTING POINTS · Not personalized yet" strip; cold-start strip reserved for genuinely empty libraries.
4. **Mid-intake refresh / resume** — live tested; refresh during intake resumes rather than bouncing to onboarding start or app home.
5. **Goodreads import** — 273-row live replay clean (273 staged → 273 linked → 271 distinct user_books; two correct intra-batch duplicate collapses). Underlying executor/stager persistence fix shipped 2026-05-15; full root-cause walkthrough lives in `docs/recently_shipped.md`.

**Skip → "let me browse"** — routing accepted, but the destination lands on a second setup-choice screen rather than the browsable Tier-0 For You surface. Deferred to the cold-start redesign workstream; **not a beta blocker** and explicitly not in scope for P3.

**Account-data-lifecycle fixes:**
- `20260515000000_account_deletion_fix_import_rows.sql` (procedural) — `DELETE FROM import_rows WHERE user_id = v_uid` BEFORE `user_books` in `delete_own_account` / `admin_reset_account` / `reset_own_data_cold` + matching Edge Function step. Applied.
- `20260516000000_import_rows_user_book_id_set_null.sql` (schema) — promotes the FK to `ON DELETE SET NULL` so deleting a single imported `user_books` row no longer raises `import_rows_user_book_id_fkey`. Audit row preserved (resolution / matched_book_id / raw_data intact). Procedural pre-step retained as defence-in-depth. Applied/verified 2026-05-16 (constraint shape confirmed in Supabase).

### Phase 1 closeout — import follow-up backlog (non-blocking, NOT P3 scope)
- "Already in Readstack" copy → rename to "Matched in our catalog" (or similar). Current copy reads as if the user already had the book.
- Import result summary should distinguish Goodreads CSV rows vs. unique catalog books (273 → 271 reads as data loss without the explanation).
- Import progress loader uses synthetic stages — eventually wire to real per-stage signals (parse / stage / match / fetch / link).
- Taste Readout evidence composition still needs refinement (over-weights single-book signals on imported users).
- For You "Currently Reading" continuation bucket label is misleading when the user has 30+ in-flight books — rename later.

---

## 5D. P3 — Score Contributions + Explanation Faithfulness
Goal:
- recommendations should explain the real reason a book won
- no explanation should cite evidence that did not actually contribute positively to rank

Required outcomes:
- score outputs become typed contribution arrays
- explanations cite real contributions
- stated vs revealed vs intent vs feedback reasons are distinguishable
- repeated rationale repetition across the top slate is reduced
- explanation audit becomes mandatory

This is the phase that moves explanations from:
> plausible templates

to:
> auditable reasoning

### P3A readiness — D1–D5 approved 2026-05-16

P3A unblocked 2026-05-16 — both prerequisites satisfied: (a) Phase 1 closeout captured in docs, and (b) migration `20260516000000_import_rows_user_book_id_set_null.sql` applied/verified in Supabase. P3A-1 foundation batch shipped same day. Five decisions locked:

- **D1 — Multi-source retrieval provenance.** Approved. Candidates carry `_retrieval_reason[]` (array, not single string). Today's single-string entry becomes the first array element; AND-gate behaviour unchanged, additive only. Required for truthful contribution attribution.
- **D2 — Fix `fetchOLByAuthor` hardcoded reason label.** Approved. Currently emits a literal `'author_anchor:'` for every book regardless of the queried author. Smallest correct fix: thread the resolved author key into the call site, emit `author_anchor:<authorKey>`. No retrieval policy change.
- **D3 — Slate diversity guard in its own file.** Approved. New `lib/composition/slateDiversity.ts`, pure function `(composed, topN, contributions) → composed`. Keeps the kind-frequency rule (reject 3rd instance of same dominant `kind` in top-N unless no alternative) testable in isolation; lets P5 plug in a richer diversity model without touching `recommender.ts` or `statedReservation.ts`.
- **D4 — Per-kind display floors live in `lib/scoring/contributions.ts`, NOT `lib/recPolicy.ts`.** Approved. Floors are explanation-faithfulness thresholds (display gating), not branch-quota / score-cap policy. Co-locating with the contribution model keeps explainability semantics together and prevents recPolicy from accreting display logic.
- **D5 — Preserve `book.reasons[]` as a derived compatibility output.** Approved. `ScoreContribution[]` becomes the authoritative reasoning surface; `book.reasons[]` is computed as a derived projection from top-K positive contributions formatted via the existing variant-pool templates so RecCard / HomeShortlist / cache-restore continue to work unchanged through the transition. RecCard rewires to `contributions[]` first-class in a follow-up phase, not P3A.

P3A scope: typed `ScoreContribution[]` attached during `scoreBookForUser`; `lib/explanations/compose.ts` reading them with per-kind display floors; slate-diversity guard wired into composition; new validator `scripts/validate_explanation_faithfulness.ts`; end-to-end fixture replay (per §5G — explanations cite real positive contributions on canonical fixtures). Do **not** start P3A work outside this scope.

---

## 5E. Semantic Intelligence Plane phases

### P4 — Semantic Intelligence Foundation
Goal:
- create the substrate for premium AI discovery

Expected components:
- `book_intelligence` model/table
- embeddings/vector strategy
- closed motif vocabulary
- structured book appeal descriptors
- reader thesis design
- offline/lazy enrichment architecture
- grounding and anti-hallucination rules

Potential book intelligence fields:
- semantic appeal vectors
- emotional tone
- intellectual density
- narrative structure
- pacing
- theme clusters
- reader appeal patterns
- “why people who love this book love it”

Potential reader thesis fields:
- motif signature
- cross-genre patterns
- contrastive motifs
- evidence books
- confidence
- thesis narrative

---

### P5 — Premium Discovery Engine
Goal:
- deliver “surprising but right” recommendations

Expected components:
- semantic retrieval branch
- bounded AI reranker
- premium cross-evidence explanations
- semantic candidates must remain grounded and within retrieved pool
- premium users see recommendations outside obvious category lanes that still connect to deeper reader appeal

Example:
A reader likes:
- Project Hail Mary
- The Martian
- Endurance
- Into Thin Air

System infers:
- competence under pressure
- operational problem-solving
- high stakes
- forward momentum

Then retrieves books outside obvious genre similarity that share those deeper motifs.

---

### P6 — Premium Insight Layer
Goal:
- create long-term subscription value beyond rec quality

Potential features:
- taste evolution over time
- “what you say you want vs. what you actually finish”
- strengthening/fading motifs
- adjacent lanes you may unexpectedly enjoy
- dynamic premium decision sessions
- three-pick decision mode:
  - safe pick
  - stretch pick
  - surprise pick

---

## 5F. Recommendation architecture quality gates

### Control Plane quality gates
Must eventually prove:

1. Zero unmapped preference labels
2. Config mismatch invalidates all deck-state stores
3. Preference edits change `RecRequest`
4. Preference edits change retrieval inputs
5. Preference edits produce top-slate delta
6. Dense users still respond to explicit edits
7. Soft avoids affect retrieval and ranking
8. Explanations match actual positive score contributions
9. No near-identical rationale repetition across top slate unless justified
10. BuildCause propagates correctly

### Semantic Intelligence quality gates
Must eventually prove:

1. Book intelligence descriptors are grounded
2. Reader thesis is stable, not erratic
3. Reader thesis claims reverse-derive into evidence books
4. Semantic retrieval surfaces cross-genre but plausibly connected books
5. AI reranker remains bounded to retrieved candidates
6. Premium explanations cite real reader/book evidence
7. Decision sessions preserve role integrity:
   - safe
   - stretch
   - surprise

---

## 5G. Phase acceptance protocol (operating standard)

Adopted 2026-05-14 in response to the Phase 2 acceptance arc. Governs all major recommender / Control Plane / Semantic Intelligence phases from P3 onward.

### Required execution sequence
For every major phase, all five steps below are required. Step 4 vs. step 5 is a *form* choice, not an opt-out — at least one of the two must produce evidence of the end-user promise.

1. **Architecture mapping** — explicit contract, interface boundaries, expected behavioral delta over the prior phase.
2. **Implementation** — code merged on green typecheck.
3. **Local contract validators** — script(s) under `scripts/validate_*.ts` that prove the unit contract synthetically; must exit 0 in CI/local before phase is "shipped". Current suite: `validate_taxonomy`, `validate_rec_validity`, `validate_rec_request`, `validate_retrieval_planner`, `validate_stated_reservation`. P3 will add an explanation-faithfulness validator.
4. **End-to-end acceptance evidence** — either (a) a fixture-replay validator that exercises the multi-stage pipeline (retrieval → scoring → composition → display) and asserts the user-visible promise on canonical fixtures, OR (b) a consolidated end-to-end trace from an instrumented live session showing the same. Mandatory for any phase whose promise crosses pipeline stages.
5. **Live smoke test** — actual app run reproducing the user-facing scenario the phase advertises. **Mandatory** for phases that promise a visible UI/deck change. Optional (but recommended) for purely backend/contract phases whose step-4 fixture replay already exercises the user-visible promise.

### Status vocabulary (load-bearing)
- **"shipped"** — code merged + all relevant local validators (step 3) green. Necessary, not sufficient.
- **"product accepted"** — the end-user promise has been demonstrated. For phases with a visible UI promise, this requires a passing step 5 live smoke (step 4 alone is not enough). For phases with a purely contract-level promise, a passing step 4 fixture replay suffices.

A phase may sit "shipped" for multiple iterations (Fix A, B1, cache normalization for P2) before reaching "product accepted". Validators going green is **not** acceptance; it is a precondition.

### Why this exists
Phase 2 reached "shipped" on 2026-05-13 with all three then-current validators green (`validate_taxonomy`, `validate_rec_validity`, `validate_stated_reservation`) and the visible deck-shift promise still failed in live use. The contract gates were correct in isolation but the reservation pick was being erased by a downstream EXP_QUALITY sort that no validator covered. Future phases must either include an end-to-end fixture replay in their validator suite or block on a live smoke before claiming acceptance.

Mirrored in `replit.md` ("Operating standard — phase acceptance protocol").

---

# 6. First-Session Experience / Onboarding Workstream

## Shipped
### V1A — Taste Readout
- route inserted after quick intake and Goodreads import success
- hedged thin-state summaries
- no fake certainty
- no LLM

### V2 — Visible Learning Feedback
- card actions visibly confirm learning
- toasts/feedback made action-to-learning loop clearer

### V3 — Anchored Explanations
- recommendation explanations grounded in:
  - liked author
  - dominant lane
  - strong genre affinity
  - subject overlap
- author phrasing softened to avoid overclaims

### V4 — Home Shortlist
- compact Home surfacing of cached recommendations
- no new fetch from Home
- freshness and acted-on filtering
- less intrusive than a full recommendation takeover

---

## UX Correction Sprint — shipped
### Trust/copy correctness
- thin-profile overclaiming gated
- explanations no longer say things like “you keep reaching for” without evidence

### More Like This clarity
- behavior clarified
- copy surfaced when MLT does not save a book
- auto-add behavior on detail surface audited

### Onboarding improvements
- liked genre multi-select clarity
- selected count line
- fiction/nonfiction/both persistence bug fixed

### Better intake questions
- avoid-genres step added
- reading outcome captured
- tone question introduced
- q_outcome / q_tone reflected in Taste Readout

### Taste Readout reflection
- avoid genres surfaced
- stronger synthesis copy shipped
- pacing key bug fixed

### FS-1 — Opening onboarding copy
- Readstack now positions itself more clearly as:
  - a next-read decision system
  - not just a tracker

### FS-5a — Taste Readout synthesis copy
- intake-only users now get more meaningful summaries
- example direction:
  > “You’re pointing Readstack toward darker speculative stories and tight thrillers that move quickly but still reward attention. We’ll steer away from business-heavy picks.”

---

## Still pending in first-session experience
### FS-5b — Animated / reasoning-style Taste Readout reveal
Goal:
- make “Here’s what we heard” feel like Readstack is forming a starting reading model
- short, premium, staged, not gimmicky
- no fake AI theater

### FS-5c — Optional grounded teaser/book preview
Decision pending after FS-5b:
- maybe useful if tied to real recommendation data
- should not fall back to fake/generic book theatre

### FS-6 — Chip-band demotion
Only if needed after readout redesign:
- chips become supporting evidence
- synthesis/reveal becomes the hero

---

# 7. Recommendation Experience Follow-Ups After P2/P3

Once the new recommender architecture is far enough along:

## Retest in app
Run strong real-product checks:
- Sci-Fi → History/Biography preference pivot
- skip genre behavior
- dense-user edit behavior
- explanation relevance
- rationale diversity
- whether the deck now visibly responds to user intent

## Explanation quality retest
FX-1 improved trait language, but recommender architecture changes may alter which reasons surface. Reassess:
- repetition
- specificity
- evidence quality
- whether recommendation reasons feel worthy of the system

---

# 8. Pull-to-Refresh Workstream

## Why it matters
Users should be able to refresh major data surfaces naturally and consistently.

## Needed audit
Define refresh semantics for:
- For You
- Home
- Library
- Profile
- Inbox/Friends
- Search if applicable

Each refresh gesture needs a clear meaning:
- rebuild recommendations?
- reload cached metrics?
- reload books/progress?
- refresh social state?
- re-read profile data?

## Desired result
A consistent cross-app refresh pattern that feels expected and does not create duplicate-fetch or stale-state regressions.

---

# 9. Your Next Read Filter Architecture / Expansion

## Why it matters
This is the product surface for **situational reading intent**.

Reading Taste = durable preference.  
Your Next Read = what I want **right now**.

## Potential future filter families
- safe vs surprising
- close fit vs stretch me
- lighter vs heavier
- short vs long
- low vs high emotional intensity
- standalone vs series
- fiction vs nonfiction
- easy to finish vs demanding
- comfort vs stimulation
- current mood / mental load
- reading occasion

## Critical sequencing
Do **not** expand the UI before the backend semantics are ready.

This work should follow:
- P1 signal contract
- P2 retrieval planner
- clearer intent architecture

---

# 10. Author Chips / Stated-Author Model

## Current status
Parked.

Reason:
- `favorite_authors` already flows into recommender pathways in ways that mix stated and revealed provenance
- this creates trust risk for copy and explanations

## Resume only after
- signal provenance is cleaner
- recommendation architecture can distinguish:
  - author I stated I like
  - author I have actually rated highly
  - author used as a retrieval/recommendation anchor

---

# 11. Reading Progress / Library / Reader Reflection Roadmap

## Progress and pacing
Planned features:
- page-level pacing
- page count/current page
- pages-per-day targets
- estimated finish date
- “ahead of schedule” states
- pace derived from actual reading behavior over time
- live insights that refresh as page updates are logged
- softer momentum framing, not guilt-driven homework

## Reading sessions
Planned:
- reading sessions / daily logs
- pages read per session
- average pages per day
- session history
- actual time-based pace learning

## Historical reflection
Planned:
- per-year reading history charts
- reading consistency heatmap
- genre coverage analysis
- author overlap analysis
- taste evolution reflections
- “what changed in my reading this year?”

## DNF graveyard
Planned:
- Did Not Finish section
- optional reason capture
- reflective learning from abandoned reads

---

# 12. Library Organization / Browsing Roadmap

## Smart organization
Planned:
- smart folders
- modular shelving
- shelves based on metadata/themes/status
- optional custom organization

## Visual browsing
Planned:
- optional gallery view for the library
- more curated “personal library” feel
- stronger cover-art emphasis

## Series awareness
Planned/partially supported:
- recommendation card should subtly indicate when a recommended starter opens a larger series opportunity
- “good taste fit + room to keep reading” is a recommendation advantage

## Cover hardening
Deferred:
- dynamic image failure fallback
- consistency across Home/Library/completed shelf/detail/manual edition

---

# 13. Discovery / Decision Features Beyond the Core Deck

## AI Taste Fit
Deferred but important:
- actual AI-powered “Will I like this?” explanation
- richer evidence-backed fit score
- weighted signal explanation
- not just surface tags

## Bookstore scanning
Planned:
- scan a physical book in-store
- receive an AI-powered taste alignment rating
- answer:
  > “Will this be good for me?”

## Invite/share flows
Parked:
- share recommendations
- invite flow
- future social hooks

## Friends’ taste overlap
Planned:
- “Alice also liked this”
- friend-overlap signals
- personalized social proof
- eventually useful for recommendation reasoning

---

# 14. Social / Network Effects Roadmap

## Existing social foundation
Already present:
- friend requests
- inbox/recommendations
- friend detail
- recommendations exchanged
- landed-rate language

## Future social product
Potential:
- friend taste overlap
- socially-informed recommendations
- book clubs/groups
- spoiler-safe social discussion
- reading circles
- recommendations trusted because they bridge people and taste

---

# 15. Production Readiness / Beta Readiness Roadmap

## Beta-critical / before broader exposure
- finish recommender Control Plane phases needed before meaningful external recommendation beta:
  - P0A ✅
  - P0A.1 ✅
  - P0B ✅
  - P0B.1 ✅
  - P1 ✅
  - P2 required
  - minimum P3 explanation-faithfulness gate required before serious external recommendation beta
- auth/onboarding integrity
- social sign-in readiness
- new-user flow QA
- import UX polish and verification
- product honesty in low-signal states
- refresh/save trust behavior
- mobile/device testing
- EAS/TestFlight readiness

## Revisit-later QA notes already tracked
- iOS/TestFlight Apple sign-in and Link Apple
- password reset deep link
- cover consistency across:
  - Home
  - Library
  - completed shelf
  - detail
  - manual edition
- add-book search speed/reliability on device

---

# 16. Production-Grade Auth / Email

## Backlog
- production-grade Supabase auth emails
- custom SMTP
- branded confirmation emails
- custom `/auth/confirm` route/flow
- premium sign-up confirmation experience

---

# 17. Legal / Compliance / Store Readiness

## Required deliverables
- privacy policy
- terms of use
- App Store data disclosures
- third-party content/IP review
- takedown process
- support contact path
- release metadata hygiene

---

# 18. Security / Data Integrity / Hardening

## Production-readiness backlog
- secrets and environment hygiene
- account lifecycle hardening, including account deletion
- verify RLS on every user-scoped table
- least-privilege policies
- server-side validation on all mutations
- rate limiting and abuse prevention
- onboarding/navigation state integrity
- recommendation system integrity
- import pipeline reliability and idempotency
- data model integrity constraints and deduping
- cache/offline/session behavior
- error handling and resilience
- observability/diagnostics
- security/dependency review
- support runbooks
- formal release checklist
- automated tests
- admin repair tooling later

---

# 19. Observability / Sentry / Telemetry

## Current status
Parked.

## Why it matters
Before meaningful external beta, we need better visibility into:
- crashes
- user-path failures
- recommendation pipeline failures
- silent data mismatches
- auth/onboarding drop-offs
- import failures
- deck invalidation issues

## Resume after
- current recommender architecture work reaches a stable pause
- P2/P3 phase direction is established

---

# 20. Technical Debt / Maintenance Tracker

Maintain a running tracker of:
- technical debt
- cleanup/refactor needs
- deferred implementation choices
- low-risk architecture improvements
- product honesty gaps

## Active examples
- `replit.md` context bloat / trim when needed
- validator scripts should eventually be CI/pre-merge where practical
- transition temporary BuildCause module-state transport into a more formal architecture if P2/P3 exposes a better path
- eventually retire defense-in-depth manual clear logic once deck validity fully proves itself in broader use

---

# 21. Immediate Next Steps — Current Decision Point

## P2 split approved in principle
We should proceed with the P2 split, not force an oversized one-shot implementation.

### Next prompt to Replit should confirm:
1. Whether soft-avoid retrieval deprioritization fits cleanly inside P2A
2. If yes:
   - include it in P2A
3. If no:
   - explicitly reserve it as P2C

### Then proceed:
- P2A — Branch Planner + Stated Retrieval + Dense-Bypass Replacement
- P2B — Top-Slate Reservation After Explicit Preference Edit
- P2C — Soft-Avoid Retrieval Deprioritization if not folded into P2A

---

# 22. Mental model for the whole roadmap

## Phase 1: Make the engine trustworthy
- taxonomy
- config validity
- stated preferences matter
- retrieval responds
- explanations are faithful

## Phase 2: Make first use feel magical
- onboarding
- Taste Readout animation
- visible understanding
- initial wow moment

## Phase 3: Make the product habit-forming
- next-read controls
- pull-to-refresh
- better progress systems
- richer reflection

## Phase 4: Make Readstack intelligent in a way others are not
- semantic book intelligence
- reader thesis
- surprising-but-right discovery
- premium next-read concierge

## Phase 5: Make it durable, safe, and launchable
- production readiness
- legal
- auth polish
- telemetry
- beta readiness
- App Store quality

---

# 23. Current one-line roadmap summary

> Build a trustworthy free recommendation control plane first, then layer in a paid semantic intelligence engine capable of surprising-but-right discovery, while continuing to sharpen first-session value, reading progress, and production readiness around that core.