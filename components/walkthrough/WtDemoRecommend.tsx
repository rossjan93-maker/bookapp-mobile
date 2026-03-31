import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useWalkthroughTarget } from '../../lib/walkthroughEngine';

export function WtDemoRecommend() {
  const { ref, onLayout } = useWalkthroughTarget('recommend_content');

  return (
    <View style={{ marginBottom: 36 }}>
      {/* Section header — matches real RecommendationsFeed */}
      <Text style={{
        fontSize: 11, fontWeight: '700', color: '#a8a29e',
        letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 12,
      }}>
        For You
      </Text>

      {/* Picked for you row — matches real ready state header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#1c1917', flex: 1 }}>
          Picked for you
        </Text>
      </View>

      {/* Demo RecCard — invisible measurement target only.
          The overlay focal card renders the visible version above the dim. */}
      <View
        ref={ref}
        onLayout={onLayout}
        style={{
          backgroundColor: '#fff',
          borderRadius: 14,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: '#e7e5e4',
          shadowColor: '#1c1917',
          shadowOpacity: 0.22,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 8 },
          elevation: 14,
          overflow: 'hidden',
          opacity: 0,
        }}
      >
        {/* Top accent bar — featured card marker */}
        <View style={{ height: 3, backgroundColor: '#1c1917' }} />

        {/* Card body */}
        <View style={{ padding: 12, flexDirection: 'row', alignItems: 'flex-start' }}>
          {/* Cover placeholder */}
          <View style={{
            width: 52, height: 76, borderRadius: 6, backgroundColor: '#ddd5c8',
          }} />

          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{
              fontSize: 15, fontWeight: '700', color: '#1c1917',
              lineHeight: 21, marginBottom: 3,
            }} numberOfLines={2}>
              Project Hail Mary
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6 }}>
              <Text style={{ fontSize: 12, color: '#78716c', flex: 1 }} numberOfLines={1}>
                Andy Weir
              </Text>
              {/* TOP PICK confidence chip */}
              <View style={{
                backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0',
                borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2,
              }}>
                <Text style={{
                  fontSize: 9, fontWeight: '700', color: '#15803d', letterSpacing: 0.3,
                }}>
                  TOP PICK
                </Text>
              </View>
            </View>

            {/* Match reason */}
            <Text style={{
              fontSize: 13, fontWeight: '600', color: '#1c1917',
              lineHeight: 18, marginBottom: 2,
            }} numberOfLines={2}>
              Long-form science with immersive pacing
            </Text>
          </View>
        </View>

        {/* Action bar — matches real RecCard */}
        <View style={{
          borderTopWidth: 1, borderTopColor: '#f0eeeb',
          flexDirection: 'row', alignItems: 'stretch',
        }}>
          <TouchableOpacity
            activeOpacity={0.7}
            style={{
              flex: 1, paddingVertical: 14, paddingHorizontal: 14,
              justifyContent: 'center',
              borderRightWidth: 1, borderRightColor: '#f0eeeb',
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: '700', color: '#1c1917' }}>
              Want to Read
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.7}
            style={{
              paddingVertical: 14, paddingHorizontal: 13,
              justifyContent: 'center', alignItems: 'center',
              borderRightWidth: 1, borderRightColor: '#f0eeeb',
            }}
          >
            <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '500' }}>
              Not for me
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            activeOpacity={0.7}
            style={{
              paddingVertical: 14, paddingHorizontal: 13,
              justifyContent: 'center', alignItems: 'center',
            }}
          >
            <Text style={{ fontSize: 12, color: '#78716c', fontWeight: '500' }}>
              More like this
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
