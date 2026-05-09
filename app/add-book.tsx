import { SAGE_DEEP } from '../lib/tokens';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BackButton } from '../components/BackButton';
import { supabase } from '../lib/supabase';
import { CoverThumb } from '../components/CoverThumb';
import {
  type BookResult,
  searchBooks,
  resolveOLKeyFromIsbn,
} from '../lib/bookSearch';
import { findSeriesForBook, getSeriesCatalog } from '../lib/seriesCatalog';
import { fetchOLMeta, fetchAuthorReleaseOrder, type AuthorReleaseOrder } from '../lib/openLibrary';
import { AuthorBibliographySheet } from '../components/AuthorBibliographySheet';
import { invalidateBookDataCaches } from '../lib/tabCache';
import { clearRecSession } from '../lib/recSession';
import { transitionStatus } from '../lib/userBookActions';
import { findOrInsertBookByExternalId } from '../lib/findOrInsertBookByExternalId';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'search' | 'confirm' | 'done';

type SelectedBook = {
  externalId: string | null;
  title: string;
  author: string;
  coverUrl: string | null;
  isManual: boolean;
  pageCount: number | null;
  editionKey: string | null;
  firstPublishYear: number | null;
  seriesName: string | null;
  seriesPosition: number | null;
  seriesTotal: number | null;
  description: string | null;
  _source?: 'ol' | 'gb';
  _isbn13?: string;
  _isbn10?: string;
};

type BookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

// ─── Constants ────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();

const FINISH_YEAR_OPTIONS: { label: string; value: number | null }[] = [
  { label: `This year (${CURRENT_YEAR})`, value: CURRENT_YEAR },
  ...Array.from({ length: 9 }, (_, i) => ({
    label: `${CURRENT_YEAR - 1 - i}`,
    value: CURRENT_YEAR - 1 - i,
  })),
  { label: "I'm not sure", value: null },
];

const STATUS_OPTIONS: { value: BookStatus; label: string; desc: string; activeBg: string; activeText: string }[] = [
  { value: 'want_to_read', label: 'Want to Read', desc: 'Saving it for later',   activeBg: '#f1f5f9', activeText: '#475569' },
  { value: 'reading',      label: 'Reading',      desc: 'Currently in progress', activeBg: '#dbeafe', activeText: '#1d4ed8' },
  { value: 'finished',     label: 'Finished',     desc: 'Completed it',          activeBg: '#eaf1ea', activeText: SAGE_DEEP },
  { value: 'dnf',          label: 'DNF',          desc: 'Did not finish',        activeBg: '#fee2e2', activeText: '#b91c1c' },
];

function olCoverUrl(coverId?: number): string | null {
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
}

// English ordinal (1st, 2nd, 3rd, 4th, 11th, 21st, …) for the author
// bibliography chip. Inline because we only need it in this one screen.
function _ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function AddBookScreen() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('search');

  const [query, setQuery] = useState('');
  const [bookResults, setBookResults] = useState<BookResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [weakQuery, setWeakQuery] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthor, setManualAuthor] = useState('');

  const [selectedBook, setSelectedBook] = useState<SelectedBook | null>(null);
  const [chosenStatus, setChosenStatus] = useState<BookStatus>('want_to_read');

  const [finishYear, setFinishYear] = useState<number | null>(CURRENT_YEAR);

  const [saving, setSaving] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');
  const [doneIsError, setDoneIsError] = useState(false);

  // Pre-fetched on entering the confirm step. When non-null it means the
  // selected book is *already* in the user's library — used to (a) default
  // the Reading Status picker to its current value instead of forcing
  // "Want to Read", (b) surface the inline "Already in your library" banner,
  // and (c) relabel the action button so the user understands they're moving
  // a shelf, not duplicating a row.
  const [existingLibraryEntry, setExistingLibraryEntry] = useState<
    { id: string; status: BookStatus; finished_at: string | null } | null
  >(null);

  // Author bibliography position — only fetched when the static series
  // catalog has nothing to say about this book. Lets a "standalone" author
  // (Lucy Foley, Tana French standalones, etc.) still get a useful
  // "her 4th release of 6" badge instead of a totally bare card.
  const [authorOrder, setAuthorOrder] = useState<AuthorReleaseOrder | null>(null);

  // Description toggle — long synopses (Lucy Foley's 600-word OL blurbs are
  // typical) get clipped to 5 lines with a "Show more" affordance so the
  // confirm card stays scannable.
  const [descExpanded, setDescExpanded] = useState(false);

  // Author bibliography sheet — opened from the bibliography chip on the
  // confirm card. Lets the reader explore the author's full catalog with
  // covers, years, and ratings before committing this book to a shelf.
  const [bibSheetOpen, setBibSheetOpen] = useState(false);

  // Stale-request guard: each search increments this; responses only committed
  // when the seq value at response time still matches the current value.
  const searchSeqRef = useRef(0);

  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  // ── Hybrid search (debounced) ──────────────────────────────────────────────
  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      setBookResults([]);
      setNoResults(false);
      setWeakQuery(false);
      setSearching(false);
      return;
    }

    const mySeq = ++searchSeqRef.current;
    setSearching(true);
    setBookResults([]);
    setNoResults(false);
    setWeakQuery(false);

    const timer = setTimeout(async () => {
      try {
        // Stream the Google Books-only first batch into the UI as soon as it
        // arrives so the user sees results within a few hundred ms even if
        // an Open Library variant is slow. The full merged/scored result
        // overwrites this once the parallel pipeline finishes.
        const result = await searchBooks(trimmed, {
          onPartial: (partial) => {
            if (searchSeqRef.current !== mySeq) return;
            if (partial.results.length === 0) return;
            setBookResults(partial.results);
            setNoResults(false);
            setWeakQuery(false);
            // Hide the spinner the moment we have something useful to show;
            // the rest of the providers continue refining in the background.
            setSearching(false);
          },
        });

        // Discard stale response
        if (searchSeqRef.current !== mySeq) return;

        if (result.weakQuery) {
          setBookResults([]);
          setNoResults(false);
          setWeakQuery(true);
        } else if (result.noResults) {
          setBookResults([]);
          setNoResults(true);
          setWeakQuery(false);
        } else {
          setBookResults(result.results);
          setNoResults(false);
          setWeakQuery(false);
        }
      } catch {
        if (searchSeqRef.current !== mySeq) return;
        setBookResults([]);
        setNoResults(true);
      }
      setSearching(false);
    }, 400);

    return () => clearTimeout(timer);
  }, [query]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function selectBook(book: BookResult) {
    const editionKey = book.cover_edition_key ?? null;
    const coverUrl = book._gbCoverUrl
      ?? (editionKey ? `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg` : olCoverUrl(book.cover_i));
    const rawPages = book.number_of_pages_median;
    const pageCount = typeof rawPages === 'number' && rawPages >= 30 ? rawPages : null;
    // Series lookup is synchronous against a static catalog — populate up
    // front so the confirm card renders the chip on first paint.
    const author = book.author_name?.[0] ?? 'Unknown author';
    const series = findSeriesForBook(book.title, author);
    const seriesEntry = series ? getSeriesCatalog(series.seriesName) : null;
    setSelectedBook({
      externalId: book.key,
      title: book.title,
      author,
      coverUrl,
      isManual: false,
      pageCount,
      editionKey,
      firstPublishYear: typeof book.first_publish_year === 'number' ? book.first_publish_year : null,
      seriesName:      seriesEntry?.displayName ?? series?.seriesName ?? null,
      seriesPosition:  series?.seriesPosition ?? null,
      seriesTotal:     seriesEntry?.total ?? null,
      description:     null,
      _source: book._source,
      _isbn13: book._isbn13,
      _isbn10: book._isbn10,
    });
    setStep('confirm');
  }

  function selectManual() {
    if (!manualTitle.trim()) return;
    setSelectedBook({
      externalId: null,
      title: manualTitle.trim(),
      author: manualAuthor.trim() || 'Unknown author',
      coverUrl: null,
      isManual: true,
      pageCount: null,
      editionKey: null,
      firstPublishYear: null,
      seriesName: null,
      seriesPosition: null,
      seriesTotal: null,
      description: null,
    });
    setStep('confirm');
  }

  // ── Already-in-library lookup ────────────────────────────────────────────
  // Runs the moment the user lands on the confirm step. If the selected
  // book has an externalId we already know about, see whether *this user*
  // has it on a shelf. If yes, default the picker to the existing status
  // and remember the entry so handleSave can short-circuit straight into
  // transitionStatus() — same propagation the book detail screen uses.
  // Stale-guarded by externalId so a quick back-and-pick-different-row
  // can't write the wrong entry into a fresh selection.
  useEffect(() => {
    if (step !== 'confirm') return;
    if (!supabase || !userId) return;
    if (!selectedBook?.externalId) {
      setExistingLibraryEntry(null);
      return;
    }
    const id = selectedBook.externalId;
    let cancelled = false;
    (async () => {
      // I4 — Option B-lite filter-only (no insert in this flow point).
      // See docs/p1_5b_3_dedup_audit.md §A.1.
      // Edge case: if user B inserted an unverified row and user A also
      // has a user_books row pointing at it, the filter hides that row
      // here and the "already in library" hint won't render. Save path
      // (handleSave → I3) recovers via the helper's 23505 fallback +
      // user_books upsert(onConflict=user_id,book_id), so no data loss —
      // only a missing UX hint in that narrow window.
      const { data: bookRow } = await supabase
        .from('books')
        .select('id')
        .eq('external_id', id)
        .or(`provenance_state.eq.verified,provenance_inserted_by.eq.${userId}`)
        .maybeSingle();
      if (cancelled || !bookRow) {
        if (!cancelled) setExistingLibraryEntry(null);
        return;
      }
      const { data: ub } = await supabase
        .from('user_books')
        .select('id, status, finished_at')
        .eq('user_id', userId)
        .eq('book_id', bookRow.id)
        .maybeSingle();
      if (cancelled) return;
      if (ub && (ub.status === 'want_to_read' || ub.status === 'reading' || ub.status === 'finished' || ub.status === 'dnf')) {
        setExistingLibraryEntry({
          id: ub.id as string,
          status: ub.status,
          finished_at: (ub.finished_at as string | null) ?? null,
        });
        // Default the picker to the existing status — the user is most
        // likely re-finding a saved book, not trying to change shelves.
        setChosenStatus(ub.status);
      } else {
        setExistingLibraryEntry(null);
      }
    })().catch(() => { if (!cancelled) setExistingLibraryEntry(null); });
    return () => { cancelled = true; };
  }, [step, selectedBook?.externalId, userId]);

  // ── Author release-order enrichment ──────────────────────────────────────
  // Skipped when we already matched the static series catalog (the series
  // chip carries strictly better information). Only runs once per
  // (selectedBook.externalId) — the helper's own in-memory cache prevents
  // re-fetching across selections of the same book.
  useEffect(() => {
    if (step !== 'confirm') return;
    if (!selectedBook) return;
    if (selectedBook.seriesName) { setAuthorOrder(null); return; }
    if (!selectedBook.title || !selectedBook.author || selectedBook.author === 'Unknown author') {
      setAuthorOrder(null);
      return;
    }
    const id = selectedBook.externalId;
    let cancelled = false;
    setAuthorOrder(null);
    fetchAuthorReleaseOrder(selectedBook.author, selectedBook.title).then(order => {
      if (cancelled) return;
      // Re-check selection identity; user may have backed out and picked
      // a different book while we were waiting on OL.
      setSelectedBook(prev => {
        if (!prev || prev.externalId !== id) return prev;
        return prev;
      });
      setAuthorOrder(order);
    }).catch(() => { /* enrichment is silent on failure — card stays minimal */ });
    return () => { cancelled = true; };
  }, [step, selectedBook?.externalId, selectedBook?.seriesName]);

  // Reset description expand state whenever the user switches selections so
  // the next book starts clipped, never inheriting the prior toggle state.
  useEffect(() => {
    setDescExpanded(false);
  }, [selectedBook?.externalId]);

  // ── Async enrichment of confirm card ─────────────────────────────────────
  // When the user lands on the confirm step with an Open Library work id,
  // fetch description + (improved) page count in the background so the
  // card grows from "title + author" to "title + author + series + year +
  // pages + 3-line synopsis" without blocking the screen. Stale-guarded
  // by externalId so a quick back-and-forth between rows can't write the
  // wrong description into a different selection.
  useEffect(() => {
    if (step !== 'confirm') return;
    if (!selectedBook?.externalId) return;
    if (selectedBook.description !== null) return; // already enriched
    const id = selectedBook.externalId;
    if (!id.startsWith('/works/')) return; // OL works only — GB rows skip
    let cancelled = false;
    fetchOLMeta(id).then(meta => {
      if (cancelled) return;
      setSelectedBook(prev => {
        if (!prev || prev.externalId !== id) return prev; // selection changed
        return {
          ...prev,
          description: meta.description,
          pageCount:   prev.pageCount ?? meta.pageCount ?? null,
        };
      });
    }).catch(() => { /* enrichment failure is silent — card just stays minimal */ });
    return () => { cancelled = true; };
  }, [step, selectedBook?.externalId]);

  async function handleSave() {
    if (!supabase || !userId || !selectedBook) return;
    setSaving(true);

    let bookId: string;
    let externalId = selectedBook.externalId;

    // If the book came from Google Books, attempt OL key resolution before saving.
    // This ensures the book gets a proper OL work key as its external_id.
    if (selectedBook._source === 'gb' && externalId?.startsWith('gb:')) {
      const fakeBookResult: BookResult = {
        key:     externalId,
        title:   selectedBook.title,
        _isbn13: selectedBook._isbn13,
        _isbn10: selectedBook._isbn10,
      };
      externalId = await resolveOLKeyFromIsbn(fakeBookResult);
    }

    if (externalId) {
      // I3 — Option B-lite cross-user dedup-read; see
      // docs/p1_5b_3_dedup_audit.md and docs/p1_5b_2_surface_audit.md §C.5.
      const insertData: Record<string, unknown> = {
        title:       selectedBook.title,
        author:      selectedBook.author,
        external_id: externalId,
        cover_url:   selectedBook.coverUrl,
      };
      if (selectedBook.pageCount) insertData.page_count = selectedBook.pageCount;
      const { row, via, error } = await findOrInsertBookByExternalId<{
        id:          string;
        cover_url:   string | null;
        page_count:  number | null;
      }>(
        supabase,
        {
          userId,
          externalId,
          selectColumns: 'id, cover_url, page_count',
          insertPayload: insertData,
          callSite:      'app/add-book.tsx#handleSave',
        },
      );
      if (error || !row) {
        setDoneMessage('Could not save book. Please try again.');
        setDoneIsError(true);
        setSaving(false);
        setStep('done');
        return;
      }
      bookId = row.id;
      // Fill-empty cover_url + page_count when we picked up an existing
      // row (filtered hit OR unfiltered 23505 fallback) — never on a
      // fresh insert (we just wrote both via insertPayload).
      if (via !== 'insert') {
        const updates: Record<string, unknown> = {};
        if (!row.cover_url && selectedBook.coverUrl) updates.cover_url = selectedBook.coverUrl;
        if (!row.page_count && selectedBook.pageCount) updates.page_count = selectedBook.pageCount;
        if (Object.keys(updates).length > 0) {
          await supabase.from('books').update(updates).eq('id', row.id);
        }
      }
    } else {
      const { data: newBook, error } = await supabase
        .from('books')
        .insert({
          title:       selectedBook.title,
          author:      selectedBook.author,
          external_id: null,
          cover_url:   null,
        })
        .select('id')
        .single();

      if (error || !newBook) {
        setDoneMessage('Could not save book. Please try again.');
        setDoneIsError(true);
        setSaving(false);
        setStep('done');
        return;
      }
      bookId = newBook.id;
    }

    const { data: existingUserBook } = await supabase
      .from('user_books')
      .select('id, status, finished_at')
      .eq('user_id', userId)
      .eq('book_id', bookId)
      .maybeSingle();

    if (existingUserBook) {
      // Two cases:
      //   (a) Same status the user picked → no-op, friendly "already there".
      //   (b) Different status → user forgot the book was already saved and
      //       is implicitly asking to change its shelf. Route through
      //       transitionStatus() so the change picks up history snapshots,
      //       activity events, recommendation sync, and paused_at clearing
      //       — exactly the same propagation the book detail screen gets.
      const oldLabel = STATUS_OPTIONS.find(o => o.value === existingUserBook.status)?.label ?? existingUserBook.status;
      if (existingUserBook.status === chosenStatus) {
        setDoneMessage(`Already in your library — ${oldLabel}.`);
        setDoneIsError(false);
        setSaving(false);
        setStep('done');
        return;
      }

      const { error: transErr } = await transitionStatus(supabase, {
        userBookId:         existingUserBook.id,
        bookId,
        userId,
        newStatus:          chosenStatus,
        existingFinishedAt: existingUserBook.finished_at as string | null | undefined,
      });
      if (transErr) {
        setDoneMessage(transErr);
        setDoneIsError(true);
        setSaving(false);
        setStep('done');
        return;
      }

      const newLabel = STATUS_OPTIONS.find(o => o.value === chosenStatus)?.label ?? chosenStatus;
      invalidateBookDataCaches();
      if (chosenStatus === 'reading') clearRecSession();
      setDoneMessage(`Moved "${selectedBook.title}" from ${oldLabel} to ${newLabel}.`);
      setDoneIsError(false);
      setSaving(false);
      setStep('done');
      return;
    }

    const now = new Date().toISOString();
    const userBookData: Record<string, unknown> = { user_id: userId, book_id: bookId, status: chosenStatus };
    if (chosenStatus === 'reading') userBookData.started_at = now;
    if (chosenStatus === 'finished' || chosenStatus === 'dnf') {
      userBookData.started_at = now;
      if (chosenStatus === 'dnf') {
        userBookData.finished_at = now;
      } else {
        if (finishYear === null) {
          // No finished_at — unknown read date
        } else if (finishYear === CURRENT_YEAR) {
          userBookData.finished_at = now;
        } else {
          userBookData.finished_at = `${finishYear}-12-31T00:00:00.000Z`;
        }
      }
    }

    const { error: ubError } = await supabase.from('user_books').insert(userBookData);
    if (ubError) {
      setDoneMessage('Could not add to library. Please try again.');
      setDoneIsError(true);
      setSaving(false);
      setStep('done');
      return;
    }

    if (chosenStatus === 'finished') {
      await supabase.from('activity_events').insert({
        actor_id:   userId,
        event_type: 'book_finished',
        book_id:    bookId,
      });
    }

    // Propagate the new shelf state across every surface that caches book
    // data: Library tab gallery + smart shelves, For-You feed (rec session),
    // Stats screen, etc. Without these calls the user lands back on Library
    // and sees nothing change until a hard refresh — the exact bug the user
    // keeps hitting after Add-to-Library. Mirrors the propagation that
    // `transitionStatus` triggers from the book detail screen.
    invalidateBookDataCaches();
    if (chosenStatus === 'reading') {
      // Same rule as in book/[id].tsx handleTransition: any move that affects
      // what counts as "currently reading" wipes the For-You session so the
      // next focus on that tab re-runs the recommender against the fresh
      // shelf state (see RecommendationsFeed's session-cleared focus effect).
      clearRecSession();
    }

    setDoneMessage(`"${selectedBook.title}" added to your library.`);
    setDoneIsError(false);
    setSaving(false);
    setStep('done');
  }

  function resetAndAddAnother() {
    setStep('search');
    setExistingLibraryEntry(null);
    setChosenStatus('want_to_read');
    setQuery('');
    setBookResults([]);
    setNoResults(false);
    setWeakQuery(false);
    setShowManual(false);
    setManualTitle('');
    setManualAuthor('');
    setChosenStatus('want_to_read');
    setFinishYear(CURRENT_YEAR);
    setSelectedBook(null);
  }

  // ── Step: search ───────────────────────────────────────────────────────────

  if (step === 'search') {
    const trimmed = query.trim();
    const hasQuery = trimmed.length >= 2;

    return (
      <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
        {/* ── Header ── */}
        <View style={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 12 }}>
          <BackButton onPress={() => router.back()} style={{ marginBottom: 20 }} />
          <Text style={{
            fontSize: 28,
            fontWeight: '800',
            color: '#231f1b',
            letterSpacing: -0.5,
            marginBottom: 5,
          }}>
            Add to Library
          </Text>
          <Text style={{ fontSize: 14, color: '#9e958d', marginBottom: 14 }}>
            Find a book to track, or add one manually.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/import/goodreads')}
            style={{ marginBottom: 16 }}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 13, color: '#9e958d' }}>
              Already on Goodreads?{' '}
              <Text style={{ color: '#78716c', textDecorationLine: 'underline' }}>
                Import your whole library →
              </Text>
            </Text>
          </TouchableOpacity>
          <TextInput
            value={query}
            onChangeText={text => { setQuery(text); setShowManual(false); }}
            placeholder="Title, author, or keyword…"
            placeholderTextColor="#9e958d"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              backgroundColor: '#fefcf9',
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 15,
              color: '#231f1b',
              shadowColor: '#000',
              shadowOpacity: 0.05,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
              elevation: 1,
            }}
          />
        </View>

        {searching && (
          <ActivityIndicator color="#78716c" style={{ marginTop: 4, marginBottom: 4 }} />
        )}

        <FlatList
          data={bookResults}
          keyExtractor={item => item.key}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const coverUrl = item._gbCoverUrl
              ?? (item.cover_edition_key
                ? `https://covers.openlibrary.org/b/olid/${item.cover_edition_key}-M.jpg`
                : olCoverUrl(item.cover_i));
            return (
              <TouchableOpacity
                onPress={() => selectBook(item)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 11,
                  borderBottomWidth: 1,
                  borderBottomColor: '#ede9e4',
                }}
              >
                <CoverThumb url={coverUrl} title={item.title} width={34} height={50} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b', lineHeight: 21 }}>
                    {item.title}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 2 }}>
                    {item.author_name?.[0] ?? 'Unknown author'}
                  </Text>
                </View>
                <Text style={{ fontSize: 20, color: '#ede9e4', marginLeft: 8 }}>›</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            !searching && hasQuery && noResults ? (
              <Text style={{ color: '#9e958d', fontSize: 14, paddingVertical: 10 }}>
                No results. Try a different title or add manually below.
              </Text>
            ) : !searching && hasQuery && weakQuery ? (
              <Text style={{ color: '#9e958d', fontSize: 14, paddingVertical: 10 }}>
                Keep typing…
              </Text>
            ) : !hasQuery && !showManual ? (
              <View style={{ paddingTop: 16 }}>
                <View style={{ alignItems: 'center', marginBottom: 20 }}>
                  <Text style={{
                    fontSize: 13,
                    color: '#9e958d',
                    lineHeight: 20,
                    textAlign: 'center',
                  }}>
                    Search millions of titles
                  </Text>
                </View>

                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: 20,
                }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: '#ede9e4' }} />
                  <Text style={{
                    fontSize: 12,
                    color: '#c4b5a5',
                    fontWeight: '500',
                    paddingHorizontal: 14,
                  }}>
                    or
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: '#ede9e4' }} />
                </View>

                <TouchableOpacity
                  onPress={() => setShowManual(true)}
                  style={{
                    backgroundColor: '#fefcf9',
                    borderRadius: 14,
                    paddingVertical: 18,
                    paddingHorizontal: 18,
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderWidth: 1,
                    borderColor: '#ede9e4',
                    shadowColor: '#000',
                    shadowOpacity: 0.03,
                    shadowRadius: 4,
                    shadowOffset: { width: 0, height: 1 },
                    elevation: 1,
                  }}
                >
                  <Text style={{ fontSize: 22, marginRight: 14 }}>✏️</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{
                      fontSize: 15,
                      fontWeight: '600',
                      color: '#231f1b',
                      marginBottom: 2,
                    }}>
                      Add manually
                    </Text>
                    <Text style={{ fontSize: 13, color: '#9e958d', lineHeight: 18 }}>
                      Enter the title and author yourself
                    </Text>
                  </View>
                  <Text style={{ fontSize: 20, color: '#ede9e4' }}>›</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
          ListFooterComponent={
            !searching && hasQuery && bookResults.length > 0 ? (
              <TouchableOpacity
                onPress={() => setShowManual(v => !v)}
                style={{ paddingVertical: 16, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 14, color: '#78716c', textDecorationLine: 'underline' }}>
                  {showManual ? 'Hide manual entry' : "Can't find it? Add manually"}
                </Text>
              </TouchableOpacity>
            ) : null
          }
        />

        {/* Manual entry form */}
        {showManual && (
          <View style={{
            marginHorizontal: 20,
            marginTop: 8,
            marginBottom: 24,
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            padding: 18,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: '#9e958d',
              letterSpacing: 0.9,
              textTransform: 'uppercase',
              marginBottom: 16,
            }}>
              Manual Entry
            </Text>
            <TextInput
              value={manualTitle}
              onChangeText={setManualTitle}
              placeholder="Book title *"
              placeholderTextColor="#9e958d"
              style={{
                borderBottomWidth: 1,
                borderBottomColor: '#ede9e4',
                paddingVertical: 10,
                fontSize: 15,
                color: '#231f1b',
                marginBottom: 12,
              }}
            />
            <TextInput
              value={manualAuthor}
              onChangeText={setManualAuthor}
              placeholder="Author (optional)"
              placeholderTextColor="#9e958d"
              style={{
                borderBottomWidth: 1,
                borderBottomColor: '#ede9e4',
                paddingVertical: 10,
                fontSize: 15,
                color: '#231f1b',
                marginBottom: 20,
              }}
            />
            <TouchableOpacity
              onPress={selectManual}
              disabled={!manualTitle.trim()}
              style={{
                backgroundColor: manualTitle.trim() ? '#231f1b' : '#ede9e4',
                borderRadius: 10,
                paddingVertical: 13,
                alignItems: 'center',
              }}
            >
              <Text style={{
                color: manualTitle.trim() ? '#fff' : '#9e958d',
                fontSize: 14,
                fontWeight: '600',
              }}>
                Continue
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  // ── Step: confirm ──────────────────────────────────────────────────────────

  if (step === 'confirm') {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#f5f1ec' }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 60, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <BackButton onPress={() => setStep('search')} label="Search" style={{ marginBottom: 22 }} />

        <Text style={{
          fontSize: 22,
          fontWeight: '800',
          color: '#231f1b',
          letterSpacing: -0.4,
          marginBottom: 4,
        }}>
          Add to Library
        </Text>
        <Text style={{ fontSize: 14, color: '#9e958d', marginBottom: 22 }}>
          Choose where this book fits in your reading.
        </Text>

        {/* Book preview card */}
        <View style={{
          backgroundColor: '#fefcf9',
          borderRadius: 14,
          padding: 16,
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 32,
          borderLeftWidth: 3,
          borderLeftColor: '#231f1b',
          shadowColor: '#000',
          shadowOpacity: 0.05,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        }}>
          <CoverThumb
            url={selectedBook?.coverUrl}
            externalId={selectedBook?.externalId}
            editionKey={selectedBook?.editionKey}
            title={selectedBook?.title}
            width={52}
            height={76}
          />
          <View style={{ flex: 1, marginLeft: 16 }}>
            <Text style={{
              fontSize: 16,
              fontWeight: '700',
              color: '#231f1b',
              lineHeight: 22,
              marginBottom: 4,
            }}>
              {selectedBook?.title}
            </Text>
            <Text style={{ fontSize: 14, color: '#78716c' }}>{selectedBook?.author}</Text>

            {/* Series chip — only when we matched the static catalog */}
            {selectedBook?.seriesName && (
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                alignSelf: 'flex-start',
                backgroundColor: '#eaf1ea',
                borderRadius: 6,
                paddingHorizontal: 8,
                paddingVertical: 3,
                marginTop: 8,
              }}>
                <Text style={{ fontSize: 11, color: SAGE_DEEP, fontWeight: '700', letterSpacing: 0.2 }}>
                  {selectedBook.seriesName}
                  {selectedBook.seriesPosition
                    ? ` · #${selectedBook.seriesPosition}${selectedBook.seriesTotal ? ` of ${selectedBook.seriesTotal}` : ''}`
                    : ''}
                </Text>
              </View>
            )}

            {/* Author bibliography chip — fallback when there's no series.
                Tappable: opens the AuthorBibliographySheet so readers can
                explore the author's full catalog before committing. */}
            {!selectedBook?.seriesName && authorOrder && selectedBook?.author && (
              <TouchableOpacity
                onPress={() => setBibSheetOpen(true)}
                activeOpacity={0.7}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  alignSelf: 'flex-start',
                  backgroundColor: '#eaf1ea',
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  marginTop: 8,
                }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Text style={{ fontSize: 11, color: SAGE_DEEP, fontWeight: '700', letterSpacing: 0.2 }}>
                  {`${_ordinal(authorOrder.position)} of ${authorOrder.total} by ${selectedBook.author}`}
                </Text>
                <Ionicons name="chevron-forward" size={11} color={SAGE_DEEP} style={{ marginLeft: 3 }} />
              </TouchableOpacity>
            )}

            {/* Year · pages meta line */}
            {(selectedBook?.firstPublishYear || selectedBook?.pageCount) && (
              <Text style={{ fontSize: 12, color: '#9e958d', marginTop: 6 }}>
                {[
                  selectedBook?.firstPublishYear ? String(selectedBook.firstPublishYear) : null,
                  selectedBook?.pageCount ? `${selectedBook.pageCount} pages` : null,
                ].filter(Boolean).join(' · ')}
              </Text>
            )}

            {selectedBook?.isManual && (
              <View style={{
                backgroundColor: '#fef3c7',
                borderRadius: 5,
                paddingHorizontal: 7,
                paddingVertical: 2,
                alignSelf: 'flex-start',
                marginTop: 7,
              }}>
                <Text style={{ fontSize: 11, color: '#92400e', fontWeight: '500' }}>Manual entry</Text>
              </View>
            )}
          </View>
        </View>

        {/* Description blurb — appears once async enrichment lands */}
        {selectedBook?.description && (() => {
          const cleaned = selectedBook.description.replace(/\s+/g, ' ').trim();
          // Only show the toggle when the description is long enough that
          // 5-line clipping actually hides content. ~280 chars ≈ 5 lines at
          // the 13/19 type rhythm; below that the toggle would just flash a
          // useless "Show more" that opens nothing new.
          const isLong = cleaned.length > 280;
          return (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 12,
              padding: 14,
              marginTop: -20,
              marginBottom: 28,
              borderWidth: 1,
              borderColor: '#ede9e4',
            }}>
              <Text style={{
                fontSize: 10,
                fontWeight: '700',
                color: '#9e958d',
                letterSpacing: 0.9,
                textTransform: 'uppercase',
                marginBottom: 6,
              }}>
                About this book
              </Text>
              <Text
                numberOfLines={descExpanded || !isLong ? undefined : 5}
                style={{ fontSize: 13, color: '#57534e', lineHeight: 19 }}
              >
                {cleaned}
              </Text>
              {isLong && (
                <TouchableOpacity
                  onPress={() => setDescExpanded(v => !v)}
                  style={{ marginTop: 10, alignSelf: 'flex-start' }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={{ fontSize: 12, color: SAGE_DEEP, fontWeight: '700', letterSpacing: 0.2 }}>
                    {descExpanded ? 'Show less' : 'Show more'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })()}

        {/* Already-in-library banner — only when the user has this book on a shelf */}
        {existingLibraryEntry && (
          <View style={{
            backgroundColor: '#fef6e7',
            borderColor: '#f6c863',
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 12,
            paddingHorizontal: 14,
            marginBottom: 22,
          }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#7a5a10', marginBottom: 2 }}>
              Already in your library
            </Text>
            <Text style={{ fontSize: 12, color: '#8a6a1a', lineHeight: 17 }}>
              Currently on your{' '}
              <Text style={{ fontWeight: '700' }}>
                {STATUS_OPTIONS.find(o => o.value === existingLibraryEntry.status)?.label ?? existingLibraryEntry.status}
              </Text>
              {' '}shelf. Pick a different status below to move it, or back out to leave it as is.
            </Text>
          </View>
        )}

        {/* Status picker */}
        <Text style={{
          fontSize: 11,
          fontWeight: '700',
          color: '#9e958d',
          letterSpacing: 0.9,
          textTransform: 'uppercase',
          marginBottom: 14,
        }}>
          Reading Status
        </Text>

        <View style={{ gap: 10, marginBottom: chosenStatus === 'finished' ? 24 : 40 }}>
          {STATUS_OPTIONS.map(opt => {
            const active = chosenStatus === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                onPress={() => setChosenStatus(opt.value)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: active ? opt.activeBg : '#fff',
                  borderRadius: 12,
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  borderWidth: 1.5,
                  borderColor: active ? opt.activeText : '#ede9e4',
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{
                    fontSize: 15,
                    fontWeight: '600',
                    color: active ? opt.activeText : '#231f1b',
                    marginBottom: 2,
                  }}>
                    {opt.label}
                  </Text>
                  <Text style={{ fontSize: 13, color: active ? opt.activeText : '#9e958d' }}>
                    {opt.desc}
                  </Text>
                </View>
                {active && (
                  <Text style={{ fontSize: 18, color: opt.activeText }}>✓</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Finish year picker (finished only) */}
        {chosenStatus === 'finished' && (
          <View style={{ marginBottom: 40 }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: '#9e958d',
              letterSpacing: 0.9,
              textTransform: 'uppercase',
              marginBottom: 14,
            }}>
              When did you finish it?
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {FINISH_YEAR_OPTIONS.map(opt => {
                  const active = finishYear === opt.value;
                  return (
                    <TouchableOpacity
                      key={String(opt.value)}
                      onPress={() => setFinishYear(opt.value)}
                      style={{
                        paddingVertical: 10,
                        paddingHorizontal: 16,
                        borderRadius: 10,
                        backgroundColor: active ? '#231f1b' : '#fff',
                        borderWidth: 1,
                        borderColor: active ? '#231f1b' : '#ede9e4',
                      }}
                    >
                      <Text style={{
                        fontSize: 14,
                        fontWeight: '500',
                        color: active ? '#fff' : '#78716c',
                      }}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}

        <TouchableOpacity
          onPress={handleSave}
          disabled={saving}
          style={{
            backgroundColor: saving ? '#ede9e4' : '#231f1b',
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: 'center',
          }}
        >
          <Text style={{
            color: saving ? '#9e958d' : '#fff',
            fontSize: 16,
            fontWeight: '700',
            letterSpacing: 0.2,
          }}>
            {saving
              ? 'Saving…'
              : existingLibraryEntry
                ? (existingLibraryEntry.status === chosenStatus
                    ? 'Already on this shelf'
                    : `Move to ${STATUS_OPTIONS.find(o => o.value === chosenStatus)?.label ?? chosenStatus}`)
                : 'Add to Library'}
          </Text>
        </TouchableOpacity>

        {/* Bibliography sheet — mounted inside the confirm step's tree so
            it tears down cleanly when the user navigates away. */}
        <AuthorBibliographySheet
          visible={bibSheetOpen}
          onClose={() => setBibSheetOpen(false)}
          author={selectedBook?.author ?? ''}
          currentTitle={selectedBook?.title ?? null}
        />
      </ScrollView>
    );
  }

  // ── Step: done ─────────────────────────────────────────────────────────────

  return (
    <View style={{
      flex: 1,
      backgroundColor: '#f5f1ec',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    }}>
      <Text style={{
        fontSize: 48,
        marginBottom: 20,
      }}>
        {doneIsError ? '⚠️' : '📚'}
      </Text>
      <Text style={{
        fontSize: 20,
        fontWeight: '700',
        color: '#231f1b',
        textAlign: 'center',
        marginBottom: 10,
        letterSpacing: -0.3,
      }}>
        {doneIsError ? 'Something went wrong' : 'Added!'}
      </Text>
      <Text style={{
        fontSize: 15,
        color: '#78716c',
        textAlign: 'center',
        marginBottom: 36,
        lineHeight: 22,
      }}>
        {doneMessage}
      </Text>

      {!doneIsError && (
        <TouchableOpacity
          onPress={resetAndAddAnother}
          style={{
            backgroundColor: '#fefcf9',
            borderRadius: 12,
            paddingVertical: 13,
            paddingHorizontal: 28,
            borderWidth: 1,
            borderColor: '#ede9e4',
            marginBottom: 16,
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b' }}>
            Add another book
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        onPress={() => router.back()}
        style={{
          paddingVertical: 13,
          paddingHorizontal: 28,
        }}
      >
        <Text style={{ fontSize: 15, color: '#78716c' }}>
          {doneIsError ? 'Go back' : 'Done'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
