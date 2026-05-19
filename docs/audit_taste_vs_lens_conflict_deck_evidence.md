# Audit — Deck-level evidence + steering proposal (companion to `audit_taste_vs_lens_conflict.md`)

**Status:** diagnosis only. No implementation. No code, ranking, RecCard, composer, or No-dark changes. C1 not started. No signal phrases added.

**Companion to:** `docs/audit_taste_vs_lens_conflict.md` — that doc owns Sections 1, 2, 4, 6, 7 (architecture map, path map, conflict-resolution walkthrough, if/then tree, next chapter proposal). **Read it first.** This doc adds:
- Concrete deck-level evidence table for the 12 observed titles (Section 3).
- A focused evaluation of the proposed steering-strength control (Section 5).
- A confirmed routing recommendation grounded in the observed deck (Section 5–6).

**Hard reminder.** Title-specific judgments below are **diagnostic fixtures**, not product logic. No title belongs in runtime code; this is invariant from `replit.md`.

---

## 1. Executive diagnosis (updated for the observed decks)

The four observed decks **confirm** the architectural diagnosis from the prior audit and **add one new signal** about No-dark:

1. **Light & accessible (`light_fun`)** — 1 of 4 is plausibly light (Thursday Murder Club). The other 3 (Gone Girl, Everything I Never Told You, The Silent Patient) are taste-fit-but-lens-mismatch. **Classifier prediction (pre-observation): Batch C0 would correctly flag at least 2 of the 3 mismatches** — Gone Girl on `marriage in crisis` → `emotionalWeight=high/spec`, Everything I Never Told You on `family secrets` → `emotionalWeight=high/spec`. The classifier is doing roughly the right thing; the deck doesn't reflect it because **the arbitration layer prevents the signal from moving the deck**. This is exactly the §3 walkthrough from the prior audit playing out on live data.
2. **Fast-paced / immersive** — deck is identical to baseline. Pace lens contributes `±0.04` per book; that is dominated by the +0.05 stated-taste floor + retrieval quota for `thriller_mystery`. Symptom: "lens did nothing." Diagnosis: pace nudge is too small to move the deck against guaranteed thriller retrieval.
3. **Short & light + No dark** (note: user combined two lenses) — 4-book deck. Thursday Murder Club ✓, The Maid ✓ (cozy mystery, low-stakes). **Everything I Never Told You and In Love are taste-fit lens-mismatches that the No-dark hard gate did not catch.** This is the load-bearing finding for No-dark: `In Love` is a memoir of loss; it carries `emotionalWeight=high/specific` (per the C0 SignalSet "memoir of loss"), but No-dark inspects `darkPhrasal` evidence, not `emotionalWeight`. By design (the BookEvidence C0 isolation contract), the new axes do not feed the gate. **So No-dark's failure here is the predicted, contracted behavior — not a bug.** It is, however, the cleanest argument I have seen yet for why a C1 admission gate (`emotionalWeight=high` softly demotes under `light_fun`/`palate_cleanser`) would deliver visible product value. It is **not** an argument for adding `emotionalWeight` to the No-dark hard gate — that remains parked behind the planning chapter the C0 invariants require.
4. **Baseline vs Fast-paced are identical** — strongest single piece of evidence that soft lenses have insufficient authority over durable taste under the current arbitration.

**Headline:** the observed decks rule out "classifier underfiring" as the *primary* root cause (the classifier would likely catch Gone Girl + Everything I Never Told You) and rule in "ranking arbitration + UI semantics" as the primary blocker. **All three layers still need work; ordering from the prior audit (UI semantics → ranking arbitration → classifier calibration) is reinforced, not changed.**

---

## 2. Durable taste vs lens path map

**Unchanged from `audit_taste_vs_lens_conflict.md §2`.** See that table; file:line citations are correct as of 2026-05-19. No new path discovered while reviewing the observed decks.

Single load-bearing line from the prior audit, repeated here so the conclusions section below stays self-contained:

> `clampP4IntentStack` (`lib/recPolicy.ts:322-338`) explicitly clamps the P4 negative stack so it cannot erase the `stated_taste_fit` floor — **durable taste wins close arbitration by design.**

---

## 3. C0 evidence table for the observed decks

**Critical caveats:**
- **C0 fields below are PREDICTED**, not observed. The operator has not yet run the forensic-mode observation pass per `docs/book_evidence_c0_observation_runbook.md`. Predictions are based on (a) the C0 SignalSet vocabulary I authored in `lib/evidence/signals.ts`, (b) the books' public descriptions, (c) the Batch B tone/pace/complexity classifier shape. Predictions are marked **(pred)**. Confirm by running the runbook before relying on any column as ground truth.
- **`market_position` and `author`** are populated from generally-known book metadata, not from a live Supabase fetch. Operator should re-confirm during the observation pass.
- "issue type" routes the finding to a follow-up chapter; see §5–6 below.

### Baseline (no lens active)
| Title | Author | Visible reason (likely) | Durable taste fit | Lens fit | Tone / conf | Pace / conf | Complexity / conf | Intensity (pred) | Emotional weight (pred) | Market position | Mismatch? | Issue type |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sometimes I Lie | Alice Feeney | "Matches your taste — psychological thriller" | ✅ thriller_mystery favorite | n/a (no lens) | dark / spec | fast / spec | medium / broad | spec (page-turner) | unknown | bestseller_thriller | n/a | n/a — baseline correct |
| Verity | Colleen Hoover | "Matches your taste — thriller / romantic suspense" | ✅ thriller_mystery favorite | n/a | dark / spec | fast / spec | medium / broad | broad (taut) | spec (marriage in crisis) | bestseller_thriller | n/a | n/a |
| The Perfect Marriage | Jeneva Rose | "Matches your taste — legal thriller" | ✅ thriller_mystery favorite | n/a | dark / broad | fast / broad | low / broad | unknown | spec (marriage in crisis) | bestseller_thriller | n/a | n/a |
| Never Lie | Freida McFadden | "Matches your taste — psychological thriller" | ✅ thriller_mystery favorite | n/a | dark / spec | fast / spec | low / broad | broad (page-turner) | unknown | bestseller_thriller | n/a | n/a |

**Baseline finding:** all four are tight thriller_mystery matches. Deck is correct for "no lens applied." Useful as the **reference distribution** — every other deck below should be measured against how far it moved from this one.

### Light & accessible (`light_fun`)
| Title | Author | Visible reason (likely) | Durable taste fit | Lens fit | Tone / conf | Pace / conf | Complexity / conf | Intensity (pred) | Emotional weight (pred) | Market position | Mismatch? | Issue type |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| The Thursday Murder Club | Richard Osman | "Lighter tone, in line with your current intent" (P4D admission) | ✅ thriller_mystery (cozy) | ✅ light | light / spec (`cozy mystery`) | medium / broad | low / broad | low / spec (`cozy mystery`) | low / spec (`cozy mystery`) | bestseller_cozy_mystery | **No** — actually correct | n/a |
| Gone Girl | Gillian Flynn | "Matches your taste — psychological thriller" (no lens cite — P4D gate fails) | ✅ thriller_mystery favorite | ❌ dark | dark / spec | fast / spec | medium / broad | broad (taut) | **spec** (`marriage in crisis`) | bestseller_thriller | **Yes** | **ranking arbitration** (classifier catches it; nudge too small) |
| Everything I Never Told You | Celeste Ng | "Critically acclaimed literary fiction" | ⚠ adjacent (literary, not thriller) | ❌ heavy | dark / broad | slow / broad | high / spec | low / broad (`quiet`) | **spec** (`family secrets`, `grief`) | literary_award | **Yes** | **ranking arbitration + classifier** (axes correct, arbitration ignores) |
| The Silent Patient | Alex Michaelides | "Matches your taste — psychological thriller" | ✅ thriller_mystery favorite | ❌ dark | dark / spec | fast / spec | medium / broad | broad (page-turner) | unknown | bestseller_thriller | **Yes** | **ranking arbitration** + possible **metadata gap** (no specific wt phrase) |

**Light & accessible finding:** 3 of 4 are taste-fit-but-lens-mismatch. C0 predicted classifications would correctly flag the worst-mismatched 2 (Gone Girl, Everything I Never Told You) via `emotionalWeight=high/specific`. **The classifier is plausibly doing its job; the deck doesn't show it because arbitration ignores it.** The Silent Patient is the murkiest case — the classifier may legitimately not fire (no canonical "marriage in crisis" / "family secrets" / "grief" phrase in its metadata) — which would be a metadata-gap problem, not a classifier-vocabulary problem. Confirm via observation pass.

### Fast-paced / immersive
| Title | Author | Visible reason (likely) | Durable taste fit | Lens fit | Tone / conf | Pace / conf | Complexity / conf | Intensity (pred) | Emotional weight (pred) | Market position | Mismatch? | Issue type |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sometimes I Lie | Alice Feeney | (same as baseline) | ✅ | ✅ fast | dark / spec | fast / spec | medium / broad | spec | unknown | bestseller_thriller | **No** | n/a |
| Verity | Colleen Hoover | (same as baseline) | ✅ | ✅ fast | dark / spec | fast / spec | medium / broad | broad | spec | bestseller_thriller | **No** | n/a |
| The Perfect Marriage | Jeneva Rose | (same as baseline) | ✅ | ✅ fast | dark / broad | fast / broad | low / broad | unknown | spec | bestseller_thriller | **No** | n/a |
| Never Lie | Freida McFadden | (same as baseline) | ✅ | ✅ fast | dark / spec | fast / spec | low / broad | broad | unknown | bestseller_thriller | **No** | n/a |

**Fast-paced finding:** deck **identical** to baseline. The pace contribution (`±0.04` per book) is small and **aligned with the durable taste** — thrillers are typically fast. The lens cannot move the deck because the deck already satisfies the lens *under* the durable taste. **Issue type for all four: none — but the lens delivers zero observable signal to the user.** This is a **UI-semantics** issue: the lens label promises a shift that doesn't (and can't) materialize when taste and lens point the same direction. Consider: should the UI hide / disable a lens that won't move the deck?

### Short & light + No dark (combined)
| Title | Author | Visible reason (likely) | Durable taste fit | Lens fit | Tone / conf | Pace / conf | Complexity / conf | Intensity (pred) | Emotional weight (pred) | Market position | Mismatch? | Issue type |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| The Thursday Murder Club | Richard Osman | "Lighter tone, in line with your current intent" | ✅ thriller_mystery (cozy) | ✅ light + not dark | light / spec | medium / broad | low / broad | low / spec | low / spec | bestseller_cozy_mystery | **No** | n/a |
| Everything I Never Told You | Celeste Ng | "Critically acclaimed literary fiction" | ⚠ adjacent | ❌ heavy (not technically "dark" in the No-dark sense) | dark / broad | slow / broad | high / spec | low / broad | **spec** (`family secrets`, `grief`) | literary_award | **Yes** | **ranking arbitration + UI semantics** — No-dark gate is *contractually* not allowed to consume `emotionalWeight` (C0 isolation invariant). User cannot tell the difference between "dark themes" and "emotionally heavy" today. |
| The Maid | Nita Prose | "Matches your taste — cozy mystery" | ✅ thriller_mystery (cozy) | ✅ light + not dark | light / broad | medium / broad | low / broad | broad (`cozy`) | broad (`light`) | bestseller_cozy_mystery | **No** | n/a |
| In Love | Amy Bloom | "Critically acclaimed memoir" | ⚠ adjacent (memoir) | ❌ heavy | n/a / n/a | slow / broad | medium / broad | spec (`quiet meditation`) | **spec** (`memoir of loss`, `meditation on mortality`) | literary_memoir | **Yes** | **UI semantics** — No-dark says "no dark themes"; book is light-prose but life-and-death subject matter. The carry-forward "emotionally heavy non-dark" mismatch from Batch B audit. **C0 caught it (predicted); No-dark contractually cannot use C0; user surprised.** |

**Short & light + No dark finding (most diagnostically valuable deck of the four):**
- 2 books correctly placed (Thursday Murder Club, The Maid — both cozy mystery, palate-cleanser-appropriate).
- 2 books that are EXACTLY the carry-forward "emotionally heavy non-dark" case Batch C C0 was designed to MEASURE. The C0 classifier (per prediction) flags both correctly. The lenses cannot use that signal today, by C0 isolation contract.
- **This is the cleanest live argument for the C1 admission gate**, scoped to soft-lens softDemotion (NOT to the No-dark hard gate). C1 should: when `light_fun` OR `palate_cleanser` is active AND `bookEvidence.emotionalWeightHigh.specificCount ≥ 1`, contribute a `weight_fit = -0.06` mismatch (mirroring `toneFit` exactly). Composer admission of `weight_fit` reason copy can wait for C2.
- It is **NOT** an argument to expand No-dark. No-dark is "avoid dark themes / dark tone"; `In Love` does not have dark tone, it has heavy subject matter. The product distinction is meaningful and must be preserved in the UI.

---

## 4. Current conflict-resolution behavior — confirmed against the observed decks

The §3 walkthrough in the prior audit predicts exactly the Light & accessible deck. Quote-and-confirm:

> "A Mystery favorite + `light_fun` lens → thriller stays in the top slate, possibly with a ~`-0.06` to `-0.12` tone-mismatch nudge that re-orders within the slate but does not eject."

Observed Light & accessible deck: 3 thrillers (Gone Girl, Silent Patient — and Everything I Never Told You which adjacent-promotes via a literary lane) + 1 cozy mystery (Thursday Murder Club). The cozy mystery slipping in is encouraging — that is the `toneFit=+0.06` lens working in concert with stated taste retrieval, exactly as designed. **The architecture is doing what it is built to do. The disagreement is between what it is built to do and what the user expected from "Light & accessible".**

This is an "underdefined product semantics" diagnosis with high confidence.

---

## 5. Recommendation — focused on the steering-strength UI proposal

The prior audit (§5) recommended all three layers in order: **UI semantics → ranking arbitration → classifier calibration.** The observed decks reinforce this ordering. This section focuses on the specific steering-strength UI proposed in the new brief.

### Proposed control
> "Your Next Read steering strength: **Stay close to my taste** / **Balance taste and mood** / **Prioritize today's mood**"

### Should it ship? — **Yes, conditionally**, as the spine of the next planning chapter.

**Why it is the right shape:**
- It makes the arbitration a **user decision**, not a hidden policy. Today the policy ships as `clampP4IntentStack` and the user has no vocabulary for it.
- It is **three positions, not a slider** — discrete positions are far easier to reason about, validate, and explain than a 0–100 dial.
- The **default position ("Balance")** maps to today's behavior exactly. Existing users see zero change unless they opt in. This is the only ship-shape that respects the trust users have built around durable taste honoring.
- It cleanly bisects the "what does Light & accessible mean?" question — *Light & accessible* under "Stay close" means cozy mysteries; under "Prioritize mood" means cozy reads from anywhere; under "Balance" the user explicitly agrees to today's compromise.

### How it should behave (proposed; not for implementation):
| Position | Retrieval | Scoring | Composition | UI affordance |
|---|---|---|---|---|
| **Stay close to my taste** (taste_first) | `statedGenres` quota +1 (mirror EDIT_CAUSE_BRANCH_BOOST shape); revealedLanes -1 | `clampP4IntentStack` runs as today (taste floor protected) | `statedReservation` eligible on lens apply too | Lens chips render with subtle "within your taste" affordance |
| **Balance** (balanced, default) | quotas unchanged from today | `clampP4IntentStack` runs as today | unchanged | Lens chips render as today |
| **Prioritize today's mood** (mood_first) | `statedGenres` quota -1, revealedLanes -1, exploration +2 | `clampP4IntentStack` skips the stated-floor protection clamp; taste floor still emits but P4 may cancel it (capped at stack ±0.30) | `statedReservation` skipped on lens apply | Lens chips render with "even outside your usual taste" affordance |

### Mapping to ranking — single load-bearing change
`clampP4IntentStack(positives, negatives, statedTaste, mode: 'protect_taste' | 'no_protect')` — a fourth parameter. `'protect_taste'` (default and for taste_first/balanced) preserves today's contract. `'no_protect'` (for mood_first) lets the lens fully cancel the stated bump but never exceed stack ±0.30. **No new contribution kinds. No new caps. No new evidence types.** This is the smallest possible arbitration change that delivers the user-visible promise.

### Session-only vs persistent — **session-only**
- The steering position is a *session intent attribute*, not a durable preference. Persisting it would silently rewrite the user's relationship to their own Reading Taste, which is the trust contract this control is designed to preserve.
- Implementation: lives on `NextReadIntent`, persists with the active intent session, clears when the lens is cleared or the session ends. Same lifetime as the lens itself.

### Should it be a visible UI control? — **Yes, but only when a soft lens is active**
- Render the three-position control directly under the active Your Next Read lens chip. Hidden when no soft lens is active (it has no effect).
- Default position: "Balance". Sticky to last-chosen for the **current** lens within the session, resets to "Balance" on session end. Never persisted across sessions in v1.
- "Stay close" / "Prioritize today's mood" each carry a one-line explanatory tooltip — these are the only place in the product where the lens-vs-taste arbitration is explained to the user.

### What validators would prove it
1. `validate_steering_field_contract` — `NextReadIntent.tasteVsIntent` defaults to `'balanced'`, serialization round-trips, byte-identical behavior at `'balanced'` against existing fixtures.
2. `validate_clamp_modes` — `clampP4IntentStack(_, _, _, 'protect_taste')` is byte-identical to today's signature; `clampP4IntentStack(_, _, _, 'no_protect')` allows neg < -statedTaste up to stack cap; positive-control on a fixture where taste = +0.10, negatives = -0.30 returns `-0.20` under no_protect vs `-0.10` under protect_taste.
3. `validate_steering_retrieval` — `taste_first` adds +1 to statedGenres quota, mirroring `EDIT_CAUSE_BRANCH_BOOST`. `mood_first` subtracts 1, exploration +2, sum across branches stays ≤ 11 (the BRANCH_QUOTAS plan-size invariant).
4. `validate_steering_reservation` — `statedReservation` runs on lens apply when steering=`taste_first` (mirroring `explicit_preference_edit`); skipped when steering=`mood_first`.
5. `validate_steering_composer` — composer reason copy gains no new kinds. Verifies the steering position does NOT cause any RecCard / composer change.
6. `validate_steering_no_dark_isolation` — extends `validate_no_dark_isolation` with one section: steering position cannot influence the No-dark hard gate (No-dark stays hard at every steering position).
7. `validate_recvalidity_includes_steering` — `recValidity.configHash` includes the steering position; switching positions invalidates the persistent cache. (This **is** a `recValidity.VERSION` bump — `rcv6 → rcv7`. The first such bump since P4C.1.)

---

## 6. If/then decision tree (refined against the observed decks)

```
Q1: Run the operator observation pass (extended runbook table) on the Mystery/Thriller
    test account against Light & accessible + Short & light, BEFORE any new chapter.
    Confirms or refutes the predicted C0 classifications in §3.

  ├─ If observed [BOOK_EVIDENCE_C] confirms Gone Girl wt=high/spec AND
  │  Everything I Never Told You wt=high/spec AND In Love wt=high/spec
  │     → classifier is doing its job; the blocker is arbitration + UI.
  │     → Proceed to Q2 with confidence.
  │
  └─ If observed C0 fails to classify ≥ 2 of those 3 correctly
        → classifier IS underfiring on the observed catalog.
        → Add the missing phrases to `lib/evidence/signals.ts`, re-validate
          (validators stay green by construction). Re-run Q1.

Q2: Pick scope for the next planning chapter.

  ├─ Minimal-risk path → "Chapter — Lens-vs-Taste Steering, Phase 1"
  │   (per `audit_taste_vs_lens_conflict.md §7`):
  │   - Adds shadow-mode steering field + [LENS_ARBITRATION] DEV log only.
  │   - No UI. No ranking change. No clamp change. No retrieval change.
  │   - One forensic observation pass tells us how often the clamp fires
  │     on lens-applied builds (load-bearing for the *real* arbitration chapter).
  │   - Status: shipped (contract-only).
  │
  └─ Full-scope path → "Chapter — Lens-vs-Taste Steering, Phase 2"
      - Ships the three-position UI + the `clampP4IntentStack` mode parameter
        + the quota / reservation lens-awareness + `recValidity` bump to rcv7.
      - Ships C1 in parallel (or in a follow-up) so `mood_first` actually
        delivers visibly different decks via real evidence (emotionalWeight
        admission as softDemotion under light_fun / palate_cleanser).
      - Status: product accepted requires a live smoke pass.

Recommendation: ALWAYS do Phase 1 first, then Phase 2.
  Phase 1 is one week of cheap measurement that prevents Phase 2 from being
  designed in the dark. This is the same pattern that BookEvidence Batch B / C0
  followed and that protected the C0 design from speculative scope.
```

---

## 7. Minimal next planning chapter

**Unchanged from `audit_taste_vs_lens_conflict.md §7`** — that proposal (Lens-vs-Taste Steering, Phase 1, contract-only / shadow-mode steering field + `[LENS_ARBITRATION]` DEV log) is the right next step. The observed decks add a single concrete pre-requisite the prior proposal did not call out:

**Pre-requisite (new):** before the Phase 1 chapter is approved, the operator should run **one forensic observation pass** covering exactly the 5 decks above (baseline + Light & accessible + Fast-paced + Short & light + No dark), against a Mystery/Thriller-favorited test account, using the extended runbook table in `docs/book_evidence_c0_observation_runbook.md §4` plus the three new columns proposed in `audit_taste_vs_lens_conflict.md §8`. The observation pass confirms or refutes the predicted C0 classifications in §3 of this doc. If the predictions hold, the Phase 1 chapter ships as proposed. If predictions fail materially, calibration goes first.

**Confirmed scope of the Phase 1 chapter** (re-stated, no change):
- Shadow-mode `tasteVsIntent` field on `NextReadIntent`, default `'balanced'`, byte-identical behavior at default.
- `[LENS_ARBITRATION]` DEV log under FORENSIC_USER_ID gate, mirroring `[BOOK_EVIDENCE_C]` shape.
- Two validators: `validate_steering_field_contract` + `validate_lens_arbitration_log_shape`.
- Status target: shipped (contract-only). Not product accepted.
- Forbidden: clamp change, retrieval change, reservation change, composer change, RecCard change, No-dark change, recValidity bump, C1 admission.

---

## What this audit does NOT do
- ❌ Does not edit any code.
- ❌ Does not start C1.
- ❌ Does not add or change any signal phrases.
- ❌ Does not change ranking, composition, retrieval, finalGate, composer, or RecCard.
- ❌ Does not bump `recValidity.VERSION`.
- ❌ Does not promote any of the predicted C0 classifications to ground truth — confirm via observation.

It produces the deck-level evidence + steering UI evaluation. The Phase 1 chapter, when approved, will be scoped, planned, and validator-gated separately, gated behind one forensic observation pass first.
