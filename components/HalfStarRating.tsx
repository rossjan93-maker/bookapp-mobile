import { Text, TouchableOpacity, View } from 'react-native';

// Reusable half-star rating control. Each star is split into two tap
// targets (left half = N - 0.5, right half = N). Tapping the same value
// again clears it (feels right for "I tapped the wrong star"). Visual
// fill is rendered with a clipped overlay so half-stars look correct
// without depending on a custom font glyph.
//
// All rating UIs (library inline prompt, book-detail post-finish modal,
// edit-history modal, search inline rate) flow through this component
// so the half-star behavior stays consistent and the DB never sees a
// value other than {null, 0.5, 1.0, ..., 5.0}.

type Props = {
  value:      number | null;
  onChange:   (v: number | null) => void;
  size?:      number;
  fillColor?: string;
  emptyColor?: string;
  // When true, tapping the currently-selected value clears the rating.
  // Default true everywhere except the post-finish modal where the user
  // expects "tap to commit" semantics.
  allowClear?: boolean;
};

export function HalfStarRating({
  value,
  onChange,
  size = 32,
  fillColor = '#f59e0b',
  emptyColor = '#ede9e4',
  allowClear = true,
}: Props) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {[1, 2, 3, 4, 5].map(n => {
        const v = value ?? 0;
        const fillState: 'full' | 'half' | 'empty' =
          v >= n ? 'full'
          : v >= n - 0.5 ? 'half'
          : 'empty';

        // Star widget = a fixed cell containing the visual layer plus
        // two transparent half-tap zones overlaid on top.
        const cell = size + 2;

        function tap(target: number) {
          if (allowClear && value === target) {
            onChange(null);
          } else {
            onChange(target);
          }
        }

        return (
          <View key={n} style={{ width: cell, height: cell, marginRight: 2 }}>
            {/* Empty layer (always rendered) */}
            <Text style={{
              position: 'absolute',
              left: 0, top: 0,
              fontSize: size,
              lineHeight: size + 2,
              color: emptyColor,
            }}>
              ★
            </Text>

            {/* Filled overlay clipped to the active fraction */}
            {fillState !== 'empty' && (
              <View style={{
                position: 'absolute',
                left: 0, top: 0,
                width: fillState === 'half' ? cell / 2 : cell,
                height: cell,
                overflow: 'hidden',
              }}>
                <Text style={{
                  fontSize: size,
                  lineHeight: size + 2,
                  color: fillColor,
                }}>
                  ★
                </Text>
              </View>
            )}

            {/* Two tap zones — left = half, right = full */}
            <View style={{
              position: 'absolute',
              left: 0, top: 0,
              flexDirection: 'row',
              width: cell,
              height: cell,
            }}>
              <TouchableOpacity
                activeOpacity={0.6}
                onPress={() => tap(n - 0.5)}
                style={{ flex: 1 }}
                hitSlop={{ top: 6, bottom: 6, left: n === 1 ? 4 : 0, right: 0 }}
                accessibilityLabel={`${n - 0.5} stars`}
                accessibilityRole="button"
              />
              <TouchableOpacity
                activeOpacity={0.6}
                onPress={() => tap(n)}
                style={{ flex: 1 }}
                hitSlop={{ top: 6, bottom: 6, left: 0, right: n === 5 ? 4 : 0 }}
                accessibilityLabel={`${n} stars`}
                accessibilityRole="button"
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

// Read-only display variant — renders the stars at a small size with
// half-star precision and no interactivity. Used in book detail history,
// home feed, and library cards.
export function StarDisplay({
  value,
  size = 14,
  fillColor = '#f59e0b',
  emptyColor = '#ede9e4',
}: {
  value: number;
  size?: number;
  fillColor?: string;
  emptyColor?: string;
}) {
  const cell = size + 1;
  return (
    <View style={{ flexDirection: 'row' }}>
      {[1, 2, 3, 4, 5].map(n => {
        const fillState: 'full' | 'half' | 'empty' =
          value >= n ? 'full'
          : value >= n - 0.5 ? 'half'
          : 'empty';
        return (
          <View key={n} style={{ width: cell, height: cell }}>
            <Text style={{
              position: 'absolute', left: 0, top: 0,
              fontSize: size, lineHeight: size + 1, color: emptyColor,
            }}>★</Text>
            {fillState !== 'empty' && (
              <View style={{
                position: 'absolute', left: 0, top: 0,
                width: fillState === 'half' ? cell / 2 : cell,
                height: cell, overflow: 'hidden',
              }}>
                <Text style={{ fontSize: size, lineHeight: size + 1, color: fillColor }}>★</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// Numeric → sentiment bucket. Half-star aware: 4.5 still loved, 3.5 liked,
// 2.5 okay, anything below not_for_me. Centralized so library + book
// detail + search stay in lock-step.
export function ratingToSentiment(rating: number): 'loved' | 'liked' | 'okay' | 'not_for_me' {
  if (rating >= 4.5) return 'loved';
  if (rating >= 3.5) return 'liked';
  if (rating >= 2.5) return 'okay';
  return 'not_for_me';
}

// Format a rating as "4.5 / 5" or "4 / 5" — drops the trailing ".0" on
// whole-star values so the most common case stays clean.
export function formatRating(rating: number): string {
  return Number.isInteger(rating) ? `${rating} / 5` : `${rating.toFixed(1)} / 5`;
}
