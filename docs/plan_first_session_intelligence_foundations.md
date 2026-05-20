# First-Session Intelligence Foundations — Intake Density · Cold-Start Retrieval · Lens Vocabulary

**Status:** Planning-only chapter. No product changes in this turn. No `recValidity` bump. Phase 2 steering remains deferred.

**Origin:** Reinterpretation of the 2026-05-20 `[LENS_ARBITRATION]` 5-scenario observation capture (`.local/lens_arb_logs/REPORT.md`) after the user surfaced that the forensic profile was effectively a **sparse-profile / cold-start user** — no Goodreads / StoryGraph import, little completed-read history, minimal onboarding, durable taste limited to `Mystery + Thriller (skip Horror)`. The earlier routing verdict ("calibrate BookEvidence first") was correct as a *signal-quality* finding but framed against the wrong baseline (mature-profile recommender). This chapter re-frames against the right baseline and orders the resulting work.

---

## 1. Executive diagnosis

The observation findings are **real**, but the dominant root cause is **not mature-profile recommender failure**. It is **first-session intelligence**: when durable taste is two genre chips and there is no behavioral signal, even a perfectly calibrated recommender cannot produce a confidence-rich, lens-responsive deck — there is not enough information in the system to project the user onto the axes the lens operates over.

This reframes the problem. The unit of work is not "improve the arbitration layer" or even "calibrate the classifier in isolation." The unit of work is: **ensure that within the first session, the system has collected (or acknowledged the absence of) enough signal to make a confident, structured, lens-responsive recommendation** — and where signal is genuinely absent, that the recommendation surface communicates that honestly and uses its slots to *gather* signal rather than pretend confidence it does not have.

Readstack's product promise is "wow in the first session." That promise is broken not by Phase 2 steering being absent but by the upstream sequence — intake, retrieval breadth under low-signal conditions, and the vocabulary the user is given to express mood — being thin. This chapter is about that sequence.

---

## 2. What conclusions still hold

These findings from the observation are **valid for any profile density**, sparse or mature, and remain actionable:

- **Classifier blindness (`classifier_miss_rate = 70%`).** `INTENSITY_*` and `EMOTIONAL_WEIGHT_*` SignalSets in `lib/evidence/signals.ts` are under-recalling against the live thriller corpus. This isn't a sparse-profile artifact — the books themselves are silent on these axes regardless of who's asking. Calibration work (Batch C slice C1 candidate) still needed; just no longer the lead.
- **Candidate-pool homogeneity (`lfa_any = false` everywhere).** Under any light-leaning lens, retrieval produces zero light-leaning alternatives in positions 11–25. Even with a mature profile this would be a problem the moment a user applied a lens. The lens is steering correctly at slot 1 (`Thursday Murder Club` matched in S1–S4) but cannot steer the pool beneath it because the pool was never broadened to match the lens intent.
- **Vocabulary semantic mismatch (revised after code re-check).** The UI does expose an `immersive` chip (`components/RecommendationsFeed.tsx` line 1542) and a `Less dark` chip (line 1643, maps to `int=low`). The capture-time gap is therefore not "missing chips" — it is **semantic clarity**: (a) "Less dark" produces `int=low` (intensity axis), NOT `exclude.avoid_dark` (which the recommender sets only when `tone='light'` is picked, line 1061). A user expecting "Less dark" to behave as `avoid_dark` will get bounded demotion (intensity-low ranking), not hard exclusion. (b) `immersive` exists but was not surfaced to the operator during S4 capture, suggesting a discoverability/affordance issue rather than absence. Reframe: **the chips exist; their semantics and discoverability don't match how readers think about mood.**
- **Chip lifecycle behavior (revised after code re-check).** A `handleClearIntent` action exists (`components/RecommendationsFeed.tsx` line 1120). The capture-time S2 → S3 → S4 carry-over (`palate_cleanser` + `max_pg=400` persisting) therefore was not "no clear affordance" — the operator did not tap Clear between scenarios. The underlying product question stands but is **narrower**: should chip-group state auto-reset on certain navigations, should single-active-per-dimension semantics replace multi-active, and is the Clear affordance discoverable enough? "No clear button" was the wrong diagnosis; "lifecycle defaults don't match reader expectation" is the right one.

---

## 3. What conclusions should be softened

These observations are **expected, or at least unsurprising, given a sparse profile**. They were correctly measured but should not be over-weighted as recommender bugs:

- **"Many books remained despite filter changes."** With durable taste = `Mystery + Thriller`, the retrieval pool is dominated by `stated_genres:thriller`. The lens nudges *order*; it cannot manufacture a Fantasy alternative from a Thriller-only profile. Under a dense imported library, the same lens would have a wider pool to re-rank.
- **`n_tlm = 2` recurring on the same two titles.** The two `taste_fit ∧ lens_mismatch` rows (`Everything I Never Told You`, `Freefall`) are exactly the books where classifier *did* fire AND the user's stated taste *does* match. With only two genre chips on file, two `tlm` per scenario is expected, not low.
- **`n_wem = 0` everywhere.** Mood-first ejection would be empty today, but that is partly because `lfa = false` (no alternatives to swap to). Fixing the supply side (retrieval breadth) before adjudicating Phase 2 arbitration math is correct; reading `n_wem = 0` as "Phase 2 has no work to do" would be wrong — it has nothing to *measure on* yet.
- **"Slot 1 routinely correct."** Lens steering at the headline pick worked in all 4 lens-active scenarios. That's a positive signal, but for a sparse user, it's also the *easiest* slot — promote the lightest classifier-positive cozy. The harder slots (3–10) are where signal-poverty bites, and that's also where users will look once the headline pick doesn't suit.

The headline reframing: **the recommender is not silently misfiring on a mature profile; it is correctly under-confident on a sparse profile, but the product surface around it is not honest about that under-confidence.**

---

## 4. Why this matters more

Readstack's product promise is **early wow / first-session intelligence**. That promise lives or dies in the first 90 seconds. The competitive baseline is Goodreads / StoryGraph, where the implicit deal is "import your library and we'll know you." Readstack must offer a different deal: **"tell us a few high-signal things and we'll know you well enough to surprise you."**

Today's first-session experience for the sparse path is:

1. User picks 1–2 genre chips and skips the rest.
2. First deck is 10 books from the dominant lane.
3. User applies a lens; the headline shifts, the rest stays.
4. User has no language for "what they actually want right now" beyond a handful of provisional implementation-named chips.
5. User concludes Readstack is "a thriller list with some sliders."

Every issue in the observation maps to this gap. Phase 2 steering won't close it. BookEvidence calibration alone won't close it. The closure requires intake density + retrieval breadth + product vocabulary, in coordinated sequence, with the first deck itself acting as part of the intake mechanism rather than purely as a result.

---

## 5. Intake-density model

Readstack must explicitly support a graded spectrum of intake density, and **the recommender + the first-deck surface must behave differently at each density**. Treating cold-start as a single weak state is the root of the current failure mode.

| Density tier | Signal available | First-deck behavior | Confidence framing |
|---|---|---|---|
| **D0 · Sparse / single-tap** | 1–2 genre chips, no behavioral signal, no books cited | First deck is a **structured discovery board** (see §9), each card explicitly labeled with its role. Reasons are honest: "Based on your Mystery + Thriller picks." Lens chips are surfaced but framed as "narrow what you're in the mood for right now." | "Early signal — these get better as you tell us more." |
| **D1 · Medium / multi-chip** | 3–6 chips across genre + tone + pacing + length, no books cited | Same structured deck as D0, but the lighter / stretch / wildcard slots are populated with higher confidence because tone+pacing chips give the lens something to grip. | "Building your profile — keep marking what fits." |
| **D2 · Book-anchor** | 2–5 books the user names as "loved" + 1–2 named as "expected to love but didn't" + free-text "why" | First deck is composed primarily from author / appeal-vector / co-read signal off the anchor books. Classifier axes can be partially seeded from the anchor books' BookEvidence. Reasons cite the anchor: "Because you loved *X*." | "Anchored on books you named — high confidence on these." |
| **D3 · Conversational** | Free-text answers to a small set of intake prompts (e.g., "what's a book you wish more people read", "what did you almost finish but didn't") | First deck is composed off LLM-extracted intent + named-book matches. Composer is conservative: cites named book OR cites the conversational signal verbatim. | "Tailored from what you told us." |
| **D4 · Dense import** | Goodreads / StoryGraph CSV; full revealed taste; behavioral lanes detectable | Current dense-profile path (already shipping; matches existing P3A acceptance). Lens steers a wide pool. Confidence is implicit, not foregrounded. | (No explicit framing — current behavior.) |

**Acceptance principle:** for D0–D3 the first deck MUST surface its own confidence framing. For D4 it MUST NOT (would feel patronizing). The framing string is part of the deck contract, not chrome.

**Cross-tier invariant:** the same `RecRequest` compiler, same branch planner, same composer ship the deck at every tier. Tier differences live in (a) which branches activate, (b) which slots in the structured deck get filled vs. left as "tell us more" gather-slots, (c) the confidence-framing string. **No tier-specific recommender fork.** This preserves Control Plane integrity.

---

## 6. Cold-start retrieval strategy

When durable taste is genre-level only, retrieval must **intentionally widen** rather than collapse to the dominant lane. Today, `Mystery + Thriller + light_fun` collapses to domestic_suspense × 10 because every branch (`revealed_authors` empty, `stated_genres` → `thriller`, `intent` → light_fun without anything to anchor on) lands in the same pool.

The cold-start retrieval contract:

1. **Genre-level taste with active lens → intentional sub-genre sampling.** For `Mystery + Thriller + light_fun`, the retrieval planner must allocate explicit branch quota to: cozy mystery, lighter detective fiction, witty crime, short mysteries (≤320pg), lower-emotional-burden suspense. None of these is "domestic suspense × variation"; each is a distinct OL subject anchor. This is **not** the same as broadening the candidate cap — it is reshaping the branch allocation when `revealed_*` branches are empty.

2. **Lens-driven adjacent-genre branch (sparse-profile only).** For `light_fun` lens on a thriller-only profile, the planner should also seed a *small* adjacent-genre branch (e.g., light contemporary fiction, light romance with mystery, lighter literary suspense). Quota stays bounded (~2 of 10 visible) and is provenance-tagged `cold_start_adjacent` so the composer can label it honestly ("A lighter read outside your usual"). This is the supply-side fix for `lfa_any = false`.

3. **Branch quota becomes density-aware, not just policy-tuned.** `BRANCH_QUOTAS` in `lib/recPolicy.ts` currently treats sparse and dense profiles identically. Cold-start needs a quota profile that explicitly favors `stated_genres` + `intent` + `exploration` + `cold_start_adjacent` and zeroes out `revealed_lanes` / `revealed_authors` when those are empty (today they get a quota that goes unfilled, wasting slots).

4. **No durable-taste mutation.** Cold-start retrieval widening does NOT write to `tasteProfile`. The user picked Mystery + Thriller; the system showing a lighter cozy as a "wildcard" slot does not implicitly add cozy to their taste. Hard invariant.

5. **Pool breadth ≠ ranking change.** Ranking, scoring, composer, RecCard, finalGate, No-dark policy unchanged. The fix is upstream of all of them. The deck shape changes because the *pool* the ranker chooses from changes.

This is the work that makes `lfa_any = false` become `lfa_any = true` for at least a meaningful subset of the deck. Phase 2 arbitration becomes meaningful only after this lands.

---

## 7. Lens / filter vocabulary strategy

Current chips (`tone=light`, `energy=light_fun`, `energy=palate_cleanser`, `pace=fast`, `int=low`, `max_pg=400`, `avoid_dark`) are **provisional implementation controls**. They map to fields in the lens type but were never designed as a product vocabulary. They reflect what the recommender can read, not what a reader thinks in.

**The two surfaces should be decoupled.** Internally, `IntentLens` can keep its current shape (and grow). Externally, the user is offered a vocabulary organized around how readers actually describe a reading mood. Proposed dimensions:

| Dimension | What a reader thinks | Example chips |
|---|---|---|
| **Mood / energy** | "I want something fun / serious / hopeful / melancholy / suspenseful / quiet" | fun, hopeful, melancholy, suspenseful, quiet, escapist |
| **Burden / emotional weight** | "I want something light vs. something I have to sit with" | easy on me, immersive but not heavy, willing to be wrecked |
| **Pace** | "Fast / steady / slow-burn" | quick read, steady, slow-burn |
| **Length** | "Short / regular / long" | short (≤300pg), regular, doorstop OK |
| **Complexity** | "Easy / literary / dense" | accessible, literary, dense / demanding |
| **Novelty vs. familiarity** | "Comfort read vs. surprise me" | comfort, familiar territory, surprise me, stretch |
| **Genre distance** | "Stay in my lane / adjacent / cross-genre" | in-lane, adjacent, cross-genre |
| **Emotional weight axis** | (paired with burden) | light heart, bittersweet, devastating OK |
| **Series / standalone** | "Series I'm in / new series OK / standalone please" | continue series, new series OK, standalone only |
| **Reread / discovery** | "Show me something I've never heard of vs. a known great" | known great, hidden gem, deep cut |
| **Reading state** | "On a plane / before bed / weekend deep-dive" | (composite — maps to multiple of above) |

**Lifecycle rules** (product surface):
- **Single-active per dimension.** Picking a new chip in the same dimension replaces the old one.
- **Visible "clear all" affordance.** Always one tap to reset.
- **Session-only persistence.** Already true internally; should be visually obvious to the user (e.g., chips fade or show "for this session" tag).
- **Composite presets** ("on a plane", "before bed", "weekend deep-dive") map to multi-chip selections so users can pick a *reading state* without learning the dimension grid.

**Mapping layer:** product vocabulary → `IntentLens` fields lives in a new `lib/intent/lensVocabulary.ts` module. The lens type itself does not change shape; the mapping table can evolve without touching the recommender.

**Honest gaps surfaced today (revised after code re-check):**

- `immersive` **does** exist as a UI chip (`components/RecommendationsFeed.tsx` line 1542) but was not surfaced to the operator during the S4 capture — a **discoverability / affordance** gap, not a missing-chip gap.
- `avoid_dark` is not exposed under its own name; the chip the user reached for is **"Less dark"** (line 1643), which sets `int=low` (intensity axis, bounded demotion in ranking) rather than `exclude.avoid_dark` (hard exclusion, set only by `tone='light'` at line 1061). This is a **semantic clarity** gap: two different lens behaviors are reachable but not under the labels readers expect.
- A `handleClearIntent` action exists (line 1120). The chip carry-over observed in the capture is therefore a **lifecycle-default** question (auto-reset on navigation? single-active-per-dimension? Clear-affordance prominence?) rather than a missing-control question.

These are all real product evidence for the vocabulary work, but the diagnosis is sharper than "introduce missing chips": **the chip surface today is largely complete in inventory; what's missing is (a) a deliberate mapping layer between reader-facing labels and recommender-internal lens fields, (b) lifecycle defaults that match reader expectation, and (c) discoverability for the less-obvious chips.** Phase 2 lets users dial the mode (`taste_first` ↔ `mood_first`), and those modes are meaningless if the mood input is reachable but semantically ambiguous.

---

## 8. Onboarding signal strategy

Onboarding must collect more high-signal information **without becoming heavy**. The "few high-signal questions" model already in spirit-form in the codebase (quick-taste flow) needs targeted enrichment:

1. **A few books the user loved (anchor books, 2–5).** Picker with cover + title; aim for breadth (genre, era, weight). Captures author signal, BookEvidence axes (intensity/weight via the loved books themselves), and gives the composer a citeable "because you loved X" reason on day 1.

2. **One book they expected to like but didn't.** Powerful anti-signal. Often the single most informative input in the whole flow because it surfaces a *boundary* the user can't articulate but can recognize. Optional but encouraged.

3. **Why, in their own words (free text, short).** Even one sentence ("too slow", "too gory", "couldn't connect to the narrator") is gold. Stored as `userNotes` on the anti-signal book. LLM extraction is a follow-up, not a gate — the raw text is itself useful evidence.

4. **Current reading-state questions (1–2 prompts).** "Right now you're in the mood for…" with composite presets from §7 (e.g., "something fun and quick", "something I can sit with"). Captures D0/D1 starting lens.

5. **Optional import path (visible, not buried).** "Import from Goodreads / StoryGraph" surfaced as a peer option to the chip path, not gated behind multiple screens. Anyone who lands on Readstack from a competitor should be one tap from D4.

6. **Skip / progressive profiling.** "Skip for now — we'll learn as you go" must land on a *real* browsable Tier-0 For You surface, not a second setup screen (this is currently parked as known UX debt). Progressive profiling = the first deck itself uses gather-slots (§9) to keep collecting signal.

**What stays out:** long questionnaires, mood-of-the-week journaling, free-text-only intake. The principle is **few questions, high signal density per question, every answer must visibly influence the first deck or be honestly framed as "early signal".**

**Existing acknowledged gap (replit.md "Current Intent Layer follow-up, post-P3A"):** tone / pace / intent inputs influence retrieval and scoring but do NOT yet produce typed `ScoreContribution[]` the composer can cite. Onboarding enrichment is a no-op if intake answers don't flow through to citeable evidence. The contribution-shape work must move in lock-step with intake (likely as part of step 3 of the implementation sequence in §10).

---

## 9. First-deck structure

The first deck for D0–D3 users should be a **decision surface**, not a flat ranked list. Each card has a role; the user reads the deck as a set of choices, not a count-down. Proposed slot shape (10 visible):

| Slot | Role | Example label | Source of confidence |
|---|---|---|---|
| 1 | **Safest fit** | "Most likely to land for you" | stated_genre × highest-confidence appeal signal available |
| 2 | **Safest fit (alt)** | "Another safe pick" | same lane, different author / sub-vector |
| 3 | **Lighter fit** | "Lighter take on what you like" | classifier `low` intensity OR lens-aligned cozy sub-branch |
| 4 | **Close fit with a twist** | "Like X but with [vector]" | stated lane + one orthogonal appeal vector |
| 5 | **Familiar-but-different** | "If you liked X, try this" | author-graph adjacency OR shared-reader signal |
| 6 | **Stretch pick** | "A small stretch from your usual" | adjacent sub-genre branch (§6 item 2) |
| 7 | **Wildcard** | "Outside your usual — but loved by readers like you" | cross-genre, provenance-tagged `cold_start_adjacent` |
| 8 | **Gather-slot · tone** | "Quick: does this kind of vibe interest you?" | renders 2–3 mini-cards user can tap to teach the system |
| 9 | **Gather-slot · weight** | "Or are you in the mood for something heavier?" | renders 2–3 mini-cards on the opposite axis |
| 10 | **Anchor prompt** | "Tell us a book you loved — we'll get sharper" | direct deep link to anchor-book intake |

**Tier behavior:**
- **D0 / D1:** all 10 slots active including gather + anchor prompt.
- **D2:** slots 1–7 anchor-book-cited; slots 8–10 can collapse to one "anything else you loved?" prompt.
- **D3:** slots 1–7 cite conversational evidence; slots 8–10 collapse.
- **D4:** structured deck collapses entirely to the current dense-profile flat ranked list. The structure is a cold-start surface, not a permanent shape.

**Hard constraints honored:**
- Composer / RecCard / ranking / scoring / finalGate / No-dark unchanged. The structure is rendered by a new *surface composer* that consumes already-ranked recs and assigns them to slots based on their existing contribution shape. No new contribution types, no new reasons, no `recValidity` bump.
- Gather-slots are a NEW component (not a RecCard). They render alongside RecCards but are not RecCards. RecCard contract is untouched.
- Anchor prompt is navigation, not a card.

This is a meaningful UI change and will require its own planning chapter and acceptance harness when it gets implemented. Surfacing it here so the dependency tree below can reason about it.

---

## 10. Dependency tree

The five candidate workstreams and the strict order they must ship in:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 0. THIS DOC                                                             │
│    Planning-only. No code changes (other than teardown).                │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. BookEvidence calibration (Batch C slice C1 candidate)                │
│    Widen INTENSITY_* / EMOTIONAL_WEIGHT_* SignalSets in                 │
│    lib/evidence/signals.ts; extend description-derivation corpus.        │
│    Goal: classifier_miss_rate ≤ 35% on the same 5-scenario capture.     │
│    No admission into ranking/composer/RecCard yet — still shadow-mode.   │
│    Required by every downstream step that consumes int/wt axes.         │
│    Pinned by: extended validate_book_evidence_intensity fixtures.       │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Cold-start retrieval expansion (§6)                                  │
│    Density-aware BRANCH_QUOTAS; intentional sub-genre sampling under    │
│    sparse profile; new cold_start_adjacent branch with bounded quota.   │
│    Goal: lfa_any = true for ≥3 of 4 lens-active scenarios on the same   │
│    sparse capture; deck breadth visibly increased.                      │
│    Depends on 1: needs classifier signal to seed sub-genre branches.    │
│    Pinned by: new validate_cold_start_retrieval fixture replay.         │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. Lens vocabulary + lifecycle (§7) + intake-density model wiring (§5)  │
│    New lib/intent/lensVocabulary.ts mapping layer; chip lifecycle       │
│    (single-active per dimension, clear-all, session-tag); onboarding    │
│    enrichment (anchor + anti-signal book + free-text why); intake       │
│    answers flowing to typed contributions.                              │
│    Can ship in parallel with 4 — independent surface.                   │
│    Pinned by: validate_lens_vocabulary_mapping + intake fixture suite   │
│    (sparse / medium / book-anchor / conversational / dense-import).     │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. First-deck structured surface (§9)                                   │
│    New surface composer assigns ranked recs to structured slots;        │
│    gather-slot component; anchor prompt slot. Tier-aware (D0–D3 only).  │
│    Depends on 2 (needs a wide enough pool to fill the slots) and 3      │
│    (needs the new vocabulary + intake signals to label slots honestly). │
│    Pinned by: structured-deck fixture replay across all density tiers.  │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. Phase 2 steering arbitration                                         │
│    taste_first / balanced / mood_first cap profiles wired into ranking. │
│    DEFERRED until 1–4 land and a re-capture shows the foundations work. │
│    Premature today: no pool to arbitrate, no vocabulary to mode-switch  │
│    on, no measurable mood-first ejection candidates (n_wem = 0).        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Parallelism windows:** 3 can begin while 2 is in implementation (independent surface). 4 cannot begin until 2 lands. 5 cannot begin until 1–4 ship AND a re-capture validates the foundations.

**Off-ramp:** if step 1 calibration shows the corpus is fundamentally too sparse to classify reliably (i.e., adding signals doesn't move the miss rate), the BookEvidence corpus-acquisition strategy (LLM-derived appeal vectors, third-party data, etc.) becomes its own chapter ahead of step 2. We won't know until step 1 is attempted.

---

## 11. Validator / acceptance harness

Cold-start vs mature-profile behavior must be testable separately. Proposed fixture-profile suite (to be implemented alongside step 1):

| Fixture profile | Density | Composition | What it asserts |
|---|---|---|---|
| **F-Sparse-MysteryThriller** | D0 | 2 genre chips (Mystery, Thriller), 0 books, 0 lanes | Structured deck §9; gather-slots fire; honest confidence framing present; classifier_miss_rate ≤ 35% (post-step-1); lfa_any = true under light lens (post-step-2) |
| **F-Sparse-FantasySciFi** | D0 | 2 genre chips (Fantasy, Sci-fi), 0 books, 0 lanes | Same assertions as above but in a different genre family — proves cold-start retrieval logic isn't thriller-specific |
| **F-Medium-Setup** | D1 | 4–6 chips (genre + tone + pace), 0 books | Structured deck still active; gather-slots reduced; lens steering visibly tighter |
| **F-BookAnchor** | D2 | 3 anchor books + 1 anti-signal book + free-text why | Composer cites anchor books; slot 5 ("Familiar-but-different") populated from author-graph; gather-slots collapse to 1 |
| **F-Conversational** | D3 | Free-text answers (3 prompts) | Composer cites conversational evidence; intent extracted correctly; deck reflects extracted lens |
| **F-DenseImport** | D4 | Full Goodreads CSV (273 rows, real fixture) | Structured deck collapses to flat ranked list; current dense-profile behavior preserved byte-identical |

**Cross-tier invariant assertions** (separate validator):
- Same recommender entry point used for all 6 fixtures.
- No tier-specific code branches in `getRankedRecs` / `composeReasons` / `finalGate`.
- `recValidity` hash stable across tiers given identical signal state.
- Composer reasons are faithful at every tier (P3A invariant preserved).

**Re-observation gate before Phase 2 (step 5):** after step 4 lands, the same 5-scenario `[LENS_ARBITRATION]` capture is re-run on a sparse user. Required deltas vs. today's capture:
- `classifier_miss_rate` ≤ 35% (from 70%)
- `lfa_any = true` in ≥ 3 of 4 lens-active scenarios (from 0)
- `n_wem` > 0 in at least one scenario (from 0) — i.e., there is finally something to arbitrate over

Only with all three crossed does Phase 2 steering arbitration move from deferred to planned.

---

## 12. Exact next implementation chapter

**Recommended next chapter:** **BookEvidence Batch C slice C1 — corpus widening + admission readiness.**

Scope (definition only — do not implement here):
- Widen `INTENSITY_HIGH/LOW` + `EMOTIONAL_WEIGHT_HIGH/LOW` SignalSets in `lib/evidence/signals.ts` based on miss-rate analysis of the current 5-scenario capture. Add the cohort of phrasings observed missing on `domestic_suspense` corpus.
- Extend the description-derivation corpus that `deriveBookEvidence` reads (today: SEMANTIC corpus; possibly add publisher description / first-chapter blurb fields if available in `books` table).
- Keep slice C0's shadow-mode-only invariant unchanged: no admission into ranking, composer, RecCard, or No-dark policy yet. (Admission is slice C2+.)
- Extend `validate_book_evidence_intensity` fixtures with the missed-classification cases from this observation.
- Re-run the same 5-scenario capture (operator workflow already established) and confirm `classifier_miss_rate ≤ 35%` before declaring slice C1 product-accepted.

**Explicitly NOT in scope for the next chapter:**
- Retrieval changes (step 2 — separate chapter, depends on C1 landing).
- Lens vocabulary changes (step 3 — separate chapter).
- Structured first-deck surface (step 4 — separate chapter, depends on 2+3).
- Phase 2 steering (step 5 — deferred).
- Any change to `recValidity`, ranking, composer, RecCard, finalGate, No-dark.

This keeps the next chapter narrow, shadow-mode-only, and pinned by a contract validator + operator re-capture — the same shape as Batch B and slice C0, both of which shipped cleanly.

---

## Hard invariants preserved by this plan

(For the reviewer's checklist when any step below ships:)

- Ranking unchanged in this chapter.
- Scoring unchanged in this chapter.
- Composer unchanged in this chapter.
- RecCard unchanged in this chapter.
- finalGate unchanged in this chapter.
- No-dark policy unchanged in this chapter.
- Durable Reading Taste never mutated by cold-start retrieval widening.
- Lens state never persisted; lifecycle work is product-surface only.
- `recValidity` stays `rcv6` for the entirety of this chapter.
- Phase 2 steering remains deferred.
- BookEvidence calibration NOT implemented in this turn.
- UI filter changes NOT implemented in this turn.

---

## Cross-references

- Observation report: `.local/lens_arb_logs/REPORT.md` (gitignored; raw capture: `.local/lens_arb_logs/lens_arb_combined.json`)
- Phase 1 steering doc: `docs/plan_lens_steering_phase1.md`
- Phase 1.1 observation-assist doc: `docs/plan_lens_arbitration_observation_assist.md`
- Operator runbook: `docs/runbook_lens_arbitration_observation.md`
- Current Intent Layer follow-up (parked): `replit.md` — "Parked / explicitly deferred" section
- Lens spec source-of-truth: `lib/currentIntentLens.ts`
- Branch quotas: `lib/recPolicy.ts`
- BookEvidence classifier: `lib/evidence/bookEvidence.ts` + `lib/evidence/signals.ts`
