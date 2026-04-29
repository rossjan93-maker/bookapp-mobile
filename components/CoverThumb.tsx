import { useState, useRef } from 'react';
import { Animated, Text, View } from 'react-native';
import { isCredibleCoverUrl } from '../lib/coverCredibility';
import {
  isCoverUrlKnownFailed,
  markCoverUrlFailed,
} from '../lib/coverCache';

// ── Design tokens (kept local — no runtime import needed) ─────────────────────
const DUST   = '#9e958d';
const STONE  = '#6b635c';
const BORDER = '#ede9e4';
const SAGE   = '#7b9e7e';
const BG     = '#f5f1ec';

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveCoverUrl(externalId: string, editionKey?: string | null): string | null {
  if (editionKey) {
    return `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg`;
  }
  const match = externalId.match(/\/works\/(OL\w+)/);
  if (!match) return null;
  return `https://covers.openlibrary.org/w/olid/${match[1]}-M.jpg`;
}

/**
 * Extracts up to two initials from a title for use in the typographic fallback.
 * "The Night Circus" → "TN"
 * "Dune"            → "D"
 * Articles (a/an/the) at the start are skipped when a second word is present.
 */
function titleInitials(title: string): string {
  const STOP_WORDS = new Set(['a', 'an', 'the']);
  const words = title
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0);

  const meaningful = words.filter(w => !STOP_WORDS.has(w.toLowerCase()));
  const source     = meaningful.length > 0 ? meaningful : words;

  return source
    .slice(0, 2)
    .map(w => w.charAt(0).toUpperCase())
    .join('');
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  url?:        string | null;
  externalId?: string | null;
  editionKey?: string | null;
  title?:      string | null;
  width?:      number;
  height?:     number;
  radius?:     number;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function CoverThumb({
  url,
  externalId,
  editionKey,
  title,
  width  = 40,
  height = 58,
  radius = 5,
}: Props) {
  const imgOpacity = useRef(new Animated.Value(0)).current;
  const [imgFailed, setImgFailed] = useState(false);

  const style = { width, height, borderRadius: radius };

  // Cover-source precedence (matches lib/coverResolver.ts):
  //   1. editionKey  → user explicitly picked this edition (highest trust)
  //   2. url         → canonical cover_url stored on the book row
  //   3. external_id → /works/OL...W derived OL URL (last resort)
  //
  // Why editionKey beats url: every list surface passes the same generic
  // books.cover_url, but only some readers will have picked a specific
  // edition. When they do, that pick must win on every surface (Home,
  // Library, Detail, Inbox), otherwise covers visibly disagree across
  // screens — the trust bug reported in user testing.
  //
  // OL CDN URLs can 404 silently; we use the session-level coverCache to
  // avoid re-attempting URLs that already failed and to fall through to the
  // next precedence step instead of leaving a blank box.
  const editionUrl = editionKey
    ? `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg`
    : null;
  const externalUrl = externalId ? deriveCoverUrl(externalId, null) : null;

  const editionLive  = editionUrl  && !isCoverUrlKnownFailed(editionUrl)  ? editionUrl  : null;
  const externalLive = externalUrl && !isCoverUrlKnownFailed(externalUrl) ? externalUrl : null;
  const urlLive      = url         && !isCoverUrlKnownFailed(url)         ? url         : null;

  const rawSrc = editionLive || urlLive || externalLive;

  // ── Credibility guard ─────────────────────────────────────────────────────
  // Reject URLs that don't come from known provider domains. A rejected URL
  // falls through to the typographic fallback exactly as if no URL existed.
  const src = rawSrc && isCredibleCoverUrl(rawSrc) ? rawSrc : null;

  // ── Image path ────────────────────────────────────────────────────────────
  if (src && !imgFailed) {
    return (
      <View style={[style, { backgroundColor: BORDER, overflow: 'hidden' }]}>
        <Animated.Image
          source={{ uri: src }}
          style={[
            { position: 'absolute', top: 0, left: 0, width, height },
            { opacity: imgOpacity },
          ]}
          resizeMode="cover"
          onLoad={() =>
            Animated.timing(imgOpacity, {
              toValue:         1,
              duration:        220,
              useNativeDriver: true,
            }).start()
          }
          onError={() => {
            // Cache this URL so re-renders of the same book skip the attempt.
            markCoverUrlFailed(src);
            setImgFailed(true);
          }}
        />
        {/* Placeholder background visible during fade-in */}
      </View>
    );
  }

  // ── Typographic fallback ──────────────────────────────────────────────────
  // Shown when: no URL, credibility check failed, or image failed to load.
  // Design: parchment background + SAGE accent strip + initial(s) + label.

  const initials   = title ? titleInitials(title) : '';
  const isLarge    = width >= 56;     // featured card or book detail hero
  const letterSize = isLarge
    ? Math.round(width * 0.36)        // 2-char initials fit better smaller
    : Math.round(width * 0.42);       // single-char initial, slightly larger

  if (!initials) {
    // Absolute fallback — no title provided at all
    return <View style={[style, { backgroundColor: BORDER }]} />;
  }

  return (
    <View style={[style, { backgroundColor: BG, overflow: 'hidden' }]}>
      {/* SAGE accent strip at top — makes it look intentional, not broken */}
      <View style={{ height: 3, backgroundColor: SAGE, width: '100%' }} />

      {/* Centred typographic content */}
      <View style={{
        flex: 1,
        alignItems:     'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
      }}>
        <Text
          style={{
            fontSize:   letterSize,
            fontWeight: '700',
            color:      STONE,
            letterSpacing: isLarge ? 2 : 0.5,
            lineHeight: letterSize * 1.1,
          }}
          numberOfLines={1}
        >
          {initials}
        </Text>

        {/* "NO COVER" micro-label — only on large enough surfaces */}
        {isLarge && (
          <Text
            style={{
              fontSize:      7,
              fontWeight:    '600',
              color:         DUST,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              marginTop:     5,
            }}
          >
            No cover
          </Text>
        )}
      </View>
    </View>
  );
}
