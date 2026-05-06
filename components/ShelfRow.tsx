import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CoverThumb } from './CoverThumb';
import { SHELF_DEFINITIONS, BookItem } from '../lib/shelves';
import type { CustomShelf } from '../lib/customShelves';
import { SAGE, SAGE_BG, SAGE_DEEP } from '../lib/tokens';

type Props = {
  items:           BookItem[];
  activeShelf:     string | null;
  onSelect:        (shelfId: string | null) => void;

  // Custom-shelf integration (Batch 4). Optional so legacy callers still work.
  userShelves?:        CustomShelf[];
  /** user_book_id → Set<shelf_id> — used to derive per-shelf book lists. */
  shelfMembership?:    Map<string, Set<string>>;
  /** user_book_id accessor on a BookItem. Caller knows the field name. */
  itemUserBookId?:     (item: BookItem) => string | null | undefined;
  onCreateShelfPress?: () => void;
  onLongPressShelf?:   (shelfId: string) => void;
};

const CARD_W       = 132;
const THUMB_W      = 24;
const THUMB_H      = 36;
const THUMB_OFFSET = 6;
const CARD_PAD     = 12;

export function ShelfRow({
  items,
  activeShelf,
  onSelect,
  userShelves        = [],
  shelfMembership    = new Map(),
  itemUserBookId,
  onCreateShelfPress,
  onLongPressShelf,
}: Props) {
  // Smart shelves (filter-fn driven). Drop empties — they earn their space.
  const smartShelves = SHELF_DEFINITIONS.map(def => ({
    kind:   'smart' as const,
    id:     def.id,
    label:  def.label,
    books:  items.filter(def.filter),
  })).filter(s => s.books.length > 0);

  // Custom shelves (membership driven). Always render even when empty so the
  // user can tap into an empty shelf and start adding books.
  const customShelves = itemUserBookId
    ? userShelves.map(sh => {
        const books = items.filter(it => {
          const ubId = itemUserBookId(it);
          if (!ubId) return false;
          return shelfMembership.get(ubId)?.has(sh.id) ?? false;
        });
        return { kind: 'custom' as const, id: sh.id, label: sh.name, books };
      })
    : [];

  const showRow = smartShelves.length + customShelves.length > 0 || onCreateShelfPress != null;
  if (!showRow) return null;

  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={{
        fontSize:        10,
        fontWeight:      '700',
        color:           '#9e958d',
        letterSpacing:   1.1,
        textTransform:   'uppercase',
        marginBottom:    10,
      }}>
        Shelves
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -20 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom:     6,
          flexDirection:     'row',
          gap:               10,
        }}
      >
        {[...smartShelves, ...customShelves].map(shelf => {
          const active     = activeShelf === shelf.id;
          const thumbBooks = shelf.books.slice(0, 3);
          const stackWidth = Math.max(THUMB_W, THUMB_W + (thumbBooks.length - 1) * THUMB_OFFSET);

          return (
            <TouchableOpacity
              key={`${shelf.kind}_${shelf.id}`}
              onPress={() => onSelect(active ? null : shelf.id)}
              onLongPress={
                shelf.kind === 'custom' && onLongPressShelf
                  ? () => onLongPressShelf(shelf.id)
                  : undefined
              }
              activeOpacity={0.82}
              style={{
                width:           CARD_W,
                borderRadius:    12,
                backgroundColor: active ? '#2e2a26' : '#fefcf9',
                borderWidth:     1,
                borderColor:     active ? '#2e2a26' : '#e8e3dd',
                padding:         CARD_PAD,
                overflow:        'hidden',
                shadowColor:     '#000',
                shadowOpacity:   active ? 0.14 : 0.05,
                shadowRadius:    active ? 8 : 4,
                shadowOffset:    { width: 0, height: active ? 3 : 1 },
                elevation:       active ? 4 : 1,
              }}
            >
              {active && (
                <View style={{
                  position:        'absolute',
                  bottom:          0,
                  left:            14,
                  right:           14,
                  height:          2.5,
                  backgroundColor: SAGE,
                  borderRadius:    2,
                }} />
              )}

              <View style={{
                flexDirection:  'row',
                alignItems:     'center',
                justifyContent: 'space-between',
                minHeight:      THUMB_H,
              }}>
                <View style={{ width: stackWidth, height: THUMB_H, position: 'relative' }}>
                  {thumbBooks.length > 0 ? thumbBooks.map((book, idx) => (
                    <View
                      key={book.book?.external_id ?? idx}
                      style={{
                        position:      'absolute',
                        left:          idx * THUMB_OFFSET,
                        top:           0,
                        zIndex:        thumbBooks.length - idx,
                        shadowColor:   '#000',
                        shadowOpacity: 0.10,
                        shadowRadius:  2,
                        shadowOffset:  { width: 1, height: 1 },
                        elevation:     thumbBooks.length - idx,
                      }}
                    >
                      <CoverThumb
                        url={book.book?.cover_url}
                        externalId={book.book?.external_id}
                        title={book.book?.title}
                        width={THUMB_W}
                        height={THUMB_H}
                        radius={3}
                      />
                    </View>
                  )) : (
                    // Empty custom shelf placeholder — subtle dashed slot
                    <View style={{
                      width:           THUMB_W,
                      height:          THUMB_H,
                      borderRadius:    3,
                      borderWidth:     1,
                      borderColor:     '#ede9e4',
                      borderStyle:     'dashed',
                      backgroundColor: '#f5f1ec',
                    }} />
                  )}
                </View>

                <View style={{
                  backgroundColor:   active ? SAGE_BG : '#f0ece6',
                  borderRadius:      10,
                  paddingHorizontal: 7,
                  paddingVertical:   3,
                  minWidth:          24,
                  alignItems:        'center',
                }}>
                  <Text style={{
                    fontSize:   11,
                    fontWeight: '700',
                    color:      active ? SAGE : '#9e958d',
                  }}>
                    {shelf.books.length}
                  </Text>
                </View>
              </View>

              <Text
                numberOfLines={1}
                style={{
                  fontSize:      11,
                  fontWeight:    '600',
                  color:         active ? '#f5f1ec' : '#3d3530',
                  letterSpacing: 0.1,
                  marginTop:     8,
                }}
              >
                {shelf.label}
              </Text>
            </TouchableOpacity>
          );
        })}

        {/* "+ New shelf" tile — outlined, last position */}
        {onCreateShelfPress && (
          <TouchableOpacity
            onPress={onCreateShelfPress}
            activeOpacity={0.75}
            style={{
              width:           CARD_W,
              borderRadius:    12,
              backgroundColor: 'transparent',
              borderWidth:     1,
              borderColor:     '#d8d3cc',
              borderStyle:     'dashed',
              padding:         CARD_PAD,
              alignItems:      'center',
              justifyContent:  'center',
              minHeight:       THUMB_H + 30,
            }}
          >
            <Ionicons name="add" size={20} color={SAGE_DEEP} />
            <Text style={{
              fontSize:      11,
              fontWeight:    '600',
              color:         SAGE_DEEP,
              letterSpacing: 0.1,
              marginTop:     4,
            }}>
              New shelf
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}
