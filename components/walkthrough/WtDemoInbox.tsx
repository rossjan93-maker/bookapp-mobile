import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useWalkthroughTarget } from '../../lib/walkthroughEngine';
import { CoverThumb } from '../CoverThumb';
import { DEMO_COVERS } from '../../lib/demoCoverUrls';

export function WtDemoInbox() {
  const { ref, onLayout } = useWalkthroughTarget('inbox_content');

  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f7', paddingHorizontal: 20, paddingTop: 24 }}>
      <View style={{ marginBottom: 24 }}>
        <Text style={{
          fontSize: 28, fontWeight: '800', color: '#1c1917',
          letterSpacing: -0.5, marginBottom: 5,
        }}>
          Inbox
        </Text>
        <Text style={{ fontSize: 14, color: '#a8a29e' }}>
          Your recommendations from friends
        </Text>
      </View>

      <Text style={{
        fontSize: 11, fontWeight: '700', color: '#a8a29e',
        letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10,
      }}>
        New · 1
      </Text>

      {/* Demo inbox card — invisible measurement target only.
          The overlay renders the visible focal card at these coordinates.
          opacity:0 hides this so the focal card above the dim has no ghost twin. */}
      <View
        ref={ref}
        onLayout={onLayout}
        style={{
          backgroundColor: '#fffbf5',
          borderRadius: 14,
          borderLeftWidth: 3,
          borderLeftColor: '#d4a574',
          padding: 16,
          marginBottom: 10,
          shadowColor: '#1c1917',
          shadowOpacity: 0.22,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 8 },
          elevation: 14,
          borderWidth: 1,
          borderColor: 'rgba(212, 165, 116, 0.15)',
          opacity: 0,
        }}
      >
        <Text style={{
          fontSize: 10, fontWeight: '700', color: '#b8860b',
          letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10,
        }}>
          From Alex
        </Text>

        <View style={{ flexDirection: 'row', marginBottom: 12 }}>
          <CoverThumb
            url={DEMO_COVERS.songOfAchilles}
            title="The Song of Achilles"
            width={48}
            height={70}
          />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{
              fontWeight: '700', fontSize: 16, color: '#1c1917',
              lineHeight: 22, marginBottom: 3,
            }}>
              The Song of Achilles
            </Text>
            <Text style={{ color: '#78716c', fontSize: 13 }}>
              Madeline Miller
            </Text>
          </View>
        </View>

        <View style={{
          backgroundColor: '#fffbf2',
          borderTopWidth: 1, borderTopColor: '#f0ede8',
          paddingTop: 10, paddingHorizontal: 10,
          paddingBottom: 8, borderRadius: 6, marginBottom: 14,
        }}>
          <Text style={{
            fontSize: 13, color: '#57534e', fontStyle: 'italic', lineHeight: 20,
          }}>
            "You need to read this. Trust me."
          </Text>
        </View>

        <TouchableOpacity
          activeOpacity={0.8}
          style={{
            alignSelf: 'flex-start',
            paddingHorizontal: 16, paddingVertical: 9,
            backgroundColor: '#1c1917', borderRadius: 8,
          }}
        >
          <Text style={{ color: '#faf9f7', fontSize: 13, fontWeight: '700' }}>
            Want to Read
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
