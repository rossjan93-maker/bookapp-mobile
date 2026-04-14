(global as any).__DEV__ = false;
// =============================================================================
// scripts/deduplicateBooks.ts
// =============================================================================
// Detects duplicate book rows, selects a canonical row per cluster, migrates
// all dependent records (user_books, reading_sessions) to the canonical row,
// patches the canonical row with the best available metadata, and deletes the
// redundant rows.
//
// Usage:
//   npx tsx scripts/deduplicateBooks.ts [flags]
//
// Flags:
//   --dry-run        Print what would happen; make no writes (default: false)
//   --verbose        Print detailed per-field merge decisions
//
// Safety properties:
//   - Dry-run always runs first in the output (shows full plan before any write)
//   - No book row is deleted until all dependent rows have been migrated
//   - Same-user user_book conflicts are resolved by merging data, not data loss
//   - reading_sessions rows are re-pointed to both the new book_id and the
//     surviving user_book_id
//   - Script exits non-zero on any unexpected DB error
// =============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const LOG = '[DEDUP]';

// ── Types ─────────────────────────────────────────────────────────────────────

type Book = {
  id: string;
  title: string;
  author: string | null;
  external_id: string | null;
  subjects: string[] | null;
  description: string | null;
  cover_url: string | null;
  cover_source: string | null;
  page_count: number | null;
  isbn: string | null;
  isbn13: string | null;
  publisher: string | null;
  binding: string | null;
  publication_year: number | null;
  original_publication_year: number | null;
  metadata_confidence: string | null;
  content_warnings: string[] | null;
  created_at: string;
};

type UserBook = {
  id: string;
  user_id: string;
  book_id: string;
  status: string | null;
  current_page: number | null;
  rating: number | null;
  review_body: string | null;
  private_note: string | null;
  review_contains_spoiler: boolean | null;
  started_at: string | null;
  finished_at: string | null;
  read_count: number | null;
  owned_copies: number | null;
  raw_shelves: string | null;
  raw_shelf_positions: string | null;
  exclusive_shelf_imported: string | null;
  import_source: string | null;
  import_source_book_id: string | null;
  import_batch_id: string | null;
  imported_at: string | null;
  taste_tags: string[] | null;
  deleted_at: string | null;
  finished_year: number | null;
  edition_key: string | null;
};

type ReadingSession = {
  id: string;
  user_id: string;
  book_id: string;
  user_book_id: string | null;
  pages_read: number | null;
  session_date: string | null;
  started_page: number | null;
  ended_page: number | null;
  duration_minutes: number | null;
};

type MergeAction =
  | { kind: 'remap';   ubId: string; fromBookId: string; toBookId: string; userId: string }
  | { kind: 'conflict-merge'; keepUbId: string; dropUbId: string; userId: string; patch: Partial<UserBook> }
  | { kind: 'remap-sessions'; sessionIds: string[]; newBookId: string; newUbId: string | null }
  | { kind: 'patch-book'; bookId: string; patch: Partial<Book> }
  | { kind: 'null-import-refs'; ubId: string }
  | { kind: 'remap-import-matched'; dropBookId: string; canonicalBookId: string }
  | { kind: 'delete-ub'; ubId: string; userId: string }
  | { kind: 'delete-book'; bookId: string; title: string };

type ClusterPlan = {
  title: string;
  canonical: Book;
  drops: Book[];
  actions: MergeAction[];
};

// ── CLI parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  let dryRun  = false;
  let verbose = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run')  dryRun  = true;
    else if (arg === '--verbose') verbose = true;
    else { console.error(`${LOG} Unknown flag: ${arg}`); process.exit(1); }
  }
  return { dryRun, verbose };
}

// ── Normalisation ─────────────────────────────────────────────────────────────

function normaliseTitle(s: string) {
  return s.toLowerCase()
    .replace(/[''""]/g, "'")
    .replace(/[^a-z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseAuthor(s: string | null) {
  if (!s) return '';
  // Use first listed author; strip everything after the first comma that is a
  // suffix (e.g. "Reid, Taylor Jenkins" → "Taylor Jenkins Reid").
  const first = s.split(';')[0].trim();
  return first.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clusterKey(b: Book) {
  return `${normaliseTitle(b.title)}||${normaliseAuthor(b.author)}`;
}

// ── Canonical scoring ─────────────────────────────────────────────────────────
// Higher score = better canonical candidate.

function score(b: Book): number {
  let s = 0;
  if (b.external_id?.startsWith('/works/'))        s += 10;
  if (Array.isArray(b.subjects))                   s += b.subjects.length * 2;
  if (b.description && b.description.length > 20)  s += 3 + Math.min(5, Math.floor(b.description.length / 500));
  if (b.metadata_confidence === 'high')             s += 5;
  else if (b.metadata_confidence === 'medium')      s += 3;
  else if (b.metadata_confidence === 'low')         s += 1;
  if (b.isbn || b.isbn13)                           s += 1;
  if (b.page_count)                                 s += 1;
  if (b.cover_url)                                  s += 1;
  return s;
}

// ── Best-metadata patch ───────────────────────────────────────────────────────
// Build a partial Book patch: for each field, prefer the value from whichever
// row is richer.  canonical wins ties.

function bestBookPatch(canonical: Book, drops: Book[], verbose: boolean): Partial<Book> {
  const candidates = [canonical, ...drops];
  const patch: Partial<Book> = {};

  function pickBest<K extends keyof Book>(
    field: K,
    better: (a: NonNullable<Book[K]>, b: NonNullable<Book[K]>) => boolean,
  ) {
    let best = canonical[field];
    let bestFrom = 'canonical';
    for (const d of drops) {
      const v = d[field];
      if (v == null) continue;
      if (best == null || better(v as NonNullable<Book[K]>, best as NonNullable<Book[K]>)) {
        best = v;
        bestFrom = `drop:${d.id.slice(0,8)}`;
      }
    }
    if (best !== canonical[field]) {
      (patch as any)[field] = best;
      if (verbose) console.log(`${LOG}   patch ${field}: ${JSON.stringify(canonical[field])} → ${JSON.stringify(best)} (from ${bestFrom})`);
    }
  }

  // subjects: prefer longer array
  pickBest('subjects', (a, b) => (a as string[]).length > (b as string[]).length);
  // description: prefer longer string
  pickBest('description', (a, b) => (a as string).length > (b as string).length);
  // content_warnings: merge union
  const allCW = new Set<string>();
  for (const b of candidates) {
    if (Array.isArray(b.content_warnings)) for (const w of b.content_warnings) allCW.add(w);
  }
  if (allCW.size > (canonical.content_warnings?.length ?? 0)) {
    patch.content_warnings = [...allCW];
  }
  // Scalar fields: prefer non-null
  for (const field of ['cover_url','page_count','isbn','isbn13','publisher','binding',
                        'publication_year','original_publication_year'] as (keyof Book)[]) {
    pickBest(field as any, () => false); // first non-null from canonical or drops wins
  }
  // metadata_confidence: prefer 'high' > 'medium' > 'low'
  const confRank: Record<string,number> = { high: 3, medium: 2, low: 1 };
  pickBest('metadata_confidence', (a, b) => (confRank[a as string] ?? 0) > (confRank[b as string] ?? 0));

  return patch;
}

// ── UserBook conflict resolution ──────────────────────────────────────────────
// When the same user owns two rows for the same book, merge them into one.

function mergeUserBooks(keep: UserBook, drop: UserBook, verbose: boolean): Partial<UserBook> {
  const patch: Partial<UserBook> = {};

  const statusRank: Record<string, number> = { finished: 4, reading: 3, 'to-read': 2, abandoned: 1 };
  const keepRank = statusRank[keep.status ?? ''] ?? 0;
  const dropRank = statusRank[drop.status ?? ''] ?? 0;
  if (dropRank > keepRank) {
    patch.status = drop.status;
    if (verbose) console.log(`${LOG}   merge status: ${keep.status} → ${drop.status}`);
  }

  // rating: keep the higher value
  if ((drop.rating ?? 0) > (keep.rating ?? 0)) {
    patch.rating = drop.rating;
    if (verbose) console.log(`${LOG}   merge rating: ${keep.rating} → ${drop.rating}`);
  }

  // read_count: keep max
  const maxRead = Math.max(keep.read_count ?? 0, drop.read_count ?? 0);
  if (maxRead > (keep.read_count ?? 0)) {
    patch.read_count = maxRead;
    if (verbose) console.log(`${LOG}   merge read_count: ${keep.read_count} → ${maxRead}`);
  }

  // review_body: prefer longer
  if ((drop.review_body?.length ?? 0) > (keep.review_body?.length ?? 0)) {
    patch.review_body = drop.review_body;
    if (verbose) console.log(`${LOG}   merge review_body: kept drop's longer review`);
  }

  // private_note: prefer longer
  if ((drop.private_note?.length ?? 0) > (keep.private_note?.length ?? 0)) {
    patch.private_note = drop.private_note;
    if (verbose) console.log(`${LOG}   merge private_note: kept drop's longer note`);
  }

  // current_page: keep max
  const maxPage = Math.max(keep.current_page ?? 0, drop.current_page ?? 0);
  if (maxPage > (keep.current_page ?? 0)) {
    patch.current_page = maxPage;
    if (verbose) console.log(`${LOG}   merge current_page: ${keep.current_page} → ${maxPage}`);
  }

  // started_at: keep earlier
  if (drop.started_at && (!keep.started_at || drop.started_at < keep.started_at)) {
    patch.started_at = drop.started_at;
    if (verbose) console.log(`${LOG}   merge started_at: kept earlier date`);
  }

  // finished_at: keep later
  if (drop.finished_at && (!keep.finished_at || drop.finished_at > keep.finished_at)) {
    patch.finished_at = drop.finished_at;
    if (verbose) console.log(`${LOG}   merge finished_at: kept later date`);
  }

  // taste_tags: union
  const tags = new Set<string>([...(keep.taste_tags ?? []), ...(drop.taste_tags ?? [])]);
  if (tags.size > (keep.taste_tags?.length ?? 0)) {
    patch.taste_tags = [...tags];
    if (verbose) console.log(`${LOG}   merge taste_tags: merged ${tags.size} tags`);
  }

  return patch;
}

// ── Plan builder ──────────────────────────────────────────────────────────────

async function buildPlan(db: SupabaseClient, verbose: boolean): Promise<ClusterPlan[]> {
  const { data: allBooks, error } = await db
    .from('books')
    .select('*')
    .limit(10000)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`${LOG} Failed to fetch books: ${error.message}`);
  const books = (allBooks ?? []) as Book[];

  // Cluster by normalised title + author
  const clusters: Record<string, Book[]> = {};
  for (const b of books) {
    const k = clusterKey(b);
    if (!clusters[k]) clusters[k] = [];
    clusters[k].push(b);
  }

  const dupClusters = Object.values(clusters).filter(arr => arr.length > 1);
  console.log(`${LOG} Books total: ${books.length} | Duplicate clusters: ${dupClusters.length}`);

  if (dupClusters.length === 0) return [];

  // Fetch all user_books and reading_sessions for duplicate books
  const allBookIds = dupClusters.flat().map(b => b.id);

  const { data: ubData, error: ubErr } = await db
    .from('user_books')
    .select('*')
    .in('book_id', allBookIds);
  if (ubErr) throw new Error(`${LOG} Failed to fetch user_books: ${ubErr.message}`);
  const userBooks = (ubData ?? []) as UserBook[];

  const { data: rsData, error: rsErr } = await db
    .from('reading_sessions')
    .select('*')
    .in('book_id', allBookIds);
  if (rsErr) throw new Error(`${LOG} Failed to fetch reading_sessions: ${rsErr.message}`);
  const sessions = (rsData ?? []) as ReadingSession[];

  const plans: ClusterPlan[] = [];

  for (const cluster of dupClusters) {
    // Sort by score desc; ties broken by created_at asc (older row preferred)
    const sorted = [...cluster].sort((a, b) => {
      const sd = score(b) - score(a);
      return sd !== 0 ? sd : a.created_at.localeCompare(b.created_at);
    });

    const canonical = sorted[0];
    const drops     = sorted.slice(1);
    const actions: MergeAction[] = [];

    if (verbose) {
      console.log(`\n${LOG} Cluster: "${canonical.title}"`);
      for (const b of sorted) {
        console.log(`${LOG}   score=${score(b).toString().padStart(3)} id=${b.id.slice(0,8)} ext=${b.external_id ?? 'none'} subjects=${Array.isArray(b.subjects) ? b.subjects.length : 'NULL'}`);
      }
    }

    for (const drop of drops) {
      const dropUbs     = userBooks.filter(ub => ub.book_id === drop.id);
      const canonicalUbs = userBooks.filter(ub => ub.book_id === canonical.id);

      for (const dub of dropUbs) {
        const conflict = canonicalUbs.find(cub => cub.user_id === dub.user_id);
        if (!conflict) {
          // Different user — just remap the book_id pointer
          actions.push({ kind: 'remap', ubId: dub.id, fromBookId: drop.id, toBookId: canonical.id, userId: dub.user_id });
        } else {
          // Same user owns both — merge data into the canonical user_book, delete drop's
          const mergedPatch = mergeUserBooks(conflict, dub, verbose);
          if (Object.keys(mergedPatch).length > 0) {
            actions.push({ kind: 'conflict-merge', keepUbId: conflict.id, dropUbId: dub.id, userId: dub.user_id, patch: mergedPatch });
          }
          // Null import_rows.user_book_id before deleting (FK is nullable)
          actions.push({ kind: 'null-import-refs', ubId: dub.id });
          actions.push({ kind: 'delete-ub', ubId: dub.id, userId: dub.user_id });
        }
      }

      // Re-point reading sessions
      const dropSessions = sessions.filter(s => s.book_id === drop.id);
      if (dropSessions.length > 0) {
        // Map each session's user_book_id to the surviving user_book for that user
        for (const sess of dropSessions) {
          const survivingUb = userBooks.find(
            ub => ub.book_id === canonical.id && ub.user_id === sess.user_id
          ) ?? userBooks.find(
            ub => ub.book_id === drop.id && ub.user_id === sess.user_id
          );
          actions.push({
            kind: 'remap-sessions',
            sessionIds: [sess.id],
            newBookId: canonical.id,
            newUbId: survivingUb?.id ?? null,
          });
        }
      }
    }

    // Best-metadata patch on canonical book
    const bookPatch = bestBookPatch(canonical, drops, verbose);
    if (Object.keys(bookPatch).length > 0) {
      actions.push({ kind: 'patch-book', bookId: canonical.id, patch: bookPatch });
    }

    // Delete non-canonical books (only after all dependent rows are handled)
    for (const drop of drops) {
      // Remap import_rows.matched_book_id before deleting (FK is not nullable)
      actions.push({ kind: 'remap-import-matched', dropBookId: drop.id, canonicalBookId: canonical.id });
      actions.push({ kind: 'delete-book', bookId: drop.id, title: drop.title });
    }

    plans.push({ title: canonical.title, canonical, drops, actions });
  }

  return plans;
}

// ── Plan printer ──────────────────────────────────────────────────────────────

function printPlan(plans: ClusterPlan[]) {
  for (const plan of plans) {
    console.log(`\n${LOG} ── Cluster: "${plan.title}" ─────────────────────────`);
    console.log(`${LOG}   canonical : ${plan.canonical.id.slice(0,8)} (${plan.canonical.external_id ?? 'no-ext-id'}, score=${score(plan.canonical)})`);
    for (const d of plan.drops) {
      console.log(`${LOG}   drop      : ${d.id.slice(0,8)} (${d.external_id ?? 'no-ext-id'}, score=${score(d)})`);
    }
    for (const a of plan.actions) {
      switch (a.kind) {
        case 'remap':
          console.log(`${LOG}   REMAP     user_books.book_id  ub=${a.ubId.slice(0,8)} user=${a.userId.slice(0,8)} ${a.fromBookId.slice(0,8)}→${a.toBookId.slice(0,8)}`);
          break;
        case 'conflict-merge':
          console.log(`${LOG}   MERGE     user_books conflict  keep=${a.keepUbId.slice(0,8)} drop=${a.dropUbId.slice(0,8)} user=${a.userId.slice(0,8)} patch=${JSON.stringify(a.patch)}`);
          break;
        case 'null-import-refs':
          console.log(`${LOG}   NULL-REFS import_rows.user_book_id where ub=${a.ubId.slice(0,8)}`);
          break;
        case 'delete-ub':
          console.log(`${LOG}   DELETE-UB user_books ub=${a.ubId.slice(0,8)} user=${a.userId.slice(0,8)}`);
          break;
        case 'remap-sessions':
          console.log(`${LOG}   REMAP     reading_sessions ${a.sessionIds.length} rows → book=${a.newBookId.slice(0,8)} ub=${a.newUbId?.slice(0,8) ?? 'null'}`);
          break;
        case 'patch-book':
          console.log(`${LOG}   PATCH-BK  books id=${a.bookId.slice(0,8)} fields=[${Object.keys(a.patch).join(',')}]`);
          break;
        case 'remap-import-matched':
          console.log(`${LOG}   REMAP-MBK import_rows.matched_book_id ${a.dropBookId.slice(0,8)}→${a.canonicalBookId.slice(0,8)}`);
          break;
        case 'delete-book':
          console.log(`${LOG}   DELETE-BK books id=${a.bookId.slice(0,8)} "${a.title.slice(0,40)}"`);
          break;
      }
    }
  }
}

// ── Executor ──────────────────────────────────────────────────────────────────

async function executePlan(db: SupabaseClient, plans: ClusterPlan[]) {
  let enriched = 0, remapped = 0, mergedUbs = 0, deletedUbs = 0, deletedBooks = 0, patchedBooks = 0;

  for (const plan of plans) {
    console.log(`\n${LOG} Executing cluster: "${plan.title}"`);

    // Execute actions in declaration order (guaranteed safe: remap before delete)
    for (const a of plan.actions) {
      switch (a.kind) {

        case 'remap': {
          const { error } = await db.from('user_books')
            .update({ book_id: a.toBookId })
            .eq('id', a.ubId);
          if (error) throw new Error(`${LOG} remap user_book failed: ${error.message}`);
          console.log(`${LOG}   remapped user_book ${a.ubId.slice(0,8)} → book ${a.toBookId.slice(0,8)}`);
          remapped++;
          break;
        }

        case 'conflict-merge': {
          if (Object.keys(a.patch).length > 0) {
            const { error } = await db.from('user_books')
              .update(a.patch)
              .eq('id', a.keepUbId);
            if (error) throw new Error(`${LOG} conflict-merge patch failed: ${error.message}`);
            console.log(`${LOG}   merged user_book data into ${a.keepUbId.slice(0,8)}`);
            mergedUbs++;
          }
          break;
        }

        case 'null-import-refs': {
          // import_rows.user_book_id is nullable — null it out before deleting the user_book
          const { error } = await db.from('import_rows')
            .update({ user_book_id: null })
            .eq('user_book_id', a.ubId);
          if (error) throw new Error(`${LOG} null-import-refs failed: ${error.message}`);
          break;
        }

        case 'delete-ub': {
          const { error } = await db.from('user_books').delete().eq('id', a.ubId);
          if (error) throw new Error(`${LOG} delete user_book failed: ${error.message}`);
          console.log(`${LOG}   deleted user_book ${a.ubId.slice(0,8)}`);
          deletedUbs++;
          break;
        }

        case 'remap-sessions': {
          for (const sid of a.sessionIds) {
            const upd: Record<string, unknown> = { book_id: a.newBookId };
            if (a.newUbId) upd.user_book_id = a.newUbId;
            const { error } = await db.from('reading_sessions').update(upd).eq('id', sid);
            if (error) throw new Error(`${LOG} remap reading_session failed: ${error.message}`);
          }
          if (a.sessionIds.length > 0) console.log(`${LOG}   remapped ${a.sessionIds.length} reading_session(s)`);
          break;
        }

        case 'patch-book': {
          const { error } = await db.from('books').update(a.patch).eq('id', a.bookId);
          if (error) throw new Error(`${LOG} patch-book failed: ${error.message}`);
          console.log(`${LOG}   patched book ${a.bookId.slice(0,8)} fields=[${Object.keys(a.patch).join(',')}]`);
          patchedBooks++;
          enriched++;
          break;
        }

        case 'remap-import-matched': {
          // import_rows.matched_book_id is NOT nullable — remap to canonical before deleting drop book
          const { error } = await db.from('import_rows')
            .update({ matched_book_id: a.canonicalBookId })
            .eq('matched_book_id', a.dropBookId);
          if (error) throw new Error(`${LOG} remap-import-matched failed: ${error.message}`);
          break;
        }

        case 'delete-book': {
          const { error } = await db.from('books').delete().eq('id', a.bookId);
          if (error) throw new Error(`${LOG} delete-book failed: ${error.message} (book=${a.bookId})`);
          console.log(`${LOG}   deleted book ${a.bookId.slice(0,8)} "${a.title.slice(0,40)}"`);
          deletedBooks++;
          break;
        }
      }
    }
  }

  return { enriched, remapped, mergedUbs, deletedUbs, deletedBooks, patchedBooks };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function run() {
  const { dryRun, verbose } = parseArgs(process.argv);

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl || !serviceKey) {
    console.error(`${LOG} Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    process.exit(1);
  }

  const db = createClient(supabaseUrl, serviceKey);

  console.log(`${LOG} === Book Deduplication ===`);
  console.log(`${LOG} dryRun=${dryRun} verbose=${verbose}`);
  if (dryRun) console.log(`${LOG} DRY RUN — no writes will be made\n`);

  const plans = await buildPlan(db, verbose);

  if (plans.length === 0) {
    console.log(`${LOG} No duplicate clusters found. Catalog is clean.`);
    return;
  }

  printPlan(plans);

  if (dryRun) {
    console.log(`\n${LOG} DRY RUN complete — ${plans.length} cluster(s) would be merged.`);
    const totalDropBooks = plans.reduce((n, p) => n + p.drops.length, 0);
    console.log(`${LOG} Books to delete: ${totalDropBooks}`);
    return;
  }

  console.log(`\n${LOG} Executing ${plans.length} cluster merge(s)...`);
  const stats = await executePlan(db, plans);

  console.log(`\n${LOG} ── Summary ────────────────────────────────────────────`);
  console.log(`${LOG}   clusters merged  : ${plans.length}`);
  console.log(`${LOG}   user_books remapped   : ${stats.remapped}`);
  console.log(`${LOG}   user_books merged     : ${stats.mergedUbs}`);
  console.log(`${LOG}   user_books deleted    : ${stats.deletedUbs}`);
  console.log(`${LOG}   books patched    : ${stats.patchedBooks}`);
  console.log(`${LOG}   books deleted    : ${stats.deletedBooks}`);
  console.log(`${LOG} ───────────────────────────────────────────────────────`);
}

run().catch(err => {
  console.error(`${LOG} Fatal:`, err);
  process.exit(1);
});
