import { useEffect, useMemo, useRef, useState } from 'react';
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
  fetchOLMeta,
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

type DescState = { status: 'loading' } | { status: 'ready'; text: string | null };

const CURRENT_YEAR = new Date().getFullYear();

function _normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Title initials for the no-cover placeholder. Skips short connector words
// so "The Lost Apothecary" → "LA" instead of "TL".
function _titleInitials(title: string): string {
  const stop = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'and', 'or', 'to', 'for']);
  const words = title
    .split(/[^a-zA-Z0-9]+/)
    .filter(w => w && !stop.has(w.toLowerCase()));
  const picks = words.slice(0, 2);
  if (picks.length === 0) return title.slice(0, 2).toUpperCase();
  return picks.map(w => w[0]?.toUpperCase() ?? '').join('');
}

// Group entries by decade. Year-less entries → "Undated" bucket at end.
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

  const [bib, setBib]                 = useState<AuthorBibliography | null>(null);
  const [loading, setLoading]         = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Lazy-loaded description cache keyed by entry.olKey ("/works/OL...W").
  // Uses a ref alongside state so the in-flight fetch dedupe doesn't trigger
  // unnecessary re-renders. Persists across sort toggles within the sheet.
  const descCache = useRef<Map<string, DescState>>(new Map());
  const [, forceTick] = useState(0);
  const bumpCache = () => forceTick(t => t + 1);

  useEffect(() => {
    if (!visible || !author) return;
    let cancelled = false;
    setLoading(true);
    setBib(null);
    setExpandedKey(null);
    fetchAuthorBibliography(author)
      .then(result => { if (!cancelled) { setBib(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setBib(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [visible, author]);

  function toggleExpanded(entry: AuthorBibliographyEntry) {
    if (expandedKey === entry.olKey) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(entry.olKey);
    if (!descCache.current.has(entry.olKey)) {
      descCache.current.set(entry.olKey, { status: 'loading' });
      bumpCache();
      // fetchOLMeta accepts externalId — works key prefixed with /works/
      // works because extractOLID strips the prefix internally.
      fetchOLMeta(entry.olKey)
        .then(meta => {
          descCache.current.set(entry.olKey, { status: 'ready', text: meta.description });
          bumpCache();
        })
        .catch(() => {
          descCache.current.set(entry.olKey, { status: 'ready', text: null });
          bumpCache();
        });
    }
  }

  const currentNorm = currentTitle ? _normTitle(currentTitle) : '';

  // Split released vs upcoming. "Upcoming" = year > current year (May 2026
  // → upcoming starts at 2027). OL routinely lists pre-announced titles
  // with their planned release year — we surface those at the top so a
  // reader can spot "new from this author" before they commit a back-list
  // pick.
  const upcoming = useMemo(() => {
    if (!bib) return [];
    return bib.entries.filter(e => e.year != null && e.year > CURRENT_YEAR);
  }, [bib]);

  const released = useMemo(() => {
    if (!bib) return [];
    return bib.entries.filter(e => e.year == null || e.year <= CURRENT_YEAR);
  }, [bib]);

  // Released catalog stays chronological. We deliberately removed the
  // "By rating" sort because the only signal we had for it was Open
  // Library's aggregated reader rating, which we no longer surface — the
  // app should reflect Readstack community ratings only.
  const sortedReleased = released;

  const totalDated = bib ? bib.entries.filter(e => e.year != null).length : 0;
  const currentEntry = bib?.entries.find(e => _normTitle(e.title) === currentNorm) ?? null;

  // Hero stack — three covers, picked from the most recent dated works
  // that have artwork. Recency is a reasonable visual proxy now that we
  // no longer have rating/popularity signal from OL.
  const heroCovers = useMemo(() => {
    if (!bib) return [];
    const withCovers = bib.entries.filter(e => !!e.coverUrl && e.year != null);
    const ranked = [...withCovers].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
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
                {upcoming.length > 0 ? ` · ${upcoming.length} upcoming` : ''}
              </Text>

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

            {/* Upcoming releases — surfaced above the regular catalog so a
                reader can spot pre-announced books before browsing back-list. */}
            {upcoming.length > 0 && (
              <View style={{ paddingHorizontal: 20, marginBottom: 22 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <View style={{
                    backgroundColor: '#fef0d8',
                    borderRadius: 4,
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    marginRight: 8,
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: '#a36a14', letterSpacing: 0.8 }}>
                      COMING SOON
                    </Text>
                  </View>
                  <Text style={{ fontSize: 12, color: '#9e958d' }}>
                    Announced for future release
                  </Text>
                </View>
                <View style={{
                  backgroundColor: '#fefcf9',
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: '#f0d9a8',
                  overflow: 'hidden',
                }}>
                  {upcoming.map((entry, idx) => (
                    <BibRow
                      key={entry.olKey}
                      entry={entry}
                      isCurrent={_normTitle(entry.title) === currentNorm}
                      isLast={idx === upcoming.length - 1}
                      isUpcoming
                      isExpanded={expandedKey === entry.olKey}
                      descState={descCache.current.get(entry.olKey)}
                      onToggle={() => toggleExpanded(entry)}
                    />
                  ))}
                </View>
              </View>
            )}

            {/* Released catalog — chronological by decade */}
            <View style={{ paddingHorizontal: 20 }}>
              {_groupByDecade(sortedReleased).map(([decade, items]) => (
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
                        isExpanded={expandedKey === entry.olKey}
                        descState={descCache.current.get(entry.olKey)}
                        onToggle={() => toggleExpanded(entry)}
                      />
                    ))}
                  </View>
                </View>
              ))}
            </View>

            {/* Footer attribution — catalog only. Ratings are intentionally
                absent here; star ratings on Readstack are sourced from app
                users (`user_books.rating`), not Open Library readers. */}
            <View style={{ paddingHorizontal: 24, marginTop: 4 }}>
              <Text style={{
                fontSize: 11,
                color: '#a8a098',
                textAlign: 'center',
                lineHeight: 16,
              }}>
                Catalog from <Text style={{ fontWeight: '700' }}>Open Library</Text>, an open-data project run by the Internet Archive. Some early or self-published works may be missing artwork or metadata.
              </Text>
            </View>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function BibRow({
  entry, isCurrent, isLast, isUpcoming, isExpanded, descState, onToggle,
}: {
  entry:      AuthorBibliographyEntry;
  isCurrent:  boolean;
  isLast:     boolean;
  isUpcoming?: boolean;
  isExpanded: boolean;
  descState:  DescState | undefined;
  onToggle:   () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onToggle}
      activeOpacity={0.7}
      style={{
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: '#f0ece6',
        backgroundColor: isCurrent ? SAGE_BG : 'transparent',
        borderLeftWidth: isCurrent ? 3 : 0,
        borderLeftColor: isCurrent ? SAGE : 'transparent',
      }}
    >
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}>
        <CoverOrPlaceholder coverUrl={entry.coverUrl} title={entry.title} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            style={{ fontSize: 14, fontWeight: '700', color: '#231f1b', lineHeight: 19 }}
            numberOfLines={2}
          >
            {entry.title}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 12, color: '#78716c' }}>
              {isUpcoming
                ? `Expected ${entry.year}`
                : (entry.year ?? 'Undated')}
              {entry.pageCount ? ` · ${entry.pageCount} pp` : ''}
            </Text>
          </View>
          {isCurrent && (
            <Text style={{ fontSize: 11, fontWeight: '700', color: SAGE_INK, marginTop: 4, letterSpacing: 0.3 }}>
              CURRENTLY VIEWING
            </Text>
          )}
        </View>
        <Ionicons
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color="#a8a098"
          style={{ marginLeft: 6 }}
        />
      </View>

      {/* Expanded detail strip — lazy-loaded description from /works/.json */}
      {isExpanded && (
        <View style={{
          paddingHorizontal: 14,
          paddingBottom: 14,
          paddingTop: 0,
        }}>
          <View style={{
            backgroundColor: '#f5f1ec',
            borderRadius: 10,
            padding: 12,
            marginLeft: 58, // align with the text column above (cover 46 + margin 12)
          }}>
            {(!descState || descState.status === 'loading') && (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#9e958d" />
                <Text style={{ fontSize: 12, color: '#9e958d', marginLeft: 8 }}>
                  Loading details…
                </Text>
              </View>
            )}
            {descState?.status === 'ready' && descState.text && (
              <Text style={{ fontSize: 12.5, color: '#57534e', lineHeight: 18 }}>
                {descState.text.replace(/\s+/g, ' ').trim()}
              </Text>
            )}
            {descState?.status === 'ready' && !descState.text && (
              <Text style={{ fontSize: 12, color: '#a8a098', fontStyle: 'italic' }}>
                {isUpcoming
                  ? 'No description available yet — this title hasn\'t been released.'
                  : 'No description on file at Open Library for this title.'}
              </Text>
            )}
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

// Cover image with a designed fallback when artwork is missing. The
// placeholder uses the title's initials on a sage swatch with a faint
// "spine" stripe so it reads as an intentional design choice rather than
// a broken image. Same dimensions as the real cover so list rhythm holds.
function CoverOrPlaceholder({ coverUrl, title }: { coverUrl: string | null; title: string }) {
  const [errored, setErrored] = useState(false);
  if (coverUrl && !errored) {
    return (
      <Image
        source={{ uri: coverUrl }}
        style={{ width: 46, height: 68, borderRadius: 3, backgroundColor: '#ede9e4' }}
        resizeMode="cover"
        onError={() => setErrored(true)}
      />
    );
  }
  return (
    <View style={{
      width: 46,
      height: 68,
      borderRadius: 3,
      backgroundColor: SAGE_BG,
      borderWidth: 1,
      borderColor: '#d4dfd4',
      overflow: 'hidden',
      flexDirection: 'row',
    }}>
      {/* Faux spine stripe — sells the "book" silhouette */}
      <View style={{ width: 4, backgroundColor: SAGE_DEEP, opacity: 0.25 }} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 13, fontWeight: '800', color: SAGE_DEEP, letterSpacing: 0.5 }}>
          {_titleInitials(title)}
        </Text>
        <Ionicons name="book-outline" size={10} color={SAGE_DEEP} style={{ marginTop: 3, opacity: 0.5 }} />
      </View>
    </View>
  );
}
