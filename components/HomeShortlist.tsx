/**
 * Home Shortlist (Batch V4) — top-of-Home next-read surface.
 *
 * Read-only consumer of the existing recommendation cache. Renders up to 3
 * compact next-read picks from `getRecSession()` when a fresh, user-matched,
 * unacted-on cache exists. Otherwise renders an honest CTA (cold cache → For
 * You; thin profile → Add a book) or hides silently.
 *
 * Hard contract:
 *   - Never calls runPipeline / getPersonalizedRecsWithExpert / triggerRecPrewarm.
 *   - Never calls setRecSession or clearRecSession.
 *   - Never triggers a new recommendation fetch.
 *   - Reads getRecSession() (sync, in-memory) and loadActedOnIds() (AsyncStorage).
 *   - 2-hour freshness window via loadedAt; userId mismatch / stale → cold cache.
 *   - Tap-through preserves rec context via setRecContext, mirroring RecCard.
 */

import { useCallback, useEffect, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { CoverThumb } from './CoverThumb';
import { getRecSession } from '../lib/recSession';
import { loadActedOnIds } from '../lib/recPayloadCache';
import { setRecContext } from '../lib/recContext';
import { INK, SAGE_BG, SAGE_DEEP, SAGE_INK } from '../lib/tokens';
import type { ScoredBook } from '../lib/recommender';

const STALE_MS = 2 * 60 * 60 * 1000; // 2h — mirrors recPayloadCache TTL
const MAX_PICKS = 3;

type Props = {
  userId:      string | null;
  librarySize: number;
};

type State =
  | { kind: 'hot'; picks: ScoredBook[] }
  | { kind: 'cold' }
  | { kind: 'thin' }
  | { kind: 'hidden' };

function deriveState(
  userId:           string | null,
  actedOn:          Set<string>,
  actedOnReadyUid:  string | null,
  librarySize:      number,
): State {
  // Thin proxy: zero books in any current-progress / year-stack surface.
  // (Avoids adding a TasteProfile fetch on Home; the For-You feed itself
  // handles tier<1 with its own onboarding nudge if the user routes there.)
  const isThinProxy = librarySize === 0;
  const fallback: State = isThinProxy ? { kind: 'thin' } : { kind: 'cold' };

  if (!userId) return fallback;

  const s = getRecSession();
  if (!s) return fallback;
  if (s.userId !== userId) return fallback;
  if (Date.now() - (s.loadedAt ?? 0) > STALE_MS) return fallback;

  // Race guard: never render `hot` until the acted-on AsyncStorage read has
  // resolved for the *current* userId. Without this, the very first paint
  // could show a card the user just dismissed in For You. Until ready we
  // pessimistically render the cold/thin fallback (always honest).
  if (actedOnReadyUid !== userId) return fallback;

  const pool = (s.discoveries?.length ? s.discoveries : s.recs) ?? [];
  if (pool.length === 0) return fallback;

  const filtered = pool.filter(b => {
    const ext = b.external_id ?? '';
    const id  = b.id ?? '';
    return !(ext && actedOn.has(ext)) && !(id && actedOn.has(id));
  });

  // Pool exists but everything has been acted on → hide silently (per V4 spec).
  if (filtered.length === 0) return { kind: 'hidden' };

  return { kind: 'hot', picks: filtered.slice(0, MAX_PICKS) };
}

function buildShortReason(book: ScoredBook): string | null {
  const r0 = (book.reasons ?? [])[0];
  if (!r0) return null;
  const stripped = r0.replace(/^By [^,]+,\s*/i, '');
  const trimmed  = stripped.length > 70 ? stripped.slice(0, 67).trimEnd() + '…' : stripped;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function HomeShortlist({ userId, librarySize }: Props) {
  const router = useRouter();
  const [actedOn,         setActedOn]         = useState<Set<string>>(new Set());
  const [actedOnReadyUid, setActedOnReadyUid] = useState<string | null>(null);
  const [version,         setVersion]         = useState(0);
  const [state,           setState]           = useState<State>(() =>
    deriveState(userId, new Set(), null, librarySize),
  );

  // Reset acted-on state immediately on userId transition (sign-out, account
  // switch) so the previous user's filter set never bleeds into the new
  // session before the next load resolves.
  useEffect(() => {
    setActedOn(new Set());
    setActedOnReadyUid(null);
  }, [userId]);

  // On focus: refresh acted-on set (read-only AsyncStorage) and bump version
  // to force a re-derive that picks up any new recSession data populated by
  // the For You tab while Home was unmounted/blurred.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (userId) {
          try {
            const acted = await loadActedOnIds(userId);
            if (!cancelled) {
              setActedOn(acted);
              setActedOnReadyUid(userId);
            }
          } catch {
            // fail-soft: mark ready with empty set so we don't block forever
            if (!cancelled) setActedOnReadyUid(userId);
          }
        }
        if (!cancelled) setVersion(v => v + 1);
      })();
      return () => { cancelled = true; };
    }, [userId]),
  );

  useEffect(() => {
    setState(deriveState(userId, actedOn, actedOnReadyUid, librarySize));
  }, [userId, actedOn, actedOnReadyUid, librarySize, version]);

  if (state.kind === 'hidden') return null;

  // ── Empty / honest CTA states ───────────────────────────────────────────
  if (state.kind === 'thin' || state.kind === 'cold') {
    const isThin    = state.kind === 'thin';
    const headline  = isThin ? 'Build your shortlist' : 'Your shortlist is waiting';
    const subline   = isThin
      ? 'Add or rate a few books to unlock sharper picks.'
      : 'Head to For You to generate your next picks.';
    const ctaLabel  = isThin ? 'Add a book' : 'See my picks';
    const ctaTarget = isThin ? '/add-book' : '/(tabs)/search';

    return (
      <View style={{ marginBottom: 32 }}>
        <Text style={{
          fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
          color: SAGE_DEEP, textTransform: 'uppercase', marginBottom: 12,
        }}>
          Your next-read shortlist
        </Text>
        <View style={{ backgroundColor: SAGE_BG, borderRadius: 14, padding: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: INK, marginBottom: 4 }}>
            {headline}
          </Text>
          <Text style={{ fontSize: 13, color: SAGE_INK, marginBottom: 12 }}>
            {subline}
          </Text>
          <TouchableOpacity
            onPress={() => router.push(ctaTarget as never)}
            style={{
              alignSelf: 'flex-start', backgroundColor: SAGE_DEEP,
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
            }}
            accessibilityRole="button"
            accessibilityLabel={ctaLabel}
          >
            <Text style={{ color: '#fefcf9', fontSize: 13, fontWeight: '600' }}>
              {ctaLabel}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Hot cache: up to 3 compact picks ────────────────────────────────────
  return (
    <View style={{ marginBottom: 32 }}>
      <View style={{
        flexDirection: 'row', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: 12,
      }}>
        <Text style={{
          fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
          color: SAGE_DEEP, textTransform: 'uppercase',
        }}>
          Your next-read shortlist
        </Text>
        <TouchableOpacity
          onPress={() => router.push('/(tabs)/search' as never)}
          accessibilityRole="button"
          accessibilityLabel="See all picks"
        >
          <Text style={{ fontSize: 12, fontWeight: '600', color: SAGE_DEEP }}>
            See all picks ›
          </Text>
        </TouchableOpacity>
      </View>

      <View style={{ gap: 10 }}>
        {state.picks.map(book => {
          const reason = buildShortReason(book);
          const onPress = () => {
            // Mirror RecCard's tap-through: write rec context so book detail
            // can render "Why this book?". Synchronous in-memory only —
            // no DB writes from Home.
            if (book.external_id) {
              setRecContext(book.external_id, {
                explanation:  reason,
                evidenceTags: [],
              });
            }
            router.push({
              pathname: '/book/[id]',
              params: {
                id:         book.external_id?.replace('/works/', '') ?? book.id,
                title:      book.title,
                author:     book.author,
                coverUrl:   book.cover_url ?? '',
                externalId: book.external_id ?? '',
              },
            });
          };

          return (
            <TouchableOpacity
              key={book.id}
              onPress={onPress}
              style={{
                flexDirection: 'row', gap: 12, padding: 10,
                backgroundColor: '#fdfaf5', borderRadius: 12,
                borderWidth: 1, borderColor: '#ece6dc',
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open ${book.title} by ${book.author}`}
            >
              <CoverThumb
                url={book.cover_url}
                externalId={book.external_id}
                editionKey={null}
                title={book.title}
                width={48}
                height={70}
              />
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <Text numberOfLines={2} style={{ fontSize: 14, fontWeight: '600', color: INK }}>
                  {book.title}
                </Text>
                <Text numberOfLines={1} style={{ fontSize: 12, color: '#7a6f60', marginTop: 2 }}>
                  {book.author}
                </Text>
                {reason && (
                  <Text numberOfLines={1} style={{
                    fontSize: 11, color: SAGE_INK, marginTop: 4, fontStyle: 'italic',
                  }}>
                    {reason}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}
