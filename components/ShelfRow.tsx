import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { CoverThumb } from './CoverThumb';
import { SHELF_DEFINITIONS, BookItem } from '../lib/shelves';

type Props = {
  items: BookItem[];
  activeShelf: string | null;
  onSelect: (shelfId: string | null) => void;
};

const CARD_W = 130;
const CARD_H = 72;
const THUMB_W = 28;
const THUMB_H = 40;
const THUMB_OFFSET = 7;

export function ShelfRow({ items, activeShelf, onSelect }: Props) {
  const shelves = SHELF_DEFINITIONS.map(def => ({
    ...def,
    books: items.filter(def.filter),
  })).filter(s => s.books.length > 0);

  if (shelves.length === 0) return null;

  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={{
        fontSize: 10,
        fontWeight: '700',
        color: '#9e958d',
        letterSpacing: 1.1,
        textTransform: 'uppercase',
        marginBottom: 10,
        paddingHorizontal: 20,
      }}>
        Shelves
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -20 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: 4,
          flexDirection: 'row',
          gap: 10,
        }}
      >
        {shelves.map(shelf => {
          const active = activeShelf === shelf.id;
          const thumbBooks = shelf.books.slice(0, 3);
          const stackWidth = THUMB_W + (thumbBooks.length - 1) * THUMB_OFFSET;

          return (
            <TouchableOpacity
              key={shelf.id}
              onPress={() => onSelect(active ? null : shelf.id)}
              activeOpacity={0.82}
              style={{
                width: CARD_W,
                height: CARD_H,
                borderRadius: 12,
                backgroundColor: active ? '#2e2a26' : '#fefcf9',
                borderWidth: 1,
                borderColor: active ? '#2e2a26' : '#e8e3dd',
                padding: 11,
                justifyContent: 'space-between',
                shadowColor: '#000',
                shadowOpacity: active ? 0.14 : 0.05,
                shadowRadius: active ? 8 : 4,
                shadowOffset: { width: 0, height: active ? 3 : 1 },
                elevation: active ? 4 : 1,
              }}
            >
              {/* Bottom accent line */}
              {active && (
                <View style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 14,
                  right: 14,
                  height: 2.5,
                  backgroundColor: '#7b9e7e',
                  borderRadius: 2,
                }} />
              )}

              {/* Top row: stacked cover thumbnails + count badge */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                {/* Stacked thumbnails (deck of cards effect) */}
                <View style={{ width: stackWidth, height: THUMB_H, position: 'relative' }}>
                  {thumbBooks.map((book, idx) => (
                    <View
                      key={book.book?.external_id ?? idx}
                      style={{
                        position: 'absolute',
                        left: idx * THUMB_OFFSET,
                        top: 0,
                        zIndex: thumbBooks.length - idx,
                        shadowColor: '#000',
                        shadowOpacity: 0.12,
                        shadowRadius: 3,
                        shadowOffset: { width: 1, height: 1 },
                        elevation: thumbBooks.length - idx,
                      }}
                    >
                      <CoverThumb
                        url={book.book?.cover_url}
                        externalId={book.book?.external_id}
                        title={book.book?.title}
                        width={THUMB_W}
                        height={THUMB_H}
                        radius={4}
                      />
                    </View>
                  ))}
                </View>

                {/* Count badge */}
                <View style={{
                  backgroundColor: active ? 'rgba(123,158,126,0.25)' : '#f0ece6',
                  borderRadius: 10,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  minWidth: 24,
                  alignItems: 'center',
                }}>
                  <Text style={{
                    fontSize: 11,
                    fontWeight: '700',
                    color: active ? '#7b9e7e' : '#9e958d',
                  }}>
                    {shelf.books.length}
                  </Text>
                </View>
              </View>

              {/* Shelf label */}
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 11,
                  fontWeight: '600',
                  color: active ? '#f5f1ec' : '#3d3530',
                  letterSpacing: 0.1,
                  marginTop: 6,
                }}
              >
                {shelf.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}
