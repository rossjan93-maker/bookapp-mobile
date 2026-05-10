# Book Recommendation App

Readstack helps users discover, track, and share personalized book recommendations.

## Run & Operate
- `npm run dev:device` — JS-only changes on device.
- `npm run build:android:dev` / `build:ios:beta` — native build.
- **Required env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OPEN_LIBRARY_API_KEY`, `GOOGLE_BOOKS_API_KEY`. Optional: `LLM_MODEL` (for `inferSubjectsLLM.ts`).
- **Pending migrations** (apply via Supabase dashboard SQL editor):
    - `20260413000001_rec_snapshots.sql`
    - `20260414000000_user_books_edition_key.sql`
    - `20260506000000_user_books_paused_at.sql`
    - `20260506000001_user_shelves.sql`
    - `20260507000000_rating_half_star.sql`
    - `20260507000001_user_books_year_goal.sql`
    - `20260508000000_p0_security_hardening.sql`
    - `20260509000000_p0_5_catalog_protection_clarity.sql`
    - `20260510000000_p1_security_hardening.sql`
    - `20260510000001_p1_cap_race_fix.sql`
    - `20260511000000_p1_5a_provenance.sql`
    - `20260512000000_p1_5b_1_verification_reconciler.sql` *(applied; reconciler deployed + scheduled — see architecture bullet)*

## Stack
React Native + Expo Router, Supabase (Postgres + Auth + RLS), TypeScript, Expo build.

## Where things live
- `lib/tokens.ts` — color palette / design tokens.
- `lib/screenLayout.ts` — `useScreenTopPadding()` (`insets.top + 16`); single source of truth for top-of-screen padding on `headerShown:false` routes.
- `lib/shelves.ts` — smart-shelf filtering (`matchesSubjects`).
- `lib/customShelves.ts` — `user_shelves` / `user_shelf_books` CRUD.
- `lib/contentWarnings.ts` — content-warning matching + two-tier confidence.
- `lib/metadataProvider.ts` — canonical book metadata + cover selection.
- `lib/metadataRepair.ts` — Open Library → Google Books repair.
- `lib/openLibrary.ts` — Open Library API + author bibliography.
- `lib/recommender.ts` — recommender (contains `FORENSIC_USER_ID`).
- `lib/nextReadIntent.ts` — soft-boost / mood-boost weights for the For-You feed.
- `lib/intentMatcher.ts` — Want-to-Read intent parser (`parseIntent` / `matchBookToIntent`).
- `lib/sessionSegment.ts` — reset-aware session segmentation.
- `lib/pacing.ts` — reading pacing.
- `lib/readingWraps.ts` — monthly / yearly wrap aggregation.
- `lib/socialAuth.ts` — shared OAuth helper.
- `lib/friendshipActions.ts` — `sendFriendRequest()` (RPC wrapper) + `deleteFriendship()` (cancel / decline / unfriend).
- `lib/goodreadsExecutor.ts` — Goodreads import + dedup.
- `lib/userBookActions.ts` — `setYearGoal()` and other user_books mutations.
- `lib/saveBookFromRec.ts` — save-from-rec path (creates books row by external_id, upserts user_books).
- `lib/mltAutoaddPref.ts` — AsyncStorage pref for "more like this" auto-add.
- `lib/subjectVocabulary.ts` — curated subject vocab for LLM inference.
- `app/_layout.tsx` — root Stack (`headerShown:false`), bootstrap context, onboarding bridge.
- `app/book/[id].tsx` — book detail (rating UI, paused toggle, year-stack toggle, recommend-to-friend, rec quick-actions card).
- `app/(tabs)/index.tsx` — home (yearly progress bar, year-stack strip, streak flame).
- `app/(tabs)/library.tsx` — library w/ smart + custom shelves, Priority filter chip.
- `app/(tabs)/search.tsx` — Discover/For-You tab.
- `app/stats/index.tsx` — Reading Insights.
- `app/onboarding.tsx`, `app/onboarding-import.tsx`, `app/onboarding-questions.tsx` — onboarding flow.
- `app/legal.tsx` — Help & Legal screen (Contact support, Report a bug, Privacy policy, Terms of service, version/build footer). Placeholder URLs marked `TODO(beta-launch)`.
- `components/CoverThumb.tsx` — every cover surface (3D treatment, `flat` opt-out).
- `components/HalfStarRating.tsx` — `HalfStarRating`, `StarDisplay`, `ratingToSentiment`, `formatRating`.
- `components/RecCard.tsx` — for-you card + rationale variant pools.
- `components/RecommendationsFeed.tsx` — for-you feed + intent chips (`handleApplyIntent`).
- `components/RecommendBookSheet.tsx` — recommend-finished-to-friend sheet.
- `components/ShelfRow.tsx` / `ShelfPickerSheet.tsx` — shelf chips + add-to-shelf bottom sheet.
- `components/LibraryGalleryView.tsx` — library gallery view.
- `scripts/repairSubjectCoverage.ts`, `scripts/inferSubjectsLLM.ts`, `scripts/backfillSessionCorrections.ts`, `scripts/deduplicateBooks.ts` — maintenance scripts.
- `app.json` — Expo config (camera plugin + explicit iOS `NSCameraUsageDescription`).
- `docs/google-signin.md`, `docs/dev-testing.md`, `docs/ios-testflight-checklist.md`.

## Architecture decisions
- **Hybrid metadata:** Open Library + Google Books, three-pass subject enrichment (OL → GBooks → LLM).
- **Supabase as BaaS:** Auth + Postgres + RLS.
- **Edition awareness:** users pick a specific edition; cover + page count update, `current_page` is preserved.
- **Reset-to-0 = start over:** session segmentation in `lib/sessionSegment.ts` keeps streak / monthly-pages honest.
- **Single sage system:** all greens via `SAGE`, `SAGE_BG`, `SAGE_DEEP`, `SAGE_INK` in `lib/tokens.ts`. Never hand-roll greens.
- **Top-of-screen padding centralized:** every full-screen route applies `useScreenTopPadding()` from `lib/screenLayout.ts` so onboarding, import, and tab routes share the same top frame.
- **Cover 3D treatment:** every cover renders through `components/CoverThumb.tsx` which owns the shadow / spine / page-sheen. Pass `flat` when the parent supplies elevation or the cover is intentionally faded; never re-add per-call shadows.
- **Explicit paused state:** `user_books.paused_at` overrides the inactivity heuristic in `inferReadState`. `transitionStatus` always clears it.
- **Half-star ratings:** `user_books.rating` and `activity_events.rating` are `numeric(3,1)` constrained to `{0.5,1,…,5}`. All rating UI uses `HalfStarRating`; sentiment thresholds live in `ratingToSentiment` (≥4.5 loved / ≥3.5 liked / ≥2.5 okay / else not_for_me). Library keeps a row visible whenever `pendingFeedback?.userBookId === i.id` so the inline rating prompt can render even after the row's status changes.
- **Custom shelves alongside smart shelves:** `user_shelves` (unique by `lower(name)`) + `user_shelf_books` (CASCADE on shelf delete only — books survive). `ShelfRow` renders both kinds identically; mutations route through `lib/customShelves.ts` (handles 23505 → friendly / idempotent add).
- **For-You intent chips → hard rules + soft boosts:** `handleApplyIntent` in `RecommendationsFeed.tsx` derives `hard` filters and `exclude` rules in addition to `soft` prefs. Soft / mood boosts use `0.12` per signal capped at `±0.30` (raised from the original `0.04 / ±0.05` which was too small to actually reorder books). Mapping notes: `tone='light' | intensity='low' | mood∈{light_fun,palate_cleanser}` → `exclude.avoid_dark`; `mood='light_fun'` → `exclude.avoid_literary`; `mood='palate_cleanser'` → `hard.max_page_count=400` (intentionally NOT `standalone_only` — would empty series-heavy libraries). `tone='dark'` always wins over avoid_dark.
- **Want-to-Read intent matching:** `lib/intentMatcher.ts` parses queries like "short fantasy" into AND-combined `IntentSignal`s (subjects via `matchesSubjects`, page bounds, free-text fallback). Runs locally on every keystroke; `signalsRequireMetadata` powers an honest empty state.
- **Recommend-from-finished:** sage button in book detail Your-History card when `localStatus === 'finished'`. Reuses the existing `recommendations` table (no migration); inserts `status='sent'` + `activity_events` row. Native `Share.share` fallback always available.
- **Rec quick-actions card (saved-from-rec):** when `recCtx != null && !userBookId`, `app/book/[id].tsx` shows a sage card above "Why this book?" with Want to Read / Add to {year} stack / More like this / Not for me. Save path is `lib/saveBookFromRec.ts` (schema-tolerant retry without `year_goal_year`). Every action also fires `persistFeedback` so ranking learns. The MLT-auto-add preference (`'always' | 'ask' | null`) lives in AsyncStorage via `lib/mltAutoaddPref.ts`; first MLT tap asks once.
- **Year-goal stack (per book, per year):** `user_books.year_goal_year` is a nullable integer (check 2000–2100, partial index where not null) so the historical signal survives year rollover. Mutations: `setYearGoal()` in `lib/userBookActions.ts` (schema-tolerant: 42703/PGRST204 → friendly "migration not yet applied" error). Home strip on `app/(tabs)/index.tsx` loads via `loadYearStack(uid)` filtered to `status in ('reading','want_to_read')`. **Reading is implicit** — three places enforce this together: (1) the book-detail toggle only renders when `localStatus === 'want_to_read'`; (2) `loadYearStack` selects `or('status.eq.reading,and(status.eq.want_to_read,year_goal_year.eq.${y})')`; (3) library Priority filter (`_isPriority`) treats `status === 'reading'` as priority too. The book-detail user_books select cascades through 4 column-set fallbacks (year_goal_year + paused_at + edition_key → drop year_goal_year → drop paused_at → drop edition_key) so the screen still renders on stale Supabase projects.
- **Priority filter chip:** `app/(tabs)/library.tsx` exposes `'priority'` second (right after `All`). Finished books are intentionally retained in this view (vs. the home strip which excludes them) so the reader sees done vs. queued in one place. Routes accept `?initialFilter=priority`.
- **Recommendation rationale variants:** `RecCard.tsx` builds explanations from variant pools (4 phrasings each for aligns/appreciation/reader-trait/subject/lane-fallback/theme-tail; 3 for author-loyalty). FNV-1a hash of `book.id + pattern-tag` deterministically picks one — same card = same sentence (snapshot-stable), consecutive cards rotate. Banned phrasings (`"you gravitate toward"`, `"because you liked"`) absent from every pool. When `reasons[0]` is a trait AND `reasons[1]` is a theme, `buildExplanation` joins via `_themeTailFor`.
- **Author bibliography (OL-catalog-only, de-bundled):** `fetchAuthorBibliography` resolves the name to a canonical OL author key via `search/authors.json` then queries `search.json?author_key=…` (the old `?author=…` query was fuzzy — Lucy Foley returned 1940s/1970s books by other Foleys); a strict `author_name` normalized-equality guard runs on every doc as backstop. Falls back to `?author=` if author lookup fails. Every doc is filtered through `isBoxSet({ title })` from `lib/boxSetDetection.ts` so omnibuses / "Books N–M" / "X-Book Bundle" titles don't duplicate works already in the response. **No OL ratings** — `rating`/`ratingCount` on the type are kept null for back-compat; sort-by-rating, OL star badge, and rating-weighted hero ranking are all removed (Readstack ratings come from `user_books.rating`). Hero covers rank by recency.
- **Reading-progress motion (home):** yearly-goal bar (`progressAnim`) eases 0 → live pct on mount and on goal change; streak flame (`flameAnim`) loops a subtle scale pulse only when `streakValue > 0`. Both refs live near the top of `app/(tabs)/index.tsx` — keep timing/easing in sync if either is touched.
- **Catalog subsystem (write protection, provenance, reconciler, cross-user filtering):** moved to `docs/catalog_subsystem.md`. Covers P0/P0.5 (write-protection trigger, 14 columns) → P1.5a (provenance state machine + insert triggers) → P1.5b-1 (verification reconciler edge function + lock model + state machine) → P1.5b-1.1 (terminal-classification cleanup, deployed 2026-05-08) → P1.5b-2 (D1/D2/D4 cross-user hard-filter, shipped 2026-05-09) → P1.5b-3 (Option B-lite I3/I4/I5/I6 dedup-read filtering via `lib/findOrInsertBookByExternalId.ts`, shipped 2026-05-09) → P1.5b-3 backlog (bonus dedup sites, S1-S7 social badging, cover-upgrade RPC, gb_/gb: normalization). Read it before touching `books` writes, the verification reconciler, or any cross-user catalog surface. Companion docs: `docs/p1_5b_1_reconciler_runbook.md`, `docs/p1_5b_2_surface_audit.md`, `docs/p1_5b_3_dedup_audit.md`.
- **Content-warning taxonomy (two-tier):** `deriveContentWarningsDetailed(subjects, description?) → ContentWarning[]` with `confidence: 'specific' | 'broad'` and optional `parent`. Subject matches → specific; description-only → broad ("may include" preface). Specific sub-labels (Sexual violence, War violence, Murder, Graphic violence, Domestic abuse, Self-harm, Suicide, Addiction, Grief, PTSD, Child abuse) suppress their broad parent. DB still stores `string[]`; confidence is re-derived on read.

## Product
Discovery & recommendations (with recommender credibility), library management (status, ratings, goals, gallery view), reading progress (streaks, pace, projected finish), social (sharing, friend activity, Goodreads import), edition specificity, barcode "Will I like this?", reading insights / year wraps.

## User preferences
- **Beta-readiness Batch 1 shipped (2026-05-10):** added `app/legal.tsx`, `Help & Legal` section in `app/settings.tsx` (with `Send feedback` mailto row), and `app.json` build metadata (`ios.buildNumber: "1"`, `android.versionCode: 1`). **Placeholder URLs** live at `https://readstack.co/privacy`, `https://readstack.co/terms`, and mailbox `hello@readstack.co` — replace before public launch. Grep `TODO(beta-launch)` to find them. `NSPhotoLibraryUsageDescription` was intentionally NOT added — only declare permissions the app actually uses.

### Pre-submission backlog (must clear before App Store / Play submission)
1. Stand up live pages at `https://readstack.co/privacy` and `https://readstack.co/terms` (publicly reachable, no auth wall).
2. Confirm `hello@readstack.co` mailbox exists and is monitored (used by Help & Legal → Contact support / Report a bug, plus Settings → Send feedback).
3. Mirror the same privacy URL into App Store Connect metadata (consistency check between in-app link and store listing).
4. Bump `ios.buildNumber` (currently `"1"` in `app.json`) and `android.versionCode` (currently `1`) on every TestFlight / Play upload — Apple/Google reject duplicate build numbers.
5. *(Optional polish)* Add a "copy email to clipboard" affordance in the mailto-fallback `Alert` (`app/legal.tsx` + `app/settings.tsx` Send-feedback handler) so users without a configured mail client aren't dead-ended.

## Gotchas
- **Greens:** only `SAGE_*` tokens. No raw Tailwind greens (`#15803d`, `#16a34a`, `#166534`) or hand-rolled `#2f6f3a`.
- **Subject / content-warning matching:** word-boundary regex (`\b...\b`), never `includes()`.
- **OAuth race:** the shared helper in `lib/socialAuth.ts` is critical to prevent "invalid grant" on social sign-in.
- **Forensic gate:** `FORENSIC_USER_ID` must stay `''` in commits.
- **Edition filter:** `fetchEditions()` requires `pageCount OR publisher` (not just `year`).
- **Goodreads dedup:** title+author guard in `lib/goodreadsExecutor.ts` prevents duplicate book rows.
- **Native changes:** run `npm run build:android:dev` (or iOS equivalent), not just a JS reload.
- **Top-of-screen padding:** new full-screen routes must use `useScreenTopPadding()` — never bare `SafeAreaView` (no-op on web/Android) and never hardcoded `paddingTop: 56/60`.
- **Friend-request ingress is RPC-only:** direct INSERT on `friendships` is REVOKED. All sends route through `sendFriendRequest()` in `lib/friendshipActions.ts` → `public.send_friend_request(p_addressee_id)` SECURITY DEFINER RPC. The RPC enforces no-self, addressee-exists, canonical-pair dedup, and a per-requester pending cap of 50 (raise SQLSTATE 53400 with prefix `FRIEND_REQUEST_PENDING_CAP_EXCEEDED`). Cap enforcement is race-safe via `pg_advisory_xact_lock(hashtext(v_uid::text))` acquired before the count check (`20260510000001_p1_cap_race_fix.sql`). The INSERT is wrapped in an exception block that catches `unique_violation` and re-raises as `FRIEND_REQUEST_DUPLICATE`, so any race that bypasses the lock still surfaces a deterministic error to the client. The classifier in `lib/friendshipActions.ts` uses SQLSTATE codes (23505, 53400, 23503) as fallbacks after message-token matching for the same reason. Cancel / decline / unfriend all go through `deleteFriendship()` which is a plain DELETE — the RLS DELETE policy (`friendships: either party can delete`) was added in the same migration to make the lifecycle work (it was missing before, so the existing UI's `.delete()` calls silently no-op'd). New gotcha: never re-add a direct INSERT policy on `friendships` — it would bypass the cap.
- **`current_page` validation is fail-loud:** column-level CHECK enforces `current_page >= 0`; trigger `_user_books_validate_current_page` raises `CURRENT_PAGE_EXCEEDS_PAGE_COUNT` (SQLSTATE 23514) when `current_page > books.page_count` (only when both are known). Any new code that writes `current_page` must clamp upstream — the trigger does NOT clamp silently.
- **Catalog gotchas (Books INSERT guardrail, reconciler service-role key, attempt-count semantics, terminal classification, lock primitive, mergeFields invariant, multi-column UPDATE atomicity):** moved to `docs/catalog_subsystem.md` §7-§13. Read it before touching the reconciler edge function or any non-service-role `books` write path.
- **User-text length CHECK constraints:** `recommendations.note <= 2000`, `user_books.review_body <= 10000`, `user_books.private_note <= 5000`, `book_club_comments.body <= 2000`. Beta-safe limits; revisit on usage data. Violations are SQLSTATE 23514.
- **Metro `FallbackWatcher` ENOENT crash (dev-environment noise):** the `Start application` workflow can die seconds after serving the first bundle with `ENOENT … watch '.local/skills/.old-delegation-*'`. Cause is a race between Metro's recursive `fs.watch()` walk and the agent runtime cleaning up its own transient `.local/skills/.old-delegation-<id>` temp dirs — `metro.config.js`'s `resolver.blockList` only filters resolution, not `FallbackWatcher._watchdir`'s independent recursion. **Not** an app, catalog, reconciler, or runtime issue; bundle serves cleanly once before the crash, native dev/prod builds are unaffected. Remediation: restart the workflow (transient dirs are short-lived; the next startup usually wins the race). **P2 follow-up:** install `watchman` via Nix so Metro replaces `FallbackWatcher` (watchman handles ENOENT gracefully and is the upstream-recommended setup); touches `replit.nix` only, no app code.

## Pointers
- Supabase: https://supabase.com/docs
- Open Library: https://openlibrary.org/developers/api
- React Native: https://reactnative.dev/docs
- Expo: https://docs.expo.dev/
- TypeScript: https://www.typescriptlang.org/docs/handbook/intro.html
- Google Sign-In setup: `docs/google-signin.md`
- Device testing: `docs/dev-testing.md`
