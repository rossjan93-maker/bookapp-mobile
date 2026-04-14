import { useCallback, useContext, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { showToast } from '../lib/toast';
import { BadgeContext } from '../app/(tabs)/_layout';
import { getFirstName } from '../lib/displayName';
import { CoverThumb } from './CoverThumb';
import { registerCacheClearer } from '../lib/tabCache';

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

// ─── Module-level session cache ───────────────────────────────────────────────

type InboxSnapshot = {
  userId:    string;
  items:     InboxItem[];
  fetchedAt: number;
};

let _sheetCache: InboxSnapshot | null = null;
const SHEET_STALE_MS = 30_000;
registerCacheClearer(() => { _sheetCache = null; });

// ─── Props ────────────────────────────────────────────────────────────────────

type RecsInboxSheetProps = {
  visible:  boolean;
  onClose:  () => void;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function RecsInboxSheet({ visible, onClose }: RecsInboxSheetProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { setNewRecCount } = useContext(BadgeContext);

  const [currentUserId, setCurrentUserId] = useState<string | null>(() => _sheetCache?.userId ?? null);
  const [items, setItems]                 = useState<InboxItem[]>(() => _sheetCache?.items ?? []);
  const [loading, setLoading]             = useState<boolean>(() => !_sheetCache);
  const [error, setError]                 = useState<string | null>(null);
  const [savingId, setSavingId]           = useState<string | null>(null);
  const [refreshing, setRefreshing]       = useState(false);

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
    if (_sheetCache && _sheetCache.userId !== user.id) _sheetCache = null;
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
      _sheetCache = { userId: user.id, items: rows, fetchedAt: Date.now() };
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!visible) return;
    if (_sheetCache && Date.now() - _sheetCache.fetchedAt < SHEET_STALE_MS) {
      supabase?.auth.getUser().then(({ data: { user } }) => {
        if (!user || _sheetCache?.userId !== user.id) {
          _sheetCache = null;
          loadNotes();
        }
      });
      return;
    }
    loadNotes();
  }, [visible]);

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
    onClose();
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

  async function handleRefresh() {
    setRefreshing(true);
    _sheetCache = null;
    await loadNotes();
    setRefreshing(false);
  }

  const newItems      = items.filter(r => r.status === 'sent');
  const savedItems    = items.filter(r => r.status === 'saved');
  const readingItems  = items.filter(r => r.status === 'started');
  const finishedItems = items.filter(r => r.status === 'finished');
  const dnfItems      = items.filter(r => r.status === 'dnf');
  const hasArchive    = savedItems.length > 0 || readingItems.length > 0 || finishedItems.length > 0 || dnfItems.length > 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
        {/* Drag handle */}
        <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 4 }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: '#c4b5a5' }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 40,
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#78716c" />
          }
        >
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
            <View>
              <Text style={{
                fontSize: 28,
                fontWeight: '800',
                color: '#231f1b',
                letterSpacing: -0.8,
                lineHeight: 34,
              }}>Inbox</Text>
              <Text style={{ fontSize: 12, color: '#9e958d', fontWeight: '500', marginTop: 2 }}>
                {items.length > 0 ? `${items.length} rec${items.length === 1 ? '' : 's'} from friends` : 'Recs from friends'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={12}
              style={{
                backgroundColor: '#ede9e4',
                borderRadius: 16,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#6b635c' }}>Done</Text>
            </TouchableOpacity>
          </View>

          {loading && (
            <View style={{ paddingTop: 40, alignItems: 'center' }}>
              <ActivityIndicator size="large" color="#78716c" />
            </View>
          )}

          {error && !loading && (
            <View style={{ alignItems: 'center', paddingTop: 40 }}>
              <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14, marginBottom: 18 }}>{error}</Text>
              <TouchableOpacity
                onPress={() => { setError(null); setLoading(true); loadNotes(); }}
                style={{ backgroundColor: '#231f1b', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 24 }}
              >
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Try again</Text>
              </TouchableOpacity>
            </View>
          )}

          {!loading && !error && items.length === 0 && (
            <View style={{ paddingTop: 60, alignItems: 'center' }}>
              <View style={{
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
              }}>
                <Text style={{ fontSize: 17, fontWeight: '700', color: '#231f1b', marginBottom: 8, textAlign: 'center' }}>
                  Nothing here yet
                </Text>
                <Text style={{ color: '#9e958d', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
                  When a friend recommends a book,{'\n'}it will show up here.
                </Text>
              </View>
            </View>
          )}

          {!loading && !error && items.length > 0 && (
            <>
              <View style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 14, color: '#9e958d' }}>
                  {newItems.length > 0
                    ? `${newItems.length} ${newItems.length === 1 ? 'book' : 'books'} waiting for you`
                    : 'All caught up'}
                </Text>
              </View>

              {/* New */}
              {newItems.length > 0 && (
                <View style={{ marginBottom: 28 }}>
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

              {newItems.length > 0 && hasArchive && <Divider />}

              {savedItems.length > 0 && (
                <View style={{ marginBottom: 28 }}>
                  <SectionLabel>{`Want to Read · ${savedItems.length}`}</SectionLabel>
                  {savedItems.map(item => (
                    <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
                  ))}
                </View>
              )}

              {readingItems.length > 0 && (
                <View style={{ marginBottom: 28 }}>
                  <SectionLabel>{`Reading · ${readingItems.length}`}</SectionLabel>
                  {readingItems.map(item => (
                    <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
                  ))}
                </View>
              )}

              {finishedItems.length > 0 && (
                <View style={{ marginBottom: 28 }}>
                  <SectionLabel>{`Finished · ${finishedItems.length}`}</SectionLabel>
                  {finishedItems.map(item => (
                    <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
                  ))}
                </View>
              )}

              {dnfItems.length > 0 && (
                <View style={{ marginBottom: 28 }}>
                  <SectionLabel>{`Did Not Finish · ${dnfItems.length}`}</SectionLabel>
                  {dnfItems.map(item => (
                    <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
