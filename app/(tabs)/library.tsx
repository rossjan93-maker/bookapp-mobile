import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';

type UserBookStatus = 'want_to_read' | 'reading' | 'finished' | 'dnf';

type UserBook = {
  id: string;
  book_id: string;
  status: UserBookStatus;
  started_at: string | null;
  finished_at: string | null;
  current_page: number | null;
  book: {
    title: string;
    author: string;
    cover_url: string | null;
    external_id: string;
    page_count: number | null;
  } | null;
};

type PendingFeedback = { userBookId: string; status: 'finished' | 'dnf' };

const SENTIMENT_OPTIONS: Array<{ value: 'loved' | 'liked' | 'okay' | 'not_for_me'; label: string }> = [
  { value: 'loved',      label: 'Loved it'    },
  { value: 'liked',      label: 'Liked it'    },
  { value: 'okay',       label: 'Okay'        },
  { value: 'not_for_me', label: 'Not for me'  },
];

const STATUS_LABELS: Record<UserBookStatus, string> = {
  want_to_read: 'Want to Read',
  reading:      'Reading',
  finished:     'Finished',
  dnf:          'DNF',
};

const STATUS_BADGE: Record<UserBookStatus, { bg: string; text: string }> = {
  want_to_read: { bg: '#f1f5f9', text: '#475569' },
  reading:      { bg: '#dbeafe', text: '#1d4ed8' },
  finished:     { bg: '#dcfce7', text: '#15803d' },
  dnf:          { bg: '#fee2e2', text: '#b91c1c' },
};

export default function LibraryScreen() {
  const router = useRouter();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [items, setItems] = useState<UserBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId]       = useState<string | null>(null);
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(null);

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

      // Try with progress columns (requires migration 20260313000001).
      // Falls back to the original query if those columns don't exist yet.
      let result = await supabase
        .from('user_books')
        .select('id, book_id, status, started_at, finished_at, current_page, book:books(title, author, cover_url, external_id, page_count)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (result.error) {
        result = await supabase
          .from('user_books')
          .select('id, book_id, status, started_at, finished_at, book:books(title, author, cover_url, external_id)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
      }

      if (result.error) {
        setError('Could not load library.');
      } else {
        setItems((result.data as unknown as UserBook[]) ?? []);
      }
      setLoading(false);
    }

    load();
  }, []));

  function saveSentiment(userBookId: string, sentiment: string) {
    setPendingFeedback(null);
    if (!supabase) return;
    // Fire-and-forget; sentiment column may not exist until migration is applied
    supabase
      .from('user_books')
      .update({ sentiment })
      .eq('id', userBookId)
      .then(() => {});
  }

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
        reading:      'started',
        finished:     'finished',
        dnf:          'dnf',
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
          await supabase.from('activity_events').insert({
            actor_id: currentUserId,
            event_type: 'recommendation_started',
            book_id: rec.book_id,
            recommendation_id: rec.id,
          });
        } else if (newStatus === 'finished') {
          await supabase.from('activity_events').insert({
            actor_id: currentUserId,
            event_type: 'recommendation_finished',
            book_id: rec.book_id,
            recommendation_id: rec.id,
          });
        }
      }
    } else if (newStatus === 'finished') {
      await supabase.from('activity_events').insert({
        actor_id: currentUserId,
        event_type: 'book_finished',
        book_id: userBook.book_id,
      });
    }

    setItems(prev =>
      prev.map(item =>
        item.id === userBook.id
          ? {
              ...item,
              status: newStatus,
              started_at:  newStatus === 'reading' ? now : item.started_at,
              finished_at: newStatus === 'finished' || newStatus === 'dnf' ? now : item.finished_at,
            }
          : item
      )
    );

    // Prompt for optional sentiment feedback on finish or DNF
    if (newStatus === 'finished' || newStatus === 'dnf') {
      setPendingFeedback({ userBookId: userBook.id, status: newStatus });
    }

    setUpdatingId(null);
  }

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#78716c" />
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
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 0, paddingBottom: 32 }}
      ListHeaderComponent={
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 20,
          paddingBottom: 16,
          borderBottomWidth: items.length > 0 ? 1 : 0,
          borderBottomColor: '#f5f5f4',
          marginBottom: items.length > 0 ? 0 : 4,
        }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: '#1c1917' }}>
            {items.length > 0 ? `${items.length} book${items.length === 1 ? '' : 's'}` : 'My Library'}
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/add-book')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: '#1c1917',
              borderRadius: 8,
              paddingHorizontal: 14,
              paddingVertical: 8,
              gap: 5,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>+ Add Book</Text>
          </TouchableOpacity>
        </View>
      }
      renderItem={({ item }) => {
        const isUpdating = updatingId === item.id;
        const isBlocked  = updatingId !== null;
        const badge      = STATUS_BADGE[item.status];
        const hasButtons = item.status === 'want_to_read' || item.status === 'reading';

        const hasProgress =
          item.status === 'reading' &&
          item.current_page != null && item.current_page > 0 &&
          item.book?.page_count != null && item.book.page_count > 0;
        const progressPct = hasProgress
          ? Math.min(100, Math.round((item.current_page! / item.book!.page_count!) * 100))
          : null;

        const hasSentimentPrompt = pendingFeedback?.userBookId === item.id;
        const hasExtraRow = hasButtons || isUpdating || hasSentimentPrompt;

        return (
          <View style={{ paddingTop: 18, paddingBottom: hasExtraRow ? 14 : 18, borderBottomWidth: 1, borderBottomColor: '#f5f5f4' }}>

            {/* Tappable row: cover + title/author/badge */}
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => router.push({
                pathname: '/book/[id]',
                params: {
                  id: item.book_id,
                  title:      item.book?.title ?? '',
                  author:     item.book?.author ?? '',
                  coverUrl:   item.book?.cover_url ?? '',
                  externalId: item.book?.external_id ?? '',
                  status:     item.status,
                  startedAt:  item.started_at ?? '',
                },
              })}
              style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: hasExtraRow ? 10 : 0 }}
            >
              <CoverThumb
                url={item.book?.cover_url}
                externalId={item.book?.external_id}
                width={44}
                height={64}
              />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={{ fontWeight: '700', fontSize: 16, color: '#1c1917', marginBottom: 3 }}>
                      {item.book?.title ?? '—'}
                    </Text>
                    <Text style={{ color: '#78716c', fontSize: 13 }}>
                      {item.book?.author ?? '—'}
                    </Text>
                  </View>
                  <View style={{ backgroundColor: badge.bg, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 4, alignSelf: 'flex-start' }}>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: badge.text }}>
                      {STATUS_LABELS[item.status]}
                    </Text>
                  </View>
                </View>

                {/* Reading progress indicator */}
                {hasProgress && (
                  <View style={{ marginTop: 8 }}>
                    <View style={{
                      height: 3,
                      backgroundColor: '#e7e5e4',
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}>
                      <View style={{
                        height: 3,
                        width: `${progressPct ?? 0}%`,
                        backgroundColor: '#1c1917',
                        borderRadius: 2,
                      }} />
                    </View>
                    <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 3 }}>
                      p.{item.current_page} of {item.book?.page_count} · {progressPct ?? 0}%
                    </Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>

            {/* Action buttons / sentiment feedback */}
            {pendingFeedback?.userBookId === item.id ? (
              <View style={{ marginLeft: 54, marginTop: 6 }}>
                <Text style={{ fontSize: 11, color: '#78716c', marginBottom: 8 }}>
                  How was it? (optional)
                </Text>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {SENTIMENT_OPTIONS.map(opt => (
                    <TouchableOpacity
                      key={opt.value}
                      onPress={() => saveSentiment(item.id, opt.value)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 20,
                        borderWidth: 1,
                        borderColor: '#e7e5e4',
                        backgroundColor: '#fff',
                      }}
                    >
                      <Text style={{ fontSize: 12, color: '#57534e' }}>{opt.label}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    onPress={() => setPendingFeedback(null)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={{ fontSize: 12, color: '#a8a29e', paddingHorizontal: 4 }}>Skip</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : isUpdating ? (
              <ActivityIndicator color="#78716c" style={{ alignSelf: 'flex-start', marginLeft: 54 }} />
            ) : item.status === 'want_to_read' ? (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginLeft: 54 }}>
                <PrimaryButton label="Start Reading"  onPress={() => handleUpdateStatus(item, 'reading')}  disabled={isBlocked} />
                <OutlineButton label="Mark Finished"  onPress={() => handleUpdateStatus(item, 'finished')} disabled={isBlocked} />
                <DangerButton  label="DNF"            onPress={() => handleUpdateStatus(item, 'dnf')}      disabled={isBlocked} />
              </View>
            ) : item.status === 'reading' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginLeft: 54 }}>
                <PrimaryButton label="Mark Finished"  onPress={() => handleUpdateStatus(item, 'finished')} disabled={isBlocked} />
                <DangerButton  label="DNF"            onPress={() => handleUpdateStatus(item, 'dnf')}      disabled={isBlocked} />
              </View>
            ) : null}
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={{ alignItems: 'center', paddingTop: 52, paddingHorizontal: 32 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: '#1c1917', marginBottom: 10, textAlign: 'center' }}>
            Your library is empty
          </Text>
          <Text style={{ color: '#a8a29e', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 28 }}>
            Add books you're reading, have finished, or want to read — from recommendations or on your own.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/add-book')}
            style={{ backgroundColor: '#1c1917', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 26 }}
          >
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>Add your first book</Text>
          </TouchableOpacity>
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
      style={{ paddingHorizontal: 14, paddingVertical: 7, backgroundColor: disabled ? '#e7e5e4' : '#1c1917', borderRadius: 8 }}
    >
      <Text style={{ fontSize: 12, fontWeight: '500', color: disabled ? '#a8a29e' : '#fff' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function OutlineButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{ paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: disabled ? '#e7e5e4' : '#d6d3d1', borderRadius: 8 }}
    >
      <Text style={{ fontSize: 12, fontWeight: '500', color: disabled ? '#a8a29e' : '#57534e' }}>{label}</Text>
    </TouchableOpacity>
  );
}

function DangerButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{ paddingHorizontal: 14, paddingVertical: 7, borderWidth: 1, borderColor: disabled ? '#e7e5e4' : '#fca5a5', borderRadius: 8 }}
    >
      <Text style={{ fontSize: 12, fontWeight: '500', color: disabled ? '#a8a29e' : '#b91c1c' }}>{label}</Text>
    </TouchableOpacity>
  );
}
