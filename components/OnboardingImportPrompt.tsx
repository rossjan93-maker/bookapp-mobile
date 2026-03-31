// ─── OnboardingImportPrompt ───────────────────────────────────────────────────
//
// Full-screen overlay that appears as the final onboarding step after the
// walkthrough completes.  Renders in _layout.tsx above the tab bar so there
// is no tab-chrome distraction — this feels like a dedicated closing step, not
// a content screen.
//
// AsyncStorage key: readstack_import_ob_v1
//   null        — never shown (prompt should appear)
//   'started'   — user tapped Import (never nag again)
//   'dismissed' — user dismissed or chose intake (never nag again)
//
// Navigation on choice:
//   Import        → /import/goodreads  (marks 'started')
//   Quick intake  → /(tabs)/search     (marks 'dismissed'; RecEntryScreen takes over)
//   Not right now → /(tabs)  [home]    (marks 'dismissed')

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  SafeAreaView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Persistence ──────────────────────────────────────────────────────────────

export const IMPORT_OB_KEY = 'readstack_import_ob_v1';

export async function getImportObState(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(IMPORT_OB_KEY);
  } catch {
    return null;
  }
}

export async function setImportObState(val: 'started' | 'dismissed'): Promise<void> {
  try {
    await AsyncStorage.setItem(IMPORT_OB_KEY, val);
  } catch {}
}

// ─── Palette (matches app-wide tokens) ───────────────────────────────────────

const BG  = '#faf9f7';
const INK = '#1c1917';
const SUB = '#78716c';
const MUT = '#a8a29e';
const BOR = '#e7e5e4';

// ─── Component ────────────────────────────────────────────────────────────────

export function OnboardingImportPrompt({
  visible,
  onDismiss,
}: {
  visible:   boolean;
  onDismiss: () => void;
}) {
  const router   = useRouter();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue:         visible ? 1 : 0,
      duration:        visible ? 260 : 160,
      useNativeDriver: true,
    }).start();
  }, [visible]);

  if (!visible) return null;

  async function handleImport() {
    await setImportObState('started');
    onDismiss();
    router.push('/import/goodreads' as any);
  }

  async function handleIntake() {
    await setImportObState('dismissed');
    onDismiss();
    router.navigate('/(tabs)/search' as any);
  }

  async function handleDismiss() {
    await setImportObState('dismissed');
    onDismiss();
    router.navigate('/(tabs)' as any);
  }

  return (
    <Animated.View
      style={{
        position:        'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: BG,
        opacity:         fadeAnim,
        zIndex:          200,
      }}
    >
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{
          flex:             1,
          paddingHorizontal: 24,
          justifyContent:   'center',
          paddingBottom:    24,
        }}>

          {/* Step dots — visually anchors this as the closing onboarding step */}
          <View style={{ flexDirection: 'row', gap: 5, marginBottom: 40 }}>
            {[1, 2, 3].map(i => (
              <View
                key={i}
                style={{
                  width:           i === 3 ? 22 : 6,
                  height:          6,
                  borderRadius:    3,
                  backgroundColor: INK,
                }}
              />
            ))}
          </View>

          {/* Headline */}
          <Text style={{
            fontSize:      32,
            fontWeight:    '800',
            color:         INK,
            lineHeight:    38,
            letterSpacing: -0.5,
            marginBottom:  12,
          }}>
            Make your first{'\n'}picks count.
          </Text>

          {/* Sub-copy */}
          <Text style={{
            fontSize:     16,
            color:        SUB,
            lineHeight:   25,
            marginBottom: 40,
          }}>
            Connect your reading history and we'll tune your recommendations from day one — no manual setup required.
          </Text>

          {/* ── Primary CTA: Import ── */}
          <TouchableOpacity
            onPress={handleImport}
            activeOpacity={0.82}
            style={{
              backgroundColor:  INK,
              borderRadius:     16,
              paddingVertical:  18,
              paddingHorizontal: 20,
              flexDirection:    'row',
              alignItems:       'center',
              gap:              14,
              marginBottom:     14,
            }}
          >
            <View style={{
              width:           42,
              height:          42,
              borderRadius:    21,
              backgroundColor: '#ffffff14',
              alignItems:      'center',
              justifyContent:  'center',
            }}>
              <Ionicons name="cloud-download-outline" size={20} color="#fff" />
            </View>

            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize:   17,
                fontWeight: '700',
                color:      '#fff',
                lineHeight: 22,
                marginBottom: 3,
              }}>
                Import my library
              </Text>
              <Text style={{ fontSize: 12, color: '#c4bfb9' }}>
                Goodreads · StoryGraph · others
              </Text>
            </View>

            <Ionicons name="chevron-forward" size={18} color="#78716c" />
          </TouchableOpacity>

          {/* Divider */}
          <View style={{
            flexDirection: 'row',
            alignItems:    'center',
            gap:           10,
            marginBottom:  14,
          }}>
            <View style={{ flex: 1, height: 1, backgroundColor: BOR }} />
            <Text style={{ fontSize: 11, color: MUT, fontWeight: '500' }}>or</Text>
            <View style={{ flex: 1, height: 1, backgroundColor: BOR }} />
          </View>

          {/* ── Secondary: Quick intake ── */}
          <TouchableOpacity
            onPress={handleIntake}
            activeOpacity={0.78}
            style={{
              backgroundColor:  '#fff',
              borderRadius:     14,
              borderWidth:      1.5,
              borderColor:      BOR,
              paddingVertical:  15,
              paddingHorizontal: 18,
              flexDirection:    'row',
              alignItems:       'center',
              gap:              12,
              marginBottom:     28,
            }}
          >
            <View style={{
              width:           38,
              height:          38,
              borderRadius:    19,
              backgroundColor: '#f5f5f4',
              alignItems:      'center',
              justifyContent:  'center',
            }}>
              <Ionicons name="options-outline" size={18} color={INK} />
            </View>

            <View style={{ flex: 1 }}>
              <Text style={{
                fontSize:   15,
                fontWeight: '600',
                color:      INK,
                lineHeight: 21,
                marginBottom: 2,
              }}>
                Answer a few questions
              </Text>
              <Text style={{ fontSize: 12, color: SUB }}>
                Genres, pacing, style — under 90 seconds
              </Text>
            </View>

            <Ionicons name="chevron-forward" size={16} color={MUT} />
          </TouchableOpacity>

          {/* ── Tertiary: dismiss ── */}
          <TouchableOpacity
            onPress={handleDismiss}
            activeOpacity={0.7}
            style={{ alignItems: 'center', paddingVertical: 10 }}
          >
            <Text style={{ fontSize: 14, color: MUT, fontWeight: '500' }}>
              Not right now →
            </Text>
          </TouchableOpacity>

        </View>
      </SafeAreaView>
    </Animated.View>
  );
}
