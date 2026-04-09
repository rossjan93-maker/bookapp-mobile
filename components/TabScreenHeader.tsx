import { StyleSheet, View, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';

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
      { paddingTop: insets.top + 12 },
      borderBottom && styles.withBorder,
    ]}>
      {title
        ? (
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        )
        : <View />
      }

      {rightAction != null
        ? <View style={styles.right}>{rightAction}</View>
        : null
      }
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: 20,
    paddingBottom:     14,
    backgroundColor:   '#f5f1ec',
  },
  withBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ede9e4',
  },
  title: {
    fontSize:      17,
    fontWeight:    '600',
    color:         '#231f1b',
    letterSpacing: -0.3,
    flex:          1,
  },
  right: {
    flexShrink: 0,
    marginLeft: 12,
  },
});
