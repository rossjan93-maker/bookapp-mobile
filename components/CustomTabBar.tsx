import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

type TabConfig = {
  name:         string;
  label:        string;
  icon:         keyof typeof Ionicons.glyphMap;
  iconFocused:  keyof typeof Ionicons.glyphMap;
};

const TABS: TabConfig[] = [
  { name: 'index',   label: 'Home',    icon: 'home-outline',     iconFocused: 'home'     },
  { name: 'search',  label: 'For You', icon: 'sparkles-outline', iconFocused: 'sparkles' },
  { name: 'library', label: 'Library', icon: 'library-outline',  iconFocused: 'library'  },
  { name: 'notes',   label: 'Inbox',   icon: 'mail-outline',     iconFocused: 'mail'     },
  { name: 'profile', label: 'Profile', icon: 'person-outline',   iconFocused: 'person'   },
];

const ACTIVE   = '#1c1917';
const INACTIVE = '#a8a29e';
const PILL_BG  = '#f0efee';

export function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;
        const tab       = TABS[index];
        if (!tab) return null;

        const descriptor = descriptors[route.key];
        const badge      = descriptor.options.tabBarBadge;
        const badgeStyle = descriptor.options.tabBarBadgeStyle;

        function onPress() {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        }

        function onLongPress() {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        }

        return (
          <TouchableOpacity
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={descriptor.options.tabBarAccessibilityLabel}
            onPress={onPress}
            onLongPress={onLongPress}
            activeOpacity={0.7}
            style={styles.tab}
          >
            {/* Active indicator dot */}
            <View style={styles.dotRow}>
              <View style={[styles.dot, isFocused && styles.dotActive]} />
            </View>

            {/* Icon + optional badge */}
            <View style={styles.iconWrap}>
              <View style={[styles.iconPill, isFocused && styles.iconPillActive]}>
                <Ionicons
                  name={isFocused ? tab.iconFocused : tab.icon}
                  size={22}
                  color={isFocused ? ACTIVE : INACTIVE}
                />
              </View>
              {badge !== undefined && badge !== null && (
                <View style={[styles.badge, badgeStyle as any]}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              )}
            </View>

            {/* Label */}
            <Text
              style={[styles.label, isFocused && styles.labelActive]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection:   'row',
    backgroundColor: '#fafaf9',
    borderTopWidth:  StyleSheet.hairlineWidth,
    borderTopColor:  '#d6d3d1',
    paddingTop:      8,
  },
  tab: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'flex-start',
    paddingTop:     0,
  },

  // Indicator dot above icon
  dotRow: {
    height:         5,
    justifyContent: 'center',
    alignItems:     'center',
    marginBottom:   3,
  },
  dot: {
    width:           0,
    height:          0,
    borderRadius:    2,
    backgroundColor: ACTIVE,
  },
  dotActive: {
    width:  20,
    height: 3,
  },

  // Icon area
  iconWrap: {
    position: 'relative',
  },
  iconPill: {
    width:         44,
    height:        34,
    borderRadius:  17,
    alignItems:    'center',
    justifyContent:'center',
  },
  iconPillActive: {
    backgroundColor: PILL_BG,
  },

  // Badge
  badge: {
    position:        'absolute',
    top:             -3,
    right:           -2,
    backgroundColor: '#1c1917',
    borderRadius:    8,
    minWidth:        16,
    height:          16,
    alignItems:      'center',
    justifyContent:  'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color:      '#fff',
    fontSize:   9,
    fontWeight: '700',
    lineHeight: 12,
  },

  // Label
  label: {
    fontSize:    10.5,
    fontWeight:  '400',
    color:       INACTIVE,
    marginTop:   3,
    letterSpacing: 0.1,
  },
  labelActive: {
    color:      ACTIVE,
    fontWeight: '600',
  },
});
