# BookEvidence Batch C slice C0 — Operator Observation Runbook

**Status:** C0 is shipped as shadow-mode foundation only. This runbook describes how to use the `[BOOK_EVIDENCE_C]` top-10 DEV log to judge whether the new `intensity` and `emotionalWeight` axes are underfiring, overfiring, or directionally useful — **before** any C1 (ranking influence) or C2 (composer admission) work is planned.

**Hard reminder.** Nothing in this runbook touches ranking, composer, RecCard copy, or the No-dark / Less-dark gates. The observation is read-only. If you find yourself wanting to "just nudge" one of those surfaces during observation, stop and write a C1 planning chapter instead.

---

## 1. Set FORENSIC_USER_ID for one test session

The log is gated by `__DEV__ && userId === FORENSIC_USER_ID` at `lib/recommender.ts:3604`. The constant is declared empty at `lib/recommender.ts:158`.

**Steps.**
1. Grab the UID of your test account from Supabase Auth (Authentication → Users → copy the UUID). Use a **dedicated test account**, never your real user.
2. Edit `lib/recommender.ts` line 158:
   ```ts
   const FORENSIC_USER_ID = '00000000-0000-0000-0000-000000000000'; // <test uid>
   ```
3. Save. Metro will hot-reload; no native rebuild needed (`npm run dev:device` is enough).
4. Sign in as the test account on device.
5. Confirm the gate is live: trigger one For-You build and grep the workflow log for `[BOOK_EVIDENCE_C]`. You should see up to 10 lines per build.

**Safety rails.**
- Do NOT commit the populated UID. Revert to `const FORENSIC_USER_ID = '';` before any commit (see §6).
- Do NOT set this to a real user's UID. The forensic block also enables `[FC1_TOP10]`, `[CACHE_BYPASS]`, and several other verbose traces — fine for a test account, noisy and privacy-sensitive otherwise.
- Observation is local-dev only. The constant is read at module init; published builds with `FORENSIC_USER_ID = ''` will never fire the block.

---

## 2. Lenses to run (one fresh deck per lens)

Run each lens on a fresh For-You build (pull-to-refresh or kill/relaunch). Capture the top 10 results per lens. **Five lenses, in this order:**

| # | Lens | How to apply | Why it's in the matrix |
|---|---|---|---|
| 1 | **Baseline / no lens** | Clear any active intent; fresh app launch | Establishes the unfiltered distribution of `int` / `wt` buckets across the user's natural top-10 |
| 2 | **No dark** | Intent → tone → "Avoid dark themes" (or whatever the No-dark control is on your build) | Confirms `int`/`wt` distribution does NOT shift due to the hard-exclusion (the gate is supposed to use `darkPhrasal` only — if you see the distribution shift, that's a signal the new axes leaked into `finalGate.ts`) |
| 3 | **Less dark** | Intent → tone → "Less dark" | Bounded-demotion lens; expect the deck to mostly hold its shape with some reordering. `int`/`wt` are observational; they should NOT influence the demotion ordering |
| 4 | **Light & accessible** | Intent → "Light & accessible" / `light_fun` | This is the lens where C1 admission is most likely to land — pay closest attention. Expect (under good calibration) the top-10 to skew toward `int=low` + `wt=low`, even though nothing today enforces that |
| 5 | **Short & light / palate cleanser** | Intent → "Palate cleanser" | Same direction as #4 but stricter on length. Cross-check that intensity/weight buckets agree with the intent |

For each lens, capture the deck twice (two fresh builds, ~30s apart) if the deck has any randomness — gives you a sanity read on stability of the buckets.

---

## 3. Exact log lines to capture

After each fresh build, the workflow log (`Start application`) will contain a block like:

```
[BOOK_EVIDENCE_C] {"r":0,"id":"OL12345W","t":"The Silent Patient","int":"spec","wt":"unknown","c_len":482,"fiSpec":2,"fwSpec":0}
[BOOK_EVIDENCE_C] {"r":1,"id":"OL67890W","t":"Beach Read","int":"broad","wt":"spec","c_len":318,"fiSpec":0,"fwSpec":1}
...
```

**Field key:**
- `r` — rank in the top-10 visible deck (0-indexed)
- `id` — book id (Open Library work id when available)
- `t` — title (truncated by JSON serializer if long)
- `int` — intensity bucket: `spec` / `broad` / `medium` / `unknown`
- `wt` — emotional-weight bucket: same set
- `c_len` — combined corpus length (subjects + description) that the classifier scanned
- `fiSpec` — first intensity SignalSet hit, specific tier (raw count)
- `fwSpec` — first emotional-weight SignalSet hit, specific tier (raw count)

**Bucket projection (for reference, identical to validator §4):**
- `spec` = specific count ≥ 1 on the dominant pole
- `broad` = broad count ≥ 2 on the dominant pole, no specific
- `medium` = both poles fired at "strong" tier (high + low both ≥ 1 specific or ≥ 2 broad)
- `unknown` = nothing reached threshold (most common for sparse-metadata books)

**Capture method.** `rg -n "BOOK_EVIDENCE_C" /tmp/logs/Start*.log | tail -50 > /tmp/c0_lens_N.txt` per lens. Then transcribe into the table below.

---

## 4. Recording table (one row per top-10 book per lens)

For each lens, fill a 10-row table:

| rank | title | tone | pace | complexity | intensity | emotionalWeight | first matching phrase | judgment |
|------|-------|------|------|------------|-----------|-----------------|----------------------|----------|
| 0 | | | | | | | | |
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| 6 | | | | | | | | |
| 7 | | | | | | | | |
| 8 | | | | | | | | |
| 9 | | | | | | | | |

**Column sources.**
- `tone` / `pace` / `complexity` — from the existing `[BOOK_EVIDENCE]` Batch B log emitted on the same build, or read off the RecCard if you've surfaced them; otherwise leave blank
- `intensity` / `emotionalWeight` — the `int` / `wt` fields from the `[BOOK_EVIDENCE_C]` line
- `first matching phrase` — open the book in the app, copy the most salient subject or description phrase that you believe the classifier latched onto (the SignalSet entries are in `lib/evidence/signals.ts`)
- `judgment` — one of:
  - **correct** — bucket matches your read of the book
  - **questionable** — bucket is defensible but you'd argue the other way
  - **wrong** — bucket is clearly mis-classified
  - **unknown** — corpus is too thin to fairly judge (note `c_len`; books with `c_len < 80` are often legitimately unknown)

Aim for 50 rows total (5 lenses × 10 books). One observation pass per week is plenty; the signal-list changes you'd consider are slow-moving.

---

## 5. Patterns to look for after one observation pass

### Safe to proceed to C1 planning
- ≥ 80% of judged rows are **correct** (excluding `unknown` rows from the denominator).
- The **Light & accessible** lens shows a visible skew toward `int=low` (`spec` or `broad`) + `wt=low/unknown` in the top-10, even though nothing today enforces it. This means C1's "soft demote `int=high` under `light_fun`" hypothesis would land on the right side of the deck.
- Diagonal cases (e.g. low intensity + high weight: `Everything I Never Told You`, `Klara and the Sun`, `A Little Life`) classify correctly. This is the carry-forward stress case Batch B couldn't resolve.

### Signal list needs calibration (no architecture change)
- A small set of recurring phrases (≤ 5) accounts for most **wrong** rows. Fix is to edit `lib/evidence/signals.ts` — add a missing specific phrase, demote a too-eager broad entry, or remove an ambiguous one. Re-run `npm run validate:book-evidence-intensity`. recValidity does NOT bump (book-side classification is not a configHash input).
- A specific genre cluster (e.g. romance, sci-fi) is consistently `unknown` because its native vocabulary isn't represented. Add genre-flavored phrases to the relevant SignalSet.

### Classifier is overclaiming (must address before C1)
- ≥ 20% of rows are **wrong** in the same direction (e.g. lots of false-high intensity).
- A single broad token is driving most of the noise (e.g. `taut` matching every literary blurb). Either promote it to specific-only or remove it.
- Memoir-trap regression: bare `memoir` is firing `wt=high`. Re-run `validate_book_evidence_intensity §6` immediately — if §6 stays green but you're seeing this, the corpus contains the phrased form ("memoir of loss") legitimately, not a bug.

### Classifier is underfiring (calibration window must continue)
- ≥ 40% of rows are `unknown` on books with `c_len ≥ 150`. The vocabulary is too narrow.
- Books you would obviously call high-intensity (thrillers with strong reviews) sit at `int=unknown` because their subjects are generic ("fiction", "thrillers"). C0 is description-aware via the SEMANTIC corpus, so this usually means description text is missing — verify with the source book in Supabase before adding more phrases.
- The **Light & accessible** lens shows no skew toward `int=low` — classifier isn't picking up enough lightness signals. Underfiring blocks C1; expand `INTENSITY_LOW` and `EMOTIONAL_WEIGHT_LOW` before any admission work.

**Decision rule.** Do not start C1 planning until you have one observation pass that lands in the "safe to proceed" pattern. If you land in "calibration needed", iterate on `signals.ts` only, re-run both validators, and observe again.

---

## 6. Revert / clear FORENSIC_USER_ID after observation

1. Edit `lib/recommender.ts` line 158 back to:
   ```ts
   const FORENSIC_USER_ID = '';
   ```
2. Save. Hot-reload will pick it up; the `[BOOK_EVIDENCE_C]` block (and all other forensic traces) will stop firing.
3. Verify with `rg -n "FORENSIC_USER_ID = '" lib/recommender.ts` — you should see `''` (empty string).
4. If you accidentally committed a populated UID, revert with a fresh commit setting it back to `''`. Do not rewrite history on shared branches.

A pre-commit safety grep is fine but not required: `! rg -q "FORENSIC_USER_ID = '[0-9a-f-]" lib/recommender.ts`.

---

## 7. Standing reminder — what this runbook does NOT authorize

- ❌ No edit to `lib/intent/finalGate.ts` or the `evaluateBookAgainstIntentLens` avoid_dark branch — pinned by `validate_no_dark_isolation §1–§2`.
- ❌ No edit to `lib/explanations/compose.ts` to add new reason kinds — pinned by `validate_no_dark_isolation §3` and `validate_explanation_faithfulness`.
- ❌ No edit to `components/RecCard.tsx` to surface intensity / weight copy.
- ❌ No edit to scoring code in `lib/recommender.ts` to give the new axes a `ScoreContribution`.
- ❌ No `recValidity.VERSION` bump.

Calibration edits in `lib/evidence/signals.ts` (the four new SignalSets only) are safe and expected during observation. If a calibration edit causes either new validator to fail, the edit is wrong — fix it before re-observing.

C1 work begins only after a "safe to proceed" observation pass AND a written C1 planning chapter that defines the admission gate shape (mirror the P4D tone/pace admission pattern) and the validator additions that would pin it.
