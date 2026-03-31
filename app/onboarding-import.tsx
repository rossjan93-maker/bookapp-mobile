// ─── Final onboarding step: import / library setup ────────────────────────────
//
// This is a first-class route, not an overlay. It lives at /onboarding-import
// outside (tabs) so there is no tab bar — it feels like a dedicated destination.
//
// Navigation contract:
//   → Arrived from walkthrough completion (router.replace from _layout.tsx)
//   → On refresh: URL persists natively, page re-mounts and checks state
//   → On navigate-away while pending: _layout.tsx redirects back here
//
// Actions:
//   Import library  → write 'importing' → push /import/goodreads
//   Answer questions → write 'dismissed' → navigate /(tabs)/search
//   Not right now   → write 'dismissed' → replace /(tabs)
//
// State guard:
//   On mount we read importObState. If it is NOT 'pending' (user already
//   acted, or somehow arrived here directly), we redirect home immediately.

import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getImportObState, setImportObState } from '../components/OnboardingImportPrompt';

const BG  = '#faf9f7';
const INK = '#1c1917';
const SUB = '#78716c';
const MUT = '#a8a29e';
const BOR = '#e7e5e4';

export default function OnboardingImportPage() {
  const router  = useRouter();
  const [ready, setReady] = useState(false);

  // Guard: only render content if state is still 'pending'.
  // Any other value means the user already made a decision (or arrived here
  // directly without completing the walkthrough) — redirect home.
  useEffect(() => {
    // Synchronous mount confirmation — fires before the async state read.
    // If you never see this log, the route is not mounting at all.
    console.log('[IMPORT_ROUTE] MOUNTED — starting AsyncStorage read for readstack_import_ob_v1');

    getImportObState().then(state => {
      console.log('[IMPORT_ROUTE] state_read_complete', {
        state,
        decision: state === 'pending' ? 'RENDER' : 'REDIRECT_HOME',
      });
      if (state !== 'pending') {
        console.log('[IMPORT_ROUTE] not pending — calling router.replace /(tabs)', { state });
        router.replace('/(tabs)' as any);
        return;
      }
      console.log('[IMPORT_ROUTE] state is pending — setting ready=true, will render');
      setReady(true);
    });
  }, []);

  async function handleImport() {
    console.log('[IMPORT_ROUTE] action: import_tapped — writing importing state');
    await setImportObState('importing');
    console.log('[IMPORT_ROUTE] action: importing state written — pushing /import/goodreads');
    router.push('/import/goodreads' as any);
  }

  async function handleIntake() {
    console.log('[IMPORT_ROUTE] action: intake_tapped — writing dismissed state');
    await setImportObState('dismissed');
    console.log('[IMPORT_ROUTE] action: dismissed written — navigating to /(tabs)/search');
    router.navigate('/(tabs)/search' as any);
  }

  async function handleDismiss() {
    console.log('[IMPORT_ROUTE] action: not_right_now_tapped — writing dismissed state');
    await setImportObState('dismissed');
    console.log('[IMPORT_ROUTE] action: dismissed written — replacing with /(tabs)');
    router.replace('/(tabs)' as any);
  }

  // Hold off rendering until the async guard resolves.
  // This prevents a flash of content for users who shouldn't see this page.
  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: BG }} />;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <View style={{
        flex:              1,
        paddingHorizontal: 24,
        justifyContent:    'center',
        paddingBottom:     24,
      }}>

        {/* Step indicator */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 44 }}>
          {[1, 2, 3].map(i => (
            <View
              key={i}
              style={{
                width:           i === 3 ? 24 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: i === 3 ? INK : '#d6d3d1',
              }}
            />
          ))}
          <Text style={{ fontSize: 12, color: MUT, marginLeft: 4, fontWeight: '500' }}>
            Last step
          </Text>
        </View>

        {/* Headline */}
        <Text style={{
          fontSize:      33,
          fontWeight:    '800',
          color:         INK,
          lineHeight:    40,
          letterSpacing: -0.6,
          marginBottom:  14,
        }}>
          One import.{'\n'}Instant recommendations.
        </Text>

        {/* Sub-copy */}
        <Text style={{
          fontSize:     16,
          color:        SUB,
          lineHeight:   26,
          marginBottom: 40,
        }}>
          This is the fastest way to make readstack useful. Connect your reading history and we'll tune your picks from day one.
        </Text>

        {/* Primary CTA */}
        <TouchableOpacity
          onPress={handleImport}
          activeOpacity={0.82}
          style={{
            backgroundColor:   INK,
            borderRadius:      16,
            paddingVertical:   18,
            paddingHorizontal: 20,
            flexDirection:     'row',
            alignItems:        'center',
            gap:               14,
            marginBottom:      14,
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
              fontSize:     17,
              fontWeight:   '700',
              color:        '#fff',
              lineHeight:   22,
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

        {/* Secondary row */}
        <View style={{
          flexDirection:  'row',
          justifyContent: 'center',
          alignItems:     'center',
          gap:            24,
          paddingTop:     8,
        }}>
          <TouchableOpacity
            onPress={handleIntake}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          >
            <Text style={{ fontSize: 14, color: SUB, fontWeight: '500' }}>
              Answer a few questions
            </Text>
          </TouchableOpacity>

          <View style={{ width: 1, height: 14, backgroundColor: BOR }} />

          <TouchableOpacity
            onPress={handleDismiss}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          >
            <Text style={{ fontSize: 14, color: MUT, fontWeight: '500' }}>
              Not right now
            </Text>
          </TouchableOpacity>
        </View>

      </View>
    </SafeAreaView>
  );
}
