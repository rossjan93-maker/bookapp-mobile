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
//   Pick genres      → write stage='done' → navigate /onboarding-questions
//   Skip for now     → write stage='done' → replace /(tabs)/search
//
// State guard:
//   On mount we read the onboarding stage. If it is NOT 'final_setup' (user
//   already acted, or arrived here directly without completing the walkthrough),
//   we redirect home immediately.

import React, { useEffect, useState } from 'react';
import {
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { readOnboardingStage, writeOnboardingStage } from '../lib/onboardingStage';
import { useOnboardingBridge } from './_layout';
import { supabase } from '../lib/supabase';
import { useScreenTopPadding } from '../lib/screenLayout';

const BG   = '#f5f1ec';
const INK  = '#231f1b';
const SUB  = '#6b635c';
const MUT  = '#9e958d';
const BOR  = '#ede9e4';
const SAGE = '#7b9e7e';

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
      // Force a token refresh so the JWT's app_metadata.onboarding_completed
      // claim (set by the trigger in migration 20260421000000) converges to
      // `true` immediately. The cold-start fast path in app/_layout.tsx
      // reads it directly from the JWT to skip the profiles SELECT entirely.
      supabase.auth.refreshSession().catch(() => {});
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
  const topPad = useScreenTopPadding();

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
    // Write stage='intake_active' (NOT 'done') so a cold-restart mid-question
    // routes the user back to /onboarding-questions to finish what they
    // started. The companion draft in lib/intakeDraft.ts preserves their
    // selections across the restart. onboarding-questions writes 'done' once
    // the flow actually completes (or is explicitly skipped).
    await writeOnboardingStage('intake_active');
    console.log('[IMPORT_ROUTE] intake: stage=intake_active written — replacing with /onboarding-questions');
    router.replace('/onboarding-questions' as any);
  }

  async function handleDismiss() {
    console.log('[IMPORT_ROUTE] action: skip_tapped');
    // Disarm the routing guard before navigating.
    completeOnboarding();
    await Promise.all([writeOnboardingStage('done'), markOnboardingComplete()]);
    // Send to the Discover tab — better starting point than an empty home
    // for a user who hasn't added any books yet.
    console.log('[IMPORT_ROUTE] dismiss: stage=done + onboarding_completed written — replacing with /(tabs)/search');
    router.replace('/(tabs)/search' as any);
  }

  // Hold off rendering until the async guard resolves.
  // This prevents a flash of content for users who shouldn't see this page.
  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: BG }} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <View style={{
        flex:              1,
        paddingHorizontal: 22,
        paddingTop:        topPad,
        justifyContent:    'center',
        paddingBottom:     24,
      }}>

        {/* Step indicator */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 24 }}>
          {[1, 2, 3].map(i => (
            <View
              key={i}
              style={{
                width:           i === 3 ? 22 : 6,
                height:          6,
                borderRadius:    3,
                backgroundColor: i === 3 ? INK : '#d8d0c8',
              }}
            />
          ))}
          <Text style={{ fontSize: 12, color: MUT, marginLeft: 4, fontWeight: '500' }}>
            Last step
          </Text>
        </View>

        {/* Headline — sized down so the primary card sits comfortably above the fold */}
        <Text style={{
          fontSize:      27,
          fontWeight:    '800',
          color:         INK,
          lineHeight:    33,
          letterSpacing: -0.5,
          marginBottom:  10,
        }}>
          One import.{'\n'}Instant recommendations.
        </Text>

        {/* Sub-copy — concrete benefit, addresses cold-start fear */}
        <Text style={{
          fontSize:     14.5,
          color:        SUB,
          lineHeight:   22,
          marginBottom: 24,
        }}>
          Your ratings and shelves tell us what you love and where your taste sits. Import them and recommendations are personal from the first session.
        </Text>

        {/* ── Primary CTA: Import ─────────────────────────────────────────── */}
        <TouchableOpacity
          onPress={handleImport}
          activeOpacity={0.82}
          style={{
            backgroundColor:   INK,
            borderRadius:      14,
            paddingVertical:   14,
            paddingHorizontal: 16,
            flexDirection:     'row',
            alignItems:        'center',
            gap:               12,
            marginBottom:      10,
          }}
        >
          <View style={{
            width:           36,
            height:          36,
            borderRadius:    18,
            backgroundColor: '#ffffff14',
            alignItems:      'center',
            justifyContent:  'center',
          }}>
            <Ionicons name="cloud-download-outline" size={18} color="#fff" />
          </View>

          <View style={{ flex: 1 }}>
            <Text style={{
              fontSize:     15.5,
              fontWeight:   '700',
              color:        '#fff',
              lineHeight:   20,
              marginBottom: 2,
            }}>
              Import my library
            </Text>
            <Text style={{ fontSize: 11.5, color: '#b8afa6' }}>
              Goodreads · StoryGraph · others
            </Text>
          </View>

          <Ionicons name="chevron-forward" size={16} color="#9e958d" />
        </TouchableOpacity>

        {/* ── Secondary CTA: Genre-based setup ────────────────────────────── */}
        {/* Clearly styled as second-best — outline card, no fill */}
        <TouchableOpacity
          onPress={handleIntake}
          activeOpacity={0.78}
          style={{
            borderRadius:      12,
            borderWidth:       1.5,
            borderColor:       BOR,
            paddingVertical:   12,
            paddingHorizontal: 16,
            flexDirection:     'row',
            alignItems:        'center',
            gap:               12,
            marginBottom:      20,
          }}
        >
          <View style={{
            width:           36,
            height:          36,
            borderRadius:    18,
            backgroundColor: SAGE + '18',
            alignItems:      'center',
            justifyContent:  'center',
          }}>
            <Ionicons name="options-outline" size={17} color={SAGE} />
          </View>

          <View style={{ flex: 1 }}>
            <Text style={{
              fontSize:     14,
              fontWeight:   '600',
              color:        INK,
              lineHeight:   19,
              marginBottom: 1,
            }}>
              Pick genres instead
            </Text>
            <Text style={{ fontSize: 11.5, color: MUT }}>
              No file needed — takes about 30 seconds
            </Text>
          </View>

          <Ionicons name="chevron-forward" size={15} color={MUT} />
        </TouchableOpacity>

        {/* ── Tertiary: Skip — intentional exit, not a dead end ───────────── */}
        <TouchableOpacity
          onPress={handleDismiss}
          activeOpacity={0.6}
          hitSlop={{ top: 12, bottom: 12, left: 20, right: 20 }}
          style={{ alignItems: 'center' }}
        >
          <Text style={{ fontSize: 13, color: MUT, fontWeight: '500' }}>
            Skip for now
          </Text>
          <Text style={{ fontSize: 11, color: MUT, opacity: 0.6, marginTop: 3 }}>
            You can import any time from your profile
          </Text>
        </TouchableOpacity>

      </View>
    </View>
  );
}
