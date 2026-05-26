# Phase B Lens Arbitration re-observation — 2026-05-26

**Task type.** Observation / diagnostic only. No product changes.
**Scope realized.** Plan-level + structural delta only. The visible-deck portion
(`[LENS_ARBITRATION]` rows under live admission) **was not captured this turn**
— see §0 for the unchanged headless blocker.

---

## 0 · Capture status — partial, sandbox-blocked

The full re-observation requires `[LENS_ARBITRATION]` + `[COLD_START_ADJACENT]`
console rows from a real signed-in dev session with `FORENSIC_USER_ID` set
locally. Per `docs/diag_lens_arbitration_blocker_2026-05-19.md` §A, that path
is blocked from this sandbox today and has not changed:

- No real test-account UUID is available to set as `FORENSIC_USER_ID`.
- The live recommender is React-Native-bound at module load and cannot be
  invoked headlessly from `tsx`/`node` without a product refactor (extracting
  a pure-recommender module) that the task's hard constraints forbid.
- Open Library returned `HTTP 403` to the offline candidate-fetch diagnostic
  (`diag_cold_start_adjacent_candidates.ts`) this turn (rate-limit /
  User-Agent), so even the candidate-layer enrichment couldn't refresh.

What I therefore did NOT do:

- Did NOT modify `FORENSIC_USER_ID` in `lib/recommender.ts:159` or
  `lib/retrieval/branchPlanner.ts:56` (both remain `''`). Setting a placeholder
  UUID would have produced no logs (no matching live user) while creating
  unnecessary churn.
- Did NOT invent visible titles, `n_tlm`, `n_wem`, `lfa_any`, or
  `classifier_miss_rate` numbers.

What I DID capture (read-only, in-process, no Supabase, no OL):

- Plan-level admission across S0..S4 lens chip variants on the documented
  sparse cold-start Mystery+Thriller / skip-Horror profile, for both
  `cold_start` and `high_signal` confidenceModes.
- Pulled the **pre-Phase-B baseline** from the previously captured
  `.local/lens_arb_logs/REPORT.md` (2026-05-20) for direct delta framing.

---

## 1 · Pre-Phase-B baseline (from `.local/lens_arb_logs/REPORT.md` · 2026-05-20)

Captured against `BRANCH_QUOTAS.cold_start.coldStartAdjacent = 0` (Phase A.1
inert), same sparse Mystery+Thriller profile, same five lens scenarios.

| Scn | Lens | n_tlm | n_wem | lfa_any | slot1_tlm | classifier_miss | Domestic-suspense `mp` count / 10 |
|---|---|---|---|---|---|---|---|
| S0 | none | 0 | 0 | false | false | 70% | **8** (1=`general_fiction`, 1=`domestic_suspense_DS_pos`) |
| S1 | `tone=light,energy=light_fun` | 2 | 0 | false | false | 70% | **7** (slot 1 = `cozy_detective` Osman) |
| S2 | `energy=palate_cleanser` | 2 | 0 | false | false | 70% | **7** |
| S3 | `intensity=low,energy=palate_cleanser` | 2 | 0 | false | false | 70% | **7** |
| S4 | `pace=fast,energy=palate_cleanser` | 2 | 0 | false | false | 70% | **7** |

**Baseline observations the user already established:**
1. Only one cozy candidate (`The Thursday Murder Club`) reached the deck under
   any lens — and it was the *same* book at slot 1 in S1/S2/S3/S4. The lens
   activates correctly; the candidate pool is the bottleneck.
2. Slots 2–10 are virtually unchanged across S1..S4 — domestic-suspense
   author cluster dominates (Flynn, Michaelides, Constantine, Hendricks,
   Feeney, Barry, Foley, Simone St. James, Heather Gudenkauf, Nita Prose,
   Stacy Willingham). Lens cannot eject because no replacement supply exists.
3. `n_wem = 0` across every scenario → the C0/C1 SignalSet vocabulary fires
   so rarely on the available pool that the `wem` arbitration is never
   activated.
4. `classifier_miss_rate = 70%` flat → the lens-vs-taste mismatch signal
   is unreliable on this pool.
5. Aggregator's executive verdict: **"Calibrate BookEvidence first"** —
   widen `INTENSITY_*` / `EMOTIONAL_WEIGHT_*` SignalSets and re-observe.
   C1 vocabulary widening has since shipped (2026-05-20).

These five observations frame what Phase B is supposed to move.

---

## 2 · Plan-level capture under live Phase B (this turn)

From `scripts/runtime_observe_phase_b_s0_s4.ts` — real `planBranches()` call,
same sparse fixture, no chips → S0..S4 chips.

```
COLD_START_RETRIEVAL_POLICY_VERSION = "csrp1"
BRANCH_QUOTAS.cold_start  = {statedGenres:4, revealedAuthors:1, revealedLanes:5, coldStartAdjacent:3}
BRANCH_QUOTAS.high_signal = {statedGenres:3, revealedAuthors:3, revealedLanes:4, coldStartAdjacent:0}
```

### cold_start plan across S0..S4

| Scn | Lens chip | adj_quota | adj_admitted | total_plan | adjacency anchors admitted |
|---|---|---|---|---|---|
| S0 | — | 3 | **3** | 5 | `[cozy mystery, cozy crime, amateur sleuth]` |
| S1 | `tone=light,energy=light_fun` | 3 | **3** | 5 | `[cozy mystery, cozy crime, amateur sleuth]` |
| S2 | `energy=palate_cleanser` | 3 | **3** | 5 | `[cozy mystery, cozy crime, amateur sleuth]` |
| S3 | `intensity=low,energy=palate_cleanser` | 3 | **3** | 5 | `[cozy mystery, cozy crime, amateur sleuth]` |
| S4 | `pace=fast,energy=palate_cleanser` | 3 | **3** | 5 | `[cozy mystery, cozy crime, amateur sleuth]` |

### high_signal plan across S0..S4 (mature-profile invariant)

| Scn | adj_quota | adj_admitted | total_plan |
|---|---|---|---|
| S0..S4 | 0 | 0 | 2 |

### Plan-level invariants

- **cold_start adjacency fingerprint identical S0..S4 → true.** Phase B
  retrieval is lens-blind by design. Confirms Phase B.1 (lens-aware breadth
  modulation) has NOT been pre-empted.
- **high_signal ever admits any adjacency → false.** Mature-profile
  byte-identity invariant holds.

---

## 3 · Structural delta (Phase B vs. pre-Phase-B baseline)

| Dimension | Pre-Phase-B | Live Phase B | Delta |
|---|---|---|---|
| `BRANCH_QUOTAS.cold_start.coldStartAdjacent` | 0 | 3 | +3 |
| cold_start fetchItems | 2 (statedGenres ×1 + revealedLanes ×1) | 5 (+3 adjacency) | +3 (+150%) |
| Adjacency anchors in plan | none | `cozy mystery, cozy crime, amateur sleuth` | new |
| Adjacency reason tag | n/a | `cold_start_adjacent:mystery` | new |
| Adjacency signalClass | n/a | `stated_durable` | unchanged-class |
| Adjacency item kind | n/a | `subject` | OL subject endpoint hit |
| `high_signal` plan | unchanged | unchanged | byte-identical |
| Lens chip influence on adjacency | n/a | none (chip-invariant) | Phase B.1 deferred |

**What this means structurally.** Phase B widens the cold-start retrieval
pool by ~150% with three OL subject queries whose vocabulary directly
overlaps the C1 SignalSet `INTENSITY_LOW` corpus (`cozy mystery`, `cozy
crime`, `amateur sleuth` are all C1 specific tokens). The single cozy
candidate that was reaching the visible deck pre-Phase-B (`Thursday Murder
Club`, `cozy_detective` `mp`, `low/specific` for both `int` and `wt`)
demonstrates the classifier reads this class correctly when supply exists.

---

## 4 · Observation questions — answers

| # | Question | Answer |
|---|---|---|
| 1 | Do coldStartAdjacent candidates enter the visible top deck? | **Unknown without live capture.** Plan-level: 3 anchors admitted → fetch occurs. Top-deck survival depends on scoring vs. domestic-suspense incumbents, which I can't run headlessly. |
| 2 | Which titles/authors enter via adjacency? | **Unknown without live capture or OL access.** Anchor queries are `cozy mystery`, `cozy crime`, `amateur sleuth` — the existing Phase A.1 candidate report at `.local/cold_start_adjacent_evidence_report_relevance_1980.md` is the candidate-level pre-Phase-B snapshot; refreshing it is blocked this turn by OL 403. |
| 3 | Does domestic-suspense saturation drop vs. baseline? | **Structurally expected: yes** (3 new non-DS anchors enter the candidate pool). **Empirically unverified this turn.** |
| 4 | Does `lfa_any` improve? | **Structurally expected: yes** (alternatives now exist in positions 11–25 for the lens to reach toward). **Empirically unverified.** |
| 5 | Does `n_wem` become meaningful? | **Plausible.** Cozy candidates carry `EMOTIONAL_WEIGHT_LOW` C1 vocab (`feel-good`, `lighthearted`, `witty`); if any survive scoring, `wem` should fire. **Empirically unverified.** |
| 6 | Does `classifier_miss_rate` remain acceptable after Phase B? | **C1 vocabulary widening already addresses this dimension.** Phase B does not change the classifier — it changes the candidate pool. If cozy candidates surface, they carry richer SignalSet matches than the domestic-suspense incumbents, so miss rate should fall. **Empirically unverified.** |
| 7 | Do S1 / S2 / S3 produce more visibly different decks? | **Structural blocker has been removed** (chip-mismatched alternatives now exist in the candidate pool). Whether the visible deck actually diverges depends on scoring deltas that need a live session. **Empirically unverified.** |
| 8 | Does the deck still over-preserve durable genre taste? | **Adjacency rows preserve `signalClass='stated_durable'`** and reason `cold_start_adjacent:mystery` — they ARE durable-taste candidates, broadened. So durable preservation persists; what changes is its internal diversity. |
| 9 | Are any adjacency candidates filtered by finalGate? | **Unknown.** finalGate runs at the queue boundary AFTER `[LENS_ARBITRATION]` fires. The `fg` field can only show in-process intent-filter exclusions, which were `null` for every visible row in the baseline. Adjacency candidates pass through the same hard-exclusion path as primaries — answer requires live capture. |
| 10 | Does high_signal remain unchanged? | **Yes — proven by harness.** `BRANCH_QUOTAS.high_signal.coldStartAdjacent = 0` and plan is byte-identical across S0..S4. Mature-profile invariant holds. |

**Empirically verified this turn: Q8 (partial — signalClass preservation),
Q10 (full).**
**Structurally implied but empirically unverified: Q1, Q3, Q4, Q5, Q6, Q7.**
**Unanswerable without live capture: Q2, Q9.**

---

## 5 · Is Phase B product-accepted?

**Mechanically accepted at the retrieval-policy layer.** All 17 validators
green. `recValidity rcv7` + `csrp:csrp1` cache invalidation verified.
Adjacency plan emission verified. Mature-profile invariant verified.
Lens-blindness invariant verified. Forbidden surfaces (composer, RecCard,
finalGate, No-dark, lens persistence, durable-taste mutation, Phase 2
steering, anchor expansion, Subject Coverage revival, thin/high_signal
quotas) all unchanged.

**Product-impact acceptance is pending live capture.** The mechanical
acceptance is necessary but not sufficient — the chapter's stated goal is
to verify whether Phase B *changes the visible cold-start recommendation
experience*. That requires the `[LENS_ARBITRATION]` rows from a real dev
session. Until those exist, "accepted" means "policy ships and behaves to
spec; product impact remains to be measured."

---

## 6 · Recommended next step

**First-deck structure decision.** Specifically: schedule the live capture
that this chapter could not produce, then decide Phase B.1 vs. lens
vocabulary vs. rollback from that data. The smallest path is the one
already documented in `docs/diag_lens_arbitration_blocker_2026-05-19.md §C`:

1. In the next dev session you're already in (or a 20-minute dedicated
   session), set `FORENSIC_USER_ID` LOCALLY to your test account UUID in
   both `lib/recommender.ts:159` and `lib/retrieval/branchPlanner.ts:56`.
   **Do not commit.**
2. For each of S0..S4, sign in as that account, apply the lens, force a
   cold rebuild (close + reopen or clear `recPayloadCache`), and save the
   `[LENS_ARBITRATION]` + `[COLD_START_ADJACENT]` console lines to
   `.local/lens_arb_logs/2026-05-26_S{0..4}_*.log`.
3. Run the aggregator:
   ```
   npx tsx scripts/diag_lens_arbitration_aggregate.ts \
     --S0 .local/lens_arb_logs/2026-05-26_S0_baseline.log \
     --S1 …  --S2 …  --S3 …  --S4 … \
     --out docs/diag_lens_arbitration_observation_2026-05-26.md
   ```
4. Revert `FORENSIC_USER_ID` to `''` in both files. Re-run
   `validate_steering_field_contract` + `validate_lens_arbitration_log_shape`
   + `validate_cold_start_adjacent`.

The aggregator's first-match-wins decision tree
(Calibrate → Expand retrieval → Proceed → Defer) will then deterministically
select among:

- **Phase B.1** (lens-aware breadth modulation) — only if classifier
  miss rate is acceptable AND `n_wem`/`lfa_any` show real arbitration.
- **First-deck structure / slot-reservation** — if S1..S4 still don't
  diverge after Phase B, the bottleneck is composition, not retrieval.
- **Lens vocabulary / lifecycle** — if classifier miss rate hasn't moved
  off 70%, C1 needs another pass (or a corpus widening beyond OL subjects).
- **Phase B rollback** — only if Phase B *worsens* something measurable.
  Plan-level evidence and the structural delta give no reason to expect
  this; no precondition for rollback has been triggered.

**Do not open Phase B.1 planning without that live capture in hand.** The
classifier_miss_rate aggregator threshold (35% / 70%) is the explicit gate.

---

## 7 · Artifacts touched this turn

- `scripts/runtime_observe_phase_b_s0_s4.ts` — new read-only harness; runs
  `planBranches()` against five lens scenarios × two confidenceModes and
  prints plan-level evidence. Re-runnable.
- This file (`docs/diag_phase_b_reobservation_2026-05-26.md`).

**No source mutations.** `FORENSIC_USER_ID = ''` in both files unchanged.
No validator changes. No `recValidity` change.
