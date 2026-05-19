# [LENS_ARBITRATION] observation — blocker report (2026-05-19)

You asked for the Phase 1 observation to be **run as a read-only diagnostic
script** instead of by manual app testing, with the report written to
`docs/diag_lens_arbitration_observation_<date>.md`.

The task as written cannot be fully automated from this environment today.
Per your explicit fallback instructions, this report describes:

1. exactly what is blocking automation,
2. the minimal data / access needed to unblock it,
3. the smallest fallback manual step (with tooling already in place).

---

## A · What is blocking automation

### A1. No real user UUID was provided

The attached prompt contains the literal placeholder
`<PASTE_FULL_USER_UUID_HERE>`. The runbook (`docs/runbook_lens_arbitration_observation.md` §1)
deliberately requires a real authenticated test-account UUID — `FORENSIC_USER_ID`
defaults to `''` in `lib/recommender.ts:159`, and no real user matches an
empty string, so the gated log is silent for every account until a UUID
is locally set.

I will not invent, hard-code, or commit any user UUID, per your hard
constraint and the project's secrets policy.

### A2. The recommender is React-Native-bound at module-load time

`lib/recommender.ts::getRankedRecs` (line 2073) is **logically** pure-ish —
it takes `(candidates, profile, intent, …)` as arguments and returns a
`RankedRecsResult`. But the wiring around it is not headless-runnable from
Node:

- The harness that produces `candidates` (live branch-planner retrieval +
  Open Library / Google Books enrichment + catalog reads) lives in
  `lib/recommender.ts` itself, transitively importing `./recRequest`,
  `./recPayloadCache`, `./recQueue`, `./recSession`, `./intent/finalGate`.
- All of those transitively import `lib/supabase.ts`, whose **top of
  file** does:
  ```ts
  import { Platform } from 'react-native';
  import AsyncStorage from '@react-native-async-storage/async-storage';
  ```
- These imports execute at module load. Running anything that touches
  `lib/recommender.ts` from `tsx` / `node` fails immediately on `react-native`
  resolution, before any function is called.

Making the recommender headless-runnable from Node would require either:
- A non-trivial RN/Expo shim layer (mock `react-native` Platform, mock
  AsyncStorage, polyfill `expo-*` modules transitively reached, plus any
  React-Native-specific behavior the Supabase auth client triggers on
  load), **or**
- A refactor that extracts the pure scoring/ranking pipeline from the
  RN-bound harness.

Either path is a **product code change**, which your instructions
explicitly disallow for this task ("Do not add product code unless a
small diagnostic script is required").

### A3. Even with shims, the recommender needs live external dependencies

Per scenario, a real deck build needs:
- Supabase service-role access to read `reader_preferences`, `user_books`,
  `books`, `series_books`, and the user's social graph for the target UUID.
  (`SUPABASE_SERVICE_ROLE_KEY` is available, but the URL is not exported
  to this environment as a top-level secret — only `SUPABASE_URL` would be
  needed alongside, which the available-secrets list does not include.)
- Open Library + Google Books API access for retrieval enrichment.
- A populated `recPayloadCache` or a cold rebuild path (and the rebuild
  path uses module-level singletons in `lib/recPrewarm.ts` /
  `lib/recSession.ts` that assume an app lifecycle).

The combination is not Node-runnable today without product changes.

---

## B · Minimal data / access to unblock full automation

In rough increasing order of effort:

1. **A real test-account UUID** (drops blocker A1 only).
2. **A pure-recommender export module** — a new `lib/recommenderPure.ts`
   that re-exports `getRankedRecs` + `branchPlanner` + helpers behind a
   barrel that does NOT touch `lib/supabase.ts`. This is a small
   refactor (~1 hr) but it is product code and needs its own planning chapter.
3. **A Node-runnable data-loader** that talks to Supabase via
   `@supabase/supabase-js` (no `react-native` import) using
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to fetch the per-user
   inputs `getRankedRecs` needs (taste profile, library, series progress,
   author read counts, retrieval candidates). This is several hours of
   diagnostic-script work and would also need to mirror — not import —
   the live retrieval branch logic, or accept a snapshot input from a
   live capture.
4. **A Phase 1.1 DEV-log extension** that adds `author`, `marketPos`,
   `finalGateExclusion`, and explicit tone/pace/complexity confidences
   to the `[LENS_ARBITRATION]` payload. Small additive change inside
   the existing `__DEV__ && userId === FORENSIC_USER_ID` guard, but it
   is product code and would need its own planning chapter + validator
   updates.

None of these are appropriate to do under the present task's hard
constraint of "do not add product code unless a small diagnostic script
is required." All four would be sensible chapters to consider before
Phase 2 — but they are decisions for you, not for this turn.

---

## C · Smallest fallback manual step (with tooling shipped now)

The Phase 1 log already emits enough to compute every aggregate stat the
report needs (`n_tlm`, `n_wem`, `lfa_any`, `slot1_tlm`,
`classifier_miss_rate`) and per-book detail (rank, title, durable taste
fit, lens fit, intensity bucket, weight bucket, would-eject flag,
alternative-nearby flag). What was missing was a single command that
turns five captured log files into the report you want.

That command is shipped now: `scripts/diag_lens_arbitration_aggregate.ts`
(read-only, no Supabase, no recommender invocation, no state mutation).

**Smallest path to a real report:**

1. **Set `FORENSIC_USER_ID` locally — DO NOT COMMIT.**
   ```
   # lib/recommender.ts line 159
   const FORENSIC_USER_ID = '<paste-test-account-uuid>';
   ```
   Restart `Start application`.
2. **For each of S0…S4**, sign in as that account, apply the lens
   described in runbook §2, trigger a cold deck build (close + reopen,
   or clear `recPayloadCache` then open For You), and save the 10
   `[LENS_ARBITRATION]` console lines to:
   ```
   .local/lens_arb_logs/2026-05-19_S<n>_<lens-shorthand>.log
   ```
3. **Run the aggregator:**
   ```
   npx tsx scripts/diag_lens_arbitration_aggregate.ts \
     --S0 .local/lens_arb_logs/2026-05-19_S0_baseline.log \
     --S1 .local/lens_arb_logs/2026-05-19_S1_light.log \
     --S2 .local/lens_arb_logs/2026-05-19_S2_palate.log \
     --S3 .local/lens_arb_logs/2026-05-19_S3_less-dark.log \
     --S4 .local/lens_arb_logs/2026-05-19_S4_fast.log \
     --out docs/diag_lens_arbitration_observation_2026-05-19.md
   ```
4. **Revert `FORENSIC_USER_ID` to `''`** and re-run the two contract
   validators to confirm baseline:
   ```
   npx tsx scripts/validate_steering_field_contract.ts
   npx tsx scripts/validate_lens_arbitration_log_shape.ts
   ```

The aggregator's executive summary applies the runbook §5 thresholds
(first-match-wins: **calibrate → expand retrieval → proceed → defer**)
and returns one of four verdicts plus rationale. If inputs are missing
or empty it returns "Inconclusive" rather than inventing a verdict.

**Fields the report will NOT cover** without a Phase 1.1 log extension
(per §B item 4): `author`, `visible reason`, explicit `toneConfidence` /
`paceConfidence` / `complexityConfidence`, `market_position`, and
`finalGate hardExclusion`. These were in the original request but the
shipped log does not emit them. Two ways to get them today:
- Manually annotate from the For You card surface during capture (slow).
- Correlate with `[BOOK_EVIDENCE_C]` and `[FINAL_GATE]` log lines from
  the same session (the runbook already recommends capturing
  `[BOOK_EVIDENCE_C]` alongside).

---

## D · Hard constraints — all held

- Read-only: no `reader_preferences` / `user_books` / lens / persistence
  writes anywhere in the new script.
- No ranking, scoring, composer, RecCard, finalGate, or `recValidity`
  change.
- No new product code in `lib/`. The only new file under `lib/` would be
  the optional `lib/recommenderPure.ts` extraction (§B item 2), which I
  did not perform — that is a planning decision.
- `FORENSIC_USER_ID` left at `''` in `lib/recommender.ts`.
- No user UUID committed.
- The new aggregator script is read-only stdin/stdout/file IO; it does
  not import `lib/recommender.ts` or any RN-bound module.

---

## E · Next decisions for you

1. Run the §C four-step fallback yourself (≈ 20 min of dev-session
   capture + one script run) to get the report this turn aimed for.
2. **Or** open a small Phase 1.1 chapter to (a) extract a pure-recommender
   module so the diagnostic can run headlessly, and/or (b) extend the
   `[LENS_ARBITRATION]` payload with the missing fields. Both would
   need their own planning + validators per the operating standard.
3. **Or** defer the observation pass until you have an opportunity to
   capture the logs naturally during your next dev session.

I am not making this call for you. The runbook, the aggregator, and
this blocker report together leave the next move as a one-decision
choice rather than a multi-step investigation.
