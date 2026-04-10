/**
 * scripts/check_series_covers.ts
 *
 * Audits the series catalog for books missing olCoverId.
 * Books without an olCoverId render the text-fallback slot in the series strip
 * instead of the cover image.
 *
 * Run with:  npx tsx scripts/check_series_covers.ts
 * Exit code: 0 = all good, 1 = entries missing
 *
 * To look up a missing ID, run the OL search used during the original backfill:
 *   node -e "fetch('https://openlibrary.org/search.json?title=TITLE&author=AUTHOR&fields=key,title,cover_i&limit=5').then(r=>r.json()).then(d=>console.log(d.docs))"
 * Then add  olCoverId: <number>  to the matching orderedBooks entry.
 */

import { getAllSeriesCatalog } from '../lib/seriesCatalog';

const catalog = getAllSeriesCatalog();

type MissingEntry = { series: string; title: string; author: string };
const missing: MissingEntry[] = [];

for (const [seriesName, entry] of Object.entries(catalog)) {
  for (const book of entry.orderedBooks) {
    if (book.olCoverId == null) {
      missing.push({ series: seriesName, title: book.title, author: book.author });
    }
  }
}

const total = Object.values(catalog).reduce((n, e) => n + e.orderedBooks.length, 0);

if (missing.length === 0) {
  console.log(`✓  All ${total} catalog entries have olCoverId — series strips will render correctly.`);
  process.exit(0);
}

console.error(
  `✗  ${missing.length}/${total} book${missing.length !== 1 ? 's' : ''} missing olCoverId` +
  ` — series strip will show text fallback for these slots:\n`,
);
for (const m of missing) {
  console.error(`  [${m.series}] "${m.title}" — ${m.author}`);
}
console.error(
  `\nTo resolve: look up the OL cover_i for each book and add  olCoverId: <number>` +
  `  to the orderedBooks entry in lib/seriesCatalog.ts.\n` +
  `See the script header for the OL search one-liner.`,
);
process.exit(1);
