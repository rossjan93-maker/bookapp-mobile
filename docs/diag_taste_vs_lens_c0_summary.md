# Diagnostic Summary — Taste-vs-Lens × C0 (actual classifier output)

**Companion to:** `docs/diag_taste_vs_lens_c0_report.md` (the raw machine-generated per-lens table — regeneratable via `npx tsx scripts/diag_taste_vs_lens_c0_report.ts`).

**Status:** diagnostic only. No code touched in product paths. No ranking, scoring, composer, RecCard, finalGate, No-dark, recValidity, or signal-list change. C1 not started. Steering UI not started.

**Source of truth:** all classifier outputs in this summary come from **actual `deriveBookEvidence(...)` + `getBookTraits(...)` + `evaluateBookAgainstIntentLens(...)` runs** against the 10 hand-curated fixtures in `scripts/diag_taste_vs_lens_c0_report.ts`. Fixture *inputs* (subjects, description, page_count) are curated from public OL/GBooks metadata; classifier *outputs* are real. Re-run any time.

**One framing caveat (from code-review pass):** §1 Finding B and §5 use causal phrasing ("blocker IS ranking arbitration"). The 100%-routed-to-arbitration figure comes from the diagnostic's **issue-type heuristic** (`classifyIssue` in the script), not from instrumented arbitration mechanics (`clampP4IntentStack`, reservation, composition). Read those lines as **diagnostic inference**, not proof. The Phase 1 chapter (§7) is exactly what would *confirm* the inference with live `[LENS_ARBITRATION]` log data.

---

## 1. Executive diagnosis

Three findings, all backed by the per-lens table in the companion report:

### Finding A: The C0 classifier is accurate on this catalog. The blocker is NOT the classifier.
- **100% catch rate** on taste-fit-but-lens-mismatch books across non-baseline lenses: every single one (18/18) carries either `emotionalWeight=high/specific` OR `tone=dark/specific`. The classifier flags them all.
- Concrete instances on the **Light & accessible** lens: Gone Girl → `tone=dark/spec` + `emotionalWeight=high/spec (marriage in crisis)`. The Silent Patient → `tone=dark/spec`. Sometimes I Lie → `tone=dark/spec` + `intensity=high/spec (page-turner)`. Verity → `tone=dark/spec` + `emotionalWeight=high/spec (family secrets)`.
- The classifier output IS available at scoring time. The deck still shows these books because nothing consumes the signal.

### Finding B: The blocker IS ranking arbitration, on every lens that's structurally "soft-only".
- **Light & accessible** with just `light_fun` active (no `avoid_dark`): **6 of 10 fixtures are taste-fit-but-lens-mismatch and finalGate hard-excludes ZERO of them.** Soft-only lenses pass everything through; the +0.06 tone-fit nudge is dominated by the +0.05 stated-taste floor + branch-quota retrieval guarantee. Issue type machine-tagged as `classifier correct but not used (ranking arbitration: taste overpowers lens)` for each one.
- **Less dark** (intensity=low soft pref): identical pattern — 6 of 10 taste-fit-mismatch, 0 hard-excluded. The lens has no authority to remove anything.
- **Fast-paced**: 0/10 mismatch — but only because the lens *agrees with* the thriller bias. Lens delivers no observable signal. This is the UI-semantics issue from the prior audit, confirmed: a lens that always matches the user's taste lane is indistinguishable from no lens at all.

### Finding C: The Short & light + No dark deck the user observed is the contracted behavior, not a bug.
- **Short & light + No dark**: 6 of 10 hard-excluded by `avoid_dark` (all 4 thrillers + Gone Girl + Silent Patient). The 4 survivors — Thursday Murder Club, Everything I Never Told You, The Maid, In Love — **exactly match the user's observed deck.**
- Everything I Never Told You and In Love survive because they don't carry **darkPhrasal** evidence (which `avoid_dark` consumes). They DO carry `emotionalWeight=high/spec` (`family secrets`, `grief and loss`) — but the C0 isolation contract explicitly forbids No-dark from consuming the new axes.
- **No-dark behaved exactly as designed. The user's surprise is a UI-semantics issue: "No dark" promises "no dark themes / dark tone"; users read it as "nothing heavy". These are different products. The audit doc (`audit_taste_vs_lens_conflict_deck_evidence.md §3`) labeled this the carry-forward case; the actual run confirms it.**

### Headline
> The C0 classifier passes its job. The arbitration layer does not let it move the deck. The "No dark vs emotionally heavy" semantic distinction is not communicated to users.

This is **the same diagnosis as `audit_taste_vs_lens_conflict_deck_evidence.md`**, now with actual measurements replacing predictions. The audit's prior predictions for the four diagnostic cells (Gone Girl, Everything I Never Told You, In Love, Silent Patient) held against the real classifier.

---

## 2. Observation table by lens

See `docs/diag_taste_vs_lens_c0_report.md` — 5 lenses × 10 books = 50 rows with 16 columns each (title, author, market_position, durable_taste, tone+conf, pace+conf, complexity+conf, intensity bucket+first phrase, emotional weight bucket+first phrase, lens fit verdict, finalGate hard-exclude, hard reasons, soft demotions, taste-fit-but-lens-mismatch, machine-tagged issue type).

Highlights from each lens (per-lens summary lines at the bottom of each section):

| Lens | Match | Mismatch | Taste-fit-but-lens-mismatch | finalGate hard-excluded |
|---|---|---|---|---|
| Baseline / no lens                | 0/10 | 0/10 | n/a      | 0/10 |
| Light & accessible (`light_fun`)  | 2/10 | 8/10 | **6/10** | 0/10 |
| Fast-paced / immersive            | 6/10 | 1/10 | 0/10     | 0/10 |
| Short & light + No dark           | 2/10 | 8/10 | 6/10     | **6/10** |
| Less dark                         | 4/10 | 6/10 | **6/10** | 0/10 |

---

## 3. % of top-10 that are taste-fit-but-lens-mismatch

- **Across all 4 non-baseline lenses (40 evaluations):** 18 / 40 = **45.0%**
- **Among soft-only lenses (Light & accessible + Less dark, 20 evaluations):** 12 / 20 = **60.0%**
- **Light & accessible alone:** 6 / 10 = **60.0%**

For a Mystery/Thriller user, six of every ten books served under a soft mood lens are flagged by C0 as taste-fit-but-lens-mismatch. This is the load-bearing number.

---

## 4. Is the C0 classifier accurate enough to use?

**Yes, on this catalog. Caveats two.**

- **Catch rate**: 18 / 18 = 100% on the mismatched set. Every single book the user-side judgment marked as lens-mismatch was flagged by C0 (`emotionalWeight=high/specific`) and/or by the tone classifier (`tone=dark/specific`).
- **Caveat 1 — fixture inputs are curated, not Supabase-fetched.** Real catalog metadata may be sparser. The validator suite (`validate_book_evidence_intensity`, 122 assertions) covers the synthetic fixture matrix; the operator runbook (`docs/book_evidence_c0_observation_runbook.md`) covers the live-catalog observation. Until the operator runs one forensic-mode pass against the real Supabase fixtures, the 100% number is "classifier is correct *when the metadata is rich enough*." For sparse-metadata books (most likely cause of any future miss), `c_len` in the `[BOOK_EVIDENCE_C]` log will reveal which books are too thin to fairly judge.
- **Caveat 2 — the diagnostic ran 10 books, not 100.** A larger replay (e.g. the user's full Goodreads import sample, ~273 books) is the natural next step before any production-grade calibration claim.

**Verdict for the next planning decision:** the classifier is accurate enough to start designing arbitration / steering against. Calibration is not the gating concern.

---

## 5. Is the main issue arbitration, classifier calibration, or UI semantics?

**Arbitration and UI semantics — in that order. Calibration is not the bottleneck.**

Per-issue tally across the 18 taste-fit-but-lens-mismatch rows (machine-tagged, see report column `Issue type`):

| Issue type | Count | % |
|---|---|---|
| classifier correct but not used (ranking arbitration: taste overpowers lens) | 18 | **100%** |
| classifier underfiring (metadata/corpus gap or signal-set gap) | 0 | 0% |
| classifier overfiring | 0 | 0% |
| UI semantics underdefined (lens does not override adjacent-lane promotion) | 0 *across taste-fit-mismatch rows* | — |

Two additional rows in the report carry `UI semantics underdefined` — Everything I Never Told You and In Love under the soft lenses. They are tagged "off-lane / adjacent" rather than "taste-fit-but-lens-mismatch" because the durable taste did NOT pick them (they're not Mystery/Thriller). But they ARE lens-mismatched (heavy emotional weight under "Light & accessible" / "Short & light"). **The Short & light + No dark case is the cleanest single argument that the UI-semantics issue is real: the user sees a 4-book deck where 2 books violate the spirit of the lens despite the gate being technically correct.**

So the two-issue split for the practical user experience:

- **Arbitration (Finding B)** — 100% of taste-fit-but-lens-mismatch rows. **Highest leverage**: fix once, fixes 60% of soft-lens decks.
- **UI semantics (Finding C)** — independent issue. Even with perfect arbitration, "No dark" promising "nothing heavy" will keep surprising users until the product names the distinction.

---

## 6. If/then decision (per the criteria in the task brief)

The brief's four decision branches:

| Condition | Met? | Action |
|---|---|---|
| classifier accurate AND mismatch rate high | ✅ 100% catch rate, 45–60% mismatch rate | → **plan Lens-vs-Taste Steering Phase 1** |
| classifier inaccurate | ❌ no | → calibrate signal lists — NOT needed |
| mismatch rate low | ❌ 45–60% on soft lenses — high | → defer steering — NOT applicable |
| UI semantics unclear | ✅ yes (the No-dark vs heavy distinction; the Fast-paced no-op) | → **plan copy/control semantics before ranking** |

**Two conditions are met.** Both point at the same next chapter family. The brief says "before ranking" for the UI-semantics path — that is exactly the shape of the Phase 1 chapter (semantics + shadow-mode steering field + measurement log — **no ranking change yet**). So both conditions converge.

---

## 7. Recommended next chapter

**Chapter — Lens-vs-Taste Steering, Phase 1** (already drafted in `docs/audit_taste_vs_lens_conflict.md §7` and reaffirmed in `docs/audit_taste_vs_lens_conflict_deck_evidence.md §7`). This diagnostic confirms it is the right next chapter, with one decision-narrowing update:

### Updated pre-requisites (from this diagnostic)
- ✅ **C0 classifier accuracy confirmed on the diagnostic catalog** — 100% catch rate. No calibration prerequisite blocks the chapter.
- ⏳ **One live-catalog forensic observation pass** still recommended before chapter approval. Goal: confirm the curated-fixture 100% catch rate holds on real Supabase metadata (might drop on sparse-metadata books; would inform tiny signal-list additions if so). Runbook: `docs/book_evidence_c0_observation_runbook.md`.

### Confirmed scope of Phase 1 (no change from prior audits)
- Add typed shadow-mode `tasteVsIntent: 'taste_first' | 'balanced' | 'mood_first'` field on `NextReadIntent`, default `'balanced'`, byte-identical behavior at default.
- Add `[LENS_ARBITRATION]` DEV log under `FORENSIC_USER_ID` gate, mirroring `[BOOK_EVIDENCE_C]` shape. Per-book emit: `{ stated_taste_value, p4c_pos_stack, p4c_neg_stack, p4c_clamped, lens_active, lens_kind, would_eject_under_mood_first }`.
- Two new validators: `validate_steering_field_contract` + `validate_lens_arbitration_log_shape`.
- Status target: **shipped (contract-only)**. Not product accepted.

### Explicit forbid list for Phase 1
- ❌ No `clampP4IntentStack` change.
- ❌ No `BRANCH_QUOTAS` change.
- ❌ No `statedReservation.eligibleCauses` widening.
- ❌ No new composer reason kinds. No RecCard change.
- ❌ No No-dark behavior change.
- ❌ No `recValidity.VERSION` bump (rcv6 preserved).
- ❌ No C1 admission of `intensity` / `emotionalWeight` into ranking or composer.
- ❌ No new signal phrases.

### What Phase 1 measures (the load-bearing input for Phase 2)
The diagnostic above already proves that **C0 + tone classifier evidence is in hand** for every book the user judges as lens-mismatch. What's still unknown — and what only Phase 1's `[LENS_ARBITRATION]` log can measure on a live build — is:
- **How often does `clampP4IntentStack` actually fire the stated-floor protection clamp on lens-applied builds?** This is the number that decides whether Phase 2 is a `clampP4IntentStack` change (small, surgical) or a deeper retrieval/reservation rework (larger).
- **How does the would-be-mood_first deck differ from the current balanced deck?** Shadow-counted under each `tasteVsIntent` value, even though only `balanced` is live.

### What Phase 1 does NOT decide
- ❌ Does NOT pick the final default position (`taste_first` vs `balanced`).
- ❌ Does NOT design the steering UI control (chips? toggle? hidden in advanced?).
- ❌ Does NOT pick the No-dark-vs-heavy copy fix.

Those decisions are for Phase 2, scoped against the Phase 1 measurement data.

---

## What this diagnostic does NOT do
- ❌ Does not change any product code.
- ❌ Does not change ranking, scoring, composer, RecCard, finalGate, or No-dark.
- ❌ Does not add or modify any signal phrases in `lib/evidence/signals.ts`.
- ❌ Does not bump `recValidity.VERSION`.
- ❌ Does not start C1 or the steering UI implementation.
- ❌ Does not claim the curated-fixture catch rate generalizes to the full Supabase catalog — confirm via the operator runbook pass.

It produces the actual classifier outputs against the 4 observed decks and machine-routes each book to an issue-type bucket. The decision tree in §6 points unambiguously at the Phase 1 chapter as the next thing to plan.
