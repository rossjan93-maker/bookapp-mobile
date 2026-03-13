import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';

type InboxItem = {
  id: string;
  status: string;
  book_id: string;
  sender: { username: string } | null;
  book: { title: string; author: string } | null;
};

export default function InboxScreen() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

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
          'id, status, book_id, sender:profiles!recommendations_from_user_id_fkey(username), book:books(title, author)'
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
    } else {
      const { data: newUserBook, error: insertError } = await supabase
        .from('user_books')
        .insert({
          user_id: currentUserId,
          book_id: item.book_id,
          status: 'want_to_read',
        })
        .select('id')
        .single();

      if (insertError || !newUserBook) {
        setError(insertError ? `User book insert failed: ${insertError.message}` : 'User book insert failed.');
        setSavingId(null);
        return;
      }

      userBookId = newUserBook.id;
    }

    const { error: recUpdateError } = await supabase
      .from('recommendations')
      .update({
        status: 'saved',
        user_book_id: userBookId,
      })
      .eq('id', item.id);

    if (recUpdateError) {
      setError(`Recommendation update failed: ${recUpdateError.message}`);
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
      setError(`Activity insert failed: ${activityError.message}`);
      setSavingId(null);
      return;
    }

    setItems(prev =>
      prev.map(r => r.id === item.id ? { ...r, status: 'saved' } : r)
    );
    setSavingId(null);
  }

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <Text style={{ color: '#c00', textAlign: 'center' }}>{error}</Text>
      </View>
    );
  }

  const newItems      = items.filter(r => r.status === 'sent');
  const savedItems    = items.filter(r => r.status === 'saved');
  const readingItems  = items.filter(r => r.status === 'started');
  const doneItems     = items.filter(r => r.status === 'finished' || r.status === 'dnf');

  const totalItems = items.length;

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      {totalItems === 0 && (
        <View style={{ alignItems: 'center', marginTop: 60 }}>
          <Text style={{ color: '#999' }}>No recommendations yet.</Text>
        </View>
      )}

      {/* ── New ── */}
      {newItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <Text style={{ fontWeight: '700', fontSize: 13, color: '#999', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' }}>
            New
          </Text>
          {newItems.map(item => (
            <View
              key={item.id}
              style={{
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: '#eee',
              }}
            >
              <Text style={{ fontWeight: '600', marginBottom: 2 }}>
                {item.book?.title ?? '—'}
              </Text>
              <Text style={{ color: '#555', fontSize: 13, marginBottom: 2 }}>
                {item.book?.author ?? '—'}
              </Text>
              <Text style={{ color: '#999', fontSize: 12, marginBottom: 10 }}>
                from {item.sender?.username ?? 'unknown'}
              </Text>
              <TouchableOpacity
                onPress={() => handleSave(item)}
                disabled={savingId !== null}
                style={{
                  alignSelf: 'flex-start',
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: savingId === item.id ? '#999' : '#000',
                  borderRadius: 6,
                }}
              >
                {savingId === item.id ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={{ color: '#fff', fontSize: 13 }}>Save to Want to Read</Text>
                )}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* ── Saved / Want to Read ── */}
      {savedItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <Text style={{ fontWeight: '700', fontSize: 13, color: '#999', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' }}>
            Saved / Want to Read
          </Text>
          {savedItems.map(item => (
            <RecRow key={item.id} item={item} statusLabel="Saved" />
          ))}
        </View>
      )}

      {/* ── Reading ── */}
      {readingItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <Text style={{ fontWeight: '700', fontSize: 13, color: '#999', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' }}>
            Reading
          </Text>
          {readingItems.map(item => (
            <RecRow key={item.id} item={item} statusLabel="Reading" />
          ))}
        </View>
      )}

      {/* ── Finished / DNF ── */}
      {doneItems.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <Text style={{ fontWeight: '700', fontSize: 13, color: '#999', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' }}>
            Finished / DNF
          </Text>
          {doneItems.map(item => (
            <RecRow
              key={item.id}
              item={item}
              statusLabel={item.status === 'finished' ? 'Finished' : 'DNF'}
              statusColor={item.status === 'finished' ? '#080' : '#c00'}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function RecRow({
  item,
  statusLabel,
  statusColor = '#555',
}: {
  item: InboxItem;
  statusLabel: string;
  statusColor?: string;
}) {
  return (
    <View
      style={{
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
      }}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={{ fontWeight: '500', marginBottom: 2 }}>
          {item.book?.title ?? '—'}
        </Text>
        <Text style={{ color: '#555', fontSize: 13, marginBottom: 2 }}>
          {item.book?.author ?? '—'}
        </Text>
        <Text style={{ color: '#999', fontSize: 12 }}>
          from {item.sender?.username ?? 'unknown'}
        </Text>
      </View>
      <Text
        style={{
          fontSize: 11,
          color: statusColor,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderWidth: 1,
          borderColor: statusColor,
          borderRadius: 4,
          alignSelf: 'flex-start',
        }}
      >
        {statusLabel}
      </Text>
    </View>
  );
}
