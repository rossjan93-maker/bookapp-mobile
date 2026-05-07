import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchAuthorBibliography,
  type AuthorBibliography,
  type AuthorBibliographyEntry,
} from '../lib/openLibrary';
import { SAGE, SAGE_BG, SAGE_DEEP, SAGE_INK } from '../lib/tokens';

type Props = {
  visible:        boolean;
  onClose:        () => void;
  author:         string;
  // Title currently being viewed in the parent screen — used to highlight
  // its row inside the bibliography list. Compared after lower/strip-punct
  // normalization so trailing-subtitle punctuation differences don't break
  // the match.
  currentTitle?:  string | null;
};

type SortMode = 'chronological' | 'rating';

function _normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Simple star renderer — half-stars rounded to nearest, capped at 5.
function _stars(rating: number): string {
  const r = Math.max(0, Math.min(5, Math.round(rating * 2) / 2));
  const full = Math.floor(r);
  const half = r - full >= 0.5 ? 1 : 0;
  return '★'.repeat(full) + (half ? '½' : '');
}

// Group entries by decade for the chronological view. Year-less entries
// land in their own "Undated" bucket at the end so the timeline stays
// honest.
function _groupByDecade(entries: AuthorBibliographyEntry[]) {
  const groups = new Map<string, AuthorBibliographyEntry[]>();
  for (const e of entries) {
    const label = e.year == null ? 'Undated' : `${Math.floor(e.year / 10) * 10}s`;
    const arr = groups.get(label) ?? [];
    arr.push(e);
    groups.set(label, arr);
  }
  return Array.from(groups.entries());
}

export function AuthorBibliographySheet({
  visible, onClose, author, currentTitle,
}: Props) {
  const insets = useSafeAreaInsets();

  const [bib, setBib]         = useState<AuthorBibliography | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort]       = useState<SortMode>('chronological');

  useEffect(() => {
    if (!visible || !author) return;
    let cancelled = false;
    setLoading(true);
    setBib(null);
    fetchAuthorBibliography(author)
      .then(result => { if (!cancelled) { setBib(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setBib(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [visible, author]);

  const currentNorm = currentTitle ? _normTitle(currentTitle) : '';

  // Re-derive the sorted list whenever the user toggles modes. Chronological
  // is the canonical OL order (already oldest→newest); rating sorts by
  // ratings_average desc, with unrated entries falling to the bottom in
  // their original order so the "career view" feel isn't lost.
  const sortedEntries = useMemo(() => {
    if (!bib) return [];
    if (sort === 'chronological') return bib.entries;
    return [...bib.entries].sort((a, b) => {
      const ar = a.rating ?? -1;
      const br = b.rating ?? -1;
      if (br !== ar) return br - ar;
      return (b.ratingCount ?? 0) - (a.ratingCount ?? 0);
    });
  }, [bib, sort]);

  const totalDated = bib ? bib.entries.filter(e => e.year != null).length : 0;
  const currentEntry = bib?.entries.find(e => _normTitle(e.title) === currentNorm) ?? null;

  // Hero cover stack: pick up to 3 visually-strongest covers (rating-weighted)
  // for the masthead. Falls back to the first 3 chronologically when no
  // ratings are available.
  const heroCovers = useMemo(() => {
    if (!bib) return [];
    const withCovers = bib.entries.filter(e => !!e.coverUrl);
    const ranked = [...withCovers].sort((a, b) => {
      const ar = (a.rating ?? 0) * Math.log10((a.ratingCount ?? 0) + 1);
      const br = (b.rating ?? 0) * Math.log10((b.ratingCount ?? 0) + 1);
      return br - ar;
    });
    return ranked.slice(0, 3);
  }, [bib]);

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

        {/* Top bar */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 20,
          paddingTop: 8,
          paddingBottom: 6,
        }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#9e958d', letterSpacing: 1.1, textTransform: 'uppercase' }}>
            Author bibliography
          </Text>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={12}
            style={{ backgroundColor: '#ede9e4', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 13, fontWeight: '600', color: '#6b635c' }}>Close</Text>
          </TouchableOpacity>
        </View>

        {loading && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={SAGE_DEEP} />
            <Text style={{ marginTop: 14, fontSize: 13, color: '#9e958d' }}>
              Pulling {author}'s catalog…
            </Text>
          </View>
        )}

        {!loading && !bib && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
            <Ionicons name="library-outline" size={42} color="#c4b5a5" />
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#231f1b', marginTop: 14, textAlign: 'center' }}>
              No catalog available
            </Text>
            <Text style={{ fontSize: 13, color: '#78716c', marginTop: 6, lineHeight: 19, textAlign: 'center' }}>
              We couldn't reach Open Library, or {author} has no catalog data on file. Try again in a moment.
            </Text>
          </View>
        )}

        {!loading && bib && (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
            showsVerticalScrollIndicator={false}
          >
            {/* Hero — cover stack + author name + summary stats */}
            <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 22 }}>
              {heroCovers.length > 0 && (
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  height: 138,
                  marginBottom: 18,
                }}>
                  {heroCovers.map((c, i) => {
                    // Stagger the three covers — center one tallest/forward,
                    // outer two slightly tilted and dimmed for depth.
                    const isCenter = i === 1 || heroCovers.length === 1;
                    const offset = i === 0 ? -42 : i === 2 ? 42 : 0;
                    const rotate = i === 0 ? '-8deg' : i === 2 ? '8deg' : '0deg';
                    const scale = isCenter ? 1 : 0.86;
                    const z = isCenter ? 3 : 1;
                    return (
                      <View
                        key={c.olKey}
                        style={{
                          position: 'absolute',
                          left: '50%',
                          marginLeft: offset - 38,
                          transform: [{ rotate }, { scale }],
                          zIndex: z,
                          shadowColor: '#000',
                          shadowOpacity: 0.18,
                          shadowRadius: 10,
                          shadowOffset: { width: 0, height: 4 },
                          elevation: 4,
                        }}
                      >
                        <Image
                          source={{ uri: c.coverUrl! }}
                          style={{ width: 76, height: 114, borderRadius: 4, backgroundColor: '#ede9e4' }}
                          resizeMode="cover"
                        />
                      </View>
                    );
                  })}
                </View>
              )}

              <Text style={{ fontSize: 24, fontWeight: '800', color: '#231f1b', textAlign: 'center', letterSpacing: -0.4 }}>
                {bib.author}
              </Text>
              <Text style={{ fontSize: 13, color: '#78716c', textAlign: 'center', marginTop: 6 }}>
                {totalDated} published {totalDated === 1 ? 'work' : 'works'}
                {bib.yearRange ? ` · ${bib.yearRange.from}–${bib.yearRange.to}` : ''}
              </Text>

              {/* Inline "you're viewing" pointer — only when we matched the current book */}
              {currentEntry && (
                <View style={{
                  marginTop: 14,
                  alignSelf: 'center',
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: SAGE_BG,
                  borderRadius: 18,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                }}>
                  <Ionicons name="bookmark" size={12} color={SAGE_INK} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: SAGE_INK, marginLeft: 6 }}>
                    You're viewing {currentEntry.title}
                    {currentEntry.year ? ` (${currentEntry.year})` : ''}
                  </Text>
                </View>
              )}
            </View>

            {/* Sort toggle */}
            <View style={{
              flexDirection: 'row',
              marginHorizontal: 20,
              marginBottom: 16,
              backgroundColor: '#ede9e4',
              borderRadius: 10,
              padding: 3,
            }}>
              {(['chronological', 'rating'] as SortMode[]).map(mode => {
                const active = sort === mode;
                return (
                  <TouchableOpacity
                    key={mode}
                    onPress={() => setSort(mode)}
                    style={{
                      flex: 1,
                      paddingVertical: 8,
                      borderRadius: 8,
                      alignItems: 'center',
                      backgroundColor: active ? '#fefcf9' : 'transparent',
                    }}
                  >
                    <Text style={{
                      fontSize: 12,
                      fontWeight: '700',
                      color: active ? '#231f1b' : '#78716c',
                      letterSpacing: 0.2,
                    }}>
                      {mode === 'chronological' ? 'By year' : 'By rating'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* List */}
            <View style={{ paddingHorizontal: 20 }}>
              {sort === 'chronological' ? (
                _groupByDecade(sortedEntries).map(([decade, items]) => (
                  <View key={decade} style={{ marginBottom: 18 }}>
                    <Text style={{
                      fontSize: 11,
                      fontWeight: '700',
                      color: '#9e958d',
                      letterSpacing: 1.1,
                      textTransform: 'uppercase',
                      marginBottom: 10,
                    }}>
                      {decade}
                    </Text>
                    <View style={{
                      backgroundColor: '#fefcf9',
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: '#ede9e4',
                      overflow: 'hidden',
                    }}>
                      {items.map((entry, idx) => (
                        <BibRow
                          key={entry.olKey}
                          entry={entry}
                          isCurrent={_normTitle(entry.title) === currentNorm}
                          isLast={idx === items.length - 1}
                        />
                      ))}
                    </View>
                  </View>
                ))
              ) : (
                <View style={{
                  backgroundColor: '#fefcf9',
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: '#ede9e4',
                  overflow: 'hidden',
                  marginBottom: 18,
                }}>
                  {sortedEntries.map((entry, idx) => (
                    <BibRow
                      key={entry.olKey}
                      entry={entry}
                      isCurrent={_normTitle(entry.title) === currentNorm}
                      isLast={idx === sortedEntries.length - 1}
                    />
                  ))}
                </View>
              )}
            </View>

            {/* Footer source attribution */}
            <Text style={{
              fontSize: 11,
              color: '#a8a098',
              textAlign: 'center',
              paddingHorizontal: 20,
              lineHeight: 16,
            }}>
              Catalog data from Open Library. Some early or self-published works may be missing.
            </Text>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function BibRow({
  entry, isCurrent, isLast,
}: {
  entry: AuthorBibliographyEntry;
  isCurrent: boolean;
  isLast: boolean;
}) {
  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderBottomWidth: isLast ? 0 : 1,
      borderBottomColor: '#f0ece6',
      backgroundColor: isCurrent ? SAGE_BG : 'transparent',
      borderLeftWidth: isCurrent ? 3 : 0,
      borderLeftColor: isCurrent ? SAGE : 'transparent',
    }}>
      {entry.coverUrl ? (
        <Image
          source={{ uri: entry.coverUrl }}
          style={{ width: 46, height: 68, borderRadius: 3, backgroundColor: '#ede9e4' }}
          resizeMode="cover"
        />
      ) : (
        <View style={{
          width: 46,
          height: 68,
          borderRadius: 3,
          backgroundColor: '#ede9e4',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Ionicons name="book-outline" size={20} color="#a8a098" />
        </View>
      )}
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text
          style={{ fontSize: 14, fontWeight: '700', color: '#231f1b', lineHeight: 19 }}
          numberOfLines={2}
        >
          {entry.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
          <Text style={{ fontSize: 12, color: '#78716c' }}>
            {entry.year ?? 'Undated'}
            {entry.pageCount ? ` · ${entry.pageCount} pp` : ''}
          </Text>
          {entry.rating != null && entry.ratingCount != null && entry.ratingCount > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8 }}>
              <Text style={{ fontSize: 12, color: '#c8a04a', letterSpacing: 0.5 }}>
                {_stars(entry.rating)}
              </Text>
              <Text style={{ fontSize: 11, color: '#a8a098', marginLeft: 4 }}>
                {entry.rating.toFixed(1)} · {entry.ratingCount.toLocaleString()}
              </Text>
            </View>
          )}
        </View>
        {isCurrent && (
          <Text style={{ fontSize: 11, fontWeight: '700', color: SAGE_INK, marginTop: 4, letterSpacing: 0.3 }}>
            CURRENTLY VIEWING
          </Text>
        )}
      </View>
    </View>
  );
}
