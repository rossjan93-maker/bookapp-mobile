# Operator Runbook — Phase B Lens Arbitration manual capture

**Status (2026-05-26).** Phase B is **engineering-verified only**. Product
acceptance is gated on this capture. Phase B.1 planning is blocked until the
checklist in §8 lands a verdict.

**Scope.** A single signed-in browser session you run end-to-end yourself.
Five scenarios (S0..S4), one combined JSON export, one splitter run, one
aggregator run, one markdown report. ~25 minutes once the test account is
set up.

**This runbook supersedes** `docs/runbook_lens_arbitration_observation.md`
for Phase B re-observation only. The original runbook remains the authoritative
spec for the `[LENS_ARBITRATION]` log surface and field semantics; this file
is the linear operator checklist.

**Hard constraints honored by this document.** No ranking, scoring, composer,
RecCard, finalGate, No-dark, durable-taste, lens-persistence, Phase B.1, or
Phase 2 steering changes. The two new files under `scripts/` are read-only
diagnostic helpers — they do not import or mutate any product code.

---

## 1 · `FORENSIC_USER_ID` setup (local-only — DO NOT COMMIT)

The `[LENS_ARBITRATION]` and `[COLD_START_ADJACENT]` logs fire only when
`__DEV__ === true` AND `userId === FORENSIC_USER_ID`. Default committed
value is `''`, so the logs are silent for every user until you set it
locally.

### 1.1 Get the test-account UUID

Supabase dashboard → **Authentication → Users** → find your test account
→ copy the **User UID** column (it's a UUID like `11111111-2222-…`).

### 1.2 Set FORENSIC_USER_ID in BOTH files

Edit these two lines **only**:

- `lib/recommender.ts:159`
  ```ts
  const FORENSIC_USER_ID = '<paste-test-account-uuid>';
  ```
- `lib/retrieval/branchPlanner.ts:56`
  ```ts
  const FORENSIC_USER_ID = '<paste-test-account-uuid>';
  ```

The two values must match. Both gates emit independently — recommender emits
`[LENS_ARBITRATION]` + `[BOOK_EVIDENCE_C]`; branchPlanner emits
`[COLD_START_ADJACENT]`. If you only set one, you'll get half the capture.

### 1.3 Restart the workflow

In the Replit Workflows pane: **Start application** → Restart. Watch the
log; you should see the Metro bundle complete (~8s) and serve at the
public URL.

### 1.4 Confirm the gate is live

Open the app in your browser, sign in as the test account, open DevTools →
Console, navigate to **For You**. You should see at least one line like:

```
[BOOK_EVIDENCE_C] {"r":1,"t":"…","int":"…","wt":"…", …}
```

If you see **zero** `[LENS_ARBITRATION]` / `[BOOK_EVIDENCE_C]` /
`[COLD_START_ADJACENT]` lines after a fresh deck build, one of these is wrong:
the UUID mismatches, the workflow wasn't restarted, or `__DEV__` is false
(verify by typing `__DEV__` in the console — it should print `true` in a
Metro web build).

---

## 2 · Sparse test-profile setup (per-account, one-time)

Use a **fresh** test account whose `reader_preferences` looks like this:

| Field | Value |
|---|---|
| `favorite_genres` | exactly two: **Mystery**, **Thriller** |
| `avoid_genres` | exactly one: **Horror** |
| `favorite_authors` | empty |
| `reading_styles` | empty (skip all the optional onboarding questions) |
| imported library | **none** (skip Goodreads/CSV import on onboarding) |
| `user_books` | none, or at most 1–2 books rated for sanity (no series, no streaks) |

### 2.1 Easiest path: fresh signup

1. Sign out of any existing account.
2. Sign up with a new email (e.g. `+phaseb-2026-05-26` alias).
3. Onboarding flow:
   - **Favorite genres**: tap *Mystery* and *Thriller* only. Skip the rest.
   - **Avoid genres**: tap *Horror* only.
   - **Reading questions**: skip / select nothing.
   - **Import library**: tap **Skip**.
4. Land on For You. The deck should be a cold-start build (no library
   data, only stated preference). Confirm via the `BuildCause: 'session_open'`
   in the surrounding logs.

### 2.2 Resetting between scenarios

For each scenario you'll force a **cold rebuild** so the lens chip change
actually triggers a new deck rather than restoring the cached one:

- **Preferred** (after pasting the capture snippet in §3):
  `readstackCapture.clearCache()` then hard-refresh For You.
- **Fallback**: Edit Preferences → Save without changes (this bumps the
  configHash and forces a rebuild), then return to For You.

---

## 3 · Browser console capture — paste-once snippet

In the **same tab**, in DevTools → Console:

1. Open `scripts/browser_console_capture_snippet.js` (in this repo).
2. Copy the entire file contents.
3. Paste into the DevTools console and press Enter.

You should see:

```
[readstackCapture] installed v1 — call readstackCapture.startScenario("S0") to begin
```

The snippet wraps `console.log` non-destructively (the original still
prints to the pane) and buffers every `[LENS_ARBITRATION]`,
`[COLD_START_ADJACENT]`, `[BOOK_EVIDENCE_C]`, and `[FINAL_GATE]` line
under the currently-active scenario tag.

**Survives across deck rebuilds. Resets on hard refresh.** If you must
refresh, re-paste the snippet first.

---

## 4 · S0..S4 scenarios (using only existing UI chips)

Chip definitions and labels are from `components/RecommendationsFeed.tsx`
(the Next Read chip bar above the deck). Use only the chips that exist
today — no new product affordances.

| Scn | Console call (paste before chip change) | UI action | Expected `lk` substring |
|---|---|---|---|
| **S0** | `readstackCapture.startScenario('S0')` | Clear all Next Read chips (no lens active). | `(none)` |
| **S1** | `readstackCapture.startScenario('S1')` | Tone chip → **Light**. Mood chip → **Light & accessible** (`light_fun`). | `tone=light,energy=light_fun` |
| **S2** | `readstackCapture.startScenario('S2')` | Clear S1 chips. Mood chip → **Short & light** (`palate_cleanser`). | `energy=palate_cleanser` |
| **S3** | `readstackCapture.startScenario('S3')` | Clear S2 chips. Tone chip → **Light** only (this is the soft `avoid_dark` demote, not the hard No-dark toggle). | `tone=light` *or* `avoid_dark` |
| **S4** | `readstackCapture.startScenario('S4')` | Clear S3 chips. Pace chip → **Fast**. Mood chip → **Immersive** (`immersive`). | `pace=fast,energy=immersive` |

### 4.1 Per-scenario procedure (repeat 5×)

1. **Set the active scenario tag** in the console:
   ```
   readstackCapture.startScenario('S0')   // or S1/S2/S3/S4
   ```
2. **Apply the chips** per the table above. Clear any chips from the
   previous scenario first.
3. **Force a cold rebuild**:
   ```
   readstackCapture.clearCache()
   ```
   Then hard-refresh the For You tab (Cmd-Shift-R / Ctrl-Shift-R).
4. **Wait for the deck to render** all 10 cards. Scroll once to make sure
   the recommender finished. Logs should appear in the pane.
5. **Sanity check** in the console:
   ```
   readstackCapture.status()
   ```
   For the current scenario you want:
   - `lensArb=10` (one per top-10 deck book — this is the load-bearing one).
   - `coldStart` ≥ 0 (will be `1` if the planner emitted; may be `0` if
     adjacency simulation logged only — both are valid).
   - `bookEv` ≥ 10 (correlates with `lensArb`, useful for §8 sanity).
   - `finalGate` may be 0 (queue-boundary gate often doesn't log on
     visible rows — that's normal; absence here is not a defect).

   If `lensArb < 10`, scroll the deck fully, then re-check. If still <10,
   the deck didn't fully render — clear cache and reload.
6. **Move to the next scenario.** Do NOT clear `readstackCapture` —
   it accumulates buckets per scenario id.

### 4.2 After all 5 scenarios

Final status check:

```
readstackCapture.status()
```

Expected (approximate — `bookEv` correlates 1:1 with `lensArb`):

```
[readstackCapture] active=S4
  S0: lensArb=10  coldStart=…  bookEv=10  finalGate=…
  S1: lensArb=10  coldStart=…  bookEv=10  finalGate=…
  S2: lensArb=10  coldStart=…  bookEv=10  finalGate=…
  S3: lensArb=10  coldStart=…  bookEv=10  finalGate=…
  S4: lensArb=10  coldStart=…  bookEv=10  finalGate=…
```

If any scenario shows `lensArb < 10`, re-run just that scenario before
exporting.

---

## 5 · One combined export file

Still in the console:

```
readstackCapture.export()
```

A file named `readstack_phase_b_capture_<YYYY-MM-DD>.json` will download.
Move it into the repo:

```bash
mkdir -p .local/lens_arb_logs
mv ~/Downloads/readstack_phase_b_capture_*.json .local/lens_arb_logs/
```

`.local/lens_arb_logs/` is already gitignored.

**File format** (schema `readstack_phase_b_capture/v1`):

```json
{
  "schema":     "readstack_phase_b_capture/v1",
  "capturedAt": "2026-05-26T…",
  "exportedAt": "2026-05-26T…",
  "userAgent":  "…",
  "activeScenario": "S4",
  "scenarios": {
    "S0": { "startedAt": "…",
            "lensArb":   ["[LENS_ARBITRATION] {…}", …×10],
            "coldStart": ["[COLD_START_ADJACENT] …"],
            "bookEv":    ["[BOOK_EVIDENCE_C] {…}", …×10],
            "finalGate": ["[FINAL_GATE] …"?],
            "rawLines":  […all four kinds in capture order…] },
    "S1": { … },
    "S2": { … },
    "S3": { … },
    "S4": { … }
  }
}
```

**Recovery if you accidentally closed DevTools without exporting:** open
the tab, paste the snippet, paste `readstackCapture.exportRaw()` — the
returned string is the same JSON (the buffer survives DevTools close as
long as the page stayed loaded). If the page was refreshed the buffer is
gone; re-run the affected scenarios.

---

## 6 · Aggregator command

The combined JSON splits into the 5 per-scenario `.log` files the
existing aggregator already consumes:

```bash
# Step 1 — split the combined JSON into 5 .log files
npx tsx scripts/split_combined_capture.ts \
  .local/lens_arb_logs/readstack_phase_b_capture_2026-05-26.json

# The splitter prints the exact Step 2 command. It will look like:
npx tsx scripts/diag_lens_arbitration_aggregate.ts \
  --S0 .local/lens_arb_logs/2026-05-26_S0_baseline.log \
  --S1 .local/lens_arb_logs/2026-05-26_S1_light.log \
  --S2 .local/lens_arb_logs/2026-05-26_S2_palate.log \
  --S3 .local/lens_arb_logs/2026-05-26_S3_less-dark.log \
  --S4 .local/lens_arb_logs/2026-05-26_S4_fast.log \
  --out docs/diag_phase_b_observation_2026-05-26.md
```

The aggregator is read-only, does not call Supabase, and does not invoke
the recommender. Its executive summary applies the runbook §5
first-match-wins thresholds (Calibrate → Expand → Proceed → Defer) and
returns one of four verdicts.

The output Markdown (`docs/diag_phase_b_observation_<date>.md`) is the
authoritative artifact for the §8 checklist.

---

## 7 · Teardown

### 7.1 Revert `FORENSIC_USER_ID` in BOTH files

- `lib/recommender.ts:159` → back to `const FORENSIC_USER_ID = '';`
- `lib/retrieval/branchPlanner.ts:56` → back to `const FORENSIC_USER_ID = '';`

### 7.2 Verify nothing is committed

Run this **before** committing anything:

```bash
rg "FORENSIC_USER_ID\s*=\s*'[^']" lib/recommender.ts lib/retrieval/branchPlanner.ts
```

Expected output: **no matches**. If you see any match, the UUID is still
in your source file — fix before committing.

Also verify no log files / capture JSON got staged:

```bash
git --no-optional-locks status --short .local/
```

Expected: empty (`.local/` is gitignored, but `git add -f` could have
pulled them in by accident).

### 7.3 Re-run the contract validators

```bash
npx tsx scripts/validate_steering_field_contract.ts
npx tsx scripts/validate_lens_arbitration_log_shape.ts
npx tsx scripts/validate_cold_start_adjacent.ts
```

All three must report green. If any fail because `FORENSIC_USER_ID`
isn't `''`, you missed §7.1 — go back and fix.

### 7.4 Restart the workflow

**Start application** → Restart. This loads the reverted source. Verify
once more by signing in as the same test account and watching the
console: you should see **zero** `[LENS_ARBITRATION]` lines now (the gate
no longer matches).

---

## 8 · Pass/fail checklist — product acceptance

Read these against the aggregator's output Markdown
(`docs/diag_phase_b_observation_<date>.md`). All six must pass to mark
Phase B product-accepted.

| # | Criterion | Pass if | Fail if |
|---|---|---|---|
| 1 | **Adjacency candidates enter visible top deck** | At least one S0..S4 deck contains a book whose author/title overlaps the `cozy mystery` / `cozy crime` / `amateur sleuth` corpus (e.g. Richard Osman, Alan Bradley, M.C. Beaton, Sophie Hannah's cozies), AND `mp` for that row is `cozy_detective` (or similar non-`domestic_suspense`). | Zero adjacency-class titles in any of S0..S4 → adjacency was retrieved but lost to scoring. Open **first-deck structure** chapter, not Phase B.1. |
| 2 | **Domestic-suspense saturation drops** vs. pre-Phase-B baseline (`.local/lens_arb_logs/REPORT.md` 2026-05-20: 8/10 S0, 7/10 S1..S4) | S0 `mp=domestic_suspense` count ≤ 6/10, AND at least one of S1..S4 ≤ 5/10. | Saturation unchanged → retrieval isn't the bottleneck; composition is. Open **first-deck structure** chapter. |
| 3 | **`lfa_any` improves** | At least one lens-active scenario (S1..S4) reports `lfa_any = true`. | All four lens-active scenarios still `lfa_any = false` → no lens-fit alternative reached deck slot 11–25. Open **lens vocabulary / lifecycle** chapter. |
| 4 | **`n_wem` becomes meaningful or is explained** | Either: at least one S1..S4 reports `n_wem ≥ 1`; OR `n_wem = 0` everywhere AND `classifier_miss_rate ≤ 40%` (the "no real mismatch to eject" case). | `n_wem = 0` everywhere AND `classifier_miss_rate > 40%` → BookEvidence still silent on the adjacency-class books too. Open **lens vocabulary / lifecycle** chapter. |
| 5 | **`classifier_miss_rate` remains acceptable** | Average across S1..S4 ≤ 40%. Baseline was 70%; C1 vocabulary widening shipped 2026-05-20 should have helped but Phase B adds new candidates that may carry richer subjects. | Average > 50% → C1 widening insufficient for adjacency corpus. Open **lens vocabulary / lifecycle** chapter. |
| 6 | **`thin` and `high_signal` remain unchanged** | (Engineering-verified already by `scripts/runtime_observe_phase_b_s0_s4.ts` §3.) No re-verification needed from the manual capture — this row is just a reminder that the manual capture must NOT use a high-signal account. | Account had imported library / many ratings → wrong confidenceMode → capture invalid. |

### 8.1 Verdict mapping (first-match-wins)

Apply in order; first match decides:

1. **Criterion 6 fails** → capture invalid. Reset profile per §2 and re-capture.
2. **Criterion 5 fails** → calibrate BookEvidence first (lens vocabulary chapter). Phase B.1 stays blocked.
3. **Criteria 1 or 2 fail** → first-deck structure chapter. Phase B.1 stays blocked.
4. **Criteria 3 or 4 fail (and 1, 2, 5 pass)** → lens vocabulary / lifecycle chapter. Phase B.1 stays blocked.
5. **All six pass** → **Phase B is product-accepted.** Phase B.1 planning may open with the captured data as its evidence base.

---

## 9 · Status statement

**Phase B.1 (lens-aware breadth modulation) is BLOCKED until the §8
checklist completes with a verdict.** Engineering verification proves
the policy ships and behaves to spec at the plan layer (3 adjacency
anchors admitted in cold_start, zero in thin/high_signal, lens-blind by
design, cache invalidates correctly). It does NOT prove product impact.
Opening Phase B.1 without §8 data would commit a calibration decision
on guessed evidence.

If any §8 criterion fails, the appropriate follow-up chapter (first-deck
structure, lens vocabulary, or rollback) opens instead — Phase B.1 stays
blocked behind that chapter's own acceptance.

---

## 10 · Artifacts referenced

| Path | What it does |
|---|---|
| `scripts/browser_console_capture_snippet.js` | Paste-once console tap; produces the combined JSON export. |
| `scripts/split_combined_capture.ts` | Read-only converter: combined JSON → 5 per-scenario `.log` files for the aggregator. |
| `scripts/diag_lens_arbitration_aggregate.ts` | Existing aggregator; consumes the 5 `.log` files and writes the Markdown observation report. |
| `.local/lens_arb_logs/REPORT.md` | Pre-Phase-B baseline (2026-05-20). The reference snapshot for §8 criteria 2 and 5. |
| `docs/runbook_lens_arbitration_observation.md` | Authoritative spec for the `[LENS_ARBITRATION]` log surface and field semantics. |
| `docs/diag_lens_arbitration_blocker_2026-05-19.md` | Why headless capture from Replit is blocked. |
| `docs/diag_phase_b_reobservation_2026-05-26.md` | Prior turn's engineering-verification report (no live capture). |
