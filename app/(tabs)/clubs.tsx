import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { createClub, fetchMyClubs } from '../../lib/bookClub';
import type { ClubWithDetails } from '../../lib/bookClubTypes';

// ── Design tokens ──────────────────────────────────────────────────────────────
const INK    = '#231f1b';
const DUST   = '#9e958d';
const SAGE   = '#7b9e7e';
const BG     = '#f5f1ec';
const PAPER  = '#fefcf9';
const BORDER = '#ede9e4';

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ onCreatePress }: { onCreatePress: () => void }) {
  return (
    <View style={styles.emptyWrap}>
      <Ionicons name="people-outline" size={48} color={DUST} />
      <Text style={styles.emptyTitle}>No clubs yet</Text>
      <Text style={styles.emptyBody}>
        Start a book club and invite your friends to read together.
      </Text>
      <TouchableOpacity style={styles.emptyButton} onPress={onCreatePress} activeOpacity={0.8}>
        <Ionicons name="add" size={16} color={PAPER} />
        <Text style={styles.emptyButtonText}>Create a club</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Club card ──────────────────────────────────────────────────────────────────

function ClubCard({ club, onPress }: { club: ClubWithDetails; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.cardRow}>
        {club.activeBook ? (
          <CoverThumb
            url={club.activeBook.cover_url}
            externalId={club.activeBook.external_id}
            title={club.activeBook.title}
            width={44}
            height={64}
            radius={6}
          />
        ) : (
          <View style={styles.noBookCover}>
            <Ionicons name="book-outline" size={20} color={DUST} />
          </View>
        )}

        <View style={styles.cardContent}>
          <Text style={styles.clubName} numberOfLines={1}>{club.name}</Text>
          {club.activeBook ? (
            <Text style={styles.bookTitle} numberOfLines={1}>
              Reading: {club.activeBook.title}
            </Text>
          ) : (
            <Text style={styles.noBook}>No active book</Text>
          )}
          <View style={styles.metaRow}>
            <Ionicons name="people-outline" size={12} color={DUST} />
            <Text style={styles.metaText}>
              {club.memberCount} {club.memberCount === 1 ? 'member' : 'members'}
            </Text>
          </View>
        </View>

        <Ionicons name="chevron-forward" size={18} color={DUST} />
      </View>
    </TouchableOpacity>
  );
}

// ── Create club modal ──────────────────────────────────────────────────────────

function CreateClubModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name,        setName]        = useState('');
  const [description, setDescription] = useState('');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) { setError('Club name is required.'); return; }
    if (!supabase) return;
    setLoading(true);
    setError(null);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); setError('Not signed in.'); return; }

    const { error: err } = await createClub(supabase, {
      name,
      description: description || undefined,
      userId: user.id,
    });

    setLoading(false);

    if (err) {
      setError(err);
      return;
    }

    setName('');
    setDescription('');
    onCreated();
    onClose();
  }

  function handleClose() {
    setName('');
    setDescription('');
    setError(null);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <View style={styles.modalWrap}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>New book club</Text>
          <TouchableOpacity onPress={handleClose} hitSlop={12}>
            <Ionicons name="close" size={22} color={INK} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
          <Text style={styles.fieldLabel}>Club name</Text>
          <TextInput
            style={styles.textInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Summer Reads"
            placeholderTextColor={DUST}
            maxLength={60}
            autoFocus
          />

          <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Description (optional)</Text>
          <TextInput
            style={[styles.textInput, { height: 80, textAlignVertical: 'top' }]}
            value={description}
            onChangeText={setDescription}
            placeholder="What kind of books will you read?"
            placeholderTextColor={DUST}
            maxLength={200}
            multiline
          />

          {error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity
            style={[styles.createButton, loading && { opacity: 0.6 }]}
            onPress={handleCreate}
            disabled={loading}
            activeOpacity={0.8}
          >
            {loading
              ? <ActivityIndicator size="small" color={PAPER} />
              : <Text style={styles.createButtonText}>Create club</Text>
            }
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function ClubsScreen() {
  const insets  = useSafeAreaInsets();
  const router  = useRouter();
  const [clubs,         setClubs]         = useState<ClubWithDetails[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [showCreate,    setShowCreate]    = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadClubs();
    }, []),
  );

  async function loadClubs() {
    if (!supabase) return;
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { clubs: data } = await fetchMyClubs(supabase, { userId: user.id });
    setClubs(data);
    setLoading(false);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Clubs</Text>
        <TouchableOpacity
          style={styles.headerAction}
          onPress={() => setShowCreate(true)}
          hitSlop={10}
        >
          <Ionicons name="add-circle-outline" size={24} color={INK} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={SAGE} />
        </View>
      ) : clubs.length === 0 ? (
        <EmptyState onCreatePress={() => setShowCreate(true)} />
      ) : (
        <FlatList
          data={clubs}
          keyExtractor={c => c.id}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          renderItem={({ item }) => (
            <ClubCard
              club={item}
              onPress={() => router.push({ pathname: '/club/[id]', params: { id: item.id } })}
            />
          )}
        />
      )}

      <CreateClubModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={loadClubs}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex:            1,
    backgroundColor: BG,
  },
  header: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    paddingHorizontal: 20,
    paddingVertical:   14,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    backgroundColor:   PAPER,
  },
  headerTitle: {
    fontSize:   20,
    fontWeight: '700',
    color:      INK,
  },
  headerAction: {
    padding: 4,
  },
  loadingWrap: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
  },

  // Empty state
  emptyWrap: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    padding:        40,
    gap:            12,
  },
  emptyTitle: {
    fontSize:   20,
    fontWeight: '700',
    color:      INK,
  },
  emptyBody: {
    fontSize:  14,
    color:     DUST,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyButton: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             6,
    backgroundColor: INK,
    paddingHorizontal: 20,
    paddingVertical:   12,
    borderRadius:      24,
    marginTop:         8,
  },
  emptyButtonText: {
    color:      PAPER,
    fontWeight: '600',
    fontSize:   14,
  },

  // Club card
  list: {
    padding: 16,
  },
  separator: {
    height: 10,
  },
  card: {
    backgroundColor: PAPER,
    borderRadius:    14,
    padding:         14,
    shadowColor:     INK,
    shadowOpacity:   0.07,
    shadowRadius:    8,
    shadowOffset:    { width: 0, height: 2 },
    elevation:       3,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
  },
  noBookCover: {
    width:           44,
    height:          64,
    borderRadius:    6,
    backgroundColor: BORDER,
    alignItems:      'center',
    justifyContent:  'center',
  },
  cardContent: {
    flex: 1,
    gap:  4,
  },
  clubName: {
    fontSize:   15,
    fontWeight: '700',
    color:      INK,
  },
  bookTitle: {
    fontSize: 12,
    color:    DUST,
  },
  noBook: {
    fontSize:    12,
    color:       DUST,
    fontStyle:   'italic',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
    marginTop:     2,
  },
  metaText: {
    fontSize: 11,
    color:    DUST,
  },

  // Modal
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
  modalBody: {
    padding: 20,
  },
  fieldLabel: {
    fontSize:     12,
    fontWeight:   '600',
    color:        DUST,
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
