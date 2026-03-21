import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { computeDatePacing, computePagePacing, estimatePaceFinish, formatLastUpdated, shortDate, computeBookPace, computeUserAvgPace } from '../../lib/pacing';
import { fetchGoogleBooksMetadata } from '../../lib/googleBooks';
import { fetchOLMeta, searchOLWork, isOLId } from '../../lib/openLibrary';
import type { OLMeta } from '../../lib/openLibrary';
import { transitionStatus } from '../../lib/userBookActions';
import type { UserBookStatus } from '../../lib/userBookActions';

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
      color: '#a8a29e',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 10,
    }}>
      {children}
    </Text>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function BookDetailScreen() {
  const router = useRouter();
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
  }>();

  const [olMeta, setOlMeta]             = useState<OLMeta | null>(null);
  const [metaLoading, setMetaLoading]   = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [avgUserPace, setAvgUserPace]   = useState<number | null>(null);
  // Enriched cover: set when Book Detail hydration finds a cover not present at
  // navigation time (e.g. imported books that had no cover in the DB yet).
  const [enrichedCoverUrl, setEnrichedCoverUrl] = useState<string | null>(null);

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

  // Edit-history modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editRating, setEditRating]       = useState<number | null>(null);
  const [editNote, setEditNote]           = useState('');
  const [savingEdit, setSavingEdit]       = useState(false);

  // Taste preferences state (used by Taste Match section)
  const [hasTastePrefs, setHasTastePrefs] = useState<boolean | null>(null);

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

      const { data } = await supabase
        .from('user_books')
        .select('id, rating, finished_at, review_body, private_note')
        .eq('user_id', user.id)
        .eq('book_id', bookId!)
        .maybeSingle();

      if (data) {
        if (data.id && !userBookId) setUserBookId(data.id as string);
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
    setMetaLoading(true);

    async function enrich() {
      if (!supabase) return;

      // ── 1. Current DB state ──────────────────────────────────────────────
      // `description` (migration 20260315000004) and `subjects` (20260315000002)
      // may not exist yet.  Degrade gracefully: full → no description → minimal.
      type BookRow = {
        cover_url?: string | null;
        description?: string | null;
        subjects?: string[] | null;
        page_count?: number | null;
        isbn13?: string | null;
        isbn?: string | null;
        external_id?: string | null;
      };
      let row: BookRow | null = null;
      let descColExists = true;
      let subjColExists = true;

      // Phase 1 fetch — includes external_id so the OL lookup never depends
      // solely on the route param (which may be absent for non-Library navigation).
      const { data: r1, error: e1 } = await supabase
        .from('books')
        .select('cover_url, description, subjects, page_count, isbn13, isbn, external_id')
        .eq('id', bookId!)
        .maybeSingle();

      if (!e1) {
        row = r1 as BookRow | null;
      } else {
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

      const dbIsbn13  = row?.isbn13   ?? null;
      const dbIsbn    = row?.isbn     ?? null;
      const dbDesc    = row?.description ?? null;
      const dbSubjects: string[] = row?.subjects ?? [];
      const dbPages   = row?.page_count ?? null;
      const dbCover   = row?.cover_url  ?? null;
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

      // Short-circuit if everything is already rich.
      if (hasCover && hasDesc && hasSubjects && hasPages) {
        if (dbDesc || dbSubjects.length > 0) {
          setOlMeta({ description: dbDesc, subjects: dbSubjects, pageCount: dbPages });
        }
        setMetaLoading(false);
        return;
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
        }
      }

      // ── 4. Local state + DB persistence ──────────────────────────────────
      if (foundCover) setEnrichedCoverUrl(foundCover);
      if (foundPages) setPageCount(prev => prev ?? foundPages!);

      const patch: Record<string, unknown> = {};
      if (discoveredExtId)                                      patch.external_id = discoveredExtId;
      if (foundCover    && !hasCover)                           patch.cover_url   = foundCover;
      if (foundDesc     && !hasDesc     && descColExists)       patch.description = foundDesc;
      if (foundSubjects.length > 0      && subjColExists)       patch.subjects    = foundSubjects;
      if (foundPages    && !hasPages)                           patch.page_count  = foundPages;

      if (Object.keys(patch).length > 0 && supabase) {
        supabase.from('books').update(patch).eq('id', bookId!).then(() => {});
      }

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
    const { error } = await supabase
      .from('user_books')
      .update({ current_page: newPage, progress_updated_at: new Date().toISOString() })
      .eq('id', userBookId);
    setSavingProgress(false);
    if (!error) {
      if (newPage !== currentPage && userId && bookId) {
        supabase
          .from('reading_progress_events')
          .insert({ user_book_id: userBookId, book_id: bookId, user_id: userId, page: newPage })
          .then(() => {});
      }
      setCurrentPage(newPage);
      setEditingProgress(false);
      Keyboard.dismiss();
    } else {
      setProgressError('Could not save — try again.');
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

    const { data, error } = await transitionStatus(supabase, {
      userBookId,
      bookId,
      userId: uid,
      newStatus,
    });

    setTransitioning(false);
    if (error) {
      setTransitionError(error);
      return;
    }

    setLocalStatus(newStatus);
    if (data?.startedAt)  setLocalStartedAt(data.startedAt);

    if (newStatus === 'finished' || newStatus === 'dnf') {
      setPendingDetailRating({ completionEventId: data?.completionEventId ?? null });
    }
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
    router.back();
  }

  // ── Derived pacing ────────────────────────────────────────────────────────

  const hasPaging       = currentPage != null && pageCount != null && pageCount > 0;
  const pagePacing      = hasPaging ? computePagePacing(currentPage!, pageCount!, localStartedAt, yearlyGoal) : null;
  const datePacing      = !hasPaging ? computeDatePacing(localStartedAt, yearlyGoal) : null;
  const pacingState     = pagePacing?.state ?? null;
  const progressPct     = hasPaging ? Math.min(100, Math.round((currentPage! / pageCount!) * 100)) : null;

  const paceEstimate    = hasPaging
    ? estimatePaceFinish(currentPage!, pageCount!, localStartedAt)
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
  const pacingChipBg     = pacingState === 'ahead' ? '#f0fdf4' : pacingState === 'behind' ? '#fef2f2' : '#f5f5f4';
  const pacingChipBorder = pacingState === 'ahead' ? '#bbf7d0' : pacingState === 'behind' ? '#fecaca' : '#e7e5e4';

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f7' }}>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: 64 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Hero cover ── */}
      <View style={{ backgroundColor: '#f0ede8', alignItems: 'center', paddingTop: 80, paddingBottom: 60 }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: 76, left: 20, zIndex: 10 }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={{ fontSize: 14, color: '#78716c' }}>← Back</Text>
        </TouchableOpacity>
        <CoverThumb url={enrichedCoverUrl || coverUrl || null} externalId={externalId || null} title={title || null} width={122} height={180} />
      </View>

      <View style={{ paddingHorizontal: 24, paddingTop: 28 }}>

        {/* ── Header: title (dominant) / author (secondary) / badge (own row) ── */}
        <Text style={{
          fontSize: 28,
          fontWeight: '800',
          color: '#1c1917',
          letterSpacing: -0.6,
          lineHeight: 36,
          marginBottom: 6,
        }}>
          {title ?? '—'}
        </Text>
        <Text style={{ fontSize: 15, color: '#78716c', lineHeight: 22, marginBottom: 12 }} numberOfLines={2}>
          {author ?? '—'}
        </Text>
        {badge && (
          <View style={{ flexDirection: 'row', marginBottom: 28 }}>
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
          </View>
        )}
        {!badge && <View style={{ marginBottom: 28 }} />}

        {/* ── Start Reading CTA — shown for want_to_read books that have been saved ── */}
        {localStatus === 'want_to_read' && userBookId && (
          <View style={{ marginBottom: 20 }}>
            <TouchableOpacity
              onPress={() => handleTransition('reading')}
              disabled={transitioning}
              style={{
                backgroundColor: transitioning ? '#d6d3d1' : '#1c1917',
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
            backgroundColor: '#fff',
            borderRadius: 16,
            padding: 20,
            marginBottom: 20,
            borderTopWidth: 3,
            borderTopColor: '#1c1917',
            shadowColor: '#000',
            shadowOpacity: 0.06,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 3 },
            elevation: 3,
          }}>
            <SectionLabel>Reading Progress</SectionLabel>

            {progressLoading ? (
              <ActivityIndicator color="#a8a29e" size="small" />
            ) : (
              <>
                {/* ── 1. Primary: % + bar + page position ── */}
                {hasPaging && (
                  <View style={{ marginBottom: 14 }}>
                    <Text style={{
                      fontSize: 36,
                      fontWeight: '800',
                      color: '#1c1917',
                      letterSpacing: -1,
                      marginBottom: 8,
                    }}>
                      {progressPct ?? 0}%
                    </Text>
                    <View style={{
                      height: 8,
                      backgroundColor: '#e7e5e4',
                      borderRadius: 4,
                      overflow: 'hidden',
                      marginBottom: 8,
                    }}>
                      <View style={{
                        height: 8,
                        width: `${progressPct ?? 0}%`,
                        backgroundColor: '#1c1917',
                        borderRadius: 4,
                      }} />
                    </View>
                    <Text style={{ fontSize: 13, color: '#78716c' }}>
                      Page {currentPage} of {pageCount} · {pagePacing?.pagesLeft ?? 0} left
                    </Text>
                  </View>
                )}

                {/* ── 2. Secondary: ONE projection line ── */}
                {hasPaging && paceEstimate != null && (
                  <Text style={{ fontSize: 13, color: '#78716c', marginBottom: 14 }}>
                    Finish by {shortDate(paceEstimate.estimatedFinish)} at your current pace
                  </Text>
                )}
                {hasPaging && paceEstimate == null && avgUserPace != null && pageCount != null && currentPage != null && pageCount > 0 && (
                  <Text style={{ fontSize: 13, color: '#a8a29e', marginBottom: 14 }}>
                    Finish by {shortDate(new Date(Date.now() + ((pageCount - currentPage) / avgUserPace) * 86_400_000))} at your usual pace
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
                    backgroundColor: datePacing.state === 'behind' ? '#fef9f0' : '#f5f5f4',
                    borderRadius: 20,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderWidth: 1,
                    borderColor: datePacing.state === 'behind' ? '#fde68a' : '#e7e5e4',
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
                      backgroundColor: '#faf9f7',
                      borderRadius: 8,
                      paddingHorizontal: 12,
                      paddingVertical: 9,
                      marginBottom: 14,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                      Set a yearly reading goal in Settings to get pacing guidance →
                    </Text>
                  </TouchableOpacity>
                )}

                {/* ── Page count missing prompt ── */}
                {!pageCount && !editingPageCount && (
                  <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: '#faf9f7',
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    marginBottom: 14,
                    gap: 12,
                  }}>
                    <Text style={{ fontSize: 13, color: '#a8a29e', flex: 1, lineHeight: 18 }}>
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
                {!pageCount && editingPageCount && (
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
                        placeholderTextColor="#a8a29e"
                        returnKeyType="done"
                        onSubmitEditing={handleSavePageCount}
                        style={{
                          width: 100,
                          height: 44,
                          borderWidth: 1.5,
                          borderColor: '#d6d3d1',
                          borderRadius: 8,
                          paddingHorizontal: 12,
                          fontSize: 18,
                          fontWeight: '700',
                          color: '#1c1917',
                          backgroundColor: '#fff',
                          textAlign: 'center',
                        }}
                      />
                      <TouchableOpacity
                        onPress={handleSavePageCount}
                        disabled={savingPageCount}
                        style={{
                          backgroundColor: savingPageCount ? '#d6d3d1' : '#1c1917',
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
                        <Text style={{ fontSize: 13, color: '#a8a29e' }}>Cancel</Text>
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
                  <Text style={{ fontSize: 12, color: '#a8a29e', fontStyle: 'italic', marginBottom: 16 }}>
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
                        backgroundColor: '#1c1917',
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
                            borderColor: transitioning ? '#e7e5e4' : '#d6d3d1',
                            borderRadius: 10,
                            paddingVertical: 11,
                            alignItems: 'center',
                          }}
                        >
                          {transitioning
                            ? <ActivityIndicator color="#78716c" size="small" />
                            : <Text style={{ color: transitioning ? '#a8a29e' : '#44403c', fontSize: 13, fontWeight: '500' }}>Mark Finished</Text>
                          }
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleTransition('dnf')}
                          disabled={transitioning}
                          style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: transitioning ? '#e7e5e4' : '#d6d3d1',
                            borderRadius: 10,
                            paddingVertical: 11,
                            alignItems: 'center',
                            opacity: transitioning ? 0.5 : 1,
                          }}
                        >
                          <Text style={{ color: transitioning ? '#a8a29e' : '#78716c', fontSize: 13, fontWeight: '500' }}>DNF</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                ) : (
                  <View>
                    <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '600', marginBottom: 8 }}>
                      Current page{pageCount ? ` (of ${pageCount})` : ''}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <TextInput
                        ref={pageInputRef}
                        value={pageInput}
                        onChangeText={setPageInput}
                        keyboardType="number-pad"
                        placeholder="0"
                        placeholderTextColor="#a8a29e"
                        returnKeyType="done"
                        onSubmitEditing={handleSaveProgress}
                        style={{
                          width: 80,
                          height: 44,
                          borderWidth: 1.5,
                          borderColor: '#d6d3d1',
                          borderRadius: 8,
                          paddingHorizontal: 12,
                          fontSize: 18,
                          fontWeight: '700',
                          color: '#1c1917',
                          backgroundColor: '#fff',
                          textAlign: 'center',
                        }}
                      />
                      <TouchableOpacity
                        onPress={handleSaveProgress}
                        disabled={savingProgress}
                        style={{
                          backgroundColor: savingProgress ? '#d6d3d1' : '#1c1917',
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
                        <Text style={{ fontSize: 13, color: '#a8a29e' }}>Cancel</Text>
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
                  <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 8, fontWeight: '500' }}>— {fromUser}</Text>
                )}
                {toUser && !fromUser && (
                  <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 8, fontWeight: '500' }}>— You</Text>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── Your History ── */}
        {userHistory && (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            marginBottom: 20,
            borderWidth: 1,
            borderColor: '#e7e5e4',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
              <Text style={{
                flex: 1,
                fontSize: 11,
                fontWeight: '700',
                color: '#a8a29e',
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
                <Text style={{ fontSize: 12, color: '#a8a29e' }}>Edit</Text>
              </TouchableOpacity>
            </View>

            {userHistory.rating != null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ fontSize: 13, color: '#78716c', width: 90 }}>Rating</Text>
                <Text style={{ fontSize: 14, color: '#1c1917', fontWeight: '600' }}>
                  {'★'.repeat(userHistory.rating)}{'☆'.repeat(5 - userHistory.rating)} · {userHistory.rating}/5
                </Text>
              </View>
            )}

            {userHistory.finishedAt && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <Text style={{ fontSize: 13, color: '#78716c', width: 90 }}>Finished</Text>
                <Text style={{ fontSize: 14, color: '#1c1917' }}>
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
              <View style={{ marginTop: 12, backgroundColor: '#faf9f7', borderRadius: 8, padding: 12 }}>
                <Text style={{ fontSize: 11, color: '#a8a29e', marginBottom: 4, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase' }}>
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
          <ActivityIndicator color="#a8a29e" size="small" style={{ marginBottom: 18, alignSelf: 'flex-start' }} />
        ) : (displayDesc || (olMeta && olMeta.subjects.length > 0)) ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            marginBottom: 20,
            borderWidth: 1,
            borderColor: '#f0ede8',
          }}>
            {displayDesc && (
              <View style={{ marginBottom: olMeta && olMeta.subjects.length > 0 ? 16 : 0 }}>
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: '#a8a29e',
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
                  <View style={{ height: 1, backgroundColor: '#f0ede8', marginBottom: 14 }} />
                )}
                <Text style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: '#a8a29e',
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
                        backgroundColor: '#f5f5f4',
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
          </View>
        ) : null}

        {/* ── Taste Match — status-gated, preference-aware ── */}
        {externalId && (!localStatus || localStatus === 'want_to_read' || localStatus === 'sent' || localStatus === 'saved') ? (
          <View style={{
            backgroundColor: '#fafaf9',
            borderRadius: 16,
            padding: 20,
            borderWidth: 1,
            borderColor: '#e7e5e4',
          }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#1c1917', marginBottom: 4 }}>
              Your Taste Match
            </Text>
            {hasTastePrefs === null ? null : hasTastePrefs ? (
              <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
                Once you've built your taste profile, we'll explain how this book fits — or challenges — your reading style.
              </Text>
            ) : (
              <>
                <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 20 }}>
                  Set your reading preferences so we can show you why this book is a good fit.
                </Text>
                <TouchableOpacity
                  onPress={() => router.push('/edit-preferences')}
                  style={{ marginTop: 12 }}
                >
                  <Text style={{ fontSize: 13, color: '#78716c', textDecorationLine: 'underline' }}>
                    Set your preferences →
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : null}

      </View>
    </ScrollView>

    {/* ── Edit History Modal ── */}
    <Modal
      visible={showEditModal}
      transparent
      animationType="fade"
      onRequestClose={() => setShowEditModal(false)}
    >
      <View style={{
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
      }}>
        <View style={{
          backgroundColor: '#fff',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 28,
          paddingBottom: 40,
        }}>
          <Text style={{
            fontSize: 16,
            fontWeight: '700',
            color: '#1c1917',
            marginBottom: 22,
          }}>
            Edit your history
          </Text>

          <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 12 }}>
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
                  color: editRating !== null && n <= editRating ? '#f59e0b' : '#d6d3d1',
                }}>
                  ★
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8 }}>
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
              borderColor: '#e7e5e4',
              borderRadius: 10,
              padding: 12,
              fontSize: 14,
              color: '#1c1917',
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
                borderColor: '#e7e5e4',
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
                backgroundColor: '#1c1917',
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
      animationType="fade"
      onRequestClose={() => { setPendingDetailRating(null); router.back(); }}
    >
      <View style={{
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'flex-end',
      }}>
        <View style={{
          backgroundColor: '#fff',
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 28,
          paddingBottom: 44,
        }}>
          <Text style={{
            fontSize: 17,
            fontWeight: '700',
            color: '#1c1917',
            marginBottom: 6,
          }}>
            How was it?
          </Text>
          <Text style={{
            fontSize: 13,
            color: '#a8a29e',
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
                  color: detailRating != null && n <= detailRating ? '#f59e0b' : '#e7e5e4',
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
              backgroundColor: detailRating == null ? '#e7e5e4' : '#1c1917',
              borderRadius: 10,
              paddingVertical: 14,
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            {savingDetailRating
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={{
                  color: detailRating == null ? '#a8a29e' : '#fff',
                  fontSize: 14,
                  fontWeight: '600',
                }}>Save rating</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { setPendingDetailRating(null); setDetailRating(null); router.back(); }}
            style={{ alignItems: 'center', paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 13, color: '#a8a29e' }}>Skip</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    </View>
  );
}
