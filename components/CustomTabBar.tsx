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
  { name: 'clubs',   label: 'Clubs',   icon: 'people-outline',   iconFocused: 'people'   },
  { name: 'profile', label: 'Profile', icon: 'person-outline',   iconFocused: 'person'   },
];

const INK      = '#231f1b';
const DUST     = '#9e958d';
const SAGE     = '#7b9e7e';

export function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.outerWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <View style={styles.pill}>
        {state.routes.map((route, index) => {
          const isFocused  = state.index === index;
          const tab        = TABS[index];
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
              {/* Active tab gets a sage tinted pill background */}
              <View style={[styles.iconPill, isFocused && styles.iconPillActive]}>
                <Ionicons
                  name={isFocused ? tab.iconFocused : tab.icon}
                  size={21}
                  color={isFocused ? SAGE : DUST}
                />
                {badge !== undefined && badge !== null && (
                  <View style={[styles.badge, badgeStyle as any]}>
                    <Text style={styles.badgeText}>{badge}</Text>
                  </View>
                )}
              </View>

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
    backgroundColor: '#fefcf9',
    borderRadius:    28,
    paddingVertical: 8,
    shadowColor:     '#231f1b',
    shadowOpacity:   0.11,
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
  iconPillActive: {
    backgroundColor: '#eef4ee',
  },

  badge: {
    position:          'absolute',
    top:               -3,
    right:             -4,
    backgroundColor:   '#231f1b',
    borderRadius:      8,
    minWidth:          15,
    height:            15,
    alignItems:        'center',
    justifyContent:    'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color:      '#fefcf9',
    fontSize:   8.5,
    fontWeight: '700',
    lineHeight: 11,
  },

  label: {
    fontSize:      10,
    fontWeight:    '500',
    color:         DUST,
    letterSpacing: 0.1,
  },
  labelActive: {
    color:      SAGE,
    fontWeight: '700',
  },
});
