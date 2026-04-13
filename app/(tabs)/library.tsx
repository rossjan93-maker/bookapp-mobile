import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGoogleBooksCoverUrl } from '../../lib/googleBooks';
import { repairBooksMetadata } from '../../lib/metadataRepair';
import { registerCacheClearer } from '../../lib/tabCache';
import { mountDevInspector } from '../../lib/devInspector';
import { ActivityIndicator, FlatList, Keyboard, Modal, RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { LibraryScreenSkeleton } from '../../components/Placeholder';
import { LibraryGalleryView } from '../../components/LibraryGalleryView';
import { computePagePacing, computeDatePacing, formatLastUpdated, computeBookPace, formatPaceChip, computeUserAvgPace, inferReadState } from '../../lib/pacing';
import { transitionStatus, saveCurrentPage } from '../../lib/userBookActions';
import { findSeriesForBook, getSeriesCatalog } from '../../lib/seriesCatalog';
import { triggerRecPrewarm } from '../../lib/recPrewarm';
import { registerWtTarget, useWalkthrough } from '../../lib/walkthroughEngine';
import { WtDemoLibrary } from '../../components/walkthrough/WtDemoLibrary';

const LIB_VIEW_MODE_KEY = 'libraryViewMode';

// ─── Types ────────────────────────────────────────────────────────────────────

type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';
type FilterKey      = 'all' | UserBookStatus;
type SortKey        = 'recent' | 'progress' | 'finished_date';

type UserBook = {
  id: string;
  book_id: string;
  status: UserBookStatus;
  started_at: string | null;
  finished_at: string | null;
  current_page: number | null;
  progress_updated_at: string | null;
  taste_tags: Record<string, any> | null;
  book: {
    title: string;
    author: string;
    cover_url: string | null;
    external_id: string;
    page_count: number | null;
  } | null;
};

type PendingFeedback = { userBookId: string; bookId: string; status: 'finished' | 'dnf'; pendingEventId: string | null };

type YearSeparator    = { __type: 'year_separator'; year: string; key: string; count: number };
type SectionSeparator = { __type: 'section_separator'; key: string; title: string; subtitle?: string; muted?: boolean };
type ListItem         = UserBook | YearSeparator | SectionSeparator;

function isYearSeparator(item: ListItem): item is YearSeparator {
  return (item as YearSeparator).__type === 'year_separator';
}
function isSectionSeparator(item: ListItem): item is SectionSeparator {
  return (item as SectionSeparator).__type === 'section_separator';
}

// Build an accordion-aware list: only books whose year is in expandedYears are
// included. Every year always gets a header row (with count) so the user can
// tap to expand/collapse even when the group is hidden.
// "No finish date" group appears last (nulls already sorted to the bottom).
function buildGroupedFinished(sorted: UserBook[], expandedYears: Set<string>): ListItem[] {
  // Count books per year in one pass.
  const yearCounts = new Map<string, number>();
  for (const book of sorted) {
    const year = book.finished_at
      ? String(new Date(book.finished_at).getFullYear())
      : 'No finish date';
    yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
  }
  const result: ListItem[] = [];
  let currentYear: string | null = null;
  for (const book of sorted) {
    const year = book.finished_at
      ? String(new Date(book.finished_at).getFullYear())
      : 'No finish date';
    if (year !== currentYear) {
      result.push({ __type: 'year_separator', year, key: `sep_${year}`, count: yearCounts.get(year) ?? 0 });
      currentYear = year;
    }
    if (expandedYears.has(year)) {
      result.push(book);
    }
  }
  return result;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<UserBookStatus, string> = {
  want_to_read: 'Want to Read',
  reading:      'Reading',
  finished:     'Finished',
  dnf:          'Set aside',
};

const STATUS_BADGE: Record<UserBookStatus, { bg: string; text: string }> = {
  want_to_read: { bg: '#f0ece6', text: '#6b635c' },
  reading:      { bg: '#e6f0e6', text: '#4d7f52' },
  finished:     { bg: '#e6f0e6', text: '#4d7f52' },
  dnf:          { bg: '#f0ece6', text: '#7d6f63' },
};

const FILTER_OPTIONS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all',          label: 'All'          },
  { key: 'reading',      label: 'Reading'      },
  { key: 'want_to_read', label: 'Want to Read' },
  { key: 'finished',     label: 'Finished'     },
  { key: 'dnf',          label: 'Set aside'    },
];

const FILTER_EMPTY: Record<FilterKey, { title: string; body: string }> = {
  all:          { title: 'Your library is empty',  body: 'Add books you\'re reading, have finished, or want to read.' },
  reading:      { title: 'Not reading anything',   body: 'Start a book from your list, or add something new.' },
  want_to_read: { title: 'Nothing queued up',      body: 'Save books you want to read next.' },
  finished:     { title: 'No finished books yet',  body: 'Finished books will appear here.' },
  dnf:          { title: 'Nothing set aside',      body: 'Sometimes a book isn\'t the right fit for now.' },
};

// ─── Module-level session cache ───────────────────────────────────────────────

type LibrarySnapshot = {
  userId:             string;
  items:              UserBook[];
  yearlyGoal:         number | null;
  hasGoodreadsImport: boolean | null;
  fetchedAt:          number;
};

let _libCache: LibrarySnapshot | null = null;
// _libItems survives bookData clears — keeps content visible during background refresh.
// Only nulled on sign-out so the user never sees a blank library after a book action.
let _libItems: UserBook[] | null = null;
// Prevents concurrent loadBooks calls when tabs are switched rapidly.
let _libLoading = false;
// IDs rendered in Phase 1. Phase 2 items sort within themselves but always land
// below Phase 1 items so already-visible rows never reshuffle mid-session.
// Reset at the start of each loadBooks() call and cleared on sign-out.
let _libPhase1Ids: Set<string> | null = null;
const LIB_STALE_MS = 60_000;
// Sign-out: clear everything including retained items
registerCacheClearer(() => { _libCache = null; _libItems = null; _libLoading = false; _libPhase1Ids = null; });
// Book action (status change, page update): invalidate fetch timing only.
// _libItems is kept so the library never full-page blanks on tab switch after a book action.
registerCacheClearer(() => { _libCache = null; }, 'bookData');

// ─── Screen ───────────────────────────────────────────────────────────────────

const VALID_FILTERS = new Set<FilterKey>(['all', 'want_to_read', 'reading', 'finished', 'dnf']);

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();
  const { initialFilter } = useLocalSearchParams<{ initialFilter?: string }>();
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => _libCache?.userId ?? null);
  const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');
  // Seed from _libItems first (survives bookData clears), then timing cache, then empty.
  const [items, setItems]                 = useState<UserBook[]>(() => _libItems ?? _libCache?.items ?? []);
  const [yearlyGoal, setYearlyGoal]       = useState<number | null>(() => _libCache?.yearlyGoal ?? null);
  // Full-page skeleton only when we have never successfully loaded — not on cache-timing invalidation.
  const [loading, setLoading]             = useState<boolean>(() => _libItems === null && _libCache === null);
  const [error, setError]                 = useState<string | null>(null);
  const [updatingId, setUpdatingId]       = useState<string | null>(null);
  const [pendingFeedback, setPendingFeedback]           = useState<PendingFeedback | null>(null);
  const [reasonEditingId, setReasonEditingId]           = useState<string | null>(null);
  // Quick-page-log state (inline progress update on reading cards)
  const [quickLogId, setQuickLogId]       = useState<string | null>(null);
  const [quickLogInput, setQuickLogInput] = useState('');
  const [quickLogSaving, setQuickLogSaving] = useState(false);
  const [quickLogError, setQuickLogError]   = useState<string | null>(null);
  const quickLogRef = useRef<TextInput>(null);
  const [pendingTasteUserBookId, setPendingTasteUserBookId] = useState<string | null>(null);
  const [likedTags, setLikedTags]                       = useState<string[]>([]);
  const [dislikedTags, setDislikedTags]                 = useState<string[]>([]);
  const [savingTaste, setSavingTaste]                   = useState(false);
  const [activeFilter, setActiveFilter]   = useState<FilterKey>(
    (initialFilter && VALID_FILTERS.has(initialFilter as FilterKey))
      ? (initialFilter as FilterKey)
      : 'all',
  );
  const [sort, setSort]                   = useState<SortKey>('recent');
  // Accordion state for Finished+chronological mode.
  // Starts empty (all years collapsed). User taps a year row to expand/collapse it.
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [hasGoodreadsImport, setHasGoodreadsImport] = useState<boolean | null>(() => _libCache?.hasGoodreadsImport ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput>(null);

  // ── Walkthrough target measurement ──────────────────────────────────────────
  // Measures the FlatList header (title + filter bar) once loading completes.
  // The overlay polls getWtTarget('library_content') and uses this rect to
  // position the spotlight aperture over the real library UI.
  // Profile was excluded from the walkthrough; library is the last list screen.

  const { wtStep } = useWalkthrough();
  const libTargetRef  = useRef<any>(null);
  const firstRowRef   = useRef<any>(null); // first visible book card/row
  const libEmptyRef   = useRef<any>(null); // import banner (no-books state)

  function measureLibContent() {
    // Priority 1 — first real book card/row (users who have books)
    // Priority 2 — import banner or empty CTA (users with no books)
    // Priority 3 — fallback: ListHeaderComponent wrapper
    const target = firstRowRef.current ?? libEmptyRef.current ?? libTargetRef.current;
    target?.measureInWindow((x: number, y: number, w: number, h: number) => {
      if (w > 0 && h > 0) {
        registerWtTarget('library_content', { x, y, width: w, height: h });
      }
    });
  }

  useEffect(() => {
    if (loading || wtStep !== 'library') return;
    const t = setTimeout(measureLibContent, 120);
    return () => clearTimeout(t);
  }, [loading, wtStep]);

  // Load persisted view mode on mount
  useEffect(() => {
    AsyncStorage.getItem(LIB_VIEW_MODE_KEY).then(val => {
      if (val === 'gallery' || val === 'list') setViewMode(val);
    });
  }, []);

  // Dev inspector — mounts __rs on globalThis for browser console access.
  // __rs.covers() / __rs.summaries() / __rs.credibility() / __rs.health() / __rs.all()
  useEffect(() => {
    if (!__DEV__ || !supabase) return;
    mountDevInspector(supabase);
  }, []);

  // Background cover enrichment for any book in this library load with no
  // cover_url. Fails quietly; updates local state as each cover resolves.
  async function backfillCovers(bookIds: string[]) {
    if (!supabase || bookIds.length === 0) return;
    const { data: books } = await supabase
      .from('books')
      .select('id, isbn13, isbn, title, author')
      .in('id', bookIds.slice(0, 30))
      .is('cover_url', null);
    for (const book of (books ?? [])) {
      try {
        const url = await fetchGoogleBooksCoverUrl({
          isbn13: (book as { isbn13?: string | null }).isbn13,
          isbn:   (book as { isbn?:   string | null }).isbn,
          title:  book.title  ?? '',
          author: book.author ?? '',
        });
        if (url) {
          await supabase.from('books').update({ cover_url: url }).eq('id', book.id);
          setItems(prev => prev.map(it =>
            it.book_id === book.id && it.book
              ? { ...it, book: { ...it.book, cover_url: url } }
              : it,
          ));
        }
      } catch {
        // fail quietly — a missing cover is never a blocker
      }
    }
  }

  async function loadBooks() {
    // Prevent concurrent fetches — rapid tab switches can trigger multiple mounts
    // before the first async load completes.
    if (_libLoading) return;
    _libLoading = true;
    _libPhase1Ids = null; // reset partition; Phase 2 of any prior load is now stale
    const t0 = Date.now();
    if (!supabase) { setError('Supabase not configured.'); setLoading(false); _libLoading = false; return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError('No signed-in user.'); setLoading(false); _libLoading = false; return; }
    if (_libCache && _libCache.userId !== user.id) { _libCache = null; _libItems = null; }
    setCurrentUserId(user.id);

    // ── Phase 1: first 50 books + profile in parallel ─────────────────────────
    // Paint immediately — user sees content in <2s regardless of library size.
    const [profileRes, primaryResult] = await Promise.all([
      supabase
        .from('profiles')
        .select('yearly_reading_goal')
        .eq('id', user.id)
        .single(),
      supabase
        .from('user_books')
        .select('id, book_id, status, started_at, finished_at, current_page, progress_updated_at, taste_tags, book:books(title, author, cover_url, external_id, page_count)')
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id',         { ascending: false })
        .range(0, 49),
    ]);

    setYearlyGoal(profileRes.data?.yearly_reading_goal ?? null);

    // Fallback: older schema without current_page / page_count columns
    let p1Result = primaryResult;
    let usedFallback = false;
    if (p1Result.error) {
      usedFallback = true;
      p1Result = await supabase
        .from('user_books')
        .select('id, book_id, status, started_at, finished_at, progress_updated_at, taste_tags, book:books(title, author, cover_url, external_id)')
        .eq('user_id', user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id',         { ascending: false })
        .range(0, 49);
    }

    if (p1Result.error) {
      setError('Could not load library.');
      setLoading(false);
      _libLoading = false;
      return;
    }

    const firstBatch = (p1Result.data as unknown as UserBook[]) ?? [];
    setItems(firstBatch);
    _libPhase1Ids = new Set(firstBatch.map(i => i.id));
    _libItems = firstBatch;
    _libCache = {
      userId:             user.id,
      items:              firstBatch,
      yearlyGoal:         profileRes.data?.yearly_reading_goal ?? null,
      hasGoodreadsImport: null,
      fetchedAt:          Date.now(),
    };
    setLoading(false);
    _libLoading = false;

    if (__DEV__) console.log(`[PERF] Library Phase 1: ${firstBatch.length} books in ${Date.now() - t0}ms`);

    // ── Phase 2: background — fetch remainder + enrichment ────────────────────
    // Runs silently after Phase 1 paints. Does NOT change loading state.
    // capturedFirst guards against a concurrent loadBooks call (e.g. pull-to-refresh)
    // overwriting a fresh first batch with stale remainder data.
    (async () => {
      try {
        const capturedFirst = firstBatch;
        let allItems = firstBatch;

        if (firstBatch.length === 50) {
          // May have more — fetch from offset 50 onwards
          let remResult = await supabase!
            .from('user_books')
            .select('id, book_id, status, started_at, finished_at, current_page, progress_updated_at, taste_tags, book:books(title, author, cover_url, external_id, page_count)')
            .eq('user_id', user.id)
            .is('deleted_at', null)
            .order('created_at', { ascending: false })
            .order('id',         { ascending: false })
            .range(50, 99999);

          if (remResult.error && !usedFallback) {
            remResult = await supabase!
              .from('user_books')
              .select('id, book_id, status, started_at, finished_at, progress_updated_at, taste_tags, book:books(title, author, cover_url, external_id)')
              .eq('user_id', user.id)
              .is('deleted_at', null)
              .order('created_at', { ascending: false })
              .order('id',         { ascending: false })
              .range(50, 99999);
          }

          if (!remResult.error && remResult.data?.length) {
            // Guard: abort if a newer loadBooks superseded this one
            if (_libItems !== capturedFirst) return;
            const remainder = remResult.data as unknown as UserBook[];
            // A book added between Phase 1 and Phase 2 queries can appear in both
            // batches (offset pagination shifts). Deduplicate so FlatList never
            // receives two rows with the same key.
            const phase1Set = new Set(firstBatch.map(i => i.id));
            allItems = [...firstBatch, ...remainder.filter(i => !phase1Set.has(i.id))];
            setItems(allItems);
            _libItems = allItems;
            if (__DEV__) console.log(`[PERF] Library Phase 2: ${allItems.length} total books in ${Date.now() - t0}ms`);
          }
        }

        // Guard: if a newer loadBooks ran and replaced _libItems, abort enrichment
        if (_libItems !== allItems) return;

        const missingCoverIds = [...new Set(
          allItems.filter(it => it.book && !it.book.cover_url).map(it => it.book_id),
        )];
        const allLibraryBookIds = [...new Set(
          allItems.filter(it => it.book_id).map(it => it.book_id),
        )];

        const [importedRes] = await Promise.all([
          supabase!
            .from('user_books')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .eq('import_source', 'goodreads'),
          backfillCovers(missingCoverIds),
          repairBooksMetadata(allLibraryBookIds, { cap: 30 }),
        ]);

        const goodreadsFlag = (importedRes.count ?? 0) > 0;
        setHasGoodreadsImport(goodreadsFlag);

        _libCache = {
          userId:             user.id,
          items:              allItems,
          yearlyGoal:         profileRes.data?.yearly_reading_goal ?? null,
          hasGoodreadsImport: goodreadsFlag,
          fetchedAt:          _libCache?.fetchedAt ?? Date.now(),
        };
      } catch {
        // Phase 2 fails silently — first batch is already visible
      }
    })();
  }

  useFocusEffect(useCallback(() => {
    // Skip if a fetch is already in progress (rapid tab switches can re-trigger this)
    if (_libLoading) return;
    // Skip re-fetch when cache is fresh — avoids showing stale-while-loading churn
    if (_libCache && Date.now() - _libCache.fetchedAt < LIB_STALE_MS) return;
    loadBooks();
  }, []));

  // ── Business logic (unchanged) ────────────────────────────────────────────

  function saveRating(userBookId: string, bookId: string, rating: number) {
    const eventId    = pendingFeedback?.pendingEventId ?? null;
    const wasFinish  = pendingFeedback?.status === 'finished'; // capture before clearing
    setPendingFeedback(null);
    if (!supabase || !currentUserId) return;
    const sentiment =
      rating >= 5 ? 'loved' :
      rating >= 4 ? 'liked' :
      rating === 3 ? 'okay' :
      'not_for_me';
    supabase.from('user_books').update({ rating, sentiment }).eq('id', userBookId).then(() => {});
    if (eventId) {
      supabase.from('activity_events').update({ rating }).eq('id', eventId).then(() => {});
    } else {
      supabase.from('activity_events').insert({
        actor_id:   currentUserId,
        event_type: 'book_rated',
        book_id:    bookId,
        rating,
      }).then(() => {});
    }
    if (currentUserId) triggerRecPrewarm(supabase, currentUserId);
    // Only offer taste capture for the finish flow — not DNF, want-to-read, or reading
    if (wasFinish) {
      setLikedTags([]);
      setDislikedTags([]);
      setPendingTasteUserBookId(userBookId);
    }
  }

  async function saveTasteTags() {
    // Capture everything synchronously before any state changes
    const rowId    = pendingTasteUserBookId;
    const liked    = likedTags;
    const disliked = dislikedTags;

    if (!supabase || !rowId) {
      if (__DEV__) console.warn('[taste_tags] Cannot save — supabase or rowId missing', { supabase: !!supabase, rowId });
      setPendingTasteUserBookId(null);
      setLikedTags([]);
      setDislikedTags([]);
      return;
    }

    setSavingTaste(true);
    const tags = { liked, didnt_work: disliked };

    if (__DEV__) {
      console.log('[taste_tags] row id:', rowId);
      console.log('[taste_tags] payload:', JSON.stringify(tags));
    }

    const { error } = await supabase
      .from('user_books')
      .update({ taste_tags: tags })
      .eq('id', rowId);

    if (__DEV__) {
      if (error) console.warn('[taste_tags] Supabase error:', error.message, error.code);
      else        console.log('[taste_tags] saved successfully');
    }

    if (!error && currentUserId) {
      triggerRecPrewarm(supabase, currentUserId);
    }
    // Reset state only AFTER the write completes
    setSavingTaste(false);
    setPendingTasteUserBookId(null);
    setLikedTags([]);
    setDislikedTags([]);
  }

  /**
   * Save (or skip) a DNF reason into taste_tags.dnf_reason.
   * Merges with any existing taste_tags so we never clobber liked/disliked tags.
   * Passing null reason = user tapped Skip.
   */
  async function saveDnfReason(userBookId: string, reason: string | null) {
    if (reason && supabase) {
      const existing = items.find(it => it.id === userBookId)?.taste_tags ?? {};
      const merged   = { ...existing, dnf_reason: reason };
      supabase
        .from('user_books')
        .update({ taste_tags: merged })
        .eq('id', userBookId)
        .then(({ error }) => {
          if (__DEV__) {
            if (error) console.warn('[DNF] reason save failed:', error.message);
            else        console.log('[DNF] reason saved:', reason);
          }
          if (!error) {
            setItems(prev =>
              prev.map(it =>
                it.id === userBookId
                  ? { ...it, taste_tags: merged }
                  : it,
              ),
            );
          }
        });
    }
    setPendingFeedback(null);
    setReasonEditingId(null);
  }

  async function handleUpdateStatus(userBook: UserBook, newStatus: UserBookStatus) {
    if (!supabase || !currentUserId) return;
    setUpdatingId(userBook.id);

    const { data, error: transErr } = await transitionStatus(supabase, {
      userBookId:         userBook.id,
      bookId:             userBook.book_id,
      userId:             currentUserId,
      newStatus,
      existingFinishedAt: userBook.finished_at,
    });

    if (transErr) {
      setError(transErr);
      setUpdatingId(null);
      return;
    }

    setItems(prev => prev.map(item =>
      item.id === userBook.id
        ? {
            ...item,
            status:      newStatus,
            started_at:  data?.startedAt  ?? item.started_at,
            finished_at: data?.finishedAt ?? item.finished_at,
          }
        : item
    ));

    if (newStatus === 'finished' || newStatus === 'dnf') {
      setPendingFeedback({
        userBookId:     userBook.id,
        bookId:         userBook.book_id,
        status:         newStatus,
        pendingEventId: data?.completionEventId ?? null,
      });
      if (newStatus === 'finished' && currentUserId) triggerRecPrewarm(supabase, currentUserId);
    }
    setUpdatingId(null);
  }

  async function handleQuickLog(item: UserBook) {
    if (!supabase || !currentUserId || !item.id) return;
    const newPage = parseInt(quickLogInput.trim(), 10);
    if (isNaN(newPage) || newPage < 0) {
      setQuickLogError('Enter a valid page number.');
      return;
    }
    if (item.book?.page_count && newPage > item.book.page_count) {
      setQuickLogError(`Can't exceed total pages (${item.book.page_count}).`);
      return;
    }
    setQuickLogError(null);
    setQuickLogSaving(true);
    const { error } = await saveCurrentPage(supabase, {
      userBookId:  item.id,
      bookId:      item.book_id,
      userId:      currentUserId,
      newPage,
      currentPage: item.current_page,
    });
    setQuickLogSaving(false);
    if (!error) {
      setItems(prev => prev.map(it =>
        it.id === item.id ? { ...it, current_page: newPage } : it
      ));
      setQuickLogId(null);
      setQuickLogInput('');
    } else {
      setQuickLogError(error);
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const searchActive     = searchQuery.trim().length > 0;
  const searchNormalized = searchQuery.toLowerCase().trim();
  const searchResults: UserBook[] = searchActive
    ? items.filter(item => {
        const title  = (item.book?.title  ?? '').toLowerCase();
        const author = (item.book?.author ?? '').toLowerCase();
        return title.includes(searchNormalized) || author.includes(searchNormalized);
      })
    : [];

  const readingCount  = items.filter(i => i.status === 'reading').length;
  const filteredItems = activeFilter === 'all' ? items : items.filter(i => i.status === activeFilter);

  // Sort + ordering:
  //   All filter    → reading first, then finished (finished_at desc), then want-to-read, then dnf.
  //   Reading filter + progress sort → sorted by page progress descending.
  //   Finished filter + finished_date (default) → sorted by finished_at descending (uses imported dates).
  //   Finished filter + recent → DB insertion order (created_at desc).
  //   All other cases → preserve DB order (created_at desc).
  //
  // Phase stability rule: Phase 1 items (IDs in _libPhase1Ids) always occupy the top
  // of their status group, sorted normally. Phase 2 items are sorted within themselves
  // but appended below Phase 1 items so no already-visible row reshuffles mid-session.
  // The boundary is erased on the next pull-to-refresh or cold load (full resort).

  // ── Series context maps — computed from ALL items for continuation detection ──────
  // _allSeriesCtx: itemId → { seriesName, seriesPosition } for catalog-matched books.
  // _seriesMaxPos: seriesName → highest reading/finished position seen in the library.
  // A want-to-read book is a "continuation" when the user has read an earlier book
  // in the same series (maxDone > 0 and the book's position > maxDone).
  const _allSeriesCtx = new Map<string, { seriesName: string; seriesPosition: number }>();
  const _seriesMaxPos = new Map<string, number>();
  for (const item of items) {
    const ctx = findSeriesForBook(item.book?.title ?? '', item.book?.author ?? '');
    if (!ctx) continue;
    _allSeriesCtx.set(item.id, ctx);
    if (item.status === 'reading' || item.status === 'finished') {
      const prev = _seriesMaxPos.get(ctx.seriesName) ?? 0;
      if (ctx.seriesPosition > prev) _seriesMaxPos.set(ctx.seriesName, ctx.seriesPosition);
    }
  }
  function seriesContinuationLabel(item: UserBook): string | null {
    if (item.status !== 'want_to_read') return null;
    const ctx = _allSeriesCtx.get(item.id);
    if (!ctx) return null;
    const maxDone = _seriesMaxPos.get(ctx.seriesName) ?? 0;
    if (maxDone === 0 || ctx.seriesPosition <= maxDone) return null;
    const catalog = getSeriesCatalog(ctx.seriesName);
    if (!catalog) return null;
    return `Book ${ctx.seriesPosition} · ${catalog.displayName}`;
  }
  function isSeriesContinuation(item: UserBook): boolean {
    return seriesContinuationLabel(item) !== null;
  }

  const displayedItems: ListItem[] = (() => {
    // When search is active: flat unified result list, no grouping
    if (searchActive) return searchResults;

    // Partition helpers — only active while a Phase 2 boundary exists.
    const p1ids = _libPhase1Ids;
    const p1 = p1ids ? filteredItems.filter(i =>  p1ids.has(i.id)) : filteredItems;
    const p2 = p1ids ? filteredItems.filter(i => !p1ids.has(i.id)) : [];

    const byRecent   = (arr: UserBook[]) => [...arr].sort((a, b) => {
      const aDate = a.progress_updated_at ?? a.started_at ?? '';
      const bDate = b.progress_updated_at ?? b.started_at ?? '';
      return bDate.localeCompare(aDate);
    });
    const byFinished = (arr: UserBook[]) => [...arr].sort((a, b) => {
      if (a.finished_at && b.finished_at) return b.finished_at.localeCompare(a.finished_at);
      if (a.finished_at) return -1;
      if (b.finished_at) return 1;
      return 0;
    });
    const byProgress = (arr: UserBook[]) => [...arr].sort((a, b) => {
      const pA = a.current_page != null && a.book?.page_count ? a.current_page / a.book.page_count : 0;
      const pB = b.current_page != null && b.book?.page_count ? b.current_page / b.book.page_count : 0;
      return pB - pA;
    });

    if (activeFilter === 'all') {
      // Order: reading → want-to-read (intent) → finished (history) → set aside.
      // Intent before history: the backlog is more actionable than completed books.
      // Each group gets a SectionSeparator header; groups with 0 items are skipped.
      const readingItems: UserBook[] = [
        ...byRecent(p1.filter(i => i.status === 'reading')),
        ...byRecent(p2.filter(i => i.status === 'reading')),
      ];
      const wtrItems: UserBook[] = [
        ...p1.filter(i => i.status === 'want_to_read'),
        ...p2.filter(i => i.status === 'want_to_read'),
      ];
      const finishedItems: UserBook[] = [
        ...byFinished(p1.filter(i => i.status === 'finished')),
        ...byFinished(p2.filter(i => i.status === 'finished')),
      ];
      const dnfItems: UserBook[] = [
        ...p1.filter(i => i.status === 'dnf'),
        ...p2.filter(i => i.status === 'dnf'),
      ];
      const result: ListItem[] = [...readingItems];
      if (wtrItems.length > 0) {
        result.push({ __type: 'section_separator', key: 'sep_wtr', title: 'Want to Read' });
        result.push(...wtrItems);
      }
      if (finishedItems.length > 0) {
        result.push({ __type: 'section_separator', key: 'sep_finished', title: 'Finished', muted: true });
        result.push(...finishedItems);
      }
      if (dnfItems.length > 0) {
        result.push({ __type: 'section_separator', key: 'sep_set_aside', title: 'Set Aside', subtitle: "Books that didn't land right now" });
        result.push(...dnfItems);
      }
      return result;
    }
    if (activeFilter === 'reading' && sort === 'recent') {
      return [...byRecent(p1), ...byRecent(p2)];
    }
    if (activeFilter === 'reading' && sort === 'progress') {
      return [...byProgress(p1), ...byProgress(p2)];
    }
    if (activeFilter === 'want_to_read') {
      // Surface series continuations at the top so the next book in an in-progress
      // series is never buried under unrelated backlog items.
      const all: UserBook[] = [
        ...p1.filter(i => i.status === 'want_to_read'),
        ...p2.filter(i => i.status === 'want_to_read'),
      ];
      const continuations = all.filter(i => isSeriesContinuation(i));
      const shelf         = all.filter(i => !isSeriesContinuation(i));
      if (continuations.length === 0) return all;
      const result: ListItem[] = [
        { __type: 'section_separator', key: 'sep_continue', title: 'Continue Reading', subtitle: 'Next in a series you started' },
        ...continuations,
      ];
      if (shelf.length > 0) {
        result.push({ __type: 'section_separator', key: 'sep_shelf', title: 'On Your Shelf', muted: true });
        result.push(...shelf);
      }
      return result;
    }
    if (activeFilter === 'finished' && sort === 'finished_date') {
      // Full sort here: year-separator groups span both phases, so we need a single
      // ordered array to avoid duplicate year headers. One-time reorder on Phase 2
      // append is acceptable for an explicitly-selected filter.
      return buildGroupedFinished(byFinished(filteredItems), expandedYears);
    }
    return filteredItems;
  })();

  const statusCounts: Record<FilterKey, number> = {
    all:          items.length,
    reading:      readingCount,
    want_to_read: items.filter(i => i.status === 'want_to_read').length,
    finished:     items.filter(i => i.status === 'finished').length,
    dnf:          items.filter(i => i.status === 'dnf').length,
  };

  const contextSubtitle = (() => {
    if (items.length === 0) return null;
    const parts: string[] = [];
    if (readingCount > 0) parts.push(`${readingCount} reading`);
    parts.push(`${items.length} book${items.length !== 1 ? 's' : ''} total`);
    return parts.join(' · ');
  })();

  const avgPace: number | null = (() => {
    const finished = items.filter(i => i.status === 'finished');
    return computeUserAvgPace(
      finished.map(i => ({
        started_at:  i.started_at,
        finished_at: i.finished_at,
        pageCount:   i.book?.page_count,
      }))
    );
  })();

  // ── Loading / error ───────────────────────────────────────────────────────

  if (loading) {
    return <LibraryScreenSkeleton />;
  }

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: '#f5f1ec', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14, marginBottom: 18 }}>{error}</Text>
        <TouchableOpacity
          onPress={() => { setError(null); setLoading(true); loadBooks(); }}
          style={{ backgroundColor: '#231f1b', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 24 }}
        >
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  async function handleRefresh() {
    setRefreshing(true);
    await loadBooks();
    setRefreshing(false);
  }

  if (wtStep === 'library') return <WtDemoLibrary />;

  const libraryHeaderEl = (
        <View ref={libTargetRef} style={{ paddingTop: insets.top + 8 }}>
          {/* ── Hero header ── */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginBottom: 4 }}>
            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize: 32,
                fontWeight: '800',
                color: '#231f1b',
                letterSpacing: -1,
                lineHeight: 38,
              }}>Library</Text>
              <Text style={{ fontSize: 12, color: '#9e958d', fontWeight: '500', marginTop: 3 }}>
                {items.length > 0 ? `${items.length} book${items.length === 1 ? '' : 's'}` : ''}
              </Text>
              <View style={{ width: 28, height: 2.5, backgroundColor: '#7b9e7e', marginTop: 10, borderRadius: 2 }} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {/* View mode toggle */}
              {items.length > 0 && !searchActive && (
                <TouchableOpacity
                  onPress={() => {
                    const next = viewMode === 'list' ? 'gallery' : 'list';
                    setViewMode(next);
                    AsyncStorage.setItem(LIB_VIEW_MODE_KEY, next);
                  }}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    borderWidth: 1,
                    borderColor: '#ede9e4',
                    backgroundColor: viewMode === 'gallery' ? '#231f1b' : '#fefcf9',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Ionicons
                    name={viewMode === 'gallery' ? 'list' : 'grid-outline'}
                    size={16}
                    color={viewMode === 'gallery' ? '#f5f1ec' : '#78716c'}
                  />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => router.push('/add-book')}
                style={{
                  flexDirection:    'row',
                  alignItems:       'center',
                  backgroundColor:  '#231f1b',
                  borderRadius:     20,
                  paddingHorizontal: 16,
                  paddingVertical:  9,
                }}
              >
                <Text style={{ color: '#f5f1ec', fontSize: 13, fontWeight: '700', letterSpacing: 0.2 }}>+ Add book</Text>
              </TouchableOpacity>
            </View>
          </View>
          {/* ── Search bar ── */}
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => searchInputRef.current?.focus()}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              borderWidth: 1,
              borderColor: '#ede9e4',
              paddingHorizontal: 13,
              paddingVertical: 11,
              marginTop: 16,
              marginBottom: 14,
              gap: 8,
            }}
          >
            <Ionicons name="search-outline" size={16} color="#9e958d" />
            <TextInput
              ref={searchInputRef}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search your library"
              placeholderTextColor="#c4b5a5"
              style={{ flex: 1, fontSize: 14, color: '#231f1b', padding: 0 }}
              returnKeyType="search"
              onSubmitEditing={() => Keyboard.dismiss()}
            />
            {searchActive && (
              <TouchableOpacity
                hitSlop={10}
                onPress={() => { setSearchQuery(''); searchInputRef.current?.blur(); }}
              >
                <Ionicons name="close-circle" size={17} color="#c4b5a5" />
              </TouchableOpacity>
            )}
          </TouchableOpacity>

          {!searchActive && contextSubtitle && (
            <Text style={{ fontSize: 13, color: '#9e958d', marginBottom: 18 }}>
              {contextSubtitle}
            </Text>
          )}

          {/* ── Filter chip bar ── */}
          {!searchActive && items.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginHorizontal: -20 }}
              contentContainerStyle={{
                paddingHorizontal: 20,
                paddingBottom: 14,
                flexDirection: 'row',
                gap: 8,
              }}
            >
              {FILTER_OPTIONS.map(f => {
                const active = activeFilter === f.key;
                const count  = f.key !== 'all' && statusCounts[f.key] > 0 ? ` (${statusCounts[f.key]})` : '';
                const readingAccent = f.key === 'reading' && !active && readingCount > 0;
                return (
                  <TouchableOpacity
                    key={f.key}
                    onPress={() => {
                      setActiveFilter(f.key);
                      if (f.key === 'finished') setSort('finished_date');
                      else setSort('recent');
                    }}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      borderRadius: 20,
                      borderWidth: 1,
                      backgroundColor: active ? '#7b9e7e' : readingAccent ? '#e6f0e6' : 'transparent',
                      borderColor:     active ? '#7b9e7e' : readingAccent ? '#a8d0aa' : '#ede9e4',
                    }}
                  >
                    <Text style={{
                      fontSize: 13,
                      fontWeight: active ? '600' : '400',
                      color: active ? '#fff' : '#6b635c',
                    }}>
                      {f.label}{count}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* ── Goodreads import banner (shown for users with books who haven't imported) ── */}
          {hasGoodreadsImport === false && items.length > 0 && (
            <TouchableOpacity
              ref={libEmptyRef}
              onPress={() => router.push('/import/goodreads')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: '#fefcf9',
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                marginBottom: 14,
                borderWidth: 1,
                borderColor: '#ede9e4',
              }}
            >
              <Text style={{ fontSize: 16, marginRight: 10 }}>⤵</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#231f1b' }}>
                  Import your library
                </Text>
                <Text style={{ fontSize: 12, color: '#9e958d', marginTop: 1 }}>
                  Bring in your reading history to improve recommendations.
                </Text>
              </View>
              <Text style={{ fontSize: 16, color: '#ede9e4' }}>›</Text>
            </TouchableOpacity>
          )}

          {/* ── Sort toggle (Reading: 2+ books; Finished: 2+ books) ── */}
          {!searchActive && filteredItems.length > 1 && (activeFilter === 'reading' || activeFilter === 'finished') && (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingBottom: 10,
            }}>
              <Text style={{ fontSize: 11, color: '#c4b5a5', marginRight: 8 }}>Sort</Text>
              {activeFilter === 'reading' ? (
                <>
                  <TouchableOpacity onPress={() => setSort('recent')}>
                    <Text style={{
                      fontSize: 12,
                      color: sort === 'recent' ? '#231f1b' : '#9e958d',
                      fontWeight: sort === 'recent' ? '600' : '400',
                    }}>Recent</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, color: '#ede9e4', marginHorizontal: 8 }}>·</Text>
                  <TouchableOpacity onPress={() => setSort('progress')}>
                    <Text style={{
                      fontSize: 12,
                      color: sort === 'progress' ? '#231f1b' : '#9e958d',
                      fontWeight: sort === 'progress' ? '600' : '400',
                    }}>Progress</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity onPress={() => setSort('finished_date')}>
                    <Text style={{
                      fontSize: 12,
                      color: sort === 'finished_date' ? '#231f1b' : '#9e958d',
                      fontWeight: sort === 'finished_date' ? '600' : '400',
                    }}>Finished</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, color: '#ede9e4', marginHorizontal: 8 }}>·</Text>
                  <TouchableOpacity onPress={() => setSort('recent')}>
                    <Text style={{
                      fontSize: 12,
                      color: sort === 'recent' ? '#231f1b' : '#9e958d',
                      fontWeight: sort === 'recent' ? '600' : '400',
                    }}>Added</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}

          {/* ── Avg pace summary (finished filter only) ── */}
          {!searchActive && activeFilter === 'finished' && avgPace !== null && (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingBottom: 12,
            }}>
              <Text style={{ fontSize: 12, color: '#9e958d' }}>
                Your reading pace · avg <Text style={{ color: '#78716c', fontWeight: '600' }}>{avgPace} pages/day</Text>
              </Text>
            </View>
          )}

          {/* ── Divider ── */}
          {!searchActive && items.length > 0 && activeFilter !== 'reading' && (
            <View style={{ height: 1, backgroundColor: '#ede9e4' }} />
          )}
        </View>
  );

  const refreshCtrl = (
    <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
    {viewMode === 'gallery' && !searchActive ? (
      <LibraryGalleryView
        books={filteredItems}
        filter={activeFilter}
        sort={sort}
        screenWidth={screenWidth}
        ListHeaderComponent={libraryHeaderEl}
        refreshControl={refreshCtrl}
        emptyComponent={
          items.length === 0 ? (
            <View style={{ paddingTop: 36, paddingHorizontal: 24, alignItems: 'center' }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: '#231f1b', marginBottom: 8, textAlign: 'center' }}>
                {FILTER_EMPTY.all.title}
              </Text>
              <Text style={{ fontSize: 14, color: '#9e958d', textAlign: 'center', lineHeight: 22, marginBottom: 24 }}>
                {FILTER_EMPTY.all.body}
              </Text>
              <TouchableOpacity
                onPress={() => router.push('/add-book')}
                style={{ backgroundColor: '#231f1b', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 26 }}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Add your first book</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ paddingTop: 48, paddingHorizontal: 24, alignItems: 'center' }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#231f1b', marginBottom: 8, textAlign: 'center' }}>
                {FILTER_EMPTY[activeFilter].title}
              </Text>
              <Text style={{ fontSize: 14, color: '#9e958d', textAlign: 'center', lineHeight: 22 }}>
                {FILTER_EMPTY[activeFilter].body}
              </Text>
            </View>
          )
        }
      />
    ) : (
    <FlatList
      data={displayedItems}
      keyExtractor={item => isYearSeparator(item) ? item.key : isSectionSeparator(item) ? item.key : item.id}
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 0, paddingBottom: 40 }}
      refreshControl={refreshCtrl}
      ListHeaderComponent={libraryHeaderEl}
      renderItem={({ item, index }) => {
        // ── Section separator header (Want to Read / Finished / Set Aside / Continue Reading / On Your Shelf) ──
        if (isSectionSeparator(item)) {
          return (
            <View style={{ paddingTop: index === 0 ? 10 : 22, paddingBottom: 6 }}>
              <Text style={{
                fontSize: 11, fontWeight: '700',
                color: item.muted ? '#c4b5a5' : '#9e958d',
                letterSpacing: 1, textTransform: 'uppercase',
              }}>
                {item.title}
              </Text>
              {item.subtitle ? (
                <Text style={{ fontSize: 12, color: '#c4b5a5', marginTop: 3 }}>
                  {item.subtitle}
                </Text>
              ) : null}
            </View>
          );
        }

        // ── Year-group accordion header ──────────────────────────────────────
        if (isYearSeparator(item)) {
          const isExpanded = expandedYears.has(item.year);
          return (
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() =>
                setExpandedYears(prev => {
                  const next = new Set(prev);
                  if (next.has(item.year)) next.delete(item.year);
                  else next.add(item.year);
                  return next;
                })
              }
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 14,
                marginTop: index === 0 ? 4 : 6,
                borderBottomWidth: 1,
                borderBottomColor: '#ede9e4',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#231f1b', letterSpacing: -0.2 }}>
                {item.year}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 12, color: '#9e958d' }}>
                  {item.count} {item.count === 1 ? 'book' : 'books'}
                </Text>
                <Text style={{ fontSize: 14, color: '#9e958d' }}>
                  {isExpanded ? '▾' : '›'}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }

        const isUpdating = updatingId === item.id;
        const isBlocked  = updatingId !== null;
        const isReading  = item.status === 'reading';
        const badge      = STATUS_BADGE[item.status];
        const hasButtons = item.status === 'want_to_read' || item.status === 'reading' || item.status === 'dnf';

        const hasProgress =
          isReading &&
          item.current_page != null && item.current_page > 0 &&
          item.book?.page_count != null && item.book.page_count > 0;
        const progressPct = hasProgress
          ? Math.min(100, Math.round((item.current_page! / item.book!.page_count!) * 100))
          : null;

        const hasPendingRating = pendingFeedback?.userBookId === item.id;
        const hasExtraRow      = hasButtons || isUpdating || hasPendingRating;

        const hasNonReading        = displayedItems.length > readingCount;
        const showNowReadingHeader = activeFilter === 'all' && index === 0 && isReading && hasNonReading;

        // ── Reading row: card style with pacing-state border ──────────────
        if (isReading) {
          const pageCount = item.book?.page_count;
          const borderPacing = (yearlyGoal && pageCount && pageCount > 0)
            ? computePagePacing(item.current_page ?? 0, pageCount, item.started_at, yearlyGoal)
            : null;
          const datePacing = (!hasProgress && item.started_at && yearlyGoal)
            ? computeDatePacing(item.started_at, yearlyGoal)
            : null;

          const accentColor = (() => {
            if (!borderPacing) return '#ede9e4';
            const s = borderPacing.state;
            if (s === 'ahead' || s === 'on_pace') return '#86efac';
            if (s === 'behind') return '#fcd34d';
            return '#ede9e4';
          })();
          const pacingNote     = hasProgress ? borderPacing?.note ?? null : datePacing?.note ?? null;
          const lastUpdatedText = formatLastUpdated(item.progress_updated_at);
          const readState = inferReadState({
            status:            item.status,
            progressUpdatedAt: item.progress_updated_at,
            startedAt:         item.started_at,
            currentPage:       item.current_page,
          });

          return (
            <View>
              {showNowReadingHeader && (
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 1, textTransform: 'uppercase', marginTop: 10, marginBottom: 8 }}>
                  Currently Reading
                </Text>
              )}
              <View
                ref={wtStep === 'library' && index === 0 ? firstRowRef : undefined}
                style={{
                backgroundColor: '#fefcf9',
                borderRadius: 14,
                marginVertical: 6,
                borderLeftWidth: 3,
                borderLeftColor: accentColor,
                shadowColor: '#000',
                shadowOpacity: 0.05,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
                elevation: 2,
                paddingTop: 14,
                paddingRight: 14,
                paddingBottom: hasExtraRow ? 12 : 14,
                paddingLeft: 14,
              }}>
              {/* Cover + title/author/progress */}
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  const seriesCtx = findSeriesForBook(item.book?.title ?? '', item.book?.author ?? '');
                  router.push({
                    pathname: '/book/[id]',
                    params: {
                      id:         item.book_id,
                      title:      item.book?.title ?? '',
                      author:     item.book?.author ?? '',
                      coverUrl:   item.book?.cover_url ?? '',
                      externalId: item.book?.external_id ?? '',
                      status:     item.status,
                      startedAt:  item.started_at ?? '',
                      ...(seriesCtx ? {
                        seriesName:     seriesCtx.seriesName,
                        seriesPosition: String(seriesCtx.seriesPosition),
                      } : {}),
                    },
                  });
                }}
                style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: hasExtraRow ? 12 : 0 }}
              >
                <CoverThumb
                  url={item.book?.cover_url}
                  externalId={item.book?.external_id}
                  title={item.book?.title}
                  width={48}
                  height={70}
                />
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <Text style={{ fontWeight: '700', fontSize: 16, color: '#231f1b', marginBottom: 3, lineHeight: 22 }}>
                    {item.book?.title ?? '—'}
                  </Text>
                  <Text style={{ color: '#78716c', fontSize: 13, marginBottom: hasProgress ? 12 : 0 }}>
                    {item.book?.author ?? '—'}
                  </Text>
                  {hasProgress && (
                    <>
                      <View style={{
                        height: 4,
                        backgroundColor: '#ede9e4',
                        borderRadius: 2,
                        overflow: 'hidden',
                        marginBottom: 5,
                      }}>
                        <View style={{
                          height: 4,
                          width: `${progressPct ?? 0}%`,
                          backgroundColor: '#231f1b',
                          borderRadius: 2,
                        }} />
                      </View>
                      <Text style={{ fontSize: 11, color: '#57534e', fontWeight: '500' }}>
                        Page {item.current_page} of {item.book?.page_count} · {progressPct}%
                      </Text>
                      {pacingNote && (
                        <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 2 }}>
                          {pacingNote}
                        </Text>
                      )}
                    </>
                  )}
                  {!hasProgress && item.status === 'reading' && (
                    <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 6 }}>
                      {pacingNote ? pacingNote : 'In progress'}
                    </Text>
                  )}
                  {lastUpdatedText && (
                    <Text style={{ fontSize: 11, color: '#c4b5a5', marginTop: 4 }}>
                      {lastUpdatedText}
                    </Text>
                  )}
                  {readState === 'stalled' && (
                    <Text style={{ fontSize: 11, color: '#b08d57', marginTop: 3, fontStyle: 'italic' }}>
                      Stalled — been a while
                    </Text>
                  )}
                  {readState === 'paused' && (
                    <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 3, fontStyle: 'italic' }}>
                      Paused for now
                    </Text>
                  )}
                </View>
              </TouchableOpacity>

              {/* Unified action area */}
              {hasPendingRating && pendingFeedback?.status === 'dnf' ? (
                <DnfReasonChips
                  onSelect={r => saveDnfReason(item.id, r)}
                  onSkip={() => setPendingFeedback(null)}
                />
              ) : hasPendingRating ? (
                <View style={{ marginTop: 2 }}>
                  <Text style={{ fontSize: 11, color: '#78716c', marginBottom: 8 }}>How would you rate it?</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {[1, 2, 3, 4, 5].map(n => (
                      <TouchableOpacity
                        key={n}
                        onPress={() => saveRating(item.id, item.book_id, n)}
                        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                        style={{ paddingHorizontal: 3, paddingVertical: 2 }}
                      >
                        <Text style={{ fontSize: 30, color: '#f59e0b' }}>★</Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity onPress={() => setPendingFeedback(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={{ fontSize: 12, color: '#9e958d', marginLeft: 12 }}>Skip</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : isUpdating ? (
                <ActivityIndicator color="#78716c" style={{ alignSelf: 'flex-start' }} />
              ) : quickLogId === item.id ? (
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <TextInput
                      ref={quickLogRef}
                      value={quickLogInput}
                      onChangeText={setQuickLogInput}
                      keyboardType="number-pad"
                      placeholder={item.current_page != null ? String(item.current_page) : '0'}
                      placeholderTextColor="#9e958d"
                      returnKeyType="done"
                      onSubmitEditing={() => handleQuickLog(item)}
                      style={{
                        width: 72,
                        height: 40,
                        borderWidth: 1.5,
                        borderColor: '#ede9e4',
                        borderRadius: 10,
                        paddingHorizontal: 10,
                        fontSize: 15,
                        fontWeight: '700',
                        color: '#231f1b',
                        textAlign: 'center',
                      }}
                    />
                    {item.book?.page_count != null && (
                      <Text style={{ fontSize: 12, color: '#9e958d' }}>
                        of {item.book.page_count}
                      </Text>
                    )}
                    <TouchableOpacity
                      onPress={() => handleQuickLog(item)}
                      disabled={quickLogSaving}
                      style={{
                        backgroundColor: quickLogSaving ? '#ede9e4' : '#231f1b',
                        borderRadius: 10,
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                        {quickLogSaving ? '…' : 'Save'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { setQuickLogId(null); setQuickLogError(null); }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={{ fontSize: 13, color: '#9e958d' }}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                  {quickLogError && (
                    <Text style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>
                      {quickLogError}
                    </Text>
                  )}
                </View>
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => {
                      setQuickLogInput(item.current_page != null ? String(item.current_page) : '');
                      setQuickLogError(null);
                      setQuickLogId(item.id);
                      setTimeout(() => quickLogRef.current?.focus(), 60);
                    }}
                    disabled={isBlocked}
                    style={{
                      flex: 1,
                      backgroundColor: isBlocked ? '#ede9e4' : '#231f1b',
                      borderRadius: 10,
                      paddingVertical: 10,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                      {item.current_page != null ? 'Update pages' : 'Log pages'}
                    </Text>
                  </TouchableOpacity>
                  <OutlineButton label="Finished" onPress={() => handleUpdateStatus(item, 'finished')} disabled={isBlocked} />
                  <DangerButton  label="Set aside" onPress={() => handleUpdateStatus(item, 'dnf')}      disabled={isBlocked} />
                </View>
              )}
            </View>
          </View>
          );
        }

        // ── Non-reading row: flat archival style ─────────────────────────────
        return (
          <View>
            <View
              ref={wtStep === 'library' && index === 0 ? firstRowRef : undefined}
              style={{
              paddingTop: 18,
              paddingBottom: hasExtraRow ? 14 : 18,
              borderBottomWidth: 1,
              borderBottomColor: '#ede9e4',
            }}>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => {
                const seriesCtx = findSeriesForBook(item.book?.title ?? '', item.book?.author ?? '');
                router.push({
                  pathname: '/book/[id]',
                  params: {
                    id:         item.book_id,
                    title:      item.book?.title ?? '',
                    author:     item.book?.author ?? '',
                    coverUrl:   item.book?.cover_url ?? '',
                    externalId: item.book?.external_id ?? '',
                    status:     item.status,
                    startedAt:  item.started_at ?? '',
                    ...(seriesCtx ? {
                      seriesName:     seriesCtx.seriesName,
                      seriesPosition: String(seriesCtx.seriesPosition),
                    } : {}),
                  },
                });
              }}
              style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: hasExtraRow ? 10 : 0 }}
            >
              <CoverThumb
                url={item.book?.cover_url}
                externalId={item.book?.external_id}
                title={item.book?.title}
                width={44}
                height={64}
              />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={{ fontWeight: '700', fontSize: 16, color: '#231f1b', marginBottom: 3 }}>
                      {item.book?.title ?? '—'}
                    </Text>
                    <Text style={{ color: '#78716c', fontSize: 13 }}>
                      {item.book?.author ?? '—'}
                    </Text>
                    {(() => {
                      const label = seriesContinuationLabel(item);
                      return label ? (
                        <Text style={{ fontSize: 11, color: '#7b9e7e', marginTop: 3, fontWeight: '500' }}>
                          {label}
                        </Text>
                      ) : null;
                    })()}
                    {item.finished_at && (item.status === 'finished' || item.status === 'dnf') && (
                      <Text style={{ fontSize: 11, color: '#c4b5a5', marginTop: 3 }}>
                        {new Date(item.finished_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </Text>
                    )}
                    {item.status === 'dnf' && reasonEditingId !== item.id && (
                      item.taste_tags?.dnf_reason ? (
                        <TouchableOpacity
                          onPress={() => setReasonEditingId(item.id)}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, alignSelf: 'flex-start' }}
                        >
                          <View style={{ backgroundColor: '#ede9e4', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 3 }}>
                            <Text style={{ fontSize: 11, color: '#6b635c' }}>
                              {DNF_REASON_LABELS[item.taste_tags.dnf_reason as string] ?? item.taste_tags.dnf_reason}
                            </Text>
                          </View>
                          <Text style={{ fontSize: 11, color: '#c4b5a5', marginLeft: 7 }}>change</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          onPress={() => setReasonEditingId(item.id)}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          style={{ marginTop: 6 }}
                        >
                          <Text style={{ fontSize: 11, color: '#c4b5a5', fontStyle: 'italic' }}>Add a note</Text>
                        </TouchableOpacity>
                      )
                    )}
                    {item.status === 'finished' && (() => {
                      const bp = computeBookPace(item.started_at, item.finished_at, item.book?.page_count);
                      if (!bp) return null;
                      return (
                        <Text style={{ fontSize: 11, color: '#9e958d', marginTop: 2 }}>
                          {formatPaceChip(bp.pagesPerDay, bp.daysToFinish)}
                        </Text>
                      );
                    })()}
                  </View>
                  <View style={{
                    backgroundColor: badge.bg, borderRadius: 6,
                    paddingHorizontal: 9, paddingVertical: 4, alignSelf: 'flex-start',
                  }}>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: badge.text }}>
                      {STATUS_LABELS[item.status]}
                    </Text>
                  </View>
                </View>
              </View>
            </TouchableOpacity>

            {hasPendingRating && pendingFeedback?.status === 'dnf' ? (
              <View style={{ marginLeft: 58, marginTop: 6 }}>
                <DnfReasonChips
                  onSelect={r => saveDnfReason(item.id, r)}
                  onSkip={() => setPendingFeedback(null)}
                />
              </View>
            ) : hasPendingRating ? (
              <View style={{ marginLeft: 58, marginTop: 6 }}>
                <Text style={{ fontSize: 11, color: '#78716c', marginBottom: 8 }}>How would you rate it?</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  {[1, 2, 3, 4, 5].map(n => (
                    <TouchableOpacity
                      key={n}
                      onPress={() => saveRating(item.id, item.book_id, n)}
                      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                      style={{ paddingHorizontal: 3, paddingVertical: 2 }}
                    >
                      <Text style={{ fontSize: 30, color: '#f59e0b' }}>★</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity onPress={() => setPendingFeedback(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={{ fontSize: 12, color: '#9e958d', marginLeft: 12 }}>Skip</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : isUpdating ? (
              <ActivityIndicator color="#78716c" style={{ alignSelf: 'flex-start', marginLeft: 58 }} />
            ) : item.status === 'want_to_read' ? (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginLeft: 58 }}>
                <PrimaryButton label="Start Reading" onPress={() => handleUpdateStatus(item, 'reading')}  disabled={isBlocked} />
                <OutlineButton label="Mark Finished" onPress={() => handleUpdateStatus(item, 'finished')} disabled={isBlocked} />
                <DangerButton  label="Set aside"      onPress={() => handleUpdateStatus(item, 'dnf')}      disabled={isBlocked} />
              </View>
            ) : item.status === 'dnf' ? (
              reasonEditingId === item.id ? (
                <View style={{ marginLeft: 58, marginTop: 6 }}>
                  <DnfReasonChips
                    onSelect={r => { saveDnfReason(item.id, r); setReasonEditingId(null); }}
                    onSkip={() => setReasonEditingId(null)}
                  />
                </View>
              ) : (
                <View style={{ marginLeft: 58, marginTop: 6 }}>
                  <OutlineButton label="Pick up again" onPress={() => handleUpdateStatus(item, 'want_to_read')} disabled={isBlocked} />
                </View>
              )
            ) : null}
          </View>
        </View>
        );
      }}
      ListEmptyComponent={
        searchActive ? (
          <View style={{ paddingTop: 60, paddingHorizontal: 24, alignItems: 'center' }}>
            <Ionicons name="search-outline" size={32} color="#c4b5a5" style={{ marginBottom: 12 }} />
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#231f1b', marginBottom: 6, textAlign: 'center' }}>
              Not in your library
            </Text>
            <Text style={{ fontSize: 14, color: '#9e958d', textAlign: 'center', lineHeight: 21, marginBottom: 24 }}>
              Nothing matching <Text style={{ color: '#231f1b', fontStyle: 'italic' }}>"{searchQuery.trim()}"</Text>{' '}
              was found in your library.
            </Text>
            <TouchableOpacity
              onPress={() => { setSearchQuery(''); router.push('/add-book'); }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: '#231f1b',
                borderRadius: 12,
                paddingVertical: 13,
                paddingHorizontal: 22,
              }}
            >
              <Ionicons name="search-outline" size={14} color="#f5f1ec" />
              <Text style={{ color: '#f5f1ec', fontSize: 14, fontWeight: '700' }}>Search all books to add it</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 && activeFilter === 'all' ? (
          <View ref={libEmptyRef} style={{ paddingTop: 36, paddingHorizontal: 24 }}>
            {/* Heading + value prop */}
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#231f1b', marginBottom: 8, letterSpacing: -0.4 }}>
              Start your library
            </Text>
            <Text style={{ color: '#78716c', fontSize: 14, lineHeight: 22, marginBottom: 28 }}>
              Your reading history powers your recommendations. The more readstack knows, the better your picks get.
            </Text>

            {/* Primary CTA */}
            <TouchableOpacity
              onPress={() => router.push('/import/goodreads')}
              style={{
                width: '100%',
                backgroundColor: '#231f1b',
                borderRadius: 12,
                paddingVertical: 15,
                alignItems: 'center',
                marginBottom: 20,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>Import from Goodreads</Text>
              <Text style={{ color: '#9e958d', fontSize: 12, marginTop: 3 }}>Brings in your full reading history at once</Text>
            </TouchableOpacity>

            {/* Platform guidance panel */}
            <View style={{
              borderWidth: 1,
              borderColor: '#ede9e4',
              borderRadius: 12,
              overflow: 'hidden',
              marginBottom: 16,
            }}>
              <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#ede9e4', backgroundColor: '#f5f1ec' }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.6, textTransform: 'uppercase' }}>
                  Where do you track books?
                </Text>
              </View>

              {/* Goodreads row */}
              <TouchableOpacity
                onPress={() => router.push('/import/goodreads')}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#ede9e4', backgroundColor: '#fefcf9' }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b' }}>Goodreads</Text>
                  <Text style={{ fontSize: 12, color: '#78716c', marginTop: 1 }}>Import your full library — live now</Text>
                </View>
                <View style={{ backgroundColor: '#dcfce7', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#15803d' }}>Supported</Text>
                </View>
                <Text style={{ fontSize: 16, color: '#ede9e4' }}>›</Text>
              </TouchableOpacity>

              {/* StoryGraph row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#ede9e4', backgroundColor: '#fefcf9' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b' }}>StoryGraph</Text>
                  <Text style={{ fontSize: 12, color: '#78716c', marginTop: 1, lineHeight: 17 }}>
                    Export your library from StoryGraph, then add your books manually below for now. Direct import is on the roadmap.
                  </Text>
                </View>
                <View style={{ backgroundColor: '#fef9c3', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginLeft: 10, alignSelf: 'flex-start', marginTop: 2 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#92400e' }}>Coming soon</Text>
                </View>
              </View>

              {/* Other sources row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13, backgroundColor: '#fefcf9' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b' }}>Elsewhere</Text>
                  <Text style={{ fontSize: 12, color: '#78716c', marginTop: 1 }}>Track books in Libby, Amazon, or a spreadsheet? Add them manually below.</Text>
                </View>
              </View>
            </View>

            {/* Secondary CTA */}
            <TouchableOpacity
              onPress={() => router.push('/add-book')}
              style={{
                width: '100%',
                borderWidth: 1,
                borderColor: '#ede9e4',
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <Text style={{ color: '#57534e', fontSize: 14, fontWeight: '500' }}>Add your first book manually</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 52, paddingHorizontal: 32 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: '#231f1b', marginBottom: 10, textAlign: 'center' }}>
              {FILTER_EMPTY.all.title}
            </Text>
            <Text style={{ color: '#9e958d', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 28 }}>
              {FILTER_EMPTY.all.body}
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/add-book')}
              style={{ backgroundColor: '#231f1b', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 26 }}
            >
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Add your first book</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Library has books but the active filter has zero matches
          <View style={{ paddingTop: 48, paddingHorizontal: 24, alignItems: 'center' }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#231f1b', marginBottom: 8, textAlign: 'center' }}>
              {FILTER_EMPTY[activeFilter].title}
            </Text>
            <Text style={{ fontSize: 14, color: '#9e958d', textAlign: 'center', lineHeight: 22, marginBottom: activeFilter === 'reading' || activeFilter === 'want_to_read' ? 20 : 0 }}>
              {FILTER_EMPTY[activeFilter].body}
            </Text>
            {activeFilter === 'reading' && (
              statusCounts.want_to_read > 0 ? (
                <TouchableOpacity
                  onPress={() => setActiveFilter('want_to_read')}
                  style={{ borderWidth: 1, borderColor: '#ede9e4', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#57534e' }}>See your reading list</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={() => router.push('/add-book')}
                  style={{ backgroundColor: '#231f1b', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Add a book</Text>
                </TouchableOpacity>
              )
            )}
            {activeFilter === 'want_to_read' && (
              <TouchableOpacity
                onPress={() => router.push('/add-book')}
                style={{ backgroundColor: '#231f1b', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Add Book</Text>
              </TouchableOpacity>
            )}
          </View>
        )
      }
    />
    )}

    {/* ── Post-finish taste capture modal ── */}
    <Modal
      visible={pendingTasteUserBookId !== null}
      transparent
      animationType="slide"
      onRequestClose={() => {
        setPendingTasteUserBookId(null);
        setLikedTags([]);
        setDislikedTags([]);
      }}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: '#fefcf9',
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          padding: 28,
          paddingBottom: 44,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: '#231f1b' }}>
              What stood out?
            </Text>
            <TouchableOpacity
              onPress={() => {
                setPendingTasteUserBookId(null);
                setLikedTags([]);
                setDislikedTags([]);
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={{ fontSize: 13, color: '#9e958d' }}>Skip</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 13, color: '#9e958d', marginBottom: 22 }}>
            Optional — helps us find books you'll love.
          </Text>

          {(['Loved about it', "Didn't land"] as const).map(groupLabel => {
            const isLiked  = groupLabel === 'Loved about it';
            const selected = isLiked ? likedTags : dislikedTags;
            return (
              <View key={groupLabel} style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 10 }}>
                  {groupLabel}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                  {(['Pacing', 'Characters', 'Plot', 'Worldbuilding', 'Writing', 'Emotional', 'Romance', 'Suspense', 'Ending', 'Originality'] as const).map(tag => {
                    const isSelected = selected.includes(tag);
                    return (
                      <TouchableOpacity
                        key={tag}
                        onPress={() => {
                          if (isLiked) {
                            setLikedTags(prev => isSelected ? prev.filter(t => t !== tag) : [...prev, tag]);
                            setDislikedTags(prev => prev.filter(t => t !== tag));
                          } else {
                            setDislikedTags(prev => isSelected ? prev.filter(t => t !== tag) : [...prev, tag]);
                            setLikedTags(prev => prev.filter(t => t !== tag));
                          }
                        }}
                        style={{
                          backgroundColor: isSelected ? '#231f1b' : '#ede9e4',
                          borderRadius: 20,
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                        }}
                      >
                        <Text style={{ fontSize: 13, color: isSelected ? '#fff' : '#57534e', fontWeight: isSelected ? '600' : '400' }}>
                          {tag}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })}

          <TouchableOpacity
            onPress={saveTasteTags}
            disabled={savingTaste}
            style={{
              backgroundColor: '#231f1b',
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: 'center',
              marginTop: 4,
              opacity: savingTaste ? 0.6 : 1,
            }}
          >
            {savingTaste
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>Done</Text>
            }
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    </View>
  );
}

// ─── Micro button components ──────────────────────────────────────────────────

// ─── DNF reason capture ───────────────────────────────────────────────────────

const DNF_REASONS: Array<{ key: string; label: string }> = [
  { key: 'not_for_me',        label: 'Not for me'         },
  { key: 'wrong_time',        label: 'Wrong time'          },
  { key: 'life_interruption', label: 'Life got in the way' },
  { key: 'too_slow',          label: 'Too slow / dense'    },
];

const DNF_REASON_LABELS: Record<string, string> = Object.fromEntries(
  DNF_REASONS.map(r => [r.key, r.label]),
);

/**
 * Soft reason capture for DNF books.
 * Tone: reflective. No guilt, no judgment — all reasons are equally valid.
 */
function DnfReasonChips({ onSelect, onSkip }: { onSelect: (reason: string) => void; onSkip: () => void }) {
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={{ fontSize: 11, color: '#78716c', marginBottom: 8 }}>
        Why did you stop? (optional)
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {DNF_REASONS.map(r => (
          <TouchableOpacity
            key={r.key}
            onPress={() => onSelect(r.key)}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={{
              borderWidth: 1,
              borderColor: '#d6cfc8',
              borderRadius: 20,
              paddingHorizontal: 11,
              paddingVertical: 5,
              backgroundColor: '#fefcf9',
            }}
          >
            <Text style={{ fontSize: 12, color: '#6b635c' }}>{r.label}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          onPress={onSkip}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={{ paddingHorizontal: 4, paddingVertical: 5 }}
        >
          <Text style={{ fontSize: 12, color: '#9e958d' }}>Skip</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: disabled ? '#ede9e4' : '#231f1b',
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 10,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function OutlineButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        borderWidth: 1,
        borderColor: disabled ? '#ede9e4' : '#ede9e4',
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 10,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: disabled ? '#9e958d' : '#44403c', fontSize: 13, fontWeight: '500' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function DangerButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        borderWidth: 1,
        borderColor: disabled ? '#ede9e4' : '#fca5a5',
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: disabled ? '#9e958d' : '#b91c1c', fontSize: 13, fontWeight: '500' }}>{label}</Text>
    </TouchableOpacity>
  );
}
