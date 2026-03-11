import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { supabase } from '../../lib/supabase';

type InboxItem = {
  id: string;
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

  useEffect(() => {
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
        .select('id, book_id, sender:profiles!recommendations_from_user_id_fkey(username), book:books(title, author)')
        .eq('to_user_id', user.id)
        .eq('status', 'sent')
        .order('created_at', { ascending: false });

      if (dbError) {
        setError('Could not load inbox.');
      } else {
        setItems((data as InboxItem[]) ?? []);
      }
      setLoading(false);
    }

    load();
  }, []);

  async function handleSave(item: InboxItem) {
    if (!supabase || !currentUserId) return;
    setSavingId(item.id);

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
        .insert({ user_id: currentUserId, book_id: item.book_id, status: 'want_to_read' })
        .select('id')
        .single();

      if (insertError || !newUserBook) {
        setSavingId(null);
        return;
      }

      userBookId = newUserBook.id;
    }

    await supabase
      .from('recommendations')
      .update({ status: 'saved', user_book_id: userBookId })
      .eq('id', item.id);

    setItems(prev => prev.filter(r => r.id !== item.id));
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
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#c00' }}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <FlatList
        data={items}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View
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
        )}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', marginTop: 60 }}>
            <Text style={{ color: '#999' }}>No recommendations yet.</Text>
          </View>
        }
      />
    </View>
  );
}
