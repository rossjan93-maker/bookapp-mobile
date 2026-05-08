# P1.5b-1 Reconciler — Operations Runbook

This document covers how to deploy, schedule, monitor, and recover the
`verify-books-batch` Edge Function and the companion
`purge_provider_lookup_log()` retention job.

It assumes P1.5b-1 migration `20260512000000_p1_5b_1_verification_reconciler.sql`
has been applied.

## 1. Deploy

```bash
# from repo root
supabase functions deploy verify-books-batch
```

The function picks up these env vars from the Supabase runtime:

- `SUPABASE_URL` (auto-injected)
- `READSTACK_SERVICE_ROLE_KEY` (preferred; operator-set via `supabase secrets
  set` — see below for why), falling back to `SUPABASE_SERVICE_ROLE_KEY`
  (auto-injected by the runtime).
- `GOOGLE_BOOKS_API_KEY` (optional; falls back to anonymous Google Books
  requests subject to the public 1000/day quota)

### Why `READSTACK_SERVICE_ROLE_KEY` and not `SUPABASE_SERVICE_ROLE_KEY`

The Supabase CLI **refuses to set secrets whose name starts with `SUPABASE_`**
— that prefix is reserved for runtime-injected values. So although the runtime
provides a `SUPABASE_SERVICE_ROLE_KEY` automatically, operators cannot
override or rotate it under that name. We resolve the key with:

```ts
Deno.env.get('READSTACK_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
```

so the operator-settable alias wins when present, and the runtime fallback
keeps the function working even if the alias hasn't been set yet (provided
both decode to `role=service_role` on the same project — they will, because
they're the same key).

If neither resolves the function returns HTTP 500
`{"ok":false,"error":"missing_service_role_key"}` rather than 401, so the
failure mode points at the deploy step instead of the request.

The function logs **boolean presence + key length** of both env vars on
module load (handy for triaging "is the secret actually set?"), and
**never** logs the value itself.

### Required secret

```bash
supabase secrets set READSTACK_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  --project-ref <project-ref>
```

Smoke-testing from the shell with `Authorization: Bearer
$SUPABASE_SERVICE_ROLE_KEY` is still correct — the local shell variable and
the Edge function's resolved key decode to the same JWT.

### Optional secret

```bash
supabase secrets set GOOGLE_BOOKS_API_KEY=<key> --project-ref <project-ref>
```

## 2. Schedule (Supabase Dashboard)

Go to **Database → Scheduled Functions** in the Supabase dashboard.

### 2a. Reconciler — hourly for week 1, then nightly

**Week 1 (drain backlog quickly):**

- Name: `verify-books-batch-hourly`
- Schedule: `0 * * * *` (every hour at minute 0)
- HTTP method: `POST`
- URL: `https://<project>.functions.supabase.co/verify-books-batch?limit=200`
- Headers:
  - `Authorization: Bearer <service-role-key>`
    (paste the actual service-role key into the Supabase dashboard's
    scheduled-trigger header field. **Never** commit it to source files,
    docs, or env templates — the dashboard stores it encrypted.)

**Week 2+ (steady state):**

- Edit the trigger above; change schedule to `0 3 * * *` (daily at 03:00 UTC).
- Reduce `?limit=200` → `?limit=500` if backlog has grown.

### 2b. Log retention — daily

- Name: `purge-provider-lookup-log-daily`
- Schedule: `15 3 * * *` (daily at 03:15 UTC, 15min after the reconciler)
- Action: SQL → `select public.purge_provider_lookup_log();`

## 3. Manual invocation

For ops investigation or one-off backfill:

```bash
curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  "https://<project>.functions.supabase.co/verify-books-batch?limit=50"
```

Response:

```json
{
  "ok": true,
  "processed": 50,
  "verified": 42,
  "failed": 8,
  "cache_hits": 14,
  "stopped_for_rate_limit": false,
  "latency_ms": 18234
}
```

If another invocation is currently running:

```json
{ "ok": true, "skipped": true, "reason": "already_running" }
```

## 4. Monitoring queries

### 4a. Verification progress

```sql
select provenance_state, count(*)
  from public.books
 group by provenance_state
 order by count desc;
```

### 4b. Books stuck in failure

```sql
select id, title, author, isbn13, external_id,
       verification_attempt_count, last_verification_attempt_at,
       last_verification_error
  from public.books
 where provenance_state in ('unverified', 'legacy')
   and verification_attempt_count >= 3
 order by verification_attempt_count desc, last_verification_attempt_at desc
 limit 50;
```

### 4c. Provider success rate (last 24h)

```sql
select provider, status, count(*),
       round(avg(latency_ms)::numeric, 1) as avg_ms
  from public.provider_lookup_log
 where occurred_at > now() - interval '24 hours'
 group by provider, status
 order by provider, count desc;
```

### 4d. Cache hit rate (last 24h)

```sql
select
  count(*) filter (where status = 'cache_hit')::float
    / nullif(count(*) filter (where status in ('cache_hit','success','not_found')), 0)
    as cache_hit_rate
  from public.provider_lookup_log
 where occurred_at > now() - interval '24 hours';
```

### 4e. Conflicts (week 1 review)

```sql
select conflict_field, count(*), array_agg(distinct provider) as providers
  from public.provider_lookup_log
 where status = 'conflict'
   and occurred_at > now() - interval '7 days'
 group by conflict_field
 order by count desc;
```

### 4f. Permanent failures

```sql
select count(*) as permanent_failures
  from public.books
 where provenance_state in ('unverified','legacy')
   and verification_attempt_count >= 5;
```

## 5. Recovery procedures

### 5a. Reset a single stuck row to retry

If a book has hit the 5-attempt cap and you've fixed the underlying issue
(e.g. corrected its ISBN, populated its external_id):

```sql
update public.books
   set verification_attempt_count = 0,
       last_verification_attempt_at = null,
       last_verification_error = null
 where id = '<uuid>';
```

The next reconciler run will pick it up.

### 5b. Reset all permanent failures (after a provider outage / fix)

```sql
update public.books
   set verification_attempt_count = 0,
       last_verification_attempt_at = null,
       last_verification_error = null
 where provenance_state in ('unverified','legacy')
   and verification_attempt_count >= 5;
```

### 5c. Stuck reconciler lock

If a reconciler invocation crashed without releasing the lock,
subsequent invocations will return `skipped: already_running` indefinitely.

To inspect the held lock (who/when):

```sql
select * from public.verify_books_batch_lock;
```

To force-release (operator-acknowledged recovery):

```sql
select public.verify_books_batch_force_release_lock();
```

The next scheduled or manual invocation will then proceed normally.

### 5d. Force-cache-bust a provider response

The reconciler caches successful provider responses for 30 days. To force
a fresh fetch for a specific external_id:

```sql
delete from public.book_enrichment_cache
 where external_id = '<external_id>';
```

## 6. Rollback

If P1.5b-1 needs to be paused (e.g. provider outage, unexpected behavior):

1. Disable both scheduled triggers in the Supabase dashboard (do not delete —
   re-enabling is one click).
2. The migration is data-additive and safe to leave in place; no rollback
   is required for client functionality. Client code is unchanged in P1.5b-1.

If P1.5b-1 needs to be fully reverted (extreme):

1. Disable the scheduled triggers as above.
2. Drop the Edge Function: `supabase functions delete verify-books-batch`.
3. The new books columns and provider_lookup_log table can remain — they
   are nullable / unused without the reconciler. Removing them requires a
   forward migration; do not do this casually.

## 7. Cadence change checklist (week 1 → week 2+)

After 7 days of hourly runs:

- [ ] Check 4a: ratio of `verified` to `legacy + unverified` should be > 70%
- [ ] Check 4d: cache hit rate should be > 30%
- [ ] Check 4c: provider success rate should be > 80% per provider
- [ ] Check 4e: review conflicts; document any systematic title/author
      disagreements
- [ ] Edit `verify-books-batch-hourly` trigger → schedule `0 3 * * *`
      (daily 03:00 UTC); rename to `verify-books-batch-nightly`
- [ ] Update `replit.md` "P1.5b-1 cadence" note

## 8. Error glossary (`books.last_verification_error`)

Error strings emitted by the reconciler, by category. Use 4b / 4f to query
distribution. Strings are ≤ 500 chars (CHECK-enforced).

### 8a. Provider outcomes (transient — retry path)
| String pattern | Meaning | Reconciler behaviour |
|---|---|---|
| `rate_limited:local_bucket_empty` | The per-process token bucket was exhausted before the call. | Counter +1, retried per backoff ladder. |
| `rate_limited:rate_limited` | Provider returned HTTP 429. | Counter +1, provider paused, retried. |
| `timeout:timeout` | The call exceeded `REQUEST_TIMEOUT_MS` (5 s). | Counter +1, retried. |
| `not_found:http_503` | Provider returned HTTP 503 (mapped to `not_found` because no fields). | Counter +1, retried. |
| `not_found:http_<NNN>` | Other non-2xx, non-404, non-429 HTTP response. | Counter +1, retried. |
| `not_found:not_found` | Provider returned HTTP 404 / empty result for ISBN search. | Counter +1, retried (real catalog gap candidate). |
| `provider_error:<detail>` | Successful HTTP but unparseable / malformed payload. | Counter +1, retried. |

### 8b. Terminal classifications (P1.5b-1.1 — counter set to MAX_ATTEMPTS, no retry)
These rows have **no actionable verification path** and are removed from
the eligible-rows query by the `verification_attempt_count < MAX_ATTEMPTS`
predicate. Provenance_state is intentionally **left unchanged** (typically
remains `'legacy'`); F5 will decide whether to migrate them to a different
state for surface filtering.

| String | Meaning | Example |
|---|---|---|
| `placeholder_manual_entry` | external_id matches `^/works/other_<slug>$` — Readstack-internal scratch row, never resolvable against any provider. | `/works/other_movq1ntf` |
| `unsupported_external_id_scheme` | external_id is non-empty and non-blank but doesn't match any scheme the resolver dispatches on (OL works key, GB volume id, onboarding_isbn) **and** the row has no ISBN to fall back on. | `goodreads:53146871` (no ISBN columns set) |
| `missing_supported_identifier` | external_id is NULL/empty **and** isbn / isbn13 are both NULL/empty. Nothing to dispatch on. | NULL external_id, both ISBN columns NULL |

**Operational note:** the introduction of these strings means
`verification_attempt_count = MAX_ATTEMPTS` no longer implies "provider
failure after 5 attempts". Distinguish the two cases via
`last_verification_error`:
- terminal classification → one of the three strings above (no provider
  call was made; check `provider_lookup_log` — there will be no rows for
  that book_id from the run that wrote the terminal string)
- exhausted-retry failure → a Provider-outcomes string from §8a (provider
  log will contain ≥ 1 row from the corresponding attempt windows)

### 8c. Defensive / should-never-happen
| String | Meaning | Action |
|---|---|---|
| `tries_built_but_none_executed` | A row produced ≥ 1 entry in the resolver's `tries[]` array but the loop didn't run any of them (likely a rate-limit break before the first iteration). | Investigate `provider_lookup_log` and rate-limiter state at the timestamp; previously this was the catch-all `no_attempts_made` string from pre-P1.5b-1.1. |
