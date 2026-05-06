import { SAGE_DEEP } from '../lib/tokens';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
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
import { setRecContext } from '../lib/recContext';
import { persistRecSnapshot } from '../lib/recSnapshot';

// Suppress unused-import warning (fitLabel / fitColor kept for future use)
void fitLabel; void fitColor;

// ── Motion Tokens — Recommendations surface ────────────────────────────────
// All timing constants for the rec surface motion system live here.
// Changing values here propagates to all card animations uniformly.
export const REC_MOTION = {
  // Confirm phase: how long the user sees the confirmation before the card exits
  CONFIRM_MS:         460,   // save / more-like-this
  CONFIRM_DISMISS_MS: 260,   // dismiss is faster — user wants to skip
  // Confirm overlay entrance
  CONFIRM_FADE_MS:    130,   // overlay fades in from transparent
  // Card exit
  EXIT_MS:            300,   // total exit animation duration
  EXIT_TRANSLATE_Y:   -28,   // px the card lifts upward on exit
  EXIT_SCALE_END:     0.95,  // card shrinks slightly as it exits
  // Reflow (LayoutAnimation for stack shift)
  REFLOW_MS:          380,
  // Undo toast entrance
  TOAST_IN_MS:        300,
} as const;

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

// ── Evidence tags ─────────────────────────────────────────────────────────────
//
// Compact chips derived from score_breakdown signals — not from reason copy.
// They complement the prose explanation by labeling the TYPE of evidence.
// Each tag string is 1-3 words and maps to a concrete signal in _score_breakdown
// or reasons[]. Never decorative — every tag requires a measured signal.
//
// Priority order: author_affinity > trait_tag > theme_match > feedback_signal
// Maximum 2 tags per card.

const TRAIT_TAG_MAP: Record<string, string> = {
  pacing:            'Pacing',
  emotionality:      'Emotional depth',
  worldbuilding:     'World-building',
  literary_prose:    'Prose',
  insight:           'Insight',
  suspense:          'Suspense',
  originality:       'Originality',
  romance_intensity: 'Romance',
  practicality:      'Practical depth',
};

function extractTraitTag(reasons: string[]): string | null {
  for (const r of reasons) {
    const m =
      r.match(/^Matches your appreciation for (.+)$/i)  ||
      r.match(/^Readers note strong (.+?) —/i)          ||
      r.match(/^Aligns with your preference for (.+)$/i);
    if (m) {
      const raw = m[1].toLowerCase().trim();
      for (const [key, label] of Object.entries(TRAIT_TAG_MAP)) {
        if (raw.includes(key)) return label;
      }
    }
  }
  return null;
}

function buildEvidenceTags(book: ScoredBook): string[] {
  const bd   = book._score_breakdown;
  const tags: string[] = [];

  // 1. Author affinity — user has previously read 2+ books by this author
  if ((bd.author_books_read ?? 0) >= 2) {
    tags.push('Author you read');
  }

  // 2. Trait match — a specific reader trait is identified and scored
  if (tags.length < 2 && bd.trait_alignment >= 0.25) {
    const trait = extractTraitTag(book.reasons);
    if (trait) tags.push(trait);
  }

  // 3. Theme / subject overlap — subject-match reason present
  if (tags.length < 2) {
    const hasTheme = book.reasons.some(r =>
      /covers themes of/i.test(r) || /themes?.+align/i.test(r)
    );
    if (hasTheme) tags.push('Theme overlap');
  }

  // 4. Explicit feedback signal — user said "more like this" on similar book
  if (tags.length < 2 && (bd.feedback_boost ?? 0) > 0) {
    tags.push('Your feedback');
  }

  return tags.slice(0, 2);
}

export function EvidenceTagsRow({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
      {tags.map(tag => (
        <View
          key={tag}
          style={{
            borderWidth:      1,
            borderColor:      '#d6cfc8',
            borderRadius:     4,
            paddingHorizontal: 6,
            paddingVertical:   2,
            backgroundColor:  '#f5f1ec',
          }}
        >
          <Text style={{ fontSize: 10, color: '#6b635c', fontWeight: '500', letterSpacing: 0.1 }}>
            {tag}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ─── Rationale variety system ────────────────────────────────────────────────
//
// Each rewrite pattern below has multiple natural-language variants. A stable
// per-book hash picks one variant deterministically — so the same card always
// shows the same sentence (preserves snapshot stability and avoids flicker on
// re-render), but consecutive cards in the same feed cycle through different
// phrasings instead of all reading "Strong match for X."
//
// Phrases banned by product feedback (and so absent from every pool):
//   • "you gravitate toward"
//   • "because you liked"
//
// Pools mix: signal-direct ("X — squarely in your wheelhouse"), reader-relative
// ("a quality your ratings reward"), and book-relative ("threads of X run
// through it") so the feed never reads as one repeating template.
// =============================================================================

// Stable string hash → non-negative integer. FNV-1a 32-bit. Good distribution
// across UUIDs and short keys; deterministic across runs/devices.
function _hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Pick one item from a pool deterministically by (book.id, pattern-tag).
// The pattern tag means different patterns on the same book also rotate
// independently (e.g. trait-rewrite ≠ theme-rewrite from the same book.id).
function _pickVariant<T>(pool: readonly T[], bookId: string, tag: string): T {
  if (pool.length === 1) return pool[0];
  const idx = _hashStr(`${bookId}::${tag}`) % pool.length;
  return pool[idx];
}

const ALIGNS_POOL = [
  (x: string) => `Strong match for ${x}.`,
  (x: string) => `Lines up with your taste for ${x}.`,
  (x: string) => `${capitalize(x)} — squarely in your wheelhouse.`,
  (x: string) => `Hits the ${x} you keep reaching for.`,
] as const;

const APPRECIATION_POOL = [
  (x: string) => `Strong ${x} — exactly the kind you tend to rate highly.`,
  (x: string) => `Notable ${x}, the kind your highest-rated reads share.`,
  (x: string) => `Heavy on ${x} — a hallmark of the books you finish strongest.`,
  (x: string) => `Built on ${x}, the quality your ratings reliably reward.`,
] as const;

const READERS_TRAIT_POOL = [
  (q: string) => `Readers especially praise ${q} — a quality your ratings reward.`,
  (q: string) => `Reviewers single out ${q}, which lands with your taste.`,
  (q: string) => `Reader consensus highlights ${q} — a strength your library leans on.`,
  (q: string) => `Standout ${q} by reader consensus, and that aligns with you.`,
] as const;

const SUBJECT_POOL = [
  (x: string) => `Covers themes of ${x} that show up in books you've loved.`,
  (x: string) => `Threads of ${x} run through it — recurring across your library.`,
  (x: string) => `Built around ${x}, themes that surface in your highest reads.`,
  (x: string) => `Centers themes of ${x} you've returned to before.`,
] as const;

const THEMES_SHORT_POOL = [
  (x: string) => `Themes of ${x} run through it.`,
  (x: string) => `${capitalize(x)} threads through the book.`,
  (x: string) => `Carries ${x} themes you've sat with before.`,
  (x: string) => `Anchored in ${x}, a recurring thread for you.`,
] as const;

const LANE_FALLBACK_POOL = [
  (l: string) => `A natural fit for your taste in ${l}.`,
  (l: string) => `Sits squarely in the ${l} you favor.`,
  (l: string) => `Lands in the ${l} space you read most.`,
  (l: string) => `Squarely in your ${l} lane.`,
] as const;

const AUTHOR_LOYALTY_POOL = [
  (lane: string, author: string) =>
    `Consistent ${lane} from an author you keep returning to.`,
  (lane: string, author: string) =>
    `Another ${lane} entry from ${author}, who's earned a slot in your rotation.`,
  (lane: string, author: string) =>
    `${author} delivering more of the ${lane} you read regularly.`,
] as const;

// Trait-name → natural quality phrase ("its pace", "its tension", …).
const TRAIT_QUALITY: Record<string, string> = {
  pacing:            'its pace',
  suspense:          'its tension',
  emotionality:      'its emotional depth',
  worldbuilding:     'its world-building',
  literary_prose:    'its prose',
  insight:           'its insight',
  originality:       'its originality',
  romance_intensity: 'its romantic intensity',
  practicality:      'its practical value',
};

// ── Reason text rewriter ───────────────────────────────────────────────────────
// Maps known system-generated reason strings to natural, reader-facing copy.
// Returns null when the source string is too weak to surface (caller renders nothing).
// Only handles strings with known patterns — unknown strings pass through unchanged.
//
// The optional `bookId` enables the variety pools above. When omitted (e.g. in
// unit tests of the matcher), a deterministic 'default' seed is used.
function rewriteReasonText(raw: string, laneLabel: string | null, bookId: string = 'default'): string | null {
  // ── Generic lane fallback ─────────────────────────────────────────────────
  if (raw === 'Fits a genre you consistently enjoy') {
    return laneLabel ? _pickVariant(LANE_FALLBACK_POOL, bookId, 'lane')(laneLabel) : null;
  }

  // ── "Aligns with your preference for X and Y" ──────────────────────────
  const alignsM = raw.match(/^Aligns with your preference for (.+)$/i);
  if (alignsM) return _pickVariant(ALIGNS_POOL, bookId, 'aligns')(alignsM[1].toLowerCase());

  // ── "Matches your appreciation for X" ─────────────────────────────────
  const appreciationM = raw.match(/^Matches your appreciation for (.+)$/i);
  if (appreciationM) return _pickVariant(APPRECIATION_POOL, bookId, 'appreciation')(appreciationM[1].toLowerCase());

  // ── "Readers note strong X — which fits your profile" ─────────────────
  const readersM = raw.match(/^Readers note strong (.+?) — which fits your profile$/i);
  if (readersM) {
    const traitKey = readersM[1].toLowerCase();
    const quality  = TRAIT_QUALITY[traitKey] ?? `its ${traitKey}`;
    return _pickVariant(READERS_TRAIT_POOL, bookId, 'readers')(quality);
  }

  // ── "Covers themes of X and Y that appear in books you've loved" ───────
  const subjectM = raw.match(/^Covers themes of (.+) that appear in books you've loved$/i);
  if (subjectM) return _pickVariant(SUBJECT_POOL, bookId, 'subject')(subjectM[1]);

  // ── "Falls within X — a genre you consistently enjoy" (expertRec path) ─
  const fallsM = raw.match(/^Falls within (.+?) — a genre you consistently enjoy$/i);
  if (fallsM) return laneLabel
    ? _pickVariant(LANE_FALLBACK_POOL, bookId, 'falls')(laneLabel)
    : 'A genre you love.';

  // ── "Themes (X, Y) align with your reading history" ───────────────────
  const themesM = raw.match(/^Themes? \((.+?)\) align with your reading history$/i);
  if (themesM) return _pickVariant(THEMES_SHORT_POOL, bookId, 'themes')(themesM[1]);

  // ── "Touches on X, which occasionally appears in your reading" ─────────
  // Weak signal — only surface as a soft lane fallback, never the primary line.
  const touchesM = raw.match(/^Touches on (.+?), which occasionally appears in your reading$/i);
  if (touchesM) return laneLabel
    ? _pickVariant(LANE_FALLBACK_POOL, bookId, 'touches')(laneLabel)
    : null;

  // ── Pass all other strings through unchanged ───────────────────────────
  return raw;
}

// =============================================================================
// Signal-category detector + ≥2-signal combination
// =============================================================================
//
// Returns the broad signal category a raw reason represents. Used by
// buildExplanation to decide whether r0 + r1 carry *different* kinds of
// evidence (trait + theme = combinable; trait + trait = redundant).
type SignalCategory = 'trait' | 'theme' | 'lane' | 'author' | 'unknown';

function classifySignal(raw: string): SignalCategory {
  if (/^Matches your appreciation for /i.test(raw))                     return 'trait';
  if (/^Readers note strong /i.test(raw))                               return 'trait';
  if (/^Covers themes of /i.test(raw))                                  return 'theme';
  if (/^Themes? \(/i.test(raw))                                         return 'theme';
  if (/^Touches on /i.test(raw))                                        return 'theme';
  if (/^Aligns with your preference for /i.test(raw))                   return 'lane';
  if (/^Falls within .+ — a genre you consistently enjoy$/i.test(raw))  return 'lane';
  if (raw === 'Fits a genre you consistently enjoy')                    return 'lane';
  return 'unknown';
}

// Short trailing clause adding a *theme* signal to a primary *trait* sentence.
// Designed to read naturally after a complete sentence ending in "."
// Plural-safe by construction: every variant's verb agrees with "themes" (the
// preceding noun in the templates) rather than the embedded subject string,
// so multi-item themes like "murder and suspense" never produce ungrammatical
// "X runs through it" copy.
const THEME_TAIL_POOL = [
  (x: string) => ` Themes of ${x} also surface — recurring in your library.`,
  (x: string) => ` Themes of ${x} thread through it too, echoing your favorites.`,
  (x: string) => ` Plus ${x} as recurring threads — the kind you return to.`,
] as const;

// Build the appended-theme tail for a "Covers themes of X..." or similar r1.
// Returns null when the raw doesn't carry an extractable subject string.
function _themeTailFor(raw: string, bookId: string): string | null {
  const m1 = raw.match(/^Covers themes of (.+) that appear in books you've loved$/i);
  if (m1) return _pickVariant(THEME_TAIL_POOL, bookId, 'theme_tail')(m1[1]);
  const m2 = raw.match(/^Themes? \((.+?)\) align with your reading history$/i);
  if (m2) return _pickVariant(THEME_TAIL_POOL, bookId, 'theme_tail')(m2[1]);
  return null;
}

// Returns a naturally articled reference to a series/saga name for inline use.
function naturalArticle(name: string): string {
  if (/^(a|an)\s+/i.test(name)) return name;
  if (/^the\s+/i.test(name))    return `the ${name.replace(/^the\s+/i, '')}`;
  return `the ${name}`;
}

// Per-lane reason strings that are prepended to every book in the lane.
// These repeat across cards and should be deprioritised in favour of
// book-specific reasons when those are available in reasons[1+].
const GENERIC_LANE_REASONS = new Set([
  'Feels adjacent to the fantasy series you repeatedly complete',
  'Fits your pattern of emotionally driven contemporary fiction',
  'Matches the twisty, readable suspense you rate highly',
  'Sits close to the narrative nonfiction you consistently enjoy',
  'Aligns with the literary fiction that appears in your reading history',
  'Fits the speculative fiction you return to most often',
  'Similar to the emotionally driven romance you rate highly',
  'Fits the horror fiction you have consistently enjoyed',
]);

// CoG fit_explanation strings from fitClassifier that describe the user's lane
// rather than what is specific or notable about the book itself.  When a more
// specific trait or subject reason is available as reasons[1], it should be
// preferred over these lane-level summaries.
const GENERIC_COG_EXPLANATIONS = new Set([
  // buildCoreExplanation() — one per dominant lane
  'Feels closest to the romantic fantasy series you return to most',
  'Fits the fantasy and speculative fiction you return to most',
  'Matches the twisty, readable suspense you return to most often',
  'Aligns with the emotionally driven romance you consistently enjoy',
  'Feels close to the contemporary, character-driven fiction you consistently enjoy',
  'Sits at the heart of the narrative nonfiction you read most',
  'Aligns with the literary fiction you consistently pick up',
  'Fits the dark, atmospheric fiction you return to consistently',
  // Generic fallbacks
  'Strongly aligned with your most repeated reading patterns',
  'A reasonable next read that sits near your reading center',
  'A reasonable match based on your reading patterns',
]);

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
//
// Priority order:
//   1. Saga / series position — navigation cue beats everything.
//   2. Specific reasons[1] when reasons[0] is a generic lane/CoG summary.
//   3. Specific reasons[0] — e.g. named-author fit_explanation or trait match.
//   4. Author loyalty (only when no specific reason is available above).
//   5. Generic reasons[0] as last resort (lane fallback copy).
//
// The core_fit + laneLabel shortcut has been removed.  Specific fit_explanations
// from the CoG classifier (e.g. "a consistent favorite — lands exactly in your
// romantic fantasy reading") are now surfaced directly rather than being silenced
// by a generic "A strong fit for your taste in X" override.
function buildExplanation(book: ScoredBook, _hasSeriesMeta: boolean): string | null {
  const bd = book._score_breakdown;

  // ── Saga / series (highest priority — positional cue) ───────────────────────
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

  const laneLabel = bd.book_lane
    ? (EXPLANATION_LANE_LABELS[bd.book_lane as DeterministicLane] ?? null)
    : null;

  const r0 = book.reasons.length > 0 ? book.reasons[0] : null;
  const r1 = book.reasons.length > 1 ? book.reasons[1] : null;

  // A reason is "generic" when it describes the user's lane pattern rather than
  // anything specific or notable about this book.  GENERIC_LANE_REASONS covers
  // the old per-lane template strings; GENERIC_COG_EXPLANATIONS covers the CoG
  // classifier's lane-level summaries (buildCoreExplanation output).
  const r0IsGeneric = r0 !== null && (
    GENERIC_LANE_REASONS.has(r0) || GENERIC_COG_EXPLANATIONS.has(r0)
  );

  // ── Prefer reasons[1] when reasons[0] is a generic lane/CoG summary ─────────
  // reasons[1] holds a book-specific trait or subject signal (pacing, themes, etc.)
  // that is far more distinctive than a lane-wide summary.
  if (r0IsGeneric && r1 !== null) {
    const specific = capitalize(stripAuthorPrefix(r1, book.author));
    const rewritten = rewriteReasonText(specific, laneLabel, book.id);
    if (rewritten != null) return rewritten;
  }

  // ── ≥2-signal combination ──────────────────────────────────────────────────
  // When r0 is a *specific* trait/quality reason AND r1 carries a *theme* signal,
  // join them so the card surfaces two distinct kinds of evidence in one
  // sentence (a quality match AND a thematic overlap), not just one.
  // We only combine across categories — combining trait+trait or theme+theme
  // would just be redundant repetition.
  if (r0 !== null && !r0IsGeneric && r1 !== null) {
    const r0Cat = classifySignal(r0);
    const r1Cat = classifySignal(r1);
    if (r0Cat === 'trait' && r1Cat === 'theme') {
      const cleaned   = capitalize(stripAuthorPrefix(r0, book.author));
      const primary   = rewriteReasonText(cleaned, laneLabel, book.id);
      const themeTail = _themeTailFor(r1, book.id);
      if (primary != null && themeTail != null) return primary + themeTail;
    }
  }

  // ── Use reasons[0] when it's specific ───────────────────────────────────────
  // Named-author strings like "a consistent favorite — lands exactly in your
  // romantic fantasy reading" come from the CoG classifier and are already
  // strong, specific copy.  Strip the "By {Author}, " prefix (author is shown
  // on the card) and pass through the rest.
  if (r0 !== null && !r0IsGeneric) {
    const cleaned  = capitalize(stripAuthorPrefix(r0, book.author));
    const rewritten = rewriteReasonText(cleaned, laneLabel, book.id);
    if (rewritten != null) return rewritten;
  }

  // ── Author loyalty — only when no specific reason is available ───────────────
  // Variants are seeded by book.id so the same author yields varied phrasing
  // across their backlist instead of repeating the same sentence on every card.
  const authorCount = bd.author_books_read ?? 0;
  if (authorCount >= 5) {
    return `Deep into ${book.author}'s catalog — this one fits the pattern.`;
  }
  if (authorCount >= 2) {
    return laneLabel
      ? _pickVariant(AUTHOR_LOYALTY_POOL, book.id, 'author')(laneLabel, book.author)
      : `Another strong read from ${book.author}.`;
  }

  // ── Generic reasons[0] as last resort ───────────────────────────────────────
  // If r0 is generic, prefer the laneLabel shortform over the verbose CoG string.
  if (r0 !== null) {
    if (r0IsGeneric) {
      return laneLabel
        ? _pickVariant(LANE_FALLBACK_POOL, book.id, 'lane_fallback')(laneLabel)
        : null;
    }
    const cleaned = capitalize(stripAuthorPrefix(r0, book.author));
    return rewriteReasonText(cleaned, laneLabel, book.id);
  }

  return null;
}


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
  const confirmOpacity = useRef(new Animated.Value(0)).current;
  const bloomAnim      = useRef(new Animated.Value(0)).current;

  const [moreDone, setMoreDone]             = useState(false);
  const [pendingAction, setPendingAction]   = useState(false);
  const [confirmState, setConfirmState]     = useState<'save' | 'more' | 'dismiss' | null>(null);
  const [seriesImgErrors, setSeriesImgErrors] = useState<Record<number, true>>({});
  const impressionFired = useRef(false);

  useEffect(() => {
    if (!impressionFired.current) {
      impressionFired.current = true;
      onImpression();
      if (__DEV__) console.log('[REC_CONFIDENCE]', `book_id=${book.id}`, `score=${book.score}`, `tier=${book.confidence}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Slower, more intentional exit — cubic ease-out, larger distance
  function animateOut(cb: () => void) {
    if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'phase=exit', `duration_ms=${REC_MOTION.EXIT_MS}`);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: REC_MOTION.EXIT_MS,
        easing:   Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(cardTranslateY, {
        toValue: REC_MOTION.EXIT_TRANSLATE_Y,
        duration: REC_MOTION.EXIT_MS,
        easing:   Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(cardScale, {
        toValue: REC_MOTION.EXIT_SCALE_END,
        duration: REC_MOTION.EXIT_MS,
        easing:   Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => cb());
  }

  // Fade-in the confirm overlay smoothly
  function showConfirm(state: 'save' | 'more' | 'dismiss') {
    confirmOpacity.setValue(0);
    setConfirmState(state);
    Animated.timing(confirmOpacity, {
      toValue:  1,
      duration: REC_MOTION.CONFIRM_FADE_MS,
      easing:   Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }

  function handleSavePress() {
    if (pendingAction) return;
    setPendingAction(true);
    // Bloom circle scales out from button centre before confirm shows
    bloomAnim.setValue(0);
    Animated.sequence([
      Animated.timing(bloomAnim, { toValue: 1, duration: 280, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(bloomAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
    ]).start();
    setTimeout(() => {
      showConfirm('save');
      if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=save', 'phase=confirm', `window_ms=${REC_MOTION.CONFIRM_MS}`);
      setTimeout(() => {
        if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=save', 'phase=exit');
        animateOut(onSave);
      }, REC_MOTION.CONFIRM_MS);
    }, 220);
  }

  function handleDismissPress() {
    if (pendingAction) return;
    setPendingAction(true);
    showConfirm('dismiss');
    if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=dismiss', 'phase=confirm', `window_ms=${REC_MOTION.CONFIRM_DISMISS_MS}`);
    setTimeout(() => {
      if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=dismiss', 'phase=exit');
      animateOut(() => {
        opacity.setValue(1);
        cardTranslateY.setValue(0);
        cardScale.setValue(1);
        confirmOpacity.setValue(0);
        if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=dismiss', 'phase=reflow');
        onDismiss();
      });
    }, REC_MOTION.CONFIRM_DISMISS_MS);
  }

  function handleMoreLikeThisPress() {
    if (pendingAction || moreDone) return;
    setPendingAction(true);
    setMoreDone(true);
    showConfirm('more');
    if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=more', 'phase=confirm', `window_ms=${REC_MOTION.CONFIRM_MS}`);
    setTimeout(() => {
      if (__DEV__) console.log('[REC_MOTION]', `book_id=${book.id}`, 'action=more', 'phase=exit');
      animateOut(onMoreLikeThis);
    }, REC_MOTION.CONFIRM_MS);
  }

  function handleCardPress() {
    if (pendingAction) return;
    // Cache rec evidence so book detail can render "Why this book?".
    // setRecContext: synchronous session cache for the immediate tap-through.
    // persistRecSnapshot: durable DB write for restarts / direct nav (fire-and-forget).
    if (book.external_id) {
      const recCtxPayload = {
        explanation:  collapsedReason,
        evidenceTags: buildEvidenceTags(book),
      };
      setRecContext(book.external_id, recCtxPayload);
      persistRecSnapshot(book.external_id, recCtxPayload);
    }
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
      backgroundColor: '#fefcf9',
      borderRadius: 14,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOpacity: featured ? 0.07 : 0.04,
      shadowRadius: featured ? 10 : 6,
      shadowOffset: { width: 0, height: featured ? 2 : 1 },
      elevation: featured ? 2 : 1,
      overflow: 'hidden',
      ...(featured ? { borderWidth: 1, borderColor: '#ede9e4' } : {}),
    }}>
      {featured && <View style={{ height: 3, backgroundColor: '#7b9e7e' }} />}

      <TouchableOpacity
        onPress={handleCardPress}
        activeOpacity={0.75}
        style={{ padding: featured ? 14 : 12, flexDirection: 'row', alignItems: 'flex-start' }}
      >
        <CoverThumb
          url={book.cover_url}
          externalId={book.external_id}
          title={book.title}
          width={featured ? 72 : 44}
          height={featured ? 106 : 64}
        />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text
            style={{ fontSize: 15, fontWeight: '700', color: '#231f1b', lineHeight: 21, marginBottom: 3 }}
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
              const bd2   = book._score_breakdown;
              const isStarterBadge      = bd2.series_label === 'series_starter' || bd2.saga_label === 'saga_entry';
              const isContinuationBadge = bd2.series_label === 'series_continuation' || bd2.saga_label === 'saga_continuation' || bd2.saga_label === 'saga_next_series';

              // Series action labels absorb the confidence tier — cleaner hierarchy:
              // "Start here" / "Continue" > "Top pick" > "Good fit" > "Explore"
              const label = isStarterBadge      ? 'Start here'
                          : isContinuationBadge ? 'Continue'
                          : tier === 'high'     ? 'Top pick'
                          : tier === 'medium'   ? 'Good fit'
                          :                      'Explore';
              const bg    = isStarterBadge      ? '#fffbeb'
                          : isContinuationBadge ? '#eaf1ea'
                          : tier === 'high'     ? '#eaf1ea'
                          : tier === 'medium'   ? '#f8f8f7'
                          :                      '#f5f1ec';
              const col   = isStarterBadge      ? '#92400e'
                          : isContinuationBadge ? SAGE_DEEP
                          : tier === 'high'     ? SAGE_DEEP
                          : tier === 'medium'   ? '#57534e'
                          :                      '#9e958d';
              const bord  = isStarterBadge      ? '#fde68a'
                          : isContinuationBadge ? '#7b9e7e'
                          : tier === 'high'     ? '#7b9e7e'
                          : tier === 'medium'   ? '#ede9e4'
                          :                      '#ede9e4';
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
                backgroundColor: '#231f1b', borderRadius: 4,
                paddingHorizontal: 5, paddingVertical: 2,
              }}>
                <Text style={{ fontSize: 9, fontWeight: '700', color: '#f5f1ec', letterSpacing: 0.4 }}>
                  EXPERT PICK
                </Text>
              </View>
            )}
          </View>

          {hasSeriesMeta && (
            <View style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 5, marginBottom: 5 }}>
              {catalogMeta!.orderedBooks.map((b, i) => {
                const isCurrent  = (i + 1) === seriesPos;
                const w          = isCurrent ? 34 : 27;
                const h          = isCurrent ? 50 : 42;
                const coverUri   = b.olCoverId && !seriesImgErrors[i]
                  ? `https://covers.openlibrary.org/b/id/${b.olCoverId}-S.jpg`
                  : null;
                return (
                  <View
                    key={`${b.title}-${i}`}
                    style={{
                      opacity:      isCurrent ? 1 : 0.70,
                      borderWidth:  isCurrent ? 1.5 : 0,
                      borderColor:  '#231f1b',
                      borderRadius: 4,
                    }}
                  >
                    {coverUri ? (
                      <Image
                        source={{ uri: coverUri }}
                        onError={() => setSeriesImgErrors(prev => ({ ...prev, [i]: true }))}
                        style={{
                          width:           w,
                          height:          h,
                          borderRadius:    3,
                          backgroundColor: '#ede9e4',
                        }}
                      />
                    ) : (
                      <View style={{
                        width:           w,
                        height:          h,
                        borderRadius:    3,
                        backgroundColor: '#ede9e4',
                        borderWidth:     1,
                        borderColor:     '#e0dbd4',
                        alignItems:      'center',
                        justifyContent:  'center',
                      }}>
                        <Text style={{ fontSize: 7, color: '#9e958d', textAlign: 'center', paddingHorizontal: 2 }} numberOfLines={3}>
                          {b.title}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
              </View>
              {/* Position label — "Book N of M" only; no action suffix */}
              <Text style={{ fontSize: 11, color: '#9e958d', letterSpacing: 0.1 }}>
                {`Book ${seriesPos} of ${seriesTotal}`}
              </Text>
            </View>
          )}

          {collapsedReason && (featured ? (
            <View style={{ marginTop: 4, borderLeftWidth: 2, borderLeftColor: '#7b9e7e', paddingLeft: 8 }}>
              <Text
                style={{ fontSize: 13, fontStyle: 'italic', color: '#6b635c', lineHeight: 18, marginBottom: 2 }}
                numberOfLines={3}
              >
                {collapsedReason}
              </Text>
            </View>
          ) : (
            <Text
              style={{ fontSize: 13, fontWeight: '600', color: '#231f1b', lineHeight: 18, marginBottom: 2 }}
              numberOfLines={2}
            >
              {collapsedReason}
            </Text>
          ))}

          {/* Evidence tags — below the prose explanation, never above */}
          <EvidenceTagsRow tags={buildEvidenceTags(book)} />
        </View>
      </TouchableOpacity>

      {/* ── Action bar ── */}
      <View style={{ borderTopWidth: 1, borderTopColor: '#f0eeeb', flexDirection: 'row', alignItems: 'stretch' }}>
        {/* Save button — bloom overlay lives here */}
        <View style={{ flex: 1, overflow: 'hidden', borderRightWidth: 1, borderRightColor: '#f0eeeb' }}>
          <TouchableOpacity
            onPress={handleSavePress}
            disabled={pendingAction}
            style={{ paddingVertical: 14, paddingHorizontal: 14, justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#231f1b' }}>Want to Read</Text>
          </TouchableOpacity>
          <Animated.View
            style={{
              position: 'absolute',
              alignSelf: 'center',
              top: '50%',
              marginTop: -30,
              width: 60,
              height: 60,
              borderRadius: 30,
              backgroundColor: '#7b9e7e',
              pointerEvents: 'none',
              opacity: bloomAnim.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 0.4, 0] }),
              transform: [{ scale: bloomAnim.interpolate({ inputRange: [0, 1], outputRange: [0.2, 3.5] }) }],
            }}
          />
        </View>

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

      {/* Confirm overlay — fades in via confirmOpacity */}
      {confirmState && (
        <Animated.View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: confirmState === 'save' ? '#eaf1ea' : confirmState === 'dismiss' ? '#ede9e4' : '#faf5ff',
          borderRadius: 14,
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 20,
          gap: 4,
          opacity: confirmOpacity,
        }}>
          {confirmState === 'save' ? (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: SAGE_DEEP }}>✓  Added to your list</Text>
              <Text style={{ fontSize: 12, color: '#3d5e42' }}>Saved to Want to Read</Text>
            </>
          ) : confirmState === 'dismiss' ? (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#78716c' }}>Skipped</Text>
              <Text style={{ fontSize: 12, color: '#9e958d' }}>We'll note this preference</Text>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 15, fontWeight: '700', color: '#6d28d9' }}>Got it — tuning your picks</Text>
              <Text style={{ fontSize: 12, color: '#7c3aed' }}>Future recs will reflect this taste</Text>
            </>
          )}
        </Animated.View>
      )}
    </Animated.View>
  );
}

// ─── UndoToast ────────────────────────────────────────────────────────────────
// Floating snackbar shown after a dismiss. Spring-based entrance for natural feel.
export function UndoToast({ book, onUndo }: { book: ScoredBook; onUndo: () => void }) {
  const translateY = useRef(new Animated.Value(14)).current;
  const fadeIn     = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, {
        toValue:  0,
        tension:  68,
        friction: 11,
        useNativeDriver: true,
      }),
      Animated.timing(fadeIn, {
        toValue:  1,
        duration: REC_MOTION.TOAST_IN_MS,
        easing:   Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View style={{
      opacity: fadeIn,
      transform: [{ translateY }],
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#231f1b',
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 8,
      gap: 8,
    }}>
      <Text style={{ flex: 1, fontSize: 12, color: '#9e958d' }} numberOfLines={1}>
        Skipped{' '}
        <Text style={{ color: '#ede9e4', fontWeight: '600' }}>"{book.title}"</Text>
      </Text>
      <TouchableOpacity
        onPress={onUndo}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={{ backgroundColor: '#292524', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}
      >
        <Text style={{ fontSize: 12, fontWeight: '700', color: '#f5f1ec' }}>Undo</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── RecSkeletonCard ──────────────────────────────────────────────────────────
// Kept for any external callers — functionality replaced by DeckAssemblingLoader.
export function RecSkeletonCard() {
  return (
    <View style={{
      backgroundColor: '#fefcf9', borderRadius: 14, padding: 16,
      marginBottom: 8, height: 110,
      shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 }, elevation: 1,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 44, height: 64, backgroundColor: '#ede9e4', borderRadius: 6 }} />
        <View style={{ flex: 1, gap: 8 }}>
          <View style={{ height: 14, backgroundColor: '#ede9e4', borderRadius: 6, width: '72%' }} />
          <View style={{ height: 11, backgroundColor: '#ede9e4', borderRadius: 6, width: '48%' }} />
          <View style={{ height: 11, backgroundColor: '#ede9e4', borderRadius: 6, width: '88%' }} />
        </View>
      </View>
    </View>
  );
}

// ─── ShimmerBlock ─────────────────────────────────────────────────────────────
// A placeholder rectangle that breathes (opacity cycles) to signal loading activity.
function ShimmerBlock({
  width,
  height,
  delay    = 0,
  radius   = 6,
}: {
  width:   number | string;
  height:  number;
  delay?:  number;
  radius?: number;
}) {
  const shimmer = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, {
          toValue:  1,
          duration: 860,
          delay,
          easing:   Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(shimmer, {
          toValue:  0.45,
          duration: 860,
          easing:   Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View style={{
      width,
      height,
      borderRadius:    radius,
      backgroundColor: '#e8e4df',
      opacity:         shimmer,
    }} />
  );
}

// ─── AssemblingCardSilhouette ─────────────────────────────────────────────────
// One animated card silhouette used inside DeckAssemblingLoader.
function AssemblingCardSilhouette({
  translateY,
  opacity,
  shimmerPhase,
}: {
  translateY:   Animated.Value;
  opacity:      Animated.Value;
  shimmerPhase: number; // ms offset so shimmer phases are different per card
}) {
  return (
    <Animated.View style={{
      transform:       [{ translateY }],
      opacity,
      backgroundColor: '#fefcf9',
      borderRadius:    14,
      padding:         12,
      marginBottom:    8,
      shadowColor:     '#000',
      shadowOpacity:   0.04,
      shadowRadius:    6,
      shadowOffset:    { width: 0, height: 1 },
      elevation:       1,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        {/* Cover placeholder */}
        <ShimmerBlock width={44} height={64} delay={shimmerPhase} radius={6} />

        <View style={{ flex: 1, gap: 8, paddingTop: 2 }}>
          {/* Title line */}
          <ShimmerBlock width="70%" height={13} delay={shimmerPhase + 60} />
          {/* Author line */}
          <ShimmerBlock width="46%" height={10} delay={shimmerPhase + 120} />
          {/* Reason / explanation line */}
          <ShimmerBlock width="85%" height={10} delay={shimmerPhase + 180} />
          {/* Confidence badge silhouette */}
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 2 }}>
            <ShimmerBlock width={52} height={16} delay={shimmerPhase + 260} radius={5} />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

// ─── DeckAssemblingLoader ─────────────────────────────────────────────────────
// Bespoke first-load experience for Recommendations.
// Three card silhouettes stagger in from slightly below with breathing shimmer.
// Replaces the generic skeleton + spinner for the initial-load state.
export function DeckAssemblingLoader() {
  // Per-card entrance values
  const ty1 = useRef(new Animated.Value(16)).current;
  const ty2 = useRef(new Animated.Value(16)).current;
  const ty3 = useRef(new Animated.Value(16)).current;
  const op1 = useRef(new Animated.Value(0)).current;
  const op2 = useRef(new Animated.Value(0)).current;
  const op3 = useRef(new Animated.Value(0)).current;
  // Title entrance
  const titleOp = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (__DEV__) console.log('[REC_LOADING]', 'mode=initial', 'visible=true');

    // Title fades in first, slightly before cards
    Animated.timing(titleOp, {
      toValue:  1,
      duration: 260,
      delay:    40,
      easing:   Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

    // Helper: entrance for one card (translateY + opacity)
    const enter = (ty: Animated.Value, op: Animated.Value, delay: number) =>
      Animated.parallel([
        Animated.timing(ty, {
          toValue:  0,
          duration: 400,
          delay,
          easing:   Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(op, {
          toValue:  1,
          duration: 320,
          delay:    delay + 50,
          easing:   Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]);

    // Staggered entrances: 0ms, 100ms, 200ms after the initial 80ms settle
    Animated.parallel([
      enter(ty1, op1,  80),
      enter(ty2, op2, 180),
      enter(ty3, op3, 280),
    ]).start();

    return () => {
      if (__DEV__) console.log('[REC_LOADING]', 'mode=initial', 'visible=false');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ marginBottom: 20 }}>
      <Animated.Text style={{
        fontSize:    14,
        fontWeight:  '600',
        color:       '#231f1b',
        marginBottom: 14,
        opacity:     titleOp,
      }}>
        Assembling your picks…
      </Animated.Text>

      <AssemblingCardSilhouette translateY={ty1} opacity={op1} shimmerPhase={0}   />
      <AssemblingCardSilhouette translateY={ty2} opacity={op2} shimmerPhase={140} />
      <AssemblingCardSilhouette translateY={ty3} opacity={op3} shimmerPhase={280} />
    </View>
  );
}

// ─── RefreshingDot ────────────────────────────────────────────────────────────
// Minimal visual for background refresh when a deck already exists.
// A single breathing dot — almost invisible, communicates activity without noise.
export function RefreshingDot() {
  const pulse = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1,   duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.3, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View style={{
      width:           6,
      height:          6,
      borderRadius:    3,
      backgroundColor: '#c4bdb7',
      marginLeft:      8,
      opacity:         pulse,
    }} />
  );
}
