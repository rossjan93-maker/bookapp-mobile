import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';

type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

type UserBook = {
  id: string;
  book_id: string;
  status: UserBookStatus;
  started_at: string | null;
  finished_at: string | null;
  book: { title: string; author: string } | null;
};

const STATUS_LABELS: Record<UserBookStatus, string> = {
  want_to_read: 'Want to Read',
  reading: 'Reading',
  finished: 'Finished',
  dnf: 'DNF',
};

export default function LibraryScreen() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [items, setItems] = useState<UserBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

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
        .from('user_books')
        .select('id, book_id, status, started_at, finished_at, book:books(title, author)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (dbError) {
        setError('Could not load library.');
      } else {
        setItems((data as UserBook[]) ?? []);
      }
      setLoading(false);
    }

    load();
  }, []));

  async function handleUpdateStatus(userBook: UserBook, newStatus: UserBookStatus) {
    if (!supabase || !currentUserId) return;
    setUpdatingId(userBook.id);

    const now = new Date().toISOString();

    const userBookUpdate: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'reading') userBookUpdate.started_at = now;
    if (newStatus === 'finished' || newStatus === 'dnf') userBookUpdate.finished_at = now;

    const { error: updateError } = await supabase
      .from('user_books')
      .update(userBookUpdate)
      .eq('id', userBook.id);

    if (updateError) {
      setError('Could not update status. Please try again.');
      setUpdatingId(null);
      return;
    }

    // update linked recommendation if one exists
    const { data: rec } = await supabase
      .from('recommendations')
      .select('id, from_user_id, to_user_id, book_id')
      .eq('user_book_id', userBook.id)
      .maybeSingle();

    if (rec) {
      const recStatusMap: Record<UserBookStatus, string> = {
        want_to_read: 'saved',
        reading: 'started',
        finished: 'finished',
        dnf: 'dnf',
      };
      const recUpdate: Record<string, unknown> = { status: recStatusMap[newStatus] };
      if (newStatus === 'finished' || newStatus === 'dnf') recUpdate.resolved_at = now;
      const { error: recUpdateError } = await supabase
        .from('recommendations')
        .update(recUpdate)
        .eq('id', rec.id);

      if (!recUpdateError && newStatus === 'finished') {
        const { data: existingEvent } = await supabase
          .from('credibility_events')
          .select('id')
          .eq('recommendation_id', rec.id)
          .maybeSingle();

        if (!existingEvent) {
          await supabase.from('credibility_events').insert({
            recommendation_id: rec.id,
            from_user_id: rec.from_user_id,
            to_user_id: rec.to_user_id,
            book_id: rec.book_id,
          });
        }
      }

      // activity event for recommendation path — only if rec update succeeded
      if (!recUpdateError) {
        if (newStatus === 'reading') {
          const { error: activityError } = await supabase.from('activity_events').insert({
            actor_id: currentUserId,
            event_type: 'recommendation_started',
            book_id: rec.book_id,
            recommendation_id: rec.id,
          });
          if (activityError) {
            console.warn('Activity insert failed:', activityError.message);
          }
        } else if (newStatus === 'finished') {
          const { error: activityError } = await supabase.from('activity_events').insert({
            actor_id: currentUserId,
            event_type: 'recommendation_finished',
            book_id: rec.book_id,
            recommendation_id: rec.id,
          });
          if (activityError) {
            console.warn('Activity insert failed:', activityError.message);
          }
        }
      }
    } else if (newStatus === 'finished') {
      // activity event for non-recommendation finished book
      const { error: activityError } = await supabase.from('activity_events').insert({
        actor_id: currentUserId,
        event_type: 'book_finished',
        book_id: userBook.book_id,
      });
      if (activityError) {
        console.warn('Activity insert failed:', activityError.message);
      }
    }

    setItems(prev =>
      prev.map(item =>
        item.id === userBook.id
          ? {
              ...item,
              status: newStatus,
              started_at: newStatus === 'reading' ? now : item.started_at,
              finished_at:
                newStatus === 'finished' || newStatus === 'dnf' ? now : item.finished_at,
            }
          : item
      )
    );
    setUpdatingId(null);
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
        renderItem={({ item }) => {
          const isUpdating = updatingId === item.id;
          const isBlocked = updatingId !== null;

          return (
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
              <Text style={{ color: '#555', fontSize: 13, marginBottom: 6 }}>
                {item.book?.author ?? '—'}
              </Text>
              <Text style={{ color: '#999', fontSize: 12, marginBottom: 10 }}>
                {STATUS_LABELS[item.status]}
              </Text>

              {isUpdating ? (
                <ActivityIndicator style={{ alignSelf: 'flex-start' }} />
              ) : item.status === 'want_to_read' ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <StatusButton
                    label="Mark Reading"
                    onPress={() => handleUpdateStatus(item, 'reading')}
                    disabled={isBlocked}
                  />
                  <StatusButton
                    label="Mark Finished"
                    onPress={() => handleUpdateStatus(item, 'finished')}
                    disabled={isBlocked}
                  />
                  <StatusButton
                    label="DNF"
                    onPress={() => handleUpdateStatus(item, 'dnf')}
                    disabled={isBlocked}
                  />
                </View>
              ) : item.status === 'reading' ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <StatusButton
                    label="Mark Finished"
                    onPress={() => handleUpdateStatus(item, 'finished')}
                    disabled={isBlocked}
                  />
                  <StatusButton
                    label="DNF"
                    onPress={() => handleUpdateStatus(item, 'dnf')}
                    disabled={isBlocked}
                  />
                </View>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', marginTop: 60 }}>
            <Text style={{ color: '#999' }}>Your library is empty.</Text>
          </View>
        }
      />
    </View>
  );
}

function StatusButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: disabled ? '#ccc' : '#000',
        borderRadius: 6,
      }}
    >
      <Text style={{ fontSize: 12, color: disabled ? '#ccc' : '#000' }}>{label}</Text>
    </TouchableOpacity>
  );
}
