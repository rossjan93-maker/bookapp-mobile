# P1.5b-2 — Cross-User Surface Filtering: Audit Package

Read-only audit of every read path that surfaces rows from the `books`
table, classified by whether the surface is cross-user, what fields are
exposed, and what risk class it falls into.

**Audit timestamp:** 2026-05-08 (post-P1.5b-1.1 deploy)
**Catalog steady state at audit:** `verified=293, legacy=18, unverified=0`
of which 16 are terminal/permanent and 2 are real catalog gaps.

**No code was changed during this audit. No production writes were made.**

---

## Provisional UX assumptions used during classification (NOT yet implemented)

1. **Own-library carve-out:** users always see their own books, regardless of provenance.
2. **Broad cross-user discovery:** public surfaces (search, discover, recommendations, author pages, browse) should prefer `provenance_state = 'verified' OR books.id IN (caller's user_books)`.
3. **Friend/social carve-out:** friend activity / direct recommendations may need a different rule because the friend's library activity is part of the social object — classify separately.
4. **Terminal rows** (`unsupported_external_id_scheme`, `placeholder_manual_entry`) are higher-risk for broad cross-user surfacing than retryable legacy rows.
5. **Hard-filter vs soft-deprioritize is NOT yet decided.** This audit identifies WHERE each choice would apply.

Risk classes used below:
- **P0** — cross-user, freely-rendered (no user gating). Highest leakage.
- **P1** — cross-user, gated by user action (search, scan, dedup-read).
- **P2** — own-library only or no leakage.
- **dedup-read** — query touches cross-user rows but result is own-library; the risk is row absorption, not visual surfacing.
- **social-identity** — cross-user, but the row IS the social object; filtering it out erases the friend's activity.
- **incidental** — cross-user, but the row is just a thumbnail/lookup; safe to filter.

---

## 1. Broad cross-user discovery surfaces

| # | Surface | File + line | Query shape | Cross-user? | Provenance filter? | Fields exposed | Risk | Terminal possible? |
|---|---|---|---|---|---|---|---|---|
| D1 | Discover / For-You feed (primary) | `lib/recommender.ts:838-842` | `books.select(...).not('id','in',(...)).limit(600)` | yes | **none** | id, title, author, cover_url, external_id, subjects, page_count, description, isbn | **P0** | **yes** |
| D2 | Discover / For-You feed (fallback) | `lib/recommender.ts:2587-2592` | `books.select(...).not('id','in',(...)).or(...).limit(2000)` | yes | **none** | same as D1 | **P0** | **yes** |
| D3 | Search "send to friend" lookup | `app/(tabs)/search.tsx:1283-1287` | `books.select('id,cover_url,page_count').eq('external_id', extId)` | yes | **none** | id, cover_url, page_count | P1 | **yes** |
| D4 | Book club book search (admin) | `app/club/[id].tsx:162-165` | `books.select(...).ilike('title', q).limit(10)` | yes | **none** | id, title, author, cover_url, external_id, page_count | **P0** | **yes** |
| D5 | Barcode scan dedup probe | `app/scan.tsx:259-262` | `books.select('id').eq('external_id', extId)` | yes | none | id only | P1 (dedup-read) | n/a (id only) |
| D6 | Metadata-repair batch (anon) | `lib/metadataRepair.ts:88-92` | `books.select(...).in('id', ids).or('cover_url.is.null,...')` | yes | none | title, author, cover_url, description, subjects, page_count | P1 | yes |
| D7 | Subject-repair batch (service-role) | `lib/subjectRepair.ts:195-199` | `books.select(...).is('subjects', null).order('id').limit(batch)` | yes | none | title, author, subjects, isbn, isbn13 | P1 (write path, gated by service-role guard) | yes |
| D8 | Goodreads import dedup | `lib/goodreadsExecutor.ts:176-184` | `books.select('id,title,author').or(...)` | yes | **`provenance_state IN ('verified','legacy') OR provenance_inserted_by = userId`** | id, title, author | P1 (dedup-read, **already protected**) | no — terminals are filtered out unless caller-owned |
| D9 | Dev/admin inspector | `lib/devInspector.ts:43-46` | `books.select(...).order('title')` | yes | none | title, author, cover_url, description | P0 (dev-only) | yes |

**Anomalies (D)**:
- **D1+D2 are the headline leak.** The For-You / Discover engine pulls the entire global `books` table with no provenance gate. Any of the 16 terminal rows (or any future unverified row) is a recommendation candidate. This is the single biggest item in P1.5b-2.
- **D4 (book club search → admin promotion) is the second-biggest concern.** A club admin can `ilike` the global catalog and promote a legacy/duplicate/terminal row as the active book for an entire club. Pre-existing risk, not introduced by P1.5b-1.
- **D8 already has the right shape** — it's the model the other dedup-reads should follow.

---

## 2. Social / friend surfaces

| # | Surface | File + line | Query shape | Cross-user? | Provenance filter? | Fields exposed | Risk | Terminal possible? |
|---|---|---|---|---|---|---|---|---|
| S1 | Friend activity feed (home) | `app/(tabs)/index.tsx:~1600-1630` | `activity_events.select(..., book:books(...), actor:profiles(...)).eq('actor_id', friend_ids)` | yes | **none** | title, author, cover_url, external_id, rating, actor.username | **social-identity** | **yes** |
| S2 | Friend profile activity | `app/friend/[id].tsx:144-150` | `activity_events.select(..., book:books(title, author), recommendation:recommendations(...)).eq('actor_id', friendId)` | yes | none | title, author, event_type, created_at | social-identity | yes |
| S3 | Direct rec inbox | `components/RecsInboxSheet.tsx:173-179` | `recommendations.select(..., book:books(title,author,cover_url,external_id), sender:profiles(...)).eq('to_user_id', uid)` | yes | none | title, author, cover_url, note, sender.username | social-identity | yes |
| S4 | Recommend-to-friend "already-recommended" check | `components/RecommendBookSheet.tsx:89-102` | `recommendations.select(to_user_id).eq('from_user_id', uid).eq('book_id', bookId)` | no (own sent) | none | to_user_id only | incidental | n/a |
| S5 | Book club active book | `app/club/[id].tsx:477-485` | `book_club_books.select(..., book:books(title,author,cover_url,external_id)).eq('club_id',cid).eq('status','active')` | yes | none | title, author, cover_url, external_id, total_pages, target_finish_date | social-identity (via D4 promotion path) | **yes** |
| S6 | Sent-recs log (own profile) | `app/(tabs)/profile.tsx:220-229` | `recommendations.select(..., book:books(title,author,cover_url,external_id), to_user:profiles(...)).eq('from_user_id', uid)` | yes (recipient view) | none | title, author, cover_url, status, recipient.username | social-identity | yes |

**Special-question answers**:
- **Manual `goodreads:NNN` row → friend's activity feed?** **Yes.** S1's join to `books` is unfiltered; the manual row's metadata renders in friend B's feed verbatim.
- **Recommend-to-friend with manual/legacy book?** **Yes.** A's `book_id` is passed as-is; B sees A's exact row, not a canonical lookup.

**Anomalies (S)**:
- **All social surfaces are social-identity, not incidental.** Hard-filtering them would erase real friend activity — bad UX. The likely intervention is per-row badging ("unverified") rather than removal, OR canonicalization at activity-write time (a separate P1.5b-3 question).
- **S5 + D4 are linked.** Anything an admin can promote via D4 becomes a club-wide social-identity surface in S5. Fixing D4 (admin-side filter) is upstream of S5.
- **Field-exposure inconsistency:** S1 exposes `external_id` + `cover_url`; S2 exposes only `title` + `author`. Out of scope for P1.5b-2 but worth flagging.

---

## 3. Own-library + dedup/ingest surfaces

| # | Surface | File + line | Query shape | Cross-user? | Provenance filter? | Fields exposed | Risk | Terminal possible? |
|---|---|---|---|---|---|---|---|---|
| L1 | Library tab (list + gallery) | `app/(tabs)/library.tsx:384-390, 451-458` | `user_books.select('..., book:books(...)')` | no (RLS-isolated) | none (implicit own) | title, author, cover_url, external_id, page_count, subjects | P2 | own only |
| L2 | Home hero / year stack | `app/(tabs)/index.tsx` | `user_books.select('..., book:books(...)')` | no | none (implicit own) | title, author, cover_url, external_id, page_count | P2 | own only |
| L3 | Reading insights | `app/stats/index.tsx:448-451` | `user_books.select('..., book:books(...)')` | no | none (implicit own) | title, author, page_count | P2 | own only |
| L4 | Book detail (own library) | `app/book/[id].tsx:515-520` | `user_books.select('..., book:books(...)')` | no | none (implicit own) | title, author, cover_url, external_id, page_count | P2 | own only |
| L5 | Book detail "is this book in catalog?" probe | `app/book/[id].tsx:665-667` | `books.select('id, external_id').eq('id', id)` | depends (id-resolved) | none | id, external_id | P2 | n/a |
| I1 | Goodreads import dedup | `lib/goodreadsExecutor.ts:176-184` | `books.select('id,title,author').or('provenance_state.in.(verified,legacy),provenance_inserted_by.eq.{userId}')` | yes | **`verified | legacy | own_inserts`** ✅ | id, title, author | dedup-read (**protected**) | no |
| I2 | Goodreads source-link dedup | `lib/goodreadsExecutor.ts:160-164` | `book_source_links.select(...).in('source_book_id', ...)` | yes | none (id-mapping only) | n/a | dedup-read | n/a |
| I3 | Add-book ISBN dedup | `app/add-book.tsx:399-403` | `books.select('id,cover_url,page_count').eq('external_id', extId)` | yes | **none** ⚠️ | id, cover_url, page_count | dedup-read | **yes** |
| I4 | Add-book "already in library?" probe | `app/add-book.tsx:284-288` | `books.select('id').eq('external_id', extId)` | yes | **none** ⚠️ | id only | dedup-read | n/a (id only) |
| I5 | Barcode scan dedup | `app/scan.tsx:259-263` | `books.select('id').eq('external_id', extId)` | yes | **none** ⚠️ | id only | dedup-read | n/a (id only) |
| I6 | Save-from-rec dedup | `lib/saveBookFromRec.ts:29-33` | `books.select('id').eq('external_id', extId)` | yes | **none** ⚠️ | id only | dedup-read | n/a (id only) |

**Upsert paths (write — listed for completeness, gated by triggers)**:
- `lib/goodreadsExecutor.ts:275-278` — `book_source_links` upsert, `(source, source_book_id)` conflict (gated by `_book_source_links_protect_identity`).
- `lib/saveBookFromRec.ts:65-71` — `user_books` upsert, `(user_id, book_id)` conflict.
- `app/scan.tsx:286-290` — `user_books` upsert, `(user_id, book_id)` conflict.

**Anomalies (L/I)**:
- **I3, I4, I5, I6 all skip the I1 protection.** When a user adds-by-ISBN, scans a barcode, or saves-from-rec, the dedup probe matches by `external_id` against the entire global catalog — including terminal/legacy rows. The user then ends up with a `user_books` row pointing at someone else's possibly-bad metadata. Lower-leakage than D1/D2 (the user explicitly initiated the action and the row will get fill-empty-repaired by `metadataRepair.ts` on next surface) but worth normalizing for consistency with I1.
- **L1–L4 are clean.** Own-library is RLS-isolated; provenance filter would actively HURT (we want users to see their own legacy/manual rows).
- **I1 is the established model.** Any fix in I3–I6 should adopt the same `or('provenance_state.in.(verified,legacy),provenance_inserted_by.eq.{userId}')` shape.

---

## Cross-cutting summary

### P0 — fix-first (cross-user, freely rendered)
- **D1, D2** — For-You / Discover feed. Single biggest leakage surface. ~330 verified vs. 18 legacy means filtering is cheap (loses ~5% candidate pool, gains correctness).
- **D4** — Book club search (admin). Fix is upstream of S5.
- **D9** — Dev inspector. Dev-only, low priority.

### P1 — fix-second (cross-user, user-gated)
- **D3** — search→send-to-friend lookup.
- **D6, D7** — repair batches (write paths, partial mitigation already via service-role).
- **I3, I4, I5, I6** — dedup-read paths missing the I1 protection. Normalize to I1's pattern.

### P2 — own-library (no fix needed)
- L1, L2, L3, L4, L5, S4 — confirmed safe.

### Social-identity (separate decision required)
- **S1, S2, S3, S5, S6** — cannot hard-filter without erasing friend activity. The right intervention is likely **per-row badging** ("unverified" tag in UI) and/or **canonicalization at activity-write time** (rewrite `book_id` to canonical row when the manual row gets matched to a verified one). Both are P1.5b-3 design questions, not P1.5b-2 implementation.

### Open architectural question (F5)
The 16 terminals stay `provenance_state='legacy'` per the P1.5b-1.1 contract. Should they migrate to a new `'manual'` state (or stay `'legacy'`) so that:
- The cross-user filter `provenance_state = 'verified'` excludes them automatically (today: must also check `last_verification_error`).
- Manual entries are explicitly distinct from "legacy from grandfathering" entries.

This decision is upstream of every P1.5b-2 filter — answer first, then the filter expression simplifies.

---

## Phase B — data audit

All numbers from live service-role read-only queries via
`/tmp/p1_5b_2_data_audit.mjs`. **No writes performed.** Run timestamp:
2026-05-08 (immediately post-P1.5b-1.1 deploy, same session).

### B.1 — Provenance distribution

| state | count | % |
|---|---|---|
| verified | 293 | 94.21 |
| legacy | 18 | 5.79 |
| unverified | 0 | 0.00 |
| **TOTAL** | **311** | 100 |

Matches the post-deploy steady state reported by the user. No drift.

### B.2 — Terminal classification breakdown

| `last_verification_error` | count |
|---|---|
| `placeholder_manual_entry` | 2 |
| `unsupported_external_id_scheme` | 14 |
| `missing_supported_identifier` | 0 |
| `tries_built_but_none_executed` (defensive) | 0 |
| legacy + still retryable (count<5) | 2 |

`16 terminal + 2 retryable = 18 legacy` — exact reconciliation.

### B.3 — Discover/For-You leakage estimate

Sampled the full books table (n=311). Bucket distribution:

| bucket | count | % |
|---|---|---|
| verified | 293 | 94.21 |
| legacy_retryable | 2 | 0.64 |
| legacy_terminal | 16 | 5.14 |
| unverified | 0 | 0.00 |

**A hard `provenance_state='verified'` filter on D1/D2 would drop 5.79% of the candidate pool.** That's small enough that the Discover ranker won't notice the loss, AND the ranker can't easily compensate for the bad metadata of the rows being filtered (terminals have nothing for it to rank on). Verdict: hard-filter on D1/D2 is likely the right call from a data perspective; final UX decision is yours.

### B.4 — Terminals appearing in cross-user surfaces today

| Surface | Terminal references |
|---|---|
| `activity_events.book_id IN (terminals)` | **0 rows** |
| `recommendations.book_id IN (terminals)` | **0 rows** |
| `user_books.book_id IN (terminals)` | 14 user_books rows across **1 distinct user** |
| Terminals shared across >1 user (cross-user leak today) | **0** |

**This is the most important finding in Phase B.** All 16 terminals are
currently owned by exactly 1 user (presumably the dev/test account) and
none are referenced by any social-identity surface (S1/S3/S6) yet. So:
- **No actual cross-user social-identity damage exists today.** The
  social-identity question (S1, S2, S3, S5, S6) is hypothetical, not
  observed. We can defer the per-row-badging decision until we see real
  cross-user friend activity reference a terminal.
- **Every leakage path through D1/D2 today returns terminals from the
  catalog but NOT through anyone's friend feed.** The fix is purely
  about ranker hygiene, not social UX.

This materially de-risks P1.5b-2 implementation: we can ship D1/D2
filters without immediately needing the per-row-badging UX work for
S1–S6.

### B.5 — `provenance_inserted_by` distribution

| | count |
|---|---|
| `provenance_inserted_by IS NULL` | **311** |
| `provenance_inserted_by IS NOT NULL` | **0** |

**All 311 rows have NULL `provenance_inserted_by`.** This means either:
(a) every row was grandfathered (P1.5a backfilled them all to `'legacy'`
with NULL inserted_by) and **no user-attributed insert has occurred
since the trigger went live**, OR
(b) the `trg_books_set_provenance` trigger isn't firing as expected on
user-JWT inserts.

**Action item for P1.5b-2:** verify (a) vs (b) before shipping any
filter that uses `provenance_inserted_by` as a fallback (e.g. the I1
pattern). If (b), the I1 protection is effectively `IN ('verified',
'legacy')` only, with the `OR provenance_inserted_by = userId` branch
being a no-op — meaning a user CAN'T see their own un-grandfathered
manual entries via the dedup path. Quick verification: insert a single
test row from a non-service-role JWT and confirm `provenance_inserted_by`
is populated. If (a), the fact that no user-attributed inserts exist yet
means we have very low real-world data on the manual-entry path —
something to keep in mind when prioritizing.

### B.6 — Cover-upgrade 403 frequency (P1.5b-3 sizing)

| event | count (7d) |
|---|---|
| `provider_lookup_log` cover_url conflict | **0** |
| `provider_lookup_log` any conflict | **0** |

The cover-upgrade RPC is **not** a hot issue today. Either no upgrade
was attempted in the last 7 days OR the upgrade path completes without
hitting the conflict branch. P1.5b-3 priority on cover-upgrade can drop
unless we see this number rise.

---

## Phase B → C bridge: what the data tells us

1. **P0 D1/D2 fix is uncontroversial.** 5.79% candidate-pool loss, no observed cross-user social damage, terminals have no useful ranker signal. Hard-filter is safe.
2. **Social-identity surfaces (S1–S6) can wait.** Zero terminals in activity_events/recommendations today. Per-row badging decision deferred to P1.5b-3 unless real cross-user activity emerges.
3. **F5 decision (terminal → `'manual'` state) is still upstream.** If we move terminals to a new state, the D1/D2 filter simplifies from `provenance_state='verified' AND last_verification_error NOT IN (terminal3)` to just `provenance_state='verified'`. Recommend deciding F5 BEFORE writing the D1/D2 filter.
4. **Verify the `provenance_inserted_by` trigger.** B.5's all-NULL result needs (a)/(b) confirmation before any I3–I6 fix that adopts the I1 pattern.
5. **D4 (book club admin search) is the second-priority fix.** Promotes any title-matched row to club-wide active book — same UX risk as D1/D2 but funnel-gated by admin action.

## Phase C — UX decision brief (next, awaiting your input)

The audit data above narrows the open UX questions to:

**Q1 (F5):** Do terminal rows migrate from `provenance_state='legacy'` to a new `'manual'` state, or stay `'legacy'`?
- **Pro `'manual'`:** D1/D2 filter simplifies to one column; terminal vs grandfathered legacy becomes structurally distinct.
- **Pro stay `'legacy'`:** zero migration risk; the `last_verification_error` column already distinguishes them.
- **Recommend:** stay `'legacy'`. The migration buys clarity but adds risk; the `last_verification_error` predicate is already the canonical disambiguator and is documented in §8b of the runbook.

**Q2 (D1/D2 filter shape):** hard-filter or soft-deprioritize?
- **Hard-filter** (`WHERE provenance_state='verified'`): cleanest, costs 5.79% candidate pool today.
- **Soft-deprioritize** (rank multiplier ×0.5 for non-verified): preserves diversity, harder to reason about.
- **Recommend:** hard-filter. Terminals have no useful ranker signal; soft path is over-engineering.

**Q3 (D4 fix):** apply the same hard-filter to admin book club search?
- **Recommend:** yes — admin promotion is high-leverage; one bad row becomes club-wide.

**Q4 (S1–S6):** badge unverified rows in social feeds, or do nothing today?
- B.4 shows zero terminals in social surfaces today. **Recommend:** do nothing for P1.5b-2; revisit when telemetry shows cross-user friend activity referencing a terminal.

**Q5 (I3/I4/I5/I6 normalization):** adopt the I1 pattern in add-book/scan/save-from-rec?
- These are dedup-reads (id-only), not visual surfaces. The risk is row absorption.
- **Recommend:** yes, but pair with the B.5 (a)/(b) verification — if `provenance_inserted_by` isn't being populated, the I1 pattern is incomplete.

Once Q1–Q5 are answered, P1.5b-2 implementation scope crystallizes to roughly:
- 1 SQL migration (only if Q1 = `'manual'` state)
- 4–5 query patches (D1, D2, D4, plus I3/I4/I5/I6 if Q5 = yes)
- 1 trigger verification check (B.5 a/b)
- 1 regression-test harness covering each filter

