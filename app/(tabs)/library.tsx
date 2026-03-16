import { useCallback, useState } from 'react';
import { fetchGoogleBooksCoverUrl } from '../../lib/googleBooks';
import { ActivityIndicator, FlatList, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { computePagePacing, computeDatePacing } from '../../lib/pacing';

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
  book: {
    title: string;
    author: string;
    cover_url: string | null;
    external_id: string;
    page_count: number | null;
  } | null;
};

type PendingFeedback = { userBookId: string; bookId: string; status: 'finished' | 'dnf'; pendingEventId: string | null };

type YearSeparator = { __type: 'year_separator'; year: string; key: string; count: number };
type ListItem      = UserBook | YearSeparator;

function isYearSeparator(item: ListItem): item is YearSeparator {
  return (item as YearSeparator).__type === 'year_separator';
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
  dnf:          'DNF',
};

const STATUS_BADGE: Record<UserBookStatus, { bg: string; text: string }> = {
  want_to_read: { bg: '#f1f5f9', text: '#475569' },
  reading:      { bg: '#dbeafe', text: '#1d4ed8' },
  finished:     { bg: '#dcfce7', text: '#15803d' },
  dnf:          { bg: '#fee2e2', text: '#b91c1c' },
};

const FILTER_OPTIONS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all',          label: 'All'          },
  { key: 'reading',      label: 'Reading'      },
  { key: 'want_to_read', label: 'Want to Read' },
  { key: 'finished',     label: 'Finished'     },
  { key: 'dnf',          label: 'DNF'          },
];

const FILTER_EMPTY: Record<FilterKey, { title: string; body: string }> = {
  all:          { title: 'Your library is empty',  body: 'Add books you\'re reading, have finished, or want to read.' },
  reading:      { title: 'Not reading anything',   body: 'Start a book from your list, or add something new.' },
  want_to_read: { title: 'Nothing queued up',      body: 'Save books you want to read next.' },
  finished:     { title: 'No finished books yet',  body: 'Finished books will appear here.' },
  dnf:          { title: 'No abandoned books',     body: 'DNF is always a valid call.' },
};

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function LibraryScreen() {
  const router = useRouter();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [items, setItems]                 = useState<UserBook[]>([]);
  const [yearlyGoal, setYearlyGoal]       = useState<number | null>(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [updatingId, setUpdatingId]       = useState<string | null>(null);
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(null);
  const [activeFilter, setActiveFilter]   = useState<FilterKey>('all');
  const [sort, setSort]                   = useState<SortKey>('recent');
  // Accordion state for Finished+chronological mode.
  // Starts empty (all years collapsed). User taps a year row to expand/collapse it.
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());

  useFocusEffect(useCallback(() => {
    // Background cover enrichment for any book in this library load with no
    // cover_url. Covers matched books that were pre-existing at import time and
    // thus skipped by the post-import enrichMissingCovers pass (which only runs
    // on newBookIds). Fails quietly; updates local state as each cover resolves.
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

    async function load() {
      if (!supabase) { setError('Supabase not configured.'); setLoading(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('No signed-in user.'); setLoading(false); return; }
      setCurrentUserId(user.id);

      // Load yearly goal for pacing-state card colors
      const profileRes = await supabase
        .from('profiles')
        .select('yearly_reading_goal')
        .eq('id', user.id)
        .single();
      setYearlyGoal(profileRes.data?.yearly_reading_goal ?? null);

      // Try with progress columns; fall back gracefully if migration not yet applied.
      let result = await supabase
        .from('user_books')
        .select('id, book_id, status, started_at, finished_at, current_page, book:books(title, author, cover_url, external_id, page_count)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (result.error) {
        result = await supabase
          .from('user_books')
          .select('id, book_id, status, started_at, finished_at, book:books(title, author, cover_url, external_id)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
      }

      if (result.error) {
        setError('Could not load library.');
      } else {
        const loadedItems = (result.data as unknown as UserBook[]) ?? [];
        setItems(loadedItems);
        // Fire-and-forget: backfill missing covers for any book in this load.
        const missingCoverIds = [...new Set(
          loadedItems.filter(it => it.book && !it.book.cover_url).map(it => it.book_id),
        )];
        backfillCovers(missingCoverIds).catch(() => {});
      }
      setLoading(false);
    }
    load();
  }, []));

  // ── Business logic (unchanged) ────────────────────────────────────────────

  function saveRating(userBookId: string, bookId: string, rating: number) {
    // Capture the completion event ID before clearing state
    const eventId = pendingFeedback?.pendingEventId ?? null;
    setPendingFeedback(null);
    if (!supabase || !currentUserId) return;
    // Derive sentiment from rating for backward-compat with signals/taste model
    const sentiment =
      rating >= 5 ? 'loved' :
      rating >= 4 ? 'liked' :
      rating === 3 ? 'okay' :
      'not_for_me';
    supabase.from('user_books').update({ rating, sentiment }).eq('id', userBookId).then(() => {});
    if (eventId) {
      // Merge rating into the existing completion event — one feed story, not two
      supabase.from('activity_events').update({ rating }).eq('id', eventId).then(() => {});
    } else {
      // No prior completion event (DNF or future standalone rating) — insert book_rated
      supabase.from('activity_events').insert({
        actor_id:   currentUserId,
        event_type: 'book_rated',
        book_id:    bookId,
        rating,
      }).then(() => {});
    }
  }

  async function handleUpdateStatus(userBook: UserBook, newStatus: UserBookStatus) {
    if (!supabase || !currentUserId) return;
    setUpdatingId(userBook.id);

    const now = new Date().toISOString();
    let completionEventId: string | null = null;
    const userBookUpdate: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'reading')                              userBookUpdate.started_at  = now;
    if (newStatus === 'finished' || newStatus === 'dnf')     userBookUpdate.finished_at = now;

    const { error: updateError } = await supabase
      .from('user_books')
      .update(userBookUpdate)
      .eq('id', userBook.id);

    if (updateError) {
      setError('Could not update status. Please try again.');
      setUpdatingId(null);
      return;
    }

    const { data: rec } = await supabase
      .from('recommendations')
      .select('id, from_user_id, to_user_id, book_id')
      .eq('user_book_id', userBook.id)
      .maybeSingle();

    if (rec) {
      const recStatusMap: Record<UserBookStatus, string> = {
        want_to_read: 'saved',
        reading:      'started',
        finished:     'finished',
        dnf:          'dnf',
      };
      const recUpdate: Record<string, unknown> = { status: recStatusMap[newStatus] };
      if (newStatus === 'finished' || newStatus === 'dnf') recUpdate.resolved_at = now;

      const { error: recUpdateError } = await supabase
        .from('recommendations')
        .update(recUpdate)
        .eq('id', rec.id);

      if (!recUpdateError && newStatus === 'finished') {
        const { data: existingEvent } = await supabase
          .from('credibility_events')
          .select('id')
          .eq('recommendation_id', rec.id)
          .maybeSingle();
        if (!existingEvent) {
          await supabase.from('credibility_events').insert({
            recommendation_id: rec.id,
            from_user_id: rec.from_user_id,
            to_user_id:   rec.to_user_id,
            book_id:      rec.book_id,
          });
        }
      }

      if (!recUpdateError) {
        if (newStatus === 'reading') {
          await supabase.from('activity_events').insert({
            actor_id: currentUserId, event_type: 'recommendation_started',
            book_id: rec.book_id, recommendation_id: rec.id,
          });
        } else if (newStatus === 'finished') {
          const { data: evtData } = await supabase
            .from('activity_events')
            .insert({
              actor_id: currentUserId, event_type: 'recommendation_finished',
              book_id: rec.book_id, recommendation_id: rec.id,
            })
            .select('id')
            .single();
          completionEventId = evtData?.id ?? null;
        }
      }
    } else if (newStatus === 'finished') {
      const { data: evtData } = await supabase
        .from('activity_events')
        .insert({ actor_id: currentUserId, event_type: 'book_finished', book_id: userBook.book_id })
        .select('id')
        .single();
      completionEventId = evtData?.id ?? null;
    }

    setItems(prev => prev.map(item =>
      item.id === userBook.id
        ? {
            ...item,
            status:      newStatus,
            started_at:  newStatus === 'reading'                          ? now : item.started_at,
            finished_at: newStatus === 'finished' || newStatus === 'dnf'  ? now : item.finished_at,
          }
        : item
    ));

    if (newStatus === 'finished' || newStatus === 'dnf') {
      setPendingFeedback({ userBookId: userBook.id, bookId: userBook.book_id, status: newStatus, pendingEventId: completionEventId });
    }
    setUpdatingId(null);
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const readingCount  = items.filter(i => i.status === 'reading').length;
  const filteredItems = activeFilter === 'all' ? items : items.filter(i => i.status === activeFilter);

  // Sort + ordering:
  //   All filter    → reading first, then finished (finished_at desc), then want-to-read, then dnf.
  //   Reading filter + progress sort → sorted by page progress descending.
  //   Finished filter + finished_date (default) → sorted by finished_at descending (uses imported dates).
  //   Finished filter + recent → DB insertion order (created_at desc).
  //   All other cases → preserve DB order (created_at desc).
  const displayedItems: ListItem[] = (() => {
    if (activeFilter === 'all') {
      // Reading first (operational priority), then finished sorted by most recently
      // finished (uses imported finish dates), then want-to-read, then DNF.
      const reading    = filteredItems.filter(i => i.status === 'reading');
      const finished   = [...filteredItems.filter(i => i.status === 'finished')]
        .sort((a, b) => {
          if (a.finished_at && b.finished_at) return b.finished_at.localeCompare(a.finished_at);
          if (a.finished_at) return -1;
          if (b.finished_at) return 1;
          return 0;
        });
      const wantToRead = filteredItems.filter(i => i.status === 'want_to_read');
      const dnf        = filteredItems.filter(i => i.status === 'dnf');
      return [...reading, ...finished, ...wantToRead, ...dnf];
    }
    if (activeFilter === 'reading' && sort === 'progress') {
      return [...filteredItems].sort((a, b) => {
        const pA = a.current_page != null && a.book?.page_count ? a.current_page / a.book.page_count : 0;
        const pB = b.current_page != null && b.book?.page_count ? b.current_page / b.book.page_count : 0;
        return pB - pA;
      });
    }
    if (activeFilter === 'finished' && sort === 'finished_date') {
      // Sort by finished_at desc (nulls last), then inject year-header separators.
      const sorted = [...filteredItems].sort((a, b) => {
        if (a.finished_at && b.finished_at) return b.finished_at.localeCompare(a.finished_at);
        if (a.finished_at) return -1;
        if (b.finished_at) return 1;
        return 0;
      });
      return buildGroupedFinished(sorted, expandedYears);
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

  // ── Loading / error ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14 }}>{error}</Text>
      </View>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <FlatList
      data={displayedItems}
      keyExtractor={item => isYearSeparator(item) ? item.key : item.id}
      style={{ backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 0, paddingBottom: 40 }}
      ListHeaderComponent={
        <View>
          {/* ── Editorial header ── */}
          <View style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            paddingTop: 24,
            paddingBottom: contextSubtitle ? 4 : 16,
          }}>
            <Text style={{
              fontSize: 28,
              fontWeight: '800',
              color: '#1c1917',
              letterSpacing: -0.5,
              lineHeight: 34,
            }}>
              Library
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/add-book')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: '#1c1917',
                borderRadius: 8,
                paddingHorizontal: 14,
                paddingVertical: 8,
                marginBottom: 2,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>+ Add Book</Text>
            </TouchableOpacity>
          </View>

          {contextSubtitle && (
            <Text style={{ fontSize: 13, color: '#a8a29e', marginBottom: 18 }}>
              {contextSubtitle}
            </Text>
          )}

          {/* ── Filter chip bar ── */}
          {items.length > 0 && (
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
                      backgroundColor: active ? '#1c1917' : readingAccent ? '#eff6ff' : 'transparent',
                      borderColor:     active ? '#1c1917' : readingAccent ? '#bfdbfe' : '#e7e5e4',
                    }}
                  >
                    <Text style={{
                      fontSize: 13,
                      fontWeight: active ? '600' : '400',
                      color: active ? '#fff' : '#78716c',
                    }}>
                      {f.label}{count}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {/* ── Sort toggle (Reading: 2+ books; Finished: 2+ books) ── */}
          {filteredItems.length > 1 && (activeFilter === 'reading' || activeFilter === 'finished') && (
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
                      color: sort === 'recent' ? '#1c1917' : '#a8a29e',
                      fontWeight: sort === 'recent' ? '600' : '400',
                    }}>Recent</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, color: '#d6d3d1', marginHorizontal: 8 }}>·</Text>
                  <TouchableOpacity onPress={() => setSort('progress')}>
                    <Text style={{
                      fontSize: 12,
                      color: sort === 'progress' ? '#1c1917' : '#a8a29e',
                      fontWeight: sort === 'progress' ? '600' : '400',
                    }}>Progress</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity onPress={() => setSort('finished_date')}>
                    <Text style={{
                      fontSize: 12,
                      color: sort === 'finished_date' ? '#1c1917' : '#a8a29e',
                      fontWeight: sort === 'finished_date' ? '600' : '400',
                    }}>Finished</Text>
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, color: '#d6d3d1', marginHorizontal: 8 }}>·</Text>
                  <TouchableOpacity onPress={() => setSort('recent')}>
                    <Text style={{
                      fontSize: 12,
                      color: sort === 'recent' ? '#1c1917' : '#a8a29e',
                      fontWeight: sort === 'recent' ? '600' : '400',
                    }}>Added</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}

          {/* ── Divider ── */}
          {items.length > 0 && activeFilter !== 'reading' && (
            <View style={{ height: 1, backgroundColor: '#f5f5f4' }} />
          )}
        </View>
      }
      renderItem={({ item, index }) => {
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
                borderBottomColor: '#f5f5f4',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#1c1917', letterSpacing: -0.2 }}>
                {item.year}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                  {item.count} {item.count === 1 ? 'book' : 'books'}
                </Text>
                <Text style={{ fontSize: 14, color: '#a8a29e' }}>
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
        const hasButtons = item.status === 'want_to_read' || item.status === 'reading';

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
        const showLibraryHeader    = activeFilter === 'all' && index === readingCount && readingCount > 0 && hasNonReading;

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
            if (!borderPacing) return '#d6d3d1';
            const s = borderPacing.state;
            if (s === 'ahead' || s === 'on_pace') return '#86efac';
            if (s === 'behind') return '#fcd34d';
            return '#d6d3d1';
          })();
          const pacingNote = hasProgress ? borderPacing?.note ?? null : datePacing?.note ?? null;

          return (
            <View>
              {showNowReadingHeader && (
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 1, textTransform: 'uppercase', marginTop: 10, marginBottom: 8 }}>
                  Now Reading
                </Text>
              )}
              <View style={{
                backgroundColor: '#fff',
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
                onPress={() => router.push({
                  pathname: '/book/[id]',
                  params: {
                    id:         item.book_id,
                    title:      item.book?.title ?? '',
                    author:     item.book?.author ?? '',
                    coverUrl:   item.book?.cover_url ?? '',
                    externalId: item.book?.external_id ?? '',
                    status:     item.status,
                    startedAt:  item.started_at ?? '',
                  },
                })}
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
                  <Text style={{ fontWeight: '700', fontSize: 16, color: '#1c1917', marginBottom: 3, lineHeight: 22 }}>
                    {item.book?.title ?? '—'}
                  </Text>
                  <Text style={{ color: '#78716c', fontSize: 13, marginBottom: hasProgress ? 12 : 0 }}>
                    {item.book?.author ?? '—'}
                  </Text>
                  {hasProgress && (
                    <>
                      <View style={{
                        height: 4,
                        backgroundColor: '#e7e5e4',
                        borderRadius: 2,
                        overflow: 'hidden',
                        marginBottom: 5,
                      }}>
                        <View style={{
                          height: 4,
                          width: `${progressPct ?? 0}%`,
                          backgroundColor: '#1c1917',
                          borderRadius: 2,
                        }} />
                      </View>
                      <Text style={{ fontSize: 11, color: '#a8a29e' }}>
                        {pacingNote ? pacingNote : `Page ${item.current_page} of ${item.book?.page_count} · ${progressPct}%`}
                      </Text>
                    </>
                  )}
                  {!hasProgress && item.status === 'reading' && (
                    <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 6 }}>
                      {pacingNote ? pacingNote : 'In progress — open to log pages'}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>

              {/* Action row */}
              {hasPendingRating ? (
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
                      <Text style={{ fontSize: 12, color: '#a8a29e', marginLeft: 12 }}>Skip</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : isUpdating ? (
                <ActivityIndicator color="#78716c" style={{ alignSelf: 'flex-start' }} />
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <PrimaryButton label="Mark Finished" onPress={() => handleUpdateStatus(item, 'finished')} disabled={isBlocked} />
                  <DangerButton  label="DNF"           onPress={() => handleUpdateStatus(item, 'dnf')}      disabled={isBlocked} />
                </View>
              )}
            </View>
          </View>
          );
        }

        // ── Non-reading row: flat archival style ─────────────────────────────
        return (
          <View>
            {showLibraryHeader && (
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#c4b5a5', letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 8 }}>
                Library
              </Text>
            )}
            <View style={{
              paddingTop: 18,
              paddingBottom: hasExtraRow ? 14 : 18,
              borderBottomWidth: 1,
              borderBottomColor: '#f5f5f4',
            }}>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.push({
                pathname: '/book/[id]',
                params: {
                  id:         item.book_id,
                  title:      item.book?.title ?? '',
                  author:     item.book?.author ?? '',
                  coverUrl:   item.book?.cover_url ?? '',
                  externalId: item.book?.external_id ?? '',
                  status:     item.status,
                  startedAt:  item.started_at ?? '',
                },
              })}
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
                    <Text style={{ fontWeight: '700', fontSize: 16, color: '#1c1917', marginBottom: 3 }}>
                      {item.book?.title ?? '—'}
                    </Text>
                    <Text style={{ color: '#78716c', fontSize: 13 }}>
                      {item.book?.author ?? '—'}
                    </Text>
                    {item.finished_at && (item.status === 'finished' || item.status === 'dnf') && (
                      <Text style={{ fontSize: 11, color: '#c4b5a5', marginTop: 3 }}>
                        {new Date(item.finished_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </Text>
                    )}
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

            {hasPendingRating ? (
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
                    <Text style={{ fontSize: 12, color: '#a8a29e', marginLeft: 12 }}>Skip</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : isUpdating ? (
              <ActivityIndicator color="#78716c" style={{ alignSelf: 'flex-start', marginLeft: 58 }} />
            ) : item.status === 'want_to_read' ? (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginLeft: 58 }}>
                <PrimaryButton label="Start Reading" onPress={() => handleUpdateStatus(item, 'reading')}  disabled={isBlocked} />
                <OutlineButton label="Mark Finished" onPress={() => handleUpdateStatus(item, 'finished')} disabled={isBlocked} />
                <DangerButton  label="DNF"           onPress={() => handleUpdateStatus(item, 'dnf')}      disabled={isBlocked} />
              </View>
            ) : null}
          </View>
        </View>
        );
      }}
      ListEmptyComponent={
        items.length === 0 && activeFilter === 'all' ? (
          <View style={{ alignItems: 'center', paddingTop: 44, paddingHorizontal: 28 }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: '#1c1917', marginBottom: 8, textAlign: 'center', letterSpacing: -0.3 }}>
              Start your library
            </Text>
            <Text style={{ color: '#78716c', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 32 }}>
              Build your reading history by importing from Goodreads, or add books one at a time.
            </Text>

            <TouchableOpacity
              onPress={() => router.push('/import/goodreads')}
              style={{
                width: '100%',
                backgroundColor: '#1c1917',
                borderRadius: 12,
                paddingVertical: 15,
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Import from Goodreads</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => router.push('/add-book')}
              style={{
                width: '100%',
                borderWidth: 1,
                borderColor: '#e7e5e4',
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#57534e', fontSize: 14, fontWeight: '500' }}>Add your first book</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 52, paddingHorizontal: 32 }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: '#1c1917', marginBottom: 10, textAlign: 'center' }}>
              {FILTER_EMPTY.all.title}
            </Text>
            <Text style={{ color: '#a8a29e', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 28 }}>
              {FILTER_EMPTY.all.body}
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/add-book')}
              style={{ backgroundColor: '#1c1917', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 26 }}
            >
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Add your first book</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Library has books but the active filter has zero matches
          <View style={{ paddingTop: 48, paddingHorizontal: 24, alignItems: 'center' }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#1c1917', marginBottom: 8, textAlign: 'center' }}>
              {FILTER_EMPTY[activeFilter].title}
            </Text>
            <Text style={{ fontSize: 14, color: '#a8a29e', textAlign: 'center', lineHeight: 22, marginBottom: activeFilter === 'reading' || activeFilter === 'want_to_read' ? 20 : 0 }}>
              {FILTER_EMPTY[activeFilter].body}
            </Text>
            {activeFilter === 'reading' && (
              statusCounts.want_to_read > 0 ? (
                <TouchableOpacity
                  onPress={() => setActiveFilter('want_to_read')}
                  style={{ borderWidth: 1, borderColor: '#d6d3d1', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#57534e' }}>See your reading list</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={() => router.push('/add-book')}
                  style={{ backgroundColor: '#1c1917', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Add a book</Text>
                </TouchableOpacity>
              )
            )}
            {activeFilter === 'want_to_read' && (
              <TouchableOpacity
                onPress={() => router.push('/add-book')}
                style={{ backgroundColor: '#1c1917', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Add Book</Text>
              </TouchableOpacity>
            )}
          </View>
        )
      }
    />
  );
}

// ─── Micro button components ──────────────────────────────────────────────────

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: disabled ? '#d6d3d1' : '#1c1917',
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{label}</Text>
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
        borderColor: disabled ? '#e7e5e4' : '#d6d3d1',
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: disabled ? '#a8a29e' : '#57534e', fontSize: 12, fontWeight: '500' }}>{label}</Text>
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
        borderColor: disabled ? '#e7e5e4' : '#fca5a5',
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: disabled ? '#a8a29e' : '#b91c1c', fontSize: 12, fontWeight: '500' }}>{label}</Text>
    </TouchableOpacity>
  );
}
