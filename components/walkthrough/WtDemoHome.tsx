import React from 'react';
import { Text, View } from 'react-native';
import { useWalkthroughTarget } from '../../lib/walkthroughEngine';
import { CoverThumb } from '../CoverThumb';
import { DEMO_COVERS } from '../../lib/demoCoverUrls';

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11, fontWeight: '700', color: '#9e958d',
      letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10,
    }}>
      {children}
    </Text>
  );
}

export function WtDemoHome({ greeting }: { greeting: string | null }) {
  const { ref, onLayout } = useWalkthroughTarget('home_content');

  return (
    <>
      <View style={{ marginBottom: 28 }}>
        <Text style={{
          fontSize: 34, fontWeight: '800', color: '#231f1b',
          letterSpacing: -0.8, lineHeight: 40,
        }}>
          {greeting ? `Hi, ${greeting}` : 'Home'}
        </Text>
        <Text style={{ fontSize: 14, color: '#9e958d', marginTop: 5 }}>
          Currently reading · The Thursday Murder Club
        </Text>
      </View>

      <View style={{ marginBottom: 32 }}>
        <SectionLabel>Continue Reading</SectionLabel>

        <View
          ref={ref}
          onLayout={onLayout}
          style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            padding: 14,
            borderLeftWidth: 3,
            borderLeftColor: '#d4a574',
            shadowColor: '#231f1b',
            shadowOpacity: 0.22,
            shadowRadius: 22,
            shadowOffset: { width: 0, height: 8 },
            elevation: 14,
            borderWidth: 1,
            borderColor: 'rgba(212, 165, 116, 0.15)',
            opacity: 0,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <CoverThumb
              url={DEMO_COVERS.thursdayMurderClub}
              title="The Thursday Murder Club"
              width={44}
              height={64}
            />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{
                fontSize: 14, fontWeight: '700', color: '#231f1b',
                lineHeight: 19, marginBottom: 3,
              }} numberOfLines={2}>
                The Thursday Murder Club
              </Text>
              <Text style={{ fontSize: 12, color: '#78716c' }}>
                Richard Osman
              </Text>
            </View>
          </View>

        </View>
      </View>
    </>
  );
}
