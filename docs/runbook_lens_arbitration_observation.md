# `[LENS_ARBITRATION]` — Observation Runbook

**Phase:** Lens-vs-Taste Steering Phase 1 (shipped 2026-05-19, contract-only).
**Owner doc:** `docs/plan_lens_steering_phase1.md` (planning); `docs/recently_shipped.md` (acceptance prose); `replit.md` (live phase status).
**Purpose of this runbook.** Use the shadow `[LENS_ARBITRATION]` logs to decide
whether Phase 2 (real ranking arbitration math wired to the `TasteVsIntent`
modes) is justified — and, if so, on what evidence. Phase 1 is observation
infrastructure; this runbook is the observation protocol that turns it into a
decision.

> **Do not start Phase 2 yet.** Phase 2 requires its own planning chapter +
> approval. This runbook produces the data that informs that decision.

---

## 1 · How to enable / confirm `FORENSIC_USER_ID` safely

`[LENS_ARBITRATION]` only emits when **both** of the following hold:
- `__DEV__ === true` (Expo dev build / Metro / web `npm run web`).
- `userId === FORENSIC_USER_ID`.

In production (`__DEV__ === false`), the entire enclosing block is dead code.
There is no path to leakage.

### Default state
`lib/recommender.ts` ships with:

```ts
const FORENSIC_USER_ID = '';
```

An empty string means **no real user matches**, so the log is silent for
every signed-in user. This is the safe default and must be the committed
state at all times.

### Enabling for a single observation session
1. Identify the auth user id of the test account you will observe
   (Supabase Auth dashboard → Users → copy the UUID).
2. Edit `lib/recommender.ts` line 159 locally — **do not commit**:
   ```ts
   const FORENSIC_USER_ID = '<paste-test-account-uuid>';
   ```
3. Restart the workflow:
   - Web: restart `Start application` (`npm run web`).
   - Device: `npm run dev:device`.
4. Sign in as that test account, navigate to For You, and trigger a deck
   build (cold session open, manual refresh, or pref edit — whichever
   matches the scenario in §2 below).
5. Watch the Metro / browser console for lines beginning with
   `[LENS_ARBITRATION] {`.

### Confirming the gate is active (and not leaking)
- Sign in as **any other account** in the same dev build and trigger a
  deck. You must see zero `[LENS_ARBITRATION]` lines for that account.
- Confirm `[BOOK_EVIDENCE_C]` lines appear alongside `[LENS_ARBITRATION]`
  for the forensic account — both share the same `__DEV__ && userId ===
  FORENSIC_USER_ID` guard, so if one fires the other must too.

### Tearing down
After the session is captured (logs saved to disk — see §3):
1. Revert `FORENSIC_USER_ID` back to `''`.
2. Run the two contract validators to confirm baseline restored:
   ```
   npx tsx scripts/validate_steering_field_contract.ts
   npx tsx scripts/validate_lens_arbitration_log_shape.ts
   ```
3. **Never commit a non-empty `FORENSIC_USER_ID`.** A pre-commit grep
   (`rg "FORENSIC_USER_ID\s*=\s*'[^']"`) is a useful local hook.

---

## 2 · Scenarios to run

Each scenario should be captured on the **same** test account with the
**same** durable Reading Taste (favorite genres + favorite authors). Only
the active intent lens changes between runs. This isolates "what the lens
says" from "what durable taste says" — the comparison `[LENS_ARBITRATION]`
is built to surface.

Test-account preconditions (do once, then leave fixed):
- Onboarded with ≥3 favorite genres mixing tones (e.g. `Thriller`,
  `Literary Fiction`, `Memoir`) — at least one genre that typically reads
  high-intensity or high-emotional-weight, so taste/lens disagreement is
  reachable.
- ≥10 books rated 4★+ (drives revealed/behavioral signal so the deck is
  not stated-only).
- Library mix includes at least one in-progress series (so
  series_continuation signal can fire).
- AsyncStorage cleared between scenarios that change the lens (use
  Edit Preferences → save, or app reset, to ensure deck rebuild rather
  than restore). Confirm rebuild via the `BuildCause` in adjacent logs.

### Scenarios

| # | Scenario | Lens setup | Expected `lk` (lens-kind) substring |
|---|---|---|---|
| **S0** | **Baseline** — no lens | Clear all intent chips | `(none)` |
| **S1** | **Light & accessible** | `tone=light` + `energy=light_fun` | `tone=light,energy=light_fun` |
| **S2** | **Short & light / palate cleanser** | `energy=palate_cleanser` (+ `max_pg=300` if available) | `energy=palate_cleanser` |
| **S3** | **Less dark** | `avoid_dark` chip (the soft-demote, not No-dark) | `avoid_dark` |
| **S4** | **Fast-paced / immersive** | `pace=fast` + `energy=immersive` | `pace=fast,energy=immersive` |

For each scenario:
- Trigger one **cold** deck build (close + reopen the app, or clear
  recPayloadCache and reopen For You).
- Capture the 10 emitted `[LENS_ARBITRATION]` lines (one per top-10 deck
  book).
- Note the `BuildCause` from the surrounding logs so you can reproduce.

---

## 3 · What to capture

Save raw log output per scenario to a dated file:

```
.local/lens_arb_logs/<YYYY-MM-DD>_S<n>_<lens-shorthand>.log
```

For each `[LENS_ARBITRATION]` JSON line, the fields are:

| Key | Meaning |
|---|---|
| `r` | 1-indexed rank in the top-10 visible deck |
| `t` | Truncated title (first 28 chars) |
| `dtf` | Durable taste fit — `audit_flags` carries a `stated_favorite:*` provenance marker |
| `lf` | Current lens fit — `'match' \| 'neutral' \| 'mismatch'` |
| `tlm` | **Taste-fit-but-lens-mismatch** — `dtf && lf === 'mismatch'` |
| `int` | Intensity bucket — `<bucket>/<conf>` (e.g. `high/specific`, `low/broad`, `unknown/unk`) |
| `wt` | Emotional-weight bucket — same shape |
| `sm` | Session steering mode — should be `'balanced'` in all observation runs (we are not toggling steering in Phase 1) |
| `la` | Lens active boolean |
| `lk` | Compact active-lens summary (see §2 expected substrings) |
| `wem` | **Would-eject-under-mood-first** (Pattern A shadow simulation) |
| `lfa` | **Lens-fit alternative nearby** in deck positions 11-25 |

For analysis, the per-scenario aggregates to record are:
- `n_tlm` — count of `tlm === true` across the 10 lines.
- `n_wem` — count of `wem === true` across the 10 lines.
- `lfa_any` — true if at least one line has `lfa === true`.
- `slot1_tlm` — whether the #1 ranked book is taste-fit-but-lens-mismatch
  (this is the most user-visible failure mode).
- Mode mix of `int` and `wt` (helps debug whether classifier is silent /
  saturated for this lens-active subset).

Optional but useful: in the same log capture, also save the
`[BOOK_EVIDENCE_C]` line for each of the 10 books — the `c_len` and
`fiSpec` / `fwSpec` fields tell you whether a "missed" lens classification
is a corpus problem (empty / sparse) or a classifier problem (corpus
present, no signal hit).

---

## 4 · How to interpret the diagnostic fields

### `taste-fit-but-lens-mismatch` (`tlm`)
- **What it captures.** A book is in the top-10 *because* durable Reading
  Taste pulled it in (it carries a `stated_favorite:*` provenance marker),
  AND the currently active lens disagrees with its intensity / weight
  profile.
- **Why it matters.** Today the lens cannot eject taste-anchored picks —
  the composer / reservation / floor protections keep stated taste in
  the slate. `tlm` is the population of books a future arbitration mode
  *could* re-prioritize. High `tlm` rates under benign light lenses are
  the signal that durable taste is dominating the lens promise.
- **Honest reading.** `tlm` is a heuristic. The lens-fit classifier (`lf`)
  is BookEvidence-derived, not the full intent-evaluation pipeline — it
  will over-call mismatch on books with unknown intensity/weight buckets
  if the lens prefers light. Always cross-check a flagged `tlm` against
  the `int` / `wt` values — `unknown/unk` on both axes is a classifier
  miss, not a real mismatch.

### `would_eject_under_mood_first` (`wem`)
- **What it captures.** A Pattern-A pure derivation: `tlm === true` AND a
  candidate book in deck positions 11–25 has a low-leaning intensity /
  weight profile (suggesting a lens-friendlier alternative is available
  in the pool the recommender already produced).
- **Why it matters.** This is the closest Phase-1-safe proxy for "Phase 2
  arbitration would actually change the deck." If `wem` is zero across all
  scenarios, Phase 2 has no fuel — even with arbitration math wired, the
  candidate pool does not contain better alternatives.
- **Honest reading.** This is **not** a Phase-2 prediction. It is
  deck-level (does *any* alternative exist), not per-slot replacement
  quality. Two systematic biases:
  - **Overstates.** It counts any low-leaning candidate in 11–25 as a
    valid replacement, even if that candidate is low-scoring on durable
    taste — a real arbitration would weigh both.
  - **Understates.** It does not consider candidates the recommender
    dropped before slot 25 (retrieval expansion is a separate lever).
  Use `wem` as a *floor* on Phase 2 impact, not a ceiling.

### `lens_fit_alternative_nearby` (`lfa`)
- **What it captures.** Independent of any taste-fit verdict: does the
  recommender *have* a lens-friendlier alternative in deck positions
  11–25 right now?
- **Why it matters.** This is the retrieval-expansion diagnostic. If `lfa`
  is consistently false under lens-active scenarios, the issue is not
  arbitration — it is retrieval not surfacing enough lens-fit candidates
  in the first place. Phase 2 arbitration cannot promote what was never
  retrieved.
- **Honest reading.** Same low-leaning heuristic as `wem`. The same
  classifier-miss caveat (`unknown/unk` deflates this) applies.

---

## 5 · Decision thresholds

Aggregate across the 5 scenarios (50 lines total, 40 of them lens-active —
S1–S4). The thresholds below are **calibration hypotheses** (per the locked
recPolicy convention) — they describe a defensible read of the data, not a
proven cut-line. Revisit after the first observation pass.

### Proceed to Phase 2 planning
*All three must hold:*
- **`n_tlm` ≥ 4 of 10 in ≥2 of S1–S4** (taste/lens disagreement is common
  enough to be a real UX issue, not an edge case).
- **`n_wem` ≥ 2 of 10 in ≥1 of S1–S4** (alternatives exist that
  arbitration could reach for).
- **`slot1_tlm === true` in ≥1 of S1–S4** (the #1 visible slot can be
  taste-anchored despite an active lens — the highest-cost failure mode).

If all three hold, open the Phase 2 planning chapter. The arbitration math
has both *demand* (`n_tlm`) and *supply* (`n_wem`) signals.

### Classifier calibration first (do **not** open Phase 2 yet)
*Trigger:* `n_tlm` is high but a non-trivial share of those flagged books
have `int === 'unknown/unk' && wt === 'unknown/unk'`.
- Action: file a follow-up to widen `INTENSITY_*` / `EMOTIONAL_WEIGHT_*`
  SignalSet coverage (Batch C slice C1 candidate) or extend the
  description-derivation corpus.
- Rationale: arbitration math built on a silent classifier will make
  ejection decisions on absence of evidence, not presence of conflict.
  That is worse than the status quo.

### Retrieval expansion first (do **not** open Phase 2 yet)
*Trigger:* `n_tlm` is high but `lfa` is consistently false (≤1 of 4 lens-
active scenarios has `lfa_any === true`).
- Action: file a follow-up to widen branch-planner anchors / quotas for
  the lens-active branches (likely a new branch or a relaxation of
  `LIKED_SUBJECT_AVOID_GUARDS` under specific lenses).
- Rationale: arbitration cannot promote what retrieval never produced.

### Defer steering UI (defer Phase 2 indefinitely)
*Trigger:* all of:
- `n_tlm` ≤ 1 of 10 across all of S1–S4 (lens-active scenarios) — the lens
  is already steering the visible top-10.
- `slot1_tlm === false` in all of S1–S4.
- `n_wem === 0` in all of S1–S4.
- The qualitative read of the top-10 lists "looks right" to the test
  reader for each lens.
- Action: keep the diagnostic in place, retire the Phase 2 planning intent,
  archive this runbook with the observation evidence appended.
- Rationale: today's pipeline (composer + reservation + intent contribution
  + intent fit) is already doing the work a steering UI would expose. A
  user-facing slider would add UI surface without changing outcomes.

### Inconclusive
If the scenarios produce contradictory signals (e.g. high `n_tlm` in S3 but
zero everywhere else), run a second observation session with:
- A different test account whose durable taste leans further away from the
  scenario lens (sharpens contrast).
- A cold-cache rebuild before each scenario (rules out cache restore
  masking the lens delta).

Record both sessions before deciding.

---

## 6 · What must remain untouched during observation

The observation runs in §2 must not change any of:

- **Ranking.** No `recPolicy` constant edits. No `recommender.ts` scoring
  changes. The deck the observation captures must be the deck production
  produces.
- **Scoring.** No `ScoreContribution` shape or weight changes. No new
  contribution kinds.
- **Composer.** `lib/explanations/compose.ts` is frozen — no new admitted
  reason kinds; no per-kind floor changes.
- **RecCard.** `components/RecCard.tsx` copy and visible surfaces frozen.
- **Durable taste.** `lib/tasteProfile.ts` is read-only for this runbook;
  no provenance changes; no `stated_favorite:*` audit-flag changes.
- **Lens persistence.** Lens stays session-only. No persistence of
  intent chips. No lens entries in `recPayloadCache` / `recSession` /
  `recQueue`. No `configHash` changes.
- **`recValidity`.** `VERSION` stays `rcv6`. Bumping it requires a
  contribution-shape change, which Phase 1 explicitly does not have.

If an observation surfaces an obvious bug in any of these (e.g. a missing
`stated_favorite:*` flag, or a composer reason that no longer matches its
contribution), file it as its own batch — **do not fix it inline during
observation.** Mixing fixes into observation invalidates the comparison.

---

## 7 · Architect caveat — validator hardening before Phase 2

The Phase 1 code review (architect, 2026-05-19) returned PASS with one
forward-looking caveat that must be addressed **before** Phase 2 introduces
real arbitration math:

> The new validators' §1 / §4 guard checks rely on backward text search,
> not block-structure / AST scope. They can in principle be fooled by a
> prior unrelated `__DEV__ && FORENSIC_USER_ID` line nearby. One counted
> `getSessionSteering(` "callsite" today is in fact a doc-comment string —
> harmless under Phase 1 because the comment is itself inside the guarded
> block, but the validators do not distinguish executable code from
> comments / string literals.

This does not break Phase 1 behavior (runtime is observation-only and
DEV-gated). It **does** matter for Phase 2 because the validators are the
load-bearing acceptance gates for "no production consumer of the steering
field." Once arbitration is wired to real ranking math, a regression that
escapes the DEV-guard would have user-visible consequences, and the
validators must be unambiguous about catching it.

Required hardening before Phase 2 opens:
1. **AST / brace-aware scope check** for `validate_steering_field_contract
   §4` and `validate_lens_arbitration_log_shape §1`. The validator must
   prove the `getSessionSteering(` call site is structurally inside the
   `if (__DEV__ && userId === FORENSIC_USER_ID) { … }` block, not merely
   preceded by a matching line.
2. **Strip comments and string literals** from the source before counting
   call sites (both validators). A simple tokenizer pass (or a TypeScript
   compiler API walk) is sufficient; line-based regex is not.
3. Add a regression test to each validator: insert a fake out-of-guard
   call site in a fixture string and confirm the validator fails.

Track this as a Phase 2 pre-req. Do not open Phase 2 planning until these
three items are addressed.

---

## Quick reference

```
Enable:    edit lib/recommender.ts:159 → FORENSIC_USER_ID = '<uuid>' (DO NOT COMMIT)
Disable:   revert to FORENSIC_USER_ID = ''
Capture:   .local/lens_arb_logs/<date>_S<n>_<lens>.log
Validate:  npx tsx scripts/validate_steering_field_contract.ts
           npx tsx scripts/validate_lens_arbitration_log_shape.ts
Scenarios: S0 baseline · S1 light+accessible · S2 palate cleanser · S3 less-dark · S4 fast+immersive
Decide:    proceed → calibrate → expand-retrieval → defer (§5 thresholds)
```
