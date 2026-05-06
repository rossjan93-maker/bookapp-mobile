import { SAGE_DEEP } from '../lib/tokens';
import React, { useCallback } from 'react';
import {
  SectionList,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CoverThumb } from './CoverThumb';
import { inferReadState } from '../lib/pacing';
import { findSeriesForBook } from '../lib/seriesCatalog';

// ─── Types ─────────────────────────────────────────────────────────────────────

type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';
type SortKey = 'recent' | 'progress' | 'finished_date';

type UserBook = {
  id: string;
  book_id: string;
  status: UserBookStatus;
  started_at: string | null;
  finished_at: string | null;
  current_page: number | null;
  progress_updated_at: string | null;
  // edition_key — the OL edition the reader has picked for their copy. Threaded
  // into CoverThumb so the gallery view shows the *same* cover the list view
  // and book detail show. Without this, switching view mode visibly changes
  // the cover for any reader who has selected a non-default edition (the trust
  // bug reported: "Lord of the Rings cover & edition change when I switch to
  // large covers"). Optional for back-compat with callers that don't yet
  // select edition_key.
  edition_key?: string | null;
  // Optional: present when the paused_at migration has been applied AND the
  // caller selected the column. When non-null on a 'reading' book it forces
  // the Paused pill regardless of recency. Treated as undefined when the
  // column isn't selected — the gallery silently falls back to the legacy
  // inactivity-based inference.
  paused_at?: string | null;
  taste_tags: Record<string, any> | null;
  book: {
    title: string;
    author: string;
    cover_url: string | null;
    external_id: string;
    page_count: number | null;
  } | null;
};

type GallerySection = {
  key: string;
  title: string;
  data: RowItem[];
  columns: 2 | 3;
};

type RowItem = {
  __row: true;
  left: UserBook | null;
  right: UserBook | null;
  third?: UserBook | null;
};

// ─── Design tokens ─────────────────────────────────────────────────────────────

const TEXT = '#231f1b';
const MUTED = '#78716c';
const DIM   = '#9e958d';
const SAGE  = '#7b9e7e';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function chunkIntoRows(books: UserBook[], cols: 2 | 3): RowItem[] {
  const rows: RowItem[] = [];
  for (let i = 0; i < books.length; i += cols) {
    if (cols === 3) {
      rows.push({
        __row: true,
        left:  books[i]     ?? null,
        right: books[i + 1] ?? null,
        third: books[i + 2] ?? null,
      });
    } else {
      rows.push({
        __row: true,
        left:  books[i]     ?? null,
        right: books[i + 1] ?? null,
      });
    }
  }
  return rows;
}

function sortByRecent(arr: UserBook[]): UserBook[] {
  return [...arr].sort((a, b) => {
    const aDate = a.progress_updated_at ?? a.started_at ?? '';
    const bDate = b.progress_updated_at ?? b.started_at ?? '';
    return bDate.localeCompare(aDate);
  });
}

function sortByFinished(arr: UserBook[]): UserBook[] {
  return [...arr].sort((a, b) => {
    if (a.finished_at && b.finished_at) return b.finished_at.localeCompare(a.finished_at);
    if (a.finished_at) return -1;
    if (b.finished_at) return 1;
    return 0;
  });
}

function sortByProgress(arr: UserBook[]): UserBook[] {
  return [...arr].sort((a, b) => {
    const pA = a.current_page != null && a.book?.page_count ? a.current_page / a.book.page_count : 0;
    const pB = b.current_page != null && b.book?.page_count ? b.current_page / b.book.page_count : 0;
    return pB - pA;
  });
}

function buildSections(books: UserBook[], sort: SortKey): GallerySection[] {
  const reading    = books.filter(b => b.status === 'reading');
  const wantToRead = books.filter(b => b.status === 'want_to_read');
  const finished   = books.filter(b => b.status === 'finished');
  const dnf        = books.filter(b => b.status === 'dnf');

  const sortedReading = sort === 'progress' ? sortByProgress(reading) : sortByRecent(reading);
  const sortedFinished = sortByFinished(finished);

  const sections: GallerySection[] = [];

  if (sortedReading.length > 0) {
    sections.push({
      key: 'reading',
      title: 'Reading',
      data: chunkIntoRows(sortedReading, 2),
      columns: 2,
    });
  }
  if (wantToRead.length > 0) {
    sections.push({
      key: 'want_to_read',
      title: 'Up Next',
      data: chunkIntoRows(wantToRead, 3),
      columns: 3,
    });
  }
  if (sortedFinished.length > 0) {
    sections.push({
      key: 'finished',
      title: 'Finished',
      data: chunkIntoRows(sortedFinished, 2),
      columns: 2,
    });
  }
  if (dnf.length > 0) {
    sections.push({
      key: 'dnf',
      title: 'Set Aside',
      data: chunkIntoRows(dnf, 2),
      columns: 2,
    });
  }

  return sections;
}

function finishedYear(book: UserBook): string | null {
  if (!book.finished_at) return null;
  return String(new Date(book.finished_at).getFullYear());
}

function readStatePill(book: UserBook): { label: string; color: string; bg: string } | null {
  const state = inferReadState({
    status:            book.status,
    progressUpdatedAt: book.progress_updated_at,
    startedAt:         book.started_at,
    currentPage:       book.current_page,
    pausedAt:          book.paused_at,
  });
  if (state === 'active')  return { label: 'Active',  color: SAGE_DEEP, bg: '#eaf1ea' };
  if (state === 'paused')  return { label: 'Paused',  color: '#92400e', bg: '#fef9c3' };
  if (state === 'stalled') return { label: 'Stalled', color: '#9a3412', bg: '#fee2e2' };
  return null;
}

// ─── GalleryBookCard ─────────────────────────────────────────────────────────

type CardProps = {
  book: UserBook;
  coverWidth: number;
  coverHeight: number;
  columns: 2 | 3;
};

function GalleryBookCard({ book, coverWidth, coverHeight, columns }: CardProps) {
  const router = useRouter();

  const hasProgress =
    book.status === 'reading' &&
    book.current_page != null && book.current_page > 0 &&
    book.book?.page_count != null && book.book.page_count > 0;

  const progressPct = hasProgress
    ? Math.min(100, Math.round((book.current_page! / book.book!.page_count!) * 100))
    : null;

  const pill = book.status === 'reading' ? readStatePill(book) : null;
  const year = book.status === 'finished' ? finishedYear(book) : null;

  function handlePress() {
    const seriesCtx = findSeriesForBook(book.book?.title ?? '', book.book?.author ?? '');
    router.push({
      pathname: '/book/[id]',
      params: {
        id:         book.book_id,
        title:      book.book?.title ?? '',
        author:     book.book?.author ?? '',
        coverUrl:   book.book?.cover_url ?? '',
        externalId: book.book?.external_id ?? '',
        status:     book.status,
        startedAt:  book.started_at ?? '',
        ...(seriesCtx ? {
          seriesName:     seriesCtx.seriesName,
          seriesPosition: String(seriesCtx.seriesPosition),
        } : {}),
      },
    });
  }

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={handlePress}
      style={{ flex: 1, alignItems: 'center' }}
    >
      {/* Cover with optional progress bar overlay */}
      <View style={{ position: 'relative', width: coverWidth }}>
        <CoverThumb
          url={book.book?.cover_url}
          externalId={book.book?.external_id}
          editionKey={book.edition_key}
          title={book.book?.title}
          width={coverWidth}
          height={coverHeight}
          radius={6}
        />
        {/* Progress bar overlaid at bottom of cover */}
        {hasProgress && progressPct != null && (
          <View style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 3,
            backgroundColor: 'rgba(0,0,0,0.15)',
            borderBottomLeftRadius: 6,
            borderBottomRightRadius: 6,
            overflow: 'hidden',
          }}>
            <View style={{
              width: `${progressPct}%`,
              height: 3,
              backgroundColor: SAGE,
            }} />
          </View>
        )}
      </View>

      {/* Text below cover */}
      <View style={{ width: coverWidth, marginTop: 6 }}>
        <Text
          numberOfLines={2}
          style={{
            fontSize:   columns === 3 ? 11 : 12,
            fontWeight: '600',
            color:      TEXT,
            lineHeight: columns === 3 ? 15 : 17,
          }}
        >
          {book.book?.title ?? '—'}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            fontSize:   columns === 3 ? 10 : 11,
            color:      MUTED,
            marginTop:  2,
          }}
        >
          {book.book?.author ?? '—'}
        </Text>

        {/* Read-state pill (reading books) */}
        {pill && (
          <View style={{
            alignSelf: 'flex-start',
            marginTop: 4,
            backgroundColor: pill.bg,
            borderRadius: 10,
            paddingHorizontal: 6,
            paddingVertical: 2,
          }}>
            <Text style={{ fontSize: 9, fontWeight: '700', color: pill.color, letterSpacing: 0.3 }}>
              {pill.label}
            </Text>
          </View>
        )}

        {/* Year band (finished books) */}
        {year && (
          <Text style={{ fontSize: 10, color: DIM, marginTop: 3 }}>
            {year}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── Row renderer ─────────────────────────────────────────────────────────────

type RowProps = {
  row: RowItem;
  columns: 2 | 3;
  screenWidth: number;
};

function GalleryRow({ row, columns, screenWidth }: RowProps) {
  const H_PAD     = 20;
  const COL_GAP   = 12;
  const available = screenWidth - H_PAD * 2;

  let coverWidth: number;
  let coverHeight: number;

  if (columns === 3) {
    coverWidth  = Math.floor((available - COL_GAP * 2) / 3);
    coverHeight = Math.round(coverWidth * 1.5);
  } else {
    coverWidth  = Math.floor((available - COL_GAP) / 2);
    coverHeight = Math.round(coverWidth * 1.52);
  }

  if (columns === 3) {
    const slots = [row.left, row.right, row.third ?? null];
    return (
      <View style={{
        flexDirection: 'row',
        gap: COL_GAP,
        marginBottom: 16,
      }}>
        {slots.map((book, idx) =>
          book ? (
            <GalleryBookCard
              key={book.id}
              book={book}
              coverWidth={coverWidth}
              coverHeight={coverHeight}
              columns={3}
            />
          ) : (
            <View key={`empty-${idx}`} style={{ flex: 1 }} />
          )
        )}
      </View>
    );
  }

  const leftHeight  = coverHeight;
  const rightHeight = Math.round(coverHeight * 0.92);

  return (
    <View style={{
      flexDirection: 'row',
      gap: COL_GAP,
      marginBottom: 16,
      alignItems: 'flex-start',
    }}>
      {row.left ? (
        <GalleryBookCard
          book={row.left}
          coverWidth={coverWidth}
          coverHeight={leftHeight}
          columns={2}
        />
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {row.right ? (
        <GalleryBookCard
          book={row.right}
          coverWidth={coverWidth}
          coverHeight={rightHeight}
          columns={2}
        />
      ) : (
        <View style={{ flex: 1 }} />
      )}
    </View>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={{ paddingTop: 24, paddingBottom: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 3, height: 14, backgroundColor: SAGE, borderRadius: 2 }} />
        <Text style={{
          fontSize:      16,
          fontWeight:    '700',
          color:         TEXT,
          letterSpacing: -0.2,
        }}>
          {title}
        </Text>
      </View>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type LibraryGalleryViewProps = {
  books: UserBook[];
  filter: 'all' | UserBookStatus;
  sort: SortKey;
  screenWidth: number;
  ListHeaderComponent?: React.ReactElement | null;
  refreshControl?: React.ReactElement | null;
  emptyComponent?: React.ReactElement | null;
};

export function LibraryGalleryView({
  books,
  filter: _filter,
  sort,
  screenWidth,
  ListHeaderComponent,
  refreshControl,
  emptyComponent,
}: LibraryGalleryViewProps) {
  const sections = buildSections(books, sort);

  const renderSectionHeader = useCallback(
    ({ section }: { section: { title: string } }) => (
      <SectionHeader title={section.title} />
    ),
    [],
  );

  const renderItem = useCallback(
    ({ item, section }: { item: RowItem; section: { columns: 2 | 3 } }) => (
      <GalleryRow
        row={item}
        columns={section.columns}
        screenWidth={screenWidth}
      />
    ),
    [screenWidth],
  );

  const keyExtractor = useCallback(
    (item: RowItem, index: number) =>
      `${item.left?.id ?? 'l'}-${item.right?.id ?? 'r'}-${index}`,
    [],
  );

  if (sections.length === 0) {
    return (
      <SectionList
        sections={[]}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48 }}
        ListHeaderComponent={ListHeaderComponent}
        ListEmptyComponent={emptyComponent ?? null}
        refreshControl={refreshControl ?? undefined}
        showsVerticalScrollIndicator={false}
      />
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48 }}
      ListHeaderComponent={ListHeaderComponent}
      refreshControl={refreshControl ?? undefined}
      showsVerticalScrollIndicator={false}
    />
  );
}
