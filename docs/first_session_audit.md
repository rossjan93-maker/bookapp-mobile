# First-Session Impact Audit — Readstack

**Date:** 2026-05-12
**Scope:** Onboarding intro slides → final-setup CTAs → quick intake (5 steps) → Taste Readout → Your Next Read filters.
**Mode:** Audit only. No code, schema, recommender, LLM, auth, Sentry, native, or metadata changes proposed in this document. All proposals are UI/copy/data-pass-through batches sized to ship one at a time.

---

## 1. Diagnosis — what the first session feels like today

Readstack's first 90 seconds currently read like a **library tracker setup**, not a **decision system you trust with your next read**. Concretely:

1. **Intro slides (`app/onboarding.tsx`)** lead with "organised," "recommendations that fit you," and "start with what you've already read." Two of the three are tracker / setup framings; the value promise ("a book you'll actually finish tonight") never lands before the user is asked to import.
2. **Final setup screen (`app/onboarding-import.tsx`)** treats Import vs. Pick-Genres as **equivalent paths**. In reality, Pick-Genres is a *much weaker* cold start, and the CTA copy doesn't tell the user that or sell the calibration step that follows.
3. **Quick intake (`RecEntryScreen.tsx`)** has grown to **5 phases (genres → avoid → outcome → 3 taste Qs → anchor book)**. Three of the five are good. Two have known friction:
   - The 3-question taste block (`q_what_grips` / `q_pacing` / `q_tone`) is a cluster of small abstract tradeoffs in the middle of a momentum-sensitive flow. Users finish it but don't feel it shaped anything.
   - The anchor-book step is open-ended search — high effort, easy to skip, and the "one book stands in for your taste" mental model is fragile.
4. **Taste Readout (`components/TasteReadout.tsx`)** is the moment of truth and currently reads as a **static chip wall** ("Loves X · Less of Y · Reading for Z"). It mirrors what the user just typed back at them. It does not yet *show one concrete book* derived from those signals, which is what would convert "you heard me" into "you understood me."
5. **Your Next Read filters (`RecommendationsFeed.tsx` chip panel + `lib/nextReadIntent.ts`)** expose seven chip groups (energy, pace, tone, intensity, length, format, series). The set is *technically* complete but reads like a search facet UI. First-session users don't yet know what their own preferences are — they need **fewer, more situational** entry points ("Tonight I want…") rather than seven orthogonal axes.

**Underlying pattern:** every surface is honest and well-built individually, but each one defaults to *information density* over *one decisive moment*. The first session needs three decisive moments — promise, calibration, payoff — and right now we have five soft ones.

---

## 2. Product direction (one sentence)

> Reframe the first session as **"in 90 seconds, we'll show you one book you actually want to read tonight"** — and have every screen visibly serve that promise.

Implication for every batch below: when in doubt, **cut**, don't add.

---

## 3. Proposed copy — Onboarding intro slides (3)

Replace the current `SLIDES` const in `app/onboarding.tsx` (lines 62-81). Tone: confident, specific, premium-restrained. No emojis. Each slide ≤ 2 short lines of body.

**Slide 1 — Promise**
- Title: *Your next great read, decided.*
- Body: Stop scrolling lists. We learn what hooks **you** and hand you the book to start tonight.

**Slide 2 — How it works (the system)**
- Title: *Built around your taste, not the bestseller list.*
- Body: A few honest answers calibrate it. Every rating sharpens it. No algorithmic mystery.

**Slide 3 — Trust / proof**
- Title: *The shelf, the streak, the why.*
- Body: Track what you finish, see why each pick fits, and skip anything that doesn't. You're in charge.

**Why these three:** slide 1 sells the *outcome* (decision, tonight). Slide 2 sells the *mechanism* (calibration + transparency — Readstack's actual differentiator vs. Goodreads/StoryGraph). Slide 3 sells the *control* (no lock-in feel). The current "organised" / "fit you" / "start with what you've read" set leads with setup, not outcome.

---

## 4. Proposed copy — Final-setup screen CTAs

`app/onboarding-import.tsx`. Make the two paths visibly **non-equivalent** — Import is the high-signal path, Genres is the fast-start path — and sell the calibration that follows the genres path so it doesn't feel like a consolation.

**Header**
- Title: *One last step before your first pick.*
- Subtitle: Two ways in. Pick whichever feels easier — you can always add the other later.

**Primary CTA (Import)**
- Label: **Import my Goodreads library**
- Subline: Best signal. We'll learn from every book you've already rated.

**Secondary CTA (Genres → calibration)**
- Label: **Start with a 60-second taste check**
- Subline: Five quick questions. Good enough to recommend something tonight.

**Tertiary**
- Label: Skip — just let me browse
- (No subline. Keep it deliberately quiet.)

**Why:** "Pick genres instead" makes Genres sound like a downgrade. "60-second taste check" reframes it as a *product feature* (calibration) and makes the duration explicit so users commit.

---

## 5. Proposed intake set (5 steps → keep 5, swap one, restructure one)

Current order is correct. Two changes:

**Step 1 — Genres you love** *(unchanged from UX-3A)*
**Step 2 — Genres you'd skip** *(unchanged from UX-3A)*
**Step 3 — Reading outcome** *(unchanged from UX-3C — `q_outcome`)*

**Step 4 — Replace the 3-question taste block with one situational question + one tone slider**
- The current `q_what_grips` / `q_pacing` / `q_tone` set is three small abstract tradeoffs in a row. Collapse to:
  - **Q4a (situational, single tap):** *When a book finally clicks for you, it's usually because…*
    - "the characters got under my skin" → maps to existing `character_driven` answer key
    - "the world felt real and specific" → `world_first`
    - "I couldn't stop turning pages" → `plot_first`
    - "the writing itself was beautiful" → `prose_first`
  - **Q4b (tone slider, single tap):** keep `q_tone` exactly as shipped in UX-3D (heavier / lighter / flexible). Rename screen header to *"And the mood you reach for?"* so the two questions feel like one beat.
- Drop `q_pacing` from the intake. **Reason:** pacing is the single most-used Your-Next-Read chip post-intake; asking for it once at intake then again per session creates whiplash and a fixed prior the user can't easily revise. Let the chip carry it.
- **All four Q4a answer keys must already exist in `ANSWER_BOOSTS`.** Audit confirms `character_driven`, `plot_first`, `prose_first` exist; `world_first` exists. No recommender change needed — same opt-chaining no-op safety as `tone_flexible`.

**Step 5 — Replace the anchor-book search with a "pick from a small slate"**
- Open-ended search is the highest-friction step in the flow and gives the recommender the **least diverse** signal (most users type the same five megasellers).
- Replacement: show **6 small covers** drawn from `lib/seededPicks.ts` (already exists, already verified rows). Copy: *"Tap one that already feels like 'me' — or skip."* Single tap = anchor book set. Three-cover fallback if `seededPicks` is filtered for the user's liked-genre split.
- Skippable. The skip path stays exactly as today.

**Net effect:** flow is still 5 phases. Phases 4 and 5 are each one tap shorter and one decision easier. No new screens, no new persistence shape, no recommender wiring.

---

## 6. Proposed Taste Readout experience

`app/taste-readout.tsx` + `components/TasteReadout.tsx` + `lib/tasteReadoutCopy.ts`.

Today the readout is a strong **chip wall**. It needs **one concrete artifact** to convert "you heard me" into "you understood me."

**Proposal — three-band layout (top → bottom):**

1. **Band 1 — Headline + summary** *(unchanged from UX-3B/E)*
2. **Band 2 — NEW: "Here's the kind of book this points at"**
   - One large cover + one-sentence rationale, rendered from `getRecSession()` if the For-You session is already primed (B-3 home shortlist already does this), otherwise from `seededPicks` filtered by the readout's own chip state.
   - Rationale uses the existing `RecCard` rewriter (so SAFE/HISTORY gating from UX-1A still applies — thin profiles get safe copy).
   - Tap → goes to book detail. **No save action on this screen** — this is the *promise reveal*, not an action surface.
3. **Band 3 — Chips + "Refine" link** *(chips unchanged from UX-3B/E, but visually demoted: smaller, lower contrast, subhead "What we're working from")*
4. **CTA** *(unchanged: "Show me my picks")*

**Why this works without breaking constraints:**
- Pulls from existing surfaces (`getRecSession`, `seededPicks`, `RecCard` rewriter). No new recommender call, no new schema.
- Demoting chips to band 3 fixes the "static wall" problem without removing the trust value.
- Skipping Band 2 cleanly when both `getRecSession()` and the filtered `seededPicks` slice are empty falls back to today's UI exactly — no regression.

---

## 7. Proposed Your Next Read filters

`RecommendationsFeed.tsx` chip panel + `lib/nextReadIntent.ts` (filter shape **unchanged**, only chip surface re-grouped).

Current: 7 chip groups (energy, pace, tone, intensity, length, format, series). Honest but reads like a search facet UI.

**Proposal — collapse to 3 "situational" rows + 1 "constraints" row, all backed by existing intent fields:**

**Row 1 — "Tonight I want…"** *(maps to existing `readingEnergy` + `pace` softs)*
- Something light & quick → `readingEnergy: 'comfort'` + `pace: 'fast'`
- Something I can sink into → `readingEnergy: 'deep'` + `pace: 'medium'`
- Something I'll think about for a week → `readingEnergy: 'challenge'` + `pace: 'slow'`

**Row 2 — "In the mood for…"** *(maps to existing `tone` + `intensity`)*
- Lighter / hopeful → `tone: 'light'`
- Darker / heavier → `tone: 'dark'` + `intensity: 'high'`
- Funny → new soft key only if `humor` already exists in nextReadIntent's vocabulary; otherwise drop this chip rather than add a key (filter shape is in scope, vocabulary is not for this batch)

**Row 3 — "Format"** *(unchanged — `fiction_only` / `nonfiction_only` / `standalone_only`)*

**Row 4 — "Length"** *(unchanged — `max_page_count` chips)*

**Cuts:** the standalone "Energy" / "Pace" / "Tone" / "Intensity" rows go away as separate groups. They still exist as fields — Row 1 and Row 2 just *bundle* the most common combinations a first-session user actually wants to express.

**Power-user escape hatch:** add a quiet "More filters →" link at the bottom of the panel that reveals the full 7-row legacy view. Zero churn for returning users; far less cognitive load on first session.

---

## 8. Implementation batches (sequenced, sized for one task each)

Each batch is sized to one Project Task. File budgets are ceilings, not estimates. **Stop conditions** are non-negotiable — if a stop condition is hit mid-batch, ship what's done and re-scope the rest.

### **Batch FS-1 — Onboarding intro slide copy** *(lowest risk)*
- **Files:** `app/onboarding.tsx` only.
- **Touches:** `SLIDES` const (lines 62-81) + any tightly-coupled style if line breaks force it.
- **Risk:** trivial. Copy-only.
- **Stop condition:** if the slide layout starts wrapping awkwardly on small screens, ship the copy and defer typography tweaks to FS-1.1.
- **Out of scope:** illustrations, animations, slide count.

### **Batch FS-2 — Final-setup CTA copy + visual hierarchy**
- **Files:** `app/onboarding-import.tsx` only.
- **Touches:** the three CTA blocks (lines ~134-292) + button styling so the import CTA reads as primary and "skip" reads as quiet tertiary.
- **Risk:** low. No handler change.
- **Stop condition:** if making "Skip" visually quiet requires a new shared button variant, ship the copy + label hierarchy with existing styles and park the visual demotion.

### **Batch FS-3 — Intake Step 4 collapse (3 Qs → 1 situational + tone)**
- **Files:** `components/RecEntryScreen.tsx` (TASTE_QS array + StepDots count if changed), `lib/intakeDraft.ts` (only if `IntakePhase` enum needs trimming — likely not).
- **Pre-flight:** confirm `character_driven` / `plot_first` / `prose_first` / `world_first` exist in `ANSWER_BOOSTS`. If any are missing, **drop that option** rather than add the key (recommender change forbidden).
- **Risk:** medium. Touches the most active intake surface.
- **Stop condition:** if dropping `q_pacing` causes a regression in any code path that reads `tasteAnswers['q_pacing']` outside `applyDiagnosisBoosts`, restore `q_pacing` and ship only the Q4a swap.
- **Out of scope:** any change to `applyDiagnosisBoosts`, ANSWER_BOOSTS keys, or schema.

### **Batch FS-4 — Intake Step 5: anchor-book slate (replaces open search)**
- **Files:** `components/RecEntryScreen.tsx` (anchor phase), reuse `lib/seededPicks.ts` (read-only).
- **Risk:** medium. UI swap, not handler swap — the existing anchor-book write path stays.
- **Stop condition:** if `seededPicks` returns < 3 covers after liked-genre filtering, fall back to the current open search for that user.
- **Out of scope:** seeding new books, changing `seededPicks` contents.

### **Batch FS-5 — Taste Readout: add Band 2 (one cover + rationale)**
- **Files:** `components/TasteReadout.tsx`, `app/taste-readout.tsx` (data-pass-through only — read `getRecSession()` and pass first eligible book + its first reason), reuse `RecCard`'s rewriter via prop or extracted pure helper if cheap; otherwise inline the safe variant strings.
- **Risk:** medium-high — this is the only batch that touches a presentational component the user *will* notice.
- **Stop condition:** if `getRecSession()` is empty AND filtered `seededPicks` is empty, render today's UI unchanged. Do not invent a fallback book.
- **Out of scope:** any save / dismiss / MLT action on this screen, any new recommender call.

### **Batch FS-6 — Taste Readout: visual demotion of chip band**
- **Files:** `components/TasteReadout.tsx` only.
- **Risk:** low. Pure styling.
- **Sequencing:** ship after FS-5 lands and is observed in the wild, not bundled with it.

### **Batch FS-7 — Your Next Read: collapse chip groups to 4 rows + "More filters"**
- **Files:** `components/RecommendationsFeed.tsx` chip panel render (lines ~1212-1430) + chip → intent mapping (lines ~743-820).
- **Pre-flight:** verify the bundled chip presets in Row 1 / Row 2 produce `nextReadIntent` shapes that the existing pipeline already accepts (no new keys).
- **Risk:** medium. This is the surface returning users use most — regressions are visible.
- **Stop condition:** if collapsing the rows breaks the existing "filter pulse" loading affordance (lines 705-740), ship the row collapse with the legacy pulse intact and defer animation tightening.
- **Out of scope:** `nextReadIntent.ts` field shape, recommender, NL parser.

**Sequencing recommendation:** FS-1 → FS-2 → FS-3 → FS-5 → FS-7 → FS-4 → FS-6. Front-load the highest-confidence copy wins (1, 2), then earn the right to touch the hot surfaces (3, 5, 7), then do the higher-friction structural swap (4) and the cosmetic polish (6) last.

---

## 9. Risks & "do not build"

**Risks to flag at task-creation time:**
- **FS-3 anchor confidence:** if any of the four Q4a answer keys are missing from `ANSWER_BOOSTS`, the option silently no-ops. The audit-time check is mandatory; without it the user sees four options that visibly do nothing.
- **FS-5 rewriter coupling:** pulling `RecCard`'s rewriter into TasteReadout risks re-renders the rewriter wasn't designed for. Prefer extracting a **pure** helper (`buildSafeReason(reason, tasteProfile)`) into `lib/recCardCopy.ts` rather than importing RecCard.
- **FS-7 chip-state migration:** users mid-session at release time may have soft state set on rows that no longer exist (e.g. `intensity: 'high'` standalone). The collapsed Row 2 still produces those fields, so existing state is forward-compatible — but verify with one manual replay before shipping.

**Do not build, regardless of perceived value:**
- Any new question that would require a new `ANSWER_BOOSTS` key.
- Any LLM call inside the Taste Readout (e.g. "AI summary of your taste"). Out of scope and trust-corrosive on thin profiles.
- A "compare to other readers" / social proof block on any first-session screen. Off-promise for the system framing.
- A settings-screen toggle for MLT auto-add (still parked).
- Sentry / analytics instrumentation (parked by user direction).
- Any onboarding change that adds a sixth phase. Five is the ceiling.

---

## 10. What success looks like (for the eventual measurement task — not this one)

When FS-1 through FS-7 are all merged, a first-session user should be able to say, **before opening For-You**: *"It asked me five fast things, then showed me a book it thinks I'll like and told me why."* If a returning user opens Your Next Read and says *"there are fewer chips, I can find the right combo faster,"* FS-7 worked.

If users still describe Readstack as "a tracker that also recommends," none of this worked and the diagnosis in §1 was wrong — re-audit before shipping more copy.

---

## 11. Taste Readout experience — extended audit (added 2026-05-12)

This section supersedes the brief Band-2 sketch in §6. It evaluates three approaches to the post-intake "wow" moment and recommends one with concrete copy, staging, and sequencing. **No LLM. No fake certainty. No implied reading history. Animation must visualize signals the user actually gave us, not invented backend work.**

### 11.1 Three approaches evaluated

| Dimension | **A — Pure model reveal** *(animation, no book)* | **B — First book reveal** *(prior §6 proposal)* | **C — Hybrid: model reveal → optional teaser/book** |
|---|---|---|---|
| **Emotional payoff** | Medium. Synthesis lands but ends abstract — no concrete artifact to anchor "you understood me." | High *if* the book lands. Risk of flat / generic if it doesn't. | High. Motion adds satisfaction; the synthesis lands; the optional teaser lets us *show* without overcommitting. |
| **Trust risk** | **High.** Stage labels like "Reading your signals…" / "Balancing pace, tone, and depth…" imply real-time computation that isn't happening. This is the textbook AI-theater failure mode. | Medium. Honest if recSession is real; **risky if we fall back to generic seededPicks**, because a megaseller cover under "here's what your taste points at" reads as "you didn't actually read me." | Low *if* stages strictly visualize captured signals (no fake "computing" labels). The teaser fallback uses a *category description*, not a specific book, so trust degrades gracefully. |
| **Implementation complexity** | Medium. Staged `Animated.timing` sequence, no new data reads. | Medium-high. 3 files, RecCard rewriter coupling, recSession-or-seededPicks branching, fallback render. | Medium-high. Animation + branching teaser logic, but each branch is independently testable and shippable. |
| **Dependence on recSession** | Zero. Same experience for every user. | **High.** When `getRecSession()` is empty (a meaningful share of first-session users), we either show a weak generic pick or render today's static UI. | Graceful. Full reveal animation always runs. Cover slot only appears when recSession is genuinely populated; otherwise a category teaser fills the slot. |
| **Gimmick / fake-AI risk** | **Highest.** Multi-stage labels are exactly the pattern that reads as "they're faking computation to feel premium." Sophisticated users will notice. | Low. Static reveal, honest. | Low *with strict guardrails*: no stage labels that describe invented work; chips animate from their own intake provenance; max one neutral header. |
| **Product-thesis fit** ("understand your taste → help you choose with confidence") | Medium — covers "understand" but not "choose." | Highest — directly delivers "choose," but only when data supports it. | Highest — "understand" via the reveal, "choose" via the optional preview, with honest fallback when the data isn't there. |

### 11.2 Recommendation: **Option C (Hybrid)** with strict anti-theater guardrails

**Why C wins:**
- It is the only option that **degrades gracefully** when recSession is empty. Option B fails closed (generic pick or no Band 2 at all); Option A always succeeds but never proves the system can actually *pick*.
- The reveal animation, executed honestly, converts the existing static chip wall into a moment of motion *without inventing reasoning steps*. The chips themselves are the evidence — they were tapped 30 seconds ago.
- It lets us ship the synthesis copy improvement *first* (FS-5a) as a low-risk standalone win, then layer animation (FS-5b), then the optional preview (FS-5c) — three independently valuable batches with stop-conditions between each.

**Hard guardrails (non-negotiable, and the reason A fails):**
1. **No stage label may describe work that isn't visibly happening.** "Reading your signals…" is banned. "Balancing pace, tone, and depth…" is banned. If a stage exists, the only label allowed is one that names what the user can already *see on screen* in that moment (e.g., a single neutral header).
2. **Every animated element must originate from a real intake answer.** Genre chips animate from the genre step. Outcome/tone chips animate from those steps. Nothing fades in that the user didn't type.
3. **No spinners. No progress bars. No typewriter text on the synthesis sentence.** All three read as theater.
4. **Total reveal duration ≤ 1.2s, tap-to-skip enabled.** Premium ≠ slow. Returning users (post-Refine) skip instantly.
5. **The optional book preview only renders when `getRecSession()` returns a non-empty, eligible book.** Falling back to `seededPicks` for the cover slot is **explicitly forbidden** — that's the trust-corrosion path. If recSession is empty, the slot renders the category teaser (text-only) instead.

### 11.3 Concrete staged sequence for Option C

Total budget: ~1.0–1.2s end-to-end. Tap anywhere to skip to final state.

| t (ms) | Stage | What animates | What it's showing | Honest? |
|---|---|---|---|---|
| 0 | Header settles | Headline "Here's what we heard" fades in (180ms) | Static label | Yes |
| 120 | Liked-genre chips | The 1–3 genre chips the user tapped scale-in from 0.85 → 1.0 with stagger (40ms apart) | Their actual genre answers, in tap order | Yes — these were typed |
| 320 | Outcome + tone chips | The `q_outcome` and `q_tone` chips slide in from below (220ms ease-out) | Their actual stated preferences | Yes |
| 540 | Avoid chips (if any) | "Less of: X" chips fade in at lower opacity (180ms) | Their actual avoid-genre answers | Yes |
| 720 | Synthesis line | One-sentence summary fades in below the chips (220ms) | Pre-computed `buildSummary()` output — no dynamic generation | Yes — assembled from the same chips visible above |
| 940 | Optional Band 2 | If `getRecSession()` non-empty: cover + rationale fade in (220ms). Otherwise: category teaser line fades in. | Real recommender output, OR a category-level description derived from the chips already on screen | Yes — fallback is text, never a generic cover |
| 1160 | CTA "Show me my picks" | Button fades to full opacity | Standard primary CTA | Yes |

**Visual treatment notes:**
- Use existing SAGE accent for the chip stagger highlight. No new colors.
- Reuse the `LayoutAnimation` pattern from `HomeShortlist` (220ms easeInEaseOut) — single source of motion truth.
- Connector lines between chips and the synthesis line are **not** recommended. They imply graph-based reasoning we aren't doing.
- No "thinking…" pulse, no shimmer, no progress dots.

**What this avoids:**
- The reveal looks like *the chips themselves assembling into a profile* — which is literally what's happening — rather than a backend service computing something. The user sees their own answers being arranged into a summary. No fiction.
- A skip-tap freezes the final state immediately, so power users and returners aren't punished.

### 11.4 Stronger synthesis example for the worked scenario

Scenario: liked = sci-fi & fantasy + thriller & mystery; reading for = depth (`craft_first`); tone = darker (`dark_tone`); preferred = fast pacing; avoid = business.

**Today's `buildSummary` would produce something like:**
> "Early signal: you lean toward sci-fi & fantasy."

**Proposed synthesis (FS-5a target):**
> "Sharp, dark fiction read for craft — sci-fi futures and tight thrillers that move fast but reward attention. We'll keep business out of the mix."

Why it's stronger:
- **Names the cluster**, not just the top genre ("sci-fi futures and tight thrillers" combines the two liked clusters into one coherent shape).
- **Encodes the outcome answer** ("read for craft") without using the abstract label `craft_first`.
- **Encodes the tone answer** ("sharp, dark") inline, not as a separate chip claim.
- **Encodes the trait** ("move fast but reward attention" = fast pacing + depth coexisting honestly).
- **Encodes the avoid** ("we'll keep business out of the mix") — turns a negative chip into a forward-looking commitment.
- **No history claim.** Nothing in this sentence implies the user has rated anything yet. Safe for thin profiles.

**Band 2 — when recSession is populated** (cover + one-sentence rationale via existing RecCard rewriter):
> *Annihilation* — Jeff VanderMeer
> "Tight, eerie sci-fi with the slow-build menace your tone signal points to."

**Band 2 — fallback when recSession is empty (text-only category teaser, no cover):**
> "We're aiming this at dark literary sci-fi and high-stakes thrillers that don't drag — Jeff VanderMeer, Tana French, Adrian Tchaikovsky territory."
>
> *(Three author names are honest reference points for the cluster, not "we recommend these books." Pick from a curated 12-author lookup table in `lib/tasteReadoutCopy.ts` keyed by liked-genre × tone — no recommender call, no metadata fetch.)*

### 11.5 Implementation batches (replaces audit §8 FS-5 / FS-6 entries)

The original FS-5 / FS-6 batch pair is superseded by **three** smaller batches: **FS-5a** (copy), **FS-5b** (animation shell), **FS-5c** (optional preview). FS-6 (chip demotion) remains as previously specified. Sequence and observe between each.

#### **FS-5a — Synthesis copy upgrade** *(ship first, lowest risk)*
- **Files:** `lib/tasteReadoutCopy.ts` only (extend `buildSummary` to compose genre-cluster + outcome + tone + trait + avoid into one sentence; add the category-teaser lookup table for FS-5c's fallback path so it ships unused but ready).
- **File budget:** 1 file.
- **Risk:** **Low.** Pure-function copy change. No IO, no rendering change.
- **Type:** **Copy-only.**
- **Stop conditions:** if the new synthesis fails for any combination of intake answers (verify with the existing combinations in tests or a manual matrix), fall back to the current `buildSummary` line for that combination rather than ship a half-broken sentence.
- **Out of scope:** TasteReadout.tsx, animation, Band 2.

#### **FS-5b — Animated reveal shell** *(ship after FS-5a is observed)*
- **Files:** `components/TasteReadout.tsx` only. The data is already on the screen — we are only changing how it appears.
- **File budget:** 1 file.
- **Risk:** **Medium.** Touches the most-watched first-session surface. Animation regressions are visible.
- **Type:** **UI-only.** No new data, no copy change, no behavior change.
- **Stop conditions:** if the staggered chip-in animation conflicts with React Native's existing `LayoutAnimation` on this screen (the screen does not currently use it, so unlikely), ship a single fade-in for the whole readout instead of staged. If total reveal exceeds 1.2s on any tested device, cut a stage rather than slow the others.
- **Hard guardrails (from §11.2):** no stage labels describing fake work, no spinners, no typewriter, tap-to-skip mandatory.
- **Out of scope:** Band 2 cover/teaser, chip demotion (FS-6).

#### **FS-5c — Optional Band 2: cover-when-real, teaser-when-not** *(ship only after FS-5a and FS-5b land cleanly)*
- **Files:** `components/TasteReadout.tsx`, `app/taste-readout.tsx` (data pass-through — read `getRecSession()`), `lib/tasteReadoutCopy.ts` (the category-teaser lookup added in FS-5a is now consumed). Optionally extract `buildSafeReason(reason, tasteProfile)` into `lib/recCardCopy.ts` to avoid coupling TasteReadout to RecCard.
- **File budget:** 3 files (4 if the rewriter helper is extracted, which is recommended).
- **Risk:** **Medium-high.** This is the only batch with a real trust-corrosion failure mode. The seededPicks-as-cover fallback is explicitly forbidden (§11.2 guardrail 5).
- **Type:** **Behavior-changing.** New data read, new render branch, new tap-through to book detail. Save/dismiss/MLT remain off this screen.
- **Stop conditions:**
  - If `getRecSession()` is non-empty but the first eligible book has no cover or no rationale, fall back to the category teaser. **Do not show a coverless card.**
  - If the category-teaser lookup is missing for the user's chip combination, render today's UI (no Band 2) rather than a generic "books we think you'll like" placeholder.
  - If extracting `buildSafeReason` causes any RecCard regression, inline the safe-variant strings into TasteReadout for now and ship the extraction as a follow-up.
- **Out of scope:** any new recommender call, any metadata fetch, any Goodreads/Open Library/Google Books read.

#### **FS-6 — Chip band visual demotion** *(unchanged from original §8; ships after FS-5c)*
- Files, budget, risk, and sequencing as previously specified.

### 11.6 Sequencing summary

```
FS-5a (copy)           → ship → observe 1 session
FS-5b (animation)      → ship → observe 1 session
FS-5c (Band 2)         → ship → observe 1 session
FS-6  (chip demotion)  → ship
```

Each batch is independently valuable. If any batch hits a stop condition, the prior batches still stand and the readout is meaningfully better than today.

### 11.7 Risks recap (Taste Readout-specific)

- **AI-theater regression:** the animation guardrails in §11.2 are load-bearing. If anyone proposes a "Reading your signals…" stage during implementation, refer them back to §11.2.1 and refuse.
- **Cover-fallback trust corrosion:** the single biggest risk in this entire workstream. `seededPicks` may **not** populate the Band 2 cover slot. Text-only category teaser is the only sanctioned fallback.
- **Animation perf on low-end devices:** staggered chip-in over 1.2s should not introduce jank, but verify on the lowest supported Android device before FS-5b ships. If jank appears, drop to single fade-in.
- **Synthesis brittleness:** `buildSummary` extension in FS-5a needs a manual matrix pass over the combinations of (genre count × outcome × tone × trait × avoid). Missing combinations should fall back to today's line, not a degraded new line.

