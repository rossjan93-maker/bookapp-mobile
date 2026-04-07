import { StyleSheet, View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';

/**
 * TabScreenHeader
 *
 * Shared top chrome for all five tab-level screens.
 * Uses useSafeAreaInsets().top to sit correctly below the device
 * status bar / Dynamic Island / notch on every device.
 *
 * Props:
 *   title        — screen label (string). Omit for screens whose first
 *                  content block already acts as the identity (e.g. Home
 *                  greeting, Profile avatar row).
 *   rightAction  — any ReactNode: icon button(s), text link, etc.
 *                  Rendered right-aligned, vertically centred in the row.
 *   borderBottom — draw a hairline separator below the header.
 *                  Default false (screens that flow into content directly).
 */
type Props = {
  title?: string;
  rightAction?: ReactNode;
  borderBottom?: boolean;
};

export function TabScreenHeader({ title, rightAction, borderBottom = false }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[
      styles.root,
      {
        // safeArea clearance + 12px breathing room before the action row
        paddingTop: insets.top + 12,
      },
      borderBottom && styles.withBorder,
    ]}>
      {/* Title — always takes the left/flex slot; empty View preserves space-between */}
      {title
        ? (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        )
        : <View />
      }

      {/* Right action zone */}
      {rightAction != null
        ? <View style={styles.right}>{rightAction}</View>
        : null
      }
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    paddingHorizontal: 20,
    paddingBottom:   14,
    backgroundColor: '#faf9f7',
  },
  withBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e7e5e4',
  },
  title: {
    fontSize:      17,
    fontWeight:    '600',
    color:         '#1c1917',
    letterSpacing: -0.2,
    flex:          1,
  },
  right: {
    flexShrink: 0,
    marginLeft: 12,
  },
});
