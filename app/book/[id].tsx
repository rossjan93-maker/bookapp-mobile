import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Modal,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BackButton } from '../../components/BackButton';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { DescriptionSkeleton, ProgressCardSkeleton } from '../../components/Placeholder';
import { getSeriesCatalog, getSagaForSeries, getAllSagaCatalog, findSeriesForBook } from '../../lib/seriesCatalog';
import { triggerRecPrewarm } from '../../lib/recPrewarm';
import { computeDatePacing, computePagePacing, estimatePaceFinish, formatLastUpdated, shortDate, computeBookPace, computeUserAvgPace } from '../../lib/pacing';
import { fetchGoogleBooksMetadata } from '../../lib/googleBooks';
import { fetchOLMeta, fetchEditions, rankEditions, searchOLWork, isOLId } from '../../lib/openLibrary';
import type { OLMeta, OLEdition } from '../../lib/openLibrary';
import { deriveContentWarnings, isCoveragePartial } from '../../lib/contentWarnings';
import { transitionStatus, editUserBook, softDeleteBook, restoreSnapshot, saveCurrentPage, setEditionKey as persistEditionKey } from '../../lib/userBookActions';
import type { UserBookStatus, BookSnapshot, FinishedDateInput, StartedDateInput } from '../../lib/userBookActions';
import { useUndoBar } from '../../lib/useUndoBar';
import { invalidateBookDataCaches } from '../../lib/tabCache';
import { getRecContext } from '../../lib/recContext';
import type { RecContext } from '../../lib/recContext';
import { getRecSnapshot } from '../../lib/recSnapshot';
import { EvidenceTagsRow } from '../../components/RecCard';

// ─── Book-level enrichment cache ──────────────────────────────────────────────
// Module-level Map keyed by book DB id.  Stores the description / subjects /
// pageCount fields that would otherwise require an OL/Google Books round-trip on
// every visit.  Max 60 entries to cap memory; LRU-eviction is not needed at this
// size.  Cleared implicitly on JS context restart (app kill / hard reload).

type BookMetaEntry = {
  description:     string | null;
  subjects:        string[];
  pageCount:       number | null;
  contentWarnings: string[];
};

const _bookMetaCache = new Map<string, BookMetaEntry>();
const BOOK_META_MAX  = 60;

function _cacheBookMeta(bookId: string, entry: BookMetaEntry): void {
  if (_bookMetaCache.size >= BOOK_META_MAX) {
    // Drop the oldest entry (first key in insertion order)
    const firstKey = _bookMetaCache.keys().next().value;
    if (firstKey !== undefined) _bookMetaCache.delete(firstKey);
  }
  _bookMetaCache.set(bookId, entry);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { bg: string; text: string; label: string }> = {
  want_to_read: { bg: '#f1f5f9', text: '#475569', label: 'Want to Read' },
  reading:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'      },
  finished:     { bg: '#dcfce7', text: '#15803d', label: 'Finished'     },
  dnf:          { bg: '#fee2e2', text: '#b91c1c', label: 'DNF'          },
  sent:         { bg: '#f1f5f9', text: '#475569', label: 'New'          },
  saved:        { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read' },
  started:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'      },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#9e958d',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 10,
    }}>
      {children}
    </Text>
  );
}

// ─── ContentWarnings ──────────────────────────────────────────────────────────

type ContentWarningsProps = {
  warnings:    string[];
  subjects:    string[];
  expanded:    boolean;
  onToggle:    () => void;
};

function ContentWarnings({ warnings, subjects, expanded, onToggle }: ContentWarningsProps) {
  if (!warnings || warnings.length === 0) return null;

  const showIncompleteNote = isCoveragePartial(subjects);

  return (
    <View style={{
      backgroundColor: '#fefcf9',
      borderRadius: 14,
      padding: 18,
      marginBottom: 20,
      borderWidth: 1,
      borderColor: '#ede9e4',
    }}>
      <TouchableOpacity
        onPress={onToggle}
        activeOpacity={0.7}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Text style={{
          fontSize: 11,
          fontWeight: '700',
          color: '#9e958d',
          letterSpacing: 0.9,
          textTransform: 'uppercase',
        }}>
          Heads up
        </Text>
        <Text style={{ fontSize: 13, color: '#9e958d' }}>
          {expanded ? '▲' : '▼'}
        </Text>
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {warnings.map((w, i) => (
              <View
                key={i}
                style={{
                  backgroundColor: '#f5f1ed',
                  borderRadius: 20,
                  paddingHorizontal: 12,
                  paddingVertical: 5,
                  borderWidth: 1,
                  borderColor: '#e6e0d9',
                }}
              >
                <Text style={{ fontSize: 12, color: '#78716c' }}>{w}</Text>
              </View>
            ))}
          </View>
          {showIncompleteNote && (
            <Text style={{
              fontSize: 11,
              color: '#b5afa9',
              marginTop: 10,
              fontStyle: 'italic',
            }}>
              Coverage may be incomplete
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function BookDetailScreen() {
  const router     = useRouter();
  const navigation = useNavigation();

  // Safe back: pop the stack if an entry exists, otherwise fall back to the
  // library tab.  Guards against GO_BACK being dispatched with an empty stack,
  // which happens on direct URL nav, web hard-refresh, and deep-links.
  function safeBack() {
    if (navigation.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/library');
    }
  }

  const {
    id: bookId,
    title,
    author,
    coverUrl,
    externalId,
    status: statusParam,
    note,
    fromUser,
    toUser,
    startedAt: startedAtParam,
    readingGoal: readingGoalParam,
    seriesName,
    seriesPosition: seriesPositionParam,
  } = useLocalSearchParams<{
    id?: string;
    title?: string;
    author?: string;
    coverUrl?: string;
    externalId?: string;
    status?: string;
    note?: string;
    fromUser?: string;
    toUser?: string;
    startedAt?: string;
    readingGoal?: string;
    seriesName?: string;
    seriesPosition?: string;
  }>();

  const [olMeta, setOlMeta]             = useState<OLMeta | null>(null);
  const [metaLoading, setMetaLoading]   = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [avgUserPace, setAvgUserPace]   = useState<number | null>(null);
  // Enriched cover: set when Book Detail hydration finds a cover not present at
  // navigation time (e.g. imported books that had no cover in the DB yet).
  const [enrichedCoverUrl, setEnrichedCoverUrl]       = useState<string | null>(null);
  const [metaFromGb, setMetaFromGb]                   = useState(false);
  const [contentWarnings, setContentWarnings]         = useState<string[]>([]);
  const [warningsExpanded, setWarningsExpanded]       = useState(false);

  // User reading history: rating, finished date, review, private note.
  // Fetched directly from user_books on open so it's always current.
  const [userHistory, setUserHistory] = useState<{
    rating:      number | null;
    finishedAt:  string | null;
    reviewBody:  string | null;
    privateNote: string | null;
  } | null>(null);

  // Reading progress state
  const [userBookId, setUserBookId]           = useState<string | null>(null);
  const [userId, setUserId]                   = useState<string | null>(null);
  const [currentPage, setCurrentPage]         = useState<number | null>(null);
  const [pageCount, setPageCount]             = useState<number | null>(null);
  const [yearlyGoal, setYearlyGoal]           = useState<number | null>(null);
  const [progressUpdatedAt, setProgressUpdatedAt] = useState<string | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);

  // Inline progress editor
  const [editingProgress, setEditingProgress] = useState(false);
  const [pageInput, setPageInput]       = useState('');
  const [savingProgress, setSavingProgress] = useState(false);
  const [progressError, setProgressError]  = useState<string | null>(null);

  // Inline page-count editor
  const [editingPageCount, setEditingPageCount] = useState(false);
  const [pageCountInput, setPageCountInput] = useState('');
  const [savingPageCount, setSavingPageCount] = useState(false);
  const [pageCountError, setPageCountError] = useState<string | null>(null);

  // Edition awareness
  // selectedEditionKey — the OL edition ID the user has explicitly chosen (from user_books.edition_key)
  // editions — candidate editions fetched from OL for the edition picker
  // showEditionPicker — controls the edition picker bottom sheet
  // savingEdition — true while persisting an edition choice
  const [selectedEditionKey, setSelectedEditionKey] = useState<string | null>(null);
  const [editions, setEditions]                     = useState<OLEdition[]>([]);
  const [showEditionPicker, setShowEditionPicker]   = useState(false);
  const [showAllEditions, setShowAllEditions]       = useState(false);
  const [savingEdition, setSavingEdition]           = useState(false);
  // pendingEditionKey tracks which edition row is actively being saved so the
  // loading spinner appears on the tapped row rather than the old selection.
  const [pendingEditionKey, setPendingEditionKey]   = useState<string | null>(null);

  // Edit-history modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editRating, setEditRating]       = useState<number | null>(null);
  const [editNote, setEditNote]           = useState('');
  const [savingEdit, setSavingEdit]       = useState(false);

  // Taste preferences state (used by Why this book? section)
  const [hasTastePrefs, setHasTastePrefs] = useState<boolean | null>(null);

  // Recommendation context — written by RecCard on tap, read here on mount.
  // Primary source: synchronous session cache (getRecContext) — populated on
  // the immediate tap-through, zero latency.
  // Fallback source: rec_snapshots DB row — populated by a useEffect once
  // userId resolves, covers restarts / direct nav / session expiry.
  // Null when no evidence exists for this book for this user.
  const [recCtx, setRecCtx] = useState<RecContext | null>(() =>
    externalId ? getRecContext(externalId) : null
  );

  // Series section — cover images for the carousel (populated post-mount).
  // Structure comes synchronously from the static catalog via seriesName param.
  type SeriesCoverItem = { olKey: string; coverId: number | null; title: string };
  const [seriesCovers, setSeriesCovers]     = useState<SeriesCoverItem[]>([]);
  const [snappedIndex, setSnappedIndex]     = useState<number>(0);
  const seriesScrollRef = useRef<ScrollView>(null);
  // Per-position user status for the series strip labels.
  // Map: 1-indexed position → user's status ('reading' | 'finished' | 'want_to_read').
  // Populated post-mount; empty until the query resolves.
  const [seriesUserPositions, setSeriesUserPositions] = useState<Map<number, string>>(new Map());

  // Saga progress section — per-sub-series completion state.
  // Structure (number of sub-series rows) is synchronous from the static
  // SAGA_CATALOG.  Only the visual states (complete/in_progress/not_started)
  // update async — no layout changes after load.
  type SagaSeriesState = {
    maxRead: number;
    total:   number;
    status:  'complete' | 'in_progress' | 'not_started';
  };
  const [sagaProgress, setSagaProgress] = useState<Map<string, SagaSeriesState> | null>(null);
  // Collapsed by default — user taps header to reveal full structure.
  // Persists for the lifetime of this screen instance (no session storage needed).
  const [sagaExpanded, setSagaExpanded] = useState(false);

  // Local status — tracks post-transition status independently from route params
  const [localStatus, setLocalStatus]     = useState<string | undefined>(statusParam);
  const [localStartedAt, setLocalStartedAt] = useState<string | undefined>(startedAtParam);
  // Status-transition (Start Reading / Mark Finished / DNF from Book Detail)
  const [transitioning, setTransitioning]   = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  // Post-finish inline rating prompt
  const [pendingDetailRating, setPendingDetailRating] = useState<{
    completionEventId: string | null;
  } | null>(null);
  const [detailRating, setDetailRating]     = useState<number | null>(null);
  const [savingDetailRating, setSavingDetailRating] = useState(false);

  const pageInputRef      = useRef<TextInput>(null);
  const pageCountInputRef = useRef<TextInput>(null);

  // ── Undo bar ───────────────────────────────────────────────────────────────
  const undoBar = useUndoBar();

  // ── Comprehensive Book Edit Sheet ──────────────────────────────────────────
  const [showBookEditSheet, setShowBookEditSheet] = useState(false);
  const [editSheetStatus,   setEditSheetStatus]   = useState<UserBookStatus | null>(null);

  // Date modes for the edit sheet
  type FinishedMode = 'exact' | 'year' | 'unknown';
  const [editSheetFinishedMode,  setEditSheetFinishedMode]  = useState<FinishedMode>('unknown');
  const [editSheetFinishedExact, setEditSheetFinishedExact] = useState('');
  const [editSheetFinishedYear,  setEditSheetFinishedYear]  = useState(new Date().getFullYear());

  type StartedMode = 'date' | 'unknown';
  const [editSheetStartedMode, setEditSheetStartedMode] = useState<StartedMode>('unknown');
  const [editSheetStartedExact, setEditSheetStartedExact] = useState('');

  const [savingBookEdit,        setSavingBookEdit]        = useState(false);
  const [bookEditError,         setBookEditError]          = useState<string | null>(null);
  const [deleteConfirmVisible,  setDeleteConfirmVisible]  = useState(false);
  const [deletingBook,          setDeletingBook]          = useState(false);

  // Snapshot stored for undo after any transition/edit
  const lastSnapshotRef = useRef<BookSnapshot | null>(null);

  // ── Fetch user reading history (rating, finished date, review, note) ────────
  // Runs for every book regardless of status so the "Your History" section
  // populates for finished, dnf, or want-to-read books too.

  useEffect(() => {
    if (!bookId || !supabase) return;

    async function fetchHistory() {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      if (!userId) setUserId(user.id);

      // Select with edition_key; if the column doesn't exist yet (migration
      // not yet applied) fall back to a query without it.
      let data: Record<string, unknown> | null = null;
      const { data: d1, error: e1 } = await supabase
        .from('user_books')
        .select('id, rating, finished_at, review_body, private_note, edition_key')
        .eq('user_id', user.id)
        .eq('book_id', bookId!)
        .maybeSingle();
      if (!e1) {
        data = d1 as Record<string, unknown> | null;
      } else {
        // The edition_key column may not exist yet (migration pending).
        // PostgreSQL "undefined_column" has code 42703; PostgREST surfaces it
        // as PGRST204 or a message containing "does not exist".
        // Retry without edition_key only for schema errors; log other causes.
        const isSchemaError =
          e1.code === '42703' ||
          e1.code === 'PGRST204' ||
          (typeof e1.message === 'string' && e1.message.includes('does not exist'));
        if (!isSchemaError) {
          console.warn('[BOOK_DETAIL] user_books select failed unexpectedly:', e1.code, e1.message);
        }
        const { data: d2 } = await supabase
          .from('user_books')
          .select('id, rating, finished_at, review_body, private_note')
          .eq('user_id', user.id)
          .eq('book_id', bookId!)
          .maybeSingle();
        data = d2 as Record<string, unknown> | null;
      }

      if (data) {
        if (data.id && !userBookId) setUserBookId(data.id as string);
        // Restore persisted edition choice
        if (data.edition_key) setSelectedEditionKey(data.edition_key as string);
        const h = {
          rating:      (data.rating      as number | null) ?? null,
          finishedAt:  (data.finished_at as string | null) ?? null,
          reviewBody:  (data.review_body as string | null) ?? null,
          privateNote: (data.private_note as string | null) ?? null,
        };
        if (h.rating || h.finishedAt || h.reviewBody || h.privateNote) {
          setUserHistory(h);
        }
      }

      const { data: finishedBooks } = await supabase
        .from('user_books')
        .select('started_at, finished_at, book:books(page_count)')
        .eq('user_id', user.id)
        .eq('status', 'finished')
        .not('started_at', 'is', null)
        .not('finished_at', 'is', null);
      if (finishedBooks && finishedBooks.length >= 2) {
        const pace = computeUserAvgPace(
          (finishedBooks as any[]).map(r => ({
            started_at:  r.started_at as string | null,
            finished_at: r.finished_at as string | null,
            pageCount:   (r.book as any)?.page_count as number | null,
          }))
        );
        setAvgUserPace(pace);
      }
    }

    fetchHistory();
  }, [bookId]);

  const badge     = localStatus ? (STATUS_META[localStatus] ?? null) : null;
  const hasRecCtx = !!(fromUser || toUser || note);
  const isReading = localStatus === 'reading' || localStatus === 'started';

  // ── Self-healing metadata enrichment ─────────────────────────────────────
  // Runs for every book (not just those with an OL externalId).
  // Phase 1: fetch current DB row to get ISBNs and check which fields are
  //          already populated — skip work for complete books.
  // Phase 2: Open Library (if externalId available) for description/subjects/pages.
  // Phase 3: Google Books (isbn13 → isbn → title+author) for any still-missing
  //          cover, description, or page count.
  // Phase 4: persist every newly found field to the books table (null-guarded)
  //          and patch local state so the UI updates immediately.

  useEffect(() => {
    if (!bookId || !supabase) return;

    // Reset content warnings so stale data from a previously viewed book
    // never bleeds into the next book (state carries over across navigations).
    setContentWarnings([]);
    setWarningsExpanded(false);

    // Pre-populate description/subjects/pageCount from session cache so the UI
    // shows content immediately on revisit without waiting for the DB query.
    const _cachedMeta = _bookMetaCache.get(bookId!);
    if (_cachedMeta) {
      setOlMeta({
        description: _cachedMeta.description,
        subjects:    _cachedMeta.subjects,
        pageCount:   _cachedMeta.pageCount,
      });
      if (_cachedMeta.contentWarnings.length > 0) {
        setContentWarnings(_cachedMeta.contentWarnings);
      }
    }
    // Only show the skeleton if there is nothing in the cache yet
    setMetaLoading(!_cachedMeta);

    async function enrich() {
      if (!supabase) return;

      // ── 1. Current DB state ──────────────────────────────────────────────
      // `description` (migration 20260315000004), `subjects` (20260315000002),
      // and `content_warnings` (20260413000002) may not exist yet.
      // Degrade gracefully — each column gets its own exists flag so that a
      // missing content_warnings column does not incorrectly suppress description
      // persistence or mark descColExists as false.
      type BookRow = {
        cover_url?: string | null;
        description?: string | null;
        subjects?: string[] | null;
        content_warnings?: string[] | null;
        page_count?: number | null;
        isbn13?: string | null;
        isbn?: string | null;
        external_id?: string | null;
      };
      let row: BookRow | null = null;
      let descColExists     = true;
      let subjColExists     = true;
      let warningsColExists = true;

      // Phase 1 fetch — all columns including content_warnings.
      const { data: r1, error: e1 } = await supabase
        .from('books')
        .select('cover_url, description, subjects, content_warnings, page_count, isbn13, isbn, external_id')
        .eq('id', bookId!)
        .maybeSingle();

      if (!e1) {
        row = r1 as BookRow | null;
      } else {
        // content_warnings column may not exist yet — retry without it before
        // concluding that description is missing (previous bug: e1 failure was
        // incorrectly attributed to description being absent).
        warningsColExists = false;
        const { data: r1b, error: e1b } = await supabase
          .from('books')
          .select('cover_url, description, subjects, page_count, isbn13, isbn, external_id')
          .eq('id', bookId!)
          .maybeSingle();
        if (!e1b) {
          row = r1b as BookRow | null;
        } else {
          // description column also absent — continue degrading.
          descColExists = false;
          const { data: r2, error: e2 } = await supabase
            .from('books')
            .select('cover_url, subjects, page_count, isbn13, isbn, external_id')
            .eq('id', bookId!)
            .maybeSingle();
          if (!e2) {
            row = r2 as BookRow | null;
          } else {
            subjColExists = false;
            const { data: r3 } = await supabase
              .from('books')
              .select('cover_url, page_count, isbn13, isbn, external_id')
              .eq('id', bookId!)
              .maybeSingle();
            row = r3 as BookRow | null;
          }
        }
      }

      const dbIsbn13          = row?.isbn13   ?? null;
      const dbIsbn            = row?.isbn     ?? null;
      const dbDesc            = row?.description ?? null;
      const dbSubjects: string[] = row?.subjects ?? [];
      const dbContentWarnings: string[] = row?.content_warnings ?? [];
      const dbPages           = row?.page_count ?? null;
      const dbCover           = row?.cover_url  ?? null;
      // Attribution: mark as Google Books sourced if the stored cover URL is a GB URL.
      if (dbCover && (dbCover.includes('books.google.com') || dbCover.includes('googleapis.com'))) {
        setMetaFromGb(true);
      }
      // Prefer DB external_id (authoritative) over route param.
      // Only treat the value as a usable OL identifier when it starts with /works/OL.
      // Goodreads-prefixed values ("goodreads:{id}") from the old import path are
      // truthy but not valid OL ids; normalize them to null so searchOLWork fires.
      const rawExtId = row?.external_id ?? externalId ?? null;
      let olId: string | null = isOLId(rawExtId) ? rawExtId : null;
      let discoveredExtId: string | null = null;

      // Navigation-time cover takes precedence over DB (might be a CDN url passed
      // through route params that hasn't been persisted yet).
      const hasCover    = !!(coverUrl || dbCover);
      const hasDesc     = !!dbDesc;
      const hasSubjects = dbSubjects.length > 0;
      const hasPages    = !!dbPages;

      // ── Fast-path: DB already has all four fields — skip every network call. ──
      // Must come BEFORE searchOLWork so a fully-enriched book pays zero latency.
      if (hasCover && hasDesc && hasSubjects && hasPages) {
        const richMeta = { description: dbDesc, subjects: dbSubjects, pageCount: dbPages };
        setOlMeta(richMeta);
        // Derive content warnings from DB subjects if not already stored.
        const fastWarnings = dbContentWarnings.length > 0
          ? dbContentWarnings
          : deriveContentWarnings(dbSubjects);
        if (fastWarnings.length > 0) setContentWarnings(fastWarnings);
        _cacheBookMeta(bookId!, {
          description: dbDesc,
          subjects:    dbSubjects,
          pageCount:   dbPages,
          contentWarnings: fastWarnings,
        });
        // Backfill content_warnings in DB if subjects exist but warnings column was empty.
        if (dbContentWarnings.length === 0 && fastWarnings.length > 0 && warningsColExists && supabase) {
          supabase.from('books').update({ content_warnings: fastWarnings }).eq('id', bookId!).then(() => {});
        }
        setMetaLoading(false);
        return;
      }

      // ── Early skeleton clear: paint whatever the DB already has, then let
      //    OL/GB complete silently in the background.  The skeleton should only
      //    cover the single DB round-trip (~300 ms), not the full enrichment chain.
      if (hasDesc || hasSubjects || hasPages) {
        setOlMeta({ description: dbDesc, subjects: dbSubjects, pageCount: dbPages });
        setMetaLoading(false); // OL/GB updates arrive as silent in-place patches
      }

      // When external_id is absent (common for Goodreads imports), search OL by
      // title+author to discover the works key so description can be fetched.
      // The discovered key is persisted to the DB in the patch below.
      if (!olId && (!hasDesc || !hasSubjects)) {
        const t = String(title  ?? '').trim();
        const a = String(author ?? '').trim();
        if (t) {
          const found = await searchOLWork(t, a);
          if (found) {
            olId              = found;
            discoveredExtId   = found;
          }
        }
      }

      let foundDesc:     string | null = null;
      let foundSubjects: string[]      = [];
      let foundPages:    number | null = null;
      let foundCover:    string | null = null;

      // ── 2. Open Library (description + subjects + page_count) ────────────
      if (olId && (!hasDesc || !hasSubjects || !hasPages)) {
        const ol = await fetchOLMeta(olId);
        if (!hasDesc     && ol.description)        foundDesc     = ol.description;
        if (!hasSubjects && ol.subjects.length > 0) foundSubjects = ol.subjects;
        if (!hasPages    && ol.pageCount)           foundPages    = ol.pageCount;
        // Update UI immediately with whatever OL returned.
        setOlMeta({
          description: foundDesc ?? dbDesc,
          subjects:    foundSubjects.length > 0 ? foundSubjects : dbSubjects,
          pageCount:   foundPages ?? dbPages,
        });
      } else if (dbDesc || dbSubjects.length > 0) {
        // Pre-populate UI from DB so existing data shows while Google Books runs.
        setOlMeta({ description: dbDesc, subjects: dbSubjects, pageCount: dbPages });
      }

      // ── 3. Google Books (cover + any still-missing desc/pages) ───────────
      const needGb = !hasCover || (!hasDesc && !foundDesc) || (!hasPages && !foundPages);
      if (needGb) {
        const t = String(title  ?? '').trim();
        const a = String(author ?? '').trim();
        if (t) {
          const gb = await fetchGoogleBooksMetadata({
            isbn13: dbIsbn13,
            isbn:   dbIsbn,
            title:  t,
            author: a,
          });
          if (!hasCover               && gb.cover_url)   foundCover = gb.cover_url;
          if (!hasDesc  && !foundDesc && gb.description) foundDesc  = gb.description;
          if (!hasPages && !foundPages && gb.page_count)  foundPages = gb.page_count;

          // Patch olMeta with Google Books values for any still-missing fields.
          if (gb.description || gb.page_count) {
            setOlMeta(prev => ({
              description: prev?.description ?? gb.description ?? null,
              subjects:    prev?.subjects    ?? [],
              pageCount:   prev?.pageCount   ?? gb.page_count  ?? null,
            }));
          }
          // Attribution: GB was called and returned at least one useful field.
          if (gb.cover_url || gb.description || gb.page_count) {
            setMetaFromGb(true);
          }
        }
      }

      // ── 4. Local state + DB persistence ──────────────────────────────────
      if (foundCover) setEnrichedCoverUrl(foundCover);
      if (foundPages) setPageCount(prev => prev ?? foundPages!);

      // Derive content warnings from the best available subjects.
      const finalSubjects = foundSubjects.length > 0 ? foundSubjects : dbSubjects;
      const derivedWarnings = dbContentWarnings.length > 0
        ? dbContentWarnings
        : deriveContentWarnings(finalSubjects);
      if (derivedWarnings.length > 0) setContentWarnings(derivedWarnings);

      const patch: Record<string, unknown> = {};
      if (discoveredExtId)                                      patch.external_id     = discoveredExtId;
      if (foundCover    && !hasCover)                           patch.cover_url       = foundCover;
      if (foundDesc     && !hasDesc     && descColExists)       patch.description     = foundDesc;
      if (foundSubjects.length > 0      && subjColExists)       patch.subjects        = foundSubjects;
      if (foundPages    && !hasPages)                           patch.page_count      = foundPages;
      if (dbContentWarnings.length === 0 && derivedWarnings.length > 0 && warningsColExists)
                                                                patch.content_warnings = derivedWarnings;

      if (Object.keys(patch).length > 0 && supabase) {
        supabase.from('books').update(patch).eq('id', bookId!).then(() => {});
      }

      // Write whatever was discovered to the session cache so the next visit
      // to this book renders description/subjects immediately with no skeleton.
      _cacheBookMeta(bookId!, {
        description:     foundDesc ?? row?.description ?? null,
        subjects:        finalSubjects,
        pageCount:       foundPages  ?? row?.page_count ?? null,
        contentWarnings: derivedWarnings,
      });

      setMetaLoading(false);
    }

    enrich();
  }, [bookId]);

  // ── Fetch reading progress + yearly goal ─────────────────────────────────

  useEffect(() => {
    if (!isReading || !bookId || !supabase) return;
    setProgressLoading(true);

    async function fetchProgress() {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setProgressLoading(false); return; }

      const [userBookRes, bookRes, profileRes] = await Promise.all([
        supabase
          .from('user_books')
          .select('id, current_page, progress_updated_at')
          .eq('user_id', user.id)
          .eq('book_id', bookId!)
          .maybeSingle(),
        supabase
          .from('books')
          .select('page_count')
          .eq('id', bookId!)
          .maybeSingle(),
        (() => {
          const goalFromParam = readingGoalParam ? parseInt(readingGoalParam, 10) : NaN;
          if (!isNaN(goalFromParam) && goalFromParam > 0) {
            return Promise.resolve({ data: { yearly_reading_goal: goalFromParam } });
          }
          return supabase
            .from('profiles')
            .select('yearly_reading_goal')
            .eq('id', user.id)
            .single();
        })(),
      ]);

      setUserId(user.id);

      if (userBookRes.data) {
        setUserBookId(userBookRes.data.id);
        const cp = userBookRes.data.current_page ?? null;
        setCurrentPage(cp);
        setPageInput(cp != null ? String(cp) : '');
        setProgressUpdatedAt((userBookRes.data.progress_updated_at as string | null) ?? null);
      }
      if (bookRes.data?.page_count) {
        setPageCount(bookRes.data.page_count);
      }
      if (profileRes.data?.yearly_reading_goal) {
        setYearlyGoal(profileRes.data.yearly_reading_goal);
      }
      setProgressLoading(false);
    }

    fetchProgress();
  }, [isReading, bookId, readingGoalParam]);

  // ── Fetch taste preferences existence ─────────────────────────────────────

  useEffect(() => {
    if (!supabase) return;

    async function fetchPrefsExistence() {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from('reader_preferences')
        .select('favorite_genres, reading_styles')
        .eq('user_id', user.id)
        .maybeSingle();

      const hasPrefs = !!(data && (
        (data.favorite_genres && data.favorite_genres.length > 0) ||
        (data.reading_styles && data.reading_styles.length > 0)
      ));
      setHasTastePrefs(hasPrefs);
    }

    fetchPrefsExistence();
  }, []);

  // ── Rec snapshot fallback — DB read when session cache is empty ───────────
  // The session cache (getRecContext) is populated synchronously on a fresh
  // tap-through from the rec feed.  This effect covers cases where that cache
  // is empty: direct nav, app restart, session expiry, or second visit after
  // kill-and-reopen.  It fires once when userId resolves.  If the DB has a
  // persisted snapshot, setRecCtx fills in the "Why this book?" section exactly
  // as if the user had just tapped the card.
  useEffect(() => {
    if (recCtx !== null) return;     // session cache hit — no DB needed
    if (!userId || !externalId) return;

    let cancelled = false;
    getRecSnapshot(userId, externalId).then(snap => {
      if (!cancelled && snap) setRecCtx(snap);
    });
    return () => { cancelled = true; };
  }, [userId]);  // eslint-disable-line react-hooks/exhaustive-deps — userId is the only gating signal

  // ── Edition candidates fetch ───────────────────────────────────────────────
  // Fires once after mount when an OL works ID is available (either from the
  // route param or from the DB).  Populates the editions array for the picker.
  // Results are cached per work in lib/openLibrary so revisits are instant.
  useEffect(() => {
    if (!bookId) return;

    let cancelled = false;

    async function loadEditions() {
      // Resolution priority for the OL work ID:
      //   1. Route param externalId (cheapest — already in memory)
      //   2. book_source_links where source='openlibrary' (authoritative per task spec)
      //   3. books.external_id (legacy fallback)
      let olId: string | null = isOLId(externalId) ? externalId! : null;

      if (!olId && supabase) {
        // Check book_source_links first — the task spec requires using the OL
        // work ID stored there.  source_book_id on a source='openlibrary' row
        // is the /works/OL... key written by the metadata pipeline.
        const { data: linkRow } = await supabase
          .from('book_source_links')
          .select('source_book_id')
          .eq('book_id', bookId!)
          .eq('source', 'openlibrary')
          .maybeSingle();
        const linkId = (linkRow as { source_book_id?: string | null } | null)?.source_book_id ?? null;
        if (isOLId(linkId)) olId = linkId;
      }

      // Fallback: books.external_id (covers books where source_link hasn't been
      // written yet — e.g. Goodreads imports that went through the old path).
      if (!olId && supabase) {
        const { data: booksRow } = await supabase
          .from('books')
          .select('external_id')
          .eq('id', bookId!)
          .maybeSingle();
        const rawId = (booksRow as { external_id?: string | null } | null)?.external_id ?? null;
        if (isOLId(rawId)) olId = rawId;
      }

      if (!olId || cancelled) return;

      const eds = await fetchEditions(olId);
      if (!cancelled) {
        setEditions(rankEditions(eds, 'eng'));
        setShowAllEditions(false);
      }
    }

    loadEditions();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ── Series cover fetch ────────────────────────────────────────────────────
  // Fires once on mount when seriesName param is present.
  // Series STRUCTURE (name, orderedBooks, total) is synchronous from the
  // static catalog.  This effect only resolves cover IMAGE ids so the
  // placeholder boxes already rendered on first paint can fill in.
  useEffect(() => {
    if (!seriesName) return;
    const meta = getSeriesCatalog(seriesName);
    if (!meta) return;

    const BAD_EDITION = /collection|omnibus|boxed|box set|complete works|anthology/i;

    const fetchCover = async (
      b: { title: string; author: string },
    ): Promise<SeriesCoverItem | null> => {
      try {
        const url = [
          'https://openlibrary.org/search.json',
          `?title=${encodeURIComponent(b.title)}`,
          `&author=${encodeURIComponent(b.author)}`,
          '&fields=key,title,cover_i&limit=5',
        ].join('');
        const data = await fetch(url).then(r => r.json()) as {
          docs?: Array<{ key: string; cover_i?: number; title?: string }>;
        };
        const docs = data.docs ?? [];
        const clean = docs.find(d => d.cover_i != null && !BAD_EDITION.test(d.title ?? ''));
        if (!clean || clean.cover_i == null) return null;
        return { olKey: clean.key, coverId: clean.cover_i, title: clean.title ?? b.title };
      } catch {
        return null;
      }
    };

    let cancelled = false;
    Promise.all(meta.orderedBooks.map(fetchCover)).then(results => {
      if (cancelled) return;
      const covers = results.map((r, i): SeriesCoverItem =>
        r ?? { olKey: `placeholder-${i}`, coverId: null, title: meta.orderedBooks[i].title }
      );
      setSeriesCovers(covers);
    });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesName]);

  // ── Auto-center carousel on current book position ─────────────────────────
  // Fires once after mount (layout pass needed first) when series params exist.
  // snappedIndex is initialised here so haptic baseline is correct.
  const SNAP_W = 76; // item container width (68) + marginRight (8) = snap interval
  useEffect(() => {
    if (!hasSeriesMeta || seriesPos == null) return;
    const targetIndex = seriesPos - 1;
    setSnappedIndex(targetIndex);
    const timer = setTimeout(() => {
      seriesScrollRef.current?.scrollTo({ x: targetIndex * SNAP_W, animated: false });
    }, 100);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Saga progress fetch ───────────────────────────────────────────────────
  // Fetches the user's finished/reading books and cross-references with the
  // saga catalog to determine per-sub-series completion state.
  //
  // The visual STATE (complete/in_progress/not_started) updates asynchronously.
  // The visual STRUCTURE (number of sub-series rows, row heights) is
  // deterministic from static catalog data and does not change after load.
  useEffect(() => {
    if (!seriesName || !userId) return;
    const sagaEntry = getSagaForSeries(seriesName);
    if (!sagaEntry) return;                        // book is not in a tracked saga
    const allSagas = getAllSagaCatalog();
    const saga     = allSagas[sagaEntry.sagaKey];
    if (!saga) return;

    supabase
      .from('user_books')
      .select('title, author, status')
      .eq('user_id', userId)
      .in('status', ['finished', 'reading'])
      .then(({ data }) => {
        if (!data) return;

        // Map each fetched book to its series using the static catalog.
        const maxReadBySeries = new Map<string, number>();
        for (const book of data) {
          const found = findSeriesForBook(book.title, book.author);
          if (!found) continue;
          if (!saga.series_order.includes(found.seriesName)) continue;
          const prev = maxReadBySeries.get(found.seriesName) ?? 0;
          if (found.seriesPosition > prev) {
            maxReadBySeries.set(found.seriesName, found.seriesPosition);
          }
        }

        // Build per-series state.
        const progress = new Map<string, SagaSeriesState>();
        for (const sKey of saga.series_order) {
          const cat = getSeriesCatalog(sKey);
          if (!cat) continue;
          const maxRead = maxReadBySeries.get(sKey) ?? 0;
          const total   = cat.total;
          const status: SagaSeriesState['status'] =
            maxRead >= total ? 'complete' :
            maxRead > 0      ? 'in_progress' :
            'not_started';
          progress.set(sKey, { maxRead, total, status });
        }
        setSagaProgress(progress);
      });
  // userId is the resolved user id string; sagaKey is stable per seriesName.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesName, userId]);

  // ── Series strip user positions ───────────────────────────────────────────
  // Fetches user's reading/finished/want-to-read books and maps them to
  // series positions so the carousel can show per-book state labels.
  // Reuses the same pattern as the saga progress fetch above.
  useEffect(() => {
    if (!seriesName || !userId || !supabase) return;
    const catalog = getSeriesCatalog(seriesName);
    if (!catalog) return;

    supabase
      .from('user_books')
      .select('status, book:books(title, author)')
      .eq('user_id', userId)
      .in('status', ['finished', 'reading', 'want_to_read'])
      .then(({ data }) => {
        if (!data) return;
        const posMap = new Map<number, string>();
        for (const ub of data as Array<{ status: string; book: { title: string; author: string } | null }>) {
          const book = ub.book;
          if (!book) continue;
          const found = findSeriesForBook(book.title ?? '', book.author ?? '');
          if (!found || found.seriesName !== seriesName) continue;
          posMap.set(found.seriesPosition, ub.status);
        }
        setSeriesUserPositions(posMap);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesName, userId]);

  // ── Edit-history save ─────────────────────────────────────────────────────

  async function handleSaveEdit() {
    if (!supabase || !bookId || savingEdit) return;
    setSavingEdit(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSavingEdit(false); return; }

    const patch: Record<string, unknown> = {};
    if (editRating !== null) patch.rating = editRating;
    if (editNote.trim() !== '') patch.review_body = editNote.trim();

    if (Object.keys(patch).length > 0) {
      if (userBookId) {
        // Preferred: update exact row — no duplicate risk
        await supabase.from('user_books').update(patch).eq('id', userBookId);
      } else {
        // Fallback: upsert by unique (user_id, book_id) constraint
        patch.user_id = user.id;
        patch.book_id = bookId!;
        await supabase.from('user_books').upsert(patch, { onConflict: 'user_id,book_id' });
      }
      setUserHistory(prev => prev ? {
        ...prev,
        rating:     editRating !== null ? editRating : prev.rating,
        reviewBody: editNote.trim() !== '' ? editNote.trim() : prev.reviewBody,
      } : prev);
    }

    setSavingEdit(false);
    setShowEditModal(false);
  }

  // ── Progress save ─────────────────────────────────────────────────────────

  async function handleSaveProgress() {
    if (!supabase || !userBookId) return;
    const newPage = parseInt(pageInput.trim(), 10);
    if (isNaN(newPage) || newPage < 0) {
      setProgressError('Enter a valid page number.');
      return;
    }
    if (pageCount && newPage > pageCount) {
      setProgressError(`Can't exceed total pages (${pageCount}).`);
      return;
    }
    setProgressError(null);
    setSavingProgress(true);

    // Resolve userId if not yet in state (rare on cold open)
    const uid = userId ?? (await supabase.auth.getUser()).data.user?.id ?? null;

    // saveCurrentPage writes user_books.current_page + reading_progress_events
    // + reading_sessions (forward progress only) — stats screen reads sessions
    let saveErrMsg: string | null = null;
    if (uid && bookId) {
      const { error } = await saveCurrentPage(supabase, {
        userBookId, bookId, userId: uid, newPage, currentPage,
      });
      saveErrMsg = error;
    } else {
      // Fallback: uid/bookId not yet resolved — bare update, no session row
      const { error } = await supabase
        .from('user_books')
        .update({ current_page: newPage, progress_updated_at: new Date().toISOString() })
        .eq('id', userBookId);
      if (error) saveErrMsg = 'Could not save — try again.';
    }

    setSavingProgress(false);
    if (!saveErrMsg) {
      setCurrentPage(newPage);
      // Page progress shown on Library and Home cards — invalidate so they re-fetch
      invalidateBookDataCaches();
      setEditingProgress(false);
      Keyboard.dismiss();
    } else {
      setProgressError(saveErrMsg);
    }
  }

  // ── Page count save ───────────────────────────────────────────────────────

  async function handleSavePageCount() {
    if (!supabase || !bookId) return;
    const newCount = parseInt(pageCountInput.trim(), 10);
    if (isNaN(newCount) || newCount < 1 || newCount > 9999) {
      setPageCountError('Enter a number between 1 and 9,999.');
      return;
    }
    setPageCountError(null);
    setSavingPageCount(true);
    const { data, error } = await supabase
      .from('books')
      .update({ page_count: newCount })
      .eq('id', bookId!)
      .select('id');
    setSavingPageCount(false);
    if (error) {
      setPageCountError(`Could not save — ${error.message}`);
    } else if (!data || data.length === 0) {
      setPageCountError('Could not save — permission denied. Try reloading.');
    } else {
      setPageCount(newCount);
      setEditingPageCount(false);
      Keyboard.dismiss();
    }
  }

  // ── Status transitions (Start Reading / Mark Finished / DNF) ─────────────

  async function handleTransition(newStatus: UserBookStatus) {
    if (!supabase || !userBookId || !bookId) return;
    const uid = userId ?? (await supabase.auth.getUser()).data.user?.id ?? null;
    if (!uid) return;
    setTransitionError(null);
    setTransitioning(true);

    const { data, error, snapshot } = await transitionStatus(supabase, {
      userBookId,
      bookId,
      userId:             uid,
      newStatus,
      existingFinishedAt: userHistory?.finishedAt ?? null,
    });

    setTransitioning(false);
    if (error) {
      setTransitionError(error);
      return;
    }

    if (snapshot) lastSnapshotRef.current = snapshot;
    setLocalStatus(newStatus);
    if (data?.startedAt) setLocalStartedAt(data.startedAt);
    // Status changed — Library and Home must re-fetch on next focus
    invalidateBookDataCaches();

    // Undo bar for status change (only for non-finish transitions — finish has its own rating modal)
    if (newStatus !== 'finished' && newStatus !== 'dnf' && snapshot) {
      undoBar.trigger(
        `Status changed to ${STATUS_META[newStatus]?.label ?? newStatus}`,
        async () => {
          if (!supabase || !userBookId || !snapshot) return;
          await restoreSnapshot(supabase, { userBookId, snapshot });
          setLocalStatus(snapshot.status);
          setLocalStartedAt(snapshot.startedAt ?? undefined);
        },
      );
    }

    if (newStatus === 'finished' || newStatus === 'dnf') {
      setPendingDetailRating({ completionEventId: data?.completionEventId ?? null });
      if (newStatus === 'finished') triggerRecPrewarm(supabase, uid);
    }
  }

  // ── Open the comprehensive book edit sheet ────────────────────────────────

  function openBookEditSheet() {
    // Pre-populate edit sheet from current state.
    const status = (localStatus as UserBookStatus) ?? 'want_to_read';
    setEditSheetStatus(status);

    // Finished date
    const curFinishedAt = userHistory?.finishedAt ?? null;
    if (curFinishedAt) {
      const d = new Date(curFinishedAt);
      const yyyy = d.getUTCFullYear();
      const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd   = String(d.getUTCDate()).padStart(2, '0');
      setEditSheetFinishedExact(`${yyyy}-${mm}-${dd}`);
      setEditSheetFinishedYear(yyyy);
      setEditSheetFinishedMode('exact');
    } else {
      setEditSheetFinishedExact('');
      setEditSheetFinishedYear(new Date().getFullYear());
      setEditSheetFinishedMode('unknown');
    }

    // Started date
    const curStartedAt = localStartedAt ?? null;
    if (curStartedAt) {
      const d2   = new Date(curStartedAt);
      const yyyy = d2.getUTCFullYear();
      const mm   = String(d2.getUTCMonth() + 1).padStart(2, '0');
      const dd   = String(d2.getUTCDate()).padStart(2, '0');
      setEditSheetStartedExact(`${yyyy}-${mm}-${dd}`);
      setEditSheetStartedMode('date');
    } else {
      setEditSheetStartedExact('');
      setEditSheetStartedMode('unknown');
    }

    setBookEditError(null);
    setDeleteConfirmVisible(false);
    setShowBookEditSheet(true);
  }

  // ── Save from the book edit sheet ─────────────────────────────────────────

  async function handleBookEditSave() {
    if (!supabase || !userBookId) return;
    setSavingBookEdit(true);
    setBookEditError(null);

    const finishedInput: FinishedDateInput = (() => {
      if (editSheetFinishedMode === 'exact' && editSheetFinishedExact.trim()) {
        return { kind: 'exact', date: editSheetFinishedExact.trim() } as const;
      }
      if (editSheetFinishedMode === 'year') {
        return { kind: 'year', year: editSheetFinishedYear } as const;
      }
      return { kind: 'unknown' } as const;
    })();

    const startedInput: StartedDateInput = (() => {
      if (editSheetStartedMode === 'date' && editSheetStartedExact.trim()) {
        return { kind: 'date', date: editSheetStartedExact.trim() } as const;
      }
      return { kind: 'unknown' } as const;
    })();

    const uid = userId ?? (await supabase.auth.getUser()).data.user?.id ?? null;
    if (!uid) { setSavingBookEdit(false); return; }

    const { result, error } = await editUserBook(supabase, {
      userBookId,
      userId: uid,
      newStatus:  editSheetStatus ?? undefined,
      startedAt:  startedInput,
      finishedAt: finishedInput,
    });

    setSavingBookEdit(false);

    if (error) {
      setBookEditError(error);
      return;
    }

    // Store snapshot for undo
    if (result?.snapshot) lastSnapshotRef.current = result.snapshot;
    // Status / dates changed — Library and Home must re-fetch on next focus
    invalidateBookDataCaches();

    // Update local display state
    if (editSheetStatus) setLocalStatus(editSheetStatus);
    if (startedInput.kind === 'date') setLocalStartedAt(startedInput.date);
    if (startedInput.kind === 'unknown') setLocalStartedAt(undefined);

    const newFinishedAt =
      finishedInput.kind === 'exact'   ? new Date(finishedInput.date).toISOString()
      : finishedInput.kind === 'year'  ? `${finishedInput.year}-12-31T00:00:00.000Z`
      : null;

    setUserHistory(prev => prev
      ? { ...prev, finishedAt: newFinishedAt }
      : { rating: null, finishedAt: newFinishedAt, reviewBody: null, privateNote: null }
    );

    setShowBookEditSheet(false);

    const snap = result?.snapshot;
    undoBar.trigger('Book updated', async () => {
      if (!supabase || !userBookId || !snap) return;
      await restoreSnapshot(supabase, { userBookId, snapshot: snap });
      setLocalStatus(snap.status);
      setLocalStartedAt(snap.startedAt ?? undefined);
      setUserHistory(prev => prev
        ? { ...prev, finishedAt: snap.finishedAt }
        : { rating: null, finishedAt: snap.finishedAt, reviewBody: null, privateNote: null }
      );
    });
  }

  // ── Soft delete (Remove from library) ────────────────────────────────────

  async function handleSoftDelete() {
    if (!supabase || !userBookId) return;
    setDeletingBook(true);

    const { snapshot, error } = await softDeleteBook(supabase, { userBookId });
    setDeletingBook(false);
    setShowBookEditSheet(false);
    setDeleteConfirmVisible(false);

    if (error) return;

    if (snapshot) lastSnapshotRef.current = snapshot;
    // Book removed — Library and Home must re-fetch on next focus
    invalidateBookDataCaches();

    undoBar.trigger(
      'Removed from library',
      async () => {
        // Undo: restore the row and stay on this screen.
        if (!supabase || !userBookId || !snapshot) return;
        await restoreSnapshot(supabase, { userBookId, snapshot });
        // Restore local status display so the detail screen looks normal.
        setLocalStatus(snapshot.status);
      },
      // onAfterDismiss: navigate back only after the 6-second window closes
      // without undo, so the user has the full window to interact with the bar.
      () => safeBack(),
    );
  }

  async function handleDetailRating(rating: number) {
    if (!supabase || !userBookId || !bookId) return;
    setSavingDetailRating(true);
    const sentiment =
      rating >= 5 ? 'loved' :
      rating >= 4 ? 'liked' :
      rating === 3 ? 'okay' : 'not_for_me';
    await supabase.from('user_books').update({ rating, sentiment }).eq('id', userBookId);
    const eventId = pendingDetailRating?.completionEventId ?? null;
    if (eventId) {
      await supabase.from('activity_events').update({ rating }).eq('id', eventId);
    } else if (userId && bookId) {
      await supabase.from('activity_events').insert({
        actor_id: userId, event_type: 'book_rated', book_id: bookId, rating,
      });
    }
    setSavingDetailRating(false);
    setPendingDetailRating(null);
    setDetailRating(null);
    if (userId) triggerRecPrewarm(supabase, userId);
    safeBack();
  }

  // ── Edition selection handler ─────────────────────────────────────────────

  async function handleSelectEdition(edition: OLEdition) {
    if (!supabase || !userBookId || savingEdition) return;
    setSavingEdition(true);
    setPendingEditionKey(edition.editionKey);   // track which row shows spinner
    const key = edition.editionKey;
    const { error } = await persistEditionKey(supabase, { userBookId, editionKey: key });
    if (!error) {
      setSelectedEditionKey(key);
      // If the chosen edition has a page count, update the local pageCount so
      // progress % recalculates immediately.  current_page is never touched.
      if (edition.pageCount) setPageCount(edition.pageCount);
    }
    setSavingEdition(false);
    setPendingEditionKey(null);
    setShowEditionPicker(false);
  }

  // ── Derived edition values ────────────────────────────────────────────────
  // selectedEdition — the OLEdition for an EXPLICIT user choice only.
  // Null when selectedEditionKey is null (no override in effect).
  // Never defaults to editions[0] — that would silently change metadata.
  const selectedEdition: OLEdition | null = selectedEditionKey
    ? (editions.find(e => e.editionKey === selectedEditionKey) ?? null)
    : null;

  // displayEdition — used ONLY for the quiet edition-info line beneath author.
  // Falls back to editions[0] (the "suggested" edition, e.g. most recent English
  // print) so the line shows context before any explicit choice is made.
  // This is a UX convenience: "here's what OL thinks you're reading" — not a
  // factual claim about which edition the user actually holds.
  // It never influences effectivePageCount, cover, or progress calculations;
  // those always use selectedEdition (explicit choice only).
  const displayEdition: OLEdition | null = selectedEdition ?? editions[0] ?? null;

  // effectivePageCount overrides the canonical books.page_count ONLY when
  // the user has explicitly chosen an edition (selectedEditionKey is set).
  const effectivePageCount = (selectedEdition?.pageCount) ?? pageCount;

  // Cover URL for the hero: prefer the selected edition's OLID-based cover
  // only when the user has explicitly chosen an edition AND that edition has
  // a cover on OL (coverKey non-null).  When the selected edition has no OL
  // cover, fall through to enrichedCoverUrl / coverUrl so the canonical art
  // is preserved rather than showing an OL 404 → typographic fallback.
  const editionCoverUrl = (selectedEditionKey && selectedEdition?.coverKey)
    ? `https://covers.openlibrary.org/b/olid/${selectedEditionKey}-M.jpg`
    : null;

  // ── Derived pacing ────────────────────────────────────────────────────────

  const hasPaging       = currentPage != null && effectivePageCount != null && effectivePageCount > 0;
  const pagePacing      = hasPaging ? computePagePacing(currentPage!, effectivePageCount!, localStartedAt, yearlyGoal) : null;
  const datePacing      = !hasPaging ? computeDatePacing(localStartedAt, yearlyGoal) : null;
  const pacingState     = pagePacing?.state ?? null;
  const progressPct     = hasPaging ? Math.min(100, Math.round((currentPage! / effectivePageCount!) * 100)) : null;

  const paceEstimate    = hasPaging
    ? estimatePaceFinish(currentPage!, effectivePageCount!, localStartedAt)
    : null;
  const daysSinceUpdate = progressUpdatedAt
    ? Math.floor((Date.now() - new Date(progressUpdatedAt).getTime()) / 86_400_000)
    : null;
  const isStale         = daysSinceUpdate != null && daysSinceUpdate > 3;
  const lastUpdatedLabel = formatLastUpdated(progressUpdatedAt);

  const descText        = olMeta?.description ?? null;
  const DESC_LIMIT      = 320;
  const descTruncated   = descText && descText.length > DESC_LIMIT && !descExpanded;
  const displayDesc     = descTruncated ? descText!.slice(0, DESC_LIMIT).trimEnd() + '…' : descText;

  const pacingChipColor  = pacingState === 'ahead' ? '#15803d' : pacingState === 'behind' ? '#b91c1c' : '#78716c';
  const pacingChipBg     = pacingState === 'ahead' ? '#f0fdf4' : pacingState === 'behind' ? '#fef2f2' : '#ede9e4';
  const pacingChipBorder = pacingState === 'ahead' ? '#bbf7d0' : pacingState === 'behind' ? '#fecaca' : '#ede9e4';

  // Series section — synchronous from static catalog + route params.
  // No async dependency: if seriesName and seriesPosition are in the params,
  // and the name is in the catalog, the section renders on first paint.
  const seriesPos     = seriesPositionParam ? parseInt(seriesPositionParam, 10) : null;
  const seriesMeta    = seriesName ? getSeriesCatalog(seriesName) : null;
  const hasSeriesMeta = seriesMeta != null && seriesPos != null && !isNaN(seriesPos);

  // Saga section — synchronous from SAGA_CATALOG; visual states fill in async.
  // hasSagaMeta gates the section; sagaNextAllowed gates locked state.
  const sagaInfo          = seriesName ? getSagaForSeries(seriesName) : null;
  const sagaCatalogEntry  = sagaInfo ? getAllSagaCatalog()[sagaInfo.sagaKey] : null;
  const hasSagaMeta       = sagaInfo != null && sagaCatalogEntry != null;

  // saga_next_allowed_index — mirrors the RIL computation.
  // Before sagaProgress loads: default to current series index so the current
  // series is always marked correctly on first paint.
  // After sagaProgress loads: derived from actual per-series completion.
  let sagaNextAllowed = sagaInfo?.seriesIndex ?? 0;
  if (sagaProgress !== null && sagaCatalogEntry) {
    sagaNextAllowed = 0;
    for (let i = 0; i < sagaCatalogEntry.series_order.length; i++) {
      const s = sagaProgress.get(sagaCatalogEntry.series_order[i]);
      if (!s || s.status !== 'complete') { sagaNextAllowed = i; break; }
      sagaNextAllowed = i + 1;
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 64 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Hero cover ── */}
      {(() => {
        // Precedence (most → least specific):
        //   1. editionCoverUrl   — user explicitly chose this OL edition for THIS copy
        //   2. coverUrl          — canonical books.cover_url (matches Library/Home/etc.)
        //   3. enrichedCoverUrl  — in-session GB lookup (only when DB had no cover)
        //
        // Putting coverUrl ahead of enrichedCoverUrl is what keeps the hero
        // matching the canonical art shown in lists. enrichedCoverUrl only
        // shows through when coverUrl is genuinely null (book row had no
        // cover at navigation time and GB found one in the background).
        const activeCoverUrl = editionCoverUrl || coverUrl || enrichedCoverUrl || null;
        const isGoogleBooks = !!(activeCoverUrl && (activeCoverUrl.includes('books.google') || activeCoverUrl.includes('googleapis')));
        const glowColor = isGoogleBooks
          ? 'rgba(220, 232, 252, 0.72)'
          : 'rgba(255, 238, 195, 0.68)';
        const glowColorMid = isGoogleBooks
          ? 'rgba(230, 240, 255, 0.30)'
          : 'rgba(255, 245, 218, 0.28)';

        return (
          <View style={{ overflow: 'hidden' }}>
            {/* Base warm-to-cool gradient */}
            <LinearGradient
              colors={['#f4f0eb', '#eee9e2']}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{ paddingTop: 80, paddingBottom: 68, alignItems: 'center' }}
            >
              {/* Subtle tonal overlay for surface depth */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  opacity: 0.045,
                  backgroundColor: '#7c6e5a',
                }}
              />

              {/* Simulated radial glow behind cover — outer ring */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  width: 260,
                  height: 260,
                  borderRadius: 130,
                  backgroundColor: glowColorMid,
                  top: '50%',
                  left: '50%',
                  marginTop: -130 + 10,
                  marginLeft: -130,
                }}
              />
              {/* Simulated radial glow — inner bloom */}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  width: 160,
                  height: 160,
                  borderRadius: 80,
                  backgroundColor: glowColor,
                  top: '50%',
                  left: '50%',
                  marginTop: -80 + 10,
                  marginLeft: -80,
                }}
              />

              <BackButton
                onPress={() => safeBack()}
                style={{
                  position: 'absolute',
                  top: 76,
                  left: 20,
                  zIndex: 10,
                  backgroundColor: 'rgba(255,255,255,0.82)',
                  borderRadius: 20,
                  padding: 5,
                }}
              />

              <CoverThumb
                url={activeCoverUrl}
                externalId={externalId || null}
                editionKey={selectedEditionKey || null}
                title={title || null}
                width={122}
                height={180}
              />
            </LinearGradient>

            {/* Bottom fade: hero bleeds into page bg */}
            <LinearGradient
              colors={['rgba(238,233,226,0)', '#f5f1ec']}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              pointerEvents="none"
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: 36,
              }}
            />
          </View>
        );
      })()}

      <View style={{ paddingHorizontal: 24, paddingTop: 24 }}>

        {/* ── Header: title (dominant) / author (secondary) / badge (own row) ── */}
        <Text style={{
          fontSize: 27,
          fontWeight: '800',
          color: '#1e1b18',
          letterSpacing: -0.7,
          lineHeight: 34,
          marginBottom: 5,
        }}>
          {title ?? '—'}
        </Text>
        <Text style={{ fontSize: 15, color: '#6e6660', lineHeight: 22, marginBottom: 8 }} numberOfLines={2}>
          {author ?? '—'}
        </Text>

        {/* ── Edition line — quiet metadata row beneath author ── */}
        {displayEdition && (
          <TouchableOpacity
            onPress={editions.length > 1 ? () => { setShowAllEditions(false); setShowEditionPicker(true); } : undefined}
            activeOpacity={editions.length > 1 ? 0.6 : 1}
            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 4 }}
          >
            <Text style={{ fontSize: 12, color: '#9e958d' }}>
              {(() => {
                const pub = displayEdition.publisher?.toLowerCase().trim();
                const hasPublisher = !!pub && pub !== 'n/a' && pub !== 'na';
                return [
                  hasPublisher ? displayEdition.publisher : null,
                  displayEdition.year,
                  displayEdition.pageCount ? `${displayEdition.pageCount} pages` : null,
                ].filter(Boolean).join(' · ') || 'Unknown edition';
              })()}
            </Text>
            {editions.length > 1 && (
              <Text style={{ fontSize: 12, color: '#b5a99f', marginLeft: 4 }}>· Change edition</Text>
            )}
          </TouchableOpacity>
        )}
        {!displayEdition && <View style={{ marginBottom: 12 }} />}

        {badge && (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
            <View style={{
              backgroundColor: badge.bg,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 5,
            }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: badge.text }}>
                {badge.label}
              </Text>
            </View>
            {userBookId && (
              <TouchableOpacity
                onPress={openBookEditSheet}
                hitSlop={{ top: 10, bottom: 10, left: 12, right: 0 }}
              >
                <Text style={{ fontSize: 13, color: '#9e958d', fontWeight: '500' }}>Edit</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {!badge && !hasSeriesMeta && !hasSagaMeta && <View style={{ marginBottom: 28 }} />}
        {!badge && hasSagaMeta && !hasSeriesMeta && <View style={{ marginBottom: 12 }} />}

        {/* ── Saga Journey Section ─────────────────────────────────────────────
             Collapsed by default — shows saga name + current series + tap hint.
             Tapping the header expands to reveal full sub-series structure.
             Structure rows are synchronous from SAGA_CATALOG (static).
             Visual states (complete/in_progress/locked) update once after the
             user_books fetch — no layout change, only color/text swap.       */}
        {hasSagaMeta && sagaCatalogEntry && (
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: '#ede9e4',
            overflow: 'hidden',
          }}>

            {/* ── Collapsed header — always visible, always tappable ── */}
            <TouchableOpacity
              activeOpacity={0.75}
              onPress={() => setSagaExpanded(prev => !prev)}
              style={{
                flexDirection: 'row',
                alignItems:    'center',
                padding:       16,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{
                  fontSize:      10,
                  fontWeight:    '700',
                  color:         '#9e958d',
                  letterSpacing: 0.9,
                  textTransform: 'uppercase',
                  marginBottom:  3,
                }}>
                  {sagaInfo!.sagaName}
                </Text>
                <Text style={{
                  fontSize:   13,
                  fontWeight: '500',
                  color:      '#231f1b',
                }}>
                  {'Continue your journey'}
                  {seriesMeta ? ` · ${seriesMeta.displayName}` : ''}
                </Text>
              </View>
              {/* Chevron — down when collapsed, up when expanded */}
              <Text style={{ fontSize: 14, color: '#9e958d', marginLeft: 12 }}>
                {sagaExpanded ? '∧' : '›'}
              </Text>
            </TouchableOpacity>

            {/* ── Expanded: full sub-series rows ──────────────────────────── */}
            {sagaExpanded && (
              <View style={{ borderTopWidth: 1, borderTopColor: '#ede9e4' }}>
                {sagaCatalogEntry.series_order.map((sKey, i) => {
                  const cat        = getSeriesCatalog(sKey);
                  if (!cat) return null;

                  const state      = sagaProgress?.get(sKey);
                  const hasLoaded  = sagaProgress !== null;
                  const isCurrent  = sKey === seriesName;
                  const isComplete = state?.status === 'complete';
                  const isInProg   = state?.status === 'in_progress';
                  const isLocked   = hasLoaded && i > sagaNextAllowed && !isCurrent;
                  // Green outline = next allowed, not started, not current
                  const isNextAvail = hasLoaded && i === sagaNextAllowed
                    && !isComplete && !isCurrent && !isInProg;

                  // Navigate to the most relevant book in this sub-series
                  const targetPos  = isInProg
                    ? Math.min(state!.maxRead + 1, cat.orderedBooks.length)
                    : 1;
                  const targetBook = cat.orderedBooks[targetPos - 1] ?? cat.orderedBooks[0];

                  // Name color — locked is muted, current is dark, else medium
                  const nameColor = isLocked ? '#c0bbb6' : isCurrent ? '#231f1b' : '#57534e';

                  // Subtitle — always rendered so row height is deterministic
                  const subtitleText = !hasLoaded
                    ? ' '
                    : isComplete
                      ? `Complete · ${state!.total} books`
                      : isInProg
                        ? `${state!.maxRead} of ${state!.total} read`
                        : isLocked
                          ? 'Complete earlier series first'
                          : 'Not yet started';

                  return (
                    <TouchableOpacity
                      key={sKey}
                      disabled={isCurrent}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (!targetBook) return;
                        router.push({
                          pathname: '/book/[id]',
                          params: {
                            id:             encodeURIComponent(targetBook.title),
                            title:          targetBook.title,
                            author:         targetBook.author,
                            seriesName:     sKey,
                            seriesPosition: String(targetPos),
                            coverUrl:       '',
                          },
                        });
                      }}
                      style={{
                        flexDirection:    'row',
                        alignItems:       'center',
                        paddingVertical:  10,
                        paddingHorizontal: 16,
                        borderTopWidth:   i > 0 ? 1 : 0,
                        borderTopColor:   '#f5f4f2',
                      }}
                    >
                      {/* ── Left: status icon ───────────────────────────── */}
                      {/* green = progress/available  |  gray = locked/pre-load */}
                      <View style={{ width: 24, alignItems: 'center', justifyContent: 'center' }}>
                        {isComplete ? (
                          // Completed — green checkmark
                          <Text style={{ fontSize: 13, color: '#15803d', lineHeight: 18 }}>✓</Text>
                        ) : (isCurrent || isInProg) ? (
                          // Current view or in-progress — green filled dot
                          <View style={{
                            width: 8, height: 8, borderRadius: 4,
                            backgroundColor: '#15803d',
                          }} />
                        ) : isNextAvail ? (
                          // Next allowed, not started — green ring
                          <View style={{
                            width: 8, height: 8, borderRadius: 4,
                            borderWidth: 1.5, borderColor: '#15803d',
                          }} />
                        ) : (
                          // Locked or pre-load — gray ring
                          <View style={{
                            width: 8, height: 8, borderRadius: 4,
                            borderWidth: 1.5, borderColor: '#ede9e4',
                          }} />
                        )}
                      </View>

                      {/* ── Center: series name + progress subtitle ─────── */}
                      <View style={{ flex: 1 }}>
                        <Text style={{
                          fontSize:   14,
                          fontWeight: isCurrent ? '700' : '400',
                          color:      nameColor,
                        }} numberOfLines={1}>
                          {cat.displayName}
                        </Text>
                        <Text style={{
                          fontSize:  11,
                          color:     isLocked ? '#ede9e4' : '#9e958d',
                          marginTop: 2,
                          lineHeight: 15,
                        }}>
                          {subtitleText}
                        </Text>
                      </View>

                      {/* ── Right: chevron — hidden for current series ──── */}
                      {!isCurrent && (
                        <Text style={{
                          fontSize:   16,
                          color:      isLocked ? '#ede9e4' : '#c0bbb6',
                          marginLeft: 8,
                        }}>›</Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* ── Series section ──
             Rendered on first paint when seriesName + seriesPosition params
             are present and the series key resolves in the static catalog.
             Cover images start as placeholder boxes and fill in post-mount. */}
        {hasSeriesMeta && (
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            padding: 16,
            marginBottom: 24,
            borderWidth: 1,
            borderColor: '#ede9e4',
          }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: '#9e958d',
              letterSpacing: 0.9,
              textTransform: 'uppercase',
              marginBottom: 12,
            }}>
              {seriesMeta!.displayName}
            </Text>

            {/* Horizontally scrollable carousel — snaps per item, haptic on settle */}
            <ScrollView
              ref={seriesScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={SNAP_W}
              decelerationRate="fast"
              contentContainerStyle={{ paddingRight: 8 }}
              style={{ marginBottom: 12 }}
              onMomentumScrollEnd={(e) => {
                const newIdx = Math.round(e.nativeEvent.contentOffset.x / SNAP_W);
                if (newIdx !== snappedIndex) {
                  setSnappedIndex(newIdx);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                }
              }}
            >
              {(() => {
                // Build an effective status map: override the current book's position
                // with localStatus (post-transition state) if available, so labels
                // stay correct immediately after the user starts/finishes a book.
                const effectiveStatuses = new Map(seriesUserPositions);
                if (seriesPos != null && localStatus) {
                  effectiveStatuses.set(seriesPos, localStatus);
                }

                // Highest finished position in the series
                const finishedEntries = Array.from(effectiveStatuses.entries())
                  .filter(([_p, s]) => s === 'finished')
                  .map(([p]) => p);
                const maxFinishedPos = finishedEntries.length > 0 ? Math.max(...finishedEntries) : 0;

                // Highest actively-reading position in the series
                const readingEntries = Array.from(effectiveStatuses.entries())
                  .filter(([_p, s]) => s === 'reading' || s === 'started')
                  .map(([p]) => p);
                const maxReadingPos = readingEntries.length > 0 ? Math.max(...readingEntries) : 0;

                // maxProgressPos = furthest position the user has reached (read or reading)
                const maxProgressPos = Math.max(maxFinishedPos, maxReadingPos);

                function getStripLabel(pos: number): string | null {
                  // "Reading" is strictly tied to the book currently being viewed.
                  // Other in-progress series books are not labeled "Reading" here —
                  // they may get "Next up" if they are the next logical volume.
                  if (pos === seriesPos && (localStatus === 'reading' || localStatus === 'started')) {
                    return 'Reading';
                  }
                  const status = effectiveStatuses.get(pos);
                  // Finished or actively-reading (non-current) positions get no label
                  if (status === 'finished' || status === 'reading' || status === 'started') return null;
                  // Position 1, series completely untouched — "Start here"
                  if (pos === 1 && maxProgressPos === 0) return 'Start here';
                  // First unread/want-to-read position immediately after current progress — "Next up"
                  if (pos === maxProgressPos + 1 && maxProgressPos > 0 && (!status || status === 'want_to_read')) return 'Next up';
                  return null;
                }

                return seriesMeta!.orderedBooks.map((b, i) => {
                  const pos       = i + 1;
                  const isCurrent = pos === seriesPos;
                  const cover     = seriesCovers[i];
                  const coverUri  = cover?.coverId
                    ? `https://covers.openlibrary.org/b/id/${cover.coverId}-S.jpg`
                    : null;
                  const coverW    = isCurrent ? 54 : 42;
                  const coverH    = isCurrent ? 80 : 62;
                  const stripLabel = getStripLabel(pos);
                  return (
                    <TouchableOpacity
                      key={`${b.title}-${i}`}
                      disabled={isCurrent}
                      activeOpacity={0.75}
                      onPress={() => router.push({
                        pathname: '/book/[id]',
                        params: {
                          id:             encodeURIComponent(b.title),
                          title:          b.title,
                          author:         b.author,
                          coverUrl:       coverUri ?? '',
                          seriesName:     seriesName!,
                          seriesPosition: String(i + 1),
                        },
                      })}
                      style={{
                        width:          68,
                        alignItems:     'center',
                        justifyContent: 'flex-end',
                        marginRight:    8,
                        opacity:        isCurrent ? 1 : 0.55,
                      }}
                    >
                      <View style={{
                        borderWidth:  isCurrent ? 2 : 0,
                        borderColor:  '#231f1b',
                        borderRadius: 5,
                      }}>
                        {coverUri ? (
                          <Image
                            source={{ uri: coverUri }}
                            style={{
                              width:           coverW,
                              height:          coverH,
                              borderRadius:    4,
                              backgroundColor: '#ede9e4',
                            }}
                          />
                        ) : (
                          <View style={{
                            width:           coverW,
                            height:          coverH,
                            borderRadius:    4,
                            backgroundColor: '#ece9e4',
                            borderWidth:     1,
                            borderColor:     '#e0dbd4',
                          }} />
                        )}
                      </View>
                      {stripLabel ? (
                        <Text style={{
                          fontSize:   10,
                          color:      '#9e958d',
                          marginTop:  5,
                          textAlign:  'center',
                          lineHeight: 13,
                        }}>
                          {stripLabel}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                });
              })()}
            </ScrollView>

            {/* Position label */}
            <Text style={{ fontSize: 12, color: '#78716c' }}>
              Book {seriesPos} of {seriesMeta!.total}
              {seriesPos === 1 ? ' · Start here' : ''}
            </Text>
          </View>
        )}

        {/* ── Start Reading CTA — shown for want_to_read books that have been saved ── */}
        {localStatus === 'want_to_read' && userBookId && (
          <View style={{ marginBottom: 20 }}>
            <TouchableOpacity
              onPress={() => handleTransition('reading')}
              disabled={transitioning}
              style={{
                backgroundColor: transitioning ? '#ede9e4' : '#231f1b',
                borderRadius: 12,
                paddingVertical: 15,
                alignItems: 'center',
              }}
            >
              {transitioning
                ? <ActivityIndicator color="#fff" />
                : <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.2 }}>Start Reading</Text>
              }
            </TouchableOpacity>
            {transitionError && (
              <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8, textAlign: 'center' }}>
                {transitionError}
              </Text>
            )}
          </View>
        )}

        {/* ── Reading Progress card (primary module) ── */}
        {isReading && (
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 16,
            padding: 20,
            marginBottom: 20,
            borderTopWidth: 3,
            borderTopColor: '#231f1b',
            shadowColor: '#000',
            shadowOpacity: 0.06,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 3 },
            elevation: 3,
          }}>
            <SectionLabel>Reading Progress</SectionLabel>

            {progressLoading ? (
              <ProgressCardSkeleton />
            ) : (
              <>
                {/* ── 1. Primary: % + bar + page position ── */}
                {hasPaging && (
                  <View style={{ marginBottom: 14 }}>
                    <Text style={{
                      fontSize: 36,
                      fontWeight: '800',
                      color: '#231f1b',
                      letterSpacing: -1,
                      marginBottom: 8,
                    }}>
                      {progressPct ?? 0}%
                    </Text>
                    <View style={{
                      height: 8,
                      backgroundColor: '#ede9e4',
                      borderRadius: 4,
                      overflow: 'hidden',
                      marginBottom: 8,
                    }}>
                      <View style={{
                        height: 8,
                        width: `${progressPct ?? 0}%`,
                        backgroundColor: '#231f1b',
                        borderRadius: 4,
                      }} />
                    </View>
                    <Text style={{ fontSize: 13, color: '#78716c' }}>
                      Page {currentPage} of {effectivePageCount} · {pagePacing?.pagesLeft ?? 0} left
                    </Text>
                  </View>
                )}

                {/* ── 2. Secondary: ONE projection line ── */}
                {hasPaging && paceEstimate != null && (
                  <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 14 }}>
                    Finish by {shortDate(paceEstimate.estimatedFinish)} at your current pace
                  </Text>
                )}
                {hasPaging && paceEstimate == null && avgUserPace != null && effectivePageCount != null && currentPage != null && effectivePageCount > 0 && (
                  <Text style={{ fontSize: 13, color: '#9e958d', marginBottom: 14 }}>
                    Finish by {shortDate(new Date(Date.now() + ((effectivePageCount - currentPage) / avgUserPace) * 86_400_000))} at your usual pace
                  </Text>
                )}

                {/* ── 3. Supporting: ONE pacing chip (state label only, no ppd/dates) ── */}
                {pagePacing && (
                  <View style={{
                    alignSelf: 'flex-start',
                    backgroundColor: pacingChipBg,
                    borderRadius: 20,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderWidth: 1,
                    borderColor: pacingChipBorder,
                    marginBottom: 14,
                  }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: pacingChipColor }}>
                      {pacingState === 'ahead' ? 'Ahead of pace' : pacingState === 'behind' ? 'Behind pace' : 'On pace'}
                    </Text>
                  </View>
                )}
                {!pagePacing && datePacing && (
                  <View style={{
                    alignSelf: 'flex-start',
                    backgroundColor: datePacing.state === 'behind' ? '#fef9f0' : '#ede9e4',
                    borderRadius: 20,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderWidth: 1,
                    borderColor: datePacing.state === 'behind' ? '#fde68a' : '#ede9e4',
                    marginBottom: 14,
                  }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: datePacing.state === 'behind' ? '#92400e' : '#78716c' }}>
                      {datePacing.state === 'behind' ? 'Behind pace' : 'On pace'}
                    </Text>
                  </View>
                )}
                {!pagePacing && !datePacing && !yearlyGoal && (
                  <TouchableOpacity
                    onPress={() => router.push('/settings')}
                    style={{
                      backgroundColor: '#f5f1ec',
                      borderRadius: 8,
                      paddingHorizontal: 12,
                      paddingVertical: 9,
                      marginBottom: 14,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: '#9e958d' }}>
                      Set a yearly reading goal in Settings to get pacing guidance →
                    </Text>
                  </TouchableOpacity>
                )}

                {/* ── Page count missing prompt ── */}
                {!effectivePageCount && !editingPageCount && (
                  <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: '#f5f1ec',
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    marginBottom: 14,
                    gap: 12,
                  }}>
                    <Text style={{ fontSize: 13, color: '#9e958d', flex: 1, lineHeight: 18 }}>
                      Total pages unknown — add them to unlock progress tracking.
                    </Text>
                    <TouchableOpacity
                      onPress={() => {
                        setPageCountInput('');
                        setPageCountError(null);
                        setEditingPageCount(true);
                        setTimeout(() => pageCountInputRef.current?.focus(), 80);
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '600', textDecorationLine: 'underline' }}>
                        Set pages
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
                {!effectivePageCount && editingPageCount && (
                  <View style={{ marginBottom: 14 }}>
                    <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '600', marginBottom: 8 }}>
                      Total pages in this book
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <TextInput
                        ref={pageCountInputRef}
                        value={pageCountInput}
                        onChangeText={setPageCountInput}
                        keyboardType="number-pad"
                        placeholder="e.g. 320"
                        placeholderTextColor="#9e958d"
                        returnKeyType="done"
                        onSubmitEditing={handleSavePageCount}
                        style={{
                          width: 100,
                          height: 44,
                          borderWidth: 1.5,
                          borderColor: '#ede9e4',
                          borderRadius: 8,
                          paddingHorizontal: 12,
                          fontSize: 18,
                          fontWeight: '700',
                          color: '#231f1b',
                          backgroundColor: '#fefcf9',
                          textAlign: 'center',
                        }}
                      />
                      <TouchableOpacity
                        onPress={handleSavePageCount}
                        disabled={savingPageCount}
                        style={{
                          backgroundColor: savingPageCount ? '#ede9e4' : '#231f1b',
                          borderRadius: 8,
                          paddingHorizontal: 16,
                          paddingVertical: 11,
                        }}
                      >
                        {savingPageCount
                          ? <ActivityIndicator color="#fff" size="small" />
                          : <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Save</Text>
                        }
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => { setEditingPageCount(false); setPageCountError(null); Keyboard.dismiss(); }}
                        style={{ paddingHorizontal: 8, paddingVertical: 11 }}
                      >
                        <Text style={{ fontSize: 13, color: '#9e958d' }}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                    {pageCountError && (
                      <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{pageCountError}</Text>
                    )}
                  </View>
                )}

                {/* ── 4. Tertiary: last updated + stale nudge ── */}
                {lastUpdatedLabel && !editingProgress && !editingPageCount && (
                  <Text style={{ fontSize: 12, color: '#c4b5a5', marginBottom: isStale ? 3 : 16 }}>
                    {lastUpdatedLabel}
                  </Text>
                )}
                {isStale && !editingProgress && !editingPageCount && (
                  <Text style={{ fontSize: 12, color: '#9e958d', fontStyle: 'italic', marginBottom: 16 }}>
                    Pick this back up?
                  </Text>
                )}

                {/* ── 5. Actions ── */}
                {!editingProgress ? (
                  <>
                    <TouchableOpacity
                      onPress={() => {
                        setPageInput(currentPage != null ? String(currentPage) : '');
                        setProgressError(null);
                        setEditingProgress(true);
                        setTimeout(() => pageInputRef.current?.focus(), 80);
                      }}
                      style={{
                        backgroundColor: '#231f1b',
                        borderRadius: 10,
                        paddingVertical: 13,
                        alignItems: 'center',
                        marginBottom: 8,
                      }}
                    >
                      <Text style={{ fontSize: 14, color: '#fff', fontWeight: '600' }}>
                        Update progress
                      </Text>
                    </TouchableOpacity>
                    {!editingPageCount && (
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TouchableOpacity
                          onPress={() => handleTransition('finished')}
                          disabled={transitioning}
                          style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: transitioning ? '#ede9e4' : '#ede9e4',
                            borderRadius: 10,
                            paddingVertical: 11,
                            alignItems: 'center',
                          }}
                        >
                          {transitioning
                            ? <ActivityIndicator color="#78716c" size="small" />
                            : <Text style={{ color: transitioning ? '#9e958d' : '#44403c', fontSize: 13, fontWeight: '500' }}>Mark Finished</Text>
                          }
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleTransition('dnf')}
                          disabled={transitioning}
                          style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: transitioning ? '#ede9e4' : '#ede9e4',
                            borderRadius: 10,
                            paddingVertical: 11,
                            alignItems: 'center',
                            opacity: transitioning ? 0.5 : 1,
                          }}
                        >
                          <Text style={{ color: transitioning ? '#9e958d' : '#78716c', fontSize: 13, fontWeight: '500' }}>DNF</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                ) : (
                  <View>
                    <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '600', marginBottom: 8 }}>
                      Current page{effectivePageCount ? ` (of ${effectivePageCount})` : ''}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <TextInput
                        ref={pageInputRef}
                        value={pageInput}
                        onChangeText={setPageInput}
                        keyboardType="number-pad"
                        placeholder="0"
                        placeholderTextColor="#9e958d"
                        returnKeyType="done"
                        onSubmitEditing={handleSaveProgress}
                        style={{
                          width: 80,
                          height: 44,
                          borderWidth: 1.5,
                          borderColor: '#ede9e4',
                          borderRadius: 8,
                          paddingHorizontal: 12,
                          fontSize: 18,
                          fontWeight: '700',
                          color: '#231f1b',
                          backgroundColor: '#fefcf9',
                          textAlign: 'center',
                        }}
                      />
                      <TouchableOpacity
                        onPress={handleSaveProgress}
                        disabled={savingProgress}
                        style={{
                          backgroundColor: savingProgress ? '#ede9e4' : '#231f1b',
                          borderRadius: 8,
                          paddingHorizontal: 16,
                          paddingVertical: 11,
                        }}
                      >
                        {savingProgress
                          ? <ActivityIndicator color="#fff" size="small" />
                          : <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Save</Text>
                        }
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => { setEditingProgress(false); setProgressError(null); Keyboard.dismiss(); }}
                        style={{ paddingHorizontal: 8, paddingVertical: 11 }}
                      >
                        <Text style={{ fontSize: 13, color: '#9e958d' }}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                    {progressError && (
                      <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{progressError}</Text>
                    )}
                  </View>
                )}
                {transitionError && (
                  <Text style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{transitionError}</Text>
                )}
              </>
            )}
          </View>
        )}

        {/* ── Recommendation context — warm handoff card ── */}
        {hasRecCtx && (
          <View style={{
            backgroundColor: '#fffbf5',
            borderRadius: 16,
            padding: 20,
            marginBottom: 20,
            borderLeftWidth: 4,
            borderLeftColor: '#d4a574',
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}>
            {fromUser && (
              <View style={{ marginBottom: note ? 16 : 0 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#44403c', lineHeight: 26 }}>
                  From {fromUser}
                </Text>
              </View>
            )}
            {toUser && !fromUser && (
              <View style={{ marginBottom: note ? 16 : 0 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#44403c', lineHeight: 26 }}>
                  You shared this with {toUser}
                </Text>
              </View>
            )}
            {note && (
              <View style={{
                backgroundColor: '#fff8f0',
                borderRadius: 10,
                paddingHorizontal: 16,
                paddingVertical: 14,
              }}>
                <Text style={{
                  fontSize: 15,
                  fontStyle: 'italic',
                  color: '#57534e',
                  lineHeight: 24,
                }}>
                  "{note}"
                </Text>
                {fromUser && (
                  <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 8, fontWeight: '500' }}>— {fromUser}</Text>
                )}
                {toUser && !fromUser && (
                  <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 8, fontWeight: '500' }}>— You</Text>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── Your History ── */}
        {userHistory && (
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            padding: 18,
            marginBottom: 20,
            borderWidth: 1,
            borderColor: '#ede9e4',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
              <Text style={{
                flex: 1,
                fontSize: 11,
                fontWeight: '700',
                color: '#9e958d',
                letterSpacing: 0.9,
                textTransform: 'uppercase',
              }}>
                Your History
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setEditRating(userHistory?.rating ?? null);
                  setEditNote(userHistory?.reviewBody ?? '');
                  setShowEditModal(true);
                }}
                hitSlop={{ top: 8, bottom: 8, left: 12, right: 0 }}
              >
                <Text style={{ fontSize: 12, color: '#9e958d' }}>Edit</Text>
              </TouchableOpacity>
            </View>

            {userHistory.rating != null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ fontSize: 13, color: '#78716c', width: 90 }}>Rating</Text>
                <Text style={{ fontSize: 14, color: '#231f1b', fontWeight: '600' }}>
                  {'★'.repeat(userHistory.rating)}{'☆'.repeat(5 - userHistory.rating)} · {userHistory.rating}/5
                </Text>
              </View>
            )}

            {userHistory.finishedAt && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ fontSize: 13, color: '#78716c', width: 90 }}>Finished</Text>
                <Text style={{ fontSize: 14, color: '#231f1b' }}>
                  {new Date(userHistory.finishedAt).toLocaleDateString('en-US', {
                    year: 'numeric', month: 'long', day: 'numeric',
                  })}
                </Text>
              </View>
            )}

            {userHistory.reviewBody ? (
              <View style={{ marginTop: userHistory.rating || userHistory.finishedAt ? 6 : 0 }}>
                <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 4 }}>Review</Text>
                <Text style={{ fontSize: 14, color: '#44403c', lineHeight: 22 }}>
                  {userHistory.reviewBody}
                </Text>
              </View>
            ) : null}

            {userHistory.privateNote ? (
              <View style={{ marginTop: 12, backgroundColor: '#f5f1ec', borderRadius: 8, padding: 12 }}>
                <Text style={{ fontSize: 11, color: '#9e958d', marginBottom: 4, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  Private note
                </Text>
                <Text style={{ fontSize: 13, color: '#57534e', lineHeight: 20 }}>
                  {userHistory.privateNote}
                </Text>
              </View>
            ) : null}
          </View>
        )}

        {/* ── About & Subjects — unified quiet section ── */}
        {metaLoading ? (
          <DescriptionSkeleton />
        ) : (displayDesc || (olMeta && olMeta.subjects.length > 0)) ? (
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            padding: 18,
            marginBottom: 20,
            borderWidth: 1,
            borderColor: '#ede9e4',
          }}>
            {displayDesc && (
              <View style={{ marginBottom: olMeta && olMeta.subjects.length > 0 ? 16 : 0 }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: '#9e958d',
                  letterSpacing: 0.9,
                  textTransform: 'uppercase',
                  marginBottom: 10,
                }}>
                  About
                </Text>
                <Text style={{ fontSize: 14, color: '#57534e', lineHeight: 24 }}>{displayDesc}</Text>
                {descText && descText.length > DESC_LIMIT && (
                  <TouchableOpacity
                    onPress={() => setDescExpanded(v => !v)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{ marginTop: 8 }}
                  >
                    <Text style={{ fontSize: 13, color: '#78716c', fontWeight: '500' }}>
                      {descExpanded ? 'Show less' : 'Read more'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            {olMeta && olMeta.subjects.length > 0 && (
              <View>
                {displayDesc && (
                  <View style={{ height: 1, backgroundColor: '#ede9e4', marginBottom: 14 }} />
                )}
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: '#9e958d',
                  letterSpacing: 0.9,
                  textTransform: 'uppercase',
                  marginBottom: 10,
                }}>
                  Subjects
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {olMeta.subjects.map((subject, i) => (
                    <View
                      key={i}
                      style={{
                        backgroundColor: '#ede9e4',
                        borderRadius: 20,
                        paddingHorizontal: 12,
                        paddingVertical: 5,
                      }}
                    >
                      <Text style={{ fontSize: 12, color: '#57534e' }}>{subject}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
            {metaFromGb && (
              <Text style={{
                fontSize: 11,
                color: '#9e958d',
                marginTop: 14,
                textAlign: 'right',
              }}>
                Book data from Google Books
              </Text>
            )}
          </View>
        ) : (
          /* ── Premium no-summary fallback ─────────────────────────────────────
             Intentional typographic state — looks editorial, not empty.
             Only shown after the enrichment pipeline has run (metaLoading=false)
             and genuinely found nothing to display.                          */
          <View style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            padding: 18,
            marginBottom: 20,
            borderWidth: 1,
            borderColor: '#ede9e4',
          }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: '#9e958d',
              letterSpacing: 0.9,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}>
              About
            </Text>
            <Text style={{
              fontSize: 14,
              fontStyle: 'italic',
              color: '#9e958d',
              lineHeight: 22,
            }}>
              No summary available for this edition.
            </Text>
          </View>
        )}

        {/* ── Content Warnings — collapsible "Heads up" section ── */}
        {/* Hidden when no warnings exist or while metadata is still loading. */}
        {!metaLoading && contentWarnings.length > 0 && (
          <ContentWarnings
            warnings={contentWarnings}
            subjects={olMeta?.subjects ?? []}
            expanded={warningsExpanded}
            onToggle={() => setWarningsExpanded(v => !v)}
          />
        )}

        {/* ── Why this book? — evidence-backed rec context ── */}
        {/* Shown only for unstarted books. Content varies by navigation source:
            - From rec feed: shows evidence tags + explanation from the recommender.
            - Direct nav, no prefs: shows "Set your preferences" CTA.
            - Direct nav, has prefs: section is hidden (no evidence to show). */}
        {externalId && (!localStatus || localStatus === 'want_to_read' || localStatus === 'sent' || localStatus === 'saved') ? (
          recCtx ? (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              padding: 18,
              borderWidth: 1,
              borderColor: '#ede9e4',
            }}>
              <Text style={{
                fontSize: 11,
                fontWeight: '700',
                color: '#9e958d',
                letterSpacing: 0.9,
                textTransform: 'uppercase',
                marginBottom: 10,
              }}>
                Why this book?
              </Text>
              {recCtx.explanation ? (
                <Text style={{ fontSize: 14, color: '#231f1b', lineHeight: 21, fontWeight: '500' }}>
                  {recCtx.explanation}
                </Text>
              ) : null}
              {recCtx.evidenceTags.length > 0 && (
                <EvidenceTagsRow tags={recCtx.evidenceTags} />
              )}
            </View>
          ) : hasTastePrefs === false ? (
            <View style={{
              backgroundColor: '#f5f1ec',
              borderRadius: 14,
              padding: 18,
              borderWidth: 1,
              borderColor: '#ede9e4',
            }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 8 }}>
                Why this book?
              </Text>
              <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
                Set your reading preferences to see why books like this are recommended for you.
              </Text>
              <TouchableOpacity
                onPress={() => router.push('/edit-preferences')}
                style={{ marginTop: 10 }}
              >
                <Text style={{ fontSize: 13, color: '#6b635c', fontWeight: '600' }}>
                  Set preferences →
                </Text>
              </TouchableOpacity>
            </View>
          ) : null
        ) : null}

      </View>
    </ScrollView>

    {/* ── Undo Bar ── */}
    {undoBar.visible && (
      <View style={{
        position:        'absolute',
        bottom:          24,
        left:            20,
        right:           20,
        backgroundColor: '#231f1b',
        borderRadius:    14,
        paddingVertical: 14,
        paddingHorizontal: 18,
        flexDirection:   'row',
        alignItems:      'center',
        shadowColor:     '#000',
        shadowOffset:    { width: 0, height: 4 },
        shadowOpacity:   0.18,
        shadowRadius:    10,
        elevation:       8,
        zIndex:          9999,
      }}>
        <Text style={{ flex: 1, fontSize: 14, color: '#f5f1ec', fontWeight: '500' }}>
          {undoBar.message}
        </Text>
        <TouchableOpacity
          onPress={undoBar.onUndo}
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 0 }}
        >
          <Text style={{ fontSize: 14, fontWeight: '700', color: '#a3e635' }}>Undo</Text>
        </TouchableOpacity>
      </View>
    )}

    {/* ── Book Edit Sheet ── */}
    <Modal
      visible={showBookEditSheet}
      transparent
      animationType="slide"
      onRequestClose={() => setShowBookEditSheet(false)}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: '#f5f1ec',
          borderTopLeftRadius:  22,
          borderTopRightRadius: 22,
          paddingTop:    8,
          paddingBottom: 48,
        }}>
          {/* Handle */}
          <View style={{ alignItems: 'center', marginBottom: 18 }}>
            <View style={{ width: 36, height: 4, backgroundColor: '#ede9e4', borderRadius: 2 }} />
          </View>

          <View style={{ paddingHorizontal: 24 }}>

            {/* ── Header ── */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 26 }}>
              <Text style={{ flex: 1, fontSize: 18, fontWeight: '800', color: '#231f1b', letterSpacing: -0.3 }}>
                Edit book
              </Text>
              <TouchableOpacity onPress={() => setShowBookEditSheet(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 0 }}>
                <Text style={{ fontSize: 14, color: '#9e958d' }}>Cancel</Text>
              </TouchableOpacity>
            </View>

            {/* ── Status ── */}
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10 }}>
              Status
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
              {(['want_to_read', 'reading', 'finished', 'dnf'] as UserBookStatus[]).map(s => {
                const m = STATUS_META[s];
                const selected = editSheetStatus === s;
                return (
                  <TouchableOpacity
                    key={s}
                    onPress={() => setEditSheetStatus(s)}
                    style={{
                      backgroundColor: selected ? m.bg : '#ede9e4',
                      borderRadius: 8,
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderWidth: selected ? 1.5 : 0,
                      borderColor: selected ? m.text : 'transparent',
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '600', color: selected ? m.text : '#78716c' }}>
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* ── Finished date ── */}
            {(editSheetStatus === 'finished' || editSheetStatus === 'dnf') && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10 }}>
                  Finished date
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  {(['exact', 'year', 'unknown'] as const).map(mode => (
                    <TouchableOpacity
                      key={mode}
                      onPress={() => setEditSheetFinishedMode(mode)}
                      style={{
                        backgroundColor: editSheetFinishedMode === mode ? '#231f1b' : '#ede9e4',
                        borderRadius: 8,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: editSheetFinishedMode === mode ? '#fff' : '#78716c' }}>
                        {mode === 'exact' ? 'Exact date' : mode === 'year' ? 'Year only' : 'Unknown'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {editSheetFinishedMode === 'exact' && (
                  <TextInput
                    value={editSheetFinishedExact}
                    onChangeText={setEditSheetFinishedExact}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#c4b5a5"
                    keyboardType="numeric"
                    style={{
                      borderWidth: 1,
                      borderColor: '#ede9e4',
                      borderRadius: 10,
                      padding: 12,
                      fontSize: 15,
                      color: '#231f1b',
                      backgroundColor: '#fefcf9',
                      marginBottom: 12,
                    }}
                  />
                )}

                {editSheetFinishedMode === 'year' && (
                  <View style={{ marginBottom: 12 }}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -4 }}>
                      {Array.from({ length: 10 }, (_, i) => new Date().getFullYear() - i).map(yr => (
                        <TouchableOpacity
                          key={yr}
                          onPress={() => setEditSheetFinishedYear(yr)}
                          style={{
                            backgroundColor: editSheetFinishedYear === yr ? '#231f1b' : '#ede9e4',
                            borderRadius: 8,
                            paddingHorizontal: 16,
                            paddingVertical: 9,
                            marginHorizontal: 4,
                          }}
                        >
                          <Text style={{ fontSize: 14, fontWeight: '600', color: editSheetFinishedYear === yr ? '#fff' : '#78716c' }}>
                            {yr}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </>
            )}

            {/* ── Started date ── */}
            {(editSheetStatus === 'reading' || editSheetStatus === 'finished') && (
              <>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10 }}>
                  Started date <Text style={{ fontWeight: '400', color: '#c4b5a5' }}>(optional)</Text>
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                  {(['date', 'unknown'] as const).map(mode => (
                    <TouchableOpacity
                      key={mode}
                      onPress={() => setEditSheetStartedMode(mode)}
                      style={{
                        backgroundColor: editSheetStartedMode === mode ? '#231f1b' : '#ede9e4',
                        borderRadius: 8,
                        paddingHorizontal: 14,
                        paddingVertical: 8,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: editSheetStartedMode === mode ? '#fff' : '#78716c' }}>
                        {mode === 'date' ? 'Set date' : 'Unknown'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {editSheetStartedMode === 'date' && (
                  <TextInput
                    value={editSheetStartedExact}
                    onChangeText={setEditSheetStartedExact}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor="#c4b5a5"
                    keyboardType="numeric"
                    style={{
                      borderWidth: 1,
                      borderColor: '#ede9e4',
                      borderRadius: 10,
                      padding: 12,
                      fontSize: 15,
                      color: '#231f1b',
                      backgroundColor: '#fefcf9',
                      marginBottom: 12,
                    }}
                  />
                )}
              </>
            )}

            {bookEditError && (
              <Text style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{bookEditError}</Text>
            )}

            {/* ── Save ── */}
            <TouchableOpacity
              onPress={handleBookEditSave}
              disabled={savingBookEdit}
              style={{
                backgroundColor: savingBookEdit ? '#ede9e4' : '#231f1b',
                borderRadius: 12,
                paddingVertical: 15,
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              {savingBookEdit
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Save changes</Text>
              }
            </TouchableOpacity>

            {/* ── Remove from library ── */}
            {!deleteConfirmVisible ? (
              <TouchableOpacity
                onPress={() => setDeleteConfirmVisible(true)}
                style={{ alignItems: 'center', paddingVertical: 10 }}
              >
                <Text style={{ fontSize: 14, color: '#b91c1c' }}>Remove from library</Text>
              </TouchableOpacity>
            ) : (
              <View style={{
                backgroundColor: '#fff1f2',
                borderRadius: 12,
                padding: 16,
                borderWidth: 1,
                borderColor: '#fecdd3',
              }}>
                <Text style={{ fontSize: 14, color: '#231f1b', fontWeight: '600', marginBottom: 6 }}>
                  Remove from library?
                </Text>
                <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 14, lineHeight: 20 }}>
                  The book will be hidden. You can undo this immediately after.
                </Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity
                    onPress={() => setDeleteConfirmVisible(false)}
                    style={{ flex: 1, borderWidth: 1, borderColor: '#ede9e4', borderRadius: 9, paddingVertical: 11, alignItems: 'center', backgroundColor: '#fefcf9' }}
                  >
                    <Text style={{ fontSize: 14, color: '#78716c' }}>Keep</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleSoftDelete}
                    disabled={deletingBook}
                    style={{ flex: 1, backgroundColor: '#b91c1c', borderRadius: 9, paddingVertical: 11, alignItems: 'center', opacity: deletingBook ? 0.6 : 1 }}
                  >
                    {deletingBook
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={{ fontSize: 14, fontWeight: '600', color: '#fff' }}>Remove</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            )}

          </View>
        </View>
      </View>
    </Modal>

    {/* ── Edit History Modal ── */}
    <Modal
      visible={showEditModal}
      transparent
      animationType="slide"
      onRequestClose={() => setShowEditModal(false)}
    >
      <View style={{
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
      }}>
        <View style={{
          backgroundColor: '#fefcf9',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 28,
          paddingBottom: 40,
        }}>
          <Text style={{
            fontSize: 16,
            fontWeight: '700',
            color: '#231f1b',
            marginBottom: 22,
          }}>
            Edit your history
          </Text>

          <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 12 }}>
            Rating
          </Text>
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 24 }}>
            {[1, 2, 3, 4, 5].map(n => (
              <TouchableOpacity
                key={n}
                onPress={() => setEditRating(editRating === n ? null : n)}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              >
                <Text style={{
                  fontSize: 34,
                  color: editRating !== null && n <= editRating ? '#f59e0b' : '#ede9e4',
                }}>
                  ★
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 }}>
            Review / note
            <Text style={{ fontWeight: '400', color: '#c4b5a5' }}> (optional)</Text>
          </Text>
          <TextInput
            value={editNote}
            onChangeText={setEditNote}
            placeholder="What did you think?"
            placeholderTextColor="#c4b5a5"
            multiline
            numberOfLines={3}
            style={{
              borderWidth: 1,
              borderColor: '#ede9e4',
              borderRadius: 10,
              padding: 12,
              fontSize: 14,
              color: '#231f1b',
              lineHeight: 22,
              minHeight: 80,
              textAlignVertical: 'top',
              marginBottom: 24,
            }}
          />

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity
              onPress={() => setShowEditModal(false)}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: '#ede9e4',
                borderRadius: 10,
                paddingVertical: 13,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontSize: 14, color: '#78716c' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSaveEdit}
              disabled={savingEdit}
              style={{
                flex: 2,
                backgroundColor: '#231f1b',
                borderRadius: 10,
                paddingVertical: 13,
                alignItems: 'center',
                opacity: savingEdit ? 0.6 : 1,
              }}
            >
              {savingEdit
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={{ fontSize: 14, fontWeight: '600', color: '#fff' }}>Save</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>

    {/* ── Post-finish rating modal ── */}
    <Modal
      visible={pendingDetailRating !== null}
      transparent
      animationType="slide"
      onRequestClose={() => { setPendingDetailRating(null); safeBack(); }}
    >
      <View style={{
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
      }}>
        <View style={{
          backgroundColor: '#fefcf9',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 28,
          paddingBottom: 44,
        }}>
          <Text style={{
            fontSize: 17,
            fontWeight: '700',
            color: '#231f1b',
            marginBottom: 6,
          }}>
            How was it?
          </Text>
          <Text style={{
            fontSize: 13,
            color: '#9e958d',
            marginBottom: 24,
          }}>
            {title ?? 'This book'}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 28 }}>
            {[1, 2, 3, 4, 5].map(n => (
              <TouchableOpacity
                key={n}
                onPress={() => setDetailRating(detailRating === n ? null : n)}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              >
                <Text style={{
                  fontSize: 40,
                  color: detailRating != null && n <= detailRating ? '#f59e0b' : '#ede9e4',
                }}>
                  ★
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            onPress={() => detailRating != null && handleDetailRating(detailRating)}
            disabled={detailRating == null || savingDetailRating}
            style={{
              backgroundColor: detailRating == null ? '#ede9e4' : '#231f1b',
              borderRadius: 10,
              paddingVertical: 14,
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            {savingDetailRating
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={{
                  color: detailRating == null ? '#9e958d' : '#fff',
                  fontSize: 14,
                  fontWeight: '600',
                }}>Save rating</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { setPendingDetailRating(null); setDetailRating(null); safeBack(); }}
            style={{ alignItems: 'center', paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 13, color: '#9e958d' }}>Skip</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>

    {/* ── Edition picker bottom sheet ── */}
    <Modal
      visible={showEditionPicker}
      transparent
      animationType="slide"
      onRequestClose={() => setShowEditionPicker(false)}
    >
      <View style={{
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
      }}>
        <View style={{
          backgroundColor: '#fefcf9',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          paddingTop: 20,
          paddingBottom: 44,
          maxHeight: '80%',
        }}>
          {/* Handle bar */}
          <View style={{
            width: 36,
            height: 4,
            backgroundColor: '#ede9e4',
            borderRadius: 2,
            alignSelf: 'center',
            marginBottom: 16,
          }} />

          <Text style={{
            fontSize: 15,
            fontWeight: '700',
            color: '#231f1b',
            paddingHorizontal: 24,
            marginBottom: 4,
          }}>
            Choose edition
          </Text>
          <Text style={{
            fontSize: 12,
            color: '#9e958d',
            paddingHorizontal: 24,
            marginBottom: 16,
          }}>
            Selecting an edition updates the cover and page count for this copy.
          </Text>

          {(() => {
            // Preferred-language editions: English-tagged or no lang data (ambiguous/likely English).
            // Always fall back to showing all editions when none pass the language filter
            // (e.g. purely foreign-language work) so the picker is never empty.
            const preferredEditions = editions.filter(
              ed => ed.languages.length === 0 || ed.languages.includes('eng'),
            );
            const visibleEditions = (showAllEditions || preferredEditions.length === 0)
              ? editions
              : preferredEditions;
            const hiddenCount = editions.length - preferredEditions.length;

            return (
              <ScrollView
                style={{ maxHeight: 420 }}
                contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8 }}
                showsVerticalScrollIndicator={false}
              >
                {visibleEditions.map(ed => {
                  const isSelected = ed.editionKey === selectedEditionKey;
                  const pub = ed.publisher?.toLowerCase().trim();
                  const hasPublisher = !!pub && pub !== 'n/a' && pub !== 'na';
                  const label = [
                    hasPublisher ? ed.publisher : null,
                    ed.year,
                    ed.pageCount ? `${ed.pageCount} pages` : null,
                  ].filter(Boolean).join(' · ') || 'Unknown edition';

                  return (
                    <TouchableOpacity
                      key={ed.editionKey}
                      onPress={() => handleSelectEdition(ed)}
                      disabled={savingEdition}
                      activeOpacity={0.7}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 12,
                        paddingHorizontal: 12,
                        borderRadius: 12,
                        marginBottom: 6,
                        backgroundColor: isSelected ? '#f0fdf4' : '#f5f1ec',
                        borderWidth: 1.5,
                        borderColor: isSelected ? '#bbf7d0' : 'transparent',
                      }}
                    >
                      {/* Cover thumbnail */}
                      <View style={{
                        width: 36,
                        height: 52,
                        borderRadius: 4,
                        overflow: 'hidden',
                        backgroundColor: '#ede9e4',
                        marginRight: 12,
                        flexShrink: 0,
                      }}>
                        {ed.coverKey ? (
                          <Image
                            source={{ uri: `https://covers.openlibrary.org/b/olid/${ed.coverKey}-S.jpg` }}
                            style={{ width: 36, height: 52 }}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={{ width: 36, height: 52, backgroundColor: '#e6e0d9' }} />
                        )}
                      </View>

                      {/* Edition metadata */}
                      <View style={{ flex: 1 }}>
                        <Text style={{
                          fontSize: 13,
                          fontWeight: isSelected ? '600' : '400',
                          color: '#231f1b',
                          marginBottom: 2,
                        }} numberOfLines={1}>
                          {label}
                        </Text>
                        {ed.isbn && (
                          <Text style={{ fontSize: 11, color: '#9e958d' }}>ISBN {ed.isbn}</Text>
                        )}
                      </View>

                      {/* Selection indicator */}
                      {isSelected && !pendingEditionKey && (
                        <Text style={{ fontSize: 14, color: '#15803d', marginLeft: 8 }}>✓</Text>
                      )}
                      {savingEdition && ed.editionKey === pendingEditionKey && (
                        <ActivityIndicator size="small" color="#9e958d" style={{ marginLeft: 8 }} />
                      )}
                    </TouchableOpacity>
                  );
                })}

                {/* Show all editions affordance — only when foreign-language editions are hidden */}
                {!showAllEditions && hiddenCount > 0 && (
                  <TouchableOpacity
                    onPress={() => setShowAllEditions(true)}
                    activeOpacity={0.7}
                    style={{
                      paddingVertical: 12,
                      paddingHorizontal: 12,
                      borderRadius: 12,
                      marginTop: 2,
                      marginBottom: 6,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 13, color: '#9e958d' }}>
                      Show all editions ({editions.length} total, including translations)
                    </Text>
                  </TouchableOpacity>
                )}
              </ScrollView>
            );
          })()}

          <TouchableOpacity
            onPress={() => setShowEditionPicker(false)}
            style={{
              marginHorizontal: 24,
              marginTop: 8,
              borderWidth: 1,
              borderColor: '#ede9e4',
              borderRadius: 10,
              paddingVertical: 13,
              alignItems: 'center',
            }}
          >
            <Text style={{ fontSize: 14, color: '#78716c' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    </View>
  );
}
