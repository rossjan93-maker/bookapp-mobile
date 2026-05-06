/**
 * components/CustomTabBar.tsx
 *
 * Themable bottom tab bar. Reads the active theme via `useAppTheme()` so
 * tab pill, active/inactive icon tint, label colors, and badge background
 * all switch with the user's theme choice.
 *
 * Style architecture:
 *   - The static, theme-agnostic geometry (radii, paddings, dimensions)
 *     lives in `StyleSheet.create` for performance.
 *   - All theme-dependent values (backgroundColor, color, shadowColor) are
 *     applied inline so they re-evaluate on theme change.
 */
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../lib/theme/ThemeProvider';

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
  { name: 'profile', label: 'Profile', icon: 'person-outline',   iconFocused: 'person'   },
];

const TAB_NAMES = new Set(TABS.map(t => t.name));
const TAB_MAP   = new Map(TABS.map(t => [t.name, t]));

export function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const c = theme.colors;

  return (
    <View style={[styles.outerWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <View
        style={[
          styles.pill,
          {
            backgroundColor: c.tabBar,
            shadowColor:     theme.isDark ? '#000' : '#231f1b',
            shadowOpacity:   theme.isDark ? 0.45 : 0.11,
            // A faint border helps the bar stand off the page on Atelier (dark)
            borderWidth:     theme.isDark ? 1 : 0,
            borderColor:     theme.isDark ? c.border : 'transparent',
          },
        ]}
      >
        {state.routes.filter(r => TAB_NAMES.has(r.name)).map((route) => {
          const routeIndex = state.routes.indexOf(route);
          const isFocused  = state.index === routeIndex;
          const tab        = TAB_MAP.get(route.name)!;

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
              {/* Active tab gets a tinted pill in the active accent */}
              <View
                style={[
                  styles.iconPill,
                  isFocused && { backgroundColor: c.accentSoft },
                ]}
              >
                <Ionicons
                  name={isFocused ? tab.iconFocused : tab.icon}
                  size={21}
                  color={isFocused ? c.accent : c.tabInactive}
                />
                {badge !== undefined && badge !== null && (
                  <View
                    style={[
                      styles.badge,
                      { backgroundColor: c.textPrimary },
                      badgeStyle as any,
                    ]}
                  >
                    <Text style={[styles.badgeText, { color: c.tabBar }]}>{badge}</Text>
                  </View>
                )}
              </View>

              <Text
                style={[
                  styles.label,
                  { color: isFocused ? c.accent : c.tabInactive, fontWeight: isFocused ? '700' : '500' },
                ]}
                numberOfLines={1}
                allowFontScaling={false}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outerWrap: {
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: 'transparent',
  },

  pill: {
    flexDirection:   'row',
    borderRadius:    28,
    paddingVertical: 8,
    shadowRadius:    18,
    shadowOffset:    { width: 0, height: 4 },
    elevation:       8,
  },

  tab: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            3,
  },

  iconPill: {
    width:         40,
    height:        30,
    borderRadius:  15,
    alignItems:    'center',
    justifyContent:'center',
    position:      'relative',
  },

  badge: {
    position:          'absolute',
    top:               -3,
    right:             -4,
    borderRadius:      8,
    minWidth:          15,
    height:            15,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    fontSize:   8.5,
    fontWeight: '700',
    lineHeight: 11,
  },

  label: {
    fontSize:      10,
    letterSpacing: 0.1,
  },
});
