/**
 * Shelf picker sheet — Batch 4.
 *
 * Bottom sheet that lets the user toggle a single book's membership across
 * their custom shelves and create new shelves inline. Used from:
 *   - library row long-press
 *   - book detail screen "Add to shelf" action (future)
 *
 * Optimistic toggle: tap flips the local checkbox immediately and fires the
 * mutation in the background. On failure we revert and surface the error in
 * the row's subtitle.
 *
 * Reads shelf membership from props (parent owns the source of truth) and
 * calls back on every change so the parent's Map stays in sync.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SAGE, SAGE_BG, SAGE_DEEP } from '../lib/tokens';
import {
  addBookToShelf,
  createShelf,
  removeBookFromShelf,
  type CustomShelf,
} from '../lib/customShelves';

type Props = {
  visible:        boolean;
  userId:         string;
  userBookId:     string | null;
  bookTitle?:     string | null;
  shelves:        CustomShelf[];
  /** shelf_ids the book currently belongs to */
  initialShelfIds: Set<string>;
  onClose:        () => void;
  /**
   * Notifies parent of every successful add/remove so it can update its
   * cached shelfMembership Map without re-querying.
   */
  onMembershipChange: (shelfId: string, added: boolean) => void;
  onShelfCreated:     (shelf: CustomShelf) => void;
};

export function ShelfPickerSheet({
  visible,
  userId,
  userBookId,
  bookTitle,
  shelves,
  initialShelfIds,
  onClose,
  onMembershipChange,
  onShelfCreated,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending,  setPending]  = useState<Set<string>>(new Set());
  const [error,    setError]    = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName,  setNewName]  = useState('');
  const [busy,     setBusy]     = useState(false);

  // Reset local state every time the sheet opens
  useEffect(() => {
    if (visible) {
      setSelected(new Set(initialShelfIds));
      setError(null);
      setCreating(false);
      setNewName('');
    }
  }, [visible, initialShelfIds]);

  async function handleToggle(shelfId: string) {
    if (!userBookId) return;
    if (pending.has(shelfId)) return;

    const wasMember = selected.has(shelfId);
    // Optimistic local flip
    setSelected(prev => {
      const next = new Set(prev);
      if (wasMember) next.delete(shelfId); else next.add(shelfId);
      return next;
    });
    setPending(prev => new Set(prev).add(shelfId));
    setError(null);
    try {
      if (wasMember) {
        await removeBookFromShelf(shelfId, userBookId);
        onMembershipChange(shelfId, false);
      } else {
        await addBookToShelf(userId, shelfId, userBookId);
        onMembershipChange(shelfId, true);
      }
    } catch (e: any) {
      // Revert
      setSelected(prev => {
        const next = new Set(prev);
        if (wasMember) next.add(shelfId); else next.delete(shelfId);
        return next;
      });
      setError(e?.message ?? 'Could not update shelf.');
    } finally {
      setPending(prev => { const n = new Set(prev); n.delete(shelfId); return n; });
    }
  }

  async function handleCreate() {
    if (!userBookId) return;
    setBusy(true);
    setError(null);
    try {
      const shelf = await createShelf(userId, newName);
      onShelfCreated(shelf);
      // Auto-add the current book to the just-created shelf.
      await addBookToShelf(userId, shelf.id, userBookId);
      onMembershipChange(shelf.id, true);
      setSelected(prev => new Set(prev).add(shelf.id));
      setCreating(false);
      setNewName('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not create shelf.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor:     '#fefcf9',
          borderTopLeftRadius:  22,
          borderTopRightRadius: 22,
          paddingTop:           20,
          paddingBottom:        36,
          maxHeight:            '80%',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, marginBottom: 4 }}>
            <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: '#231f1b' }}>
              Add to shelf
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={{ fontSize: 14, color: '#9e958d' }}>Done</Text>
            </TouchableOpacity>
          </View>
          {bookTitle && (
            <Text
              style={{ paddingHorizontal: 24, fontSize: 13, color: '#9e958d', marginBottom: 16 }}
              numberOfLines={1}
            >
              {bookTitle}
            </Text>
          )}

          {error && (
            <View style={{ marginHorizontal: 24, marginBottom: 12, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#fdecec', borderRadius: 8 }}>
              <Text style={{ fontSize: 12, color: '#b91c1c' }}>{error}</Text>
            </View>
          )}

          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 8 }}>
            {shelves.length === 0 && !creating && (
              <View style={{ paddingVertical: 12 }}>
                <Text style={{ fontSize: 13, color: '#9e958d', textAlign: 'center' }}>
                  You don't have any shelves yet. Create one below.
                </Text>
              </View>
            )}
            {shelves.map(sh => {
              const isOn      = selected.has(sh.id);
              const isPending = pending.has(sh.id);
              return (
                <TouchableOpacity
                  key={sh.id}
                  onPress={() => handleToggle(sh.id)}
                  disabled={!userBookId || isPending}
                  activeOpacity={0.7}
                  style={{
                    flexDirection:    'row',
                    alignItems:       'center',
                    paddingVertical:  12,
                    borderBottomWidth: 1,
                    borderBottomColor: '#f0ece6',
                    gap: 12,
                  }}
                >
                  <View style={{
                    width:           22,
                    height:          22,
                    borderRadius:    6,
                    borderWidth:     1.5,
                    borderColor:     isOn ? SAGE : '#d8d3cc',
                    backgroundColor: isOn ? SAGE_BG : 'transparent',
                    alignItems:      'center',
                    justifyContent:  'center',
                  }}>
                    {isOn && <Ionicons name="checkmark" size={14} color={SAGE_DEEP} />}
                  </View>
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: '500', color: '#231f1b' }} numberOfLines={1}>
                    {sh.name}
                  </Text>
                  {isPending && <ActivityIndicator size="small" color="#9e958d" />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Create-new row */}
          <View style={{ paddingHorizontal: 24, paddingTop: 14 }}>
            {!creating ? (
              <TouchableOpacity
                onPress={() => setCreating(true)}
                activeOpacity={0.7}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}
              >
                <Ionicons name="add-circle-outline" size={18} color={SAGE_DEEP} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: SAGE_DEEP }}>
                  Create new shelf
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="Shelf name"
                  placeholderTextColor="#c4b5a5"
                  autoFocus
                  maxLength={60}
                  style={{
                    flex: 1,
                    fontSize: 14,
                    color: '#231f1b',
                    backgroundColor: '#f5f1ec',
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  }}
                />
                <TouchableOpacity
                  onPress={handleCreate}
                  disabled={busy || newName.trim().length === 0}
                  style={{
                    backgroundColor: newName.trim().length === 0 ? '#d8d3cc' : '#231f1b',
                    borderRadius: 10,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                  }}
                >
                  {busy
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Create</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => { setCreating(false); setNewName(''); setError(null); }}
                  hitSlop={10}
                >
                  <Text style={{ fontSize: 13, color: '#9e958d' }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}
