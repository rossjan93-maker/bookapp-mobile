import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import {
  fetchClubComments,
  fetchMemberProgress,
  inviteMember,
  isCommentVisible,
  postComment,
  unlocksAtPage,
} from '../../lib/bookClub';
import type {
  BookClub,
  BookClubBook,
  CommentWithAuthor,
  MemberProgress,
} from '../../lib/bookClubTypes';
import { getDisplayName, getFirstName } from '../../lib/displayName';

// ── Design tokens ──────────────────────────────────────────────────────────────
const INK    = '#231f1b';
const DUST   = '#9e958d';
const SAGE   = '#7b9e7e';
const BG     = '#f5f1ec';
const PAPER  = '#fefcf9';
const BORDER = '#ede9e4';
const STONE  = '#6b635c';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Section label ──────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.sectionLine} />
    </View>
  );
}

// ── Progress bar row ───────────────────────────────────────────────────────────

function ProgressRow({ member }: { member: MemberProgress }) {
  return (
    <View style={styles.progressRow}>
      <Text style={styles.progressName} numberOfLines={1}>{member.displayName}</Text>
      <View style={styles.progressBarWrap}>
        <View style={[styles.progressBarFill, { width: `${member.percentComplete}%` }]} />
      </View>
      <Text style={styles.progressPct}>{member.percentComplete}%</Text>
    </View>
  );
}

// ── Comment row ────────────────────────────────────────────────────────────────

function CommentRow({
  comment,
  readerPage,
  isOwn,
}: {
  comment:    CommentWithAuthor;
  readerPage: number;
  isOwn:      boolean;
}) {
  const visible = isCommentVisible(readerPage, comment.page_threshold);
  const authorName = comment.author
    ? getFirstName({ first_name: comment.author.first_name, last_name: comment.author.last_name, username: comment.author.username })
    : 'Unknown';

  if (!visible) {
    return (
      <View style={styles.lockedComment}>
        <Ionicons name="lock-closed" size={13} color={DUST} />
        <Text style={styles.lockedText}>
          Unlocks at page {unlocksAtPage(comment.page_threshold)}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.comment, isOwn && styles.commentOwn]}>
      <View style={styles.commentHeader}>
        <Text style={[styles.commentAuthor, isOwn && styles.commentAuthorOwn]}>{authorName}</Text>
        <Text style={styles.commentTime}>{formatTime(comment.created_at)}</Text>
      </View>
      <Text style={[styles.commentBody, isOwn && styles.commentBodyOwn]}>{comment.body}</Text>
      {comment.page_threshold > 0 && (
        <Text style={styles.commentPage}>p. {comment.page_threshold}</Text>
      )}
    </View>
  );
}

// ── Set book modal (admin only) ────────────────────────────────────────────────

type BookResult = {
  id:          string;
  title:       string;
  author:      string;
  cover_url:   string | null;
  external_id: string | null;
  page_count:  number | null;
};

function SetBookModal({
  visible,
  clubId,
  onClose,
  onSet,
}: {
  visible: boolean;
  clubId:  string;
  onClose: () => void;
  onSet:   () => void;
}) {
  const [query,      setQuery]      = useState('');
  const [results,    setResults]    = useState<BookResult[]>([]);
  const [selected,   setSelected]   = useState<BookResult | null>(null);
  const [totalPages, setTotalPages] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [loading,    setLoading]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  async function searchBooks() {
    if (!query.trim() || !supabase) return;
    setLoading(true);
    setError(null);
    // P1.5b-2 D4: book club admin search hard-filter. The selected row
    // becomes the club's active book and is visible to every member, so
    // surface only verified rows OR the admin's own inserted rows.
    const { data: { user } } = await supabase.auth.getUser();
    let q = supabase
      .from('books')
      .select('id, title, author, cover_url, external_id, page_count')
      .ilike('title', `%${query.trim()}%`);
    if (user) {
      q = q.or(`provenance_state.eq.verified,provenance_inserted_by.eq.${user.id}`);
    } else {
      q = q.eq('provenance_state', 'verified');
    }
    const { data } = await q.limit(10);
    setResults((data ?? []) as BookResult[]);
    setLoading(false);
  }

  async function handleSave() {
    if (!selected || !supabase) { setError('Select a book first.'); return; }
    const pages = parseInt(totalPages, 10);
    if (!pages || pages <= 0) { setError('Enter a valid page count.'); return; }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError('Not signed in.'); return; }

    setSaving(true);
    setError(null);

    const { setClubBook } = await import('../../lib/bookClub');
    const { error: err } = await setClubBook(supabase, {
      clubId,
      bookId:           selected.id,
      selectedBy:       user.id,
      totalPages:       pages,
      targetFinishDate: targetDate.trim() || null,
    });

    setSaving(false);
    if (err) { setError(err); return; }

    handleClose();
    onSet();
  }

  function handleClose() {
    setQuery('');
    setResults([]);
    setSelected(null);
    setTotalPages('');
    setTargetDate('');
    setError(null);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={styles.modalWrap}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Set current book</Text>
          <TouchableOpacity onPress={handleClose} hitSlop={12}>
            <Ionicons name="close" size={22} color={INK} />
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.modalBody2} keyboardShouldPersistTaps="handled">
          {!selected ? (
            <>
              <View style={styles.searchRow}>
                <TextInput
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search by title"
                  placeholderTextColor={DUST}
                  onSubmitEditing={searchBooks}
                  returnKeyType="search"
                />
                <TouchableOpacity style={styles.searchBtn} onPress={searchBooks}>
                  <Ionicons name="search" size={18} color={PAPER} />
                </TouchableOpacity>
              </View>
              {loading && <ActivityIndicator color={SAGE} style={{ marginTop: 16 }} />}
              {results.map(b => (
                <TouchableOpacity key={b.id} style={styles.bookPickRow} onPress={() => {
                  setSelected(b);
                  if (b.page_count) setTotalPages(String(b.page_count));
                }}>
                  <CoverThumb url={b.cover_url} externalId={b.external_id} title={b.title} width={36} height={52} radius={4} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.bookPickTitle} numberOfLines={1}>{b.title}</Text>
                    <Text style={styles.bookPickAuthor} numberOfLines={1}>{b.author}</Text>
                  </View>
                </TouchableOpacity>
              ))}
              {results.length === 0 && !loading && query.length > 0 && (
                <Text style={styles.noResults}>No books found. Try a different title.</Text>
              )}
            </>
          ) : (
            <>
              <TouchableOpacity style={styles.selectedBook} onPress={() => setSelected(null)}>
                <CoverThumb url={selected.cover_url} externalId={selected.external_id} title={selected.title} width={44} height={64} radius={6} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.bookPickTitle}>{selected.title}</Text>
                  <Text style={styles.bookPickAuthor}>{selected.author}</Text>
                </View>
                <Text style={styles.changeText}>Change</Text>
              </TouchableOpacity>

              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Total pages</Text>
              <TextInput
                style={styles.textInput}
                value={totalPages}
                onChangeText={setTotalPages}
                placeholder="e.g. 352"
                placeholderTextColor={DUST}
                keyboardType="number-pad"
              />

              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Target finish date (optional)</Text>
              <TextInput
                style={styles.textInput}
                value={targetDate}
                onChangeText={setTargetDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={DUST}
                maxLength={10}
              />

              {error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[styles.createButton, saving && { opacity: 0.6 }]}
                onPress={handleSave}
                disabled={saving}
                activeOpacity={0.8}
              >
                {saving
                  ? <ActivityIndicator size="small" color={PAPER} />
                  : <Text style={styles.createButtonText}>Set book</Text>
                }
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Invite modal ───────────────────────────────────────────────────────────────

function InviteModal({
  visible,
  clubId,
  onClose,
}: {
  visible: boolean;
  clubId:  string;
  onClose: () => void;
}) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<{ id: string; username: string; first_name: string | null; last_name: string | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg,     setMsg]     = useState<string | null>(null);

  async function search() {
    if (!query.trim() || !supabase) return;
    setLoading(true);
    setMsg(null);
    // Find friends matching the query
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    // Get accepted friend IDs
    const { data: friendships } = await supabase
      .from('friendships')
      .select('requester_id, addressee_id')
      .eq('status', 'accepted')
      .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

    const friendIds = (friendships ?? []).map(f =>
      f.requester_id === user.id ? f.addressee_id : f.requester_id,
    );

    if (friendIds.length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, first_name, last_name')
      .in('id', friendIds)
      .ilike('username', `%${query.trim()}%`)
      .limit(10);

    setResults(profiles ?? []);
    setLoading(false);
  }

  async function invite(friendId: string) {
    if (!supabase) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await inviteMember(supabase, {
      clubId,
      inviterId: user.id,
      inviteeId: friendId,
    });

    setMsg(error ?? 'Invited successfully!');
  }

  function handleClose() {
    setQuery('');
    setResults([]);
    setMsg(null);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={styles.modalWrap}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Invite a friend</Text>
          <TouchableOpacity onPress={handleClose} hitSlop={12}>
            <Ionicons name="close" size={22} color={INK} />
          </TouchableOpacity>
        </View>
        <View style={styles.modalBody2}>
          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search by username"
              placeholderTextColor={DUST}
              onSubmitEditing={search}
              returnKeyType="search"
            />
            <TouchableOpacity style={styles.searchBtn} onPress={search}>
              <Ionicons name="search" size={18} color={PAPER} />
            </TouchableOpacity>
          </View>

          {loading && <ActivityIndicator color={SAGE} style={{ marginTop: 16 }} />}

          {msg && (
            <Text style={[styles.msgText, msg.includes('success') || msg.includes('already') ? {} : { color: '#c0392b' }]}>
              {msg}
            </Text>
          )}

          {results.map(p => (
            <View key={p.id} style={styles.friendRow}>
              <Text style={styles.friendName}>{getDisplayName({ first_name: p.first_name, last_name: p.last_name, username: p.username })}</Text>
              <TouchableOpacity style={styles.inviteBtn} onPress={() => invite(p.id)}>
                <Text style={styles.inviteBtnText}>Invite</Text>
              </TouchableOpacity>
            </View>
          ))}

          {results.length === 0 && !loading && query.length > 0 && (
            <Text style={styles.noResults}>No matching friends found.</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

type ClubDetail = {
  club:        BookClub;
  activeBook:  (BookClubBook & { title: string; author: string; cover_url: string | null; external_id: string | null }) | null;
  isAdmin:     boolean;
};

export default function ClubDetailScreen() {
  const { id }     = useLocalSearchParams<{ id: string }>();
  const insets     = useSafeAreaInsets();
  const router     = useRouter();

  const [detail,       setDetail]       = useState<ClubDetail | null>(null);
  const [progress,     setProgress]     = useState<MemberProgress[]>([]);
  const [comments,     setComments]     = useState<CommentWithAuthor[]>([]);
  const [readerPage,   setReaderPage]   = useState(0);
  const [userId,       setUserId]       = useState<string | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [commentText,  setCommentText]  = useState('');
  const [posting,      setPosting]      = useState(false);
  const [showInvite,   setShowInvite]   = useState(false);
  const [showSetBook,  setShowSetBook]  = useState(false);

  const flatRef = useRef<FlatList>(null);

  useFocusEffect(
    useCallback(() => {
      if (id) loadAll(id);
    }, [id]),
  );

  async function loadAll(clubId: string) {
    if (!supabase) return;
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    setUserId(user.id);

    // Club info + membership
    const [clubResult, memberResult] = await Promise.all([
      supabase.from('book_clubs').select('*').eq('id', clubId).single(),
      supabase.from('book_club_members').select('role').eq('club_id', clubId).eq('user_id', user.id).maybeSingle(),
    ]);

    if (!clubResult.data) { setLoading(false); return; }

    const isAdmin = memberResult.data?.role === 'admin';

    // Active book
    const { data: bookRow } = await supabase
      .from('book_club_books')
      .select(`
        id, club_id, book_id, selected_by, total_pages, target_finish_date, status, created_at,
        book:books!book_club_books_book_id_fkey (title, author, cover_url, external_id)
      `)
      .eq('club_id', clubId)
      .eq('status', 'active')
      .maybeSingle();

    const bookData = bookRow?.book as { title: string; author: string; cover_url: string | null; external_id: string | null } | null;

    const activeBook = bookRow
      ? { ...bookRow, title: bookData?.title ?? '', author: bookData?.author ?? '', cover_url: bookData?.cover_url ?? null, external_id: bookData?.external_id ?? null }
      : null;

    setDetail({ club: clubResult.data, activeBook, isAdmin });

    // Reader's current page for this book
    if (activeBook) {
      const { data: ub } = await supabase
        .from('user_books')
        .select('current_page')
        .eq('user_id', user.id)
        .eq('book_id', activeBook.book_id)
        .maybeSingle();
      setReaderPage(ub?.current_page ?? 0);

      // Member progress
      const { progress: prog } = await fetchMemberProgress(supabase, {
        clubId,
        clubBookId: activeBook.id,
        bookId:     activeBook.book_id,
        totalPages: activeBook.total_pages,
      });
      setProgress(prog);

      // Comments
      const { comments: coms } = await fetchClubComments(supabase, { clubBookId: activeBook.id });
      setComments(coms);
    } else {
      // No active book — clear any stale state from a previous navigation
      setProgress([]);
      setComments([]);
      setReaderPage(0);
    }

    setLoading(false);
  }

  async function handlePostComment() {
    if (!detail?.activeBook || !supabase || !userId || !commentText.trim()) return;
    setPosting(true);

    const { comment, error } = await postComment(supabase, {
      clubId:     detail.club.id,
      clubBookId: detail.activeBook.id,
      bookId:     detail.activeBook.book_id,
      userId,
      body:       commentText.trim(),
    });

    setPosting(false);

    if (comment) {
      // Refresh comments and clear input
      const { comments: coms } = await fetchClubComments(supabase, { clubBookId: detail.activeBook.id });
      setComments(coms);
      setCommentText('');
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }

  if (loading) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={SAGE} />
        </View>
      </View>
    );
  }

  if (!detail) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Text style={{ textAlign: 'center', marginTop: 40, color: DUST }}>Club not found.</Text>
      </View>
    );
  }

  const { club, activeBook, isAdmin } = detail;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={INK} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{club.name}</Text>
        {isAdmin ? (
          <TouchableOpacity onPress={() => setShowInvite(true)} hitSlop={10} style={styles.inviteIconBtn}>
            <Ionicons name="person-add-outline" size={20} color={INK} />
          </TouchableOpacity>
        ) : (
          <View style={styles.inviteIconBtn} />
        )}
      </View>

      <FlatList
        ref={flatRef}
        data={comments}
        keyExtractor={c => c.id}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={() => (
          <>
            {/* Active book */}
            <View style={styles.bookSection}>
              {activeBook ? (
                <>
                  <View style={styles.bookRow}>
                    <CoverThumb
                      url={activeBook.cover_url}
                      externalId={activeBook.external_id}
                      title={activeBook.title}
                      width={64}
                      height={92}
                      radius={8}
                    />
                    <View style={styles.bookInfo}>
                      <Text style={styles.bookTitle}>{activeBook.title}</Text>
                      <Text style={styles.bookAuthor}>{activeBook.author}</Text>
                      {activeBook.target_finish_date && (
                        <View style={styles.targetRow}>
                          <Ionicons name="calendar-outline" size={12} color={DUST} />
                          <Text style={styles.targetDate}>
                            Target: {formatDate(activeBook.target_finish_date)}
                          </Text>
                        </View>
                      )}
                      <Text style={styles.totalPages}>{activeBook.total_pages} pages</Text>
                    </View>
                  </View>
                  {isAdmin && (
                    <TouchableOpacity
                      style={styles.setBookBtn}
                      onPress={() => setShowSetBook(true)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="book-outline" size={13} color={STONE} />
                      <Text style={styles.setBookBtnText}>Change book</Text>
                    </TouchableOpacity>
                  )}
                </>
              ) : (
                <View style={styles.noBookWrap}>
                  <Ionicons name="book-outline" size={28} color={DUST} />
                  <Text style={styles.noBookText}>No active book yet.</Text>
                  {isAdmin && (
                    <TouchableOpacity
                      style={styles.setBookBtn}
                      onPress={() => setShowSetBook(true)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="add" size={13} color={STONE} />
                      <Text style={styles.setBookBtnText}>Set current book</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>

            {/* Member progress */}
            {progress.length > 0 && (
              <>
                <SectionLabel label="Progress" />
                <View style={styles.progressSection}>
                  {progress.map(m => (
                    <ProgressRow key={m.userId} member={m} />
                  ))}
                </View>
              </>
            )}

            {/* Comments header */}
            <SectionLabel label="Discussion" />
            {comments.length === 0 && (
              <Text style={styles.noComments}>
                No comments yet. Be the first to share your thoughts!
              </Text>
            )}
          </>
        )}
        renderItem={({ item }) => (
          <CommentRow
            comment={item}
            readerPage={readerPage}
            isOwn={item.user_id === userId}
          />
        )}
        ListFooterComponent={<View style={{ height: 12 }} />}
      />

      {/* Comment input */}
      {activeBook && (
        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <TextInput
            style={styles.commentInput}
            value={commentText}
            onChangeText={setCommentText}
            placeholder="Share your thoughts…"
            placeholderTextColor={DUST}
            multiline
            maxLength={1000}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!commentText.trim() || posting) && { opacity: 0.4 }]}
            onPress={handlePostComment}
            disabled={!commentText.trim() || posting}
          >
            {posting
              ? <ActivityIndicator size="small" color={PAPER} />
              : <Ionicons name="send" size={16} color={PAPER} />
            }
          </TouchableOpacity>
        </View>
      )}

      <InviteModal
        visible={showInvite}
        clubId={club.id}
        onClose={() => setShowInvite(false)}
      />

      {isAdmin && (
        <SetBookModal
          visible={showSetBook}
          clubId={club.id}
          onClose={() => setShowSetBook(false)}
          onSet={() => { if (id) loadAll(id); }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex:            1,
    backgroundColor: BG,
  },
  loadingWrap: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
  },

  header: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    backgroundColor:   PAPER,
    gap:               8,
  },
  backBtn: {
    padding: 2,
  },
  headerTitle: {
    flex:       1,
    fontSize:   17,
    fontWeight: '700',
    color:      INK,
  },
  inviteIconBtn: {
    padding: 4,
  },

  scrollContent: {
    paddingBottom: 8,
  },

  // Book section
  bookSection: {
    backgroundColor: PAPER,
    padding:         16,
    marginBottom:    12,
  },
  bookRow: {
    flexDirection: 'row',
    gap:           14,
    alignItems:    'flex-start',
  },
  bookInfo: {
    flex: 1,
    gap:  4,
  },
  bookTitle: {
    fontSize:   16,
    fontWeight: '700',
    color:      INK,
  },
  bookAuthor: {
    fontSize: 13,
    color:    DUST,
  },
  targetRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
    marginTop:     4,
  },
  targetDate: {
    fontSize: 12,
    color:    DUST,
  },
  totalPages: {
    fontSize: 12,
    color:    STONE,
  },
  noBookWrap: {
    alignItems: 'center',
    padding:    20,
    gap:        8,
  },
  noBookText: {
    color:     DUST,
    fontSize:  14,
    fontStyle: 'italic',
  },

  // Section label
  sectionRow: {
    flexDirection: 'row',
    alignItems:    'center',
    paddingHorizontal: 16,
    marginBottom:  10,
    gap:           10,
  },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    '700',
    color:         DUST,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  sectionLine: {
    flex:            1,
    height:          1,
    backgroundColor: BORDER,
  },

  // Progress
  progressSection: {
    paddingHorizontal: 16,
    gap:               10,
    marginBottom:      16,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
  },
  progressName: {
    width:      90,
    fontSize:   13,
    color:      INK,
    fontWeight: '500',
  },
  progressBarWrap: {
    flex:            1,
    height:          6,
    borderRadius:    3,
    backgroundColor: BORDER,
    overflow:        'hidden',
  },
  progressBarFill: {
    height:          6,
    borderRadius:    3,
    backgroundColor: SAGE,
  },
  progressPct: {
    width:    32,
    fontSize: 12,
    color:    DUST,
    textAlign: 'right',
  },

  // Comments
  noComments: {
    textAlign: 'center',
    color:     DUST,
    fontSize:  13,
    paddingHorizontal: 24,
    marginBottom: 16,
    fontStyle: 'italic',
  },
  comment: {
    backgroundColor: PAPER,
    borderRadius:    12,
    padding:         12,
    marginHorizontal: 16,
    marginBottom:    8,
    shadowColor:     INK,
    shadowOpacity:   0.04,
    shadowRadius:    4,
    shadowOffset:    { width: 0, height: 1 },
    elevation:       1,
  },
  commentOwn: {
    backgroundColor: '#eef4ee',
  },
  commentHeader: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    marginBottom:   4,
  },
  commentAuthor: {
    fontSize:   12,
    fontWeight: '700',
    color:      STONE,
  },
  commentAuthorOwn: {
    color: SAGE,
  },
  commentTime: {
    fontSize: 11,
    color:    DUST,
  },
  commentBody: {
    fontSize:   14,
    color:      INK,
    lineHeight: 20,
  },
  commentBodyOwn: {
    color: '#2d4a2f',
  },
  commentPage: {
    fontSize:  11,
    color:     DUST,
    marginTop: 4,
  },
  lockedComment: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            6,
    marginHorizontal: 16,
    marginBottom:   8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: BORDER,
    borderRadius:   10,
  },
  lockedText: {
    fontSize:  13,
    color:     DUST,
    fontStyle: 'italic',
  },

  // Comment input
  inputBar: {
    flexDirection:     'row',
    alignItems:        'flex-end',
    paddingHorizontal: 14,
    paddingTop:        10,
    borderTopWidth:    1,
    borderTopColor:    BORDER,
    backgroundColor:   PAPER,
    gap:               10,
  },
  commentInput: {
    flex:              1,
    backgroundColor:   BG,
    borderRadius:      20,
    paddingHorizontal: 14,
    paddingVertical:   10,
    fontSize:          14,
    color:             INK,
    maxHeight:         100,
  },
  sendBtn: {
    backgroundColor:  INK,
    width:            38,
    height:           38,
    borderRadius:     19,
    alignItems:       'center',
    justifyContent:   'center',
  },

  // Invite modal
  modalWrap: {
    flex:            1,
    backgroundColor: PAPER,
  },
  modalHeader: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: 20,
    paddingVertical:   16,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  modalTitle: {
    fontSize:   17,
    fontWeight: '700',
    color:      INK,
  },
  modalBody2: {
    padding: 20,
    gap:     12,
  },
  searchRow: {
    flexDirection: 'row',
    gap:           10,
    alignItems:    'center',
  },
  searchInput: {
    flex:              1,
    backgroundColor:   BG,
    borderRadius:      10,
    paddingHorizontal: 14,
    paddingVertical:   11,
    fontSize:          14,
    color:             INK,
    borderWidth:       1,
    borderColor:       BORDER,
  },
  searchBtn: {
    backgroundColor: INK,
    width:           42,
    height:          42,
    borderRadius:    10,
    alignItems:      'center',
    justifyContent:  'center',
  },
  msgText: {
    fontSize:  13,
    color:     SAGE,
    marginTop: 4,
  },
  friendRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  friendName: {
    fontSize:   14,
    color:      INK,
    fontWeight: '500',
  },
  inviteBtn: {
    backgroundColor: INK,
    paddingHorizontal: 14,
    paddingVertical:   7,
    borderRadius:      16,
  },
  inviteBtnText: {
    color:      PAPER,
    fontSize:   13,
    fontWeight: '600',
  },
  noResults: {
    color:     DUST,
    fontSize:  13,
    fontStyle: 'italic',
    marginTop: 8,
  },

  // Set book
  setBookBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               5,
    alignSelf:         'flex-start',
    marginTop:         10,
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      14,
    borderWidth:       1,
    borderColor:       BORDER,
    backgroundColor:   PAPER,
  },
  setBookBtnText: {
    fontSize:   12,
    color:      STONE,
    fontWeight: '500',
  },

  // Book picker
  bookPickRow: {
    flexDirection:    'row',
    alignItems:       'center',
    gap:              12,
    paddingVertical:  12,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  bookPickTitle: {
    fontSize:   14,
    color:      INK,
    fontWeight: '600',
  },
  bookPickAuthor: {
    fontSize: 12,
    color:    DUST,
    marginTop: 2,
  },
  selectedBook: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            12,
    padding:        12,
    backgroundColor: BG,
    borderRadius:   10,
    marginBottom:   4,
  },
  changeText: {
    fontSize:   12,
    color:      SAGE,
    fontWeight: '600',
  },
  fieldLabel: {
    fontSize:      12,
    fontWeight:    '600',
    color:         DUST,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom:  6,
  },
  textInput: {
    backgroundColor: BG,
    borderRadius:    10,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          15,
    color:             INK,
    borderWidth:       1,
    borderColor:       BORDER,
  },
  errorText: {
    color:     '#c0392b',
    fontSize:  13,
    marginTop: 10,
  },
  createButton: {
    backgroundColor: INK,
    borderRadius:    28,
    paddingVertical: 14,
    alignItems:      'center',
    marginTop:       24,
    marginBottom:    40,
  },
  createButtonText: {
    color:      PAPER,
    fontWeight: '700',
    fontSize:   15,
  },
});
