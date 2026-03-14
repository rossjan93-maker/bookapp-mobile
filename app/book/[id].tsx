import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { computePacingNote, computePagePacing } from '../../lib/pacing';
import { fetchGoogleBooksPageCount } from '../../lib/googleBooks';

const STATUS_META: Record<string, { bg: string; text: string; label: string }> = {
  want_to_read: { bg: '#f1f5f9', text: '#475569', label: 'Want to Read' },
  reading:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'      },
  finished:     { bg: '#dcfce7', text: '#15803d', label: 'Finished'     },
  dnf:          { bg: '#fee2e2', text: '#b91c1c', label: 'DNF'          },
  sent:         { bg: '#f1f5f9', text: '#475569', label: 'New'          },
  saved:        { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read' },
  started:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'      },
};

type OLMeta = {
  description: string | null;
  subjects: string[];
  pageCount: number | null;
};

function extractOLID(externalId: string): string | null {
  const m = externalId.match(/\/works\/(OL\w+)/);
  return m ? m[1] : null;
}

async function fetchOLMeta(externalId: string): Promise<OLMeta> {
  const olid = extractOLID(externalId);
  if (!olid) return { description: null, subjects: [], pageCount: null };
  try {
    const res = await fetch(`https://openlibrary.org/works/${olid}.json`);
    if (!res.ok) return { description: null, subjects: [], pageCount: null };
    const data = await res.json();

    let description: string | null = null;
    if (typeof data.description === 'string') description = data.description;
    else if (data.description?.value) description = data.description.value;

    const subjects: string[] = Array.isArray(data.subjects) ? data.subjects.slice(0, 8) : [];
    const pageCount: number | null = typeof data.number_of_pages === 'number' ? data.number_of_pages : null;

    return { description, subjects, pageCount };
  } catch {
    return { description: null, subjects: [], pageCount: null };
  }
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 10,
      fontWeight: '700',
      color: '#9ca3af',
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginBottom: 10,
    }}>
      {children}
    </Text>
  );
}

export default function BookDetailScreen() {
  const router = useRouter();
  const {
    id: bookId,
    title,
    author,
    coverUrl,
    externalId,
    status,
    note,
    fromUser,
    toUser,
    startedAt,
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

  // Reading progress state
  const [userBookId, setUserBookId]     = useState<string | null>(null);
  const [userId, setUserId]             = useState<string | null>(null);
  const [currentPage, setCurrentPage]   = useState<number | null>(null);
  const [pageCount, setPageCount]       = useState<number | null>(null);
  const [yearlyGoal, setYearlyGoal]     = useState<number | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);

  // Inline progress editor
  const [editingProgress, setEditingProgress] = useState(false);
  const [pageInput, setPageInput]       = useState('');
  const [savingProgress, setSavingProgress] = useState(false);
  const [progressError, setProgressError]  = useState<string | null>(null);

  // Inline page-count editor (missing page count recovery)
  const [editingPageCount, setEditingPageCount] = useState(false);
  const [pageCountInput, setPageCountInput] = useState('');
  const [savingPageCount, setSavingPageCount] = useState(false);
  const [pageCountError, setPageCountError] = useState<string | null>(null);

  const pageInputRef      = useRef<TextInput>(null);
  const pageCountInputRef = useRef<TextInput>(null);

  const badge      = status ? (STATUS_META[status] ?? null) : null;
  const hasRecCtx  = !!(fromUser || toUser || note);
  const isReading  = status === 'reading' || status === 'started';

  // ── Fetch OL metadata + Google Books page-count fallback ──
  useEffect(() => {
    if (!externalId) return;
    setMetaLoading(true);

    async function enrich() {
      const meta = await fetchOLMeta(externalId!);
      setOlMeta(meta);
      setMetaLoading(false);

      if (meta.pageCount && bookId && supabase) {
        // OL returned a page count — persist it (no-op if already set in DB)
        supabase
          .from('books')
          .update({ page_count: meta.pageCount })
          .eq('id', bookId)
          .is('page_count', null)
          .then(({ error }) => {
            if (!error) setPageCount(prev => prev ?? meta.pageCount!);
          });
        return;
      }

      // OL had no page count — try Google Books silently
      if (bookId && title && author && supabase) {
        const gbCount = await fetchGoogleBooksPageCount(
          String(title ?? '').trim(),
          String(author ?? '').trim(),
        );
        if (gbCount) {
          setPageCount(prev => prev ?? gbCount);
          supabase
            .from('books')
            .update({ page_count: gbCount })
            .eq('id', bookId)
            .is('page_count', null)
            .then(() => {});
        }
      }
    }

    enrich();
  }, [externalId, bookId]);

  // ── Fetch reading progress + yearly goal ──
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
          .select('id, current_page')
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
      // Log to progress history if page actually changed (fire-and-forget; table may not exist yet)
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
      // RLS blocked the update silently: no row was modified
      setPageCountError('Could not save — permission denied. Try reloading.');
    } else {
      setPageCount(newCount);
      setEditingPageCount(false);
      Keyboard.dismiss();
    }
  }

  // ── Derived pacing ──
  const hasPaging = currentPage != null && pageCount != null && pageCount > 0;
  const pagePacing = hasPaging
    ? computePagePacing(currentPage!, pageCount!, startedAt, yearlyGoal)
    : null;
  const datePacingNote = !hasPaging
    ? computePacingNote(startedAt, yearlyGoal)
    : null;

  const pacingState = pagePacing?.state ?? null;
  const isAhead     = pacingState === 'ahead';

  const progressPct = hasPaging
    ? Math.min(100, Math.round((currentPage! / pageCount!) * 100))
    : null;

  const descText = olMeta?.description ?? null;
  const DESC_LIMIT = 320;
  const descTruncated = descText && descText.length > DESC_LIMIT && !descExpanded;
  const displayDesc = descTruncated ? descText!.slice(0, DESC_LIMIT).trimEnd() + '…' : descText;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingBottom: 64 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Hero cover ── */}
      <View style={{ backgroundColor: '#f0ede8', alignItems: 'center', paddingTop: 60, paddingBottom: 40 }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: 56, left: 20, zIndex: 10 }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={{ fontSize: 14, color: '#78716c' }}>← Back</Text>
        </TouchableOpacity>
        <CoverThumb url={coverUrl || null} externalId={externalId || null} width={116} height={170} />
      </View>

      <View style={{ paddingHorizontal: 24, paddingTop: 28 }}>

        {/* ── Title + author ── */}
        <Text style={{ fontSize: 24, fontWeight: '800', color: '#111827', letterSpacing: -0.4, lineHeight: 32, marginBottom: 6 }}>
          {title ?? '—'}
        </Text>
        <Text style={{ fontSize: 16, color: '#78716c', marginBottom: 20 }}>
          {author ?? '—'}
        </Text>

        {/* ── Status badge row ── */}
        {badge && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 22 }}>
            <View style={{ backgroundColor: badge.bg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: badge.text }}>{badge.label}</Text>
            </View>
          </View>
        )}

        {/* ── Reading Progress card ── */}
        {isReading && (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 16,
            padding: 18,
            marginBottom: 18,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 2,
          }}>
            <SectionLabel>Reading Progress</SectionLabel>

            {progressLoading ? (
              <ActivityIndicator color="#a8a29e" size="small" />
            ) : (
              <>
                {/* Progress bar + page label */}
                {hasPaging && (
                  <View style={{ marginBottom: 14 }}>
                    <View style={{ height: 6, backgroundColor: '#e7e5e4', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
                      <View style={{
                        height: 6,
                        width: `${progressPct ?? 0}%`,
                        backgroundColor: '#1d4ed8',
                        borderRadius: 3,
                      }} />
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: '#374151', fontWeight: '600' }}>
                        Page {currentPage} of {pageCount}
                      </Text>
                      <Text style={{ fontSize: 13, color: '#6b7280' }}>
                        {progressPct ?? 0}% · {pagePacing?.pagesLeft} left
                      </Text>
                    </View>
                  </View>
                )}

                {/* Pacing guidance */}
                {(pagePacing || datePacingNote) && (
                  <View style={{
                    backgroundColor: isAhead ? '#f0fdf4' : '#fef9f0',
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderWidth: 1,
                    borderColor: isAhead ? '#bbf7d0' : '#fde68a',
                    marginBottom: 14,
                  }}>
                    {pagePacing ? (
                      <>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: isAhead ? '#15803d' : '#92400e' }}>
                          {pacingState === 'ahead'
                            ? 'Ahead of pace'
                            : pacingState === 'on_pace' && pagePacing.targetDate
                            ? 'On pace'
                            : pagePacing.pagesPerDayNeeded != null
                            ? `${pagePacing.pagesPerDayNeeded} pages/day to stay on pace`
                            : `${pagePacing.pagesLeft} pages left`}
                        </Text>
                        {pagePacing.targetDate && (
                          <Text style={{ fontSize: 12, color: isAhead ? '#16a34a' : '#b45309', marginTop: 2 }}>
                            Target finish: {pagePacing.targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text style={{ fontSize: 13, fontWeight: '500', color: '#92400e' }}>
                        {datePacingNote}
                      </Text>
                    )}
                  </View>
                )}

                {/* No goal nudge */}
                {!pagePacing && !datePacingNote && !yearlyGoal && (
                  <TouchableOpacity
                    onPress={() => router.push('/(tabs)/profile')}
                    style={{
                      backgroundColor: '#faf9f7',
                      borderRadius: 8,
                      paddingHorizontal: 12,
                      paddingVertical: 9,
                      marginBottom: 14,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: '#a8a29e' }}>
                      Set a yearly reading goal on your profile to get pacing guidance →
                    </Text>
                  </TouchableOpacity>
                )}

                {/* Missing page count recovery */}
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

                {/* Inline progress editor */}
                {!editingProgress ? (
                  <TouchableOpacity
                    onPress={() => {
                      setPageInput(currentPage != null ? String(currentPage) : '');
                      setProgressError(null);
                      setEditingProgress(true);
                      setTimeout(() => pageInputRef.current?.focus(), 80);
                    }}
                    style={{
                      borderWidth: 1.5,
                      borderColor: '#e7e5e4',
                      borderRadius: 10,
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500' }}>
                      {currentPage != null ? 'Update progress' : '+ Log current page'}
                    </Text>
                  </TouchableOpacity>
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
              </>
            )}
          </View>
        )}

        {/* ── Recommendation context ── */}
        {hasRecCtx && (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            marginBottom: 18,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 1,
          }}>
            {fromUser ? (
              <View style={{ marginBottom: note || toUser ? 14 : 0 }}>
                <SectionLabel>Recommended by</SectionLabel>
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#111827' }}>{fromUser}</Text>
              </View>
            ) : null}
            {toUser ? (
              <View style={{ marginBottom: note ? 14 : 0 }}>
                <SectionLabel>Recommended to</SectionLabel>
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#111827' }}>{toUser}</Text>
              </View>
            ) : null}
            {note ? (
              <View>
                <SectionLabel>Their note</SectionLabel>
                <Text style={{ fontSize: 14, color: '#374151', fontStyle: 'italic', lineHeight: 22 }}>
                  "{note}"
                </Text>
              </View>
            ) : null}
          </View>
        )}

        {/* ── OL description ── */}
        {metaLoading ? (
          <ActivityIndicator color="#a8a29e" size="small" style={{ marginBottom: 18, alignSelf: 'flex-start' }} />
        ) : displayDesc ? (
          <View style={{ marginBottom: 20 }}>
            <SectionLabel>About this book</SectionLabel>
            <Text style={{ fontSize: 14, color: '#374151', lineHeight: 23 }}>{displayDesc}</Text>
            {descText && descText.length > DESC_LIMIT && (
              <TouchableOpacity
                onPress={() => setDescExpanded(v => !v)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginTop: 6 }}
              >
                <Text style={{ fontSize: 13, color: '#78716c', textDecorationLine: 'underline' }}>
                  {descExpanded ? 'Show less' : 'Read more'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}

        {/* ── OL subjects ── */}
        {olMeta && olMeta.subjects.length > 0 && (
          <View style={{ marginBottom: 22 }}>
            <SectionLabel>Subjects</SectionLabel>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {olMeta.subjects.map((subject, i) => (
                <View key={i} style={{ backgroundColor: '#f5f5f4', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5 }}>
                  <Text style={{ fontSize: 12, color: '#57534e' }}>{subject}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Taste Match placeholder ── */}
        {externalId ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            borderWidth: 1,
            borderColor: '#f0ede8',
            borderStyle: 'dashed',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <View style={{ backgroundColor: '#fef3c7', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 10 }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: '#92400e', letterSpacing: 0.5 }}>COMING SOON</Text>
              </View>
              <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917' }}>Taste Match</Text>
            </View>
            <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20 }}>
              Once we know your reading history and taste better, we'll explain why this book might — or might not — be a great fit for you.
            </Text>
            <TouchableOpacity onPress={() => router.push('/edit-preferences')} style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 13, color: '#78716c', textDecorationLine: 'underline' }}>
                Build your taste profile →
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
