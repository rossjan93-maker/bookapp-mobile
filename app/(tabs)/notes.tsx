import { useCallback, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { BadgeContext } from './_layout';
import { CoverThumb } from '../../components/CoverThumb';

type InboxItem = {
  id: string;
  status: string;
  book_id: string;
  note: string | null;
  sender: { username: string } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

const BADGE: Record<string, { bg: string; text: string; label: string }> = {
  sent:     { bg: '#f1f5f9', text: '#475569', label: 'New'           },
  saved:    { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read'  },
  started:  { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'       },
  finished: { bg: '#dcfce7', text: '#15803d', label: 'Finished'      },
  dnf:      { bg: '#fee2e2', text: '#b91c1c', label: 'Did Not Finish' },
};

function StatusPill({ status }: { status: string }) {
  const b = BADGE[status] ?? { bg: '#f1f5f9', text: '#475569', label: status };
  return (
    <View style={{ backgroundColor: b.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ fontSize: 11, fontWeight: '600', color: b.text }}>{b.label}</Text>
    </View>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#a8a29e',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 12,
    }}>
      {children}
    </Text>
  );
}

export default function InboxScreen() {
  const router = useRouter();
  const { setNewRecCount } = useContext(BadgeContext);

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    const count = items.filter(r => r.status === 'sent').length;
    setNewRecCount(count);
  }, [items]);

  useFocusEffect(useCallback(() => {
    async function load() {
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

      setCurrentUserId(user.id);

      const { data, error: dbError } = await supabase
        .from('recommendations')
        .select(
          'id, status, book_id, note, sender:profiles!recommendations_from_user_id_fkey(username), book:books(title, author, cover_url, external_id)'
        )
        .eq('to_user_id', user.id)
        .order('created_at', { ascending: false });

      if (dbError) {
        setError('Could not load inbox.');
      } else {
        setItems((data as InboxItem[]) ?? []);
      }

      setLoading(false);
    }

    load();
  }, []));

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
      supabase
        .from('user_books')
        .update({ source: 'recommendation' })
        .eq('id', existing.id)
        .then(() => {});
    } else {
      let insertResult = await supabase
        .from('user_books')
        .insert({
          user_id: currentUserId,
          book_id: item.book_id,
          status: 'want_to_read',
          source: 'recommendation',
        })
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
      .update({
        status: 'saved',
        user_book_id: userBookId,
      })
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

    if (activityError) {
      console.warn('Activity insert failed:', activityError.message);
    }

    setItems(prev =>
      prev.map(r => r.id === item.id ? { ...r, status: 'saved' } : r)
    );
    setSavingId(null);
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
        fromUser: item.sender?.username ?? '',
      },
    });
  }

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#a8a29e" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14 }}>{error}</Text>
      </View>
    );
  }

  const newItems     = items.filter(r => r.status === 'sent');
  const savedItems   = items.filter(r => r.status === 'saved');
  const readingItems = items.filter(r => r.status === 'started');
  const doneItems    = items.filter(r => r.status === 'finished' || r.status === 'dnf');

  if (items.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Text style={{ color: '#a8a29e', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
          No recommendations yet.{'\n'}Ask a friend to send you a book.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32 }}>

      {/* ── New summary banner ── */}
      {newItems.length > 0 && (
        <View style={{
          backgroundColor: '#f0f9ff',
          borderRadius: 10,
          borderWidth: 1,
          borderColor: '#e0f2fe',
          paddingHorizontal: 16,
          paddingVertical: 12,
          marginBottom: 20,
        }}>
          <Text style={{ fontSize: 14, color: '#0369a1', fontWeight: '500' }}>
            {newItems.length === 1
              ? 'You have 1 new recommendation.'
              : `You have ${newItems.length} new recommendations.`}
          </Text>
        </View>
      )}

      {/* ── New ── */}
      {newItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>{`New (${newItems.length})`}</SectionLabel>
          {newItems.map(item => (
            <View
              key={item.id}
              style={{
                backgroundColor: '#fff',
                borderRadius: 14,
                borderWidth: 1,
                borderColor: '#e7e5e4',
                padding: 16,
                marginBottom: 10,
              }}
            >
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => goToDetail(item)}
                style={{ flexDirection: 'row', marginBottom: 14 }}
              >
                <CoverThumb
                  url={item.book?.cover_url}
                  externalId={item.book?.external_id}
                  width={48}
                  height={70}
                />
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <Text style={{ fontWeight: '700', fontSize: 16, color: '#1c1917', marginBottom: 3 }}>
                    {item.book?.title ?? '—'}
                  </Text>
                  <Text style={{ color: '#78716c', fontSize: 13, marginBottom: 2 }}>
                    {item.book?.author ?? '—'}
                  </Text>
                  <Text style={{ color: '#a8a29e', fontSize: 12 }}>
                    from {item.sender?.username ?? 'unknown'}
                  </Text>
                  {item.note ? (
                    <Text style={{ fontSize: 13, color: '#57534e', fontStyle: 'italic', marginTop: 6 }}>
                      "{item.note}"
                    </Text>
                  ) : null}
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleSave(item)}
                disabled={savingId !== null}
                style={{
                  alignSelf: 'flex-start',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  backgroundColor: savingId === item.id ? '#a8a29e' : '#1c1917',
                  borderRadius: 8,
                }}
              >
                {savingId === item.id ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Add to Library</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* ── Want to Read ── */}
      {savedItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>Want to Read</SectionLabel>
          {savedItems.map(item => (
            <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
          ))}
        </View>
      )}

      {/* ── Reading ── */}
      {readingItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>Reading</SectionLabel>
          {readingItems.map(item => (
            <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
          ))}
        </View>
      )}

      {/* ── Done ── */}
      {doneItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <SectionLabel>Done</SectionLabel>
          {doneItems.map(item => (
            <RecRow key={item.id} item={item} onPress={() => goToDetail(item)} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function RecRow({ item, onPress }: { item: InboxItem; onPress: () => void }) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={{
        paddingVertical: 15,
        borderBottomWidth: 1,
        borderBottomColor: '#f5f5f4',
        flexDirection: 'row',
        alignItems: 'flex-start',
      }}
    >
      <CoverThumb
        url={item.book?.cover_url}
        externalId={item.book?.external_id}
        width={40}
        height={58}
      />
      <View style={{ flex: 1, marginLeft: 14, marginRight: 10 }}>
        <Text style={{ fontWeight: '700', fontSize: 15, color: '#1c1917', marginBottom: 2 }}>
          {item.book?.title ?? '—'}
        </Text>
        <Text style={{ color: '#78716c', fontSize: 13, marginBottom: 3 }}>
          {item.book?.author ?? '—'}
        </Text>
        <Text style={{ color: '#a8a29e', fontSize: 12 }}>
          from {item.sender?.username ?? 'unknown'}
        </Text>
        {item.note ? (
          <Text style={{ fontSize: 12, color: '#78716c', fontStyle: 'italic', marginTop: 4 }}>
            "{item.note}"
          </Text>
        ) : null}
      </View>
      <StatusPill status={item.status} />
    </TouchableOpacity>
  );
}
