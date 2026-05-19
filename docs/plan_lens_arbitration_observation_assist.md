# Phase 1.1 planning chapter — Lens Arbitration Observation Assist

**Status:** PLANNING. Not implemented. Awaiting approval before any code change.
**Parent phase:** Lens-vs-Taste Steering Phase 1 (shipped + accepted 2026-05-19).
**Companion docs:** `docs/runbook_lens_arbitration_observation.md`, `docs/diag_lens_arbitration_blocker_2026-05-19.md`.
**Validators today:** `validate_steering_field_contract` (44 assertions), `validate_lens_arbitration_log_shape` (50 assertions).

---

## 1 · Executive recommendation

**Recommendation:** ship a tightly-scoped Phase 1.1 that does two things and nothing else:

1. Extend the existing `[LENS_ARBITRATION]` JSON payload with five additional shadow-only fields (`au`, `vr`, `tn`, `pc`, `cx`, `mp`, `fg`) so a single dev session captures everything the original observation request asked for.
2. Add a concise browser-console capture protocol section to the runbook plus a small file-name convention for `.local/lens_arb_logs/`.

Both changes stay inside the existing `__DEV__ && userId === FORENSIC_USER_ID` guard, stay top-10-only, stay shadow-mode (no ranking / scoring / composer / RecCard / finalGate / `recValidity` touch), and stay zero-cost when `FORENSIC_USER_ID === ''`.

**Explicitly out of scope for this chapter:** pure-recommender extraction, Node-runnable headless harness, any change to `lib/supabase.ts` import surface, any change to the aggregator's verdict thresholds.

**Why this and not the bigger refactor:** A pure-recommender extraction is the right long-term move, but it is a several-day refactor with its own regression surface (live retrieval branches, RN-bound enrichment, recPayloadCache lifecycle). Phase 1.1 turns one browser session into a complete report for ≤ 1 day of work and ≤ 50 lines of code change. We can revisit headless extraction later if Phase 2 actually wants automated regression runs.

---

## 2 · Fields needed vs. fields the log emits today

The aggregator (`scripts/diag_lens_arbitration_aggregate.ts`) reads the 12-key payload that ships today. The original task spec asked for fields the log does NOT emit. The gap:

| Requested field | In log today? | Cheapest source in `getRankedRecs` scope |
|---|---|---|
| `rank` | ✓ `r` | — |
| `title` | ✓ `t` (28-char truncation) | — |
| **`author`** | ✗ | `r.authors?.[0]` already on the rec object |
| **`visible reason`** | ✗ | `r.reasons?.[0]?.text` (or composer summary) already on the rec object |
| `durable_taste_fit` | ✓ `dtf` | — |
| `current_lens_fit` | ✓ `lf` | — |
| `taste_fit_but_lens_mismatch` | ✓ `tlm` | — |
| `would_eject_under_mood_first` | ✓ `wem` | — |
| `lens_fit_alternative_nearby` | ✓ `lfa` | — |
| **`tone` / `toneConfidence`** | partial (lens-classifier projection only) | `bookEvidence` already computed at `lib/recommender.ts:2216` adjacency |
| **`pace` / `paceConfidence`** | partial (lens-classifier projection only) | same |
| **`complexity` / `complexityConfidence`** | partial | same |
| `intensity` (bucket) | ✓ `int` | — |
| `emotionalWeight` (bucket) | ✓ `wt` | — |
| **`market_position`** | ✗ | `r._score_breakdown.market_position` already set at `lib/recommender.ts:2255` |
| **`finalGate hard exclusion`** | ✗ | finalGate runs after `getRankedRecs`; needs a thin shadow recall — see §4 risks |

Net: **5 truly missing fields** + 1 that needs care to source without breaking the "shadow-only" contract.

### Proposed extended payload (17 keys)

Existing 12 keys unchanged (byte-identical phrasing and key names). New keys appended:

| New key | Type | Source | Notes |
|---|---|---|---|
| `au` | `string` | `(r.authors?.[0] ?? '').slice(0, 28)` | Truncated to mirror `t` policy. |
| `vr` | `string` | `(r.reasons?.[0]?.text ?? '').slice(0, 80)` | First visible composer reason; empty string if none. |
| `tn` | `string` | `${bookEvidence.toneSummary ?? 'unk'}/${bookEvidence.bookToneConfidence ?? 'unk'}` | Same bucket/conf shape as existing `int`/`wt`. |
| `pc` | `string` | `${bookEvidence.paceSummary ?? 'unk'}/${bookEvidence.bookPaceConfidence ?? 'unk'}` | Same shape. |
| `cx` | `string` | `${bookEvidence.complexitySummary ?? 'unk'}/${bookEvidence.bookComplexityConfidence ?? 'unk'}` | Same shape. |
| `mp` | `string` | `r._score_breakdown?.market_position ?? 'unk'` | One token (`romantasy`, `domestic_suspense`, etc.). |
| `fg` | `string` | finalGate hardExclusion reason for this rec id, or `''` | See §4 source-of-truth question. |

All seven additions are **read-only projections of values the recommender has already computed for this rec** at the time the log fires. No new computation, no new pipeline stages, no new RN-bound imports.

---

## 3 · Does the current aggregator already accept these logs?

**Partially.** The aggregator parses any JSON-lines `[LENS_ARBITRATION] {…}` it sees and ignores extra keys (`JSON.parse` is forgiving; the `Line` type is structural in TS but runtime is duck-typed). So:

- Extending the payload with new keys **will not break** the existing aggregator. It will silently drop the new keys until the aggregator is taught about them.
- The aggregator's per-scenario tables currently render 9 columns (`r, title, dtf, lf, tlm, int, wt, wem, lfa`). To surface the new fields, the table-formatter needs a second column block (the executive summary / verdict logic is unchanged — none of the new fields feed any threshold).
- The aggregator's verdict logic stays exactly the same — `n_tlm`, `n_wem`, `lfa_any`, `slot1_tlm`, `classifier_miss_rate` are unaffected.

Net: **aggregator forward-compatible today, needs a one-function rendering tweak** to surface the new fields. Roughly +30 lines in the renderer.

---

## 4 · Smallest implementation plan

### 4.1 Code changes (3 files, ≤ 80 lines net)

**File 1: `lib/recommender.ts` (single emit site, lines 3831-3844).**

- Append 7 keys to the JSON payload. All sourced from values already in scope at that line.
- **Source-of-truth question for `fg` (finalGate hardExclusion):** finalGate runs at the queue boundary, downstream of `getRankedRecs`. There is no in-process call to finalGate at the LENS_ARBITRATION emit site. Two options:
  - **Option A (preferred for Phase 1.1).** Source `fg` from `r._score_breakdown.is_hard_excluded` + `r._score_breakdown.intent_exclusion_reason` if they exist on the per-book breakdown (lines 2496-2499 set `exclusionReason`). If not surfaced onto `_score_breakdown` today, expose them as additional read-only fields on the breakdown — that is itself a minor extension, but it is structurally inside the existing scoring path, not a new gate. Confirm with a quick read of the breakdown shape at planning-implementation time.
  - **Option B (rejected for Phase 1.1).** Re-run a shadow finalGate evaluation inside the LENS_ARBITRATION block. Rejected because it duplicates No-dark logic — risks divergence and violates "one gate, one truth" (the Resolution A invariant).
- All other 6 fields are pure field reads.

**File 2: `scripts/diag_lens_arbitration_aggregate.ts`.**

- Extend `Line` type with the 7 optional keys.
- Extend `formatScenarioTable` to render a second 7-column table per scenario (or extend the existing table to 16 columns — the second-table layout reads better in markdown).
- Verdict / aggregate computations unchanged. Header counts unchanged.

**File 3: `docs/runbook_lens_arbitration_observation.md`.**

- Add a §3.5 "Browser-console capture protocol" (see §4.3 below).
- Update §3 "What to capture" key-table to list the 7 new keys.
- Update §7 architect caveat to add a third validator-hardening line: validators must reject any LENS_ARBITRATION emit site outside the DEV+FORENSIC guard, *and* must verify the extended payload key set.

### 4.2 Browser-console capture protocol (drop-in runbook §3.5)

```
Open Chrome DevTools → Console.
Right-click anywhere in the console pane → "Save as…" → write to:
   .local/lens_arb_logs/<YYYY-MM-DD>_S<n>_<lens-shorthand>.log

The aggregator regex tolerates console line prefixes (timestamps, file:line
annotations, the leading "log: " or ">" Chrome attaches) — it extracts only
the trailing `[LENS_ARBITRATION] {…}` JSON. No manual cleanup needed.

Sanity check before running the aggregator:
   grep -c '\[LENS_ARBITRATION\]' .local/lens_arb_logs/<file>.log
   # expect 10 per scenario (top-10 deck)
```

### 4.3 File-naming convention (drop-in)

```
.local/lens_arb_logs/<YYYY-MM-DD>_S<0|1|2|3|4>_<lens-shorthand>.log
                     date          scenario id  one of: baseline, light, palate,
                                                less-dark, fast

Examples:
.local/lens_arb_logs/2026-05-19_S0_baseline.log
.local/lens_arb_logs/2026-05-19_S1_light.log
.local/lens_arb_logs/2026-05-19_S2_palate.log
.local/lens_arb_logs/2026-05-19_S3_less-dark.log
.local/lens_arb_logs/2026-05-19_S4_fast.log
```

`.local/` is gitignored by convention — confirm `.local/lens_arb_logs/` is also
ignored before first capture (small one-line `.gitignore` addition if not).

### 4.4 Hard constraints — restated and bound

| Constraint | How Phase 1.1 holds it |
|---|---|
| Read-only, no Supabase write | Emit-site only reads pre-computed values. No DB call. |
| No `FORENSIC_USER_ID` commit | Phase 1.1 does not touch line 159. Default stays `''`. |
| No UUID committed | Phase 1.1 adds no fixture or test that contains a UUID. |
| DEV-only | Phase 1.1 stays inside the existing `__DEV__ && userId === FORENSIC_USER_ID` block. Confirmed by validator (see §6). |
| Top-10 only | Existing `slice(0, 10)` enclosing loop unchanged. |
| No ranking change | Emit site is logging only; no return value influences ranking. |
| No scoring change | No new `ScoreContribution` kinds, no policy constant edits. |
| No composer change | No new admitted reason kinds. `vr` reads what composer already produced. |
| No RecCard change | No `components/RecCard.tsx` edit. |
| No finalGate change | Source `fg` from existing `_score_breakdown` fields (Option A above). No new finalGate logic. |
| `recValidity` stays `rcv6` | No contribution shape change. |
| No production consumer | Phase 1.1 adds no read of any LENS_ARBITRATION-emitted field outside the DEV-gated console.log. |

---

## 5 · If / then decision tree

```
Approved as proposed?
├── YES → implement §4 (≈ ½ day). Run validators §6. Update replit.md status row.
│         Then re-run the runbook §C four-step manual capture for one
│         test account. Report verdict via aggregator.
│
└── NO → choose one of:
    ├── (a) Skip Phase 1.1 entirely; capture the 5 missing fields by manual
    │       annotation during the runbook §C session. Higher operator burden;
    │       acceptable if Phase 2 decision is not urgent.
    │
    ├── (b) Approve fields-only (au, vr, tn, pc, cx, mp), drop `fg`. Half-
    │       day shrinks to ≈ 2 hours; finalGate exclusion data lost — but
    │       the runbook already recommends capturing `[FINAL_GATE]` logs
    │       alongside, so cross-correlation is possible without `fg`.
    │
    └── (c) Defer Phase 1.1, schedule pure-recommender extraction as its
            own chapter. Several days of work; opens Node-runnable
            automation for future phases but does not produce a report
            faster than (a) or (b) for this immediate decision.

If §4.1 Option A turns out infeasible at implementation time (the
breakdown fields don't expose hardExclusion cleanly):
├── Fall back to Option (b) — ship without `fg`. Do NOT pursue Option B
│   (shadow finalGate re-run). Document the gap in the runbook.
```

---

## 6 · Validators to run

### Existing validators that MUST stay green (no expected changes)
- `scripts/validate_steering_field_contract.ts` (44 assertions) — `TasteVsIntent` contract; no change.
- `scripts/validate_intent_final_gate.ts` — queue-boundary hard-exclusion; no change.
- `scripts/validate_intent_lens.ts` — Intent Lens fixture matrix; no change.
- `scripts/validate_explanation_faithfulness.ts` — composer purity + P4D-1..§P4D-7; no change.
- `scripts/validate_book_evidence.ts` (222 assertions) — Batch B byte-identity; no change.
- `scripts/validate_book_evidence_intensity.ts` (122 assertions) — Batch C C0 shadow contract; no change.
- `scripts/validate_no_dark_isolation.ts` (73 assertions) — Batch C C0 isolation; no change.
- `scripts/validate_rec_validity.ts` — `rcv6` hash; no change.
- `scripts/validate_p4c_limited_ranking.ts` — caps; no change.
- `scripts/validate_intent_contribution.ts`, `validate_tone_pace_fit.ts`, `validate_series_continuation.ts` — upstream P4C; no change.
- `scripts/validate_rec_payload_cache_lens.ts` — lens-tagged cache discard; no change.

### Validator that MUST be extended (1 file)
- `scripts/validate_lens_arbitration_log_shape.ts` (currently 50 assertions, §1–§6) — extend to assert the **19-key** payload shape (12 old + 7 new), each new key's type, the truncation policy on `au` (≤ 28) and `vr` (≤ 80), and the `bucket/conf` shape on `tn`/`pc`/`cx`. Estimated +25 assertions (target: §7 "extended payload shape", §8 "truncation invariants"). Total target: ~75 assertions.

### Aggregator self-test (recommended but optional)
- Add a small fixture-based test for the aggregator's renderer — e.g. `scripts/validate_aggregator_render.ts` — that feeds a synthetic 10-line scenario file and asserts the markdown contains the 7 new column headers. Out of scope for Phase 1.1 if you want it tighter; can be a follow-up.

### Architect re-engagement
- Phase 1.1 inherits the Phase 1 architect caveat (validator scope-check hardening). The validator extension above is a natural place to also address caveat item #2 ("strip comments and string literals"), but **only if scope creep is acceptable**. If not, schedule the caveat as a separate Phase 2 pre-req batch as planned.

---

## 7 · Exact implementation prompt (for approval)

Copy-paste-ready prompt for the next chat turn, if/when you approve:

> Implement Phase 1.1 — Lens Arbitration Observation Assist — exactly per
> `docs/plan_lens_arbitration_observation_assist.md`.
>
> Scope (do not exceed):
> 1. `lib/recommender.ts` — at the existing `[LENS_ARBITRATION]`
>    `console.log` (line ~3831), append 7 keys to the JSON payload in this
>    order: `au, vr, tn, pc, cx, mp, fg`. Source per the plan §2 table.
>    For `fg`, use Option A (read `_score_breakdown.is_hard_excluded` +
>    `_score_breakdown.intent_exclusion_reason`); if those fields are not
>    already on the breakdown, expose them as read-only additions to the
>    breakdown shape only (no logic change). Do NOT re-run finalGate.
>    Do NOT change the enclosing guard. Do NOT touch ranking, scoring,
>    composer, RecCard, finalGate, or `recValidity`.
> 2. `scripts/diag_lens_arbitration_aggregate.ts` — extend the `Line`
>    type with the 7 new optional keys. Extend `formatScenarioTable` to
>    render a second 7-column table per scenario (`r | au | vr | tn |
>    pc | cx | mp | fg`) below the existing 9-column table. Do NOT
>    change `aggregate()`, `decide()`, or any verdict threshold.
> 3. `scripts/validate_lens_arbitration_log_shape.ts` — extend to assert
>    the 19-key payload shape, new-key types, and the truncation
>    invariants on `au` (≤ 28) and `vr` (≤ 80). New §7 + §8. Target
>    ~75 assertions total.
> 4. `docs/runbook_lens_arbitration_observation.md` — add §3.5 "Browser-
>    console capture protocol" and update §3 "What to capture" key
>    table. Confirm `.local/lens_arb_logs/` is in `.gitignore` (one
>    line addition if not).
> 5. `replit.md` — add a Phase 1.1 row under the phase status table:
>    "Lens Arbitration Observation Assist · shadow-only payload
>    extension · `recValidity.VERSION = rcv6` unchanged · pinned by
>    `validate_lens_arbitration_log_shape` (extended)". Mark "shipped"
>    once validators green; mark "product accepted" only after a real
>    capture session produces a complete aggregator report.
>
> Acceptance:
> - All 14 existing validators green (no regressions).
> - Extended `validate_lens_arbitration_log_shape.ts` green.
> - `FORENSIC_USER_ID` stays `''` in committed code.
> - No UUID, no fixture UUID, in committed code.
> - `lib/supabase.ts` import surface unchanged.
> - `git diff` shows changes in exactly the 5 files listed above
>   (plus optionally `.gitignore`). No other file touched.
>
> Out of scope: pure-recommender extraction, headless harness,
> automated capture, aggregator render self-test, architect-caveat
> hardening. Each is its own future chapter.

---

## 8 · Approval checklist

Before saying "go", confirm:

- [ ] You agree §4.1 Option A (`fg` sourced from `_score_breakdown`) is acceptable, with §4 fallback to Option (b) if infeasible.
- [ ] You agree the aggregator renders a second table rather than widening the existing one.
- [ ] You agree the validator extension lands in `validate_lens_arbitration_log_shape.ts` rather than a new file.
- [ ] You agree this chapter does NOT also tackle the Phase 1 architect caveat (validator scope-check hardening) — that stays a Phase 2 pre-req.
- [ ] You agree the post-implementation acceptance pass is a single runbook §C manual capture for one test account (no automated replay).
