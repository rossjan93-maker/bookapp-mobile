// ─── Final onboarding step: import / library setup ────────────────────────────
//
// This is a first-class route, not an overlay. It lives at /onboarding-import
// outside (tabs) so there is no tab bar — it feels like a dedicated destination.
//
// Navigation contract:
//   → Arrived when _layout.tsx reads stage='final_setup' (advanceWt/skipWt)
//   → On refresh: URL persists natively, page re-mounts and checks state
//   → On navigate-away before acting: _layout.tsx redirects back here
//
// Actions:
//   Import library   → write stage='done' → push /import/goodreads
//   Answer questions → write stage='done' → navigate /(tabs)/search
//   Not right now    → write stage='done' → replace /(tabs)
//
// State guard:
//   On mount we read the onboarding stage. If it is NOT 'final_setup' (user
//   already acted, or arrived here directly without completing the walkthrough),
//   we redirect home immediately.

import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { readOnboardingStage, writeOnboardingStage } from '../lib/onboardingStage';
import { useOnboardingBridge } from './_layout';
import { supabase } from '../lib/supabase';

const BG  = '#faf9f7';
const INK = '#1c1917';
const SUB = '#78716c';
const MUT = '#a8a29e';
const BOR = '#e7e5e4';

// ─── Shared helper ────────────────────────────────────────────────────────────
// Write onboarding_completed=true to the profiles table.
// Called from every resolution action so the flag is durable for future logins.
// Uses getSession() (cached) to avoid a network round-trip.
async function markOnboardingComplete(): Promise<void> {
  if (!supabase) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      await supabase
        .from('profiles')
        .update({ onboarding_completed: true })
        .eq('id', session.user.id);
    }
  } catch {
    // Non-blocking — local stage='done' already prevents the import page from
    // appearing again; this write is belt-and-suspenders for future logins.
  }
}

export default function OnboardingImportPage() {
  const router  = useRouter();
  const { completeOnboarding } = useOnboardingBridge();
  const [ready, setReady] = useState(false);

  // Guard: only render content if the onboarding stage is 'final_setup'.
  // Any other value means the user already acted (or arrived here directly
  // without completing the walkthrough) — redirect home immediately.
  useEffect(() => {
    console.log('[IMPORT_ROUTE] MOUNTED — reading readstack_onboarding_stage_v1');

    readOnboardingStage().then(stage => {
      console.log('[IMPORT_ROUTE] stage_read_complete', {
        stage,
        decision: stage === 'final_setup' ? 'RENDER' : 'REDIRECT_HOME',
      });
      if (stage !== 'final_setup') {
        console.log('[IMPORT_ROUTE] stage is not final_setup — redirecting home', { stage });
        router.replace('/(tabs)' as any);
        return;
      }
      console.log('[IMPORT_ROUTE] stage is final_setup — setting ready=true, will render');
      setReady(true);
    });
  }, []);

  async function handleImport() {
    console.log('[IMPORT_ROUTE] action: import_tapped');
    // completeOnboarding() tells the root layout guard immediately so it does
    // not re-intercept when segments change away from onboarding-import.
    completeOnboarding();
    await Promise.all([writeOnboardingStage('done'), markOnboardingComplete()]);
    console.log('[IMPORT_ROUTE] import: stage=done + onboarding_completed written — pushing /import/goodreads');
    router.push('/import/goodreads' as any);
  }

  async function handleIntake() {
    console.log('[IMPORT_ROUTE] action: intake_tapped');
    // Disarm the routing guard before navigating.
    completeOnboarding();
    // Write stage='done' so onboarding-import doesn't re-appear if the user
    // backs out mid-questions. Do NOT write markOnboardingComplete() here —
    // that is deferred to onboarding-questions when the flow actually finishes.
    await writeOnboardingStage('done');
    console.log('[IMPORT_ROUTE] intake: stage=done written — replacing with /onboarding-questions');
    router.replace('/onboarding-questions' as any);
  }

  async function handleDismiss() {
    console.log('[IMPORT_ROUTE] action: not_right_now_tapped');
    // Disarm the routing guard before navigating.
    completeOnboarding();
    await Promise.all([writeOnboardingStage('done'), markOnboardingComplete()]);
    console.log('[IMPORT_ROUTE] dismiss: stage=done + onboarding_completed written — replacing with /(tabs)');
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
