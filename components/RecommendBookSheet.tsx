import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  Share,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { showToast } from '../lib/toast';
import { getDisplayName } from '../lib/displayName';
import { SAGE, SAGE_BG, SAGE_DEEP, SAGE_INK } from '../lib/tokens';

type Friend = {
  id: string;
  username: string;
  first_name: string | null;
  last_name: string | null;
};

type RecommendBookSheetProps = {
  visible:    boolean;
  onClose:    () => void;
  bookId:     string | null;     // canonical books.id (required for in-app send)
  title:      string;
  author:     string;
  externalId: string | null;
};

const NOTE_MAX = 200;

function InitialAvatar({ name }: { name: string }) {
  return (
    <View style={{
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: SAGE_BG,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    }}>
      <Text style={{ fontSize: 15, fontWeight: '700', color: SAGE_INK }}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

export function RecommendBookSheet({
  visible, onClose, bookId, title, author, externalId,
}: RecommendBookSheetProps) {
  const insets = useSafeAreaInsets();

  const [me, setMe]                   = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [friends, setFriends]         = useState<Friend[]>([]);
  const [alreadySent, setAlreadySent] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [note, setNote]               = useState('');
  const [sending, setSending]         = useState(false);
  const [error, setError]             = useState<string | null>(null);

  // Reset transient state when reopened
  useEffect(() => {
    if (!visible) return;
    setSelectedId(null);
    setNote('');
    setError(null);
    setSending(false);
  }, [visible]);

  // Load accepted friends + recent recipients of this book (to flag dup sends)
  useEffect(() => {
    if (!visible || !supabase) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase!.auth.getUser();
      if (cancelled) return;
      if (!user) { setLoading(false); return; }
      setMe(user.id);

      const [{ data: friendships }, { data: priorRecs }] = await Promise.all([
        supabase!
          .from('friendships')
          .select('requester_id, addressee_id')
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
        bookId
          ? supabase!
              .from('recommendations')
              .select('to_user_id')
              .eq('from_user_id', user.id)
              .eq('book_id', bookId)
          : Promise.resolve({ data: [] as { to_user_id: string }[] }),
      ]);

      if (cancelled) return;

      const ids = (friendships ?? []).map(f =>
        f.requester_id === user.id ? f.addressee_id : f.requester_id
      );
      if (ids.length === 0) {
        setFriends([]);
        setAlreadySent(new Set());
        setLoading(false);
        return;
      }

      const { data: profiles } = await supabase!
        .from('profiles')
        .select('id, username, first_name, last_name')
        .in('id', ids);

      if (cancelled) return;
      setFriends((profiles as Friend[]) ?? []);
      setAlreadySent(new Set(((priorRecs ?? []) as { to_user_id: string }[]).map(r => r.to_user_id)));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [visible, bookId]);

  async function handleSend() {
    if (!supabase || !me || !selectedId || !bookId) return;
    // Client-side dedup gate. v1 has no DB-level unique constraint
    // (intentional — see replit.md Architecture decisions). The
    // `alreadySent` set is preloaded from existing rows so a second tap
    // doesn't insert another `recommendations` row for the same trio.
    if (alreadySent.has(selectedId)) {
      setError("You've already recommended this book to that friend.");
      return;
    }
    setSending(true);
    setError(null);

    const trimmed = note.trim();
    const { data: rec, error: recError } = await supabase
      .from('recommendations')
      .insert({
        from_user_id: me,
        to_user_id:   selectedId,
        book_id:      bookId,
        status:       'sent',
        note:         trimmed.length > 0 ? trimmed : null,
      })
      .select('id')
      .single();

    if (recError || !rec) {
      setSending(false);
      // RLS rejection (no accepted friendship) is the only realistic path
      // here besides transient network errors — surface a friendly message.
      const isRls = (recError?.message ?? '').toLowerCase().includes('row-level security');
      setError(isRls
        ? "Can't send — this friendship is no longer accepted."
        : (recError?.message ?? 'Could not send. Try again.'));
      return;
    }

    // Mirror existing sender pattern from app/(tabs)/search.tsx. We don't
    // block the success toast on activity_events — the inbox reads from
    // `recommendations` directly — but we do log so silent drops are
    // observable in the browser console / Sentry.
    const { error: activityError } = await supabase.from('activity_events').insert({
      actor_id:          me,
      event_type:        'recommendation_sent',
      book_id:           bookId,
      recommendation_id: rec.id,
    });
    if (activityError) console.warn('activity_events insert failed:', activityError.message);

    setSending(false);
    showToast('Recommendation sent');
    setAlreadySent(prev => { const n = new Set(prev); n.add(selectedId); return n; });
    onClose();
  }

  async function handleNativeShare() {
    try {
      await Share.share({
        message: `${title} by ${author}`,
        title:   title,
      });
    } catch {
      // user cancelled or share unavailable — silent
    }
  }

  const selectedAlreadySent = !!selectedId && alreadySent.has(selectedId);
  const canSend = !!selectedId && !!bookId && !sending && !selectedAlreadySent;

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

        {/* Header */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: 14,
        }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: '#231f1b', letterSpacing: -0.4 }}>
              Recommend
            </Text>
            <Text style={{ fontSize: 13, color: '#9e958d', marginTop: 2 }} numberOfLines={1}>
              {title}
            </Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={12}
            style={{ backgroundColor: '#ede9e4', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: '#6b635c' }}>Cancel</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingBottom: insets.bottom + 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Friends list */}
          <Text style={{
            fontSize: 11,
            fontWeight: '700',
            color: '#9e958d',
            letterSpacing: 1.1,
            textTransform: 'uppercase',
            marginBottom: 10,
          }}>
            To
          </Text>

          {loading && (
            <View style={{ paddingVertical: 30, alignItems: 'center' }}>
              <ActivityIndicator color="#78716c" />
            </View>
          )}

          {!loading && friends.length === 0 && (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              borderWidth: 1,
              borderColor: '#ede9e4',
              padding: 18,
              marginBottom: 18,
            }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: '#231f1b', marginBottom: 4 }}>
                No friends yet
              </Text>
              <Text style={{ fontSize: 13, color: '#78716c', lineHeight: 19 }}>
                Add friends to send book recommendations. You can still share this book using your phone's share menu below.
              </Text>
            </View>
          )}

          {!loading && friends.length > 0 && (
            <View style={{
              backgroundColor: '#fefcf9',
              borderRadius: 14,
              borderWidth: 1,
              borderColor: '#ede9e4',
              marginBottom: 18,
              overflow: 'hidden',
            }}>
              {friends.map((f, i) => {
                const isSelected = selectedId === f.id;
                const sentBefore = alreadySent.has(f.id);
                const display    = getDisplayName(f);
                return (
                  <TouchableOpacity
                    key={f.id}
                    activeOpacity={0.7}
                    onPress={() => setSelectedId(isSelected ? null : f.id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: '#f0ece6',
                      backgroundColor: isSelected ? SAGE_BG : 'transparent',
                    }}
                  >
                    <InitialAvatar name={display} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: '#231f1b' }}>
                        {display}
                      </Text>
                      {sentBefore && (
                        <Text style={{ fontSize: 12, color: '#9e958d', marginTop: 2 }}>
                          Already recommended
                        </Text>
                      )}
                    </View>
                    {isSelected && (
                      <Ionicons name="checkmark-circle" size={22} color={SAGE_DEEP} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Optional note */}
          {!loading && friends.length > 0 && (
            <>
              <Text style={{
                fontSize: 11,
                fontWeight: '700',
                color: '#9e958d',
                letterSpacing: 1.1,
                textTransform: 'uppercase',
                marginBottom: 10,
              }}>
                Note (optional)
              </Text>
              <View style={{
                backgroundColor: '#fefcf9',
                borderRadius: 14,
                borderWidth: 1,
                borderColor: '#ede9e4',
                padding: 14,
                marginBottom: 6,
              }}>
                <TextInput
                  value={note}
                  onChangeText={t => setNote(t.slice(0, NOTE_MAX))}
                  placeholder="Thought you'd like this."
                  placeholderTextColor="#9e958d"
                  multiline
                  style={{
                    fontSize: 14,
                    color: '#231f1b',
                    minHeight: 64,
                    lineHeight: 20,
                    textAlignVertical: 'top',
                  }}
                />
              </View>
              <Text style={{ fontSize: 11, color: '#9e958d', alignSelf: 'flex-end', marginBottom: 18 }}>
                {note.length}/{NOTE_MAX}
              </Text>
            </>
          )}

          {error && (
            <Text style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>
              {error}
            </Text>
          )}

          {/* Send button */}
          {!loading && friends.length > 0 && (
            <TouchableOpacity
              onPress={handleSend}
              disabled={!canSend}
              style={{
                backgroundColor: canSend ? SAGE_DEEP : '#ede9e4',
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              {sending
                ? <ActivityIndicator color="#fff" />
                : (
                  <Text style={{ color: canSend ? '#fff' : '#9e958d', fontSize: 15, fontWeight: '700' }}>
                    Send recommendation
                  </Text>
                )
              }
            </TouchableOpacity>
          )}

          {/* Native share fallback — always available */}
          <TouchableOpacity
            onPress={handleNativeShare}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderWidth: 1,
              borderColor: '#ede9e4',
              borderRadius: 12,
              paddingVertical: 13,
            }}
          >
            <Ionicons name="share-outline" size={16} color="#57534e" />
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#57534e' }}>
              Share outside the app
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}
