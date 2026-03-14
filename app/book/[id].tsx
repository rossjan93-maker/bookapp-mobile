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

// ─── Types ────────────────────────────────────────────────────────────────────

type OLMeta = {
  description: string | null;
  subjects: string[];
  pageCount: number | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function Divider() {
  return <View style={{ height: 1, backgroundColor: '#f0ede8', marginBottom: 22 }} />;
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

  // Inline page-count editor
  const [editingPageCount, setEditingPageCount] = useState(false);
  const [pageCountInput, setPageCountInput] = useState('');
  const [savingPageCount, setSavingPageCount] = useState(false);
  const [pageCountError, setPageCountError] = useState<string | null>(null);

  const pageInputRef      = useRef<TextInput>(null);
  const pageCountInputRef = useRef<TextInput>(null);

  const badge     = status ? (STATUS_META[status] ?? null) : null;
  const hasRecCtx = !!(fromUser || toUser || note);
  const isReading = status === 'reading' || status === 'started';

  // ── Fetch OL metadata + Google Books page-count fallback ─────────────────

  useEffect(() => {
    if (!externalId) return;
    setMetaLoading(true);

    async function enrich() {
      const meta = await fetchOLMeta(externalId!);
      setOlMeta(meta);
      setMetaLoading(false);

      if (meta.pageCount && bookId && supabase) {
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

  // ── Derived pacing ────────────────────────────────────────────────────────

  const hasPaging      = currentPage != null && pageCount != null && pageCount > 0;
  const pagePacing     = hasPaging ? computePagePacing(currentPage!, pageCount!, startedAt, yearlyGoal) : null;
  const datePacingNote = !hasPaging ? computePacingNote(startedAt, yearlyGoal) : null;
  const pacingState    = pagePacing?.state ?? null;
  const isAhead        = pacingState === 'ahead';
  const progressPct    = hasPaging ? Math.min(100, Math.round((currentPage! / pageCount!) * 100)) : null;

  const descText       = olMeta?.description ?? null;
  const DESC_LIMIT     = 320;
  const descTruncated  = descText && descText.length > DESC_LIMIT && !descExpanded;
  const displayDesc    = descTruncated ? descText!.slice(0, DESC_LIMIT).trimEnd() + '…' : descText;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
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
        <CoverThumb url={coverUrl || null} externalId={externalId || null} width={122} height={180} />
      </View>

      <View style={{ paddingHorizontal: 24, paddingTop: 28 }}>

        {/* ── Title block: title + [author · badge] ── */}
        <Text style={{
          fontSize: 26,
          fontWeight: '800',
          color: '#1c1917',
          letterSpacing: -0.5,
          lineHeight: 34,
          marginBottom: 8,
        }}>
          {title ?? '—'}
        </Text>
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 28,
        }}>
          <Text style={{ fontSize: 16, color: '#78716c', flex: 1, marginRight: 12 }} numberOfLines={2}>
            {author ?? '—'}
          </Text>
          {badge && (
            <View style={{
              backgroundColor: badge.bg,
              borderRadius: 8,
              paddingHorizontal: 11,
              paddingVertical: 5,
              alignSelf: 'flex-start',
            }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: badge.text }}>
                {badge.label}
              </Text>
            </View>
          )}
        </View>

        {/* ── Reading Progress card ── */}
        {isReading && (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 16,
            padding: 18,
            marginBottom: 18,
            borderTopWidth: 3,
            borderTopColor: '#1c1917',
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
                {/* Progress bar */}
                {hasPaging && (
                  <View style={{ marginBottom: 14 }}>
                    <View style={{
                      height: 6,
                      backgroundColor: '#e7e5e4',
                      borderRadius: 3,
                      overflow: 'hidden',
                      marginBottom: 7,
                    }}>
                      <View style={{
                        height: 6,
                        width: `${progressPct ?? 0}%`,
                        backgroundColor: '#1c1917',
                        borderRadius: 3,
                      }} />
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: '#1c1917', fontWeight: '600' }}>
                        Page {currentPage} of {pageCount}
                      </Text>
                      <Text style={{ fontSize: 13, color: '#78716c' }}>
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

                {/* Progress CTA — primary action */}
                {!editingProgress ? (
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
                    }}
                  >
                    <Text style={{ fontSize: 14, color: '#fff', fontWeight: '600' }}>
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

        {/* ── Recommendation context — warm card ── */}
        {hasRecCtx && (
          <View style={{
            backgroundColor: '#fffbf5',
            borderRadius: 14,
            padding: 18,
            marginBottom: 18,
            borderLeftWidth: 3,
            borderLeftColor: '#d4a574',
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}>
            {fromUser && (
              <View style={{ marginBottom: note ? 14 : 0 }}>
                <Text style={{ fontSize: 12, color: '#a8a29e', fontWeight: '500', marginBottom: 3 }}>
                  Recommended by
                </Text>
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#1c1917' }}>
                  {fromUser}
                </Text>
              </View>
            )}
            {toUser && !fromUser && (
              <View style={{ marginBottom: note ? 14 : 0 }}>
                <Text style={{ fontSize: 12, color: '#a8a29e', fontWeight: '500', marginBottom: 3 }}>
                  You recommended this to
                </Text>
                <Text style={{ fontSize: 15, fontWeight: '700', color: '#1c1917' }}>
                  {toUser}
                </Text>
              </View>
            )}
            {note && (
              <View style={{
                borderTopWidth: (fromUser || toUser) ? 1 : 0,
                borderTopColor: '#f0e8dc',
                paddingTop: (fromUser || toUser) ? 14 : 0,
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
                  <Text style={{ fontSize: 12, color: '#a8a29e', marginTop: 6 }}>— {fromUser}</Text>
                )}
              </View>
            )}
          </View>
        )}

        {/* ── About this book ── */}
        {metaLoading ? (
          <ActivityIndicator color="#a8a29e" size="small" style={{ marginBottom: 18, alignSelf: 'flex-start' }} />
        ) : displayDesc ? (
          <View style={{ marginBottom: 22 }}>
            <Divider />
            <SectionLabel>About this book</SectionLabel>
            <Text style={{ fontSize: 14, color: '#57534e', lineHeight: 24 }}>{displayDesc}</Text>
            {descText && descText.length > DESC_LIMIT && (
              <TouchableOpacity
                onPress={() => setDescExpanded(v => !v)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginTop: 8 }}
              >
                <Text style={{ fontSize: 13, color: '#78716c', textDecorationLine: 'underline' }}>
                  {descExpanded ? 'Show less' : 'Read more'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}

        {/* ── Subjects ── */}
        {olMeta && olMeta.subjects.length > 0 && (
          <View style={{ marginBottom: 24 }}>
            <SectionLabel>Subjects</SectionLabel>
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

        {/* ── Taste Match / Why this fits you ── */}
        {externalId ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            borderWidth: 1,
            borderColor: '#f0ede8',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#1c1917', marginRight: 10 }}>
                Why this fits you
              </Text>
              <View style={{
                backgroundColor: '#fef3c7',
                borderRadius: 6,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: '#92400e', letterSpacing: 0.5 }}>
                  COMING SOON
                </Text>
              </View>
            </View>
            <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20 }}>
              Once you've built your taste profile, we'll explain how this book fits — or challenges — your reading style.
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/edit-preferences')}
              style={{ marginTop: 12 }}
            >
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
