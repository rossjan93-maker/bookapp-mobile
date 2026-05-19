# Plan — Lens-vs-Taste Steering, Phase 1 (shadow-mode arbitration field)

**Status:** planning chapter only. **No implementation in this chapter.** No code touched.

**Predecessors:**
- `docs/audit_taste_vs_lens_conflict.md` — original taste-vs-lens audit + steering proposal.
- `docs/audit_taste_vs_lens_conflict_deck_evidence.md` — deck-level audit (predicted labels).
- `docs/diag_taste_vs_lens_c0_report.md` + `docs/diag_taste_vs_lens_c0_summary.md` — actual-classifier diagnostic that this chapter answers.

**Hard constraints carried forward and reaffirmed below:**
- No ranking change. No scoring change. No composer change. No RecCard change.
- No visible UI control yet. No durable Reading Taste mutation. No lens persistence.
- `recValidity.VERSION = rcv6` preserved. No new signal phrases in `lib/evidence/signals.ts`.
- C0 remains shadow-mode (no C1 admission of `intensity` / `emotionalWeight` into ranking or composer).
- BookEvidence calibration NOT triggered (the diagnostic's 100% catch rate on curated fixtures does not justify it; live-catalog confirmation can run independently via `docs/book_evidence_c0_observation_runbook.md`).

---

## 1. Executive diagnosis (re-stated, anchored in actual numbers)

From `docs/diag_taste_vs_lens_c0_report.md` (50 evaluations on actual classifier output):

- **45.0%** taste-fit-but-lens-mismatch rate across the 40 non-baseline evaluations.
- **60.0%** on soft-only lenses (Light & accessible + Less dark).
- **100%** classifier catch rate on the mismatched set under the diagnostic's catch definition (`emotionalWeight=high/specific` OR `tone=dark/specific` flagged every mismatched book).
- Short & light + No dark deck reproduced in the diagnostic matches the user-observed deck **exactly** (Thursday Murder Club / Everything I Never Told You / The Maid / In Love).
- Fast-paced lens reaches **6/10 match, 0/10 taste-fit-mismatch** — and 0 hard-excludes. It "works" only because the lens agrees with the user's lane. This is the UI-no-op symptom Phase 1 will measure.

**Routing verdict (diagnostic inference, to be confirmed by Phase 1 instrumentation):**
- Not a classifier-calibration problem. The signal is there.
- Primarily a **ranking arbitration** problem (the stated-taste floor + branch quota prevent the lens from pulling the deck) plus a **UI semantics** problem (the No-dark / Less-dark / Light chips do not communicate the taste-vs-mood tradeoff).

**Phase 1 promise:** produce a per-deck DEV log that proves or refutes the arbitration-bottleneck inference on a live build — without changing what the user sees.

---

## 2. Proposed steering model

### Type
```ts
export type TasteVsIntent = 'taste_first' | 'balanced' | 'mood_first';
```

### Semantics (Phase 1 — definitions only, not yet wired into ranking)

| Mode | What it means | Phase 2 behavior sketch (NOT Phase 1) |
|---|---|---|
| `taste_first` | Durable Reading Taste dominates. Lens softens within existing lanes; lens-mismatch books outside taste lanes are de-emphasized but not removed. | Stated-taste floor preserved at current value; lens contributions clamped tighter (e.g. half their P4C.1 cap). |
| `balanced` | Default. Durable taste and current lens both matter. **Equivalent to today's production behavior at the default value** — byte-identical at Phase 1. | Today's `clampP4IntentStack` + stated-taste floor unchanged. |
| `mood_first` | Current lens may meaningfully pull the deck outside durable genre lanes. Stated-taste floor relaxed; lens contributions get more headroom; lens-fit alternatives can displace taste-only picks. | Stated-taste floor lowered (e.g. 0.05 → 0.02); per-kind P4C cap raised (e.g. ±0.20 → ±0.30); reservation `eligibleCauses` extended to `intent_apply`. **Exact numbers belong to Phase 2.** |

### Why three modes, not two
- Two modes (`taste` / `mood`) force a binary the diagnostic does not yet justify. `balanced` is the safety valve that lets us ship Phase 1 byte-identically.
- Three modes give the if/then tree (§6) three measurable shadow simulations per deck without committing to a default change.

### What this model deliberately does NOT include
- ❌ A way to set steering mode per-deck-position (e.g. "top-5 taste-first, 6-10 mood-first"). Out of scope; one mode per build.
- ❌ Per-axis steering ("taste-first on tone, mood-first on pace"). Out of scope.
- ❌ A confidence number on the mode itself. The mode is user-controlled (eventually) or default — not classifier-inferred.

---

## 3. Session-state design

### Anchor file: **`lib/currentIntentLens.ts`**

Best home of the three candidates, justified below.

| Candidate | Verdict | Why |
|---|---|---|
| **`currentIntentLens.ts`** | ✅ **chosen** | Already the canonical "session-only, never-persisted, view-model over lens chips" module (file header explicitly says "does not persist lens state — the lens is session-only by contract"). Steering mode is literally a lens-arbitration knob. Same lifecycle, same isolation guarantees, same DEV-only consumers today. |
| `RecRequest` (`lib/recRequest.ts`) | ❌ rejected for Phase 1 | `RecRequest` participates in `configHash` (P0B). Adding a field there forces `recValidity.VERSION` bump (rcv6→rcv7) and invalidates every persisted deck. Violates "no recValidity bump" constraint. Move there in Phase 2 *only if* ranking starts consuming the field. |
| `recSignals/` (`build.ts` / `partitions.ts` / `types.ts`) | ❌ rejected | Signals are *typed user-side evidence with provenance + decay policy*. Steering is not evidence — it is arbitration policy. Wrong semantic category. |
| Local `RecommendationsFeed` component state | ❌ rejected | Would scope the field to one component and prevent the recommender / log site from reading it without prop-drilling. |
| Other session-only object (new module) | ❌ rejected | Premature. `currentIntentLens.ts` already exists and matches the contract. |

### Concrete API to add (Phase 1, no behavior change)

```ts
// in lib/currentIntentLens.ts (additive only — NO existing export changes)

export type TasteVsIntent = 'taste_first' | 'balanced' | 'mood_first';

const DEFAULT_STEERING: TasteVsIntent = 'balanced';

let _sessionSteering: TasteVsIntent = DEFAULT_STEERING;

/** Read current session steering mode. Default 'balanced'. Never persisted. */
export function getSessionSteering(): TasteVsIntent;

/** Set steering mode for the current session. Phase 1: only called by DEV
 *  triggers (forensic toggle, optional dev menu). Never wired to a user
 *  control until Phase 3. */
export function setSessionSteering(mode: TasteVsIntent): void;

/** Test-only reset hook (mirrors existing _resetPendingBuildCauseForTest). */
export function _resetSessionSteeringForTest(): void;
```

### Lifecycle guarantees (pinned by validators in §5)

- **Module-level mutable** — same shape as `pendingBuildCause` in `lib/recRequest.ts`. Lives only for the JS process lifetime.
- **Never persisted** — no AsyncStorage write, no Supabase write, no inclusion in any cache key.
- **Never included in `configHash`** — guaranteed by virtue of NOT being added to `RecRequest`.
- **Default `'balanced'`** — chosen specifically so Phase 1 is byte-identical to today (see §2).

---

## 4. Shadow log design

### Log tag: `[LENS_ARBITRATION]`

### Gate
- `__DEV__` AND `currentUserId === FORENSIC_USER_ID` (mirrors `[BOOK_EVIDENCE_C]` from C0 — same forensic identity, same DEV gate).
- One emit per **top-10 visible deck book per build**. (Same scope as `[BOOK_EVIDENCE_C]`.)
- Emit site: `lib/recommender.ts`, after the final visible deck assembly, before queue write. Same call site as the existing `[BOOK_EVIDENCE_C]` loop — they can co-locate.

### Per-book payload (12 fields, in this order so the log lines column-align in a terminal)

| Field | Type | Source | Notes |
|---|---|---|---|
| `idx` | number | deck position (0-9) | |
| `title` | string | `book.title` | truncated to 40 chars |
| `steering_mode` | `'taste_first'\|'balanced'\|'mood_first'` | `getSessionSteering()` | the **current** mode |
| `stated_taste_value` | number | book's `stated_taste_fit` contribution `.value` | from `ScoreContribution[]` |
| `p4c_pos_stack` | number | sum of positive P4C.1 contribution values (pre-clamp) | |
| `p4c_neg_stack` | number | sum of negative P4C.1 contribution values (pre-clamp) | |
| `p4c_clamped` | boolean | whether `clampP4IntentStack` would alter the stack | derived from the cap-vs-stack arithmetic |
| `lens_active` | boolean | `isIntentActive(intent)` | from `lib/nextReadIntent.ts` |
| `lens_kind` | string | chips active (e.g. `'tone=light,energy=light_fun'`) | comma-joined |
| `book_intensity_bucket` | string | `[BOOK_EVIDENCE_C]` projection of `evidence.intensityHigh/Low` | reuse the existing projection from the C0 log |
| `book_emotional_weight_bucket` | string | same projection over `emotionalWeightHigh/Low` | |
| `would_eject_under_mood_first` | boolean | **shadow simulation**: would this book drop out of top-10 if mode were `mood_first`? | see "shadow simulation" below |
| `lens_fit_alternative_nearby` | boolean | **shadow simulation**: was there a candidate scored slot 11-25 that has higher lens-fit AND survives finalGate? | see "shadow simulation" below |

### Shadow simulation rules (load-bearing)

The shadow simulation MUST NOT mutate any production code path. Two implementation patterns are acceptable; planning leaves the choice to the implementer:

- **Pattern A (preferred): pure derivation from already-computed values.** `would_eject_under_mood_first` and `lens_fit_alternative_nearby` are computed from data the recommender already has in scope (the candidate list pre-truncation + the contribution arrays + the verdict from `evaluateBookAgainstIntentLens`). No re-scoring. No re-retrieval. This makes the simulation deterministic and cheap.
- **Pattern B (acceptable if A proves insufficient): re-run `clampP4IntentStack` once per book under a `mood_first` cap profile, in a local helper that takes the profile as an argument and returns a number — the existing function is left untouched and is still the only one consumed by ranking.**

Either pattern: the simulation is **observation-only**, gated by the DEV+forensic guard, and runs ONLY when emitting the log line. Production builds compile it out.

### What the log does NOT include
- ❌ No PII beyond `FORENSIC_USER_ID` (which is itself a dev artifact).
- ❌ No raw book IDs or Supabase row IDs.
- ❌ No metadata that would let an outside reader reconstruct the user's library.

---

## 5. Validator plan

Two new validators. Both **contract-only** (no live data, no Supabase). Both required green for Phase 1 to ship.

### `scripts/validate_steering_field_contract.ts`

Pins the field-shape and lifecycle invariants. ~60-80 assertions.

§1 — **Default and round-trip.** `getSessionSteering()` returns `'balanced'` initially. After `setSessionSteering('mood_first')`, it returns `'mood_first'`. After `_resetSessionSteeringForTest()`, it returns `'balanced'` again. Assert all three values are settable + readable.

§2 — **No persistence surface.** Source-grep `lib/currentIntentLens.ts` for any of: `AsyncStorage`, `MMKV`, `localStorage`, `supabase`, `recPayloadCache`, `recSession`, `recQueue`. Zero matches.

§3 — **Not in `configHash`.** Source-grep `lib/recValidity.ts` and `lib/recRequest.ts` for `steering` / `tasteVsIntent` / `TasteVsIntent`. Zero matches.

§4 — **Not consumed by ranking surfaces.** Source-grep `lib/recommender.ts` clampP4IntentStack site + scoring path for `getSessionSteering(` / `tasteVsIntent` consumers in non-DEV-gated code blocks. Phase 1: zero non-DEV consumers. Phase 2 will change this assertion.

§5 — **No composer / RecCard / finalGate / No-dark consumption.** Source-grep `lib/explanations/compose.ts`, `components/RecCard.tsx`, `lib/intent/finalGate.ts`, `lib/nextReadIntent.ts` (`avoid_dark` branch) for the type and getter. Zero matches.

§6 — **No new signal phrases.** Source-grep `lib/evidence/signals.ts` for a diff vs HEAD (Phase 1 must not modify this file). Zero changes.

§7 — **`recValidity.VERSION` is rcv6.** Import and assert.

### `scripts/validate_lens_arbitration_log_shape.ts`

Pins the log shape + gating. ~40-60 assertions.

§1 — **DEV+forensic gate.** Source-grep the emit site in `lib/recommender.ts`: must be inside an `if (__DEV__ && currentUserId === FORENSIC_USER_ID)` (or equivalent guard). Zero callsites outside this guard.

§2 — **Top-10 scope.** Source-grep the loop bound — must be `slice(0, 10)` or equivalent, matching `[BOOK_EVIDENCE_C]`.

§3 — **Field-shape.** Synthetic deck of 3 books × 3 steering modes × 2 lens states fed through a `formatLensArbitrationLogLine(...)` pure helper. Assert each line contains every required key (`steering_mode`, `stated_taste_value`, `p4c_pos_stack`, `p4c_neg_stack`, `p4c_clamped`, `lens_active`, `lens_kind`, `book_intensity_bucket`, `book_emotional_weight_bucket`, `would_eject_under_mood_first`, `lens_fit_alternative_nearby`).

§4 — **Bucket reuse.** The intensity/emotional-weight bucket strings must equal the strings emitted by the existing `[BOOK_EVIDENCE_C]` projection on the same `BookEvidence` input. Assert byte-identity across 12 fixtures (reuse the `validate_book_evidence_intensity` fixture set).

§5 — **Shadow simulation purity.** Fixture: run the log emit twice with steering `'balanced'`, between runs flip the input candidate ordering. Assert the live deck output is byte-identical (the log read-path did not mutate the deck).

§6 — **Mode-default neutrality.** Fixture: run the recommender end-to-end with steering at default (`'balanced'`), capture deck. Run again after `setSessionSteering('mood_first')` then immediately reading the deck (Phase 1: the mode is not consumed by ranking, so the deck MUST be byte-identical). Assert byte-identity. **This is the load-bearing Phase 1 acceptance invariant.**

### Sibling validators left untouched
All 11 existing validators continue to run green unchanged.

---

## 6. If/then decision tree

After Phase 1 ships + ≥ 1 forensic session is captured:

### Branch A — Most likely outcome (per the diagnostic)
**IF** shadow logs show `would_eject_under_mood_first = true` on ≥ 30% of taste-fit-but-lens-mismatch books **AND** `lens_fit_alternative_nearby = true` on ≥ 50% of those rows
**THEN** the arbitration bottleneck is confirmed → **plan Phase 2 ranking arbitration** (`clampP4IntentStack` profile per `TasteVsIntent`, reservation widening for `intent_apply`).
**Phase 2 chapter promise:** ship `taste_first` and `mood_first` as live behaviors; `balanced` continues to map to today's behavior. Default is decided by Phase 2 from real-deck evidence, not guessed now.

### Branch B
**IF** shadow logs show `would_eject_under_mood_first = true` but `lens_fit_alternative_nearby = false` on the majority of rows
**THEN** retrieval is the upstream bottleneck → **plan retrieval expansion before arbitration** (add a `mood_lens_alternative` branch to `lib/retrieval/branchPlanner.ts` that pulls candidates that match the active lens regardless of stated genre). Do NOT proceed to Phase 2 ranking until retrieval supplies the alternatives.

### Branch C
**IF** the diagnostic-classifier catch rate fails to reproduce on the live catalog (e.g. < 70% under the operator runbook in `docs/book_evidence_c0_observation_runbook.md`)
**THEN** BookEvidence C0 signal lists need calibration first → branch into a separate BookEvidence calibration chapter; pause Phase 2 planning until catch rate clears the bar on the live catalog.

### Branch D
**IF** `mood_first` simulation surfaces mostly low-quality or off-taste books in the `lens_fit_alternative_nearby` slot
**THEN** keep steering hidden + improve retrieval and book evidence first (Branch B + Branch C combined). Do NOT ship a steering UI.

### Branch E (success)
**IF** shadow mode is useful AND alternatives exist AND simulated mood_first decks are high-quality
**THEN** plan UI semantics chapter (Phase 3):
- Three labels exactly as in the brief: **"Stay close to my taste"** / **"Balance taste and mood"** / **"Prioritize today's mood"**
- Resolve the No-dark-vs-emotional-weight semantic distinction that this chapter explicitly leaves unfixed.
- Decide control surface: chip cluster vs. toggle vs. lens-side affordance. (NOT decided here.)

---

## 7. Minimal implementation chapter (handed off, not executed)

### Chapter name
**Lens-vs-Taste Steering Phase 1 — shadow-mode arbitration field**

### Files likely touched (smallest safe set)

| File | Change | LOC est |
|---|---|---|
| `lib/currentIntentLens.ts` | Add `TasteVsIntent` type, `getSessionSteering`, `setSessionSteering`, `_resetSessionSteeringForTest`, default `'balanced'`. Additive only — zero changes to existing exports. | ~25 |
| `lib/recommender.ts` | Add `[LENS_ARBITRATION]` emit inside the existing `__DEV__ && FORENSIC_USER_ID` gated block that already houses `[BOOK_EVIDENCE_C]`. Pure observation. | ~40 |
| `scripts/validate_steering_field_contract.ts` | New validator (§5 above). | ~120 |
| `scripts/validate_lens_arbitration_log_shape.ts` | New validator (§5 above). | ~150 |
| `replit.md` | One-line phase status row addition: "Phase 1 · shadow-mode steering field — shipped (contract-only)". Pointer to this doc. | ~3 |
| `docs/recently_shipped.md` | Phase 1 acceptance prose on ship. | ~25 |

**Files explicitly NOT touched:**
- `lib/recPolicy.ts`, `lib/recRequest.ts`, `lib/recValidity.ts`
- `lib/composition/statedReservation.ts`, `lib/retrieval/**`
- `lib/explanations/compose.ts`, `components/RecCard.tsx`
- `lib/intent/finalGate.ts`, `lib/nextReadIntent.ts`
- `lib/evidence/signals.ts`, `lib/evidence/bookEvidence.ts`

### No-behavior-change guarantees (validator-pinned)
- Production deck output byte-identical to today at default mode (§5 validator §6 of `validate_lens_arbitration_log_shape`).
- `recValidity.VERSION` stays `rcv6` (§5 validator §7 of `validate_steering_field_contract`).
- `lib/evidence/signals.ts` source unchanged (§5 validator §6).
- Steering field is module-state only, never persisted, never in `configHash` (§5 validator §2, §3).
- Shadow log is DEV+forensic-gated (§5 validator §1 of `validate_lens_arbitration_log_shape`).

### Acceptance criteria
1. Both new validators exit 0.
2. All 11 pre-existing validators in the active acceptance loop continue to exit 0.
3. `npx tsc --noEmit` clean on the new file changes (pre-existing typecheck errors in `lib/bookTraits.ts`, `lib/nextReadIntent.ts`, `lib/tasteProfile.ts`, `lib/taxonomy/*` are unrelated and not gated by this chapter).
4. One forensic-mode live build emits ≥ 10 `[LENS_ARBITRATION]` log lines (smoke that the emit site is reachable). Visible deck unchanged from a build immediately prior, same user, same lens.
5. Status target: **shipped (contract-only)**. NOT "product accepted" — no user-visible promise exists in this phase.

### Out of scope (explicit)
- Phase 2 ranking arbitration (`clampP4IntentStack` profile per `TasteVsIntent`).
- Phase 3 UI semantics (the three chip labels).
- C1 admission of `intensity` / `emotionalWeight` into ranking/composer.
- BookEvidence signal-list calibration (only triggered if Branch C fires).
- Persistence of steering across sessions.
- No-dark-vs-emotional-weight copy fix.

---

## 8. Exact implementation prompt for approval

> Implement **Lens-vs-Taste Steering Phase 1 — shadow-mode arbitration field**, per `docs/plan_lens_steering_phase1.md`.
>
> 1. Add to `lib/currentIntentLens.ts` (additive only): `export type TasteVsIntent = 'taste_first' | 'balanced' | 'mood_first'`, module-level mutable `_sessionSteering` defaulting to `'balanced'`, exports `getSessionSteering()`, `setSessionSteering(mode)`, and `_resetSessionSteeringForTest()`. Do not touch any existing export of this module. Do not import from or write to AsyncStorage, MMKV, Supabase, or any cache.
>
> 2. Add a `[LENS_ARBITRATION]` log emit inside `lib/recommender.ts`, co-located with the existing `[BOOK_EVIDENCE_C]` emit (same `__DEV__ && currentUserId === FORENSIC_USER_ID` guard, same top-10 scope). Emit one line per top-10 deck book with the 12 fields specified in `docs/plan_lens_steering_phase1.md` §4. Reuse the existing `[BOOK_EVIDENCE_C]` bucket projection for `book_intensity_bucket` / `book_emotional_weight_bucket`. Implement shadow simulations under Pattern A (pure derivation from already-computed values) if possible; fall back to Pattern B (local helper that takes a cap profile) if not. **Production ranking, scoring, composition, RecCard rendering, finalGate, No-dark, and explanation paths MUST NOT call `getSessionSteering()` or read `TasteVsIntent` in this phase.**
>
> 3. Add `scripts/validate_steering_field_contract.ts` with the seven sections (§1 default/round-trip, §2 no-persistence source-grep, §3 not-in-configHash source-grep, §4 not-consumed-by-ranking-surfaces source-grep, §5 no-composer/RecCard/finalGate/No-dark consumption source-grep, §6 `lib/evidence/signals.ts` source unchanged vs HEAD, §7 `recValidity.VERSION === 'rcv6'`). Exit 0 on success.
>
> 4. Add `scripts/validate_lens_arbitration_log_shape.ts` with the six sections (§1 DEV+forensic gate source-grep, §2 top-10 scope source-grep, §3 field-shape on synthetic deck, §4 bucket-string byte-identity vs the `[BOOK_EVIDENCE_C]` projection across 12 fixtures from `validate_book_evidence_intensity`, §5 shadow-simulation purity — deck byte-identical across two runs with reordered candidate input, §6 mode-default neutrality — deck byte-identical between default `'balanced'` and `'mood_first'`). Exit 0 on success. **§6 is the load-bearing Phase 1 acceptance invariant.**
>
> 5. Both new validators must exit 0. All 11 pre-existing validators in the active acceptance loop must continue to exit 0. `recValidity.VERSION` must remain `rcv6`. `lib/evidence/signals.ts` must be byte-identical vs HEAD. Do NOT bump `recValidity.VERSION`. Do NOT add to or change any signal phrase in `lib/evidence/signals.ts`. Do NOT touch `lib/recPolicy.ts`, `lib/recRequest.ts`, `lib/recValidity.ts`, `lib/composition/statedReservation.ts`, `lib/retrieval/**`, `lib/explanations/compose.ts`, `components/RecCard.tsx`, `lib/intent/finalGate.ts`, `lib/nextReadIntent.ts`, `lib/evidence/signals.ts`, or `lib/evidence/bookEvidence.ts`.
>
> 6. Add a one-line phase status row to `replit.md` under the Phase status table: `Phase 1 · shadow-mode steering field — shipped (contract-only); pointer → docs/plan_lens_steering_phase1.md`. Add the Phase 1 acceptance prose to `docs/recently_shipped.md` on ship.
>
> 7. Status target: **shipped (contract-only)**. Not "product accepted". No live-smoke required by Phase 1 acceptance because there is no user-visible promise — but one forensic-mode build emitting ≥ 10 `[LENS_ARBITRATION]` log lines IS required as the §4 smoke for the implementation chapter.
>
> Out of scope: Phase 2 ranking arbitration, Phase 3 UI semantics, C1 admission, BookEvidence calibration, persistence, No-dark copy fix.
