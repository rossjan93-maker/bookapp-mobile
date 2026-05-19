# Audit — Reading Taste (durable) vs Your Next Read lens (session intent)

**Status:** diagnosis only. No implementation. Output intended as the input to a follow-up planning chapter that decides between classifier calibration, ranking arbitration, UI steering, or a combination.

---

## 1. Executive diagnosis

The user-observed symptom — "I applied Light & accessible (or Short & light) but my deck is still mostly mystery/thriller" — is **primarily a ranking-arbitration and UI-semantics issue, not a BookEvidence classifier issue.** C0 calibration will not fix it on its own.

The recommender today is **structurally biased toward durable taste over session intent at every pipeline stage:**

1. **Retrieval** keeps a non-zero `statedGenres` branch quota at every confidence mode, including `high_signal` (quota = 3). A Mystery/Thriller favorite always pulls thrillers into the candidate pool — the lens has no input here.
2. **Scoring** caps a single P4C kind at ±0.20 and the whole P4C stack at ±0.30. `stated_taste_fit` gets a +0.05 floor up to +0.12. Numerically the lens can outscore taste — but only if the BookEvidence classifier reliably fires `tone_fit = -0.06` mismatch for every thriller, which it does not (C0 observation pending).
3. **Stated-taste floor protection** (`clampP4IntentStack` at `lib/recPolicy.ts:322-338`) explicitly clamps the P4 negative stack so it cannot erase the stated `+0.05` floor. **This is a deliberate "durable taste wins ties" policy** — a Mystery favorite cannot be pushed below baseline by intent alone, by design.
4. **`light_fun` and `palate_cleanser` lenses are soft-only.** They do NOT hard-exclude, do NOT filter retrieval, and do NOT relax the `statedGenres` branch quota. Their entire ranking influence is `toneFitMismatch = -0.06` per book (capped) — a thumb on the scale, not a redirection of the deck.
5. **No user-facing steering knob exists.** The arbitration is a single policy line buried in `lib/recPolicy.ts`; the user has no language to say "this session, ignore my baseline taste and just give me what I asked for."

**The product semantics of "Light & accessible" are underdefined.** Code treats it as "lighter books within your existing taste" (soft tone-fit nudge). The user almost certainly reads it as "lighter books, even outside my usual taste." These are different products. The classifier debate (C0) is downstream of this ambiguity.

---

## 2. Durable taste vs session lens — path map

### Where durable Reading Taste enters
| Stage | File:Line | Mechanism | Magnitude / authority |
|---|---|---|---|
| Retrieval | `lib/retrieval/branchPlanner.ts:45,120-125` + `lib/recPolicy.ts:166-174` | `statedGenres` branch runs every build; quota = 4 (cold/thin) / 3 (high_signal). **Never zero.** | Guarantees presence in candidate pool. Not capped by lens. |
| Retrieval boost | `lib/recPolicy.ts:178-181` | `BuildCause = explicit_preference_edit` adds +1 to statedGenres, -1 to revealedLanes | Only on pref edit, not on lens apply |
| Scoring | `lib/recPolicy.ts:63-77, 107-146` (`computeStatedTasteContribution`) | `stated_taste_fit` contribution: +0.05 floor, +0.12 cap (favorite match); -0.06 floor, -0.15 cap (avoid match) | Always-on; per-book |
| Scoring protection | `lib/recPolicy.ts:322-338` (`clampP4IntentStack`) | When `stated_taste > 0`, the P4 negative stack is clamped to `max(stackNegCap, -stated_taste)`. Intent cannot fully erase the stated floor. | **Hard policy — durable taste wins close arbitration** |
| Composition | `lib/composition/statedReservation.ts:90-92, 148-211` + `lib/recPolicy.ts:255-260` | Top-slate reservation AND-gate; only fires on `BuildCause = explicit_preference_edit`. Allows ADJACENT pick on that cause. | One reserved slot per pref-edit build. **Does NOT fire on lens apply.** |
| Explanation | `lib/composition/statedReservation.ts:174` (audit flag `stated_favorite:<key>`) | Composer emits "stated_taste_fit" reasons | P3A-grade; reason quality OK |

### Where Your Next Read lens enters
| Lens | Hard filter (finalGate) | Soft demote | Retrieval bias | P4C scoring | Composer reason | Authority to override taste |
|---|---|---|---|---|---|---|
| **No dark** (`avoid_dark` with specific evidence) | ✅ `lib/nextReadIntent.ts:391`, gated by final visible-deck `lib/intent/finalGate.ts:187` | — | — | indirect via tone/complexity | — | **Yes (hard)** |
| **Less dark** (`avoid_dark` ambiguous) | ❌ | ✅ `less_dark_demotion` (`lib/nextReadIntent.ts:416`) | — | indirect | — | No — bounded demote only |
| **Light & accessible** (`light_fun`) | ❌ | ❌ | ❌ | ✅ → tone='light' via `lib/scoring/p4cContributions.ts:112`. `toneFitMatch=+0.06 / toneFitMismatch=-0.06`, capped per-kind ±0.20, stack ±0.30 | gated (P4D admission, specific-tone evidence required) | **Minimal** — ±0.06 thumb on the scale |
| **Short & light / palate cleanser** | partial (`max_page_count` becomes a hard catalog filter, `lib/nextReadIntent.ts:55`) | ❌ | page-count filter only | ✅ same as `light_fun` → tone='light' (`p4cContributions.ts:113`) | gated | **Minimal beyond page filter** |
| **Fast-paced / immersive** | ❌ | ❌ | ❌ | ✅ pace='fast' via P4C, ±0.04 per match | gated | **Minimal** — ±0.04 |
| **Avoid classics / literary / romance / nonfiction** | ✅ hard (`lib/nextReadIntent.ts:344-356`) | — | — | — | — | **Yes (hard)** |
| **Standalone only / Fiction only / Max page count** | ✅ hard | — | catalog filter | — | — | **Yes (hard)** |

### Key asymmetry
| Property | Durable taste | Session lens (soft kinds: light_fun, palate_cleanser, less_dark, fast_paced) |
|---|---|---|
| Retrieval guarantee | ✅ branch quota | ❌ none |
| Scoring magnitude | +0.05 floor → +0.12 cap | ±0.04 (pace) / ±0.06 (tone) per book |
| Stack cap | n/a (one kind) | ±0.30 across all P4C kinds |
| Floor protection | ✅ `clampP4IntentStack` protects taste floor | ❌ no equivalent protection |
| Composition reservation | ✅ on pref edit | ❌ never |
| User can override | ✅ edit preferences (durable) | ✅ apply lens (session) — but lens carries less authority than the taste it conflicts with |

**The lens has less institutional authority than the taste it is trying to override.** This is the architecture, not a bug.

---

## 3. Current conflict-resolution behavior — concrete walkthrough

Imagine a user with `favorite_genres = ['thriller_mystery']`, tier 2 (high_signal), applies `light_fun`. Pick any thriller in the candidate pool (`Gone Girl`). At score time:

- `stated_taste_fit` = `+0.05` floor → `+0.12` if affinity blend is strong (favorite match, tier 2 mult 1.0)
- Retrieval branch: `statedGenres` quota 3 → at least 3 thriller candidates regardless of lens
- P4C `tone_fit` contribution: only emits a **signed** value if BookEvidence has `bookToneConfidence === 'specific'`. For a thriller without an explicit "dark"/"light" tone phrase in subjects+description, `tone_fit` may be 0. If specific-dark evidence fires, the mismatch contribution is `-0.06`, capped by stack cap at `-0.30`.
- `clampP4IntentStack(positives, negatives, statedTaste=+0.12)` → `neg = max(-0.30, -0.12) = -0.12`. The negative stack is clamped at `-0.12`. **The thriller cannot be pushed below baseline by the lens.**

Net effect: a Mystery favorite + `light_fun` lens → thriller stays in the top slate, possibly with a ~`-0.06` to `-0.12` tone-mismatch nudge that re-orders within the slate but does not eject. Add in retrieval-side guaranteed thriller candidates, and the user-visible deck remains thriller-heavy. **This matches the symptom report exactly.**

For a `palate_cleanser` lens, the same logic applies *plus* a hard page-count filter (`max_page_count: 300`). Long thrillers drop out — but short thrillers stay, and `Gone Girl`-class books often slip in under 400pp.

---

## 4. Are the current product semantics underdefined? — Yes.

Four undefined behaviors:

1. **"Light & accessible" has no documented meaning.** Code says "soft tone-fit nudge within retrieved pool". UI implies "give me lighter books". User expects "even outside my usual taste". No spec arbitrates.
2. **"Short & light / palate cleanser" mixes a hard filter (page count) with a soft nudge (tone).** Half-hard, half-soft. Inconsistent authority.
3. **Lens vs taste arbitration is policy-baked.** `clampP4IntentStack` enforces "taste wins ties" globally. No lens can opt out. No BuildCause exists for "lens-driven rebuild" (only `intent_apply` / `intent_clear`, both treated like any other rebuild for reservation purposes).
4. **No user-facing language for the arbitration.** The user cannot tell the system "today I want to step outside my taste." The only way to do that is to edit durable preferences — and most users will not edit their durable Reading Taste just to try a different mood today.

---

## 5. Recommendation — all three layers need work, in order

| # | Layer | Why | Risk if skipped |
|---|---|---|---|
| 1 | **UI steering option** (product semantics) | Until the product decides what "Light & accessible" means, neither calibration nor arbitration changes are well-typed. This is the highest-leverage change. | Calibration debates become unwinnable because the target is undefined |
| 2 | **Ranking arbitration** (lens-aware stated reservation, lens-aware floor protection) | Even with perfect calibration, the structural asymmetry above prevents soft lenses from moving the deck enough | Classifier calibration burns cycles fighting an architecture that re-imposes thriller-bias |
| 3 | **Classifier calibration** (C0 → C1) | Necessary but not sufficient. Sharper tone/intensity evidence makes the existing nudges more reliable, but ±0.06 per book against a +0.12 floor + reservation will still under-deliver | Calibration alone produces small gains, user perception of "lens does nothing" persists |

**Do all three. Order matters.** Doing classifier-only first (the path C0/C1 was on) ships measurable internal improvements with no user-visible deck shift, which is exactly the scenario that the operating-standard "shipped ≠ product accepted" rule exists to prevent.

---

## 6. If / then decision tree

Use this to choose the next planning chapter:

```
Q1: Does the product want soft lenses (light_fun, palate_cleanser, less_dark)
    to be able to push the user's deck OUTSIDE their durable taste this session?

  ├─ NO  (product semantics = "lighter books WITHIN my existing taste")
  │   → No arbitration change needed. Plan only Chapter A: classifier
  │     calibration (C0 observation pass + C1 admission gate). Update UI copy
  │     for light_fun / palate_cleanser to clarify "within your taste".
  │
  └─ YES (product semantics = "lighter books even outside my usual taste")
      → Q2: Should this be the default, or opt-in per session?
        ├─ DEFAULT
        │   → Plan Chapter B: lens-aware floor protection. `clampP4IntentStack`
        │     gains a `lensOverridesStatedFloor` parameter; soft lenses set
        │     it true. Plus Chapter A (calibration) so the nudge is reliable.
        │
        └─ OPT-IN (recommended)
            → Plan Chapter C: three-position steering UI:
              "Stay close to my taste" | "Balanced" (default) | "Prioritize today's mood"
              Plus Chapter B (lens-aware arbitration) wired to the mood position.
              Plus Chapter A (calibration) so the mood position delivers.

Q3 (independent of Q1): Should `light_fun` / `palate_cleanser` reduce the
    statedGenres retrieval quota when active?

  ├─ NO  → leave retrieval alone; arbitration happens at scoring only
  └─ YES → add lens-aware BRANCH_QUOTAS modifier, mirror EDIT_CAUSE_BRANCH_BOOST
           shape. Only safe to do if Q1 = YES.
```

The recommended default path is the **OPT-IN steering branch (Q1=yes, Q2=opt-in)**, because:
- It preserves current behavior for users who never touch the steer (taste-first stays the default).
- It gives the user vocabulary to describe what they want.
- It defines the lens-vs-taste arbitration as a *user decision*, not a *policy choice* — which is the only way to ship lenses that actually re-shape the deck without breaking the trust of users who genuinely want their durable taste honored.

---

## 7. Minimal next planning chapter — proposal (not for implementation now)

**Title:** *Chapter — Lens-vs-Taste Steering, Phase 1 (semantics + UI placeholder + measurement)*

**Scope (intentionally minimal; the steering knob is the smallest thing that unblocks both arbitration and calibration):**

1. **Lock product semantics in writing.** Single page in `docs/`: define what each soft lens means under each steering position. The current ambiguity is the root blocker.
2. **Add the steering knob to `NextReadIntent`** as a typed field `tasteVsIntent: 'taste_first' | 'balanced' | 'mood_first'`, default `'balanced'`. **No ranking change yet** — the field is shadow-mode, observed via a DEV log identical in shape to the C0 `[BOOK_EVIDENCE_C]` pattern. Goal: see what value users *would* pick if given the choice, and how the resulting deck *would* look.
3. **Add a `[LENS_ARBITRATION]` DEV log** at the same forensic-trace site as `[BOOK_EVIDENCE_C]`, emitting per-book: `{ stated_taste_value, p4c_pos_stack, p4c_neg_stack, p4c_clamped, lens_active, lens_kind, would_eject_under_mood_first }`. This is the measurement we need *before* changing `clampP4IntentStack`. **One observation pass** (using the operator runbook shape from `docs/book_evidence_c0_observation_runbook.md`) tells us how often the floor-protection clamp actually fires on lens-applied builds — which is the load-bearing number for any arbitration redesign.
4. **Do NOT yet:** add the steering UI, change `clampP4IntentStack`, change `BRANCH_QUOTAS`, change `statedReservation` cause eligibility, or admit BookEvidence Batch C axes (C0 → C1) into scoring. Each of those is its own follow-on chapter, scoped against the data this chapter produces.

**Validators added by this chapter:**
- `validate_lens_arbitration_log_shape` — DEV log fires for soft lenses only, contains the seven fields, gated by `FORENSIC_USER_ID`.
- `validate_nextread_intent_steering_field` — `tasteVsIntent` defaults to `'balanced'`, is byte-identical for every existing fixture (no behavior delta), serialization round-trips.

**Acceptance gate:** "shipped (contract-only)", not "product accepted". Same status pattern as BookEvidence Batches B and C0.

**Forbidden in this chapter** (pin in the chapter doc):
- No `clampP4IntentStack` change.
- No `BRANCH_QUOTAS` change.
- No `statedReservation.eligibleCauses` widening.
- No new composer reason kinds.
- No `recValidity.VERSION` bump.

**Required before any *next* chapter:** one forensic observation pass with the steering log on, capturing baseline + each soft lens against a Mystery/Thriller-favorited test account, tabulated using the same shape as the C0 runbook. The number this produces — "% of top-10 books on a `light_fun` build where `clampP4IntentStack` clamped the negative stack away from -0.30" — is the load-bearing input to the arbitration chapter that follows.

---

## 8. C0 observation report (format only — to be filled by operator)

The C0 observation runbook already specifies the per-lens table format (`docs/book_evidence_c0_observation_runbook.md §4`). For this audit's purposes, the table is **extended with three additional columns** so a single observation pass produces evidence for both the C0 classifier question and the lens-vs-taste arbitration question:

| Field | Source | Why |
|---|---|---|
| title | `[BOOK_EVIDENCE_C].t` | identity |
| reason | RecCard composer output | what the user is told the book is for |
| **durable taste fit** *(new)* | `[FC1_TOP10]` line — sign of `stated_taste_fit` contribution | did taste pick this? |
| **current lens fit** *(new)* | `[FC1_TOP10]` line — sign of P4C `tone_fit` / `pace_fit` | did the lens pick this? |
| tone / pace / complexity | `[BOOK_EVIDENCE]` Batch B log | classifier evidence |
| intensity / emotionalWeight | `[BOOK_EVIDENCE_C]` log | C0 shadow evidence |
| **taste-fit but lens-mismatch?** *(new)* | manual: durable=+ AND lens=− | the symptom signature |
| **issue type** *(new)* | manual one of: `classifier_underfire` / `classifier_overclaim` / `ranking_arbitration` / `ui_semantics` / `none` | routes the finding to the right next chapter |

**Lenses for the pass** (in order, identical to runbook §2 plus one addition for fast-paced):
1. Baseline / no lens
2. Light & accessible (`light_fun`)
3. Fast-paced / immersive
4. Short & light (`palate_cleanser`)
5. No dark
6. Less dark

**Decision rule (per the if/then tree in §6):**
- If most "taste-fit but lens-mismatch" rows are `ranking_arbitration` → Q1=YES, proceed to the steering chapter (§7).
- If most are `classifier_underfire` → C0 calibration alone, follow the existing runbook.
- If split → both, in the order of §5.

**Status:** to be run by operator. Not blocking this audit's completion.

---

## What this audit does NOT do
- ❌ Does not edit any code.
- ❌ Does not change `recValidity.VERSION`.
- ❌ Does not start C1 work.
- ❌ Does not add a steering UI or change `clampP4IntentStack`.
- ❌ Does not modify retrieval, scoring, composition, or finalGate.

It produces the diagnostic and the proposed next chapter. The chapter itself, when approved, will be scoped, planned, and validator-gated separately.
