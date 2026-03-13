import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';

type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

type UserBook = {
  id: string;
  book_id: string;
  status: UserBookStatus;
  started_at: string | null;
  finished_at: string | null;
  book: { title: string; author: string; cover_url: string | null } | null;
};

const STATUS_LABELS: Record<UserBookStatus, string> = {
  want_to_read: 'Want to Read',
  reading: 'Reading',
  finished: 'Finished',
  dnf: 'DNF',
};

const STATUS_BADGE: Record<UserBookStatus, { bg: string; text: string }> = {
  want_to_read: { bg: '#f1f5f9', text: '#475569' },
  reading:      { bg: '#dbeafe', text: '#1d4ed8' },
  finished:     { bg: '#dcfce7', text: '#15803d' },
  dnf:          { bg: '#fee2e2', text: '#b91c1c' },
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
        .select('id, book_id, status, started_at, finished_at, book:books(title, author, cover_url)')
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
        <ActivityIndicator color="#111827" />
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

  return (
    <FlatList
      data={items}
      keyExtractor={item => item.id}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32 }}
      renderItem={({ item }) => {
        const isUpdating = updatingId === item.id;
        const isBlocked = updatingId !== null;
        const badge = STATUS_BADGE[item.status];

        return (
          <View
            style={{
              paddingVertical: 16,
              borderBottomWidth: 1,
              borderBottomColor: '#f3f4f6',
              flexDirection: 'row',
              alignItems: 'flex-start',
            }}
          >
            <CoverThumb url={item.book?.cover_url} width={40} height={58} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <View style={{ flex: 1, marginRight: 10 }}>
                  <Text style={{ fontWeight: '600', fontSize: 15, color: '#111827', marginBottom: 3 }}>
                    {item.book?.title ?? '—'}
                  </Text>
                  <Text style={{ color: '#6b7280', fontSize: 13 }}>
                    {item.book?.author ?? '—'}
                  </Text>
                </View>
                <View style={{ backgroundColor: badge.bg, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 4, alignSelf: 'flex-start' }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: badge.text }}>
                    {STATUS_LABELS[item.status]}
                  </Text>
                </View>
              </View>

              {isUpdating ? (
                <ActivityIndicator color="#111827" style={{ alignSelf: 'flex-start', marginTop: 4 }} />
              ) : item.status === 'want_to_read' ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <PrimaryButton
                    label="Start Reading"
                    onPress={() => handleUpdateStatus(item, 'reading')}
                    disabled={isBlocked}
                  />
                  <OutlineButton
                    label="Mark Finished"
                    onPress={() => handleUpdateStatus(item, 'finished')}
                    disabled={isBlocked}
                  />
                  <DangerButton
                    label="DNF"
                    onPress={() => handleUpdateStatus(item, 'dnf')}
                    disabled={isBlocked}
                  />
                </View>
              ) : item.status === 'reading' ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <PrimaryButton
                    label="Mark Finished"
                    onPress={() => handleUpdateStatus(item, 'finished')}
                    disabled={isBlocked}
                  />
                  <DangerButton
                    label="DNF"
                    onPress={() => handleUpdateStatus(item, 'dnf')}
                    disabled={isBlocked}
                  />
                </View>
              ) : null}
            </View>
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={{ alignItems: 'center', marginTop: 60, paddingHorizontal: 24 }}>
          <Text style={{ color: '#9ca3af', fontSize: 14, textAlign: 'center', lineHeight: 22 }}>
            Your library is empty.{'\n'}Books you save from recommendations{'\n'}will appear here.
          </Text>
        </View>
      }
    />
  );
}

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 7,
        backgroundColor: disabled ? '#e5e7eb' : '#111827',
        borderRadius: 8,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: '500', color: disabled ? '#9ca3af' : '#fff' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function OutlineButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderWidth: 1,
        borderColor: disabled ? '#e5e7eb' : '#d1d5db',
        borderRadius: 8,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: '500', color: disabled ? '#9ca3af' : '#374151' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function DangerButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderWidth: 1,
        borderColor: disabled ? '#e5e7eb' : '#fca5a5',
        borderRadius: 8,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: '500', color: disabled ? '#9ca3af' : '#b91c1c' }}>{label}</Text>
    </TouchableOpacity>
  );
}
