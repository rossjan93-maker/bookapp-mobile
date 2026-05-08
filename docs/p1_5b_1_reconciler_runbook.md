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
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected)
- `GOOGLE_BOOKS_API_KEY` (optional; falls back to anonymous Google Books
  requests subject to the public 1000/day quota)

If you need to set `GOOGLE_BOOKS_API_KEY` for the Edge Function:

```bash
supabase secrets set GOOGLE_BOOKS_API_KEY=<key>
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

### 5c. Stuck advisory lock

If a reconciler invocation crashed without releasing the advisory lock,
subsequent invocations will return `skipped: already_running` indefinitely.
Connection-scoped advisory locks normally release at session end, but to
force-release:

```sql
select pg_advisory_unlock(2069037057);  -- key 0x7B5B0001
```

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
