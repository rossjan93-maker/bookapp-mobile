# readstack — Project Status Checkpoint

**Date:** 2026-04-01  
**Basis:** Live repository audit. All facts grounded in current code.

---

## 1. Executive Summary

**Solid**
- Auth session bootstrap (`getSession` → `ensureProfile` → `checkOnboardingCompleted` → `readOnboardingStage`) is sound.
- The `locallyDone` guard in `_layout.tsx` correctly prevents the `USER_UPDATED` race that previously bounced users back to onboarding after dismissal.
- Routing guard tri-state (`undefined → null/boolean`) prevents premature routing during async resolution.
- Welcome screen: animations fire on fixed timeout (not chained to springs); 12-second failsafe in place.
- Walkthrough advance/skip ordering: `writeOnboardingStage('final_setup')` resolves before `setWtStep('done')`, preventing premature `RecEntryScreen` trigger.
- Tier < 1 gate in `RecommendationsFeed`: setup CTA renders immediately, pipeline never runs, no `DeckAssemblingLoader` for new users.
- `recPayloadCache` pre-warm in `(tabs)/_layout.tsx`: fills in-memory session before Recommend tab mounts.
- Swipe gesture correctly disabled during walkthrough steps.

**Partially working**
- `insufficient_pool` quality gate: messaging was wrong (fixed in last session — now shows full actionable CTA). First-ever hit still shows `DeckAssemblingLoader` for 5–6 seconds (pipeline IS running — honest but jarring).
- `displayState` machine: `loading_initial` now guards `&& !recsQualityGate` — prevents repeated loader on reload when gate is known from session. First hit is still a full pipeline run.
- Coach card: reduced padding, shadow replaced with thin border, narrower margins. Still a fundamentally full-width card; visual weight lower but not eliminated.

**Broken**
- Account delete + recreate on same device bypasses onboarding entirely. AsyncStorage keys (`readstack_onboarding_stage_v1='done'`, `readstack_rec_entry_v1='1'`) survive account deletion and sign-out.
- `handleIntake()` does not call `markOnboardingComplete()`. `profiles.onboarding_completed` stays `false` for intake-path users. Cross-device inconsistency: new device shows welcome screen again.
- `insufficient_score` quality gate: type exists in recommender, no dedicated render branch.

**Architecturally sound**
- Onboarding stage machine: single key, four values, one writer per transition.
- `computeTasteProfile`: pure function, Bayesian genre affinity scaling is principled.
- Recommender pipeline: clearly separated retrieval → enrichment → scoring → quality gate.
- `recPayloadCache` as durable cross-session storage (user-keyed AsyncStorage).

**Patched / fragile**
- Dual-source truth for onboarding completion: `profiles.onboarding_completed` (DB) + local `readstack_onboarding_stage_v1`. The local key is the race fallback; local wins over DB.
- `(tabs)/_layout.tsx` does walkthrough state, swipe gesture, badge fetching, and rec pre-warm. Large surface area.
- `search.tsx` at 2007 lines: hub + search + friends + send + rec entry + rec feed + taste tags + hub data loading all in one file.

---

## 2. Onboarding State Model

| State item | Lives in | Written by | Read by | Risk |
|---|---|---|---|---|
| `profiles.onboarding_completed` | Supabase DB | `onboarding-import.tsx` (3 of 3 paths, 2 of 3 immediately) | `_layout.tsx` `checkOnboardingCompleted` | Authoritative cross-device |
| `readstack_onboarding_stage_v1` | AsyncStorage | `onboarding.tsx`, `onboarding-import.tsx`, `(tabs)/_layout.tsx` | `_layout.tsx`, `(tabs)/_layout.tsx`, `onboarding-import.tsx`, `search.tsx` | Persists after account delete |
| `readstack_walkthrough_v1` | AsyncStorage | `(tabs)/_layout.tsx`, `onboarding.tsx` | `(tabs)/_layout.tsx` | Harmless persistence |
| `readstack_rec_entry_v1` | AsyncStorage | `RecEntryScreen.tsx` on any choice | `search.tsx` `hasSeenRecEntry()` | Persists after account delete — new account skips RecEntryScreen |
| `recPayloadCache:${userId}` | AsyncStorage | `lib/recPayloadCache.ts` | `(tabs)/_layout.tsx` pre-warm, `RecommendationsFeed` | User-keyed; safe |
| In-memory rec session | Module-level `lib/recSession.ts` | `(tabs)/_layout.tsx`, `RecommendationsFeed` pipeline | `RecommendationsFeed`, queue system | Ephemeral; cleared on sign-out |

**Auth events handled:** `SIGNED_IN`, `USER_UPDATED` → `ensureProfile` + `checkOnboarding`. `SIGNED_OUT` → clears tab caches only (NOT AsyncStorage).

---

## 3. Recommendations State Model

**Tier definition:**
- Tier 0: < 5 strong signals → setup CTA; pipeline never runs
- Tier 1: 5–9 strong signals → pipeline runs; DeckAssemblingLoader
- Tier 2: 10+ strong signals → pipeline runs
- Tier 3: 10+ strong signals + import + enrichment → pipeline runs

**No intake boost to tier.** Intake answers affect trait scores only, not `strongSignalCount`. Intake-path user with 0 finished books stays tier 0 → setup CTA, no loading.

**`displayState` machine (current):**
```
isInitialLoading && !hasCards && !recsQualityGate → loading_initial (DeckAssemblingLoader)
hasCards                                          → ready / ready_refreshing
deckTransitionHint                                → transitioning
recsQualityGate                                   → quality_gated
isExhausted                                       → exhausted_refreshing / exhausted_terminal
else                                              → empty
```

**Quality gate renders:**
- `insufficient_pool` → full actionable CTA (import / add books / refine preferences)
- `intent_filtered_empty` → compact "No matches with these filters" + Clear filters button
- `insufficient_score` → generic "No close matches" card (no dedicated branch — gap)
- Other → generic "No close matches" card

**Known loading risk:** Pipeline has no network timeout. On lossy mobile, `isInitialLoading=true` indefinitely.

---

## 4. Final Setup Exit Paths

### A. Import my library
1. `completeOnboarding()` → React state (sync)
2. `await Promise.all([writeOnboardingStage('done'), markOnboardingComplete()])` (AsyncStorage + DB)
3. `router.push('/import/goodreads')`

Status: **Deterministic.**

### B. Answer a few questions
1. `completeOnboarding()` → React state (sync)
2. `await writeOnboardingStage('done')` (AsyncStorage only)
3. `router.replace('/onboarding-questions')`

`markOnboardingComplete()` is NOT called here — deferred to `onboarding-questions.tsx`.

Status: **Partially fragile.** DB `onboarding_completed` stays false if user backs out mid-intake. LocalStage='done' covers same-device. New device re-shows welcome screen.

### C. Not right now
1. `completeOnboarding()` → React state (sync)
2. `await Promise.all([writeOnboardingStage('done'), markOnboardingComplete()])` (AsyncStorage + DB)
3. `router.replace('/(tabs)')`

Status: **Deterministic.** USER_UPDATED race fixed by `locallyDone` guard.

---

## 5. AsyncStorage Key Inventory

| Key | Value | Risk |
|---|---|---|
| `readstack_onboarding_stage_v1` | `null/'walkthrough'/'final_setup'/'done'` | Survives account delete → bypasses onboarding |
| `readstack_walkthrough_v1` | `null/'home'/'recommend'/'library'/'inbox'/'done'` | Survives delete; overwritten at next onboarding start |
| `readstack_rec_entry_v1` | `'1'` or null | Survives delete → RecEntryScreen never shows for new account |
| `readstack_guided_tour_v1` | Step number (legacy; always 99) | Dead code — still read/written on every mount |
| `recPayloadCache:${userId}` | JSON rec payload | User-keyed; safe against user switching |
| `readstack_tooltip_v1_scan_result` | `'1'` or null | Feature-local |
| `OnboardingTooltip_v1_${id}` | `'1'` or null | Multiple keys; survive delete |

**None of these keys are cleared on `SIGNED_OUT` or account deletion.**

---

## 6. Pass/Fail Matrix

| Journey | Status | Reason |
|---|---|---|
| A. Signup before email confirmation | FRAGILE | Depends on Supabase autoconfirm setting and email delivery |
| B. Email confirmation link | FRAGILE | Deep link / redirect URL behavior is runtime-dependent |
| C. First login after confirmation | PASS | Deterministic — `checkOnboardingCompleted=false` + `readOnboardingStage=null` → onboarding |
| D. Returning user login | PASS | `checkOnboardingCompleted=true` → normal app |
| E. Refresh during welcome | PASS | `inOnboarding=true` → no redirect |
| F. Refresh during walkthrough | PASS | `midFlow=true` → no redirect; overlay resumes from stored step |
| G. Refresh during final setup | PASS | `inOnboarding=true` + mount guard reads `stage='final_setup'` |
| H. Final setup → import | PASS | Both writes awaited; `locallyDone` covers DB failure |
| I. Final setup → answer questions | FRAGILE | `markOnboardingComplete()` not called; DB inconsistency if user backs out |
| J. Final setup → not right now | PASS | Both writes awaited; USER_UPDATED race fixed |
| K. New low-signal user on Recommendations | PASS | `hasPersonalizationSignal=false` → RecEntryScreen; tier=0 → setup CTA |
| L. Large import history on Recommendations | PASS (caveats) | Pipeline runs; quality gate now shows actionable CTA; first hit still loads 5–6s |
| M. Delete + recreate same device | **FAIL** | AsyncStorage survives delete → bypasses onboarding + RecEntryScreen |
| N. Dev onboarding reset | FRAGILE | Must manually clear 3+ AsyncStorage keys; clearing DB alone insufficient |

---

## 7. Instrumentation Map

| Log tag | Location | Gated? | Notes |
|---|---|---|---|
| `[ROOT_GUARD]` | `app/_layout.tsx` | Never | Every routing decision — useful |
| `[STAGE]` | `(tabs)/_layout.tsx` | Never | Stage transitions — useful |
| `[WT]` / `[WT_ADVANCE]` | `walkthroughEngine.ts`, `(tabs)/_layout.tsx` | Never | Walkthrough events |
| `[IMPORT_ROUTE]` | `onboarding-import.tsx` | Never | Every action on import page |
| `[PERF]` | `search.tsx`, `library.tsx`, `index.tsx` | `__DEV__` | Hub timing |
| `[REC_REFRESH]` | `RecommendationsFeed.tsx` | `__DEV__` | Pipeline trigger reason |
| `[REC_LOADING]` | `RecommendationsFeed.tsx` | `__DEV__` | Pipeline start; `visible` = queue depth, not loader visibility (misleading name) |
| `[POOL_CHECK]` | `lib/recommender.ts` | `__DEV__` | Quality gate decision |
| `[PERSIST_CACHE]` | `lib/recPayloadCache.ts` | `__DEV__` | Cache hit/miss/age |
| `[taste_tags]` | `library.tsx` | **NOT gated** | Fires in production builds — should be `__DEV__` |

**Missing:** No log on `maybeShowEntry()` decision, `hasPersonalizationSignal()` result, quality gate state restored from session, or RecEntryScreen show/dismiss.

---

## 8. Technical Debt / Fragility Points (Ranked)

1. **`search.tsx` at 2007 lines.** Hub + search + rec entry + friend send + taste tags + hub data loading in one component. Highest regression risk.
2. **Dual-source onboarding truth.** `profiles.onboarding_completed` (DB) and `readstack_onboarding_stage_v1` (local). Local wins over DB via `locallyDone` guard. Undocumented priority order.
3. **AsyncStorage never cleared on sign-out / delete.** Every `readstack_*` key persists. Multi-account usage, dev resets, and delete+recreate flows all produce stale state.
4. **`COACH_H_EST=160` is a constant, not measured.** Positioning math uses this value. Small screens, accessibility font sizes, or long body text cause card overflow.
5. **Library spotlight uses static fallback rect.** No `onLayout` hook in `library.tsx`. Spotlight may miss actual content on non-standard screen sizes.
6. **`runPipeline` has no network timeout.** OL live fetch can hang indefinitely. `isInitialLoading=true` forever on lossy mobile connections.
7. **`entryChecked` ref is a permanent lock.** Once set, `maybeShowEntry()` never re-runs in the component's lifetime, even after transient DB errors.
8. **`computeTasteProfile` on every `loadHub()` call.** Three concurrent DB queries on every tab focus. No caching layer for the taste profile.
9. **Pipeline trigger dep: `strongSignalCount` only.** If book count stays constant but ratings/genres change, pipeline does not re-trigger.
10. **`readstack_guided_tour_v1` is dead code.** Read and written on every tab mount; always advances to 99 immediately. Clean up.

---

## 9. Prioritized Next Actions

| Priority | Action | Why it matters |
|---|---|---|
| 1 | Clear AsyncStorage `readstack_*` keys on `SIGNED_OUT` | Fixes delete+recreate bug; fixes dev reset; removes stale-state category |
| 2 | Verify `onboarding-questions.tsx` calls `markOnboardingComplete()` | Intake path leaves DB in inconsistent state if this is missing |
| 3 | Add network timeout to `runPipeline` (10s AbortController) | Prevents infinite `DeckAssemblingLoader` on lossy mobile |
| 4 | Remove `readstack_guided_tour_v1` legacy key | Dead code with AsyncStorage overhead on every tab mount |
| 5 | Measure coach card height dynamically via `onLayout` | Prevents overflow/clip on small screens or accessibility font sizes |
| 6 | Add `onLayout` measurement to Library first book row | Walkthrough spotlight aligns with real content |
| 7 | Log `maybeShowEntry()` decision path | Currently no way to trace why RecEntryScreen showed or was skipped |
| 8 | Gate `[taste_tags]` logs behind `__DEV__` | Currently fires in production builds |
| 9 | Add dedicated `insufficient_score` quality gate render | Currently falls through to generic "no close matches" |
| 10 | Split `search.tsx` | Long-term regression prevention |

---

## 10. Open Questions

1. **Email confirmation redirect URL** — What is the Supabase auth redirect URL? Deep link / redirect behavior requires runtime confirmation.
2. **`markOnboardingComplete()` in `onboarding-questions.tsx`** — Not verified in this audit. Must confirm the completion handler calls it.
3. **OL metadata repair timing** — How quickly does `repairBooksMetadata` run post-import? Until repair completes, imported books have `subjects=null` and the recommender falls back to `raw_shelves`.
4. **`insufficient_score` trigger conditions** — The quality gate type exists in the recommender but exact scoring thresholds not audited. Whether it fires in practice is unknown.
5. **React StrictMode in development** — Double-fires pipeline trigger effect, doubling network calls in dev. Behavior is dev-only but makes pipeline timing tests unreliable.
6. **Delete-account edge function coverage** — Whether `delete-account/index.ts` clears all user tables (`reader_preferences`, `user_books`, `profiles`, `recommendations`) was not verified.
