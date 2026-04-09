import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { showToast } from '../../lib/toast';
import { registerCacheClearer } from '../../lib/tabCache';
import { BadgeContext } from './_layout';
import { getFirstName } from '../../lib/displayName';
import { CoverThumb } from '../../components/CoverThumb';
import { registerWtTarget, useWalkthrough } from '../../lib/walkthroughEngine';
import { WtDemoInbox } from '../../components/walkthrough/WtDemoInbox';
import { InboxScreenSkeleton } from '../../components/Placeholder';

// ─── Types ────────────────────────────────────────────────────────────────────

type InboxItem = {
  id: string;
  status: string;
  book_id: string;
  note: string | null;
  sender: { username: string; first_name: string | null; last_name: string | null } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusLabel(status: string): string | null {
  switch (status) {
    case 'saved':    return 'Want to Read';
    case 'started':  return 'Reading';
    case 'finished': return 'Finished';
    case 'dnf':      return 'Did Not Finish';
    default:         return null;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14, gap: 8 }}>
      <View style={{ width: 14, height: 1.5, backgroundColor: '#7b9e7e', borderRadius: 1 }} />
      <Text style={{
        fontSize: 10.5,
        fontWeight: '700',
        color: '#9e958d',
        letterSpacing: 1.1,
        textTransform: 'uppercase',
      }}>
        {children}
      </Text>
    </View>
  );
}

function Divider() {
  return <View style={{ height: 1, backgroundColor: '#ede9e4', marginBottom: 24, marginTop: 4 }} />;
}

// ─── Module-level session cache ───────────────────────────────────────────────

type InboxSnapshot = {
  userId:    string;
  items:     InboxItem[];
  fetchedAt: number;
};

let _inboxCache: InboxSnapshot | null = null;
const INBOX_STALE_MS = 30_000; // inbox is more time-sensitive than home/library
registerCacheClearer(() => { _inboxCache = null; });

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { setNewRecCount } = useContext(BadgeContext);

  const [currentUserId, setCurrentUserId] = useState<string | null>(() => _inboxCache?.userId ?? null);
  const [items, setItems]                 = useState<InboxItem[]>(() => _inboxCache?.items ?? []);
  // loading is true only on a cold start with no cached data
  const [loading, setLoading]             = useState<boolean>(() => !_inboxCache);
  const [error, setError]                 = useState<string | null>(null);
  const [savingId, setSavingId]           = useState<string | null>(null);
  const [refreshing, setRefreshing]       = useState(false);

  // ── Walkthrough target measurement ──────────────────────────────────────────
  // Register the inbox primary content area once loading completes.

  const { wtStep } = useWalkthrough();
  const inboxTargetRef = useRef<any>(null);

  function measureInboxContent() {
    inboxTargetRef.current?.measureInWindow((x: number, y: number, w: number, h: number) => {
      if (w > 0 && h > 0) {
        registerWtTarget('inbox_content', { x, y, width: w, height: h });
      }
    });
  }

  useEffect(() => {
    if (loading || wtStep !== 'inbox') return;
    const t = setTimeout(measureInboxContent, 120);
    return () => clearTimeout(t);
  }, [loading, wtStep]);

  useEffect(() => {
    const count = items.filter(r => r.status === 'sent').length;
    setNewRecCount(count);
  }, [items]);

  async function loadNotes() {
    if (!supabase) {
      setError('Supabase not configured.');
      setLoading(false);
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setError('No signed-in user.');
      setLoading(false);
      return;
    }
    // Belt-and-suspenders: clear stale cache if the user switched accounts
    if (_inboxCache && _inboxCache.userId !== user.id) _inboxCache = null;
    setCurrentUserId(user.id);

    const { data, error: dbError } = await supabase
      .from('recommendations')
      .select(
        'id, status, book_id, note, sender:profiles!recommendations_from_user_id_fkey(username, first_name, last_name), book:books(title, author, cover_url, external_id)'
      )
      .eq('to_user_id', user.id)
      .order('created_at', { ascending: false });

    if (dbError) {
      setError('Could not load inbox.');
    } else {
      const rows = (data as InboxItem[]) ?? [];
      setItems(rows);
      _inboxCache = { userId: user.id, items: rows, fetchedAt: Date.now() };
    }
    setLoading(false);
  }

  useFocusEffect(useCallback(() => {
    // Inbox is time-sensitive (new recs arrive): stale window is shorter than home/library
    if (_inboxCache && Date.now() - _inboxCache.fetchedAt < INBOX_STALE_MS) return;
    loadNotes();
  }, []));

  // ── Save handler (logic unchanged) ────────────────────────────────────────

  async function handleSave(item: InboxItem) {
    if (!supabase || !currentUserId) return;
    setSavingId(item.id);
    setError(null);

    const { data: existing } = await supabase
      .from('user_books')
      .select('id')
      .eq('user_id', currentUserId)
      .eq('book_id', item.book_id)
      .maybeSingle();

    let userBookId: string;

    if (existing) {
      userBookId = existing.id;
      supabase.from('user_books').update({ source: 'recommendation' }).eq('id', existing.id).then(() => {});
    } else {
      let insertResult = await supabase
        .from('user_books')
        .insert({ user_id: currentUserId, book_id: item.book_id, status: 'want_to_read', source: 'recommendation' })
        .select('id')
        .single();

      if (insertResult.error) {
        insertResult = await supabase
          .from('user_books')
          .insert({ user_id: currentUserId, book_id: item.book_id, status: 'want_to_read' })
          .select('id')
          .single();
      }

      if (insertResult.error || !insertResult.data) {
        setError('Could not save. Please try again.');
        setSavingId(null);
        return;
      }
      userBookId = insertResult.data.id;
    }

    const { error: recUpdateError } = await supabase
      .from('recommendations')
      .update({ status: 'saved', user_book_id: userBookId })
      .eq('id', item.id);

    if (recUpdateError) {
      setError('Could not save. Please try again.');
      setSavingId(null);
      return;
    }

    const { error: activityError } = await supabase
      .from('activity_events')
      .insert({
        actor_id: currentUserId,
        event_type: 'recommendation_saved',
        book_id: item.book_id,
        recommendation_id: item.id,
      });

    if (activityError) console.warn('Activity insert failed:', activityError.message);

    setItems(prev => prev.map(r => r.id === item.id ? { ...r, status: 'saved' } : r));
    setSavingId(null);
    showToast('Saved to your library');
  }

  function goToDetail(item: InboxItem) {
    router.push({
      pathname: '/book/[id]',
      params: {
        id: item.book_id,
        title: item.book?.title ?? '',
        author: item.book?.author ?? '',
        coverUrl: item.book?.cover_url ?? '',
        externalId: item.book?.external_id ?? '',
        status: item.status,
        note: item.note ?? '',
        fromUser: getFirstName(item.sender),
      },
    });
  }

  // ── Loading / error states ────────────────────────────────────────────────

  if (loading) {
    return <InboxScreenSkeleton />;
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14, marginBottom: 18 }}>{error}</Text>
        <TouchableOpacity
          onPress={() => { setError(null); setLoading(true); loadNotes(); }}
          style={{ backgroundColor: '#231f1b', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 24 }}
        >
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Grouping ──────────────────────────────────────────────────────────────

  const newItems      = items.filter(r => r.status === 'sent');
  const savedItems    = items.filter(r => r.status === 'saved');
  const readingItems  = items.filter(r => r.status === 'started');
  const finishedItems = items.filter(r => r.status === 'finished');
  const dnfItems      = items.filter(r => r.status === 'dnf');

  const hasArchive    = savedItems.length > 0 || readingItems.length > 0 || finishedItems.length > 0 || dnfItems.length > 0;

  // ── Empty state ───────────────────────────────────────────────────────────

  async function handleRefresh() {
    setRefreshing(true);
    await loadNotes();
    setRefreshing(false);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (wtStep === 'inbox') return <WtDemoInbox />;

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
    <ScrollView
      style={{ flex: 1, backgroundColor: '#f5f1ec' }}
      contentContainerStyle={
        items.length === 0
          ? { flex: 1, paddingHorizontal: 20, paddingTop: insets.top + 8 }
          : { paddingHorizontal: 20, paddingTop: insets.top + 8, paddingBottom: 40 }
      }
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
      }
    >
      {/* ── Hero header ── */}
      <View style={{ marginBottom: 28 }}>
        <Text style={{
          fontSize: 32,
          fontWeight: '800',
          color: '#231f1b',
          letterSpacing: -1,
          lineHeight: 38,
        }}>Inbox</Text>
        <Text style={{ fontSize: 12, color: '#9e958d', fontWeight: '500', marginTop: 3 }}>
          {items.length > 0 ? `${items.length} rec${items.length === 1 ? '' : 's'} from friends` : 'Recs from friends'}
        </Text>
        <View style={{ width: 28, height: 2.5, backgroundColor: '#7b9e7e', marginTop: 10, borderRadius: 2 }} />
      </View>

      {items.length === 0 && (
        <>
          <Text style={{ fontSize: 14, color: '#9e958d', marginBottom: 12 }}>
            Your recommendations from friends
          </Text>
          {/* Flex wrapper keeps the card vertically centred; the ref is on the
              specific white card so measureInWindow returns a human-sized rect
              (not a full-screen flex container that would make the spotlight
              cover the entire screen). */}
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 0, paddingTop: 40 }}>
            <View
              ref={inboxTargetRef}
              onLayout={measureInboxContent}
              style={{
                width: '100%',
                backgroundColor: '#fefcf9',
                borderRadius: 16,
                padding: 28,
                alignItems: 'center',
                shadowColor: '#000',
                shadowOpacity: 0.05,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
                elevation: 2,
                borderWidth: 1,
                borderColor: '#ede9e4',
              }}
            >
              <Text style={{ fontSize: 17, fontWeight: '700', color: '#231f1b', marginBottom: 8, textAlign: 'center' }}>
                Nothing here yet
              </Text>
              <Text style={{ color: '#9e958d', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 20 }}>
                When a friend recommends a book,{'\n'}it will show up here.
              </Text>
              <TouchableOpacity
                onPress={() => router.push('/(tabs)/')}
                style={{
                  backgroundColor: '#231f1b',
                  borderRadius: 10,
                  paddingVertical: 11,
                  paddingHorizontal: 22,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Find friends</Text>
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

      {/* ── Header ── */}
      {items.length > 0 && (
      <View style={{ marginBottom: 20 }}>
        <Text style={{ fontSize: 14, color: '#9e958d' }}>
          {newItems.length > 0
            ? `${newItems.length} ${newItems.length === 1 ? 'book' : 'books'} waiting for you`
            : 'All caught up'}
        </Text>
      </View>
      )}

      {/* ── New ── */}
      {newItems.length > 0 && (
        <View ref={inboxTargetRef} style={{ marginBottom: 28 }} onLayout={measureInboxContent}>
          <SectionLabel>{`New · ${newItems.length}`}</SectionLabel>
          {newItems.map(item => (
            <View
              key={item.id}
              style={{
                backgroundColor: '#fefcf9',
                borderRadius: 14,
                borderLeftWidth: 3,
                borderLeftColor: '#d4a574',
                padding: 16,
                marginBottom: 10,
                shadowColor: '#000',
                shadowOpacity: 0.04,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 1 },
                elevation: 1,
              }}
            >
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => goToDetail(item)}
                style={{ marginBottom: 14 }}
              >
                <Text style={{
                  fontSize: 10,
                  fontWeight: '700',
                  color: '#b8860b',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  marginBottom: 10,
                }}>
                  From {getFirstName(item.sender)}
                </Text>
                <View style={{ flexDirection: 'row' }}>
                  <CoverThumb
                    url={item.book?.cover_url}
                    externalId={item.book?.external_id}
                    title={item.book?.title}
                    width={48}
                    height={70}
                  />
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={{ fontWeight: '700', fontSize: 16, color: '#231f1b', lineHeight: 22, marginBottom: 3 }}>
                      {item.book?.title ?? '—'}
                    </Text>
                    <Text style={{ color: '#78716c', fontSize: 13 }}>
                      {item.book?.author ?? '—'}
                    </Text>
                  </View>
                </View>
                {item.note ? (
                  <View style={{
                    backgroundColor: '#fffbf2',
                    borderTopWidth: 1,
                    borderTopColor: '#ede9e4',
                    marginTop: 12,
                    paddingTop: 10,
                    paddingHorizontal: 10,
                    paddingBottom: 8,
                    borderRadius: 6,
                  }}>
                    <Text style={{ fontSize: 13, color: '#57534e', fontStyle: 'italic', lineHeight: 20 }}>
                      "{item.note}"
                    </Text>
                  </View>
                ) : null}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleSave(item)}
                disabled={savingId !== null}
                style={{
                  alignSelf: 'flex-start',
                  paddingHorizontal: 16,
                  paddingVertical: 9,
                  backgroundColor: savingId === item.id ? '#ede9e4' : '#231f1b',
                  borderRadius: 8,
                }}
              >
                {savingId === item.id ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Add to Library</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* ── Divider between actionable and archival ── */}
      {newItems.length > 0 && hasArchive && <Divider />}

      {/* ── Want to Read ── */}
      {savedItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>{`Want to Read · ${savedItems.length}`}</SectionLabel>
          {savedItems.map(item => (
            <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
          ))}
        </View>
      )}

      {/* ── Reading ── */}
      {readingItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>{`Reading · ${readingItems.length}`}</SectionLabel>
          {readingItems.map(item => (
            <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
          ))}
        </View>
      )}

      {/* ── Finished ── */}
      {finishedItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>{`Finished · ${finishedItems.length}`}</SectionLabel>
          {finishedItems.map(item => (
            <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
          ))}
        </View>
      )}

      {/* ── DNF ── */}
      {dnfItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>{`Did Not Finish · ${dnfItems.length}`}</SectionLabel>
          {dnfItems.map(item => (
            <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
          ))}
        </View>
      )}
    </ScrollView>
    </View>
  );
}

// ─── RecRow — archival secondary rows ────────────────────────────────────────

function RecRow({ item, onPress }: { item: InboxItem; onPress: () => void }) {
  const chip = statusLabel(item.status);
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={{
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: '#ede9e4',
        flexDirection: 'row',
        alignItems: 'flex-start',
      }}
    >
      <CoverThumb
        url={item.book?.cover_url}
        externalId={item.book?.external_id}
        title={item.book?.title}
        width={40}
        height={58}
      />
      <View style={{ flex: 1, marginLeft: 14 }}>
        <Text style={{ fontWeight: '700', fontSize: 15, color: '#231f1b', marginBottom: 2, lineHeight: 21 }}>
          {item.book?.title ?? '—'}
        </Text>
        <Text style={{ color: '#78716c', fontSize: 13, marginBottom: 3 }}>
          {item.book?.author ?? '—'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: '#9e958d', fontSize: 12 }}>
            from {getFirstName(item.sender)}
          </Text>
          {chip && (
            <View style={{
              backgroundColor: '#ede9e4',
              borderRadius: 8,
              paddingHorizontal: 7,
              paddingVertical: 2,
            }}>
              <Text style={{ fontSize: 11, color: '#78716c' }}>{chip}</Text>
            </View>
          )}
        </View>
        {item.note ? (
          <Text style={{ fontSize: 13, color: '#78716c', fontStyle: 'italic', marginTop: 6, lineHeight: 19 }}>
            "{item.note}"
          </Text>
        ) : null}
      </View>
      <Text style={{ fontSize: 16, color: '#ede9e4', marginTop: 2, marginLeft: 8 }}>›</Text>
    </TouchableOpacity>
  );
}
