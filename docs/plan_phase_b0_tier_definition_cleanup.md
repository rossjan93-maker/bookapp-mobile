# Phase B.0 — Tier-Definition Cleanup (planning chapter)

**Status.** Planning-only. No product code is changed by reading this document.
Implementation requires a separate approval turn and its own validator-green
acceptance gate.

**Why this chapter exists.** The Phase B live capture turn (2026-05-26)
proved the engineering-correctness of Cold-Start Retrieval Expansion Phase B
but exposed a product-scope gap: the test account — Mystery + Thriller,
avoid Horror, no library — classified as `density=thin` not `cold_start`,
so `liveQuota=0`. The recommender behaved exactly as written. The written
spec just doesn't cover the user state the planning chapter intended.

**Root cause (from the 2026-05-26 diagnostic turn).**
`lib/tasteProfile.ts:718–722` applies an intake boost: if
`diagnosis_answers.intake_completed === 'true'` AND
`favorite_genres.length > 0`, `effectiveSignalCount` is lifted to
`max(strongSignalCount, 5)`. `5` crosses the tier-1 threshold in
`computeConfidenceTier`, which projects to `confidenceMode='thin'` via
`confidenceModeForTier`. Every onboarded user with at least one favorite
genre therefore enters the For You surface as `thin` — including users
who have given zero library signal. `cold_start` is reachable only by
users who skipped intake or completed intake with no favorite genres, a
path the onboarding flow actively prevents.

The fix is conceptual, not numeric. `cold_start` is currently doing the
work of two product states (auth-newness AND zero-recommendation-signal).
Phase B.0 separates them and assigns the `coldStartAdjacent` quota to the
state that actually needs it.

---

## 1 · Current path map (verified 2026-05-26)

```
reader_preferences        user_books
(favorite_genres,         (status, rating, taste_tags,
 diagnosis_answers,       review_body, source,
 avoid_genres,            import_source)
 reading_styles,
 favorite_authors)
        │                      │
        └──────────┬───────────┘
                   ▼
lib/tasteProfile.ts :: computeTasteProfile()                  [line 636]
                   │
                   ├─ evidence: TasteProfileEvidence          [line 687]
                   │     {completed, imported, rated,
                   │      taste_tag, review, diagnosis} counts
                   │
                   ├─ strongSignalCount                       [line 699]
                   │     # finished books with rating OR taste_tag
                   │     OR review OR goodreads-import
                   │
                   ├─ INTAKE BOOST (★ the seam) ★             [lines 706–722]
                   │     const intakeCompleted =
                   │       diagnosisAnswers.intake_completed === 'true';
                   │     const hasIntakeGenres =
                   │       (prefsData?.favorite_genres ?? []).length > 0;
                   │     effectiveSignalCount = (intakeCompleted && hasIntakeGenres)
                   │       ? max(strongSignalCount, 5)
                   │       : strongSignalCount;
                   │
                   ▼
lib/tasteProfile.ts :: computeConfidenceTier(evidence, effectiveSignal)   [line 79]
                   if strong ≥ 10 && hasImport && hasEnrich → tier 3
                   else if strong ≥ 10                      → tier 2
                   else if strong ≥ 5                       → tier 1  ← boost lands here
                   else                                     → tier 0
                   │
                   ▼
lib/recPolicy.ts :: confidenceModeForTier(tier)              [line 27]
                   tier ≤ 0  → 'cold_start'
                   tier ≤ 1  → 'thin'      ← all onboarded sparse users
                   else      → 'high_signal'
                   │
                   ▼
RecRequest.policy.confidenceMode                              [recRequest.ts:192]
                   │
                   ▼
lib/recPolicy.ts :: BRANCH_QUOTAS[confidenceMode]            [line 179]
                   cold_start.coldStartAdjacent  = 3   ← Phase B live
                   thin.coldStartAdjacent        = 0   ← Phase B inert
                   high_signal.coldStartAdjacent = 0   ← forever (invariant)
                   │
                   ▼
lib/retrieval/branchPlanner.ts :: planBranches()             [line 60]
   buildColdStartAdjacentBranch() runs LAST in BRANCH_ORDER;
   admits 0 items when quota=0.
                   │
                   ▼
[COLD_START_ADJACENT] DEV log emits `density=<confidenceMode>` + quotas
```

**Two seams that matter for the cleanup:**

| Seam | Today | After Phase B.0 (proposed) |
|---|---|---|
| `tasteProfile.ts:718–722` intake boost | Mutates `effectiveSignalCount` AND silently re-tiers the user | Same input, but the boost output is captured as a SEPARATE flag (`intake_boosted: true`) and not folded into the tier value |
| `recPolicy.ts:27` `confidenceModeForTier(tier)` | 1-arg projection of tier → 3-mode union | 2-arg projection `(tier, intake_boosted)` → 4-mode union |

No call site outside these two files needs to change for the core fix. The
quota table widens (3 entries → 4), `BranchQuotas` and `coldStartAdjacent`
gain a `sparse_onboarding` row. Everything else propagates from the type.

---

## 2 · Proposed product-state model

| Code mode | Product meaning | Reachable when | Deck shape today (pre-fix) |
|---|---|---|---|
| **`zero_signal`** | True net-new account — auth exists but onboarding either skipped or aborted before favorite genres. The user got to For You by deep-link or a stale session. | `strongSignalCount = 0` AND `!(intake_completed=true && favorite_genres.length > 0)` | Dominated by stated-empty fallback; mostly broad popular OL subjects. |
| **`sparse_onboarding`** | Onboarded user with favorite genres declared, no imported library, no meaningful ratings. **This is the state Phase B planning intended to improve.** | `intake_completed=true` AND `favorite_genres.length > 0` AND `strongSignalCount < 5` | Currently dominated by domestic_suspense saturation under Mystery+Thriller (8/10 in the pre-Phase-B baseline; the symptom Phase B exists to address). |
| **`thin`** | Real early library — has 5–9 strong signals from genuine activity (ratings, taste tags, reviews, imports). | `strongSignalCount ≥ 5` AND not yet at tier-2 threshold | Library starts to anchor; adjacency is dose-controlled. |
| **`high_signal`** | Mature profile. **Mature-profile byte-identity invariant applies.** | `strongSignalCount ≥ 10` | Library carries the deck. Adjacency would be intrusive. |

### 2.1 What the rename changes for tier 1

The current `thin` mode is overloaded:
- **Today.** Onboarded sparse user (strong=0, boosted to 5) AND real-library tier-1 user (strong=5..9) are indistinguishable.
- **After.** Onboarded sparse user → `sparse_onboarding`. Real-library tier-1 user → `thin`. Two different deck recipes.

### 2.2 What `cold_start` becomes

`cold_start` is retired as a `ConfidenceMode` value. Its role is split:
- The "tier 0, no real history" lattice position remains in `TasteProfile.tier` (`tier === 0`). Nothing in the type system loses information.
- The product behaviors previously routed to `cold_start` (the `coldStartAdjacent=3` quota, the planner's cold-branch policy bypasses) re-key to `sparse_onboarding` — the state where those behaviors actually help.
- An explicit `zero_signal` mode captures the residual auth-new case so it stops being a silent alias of `sparse_onboarding`.

**Naming note.** `coldStartAdjacent` the *branch / quota field* keeps its
name — it accurately describes "adjacency injection during cold-start
buildout." `cold_start` the *confidenceMode value* is what goes away.
This minimizes diff against existing validators and external docs that
discuss "cold-start adjacency" as a feature.

---

## 3 · Exact rule for `sparse_onboarding`

```
mode = 'sparse_onboarding'  iff
    diagnosis_answers.intake_completed === 'true'
    AND favorite_genres.length > 0
    AND strongSignalCount < 5      // real signal, NOT effectiveSignalCount
```

Equivalently, in terms of the proposed `intake_boosted` flag:

```
mode = 'sparse_onboarding'  iff  intake_boosted === true AND tier === 0
```

Where `tier` is computed from `evidence + strongSignalCount` (the
**unboosted** count). Verification rules:
- A user with `strongSignalCount = 5` from real ratings (not boost) does
  NOT fall into `sparse_onboarding`. They are `thin`.
- A user with `intake_completed=true` AND `favorite_genres=[]` does NOT
  fall into `sparse_onboarding`. They are `zero_signal` (the intake boost
  predicate already requires both conditions).
- A user with `intake_completed != 'true'` AND `strongSignalCount = 0`
  falls into `zero_signal`.
- An imported-library user (Goodreads ≥1 row) WITHOUT ratings/tags still
  contributes to `strongSignalCount` via `isGoodreadsRow` — so a 1-book
  Goodreads import already pushes you out of `sparse_onboarding` (into
  `zero_signal`-with-evidence-of-import OR `thin`, depending on count).
  **Decision needed at implementation time**: should imports count as
  "real signal" for the cleanup boundary? See §11 risks.

---

## 4 · Implementation approach — three options

| Option | Shape | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Expanded `ConfidenceMode` union (4 values)** | `'zero_signal' \| 'sparse_onboarding' \| 'thin' \| 'high_signal'` | Type-safe at every consumer. Exhaustive `switch` checking lights up at compile time for any forgotten consumer. Validators trivially gain `sparse_onboarding` fixtures. Single seam: `confidenceModeForTier(tier, intake_boosted)`. | Renames touch every test fixture that hard-codes `'thin'` or `'cold_start'`. | **Recommended.** |
| B. Raw tier + `intake_boosted` flag, `confidenceMode` stays 3-valued | `RecRequest.policy.confidenceMode` unchanged. New `RecRequest.policy.intakeBoosted: boolean`. `BRANCH_QUOTAS` becomes a `(mode, intakeBoosted) → BranchQuotas` lookup. | Minimum surface change at the type level. | Every consumer that branches on `confidenceMode` must now ALSO read `intakeBoosted`, or be explicitly proven not to care. That's a coordination tax we already paid in Phase B and got wrong (the `intake_boost` was invisible to the planner). Re-paying it for every future caller is bad design hygiene. | Rejected. |
| C. Separate `signalDensity` field alongside `confidenceMode` | Two parallel fields, `confidenceMode` ('cold_start' | 'thin' | 'high_signal') AND `signalDensity` ('none' | 'onboarding' | 'real' | 'mature'). Validators must cross-check both. | Most expressive. | Two sources of truth always desync. The whole point of `confidenceMode` was to be the single policy projection. Adding a parallel field reintroduces the scattered-tier-branches problem the comment at `recPolicy.ts:20–23` set out to solve. | Rejected. |

**Recommendation: Option A.**

### 4.1 Sketch of the Option-A type changes (NOT code — illustrative only)

```ts
// lib/recPolicy.ts (sketch — planning only, NOT to apply this turn)

export type ConfidenceMode =
  | 'zero_signal'        // tier 0, no intake boost
  | 'sparse_onboarding'  // tier 0 raw, intake-boosted
  | 'thin'               // tier 1 from real signal (no boost dependency)
  | 'high_signal';       // tier 2 or 3

export function confidenceModeForTier(
  rawTier:       number,         // computed from UNBOOSTED strongSignalCount
  intakeBoosted: boolean,
): ConfidenceMode {
  if (rawTier >= 2)                       return 'high_signal';
  if (rawTier === 1)                      return 'thin';
  // rawTier === 0
  return intakeBoosted ? 'sparse_onboarding' : 'zero_signal';
}
```

```ts
// lib/tasteProfile.ts (sketch — planning only)
// computeTasteProfile() needs to expose `intakeBoosted` so the policy
// projection above can read it. The cleanest seam:

const rawTier        = computeConfidenceTier(evidence, strongSignalCount);   // UNBOOSTED
const intakeBoosted  = intakeCompleted && hasIntakeGenres && strongSignalCount < 5;
const policyTier     = intakeBoosted ? Math.max(rawTier, 1) : rawTier;
// `profile.tier` continues to surface `policyTier` (UI / scoring continue to
// see the boosted view — no behavior change to anything reading profile.tier).
// `profile.intakeBoosted` becomes a new field that ONLY confidenceModeForTier
// reads.
```

**Critical:** `TasteProfile.tier` keeps its current semantics (boosted).
The only consumer that learns about the boost flag is
`confidenceModeForTier`. Every other reader (scoring multipliers,
hypothesis generators, `tasteReadoutCopy`, etc.) sees the same tier value
they see today. **Zero behavioral change for anything not in the
retrieval-branch-quota path.**

---

## 5 · Proposed quota table

```
                       statedGenres  revealedAuthors  revealedLanes  coldStartAdjacent
zero_signal              4               1               5               3
sparse_onboarding        4               1               5               3
thin                     4               1               5               0  (Phase B.1 territory)
high_signal              3               3               4               0  (mature invariant)
```

### 5.1 Why these numbers

- **`zero_signal` and `sparse_onboarding` are identical except in intent.**
  Both are tier-0 raw signal; both benefit from adjacency injection.
  Splitting them at the type level future-proofs the surface (e.g., a later
  product chapter may want zero_signal to route through a different first
  surface entirely) without forcing a numeric difference now.
- **`thin` keeps `coldStartAdjacent = 0`.** This is the central spirit-preserving
  move. Today's `thin` is overloaded with sparse_onboarding; once we split
  those, the real-library tier-1 case stays unchanged — same retrieval,
  same deck shape, no surprise behavior for users who've started rating.
  Whether `thin` later gets `1` or `2` adjacency slots is a **Phase B.1**
  decision, not a Phase B.0 one.
- **`high_signal` keeps `coldStartAdjacent = 0` forever.** Pinned by
  `validate_cold_start_adjacent §5`. Phase B.0 does not touch this.

### 5.2 What does NOT change in this chapter

- `statedGenres` / `revealedAuthors` / `revealedLanes` quotas for what
  is currently `cold_start` carry forward unchanged to BOTH `zero_signal`
  and `sparse_onboarding`. (Validators pin the carry-forward.)
- `thin` and `high_signal` rows are byte-identical to today.
- No new branch is added. No anchor set changes. No scoring multipliers
  change.

---

## 6 · `sparse_onboarding` should get `coldStartAdjacent = 3`

**Yes.** The Phase B planning chapter's intended target user — onboarded,
sparse-preferences, no library — IS the `sparse_onboarding` state in the
new taxonomy. Moving the quota from `cold_start` (a state the user state
machine virtually never produces) to `sparse_onboarding` is the entire
purpose of Phase B.0.

The numeric value `3` is unchanged; only the keying changes. This is a
**re-keying**, not a quota expansion. The number `3` was validated by
the Phase A.1 anchor-prune work (`.local/cold_start_adjacent_evidence_report_relevance_1980.md`)
and the Phase B engineering acceptance (`validate_cold_start_adjacent §3`).

---

## 7 · Real-library `thin` — defer the decision

**Recommendation: `thin.coldStartAdjacent = 0` in Phase B.0, mark
explicitly as Phase B.1 territory.**

Reasoning:
- Phase B.0's job is the rename + re-keying, not new behavior expansion.
  Bundling a quota change for real-library `thin` users would conflate
  "split a confused type" with "expand adjacency injection," each of
  which deserves its own observation cycle.
- Real-library tier-1 users (strong=5..9) HAVE behavioral signal. The
  Phase B planning chapter explicitly excluded this state because their
  library starts to carry the deck. Whether adjacency helps or hurts
  them is an open question Phase B.1 should answer — with its own
  evidence capture against a real-library fixture (§9 below provides one).
- Phase B.1 planning, once unblocked, will get to choose between `0`,
  `1`, or `2` for `thin`. Phase B.0 does not pre-commit that choice.

If Phase B.1 later sets `thin.coldStartAdjacent = 1` or `2`, that's a
COLD_START_RETRIEVAL_POLICY_VERSION bump (csrp2 → csrp3) — covered by
the existing belt-and-suspenders mechanism. No further `recValidity`
bump needed if the only change is the integer.

---

## 8 · Cache / versioning recommendation

**Bump BOTH `recValidity.VERSION` (rcv7 → rcv8) AND
`COLD_START_RETRIEVAL_POLICY_VERSION` (csrp1 → csrp2).**

| Bump | Required? | Why |
|---|---|---|
| `recValidity.VERSION: rcv7 → rcv8` | **Yes** | The `ConfidenceMode` union value set itself is changing. Any persisted deck written under rcv7 was scored/composed inside a recommender that thought `confidenceMode` was 3-valued. After Phase B.0, the type system treats `'cold_start'` as an invalid value. Any pre-Phase-B.0 cached payload tagged with a `cold_start` deck would dead-code-path if restored — safest to force-invalidate at the hash layer rather than rely on consumer-side defensive coding. Bumping the version prefix on the hash forces every device to discard its cache and rebuild on next foreground. |
| `COLD_START_RETRIEVAL_POLICY_VERSION: csrp1 → csrp2` | **Yes (belt-and-suspenders)** | The `coldStartAdjacent` quota is moving from `cold_start` (effectively unreachable) to `sparse_onboarding` (commonly reachable). For sparse onboarded users, this is the first time their deck will actually contain adjacency items. Any pre-Phase-B.0 cached deck for these users was built without adjacency. The `recValidity` bump catches this via the version prefix; the `csrp` bump documents the policy intent and provides traceability in the hash. The two-bump policy is exactly what Phase B's planning chapter pre-committed to for any retrieval-policy change. |

**Resulting hash shape (sketch):**
```
rcv8|csrp:csrp2|fg:<…>|ag:<…>|rs:<…>|fa:<…>
```

Existing rcv7-tagged payloads in `recPayloadCache` / `recSession` /
`recQueue` will fail `assertCurrent` with `reason: 'config_mismatch'` on
first read after deploy and self-invalidate, exactly as designed.

### 8.1 Migration semantics

- **No DB migration.** No persisted Postgres schema changes — `recPayloadCache`
  is AsyncStorage-only.
- **No user-visible reset.** The next foreground rebuild produces a fresh
  deck; users see the same For You surface, just one cold rebuild later.
- **No `reader_preferences` change.** Phase B.0 does not touch the
  hash-input columns; the user's saved preferences are unchanged.

---

## 9 · Validator plan

Five new fixtures + one cache-migration fixture, distributed across the
existing validator surface. No new validator file is required.

### 9.1 New fixtures for `validate_cold_start_adjacent.ts`

| Fixture | Inputs | Expected `confidenceMode` | Expected adjacency admission |
|---|---|---|---|
| `zero_signal_no_intake` | `intake_completed=undefined`, `favorite_genres=[]`, no `user_books` | `'zero_signal'` | quota=3; admits if favorite_genres has Mystery/Thriller — for this fixture, ZERO favorites means zero admission (no anchors to pull from) |
| `zero_signal_with_avoid_only` | `intake_completed=undefined`, `favorite_genres=[]`, `avoid_genres=['Horror']` | `'zero_signal'` | quota=3; same — zero admission without favorites |
| `sparse_onboarding_mystery_thriller` ★ | `intake_completed='true'`, `favorite_genres=['Mystery','Thriller']`, `avoid_genres=['Horror']`, no `user_books` | `'sparse_onboarding'` | quota=3; admits ≥1 adjacency item from Mystery/Thriller anchors |
| `early_library_3_ratings` | sparse_onboarding fixture + 3 finished+rated `user_books` | `'sparse_onboarding'` (strong=3, still boosted to 5 in policy but raw < 5) | quota=3; admits as above |
| `thin_7_ratings` | sparse_onboarding fixture + 7 finished+rated `user_books` | `'thin'` (strong=7, real, no boost dependency) | quota=0; ZERO admission |
| `high_signal_20_books` | sparse_onboarding fixture + 20 finished+rated+imported `user_books` | `'high_signal'` | quota=0; ZERO admission (mature invariant) |

★ The `sparse_onboarding_mystery_thriller` fixture is the live-account
shape from the 2026-05-26 capture. Successfully running this fixture
through `validate_cold_start_adjacent` is the acceptance proxy for "the
manual recapture (§10) will now classify correctly."

### 9.2 Extensions to other validators

- `validate_rec_validity.ts` §8 — extend with negative-rejection fixtures
  for `rcv7|csrp:csrp1|…`, `rcv7|csrp:csrp2|…`, and `rcv8|csrp:csrp1|…`
  stored hashes against the live `rcv8|csrp:csrp2|…` current hash. All
  three must fail with `config_mismatch`. Positive case: `rcv8|csrp:csrp2|…`
  matches.
- `validate_rec_payload_cache_lens.ts` §4/§4b/§4c — extend with a behavioral
  round-trip test that stores an rcv7 payload, reads with current
  (rcv8) hash, asserts the read returns `null` (cache miss / discard),
  and a subsequent write+read at rcv8 round-trips.
- `validate_retrieval_planner.ts` — extend the per-mode expectations table
  to include `zero_signal` and `sparse_onboarding` rows alongside `thin`
  and `high_signal`. Branch-order placement of `coldStartAdjacent` (LAST)
  is unchanged and must still pin.
- `validate_cold_start_adjacent.ts` §5 — **broaden** the mature-profile
  byte-identity invariant to BOTH `thin` AND `high_signal` (today only
  high_signal is pinned because thin was being mis-fed sparse-onboarding
  users; after Phase B.0, `thin` is genuinely mature-tier-1 and must
  carry the same invariant). This is the most important validator
  strengthening in this chapter.
- `validate_taxonomy.ts` — no change (adjacency-map shape is untouched).

### 9.3 Sibling-validator green-after expectations

All 17 currently-green validators (the active suite from `replit.md`)
must remain green. The two known pre-existing `__DEV__` errors in
`validate_taxonomy` / `validate_stated_reservation` continue to be
out-of-scope.

---

## 10 · Manual capture plan after Phase B.0 ships

**Use `docs/operator_runbook_phase_b_capture.md` unchanged** for the
operator workflow. The only thing that changes is the §4.1 sanity-check
expectations.

Updated sanity check (drop-in replacement for the runbook's §4.1 step 5,
post-Phase-B.0):

```
After running readstackCapture.startScenario('S0') and forcing a cold
rebuild, in the same browser console verify the FIRST [COLD_START_ADJACENT]
log line for the build shows:
  density=sparse_onboarding
  liveQuota=3
  liveAdmittedCount >= 1
```

Acceptance:
1. The same Mystery+Thriller / avoid-Horror / no-library test account
   from the 2026-05-26 capture now classifies as `density=sparse_onboarding`.
2. `liveQuota=3` (not 0).
3. `liveAdmittedCount >= 1` for at least S0 (and ideally S1..S4 too,
   though lens-blindness in Phase B means the count may not vary).
4. The §8 checklist in the operator runbook then runs verbatim against
   the resulting aggregator markdown report. All 6 criteria evaluated.
5. Phase B product-acceptance verdict from §8.1 of the runbook applies
   unchanged — Phase B.0 is a re-keying, not a behavior change at the
   adjacency-content layer.

**Pre-flight check.** Before the capture, dry-run the validator-side
fixture `sparse_onboarding_mystery_thriller` (§9.1) to confirm the
classification path works in isolation. If the validator fixture passes
but the live capture still shows `density=thin`, the gap is in
`computeTasteProfile`'s wiring of the `intakeBoosted` flag to the
policy projection — fix that before re-capturing.

---

## 11 · Risks and rollback

### 11.1 Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| A consumer outside `confidenceModeForTier` is reading `confidenceMode === 'cold_start'` as a literal string and silently no-ops after the rename | Low | Medium | Exhaustive `switch` on the new union in TypeScript will surface unhandled cases. Pre-implementation: `rg "'cold_start'"` / `rg "\"cold_start\""` across `lib/` and `app/` and `components/` to enumerate every literal-string consumer. |
| Goodreads-import boundary: a 1-row Goodreads import bumps `strongSignalCount` by 1 → user might tip across boundaries unexpectedly | Medium | Low | Decision needed at implementation time: either (a) keep Goodreads-import as-counted (current behavior; user with 1-row import + sparse onboarding → `zero_signal` because boost predicate fails on the favorite_genres check — actually unchanged), or (b) explicitly require ≥5 imports to count as "real signal" for the boundary. Recommend (a) — minimal change. |
| `tasteReadoutCopy.ts` and other tier-reading UI surfaces start showing different copy because `profile.tier` semantics changed | None | — | Non-issue under the recommended sketch in §4.1: `profile.tier` keeps its boosted value. Only `confidenceModeForTier` reads `intakeBoosted`. UI copy is byte-identical. |
| Cached `rcv7` payload on a device with a sparse_onboarding user does NOT discard cleanly | Low | Medium | The hash version prefix changes (`rcv7` → `rcv8`) so `assertCurrent` fails with `config_mismatch`. The cache-migration fixture in §9.2 pins this behavior. Manual smoke test post-deploy: open app, observe Metro log shows one `[PERSIST_CACHE] config_mismatch` on first foreground, deck rebuilds. |
| Phase B.0 ships, fixes the type seam, but adjacency still does not appear in the user's deck because the anchor set + scoring path drops candidates before slot 10 | Medium | High | This is precisely what the manual capture (§10) is for. If `liveAdmittedCount >= 1` but the items don't reach the visible top-10, the diagnosis is composer/scoring, not tier. That diagnosis opens a separate planning chapter ("first-deck structure"), not a Phase B.0 follow-up. |
| Validator suite green but live behavior wrong due to async/Supabase wiring difference | Low | Medium | The `validate_cold_start_adjacent §3` live-quota invariant works purely off `BRANCH_QUOTAS` constants and a synthetic `RecRequest`. Manual capture (§10) is the only live cross-check. |

### 11.2 Rollback

Phase B.0 is rollback-cheap:

| Lever | Action | Recovery time |
|---|---|---|
| Code revert | `git revert <Phase B.0 commit>` | Single revert restores `ConfidenceMode = 'cold_start' \| 'thin' \| 'high_signal'`, `confidenceModeForTier(tier)` 1-arg form, and the 3-row `BRANCH_QUOTAS`. |
| Cache invalidation | Bump `recValidity.VERSION` rcv8 → rcv9 in the revert commit | All Phase-B.0-era cached decks (which used `sparse_onboarding` as a hash-mode-affecting policy value via csrp2) discard cleanly on next foreground. |
| Phase B status | Reverts to "Phase B engineering-verified, product-acceptance blocked on tier-definition cleanup" — the same status as before Phase B.0. | Immediate. |

No data loss. No user-facing visible disruption beyond one extra cold
rebuild. `reader_preferences` and `user_books` are untouched.

---

## 12 · Exact implementation prompt (for approval — do not run this turn)

> **Implement Phase B.0 — Tier-Definition Cleanup per `docs/plan_phase_b0_tier_definition_cleanup.md`.**
>
> Apply the following changes in a single commit:
>
> 1. **`lib/recPolicy.ts`** — Replace the `ConfidenceMode` union with
>    `'zero_signal' | 'sparse_onboarding' | 'thin' | 'high_signal'`.
>    Change `confidenceModeForTier(tier)` to
>    `confidenceModeForTier(rawTier: number, intakeBoosted: boolean)`
>    per the sketch in plan §4.1. Extend `BRANCH_QUOTAS` to a 4-entry
>    table per plan §5: `zero_signal` and `sparse_onboarding` carry the
>    current `cold_start` row (including `coldStartAdjacent: 3`); `thin`
>    keeps `coldStartAdjacent: 0`; `high_signal` unchanged. Bump
>    `COLD_START_RETRIEVAL_POLICY_VERSION` from `'csrp1'` to `'csrp2'`
>    with a History comment noting "Phase B.0 (2026-XX-XX) — quota
>    re-keyed from `cold_start` (retired value) to `sparse_onboarding`."
>
> 2. **`lib/tasteProfile.ts`** — In `computeTasteProfile`, capture
>    `intakeBoosted` as a boolean alongside `effectiveSignalCount`
>    (predicate identical to today's intake-boost predicate). Compute
>    `rawTier` from `computeConfidenceTier(evidence, strongSignalCount)`
>    (UNBOOSTED). Keep `profile.tier = computeConfidenceTier(evidence,
>    effectiveSignalCount)` so all existing tier readers are byte-identical.
>    Add `profile.intakeBoosted: boolean` to the `TasteProfile` type and
>    populate it. Do NOT change any other behavior in this file.
>
> 3. **`lib/recRequest.ts`** — Update the `confidenceMode` derivation at
>    line ~192 to pass both `profile.tier` (or `rawTier` — pick whichever
>    is cleaner) AND `profile.intakeBoosted` into the new
>    `confidenceModeForTier` signature. This is the only call site that
>    must change.
>
> 4. **`lib/recValidity.ts`** — Bump `VERSION` from `'rcv7'` to `'rcv8'`
>    with a comment block matching the rcv6→rcv7 comment style, citing
>    Phase B.0 tier-definition cleanup.
>
> 5. **`scripts/validate_cold_start_adjacent.ts`** — Add the 6 fixtures
>    listed in plan §9.1. Update §3 live-quota invariant to assert the
>    full 4-row table. **Broaden §5 mature-profile byte-identity invariant
>    to assert ZERO admission for BOTH `thin` AND `high_signal`** (the
>    most important strengthening this chapter introduces).
>
> 6. **`scripts/validate_rec_validity.ts`** — Add negative-rejection
>    fixtures for `rcv7|csrp:csrp1|…`, `rcv7|csrp:csrp2|…`,
>    `rcv8|csrp:csrp1|…` against the live `rcv8|csrp:csrp2|…` hash.
>
> 7. **`scripts/validate_rec_payload_cache_lens.ts`** — Add a behavioral
>    round-trip rcv7-stored / current-rcv8 discard test (§4d), and a
>    rcv8-stored / rcv8-read round-trip success test (§4e).
>
> 8. **`scripts/validate_retrieval_planner.ts`** — Extend the per-mode
>    expectations table to cover `zero_signal` and `sparse_onboarding`
>    rows alongside `thin` and `high_signal`.
>
> 9. **`replit.md`** — Add a new "Phase status" row for Phase B.0; bump
>    the live-state paragraph's `recValidity.VERSION` to `rcv8` and
>    `csrp2`; expand the "Hard invariants" Cold-Start Retrieval Expansion
>    bullet to reflect the new keying.
>
> 10. **`docs/recently_shipped.md`** — Append a Phase B.0 acceptance
>     prose block following the existing per-phase format.
>
> 11. **`docs/operator_runbook_phase_b_capture.md`** — Update §4.1 step
>     5 expectations to `density=sparse_onboarding`, `liveQuota=3`. The
>     rest of the runbook (snippet, splitter, aggregator, §8 checklist)
>     is unchanged.
>
> **Forbidden in this implementation:**
> - No change to ranking, scoring, composer, RecCard, finalGate,
>   No-dark policy, durable Reading Taste mutation, lens persistence,
>   Phase B.1 quota changes (thin stays 0), Phase 2 steering, anchor
>   set, title blacklists, popular-book fallback, Subject Coverage
>   work.
> - No new files outside the ones listed above.
> - No DB migration. No `reader_preferences` schema change.
>
> **Acceptance:**
> - All 17 currently-green validators stay green.
> - The 6 new fixtures in `validate_cold_start_adjacent` pass.
> - Manual smoke check: a fresh sparse-onboarding test account, after
>   the §10 capture, reports `density=sparse_onboarding` and
>   `liveQuota=3`.
>
> **After implementation lands**, run the manual capture per
> `docs/operator_runbook_phase_b_capture.md` against the same test
> account from the 2026-05-26 capture. The §8 checklist verdict (still
> first-match-wins) is the Phase B product-acceptance gate. Phase B.1
> planning stays blocked behind that verdict.

---

## Status statement

**Phase B.0 is a planning chapter only as of this writing.** No product
code, no validator code, no docs other than this file have been changed.
Implementation requires explicit approval to execute the §12 prompt.
Phase B.1 remains blocked. Phase 2 steering remains blocked. The
manual capture from 2026-05-26 remains the binding evidence that
motivated this chapter.
