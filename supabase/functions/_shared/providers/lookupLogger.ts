// Buffered writer for public.provider_lookup_log.
//
// The reconciler accumulates LookupOutcomes during a batch run and flushes
// them in a single INSERT at the end (or on early exit). This keeps the
// per-row overhead low and avoids one HTTP round-trip per provider lookup.

import type { LookupOutcome } from './types.ts';

type AdminClient = {
  from: (table: string) => {
    insert: (rows: Record<string, unknown>[]) => Promise<{ data: unknown; error: unknown }>;
  };
};

export interface LogRow {
  outcome: LookupOutcome;
  bookId: string;
}

export class LookupLogger {
  private rows: LogRow[] = [];
  constructor(private admin: AdminClient) {}

  add(bookId: string, outcome: LookupOutcome) {
    this.rows.push({ bookId, outcome });
  }

  /**
   * Flush buffered rows in chunks of 500 (Postgres parameter limit safety).
   * Errors are logged to console but never thrown — losing audit rows is
   * preferable to crashing the reconciler.
   */
  async flush(): Promise<void> {
    if (this.rows.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < this.rows.length; i += CHUNK) {
      const slice = this.rows.slice(i, i + CHUNK);
      const payload = slice.map(({ bookId, outcome }) => ({
        provider: outcome.provider,
        lookup_kind: outcome.lookup_kind,
        identifier: outcome.identifier,
        book_id: bookId,
        status: outcome.status,
        latency_ms: outcome.latency_ms,
        http_status: outcome.http_status,
        error_detail: outcome.error_detail,
        conflict_field: outcome.conflict_field,
      }));
      const { error } = await this.admin.from('provider_lookup_log').insert(payload);
      if (error) {
        console.error('[lookupLogger] flush failed:', (error as { message?: string }).message ?? error);
      }
    }
    this.rows = [];
  }

  size(): number {
    return this.rows.length;
  }
}
