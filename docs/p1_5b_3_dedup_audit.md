# P1.5b-3 — Cross-user dedup-read normalization (Option B-lite)

**Status:** shipped 2026-05-09
**Scope:** I3, I4, I5, I6 only (Option B-lite). Bonus sites (RecommendationsFeed, RecEntryScreen, search.tsx, recSnapshot) deferred to a follow-up batch.
**Touches:** 4 runtime files (1 new helper, 3 patched call sites), ~95 lines runtime diff, **no schema, no Supabase, no migrations, no D1/D2/D4 changes.**

---

## §1 — What problem this fixes

`docs/p1_5b_2_surface_audit.md` Phase A inventoried the cross-user catalog read sites. Sites I3–I6 (own-library + dedup/ingest paths in add-book / scan / save-from-rec) were classified as missing the I1 (Goodreads) protection that scopes reads to `verified | own_inserts`.

The blocker for adopting the I1 pattern verbatim (documented in §C.5 of the surface audit): `books.external_id` is **UNIQUE**. The I1 dedups on title+author (no UNIQUE), so "skip the row + insert your own" is safe. For I3–I6 it would deterministically hit SQLSTATE **23505** any time a previous user inserted an unverified row for the same external_id.

P1.5b-3 ships **Option B-lite** — apply the filter at I3/I5/I6 dedup-reads, then on a 23505 collision do an unfiltered re-read by `external_id` and adopt that row. I4 is filter-only (no insert at that flow point).

## §2 — Decision matrix per site

| Site | Path | Reachable insert? | Treatment | Helper used |
|---|---|---|---|---|
| I3 | `app/add-book.tsx:410-452` (handleSave) | Yes (line 421-425 in pre-patch) → wraps to helper | Filter + 23505 fallback | `findOrInsertBookByExternalId` |
| I4 | `app/add-book.tsx:295-300` (existing-library probe `useEffect`) | **No** | Filter only | none — inline `.or(...)` |
| I5 | `app/scan.tsx:259-285` (barcode IIFE) | Yes (fire-and-forget) | Filter + 23505 fallback; non-23505 errors stay silent (parity with prior behavior) | `findOrInsertBookByExternalId` |
| I6 | `lib/saveBookFromRec.ts:32-54` | Yes (returns `{error}` to caller) | Filter + 23505 fallback | `findOrInsertBookByExternalId` |

## §3 — The helper

`lib/findOrInsertBookByExternalId.ts` (~110 lines). Three branches:

1. **filtered_hit** — `select … .eq('external_id', x).or('provenance_state.eq.verified,provenance_inserted_by.eq.${userId}')` returns a row → return it.
2. **insert** — read miss → `insert(payload).select(cols).single()` → return the new row.
3. **unfiltered_fallback** — insert returns SQLSTATE `23505` → unfiltered `select … .eq('external_id', x).maybeSingle()` → return that row + emit one structured `console.warn`.

`console.warn` payload (no PII; no title/author/user-visible text):

```js
console.warn('[catalog]', {
  event:             'cross_user_dedup_fallback',
  call_site:         '<file#fn>',
  external_id:       '<provider key>',
  error_code:        '23505',
  recovered_book_id: '<uuid>',
});
```

Persistent telemetry (`catalog_event_log` or RPC-backed surface) is intentionally **not** added in this batch — `provider_lookup_log` is service-role-only and must not be loosened from client paths. Future P2 follow-up if console-warn volume warrants persisting.

## §4 — I4 graceful-degradation edge case

I4 is the existing-library probe. Filter-only is safe because there is no insert at this flow point. Narrow edge case (documented in code comment at the call site):

> If user B inserted an unverified `books` row and user A also has a `user_books` row pointing at it (e.g. via save-from-rec earlier), the filter hides that row at I4 → the "already in library" UX hint won't render. Save path (`handleSave` → I3) recovers via the helper's 23505 fallback + `user_books.upsert(onConflict='user_id,book_id')`, so no data loss — only a missing UX hint in that narrow window.

## §5 — Behavioral semantics preserved

| Site | Pre-patch error UX | Post-patch error UX |
|---|---|---|
| I3 | Toast: "Could not save book. Please try again." (set `doneIsError`) | Same — preserved |
| I4 | Sets `existingLibraryEntry = null` on miss | Same — filter just changes which rows count as misses (see §4) |
| I5 | Insert error silently swallowed in fire-and-forget IIFE | Same — non-23505 errors silently swallowed; 23505 recovers + warns |
| I6 | Returns `{error: createErr.message}` to caller | Same — helper's `{error}` is mapped 1:1 to caller's return shape |

I3's fill-empty cover_url/page_count update branch is preserved and now runs on `via !== 'insert'` (so it triggers on filtered_hit AND unfiltered_fallback, never on a fresh insert where we already wrote both).

## §6 — Verification

- **TypeScript:** patched files (`lib/findOrInsertBookByExternalId.ts`, `lib/saveBookFromRec.ts`, `app/add-book.tsx`, `app/scan.tsx`) all clean. Repository total error count went from 183 (baseline pre-patch) to 179 (post-patch); no errors introduced in touched files.
- **Regression harness:** `/tmp/p1_5b_3_verify.mjs` — 18 assertions across 6 scenarios (filtered_hit, insert, fallback_23505, fatal non-23505, 23505 + lost-race, filter-expression contract). Inline TS transpile so the actual helper source is exercised, no recompile drift. All passing.
- **Live DB E2E** (cross-user 23505 fallback under real Postgres): not run in this batch — requires SUPABASE_URL + two anon JWTs which aren't in the agent env. Captured as a P2 follow-up. Steady-state mitigation: the verification reconciler drains unverified rows hourly, so the 23505-collision window is naturally short.

## §7 — What's intentionally out of scope

- Bonus dedup sites: `components/RecommendationsFeed.tsx:495`, `components/RecEntryScreen.tsx:245-248`, `app/(tabs)/search.tsx:1286`, `lib/recSnapshot.ts:62` — same pattern, deferred to the next batch by your direction.
- D1 / D2 / D4 cross-user hard-filter — stays strict (those are P1.5b-2's territory).
- Reconciler edge function, schema, migrations, `provider_lookup_log` — untouched.
- `gb_` / `gb:` prefix normalization — stays in the catalog backlog.
- Social badging, manual-entry table split, cover-upgrade RPC — stay in the catalog backlog.

## §8 — Trigger for revisiting

Per `docs/p1_5b_2_surface_audit.md` §C.5, original Option-A trigger was: any user-reported "the cover/page count for the book I just added is wrong" OR observed bursts of `metadataRepair.ts` writes from save-from-rec/scan paths. Option B-lite mostly resolves the read-side; the residual risk is the unfiltered_fallback path adopting an unverified row. Telemetry: search for `cross_user_dedup_fallback` in console output. If it fires often, escalate to persistent telemetry (P2).
