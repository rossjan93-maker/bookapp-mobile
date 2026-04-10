// =============================================================================
// Quota Monitor — durable Google Books API call accounting
// =============================================================================
//
// Problem: Google Books allows 1,000 queries/day on the anonymous tier (or per
// project key).  The in-memory providerHealth counters reset on every app
// restart, so there is no visibility into daily call volume across sessions.
//
// Solution: AsyncStorage-backed daily counter (one integer per calendar day).
// Very lean — a single JSON record with { date, calls }.  Resets automatically
// when the calendar date advances; no migration, no server, no schema change.
//
// Soft warning threshold: 80 % of the daily limit (800 calls).
// Hard warning: at exactly the limit value (900 — we leave 100 headroom).
//
// Usage (in metadataRepair, googleBooks, wherever a GB request fires):
//   await recordGbCall();
//
// Usage (in dev inspector or health summary):
//   const snap = await getGbQuotaSnapshot();
//   await logQuotaSnapshot();
//
// =============================================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY   = 'readstack:quota:gb_daily';
const DAILY_LIMIT   = 900;    // 1 000 API quota - 100 headroom
const WARN_SOFT_PCT = 0.8;    // console.warn at 80 %

// ── Internal helpers ─────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

type DailyRecord = { date: string; calls: number };

async function loadRecord(): Promise<DailyRecord> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { date: todayISO(), calls: 0 };
    const record = JSON.parse(raw) as DailyRecord;
    if (record.date !== todayISO()) return { date: todayISO(), calls: 0 };
    return record;
  } catch {
    return { date: todayISO(), calls: 0 };
  }
}

async function saveRecord(record: DailyRecord): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // write failure is non-fatal — counter is best-effort
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Increments the daily Google Books call counter by 1.
 * Logs a warning at the soft threshold and at the hard limit.
 * Call this immediately before (or after) every GB API request fires.
 */
export async function recordGbCall(): Promise<void> {
  const record = await loadRecord();
  record.calls += 1;
  await saveRecord(record);

  if (record.calls === DAILY_LIMIT) {
    console.warn(
      `[QUOTA] google_books daily calls reached ${record.calls}` +
      ` — at configured limit (${DAILY_LIMIT}). Consider pausing enrichment.`,
    );
  } else if (record.calls === Math.floor(DAILY_LIMIT * WARN_SOFT_PCT)) {
    console.warn(
      `[QUOTA] google_books daily calls at ${record.calls}/${DAILY_LIMIT}` +
      ` (${Math.round(WARN_SOFT_PCT * 100)}% of limit).`,
    );
  }
}

export type GbQuotaSnapshot = {
  date:         string;
  calls:        number;
  limit:        number;
  pct:          number;    // 0–100
  nearingLimit: boolean;   // true when >= 80 %
  atLimit:      boolean;   // true when >= limit
};

/** Returns a snapshot of today's quota usage without incrementing the counter. */
export async function getGbQuotaSnapshot(): Promise<GbQuotaSnapshot> {
  const record = await loadRecord();
  const pct    = Math.round((record.calls / DAILY_LIMIT) * 100);
  return {
    date:         record.date,
    calls:        record.calls,
    limit:        DAILY_LIMIT,
    pct,
    nearingLimit: record.calls >= DAILY_LIMIT * WARN_SOFT_PCT,
    atLimit:      record.calls >= DAILY_LIMIT,
  };
}

/**
 * Logs a one-line quota summary prefixed with [QUOTA].
 * Call alongside logProviderHealthSummary() after a repair batch.
 */
export async function logQuotaSnapshot(): Promise<void> {
  const snap = await getGbQuotaSnapshot();
  const flag  = snap.atLimit ? ' ⚠ AT LIMIT' : snap.nearingLimit ? ' ⚠ NEARING LIMIT' : '';
  console.log(
    `[QUOTA] google_books — date=${snap.date}` +
    ` calls=${snap.calls}/${snap.limit} (${snap.pct}%)${flag}`,
  );
}
