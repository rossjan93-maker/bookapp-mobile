import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CoverThumb } from './CoverThumb';
import { fitLabel, fitColor } from '../lib/recommender';
import type { ScoredBook } from '../lib/recommender';
import type { DeterministicLane } from '../lib/bookTraits';
import { getSeriesCatalog } from '../lib/seriesCatalog';

// Suppress unused-import warning (fitLabel / fitColor kept for future use)
void fitLabel; void fitColor;

// ─── Text helpers ─────────────────────────────────────────────────────────────

function stripAuthorPrefix(reason: string, author: string): string {
  const prefix = `By ${author}, `;
  if (reason.startsWith(prefix)) return reason.slice(prefix.length);
  if (reason.toLowerCase().startsWith(prefix.toLowerCase())) return reason.slice(prefix.length);
  return reason;
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Returns a naturally articled reference to a series/saga name for inline use.
function naturalArticle(name: string): string {
  if (/^(a|an)\s+/i.test(name)) return name;
  if (/^the\s+/i.test(name))    return `the ${name.replace(/^the\s+/i, '')}`;
  return `the ${name}`;
}

const EXPLANATION_LANE_LABELS: Record<DeterministicLane, string> = {
  romantasy:            'romantic fantasy',
  scifi_fantasy:        'fantasy and speculative fiction',
  modern_suspense:      'psychological suspense',
  romance:              'emotionally driven romance',
  contemporary_fiction: 'contemporary fiction',
  memoir_nonfiction:    'narrative nonfiction',
  literary:             'literary fiction',
  horror:               'dark atmospheric fiction',
};

// Build a single behavior-driven explanation anchored to ONE concrete user signal.
function buildExplanation(book: ScoredBook, _hasSeriesMeta: boolean): string | null {
  const bd = book._score_breakdown;

  if (bd.saga_label && bd.saga_name) {
    switch (bd.saga_label) {
      case 'saga_entry':
        return `Begin where ${naturalArticle(bd.saga_name)} saga starts.`;
      case 'saga_continuation':
        return `Continue ${naturalArticle(bd.saga_name)} saga.`;
      case 'saga_next_series':
        return `Next chapter of ${naturalArticle(bd.saga_name)} saga.`;
    }
  }

  if (bd.series_position != null && bd.series_name) {
    const pos  = bd.series_position;
    const name = bd.series_name;
    if (pos === 1) {
      return `Start with book one of ${naturalArticle(name)}.`;
    }
    const maxRead    = bd.series_max_read     ?? null;
    const contiguous = bd.series_is_contiguous ?? null;
    if (maxRead != null && maxRead > 0) {
      if (contiguous === true) {
        return `Continue ${naturalArticle(name)} series \u2014 book ${pos}`;
      }
      return `Continue ${naturalArticle(name)} series`;
    }
  }

  const authorCount = bd.author_books_read ?? 0;
  if (authorCount >= 2) {
    return `Another strong read from ${book.author}`;
  }

  const laneLabel = bd.book_lane
    ? (EXPLANATION_LANE_LABELS[bd.book_lane as DeterministicLane] ?? null)
    : null;
  if (bd.fit_class === 'core_fit' && laneLabel) {
    return `A strong fit for your taste in ${laneLabel}.`;
  }

  if (book.reasons.length > 0) {
    const raw = capitalize(stripAuthorPrefix(book.reasons[0], book.author));
    if (raw === 'Fits a genre you consistently enjoy' && laneLabel) {
      return `A consistent pick for your taste in ${laneLabel}.`;
    }
    return raw;
  }

  return null;
}

type SeriesCover = { olKey: string; coverId: number | null; title: string };

// ─── VariantBadge ─────────────────────────────────────────────────────────────
function VariantBadge({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <View style={{
      alignSelf: 'flex-start', marginBottom: 6,
      paddingHorizontal: 7, paddingVertical: 3,
      borderRadius: 6, backgroundColor: bg,
    }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color, letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}

// ─── RecCard ──────────────────────────────────────────────────────────────────
export function RecCard({
  book,
  isExpert          = false,
  featured          = false,
  onSave            = () => {},
  onDismiss         = () => {},
  onMoreLikeThis    = () => {},
  onImpression      = () => {},
  onExplanationOpen = () => {},
}: {
  book:               ScoredBook;
  isExpert?:          boolean;
  featured?:          boolean;
  onSave?:            () => void;
  onDismiss?:         () => void;
  onMoreLikeThis?:    () => void;
  onImpression?:      () => void;
  onExplanationOpen?: () => void;
}) {
  const router = useRouter();

  const opacity        = useRef(new Animated.Value(1)).current;
  const cardTranslateY = useRef(new Animated.Value(0)).current;
  const cardScale      = useRef(new Animated.Value(1)).current;

  const [moreDone, setMoreDone]           = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [confirmState, setConfirmState]   = useState<'save' | 'more' | 'dismiss' | null>(null);
  const [seriesCovers, setSeriesCovers]   = useState<SeriesCover[]>([]);
  const impressionFired = useRef(false);

  useEffect(() => {
    if (!impressionFired.current) {
      impressionFired.current = true;
      onImpression();
      if (__DEV__) console.log('[REC_CONFIDENCE]', `book_id=${book.id}`, `score=${book.score}`, `tier=${book.confidence}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sn = book._score_breakdown.series_name;
    const sp = book._score_breakdown.series_position;
    if (!sn || sp == null) return;
    const meta = getSeriesCatalog(sn);
    if (!meta) return;
    const BAD_EDITION = /collection|omnibus|boxed|box set|complete works|anthology/i;
    const fetchCover = async (b: { title: string; author: string }): Promise<SeriesCover | null> => {
      try {
        const url = [
          'https://openlibrary.org/search.json',
          `?title=${encodeURIComponent(b.title)}`,
          `&author=${encodeURIComponent(b.author)}`,
          '&fields=key,title,cover_i&limit=5',
        ].join('');
        const data: { docs?: Array<{ key: string; cover_i?: number; title?: string }> } =
          await fetch(url).then(r => r.json());
        const docs  = data.docs ?? [];
        const clean = docs.find(d => d.cover_i != null && !BAD_EDITION.test(d.title ?? ''));
        if (!clean || clean.cover_i == null) return null;
        return { olKey: clean.key, coverId: clean.cover_i, title: clean.title ?? b.title };
      } catch { return null; }
    };
    let cancelled = false;
    Promise.all(meta.orderedBooks.map(fetchCover)).then(results => {
      if (cancelled) return;
      setSeriesCovers(results.map((r, i): SeriesCover =>
        r ?? { olKey: `placeholder-${i}`, coverId: null, title: meta.orderedBooks[i].title }
      ));
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function animateOut(cb: () => void) {
    if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'phase=exit', 'duration_ms=220');
    Animated.parallel([
      Animated.timing(opacity,        { toValue: 0,    duration: 220, useNativeDriver: true }),
      Animated.timing(cardTranslateY, { toValue: -16,  duration: 220, useNativeDriver: true }),
      Animated.timing(cardScale,      { toValue: 0.96, duration: 220, useNativeDriver: true }),
    ]).start(() => cb());
  }

  function handleSavePress() {
    if (pendingAction) return;
    setPendingAction(true);
    setConfirmState('save');
    if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=save', 'phase=confirm');
    setTimeout(() => animateOut(onSave), 350);
  }

  function handleDismissPress() {
    if (pendingAction) return;
    setPendingAction(true);
    setConfirmState('dismiss');
    if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=dismiss', 'phase=confirm');
    setTimeout(() => {
      animateOut(() => {
        opacity.setValue(1);
        cardTranslateY.setValue(0);
        cardScale.setValue(1);
        if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=dismiss', 'phase=reflow');
        onDismiss();
      });
    }, 200);
  }

  function handleMoreLikeThisPress() {
    if (pendingAction || moreDone) return;
    setPendingAction(true);
    setMoreDone(true);
    setConfirmState('more');
    if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=more', 'phase=confirm');
    setTimeout(() => animateOut(onMoreLikeThis), 350);
  }

  function handleCardPress() {
    if (pendingAction) return;
    const sn = book._score_breakdown.series_name;
    const sp = book._score_breakdown.series_position;
    router.push({
      pathname: '/book/[id]',
      params: {
        id:         book.external_id?.replace('/works/', '') ?? 'rec',
        title:      book.title,
        author:     book.author,
        coverUrl:   book.cover_url ?? '',
        externalId: book.external_id ?? '',
        ...(sn && sp != null ? { seriesName: sn, seriesPosition: String(sp) } : {}),
      },
    });
    onExplanationOpen();
  }

  const seriesPos   = book._score_breakdown.series_position;
  const seriesTotal = book._score_breakdown.series_total;
  const catalogMeta = getSeriesCatalog(book._score_breakdown.series_name ?? '');
  const hasSeriesMeta =
    catalogMeta != null &&
    seriesPos   != null &&
    seriesTotal != null;

  const collapsedReason = buildExplanation(book, hasSeriesMeta);

  return (
    <Animated.View style={{
      opacity,
      transform: [{ translateY: cardTranslateY }, { scale: cardScale }],
      backgroundColor: '#fff',
      borderRadius: 14,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOpacity: featured ? 0.07 : 0.04,
      shadowRadius: featured ? 10 : 6,
      shadowOffset: { width: 0, height: featured ? 2 : 1 },
      elevation: featured ? 2 : 1,
      overflow: 'hidden',
      ...(featured ? { borderWidth: 1, borderColor: '#e7e5e4' } : {}),
    }}>
      {featured && <View style={{ height: 3, backgroundColor: '#1c1917' }} />}

      <TouchableOpacity
        onPress={handleCardPress}
        activeOpacity={0.75}
        style={{ padding: 12, flexDirection: 'row', alignItems: 'flex-start' }}
      >
        <CoverThumb
          url={book.cover_url}
          externalId={book.external_id}
          title={book.title}
          width={featured ? 52 : 44}
          height={featured ? 76 : 64}
        />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            style={{ fontSize: 15, fontWeight: '700', color: '#1c1917', lineHeight: 21, marginBottom: 3 }}
            numberOfLines={2}
          >
            {book.title}
          </Text>

          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6 }}>
            <Text style={{ fontSize: 12, color: '#78716c', flex: 1 }} numberOfLines={1}>
              {book.author}
            </Text>
            {(() => {
              const tier  = book.confidence;
              const label = tier === 'high' ? 'Top pick' : tier === 'medium' ? 'Good fit' : 'Explore';
              const bg    = tier === 'high' ? '#f0fdf4' : tier === 'medium' ? '#f8f8f7' : '#fafaf9';
              const col   = tier === 'high' ? '#15803d' : tier === 'medium' ? '#57534e' : '#a8a29e';
              const bord  = tier === 'high' ? '#bbf7d0' : tier === 'medium' ? '#e7e5e4' : '#e7e5e4';
              return (
                <View style={{
                  backgroundColor: bg, borderWidth: 1, borderColor: bord,
                  borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2,
                }}>
                  <Text style={{ fontSize: 9, fontWeight: '700', color: col, letterSpacing: 0.3 }}>
                    {label.toUpperCase()}
                  </Text>
                </View>
              );
            })()}
            {isExpert && (
              <View style={{
                backgroundColor: '#1c1917', borderRadius: 4,
                paddingHorizontal: 5, paddingVertical: 2,
              }}>
                <Text style={{ fontSize: 9, fontWeight: '700', color: '#faf9f7', letterSpacing: 0.4 }}>
                  EXPERT PICK
                </Text>
              </View>
            )}
          </View>

          {hasSeriesMeta && (
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, marginBottom: 8 }}>
              {catalogMeta!.orderedBooks.map((b, i) => {
                const isCurrent = (i + 1) === seriesPos;
                const cover     = seriesCovers[i];
                const coverUri  = cover?.coverId
                  ? `https://covers.openlibrary.org/b/id/${cover.coverId}-S.jpg`
                  : null;
                return (
                  <View
                    key={`${b.title}-${i}`}
                    style={{
                      opacity:      isCurrent ? 1 : 0.38,
                      borderWidth:  isCurrent ? 1.5 : 0,
                      borderColor:  '#1c1917',
                      borderRadius: 4,
                    }}
                  >
                    {coverUri ? (
                      <Image
                        source={{ uri: coverUri }}
                        style={{
                          width:           isCurrent ? 34 : 27,
                          height:          isCurrent ? 50 : 42,
                          borderRadius:    3,
                          backgroundColor: '#e7e5e4',
                        }}
                      />
                    ) : (
                      <View style={{
                        width:           isCurrent ? 34 : 27,
                        height:          isCurrent ? 50 : 42,
                        borderRadius:    3,
                        backgroundColor: '#ece9e4',
                        borderWidth:     1,
                        borderColor:     '#e0dbd4',
                      }} />
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {(() => {
            const bd = book._score_breakdown;
            const isStarter      = bd.series_label === 'series_starter' || bd.saga_label === 'saga_entry';
            const isContinuation = bd.series_label === 'series_continuation' || bd.saga_label === 'saga_continuation' || bd.saga_label === 'saga_next_series';
            const isAuthorMatch  = !isStarter && !isContinuation && (bd.author_books_read ?? 0) >= 2;
            if (isStarter)      return <VariantBadge label="Start here"      bg="#fef3c7" color="#92400e" />;
            if (isContinuation) return <VariantBadge label="Continue series" bg="#f0fdf4" color="#166534" />;
            if (isAuthorMatch)  return <VariantBadge label="Author match"    bg="#f5f3ff" color="#5b21b6" />;
            return null;
          })()}

          {collapsedReason && (
            <Text
              style={{ fontSize: 13, fontWeight: '600', color: '#1c1917', lineHeight: 18, marginBottom: 2 }}
              numberOfLines={2}
            >
              {collapsedReason}
            </Text>
          )}
        </View>
      </TouchableOpacity>

      {/* ── Action bar ── */}
      <View style={{ borderTopWidth: 1, borderTopColor: '#f0eeeb', flexDirection: 'row', alignItems: 'stretch' }}>
        <TouchableOpacity
          onPress={handleSavePress}
          disabled={pendingAction}
          style={{ flex: 1, paddingVertical: 14, paddingHorizontal: 14, justifyContent: 'center', borderRightWidth: 1, borderRightColor: '#f0eeeb' }}
        >
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917' }}>Want to Read</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleDismissPress}
          disabled={pendingAction}
          style={{ paddingVertical: 14, paddingHorizontal: 13, justifyContent: 'center', alignItems: 'center', borderRightWidth: 1, borderRightColor: '#f0eeeb' }}
        >
          <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '500' }}>Not for me</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleMoreLikeThisPress}
          disabled={pendingAction}
          style={{ paddingVertical: 14, paddingHorizontal: 13, justifyContent: 'center', alignItems: 'center' }}
        >
          <Text style={{ fontSize: 12, fontWeight: '500', color: '#78716c' }}>More like this</Text>
        </TouchableOpacity>
      </View>

      {confirmState && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: confirmState === 'save' ? '#f0fdf4' : confirmState === 'dismiss' ? '#f5f5f4' : '#faf5ff',
          borderRadius: 14,
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 20,
          gap: 4,
        }}>
          {confirmState === 'save' ? (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#15803d' }}>✓  Added to your list</Text>
              <Text style={{ fontSize: 12, color: '#166534' }}>Saved to Want to Read</Text>
            </>
          ) : confirmState === 'dismiss' ? (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#78716c' }}>Skipped</Text>
              <Text style={{ fontSize: 12, color: '#a8a29e' }}>We'll note this preference</Text>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#6d28d9' }}>Got it — tuning your picks</Text>
              <Text style={{ fontSize: 12, color: '#7c3aed' }}>Future recs will reflect this taste</Text>
            </>
          )}
        </View>
      )}
    </Animated.View>
  );
}

// ─── UndoToast ────────────────────────────────────────────────────────────────
// Floating snackbar shown after a dismiss. Slides up from below.
export function UndoToast({ book, onUndo }: { book: ScoredBook; onUndo: () => void }) {
  const translateY = useRef(new Animated.Value(10)).current;
  const fadeIn     = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(fadeIn,     { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View style={{
      opacity: fadeIn,
      transform: [{ translateY }],
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#1c1917',
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 8,
      gap: 8,
    }}>
      <Text style={{ flex: 1, fontSize: 12, color: '#a8a29e' }} numberOfLines={1}>
        Skipped{' '}
        <Text style={{ color: '#e7e5e4', fontWeight: '600' }}>"{book.title}"</Text>
      </Text>
      <TouchableOpacity
        onPress={onUndo}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{ backgroundColor: '#292524', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}
      >
        <Text style={{ fontSize: 12, fontWeight: '700', color: '#faf9f7' }}>Undo</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── RecSkeletonCard ──────────────────────────────────────────────────────────
export function RecSkeletonCard() {
  return (
    <View style={{
      backgroundColor: '#fff', borderRadius: 14, padding: 16,
      marginBottom: 8, height: 110,
      shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 }, elevation: 1,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 44, height: 64, backgroundColor: '#f5f5f4', borderRadius: 6 }} />
        <View style={{ flex: 1, gap: 8 }}>
          <View style={{ height: 14, backgroundColor: '#f5f5f4', borderRadius: 6, width: '72%' }} />
          <View style={{ height: 11, backgroundColor: '#f5f5f4', borderRadius: 6, width: '48%' }} />
          <View style={{ height: 11, backgroundColor: '#f5f5f4', borderRadius: 6, width: '88%' }} />
        </View>
      </View>
    </View>
  );
}
