import React from 'react';
import { Text, View } from 'react-native';
import { useWalkthroughTarget } from '../../lib/walkthroughEngine';

export function WtDemoLibrary() {
  const { ref, onLayout } = useWalkthroughTarget('library_content');

  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f7' }}>
      {/* Library editorial header — matches real ListHeaderComponent style */}
      <View style={{
        flexDirection: 'row', alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingTop: 24, paddingBottom: 16,
        paddingHorizontal: 20,
      }}>
        <View>
          <Text style={{
            fontSize: 28, fontWeight: '800', color: '#1c1917',
            letterSpacing: -0.5, lineHeight: 34,
          }}>
            Library
          </Text>
          <Text style={{ fontSize: 14, color: '#a8a29e', marginTop: 2 }}>
            Your reading history
          </Text>
        </View>
      </View>

      <View style={{ paddingHorizontal: 20 }}>
        {/* "Currently Reading" section label */}
        <Text style={{
          fontSize: 11, fontWeight: '700', color: '#a8a29e',
          letterSpacing: 1, textTransform: 'uppercase',
          marginTop: 10, marginBottom: 8,
        }}>
          Currently Reading
        </Text>

        {/* Row 1 — Reading card (same style as real library renderItem reading branch) */}
        <View
          ref={ref}
          onLayout={onLayout}
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            marginVertical: 6,
            borderLeftWidth: 3,
            borderLeftColor: '#3b82f6',
            shadowColor: '#1c1917',
            shadowOpacity: 0.18,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 6 },
            elevation: 12,
            paddingTop: 14, paddingRight: 14,
            paddingBottom: 14, paddingLeft: 14,
            transform: [{ scale: 1.02 }],
            borderWidth: 1,
            borderColor: 'rgba(59, 130, 246, 0.18)',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            {/* Cover placeholder */}
            <View style={{
              width: 44, height: 64, borderRadius: 6, backgroundColor: '#ddd5c8',
            }} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{
                fontSize: 14, fontWeight: '700', color: '#1c1917',
                lineHeight: 19, marginBottom: 3,
              }} numberOfLines={2}>
                The Midnight Library
              </Text>
              <Text style={{ fontSize: 12, color: '#78716c' }}>Matt Haig</Text>
            </View>
          </View>

          {/* Progress bar */}
          <View style={{
            height: 3, backgroundColor: '#e7e5e4',
            borderRadius: 2, overflow: 'hidden',
            marginTop: 10, marginBottom: 4,
          }}>
            <View style={{
              height: 3, width: '34%',
              backgroundColor: '#3b82f6', borderRadius: 2,
            }} />
          </View>
          <Text style={{ fontSize: 10, color: '#a8a29e' }}>
            Page 145 of 432 · 34%
          </Text>
        </View>

        {/* "Library" section label */}
        <Text style={{
          fontSize: 11, fontWeight: '700', color: '#c4b5a5',
          letterSpacing: 1, textTransform: 'uppercase',
          marginTop: 16, marginBottom: 8,
        }}>
          Library
        </Text>

        {/* Row 2 — Flat archival row (same style as real non-reading branch) */}
        <View style={{
          paddingTop: 18, paddingBottom: 18,
          borderBottomWidth: 1, borderBottomColor: '#f5f5f4',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {/* Cover placeholder */}
            <View style={{
              width: 40, height: 58, borderRadius: 5, backgroundColor: '#ddd5c8',
            }} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{
                fontSize: 14, fontWeight: '600', color: '#1c1917',
                lineHeight: 19, marginBottom: 2,
              }} numberOfLines={1}>
                Atomic Habits
              </Text>
              <Text style={{ fontSize: 12, color: '#78716c' }}>James Clear</Text>
            </View>
            {/* Status chip */}
            <View style={{
              backgroundColor: '#f0fdf4',
              borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
              borderWidth: 1, borderColor: '#bbf7d0',
            }}>
              <Text style={{ fontSize: 11, fontWeight: '600', color: '#15803d' }}>
                Finished
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
