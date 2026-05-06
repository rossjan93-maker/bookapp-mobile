/**
 * components/ThemePickerCard.tsx
 *
 * Settings → Appearance theme picker.
 *
 * Renders one preview card per theme in `THEME_ORDER`. Each card shows:
 *   - theme name + short descriptor
 *   - mini palette (paper / ink / accent / accent-alt swatches)
 *   - sample mini "card" with a sample heading + body line so the user can
 *     judge readability and mood at a glance
 *   - a pronounced selected ring + checkmark when active
 *
 * Tapping a card calls `setTheme(id)` immediately. The change is reflected
 * everywhere `useAppTheme()` is consumed and persisted via AsyncStorage.
 *
 * The picker itself is themed using the CURRENTLY ACTIVE theme so Settings
 * stays coherent the moment a user switches.
 */
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { THEMES, THEME_ORDER, ThemeId } from '../lib/theme/themes';
import { useAppTheme } from '../lib/theme/ThemeProvider';

export function ThemePickerCard() {
  const { themeId: activeId, setTheme, theme: activeTheme } = useAppTheme();

  return (
    <View style={{ gap: 10 }}>
      {THEME_ORDER.map(id => {
        const t        = THEMES[id];
        const selected = id === activeId;

        return (
          <TouchableOpacity
            key={id}
            onPress={() => setTheme(id)}
            activeOpacity={0.85}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`${t.name} theme — ${t.shortDescription}`}
            style={{
              borderWidth:     selected ? 2 : 1,
              borderColor:     selected ? activeTheme.colors.accent : activeTheme.colors.border,
              borderRadius:    activeTheme.radius.card,
              padding:         14,
              backgroundColor: activeTheme.colors.cardBackground,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }}>
              {/* ── Mini preview tile (uses the candidate theme, not the active one) ── */}
              <View
                style={{
                  width:           76,
                  height:          76,
                  borderRadius:    t.radius.md,
                  borderWidth:     1,
                  borderColor:     t.colors.border,
                  backgroundColor: t.colors.appBackground,
                  padding:         8,
                  justifyContent:  'space-between',
                }}
              >
                {/* Faux heading bar */}
                <View
                  style={{
                    width:           '70%',
                    height:          6,
                    borderRadius:    3,
                    backgroundColor: t.colors.textPrimary,
                  }}
                />
                {/* Two faux body lines */}
                <View style={{ gap: 4 }}>
                  <View style={{ width: '90%', height: 4, borderRadius: 2, backgroundColor: t.colors.textSecondary, opacity: 0.45 }} />
                  <View style={{ width: '60%', height: 4, borderRadius: 2, backgroundColor: t.colors.textSecondary, opacity: 0.45 }} />
                </View>
                {/* Accent dot row */}
                <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                  <View style={{ width: 14, height: 6, borderRadius: 3, backgroundColor: t.colors.accent }} />
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.colors.accentAlt, opacity: 0.85 }} />
                </View>
              </View>

              {/* ── Name + descriptor + selected indicator ────────────────────── */}
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                  <Text
                    style={{
                      fontSize:      16,
                      fontWeight:    '700',
                      color:         activeTheme.colors.textPrimary,
                      letterSpacing: -0.2,
                    }}
                  >
                    {t.name}
                  </Text>
                  {selected && (
                    <View
                      style={{
                        width:           22,
                        height:          22,
                        borderRadius:    11,
                        backgroundColor: activeTheme.colors.accent,
                        alignItems:      'center',
                        justifyContent:  'center',
                      }}
                    >
                      <Ionicons name="checkmark" size={14} color={activeTheme.colors.accentText} />
                    </View>
                  )}
                </View>

                <Text
                  style={{
                    fontSize:   13,
                    color:      activeTheme.colors.textSecondary,
                    lineHeight: 18,
                    marginBottom: 8,
                  }}
                >
                  {t.shortDescription}
                </Text>

                {/* ── Mini palette dots ──────────────────────────────────────── */}
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Swatch color={t.colors.appBackground}  ring={t.colors.border} />
                  <Swatch color={t.colors.textPrimary}    ring={t.colors.border} />
                  <Swatch color={t.colors.accent}         ring={t.colors.border} />
                  <Swatch color={t.colors.accentAlt}      ring={t.colors.border} />
                  <Swatch color={t.colors.surfaceElevated} ring={t.colors.border} />
                </View>
              </View>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Swatch({ color, ring }: { color: string; ring: string }) {
  return (
    <View
      style={{
        width:           18,
        height:          18,
        borderRadius:    9,
        backgroundColor: color,
        borderWidth:     1,
        borderColor:     ring,
      }}
    />
  );
}
