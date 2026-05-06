import { SAGE_DEEP } from '../../lib/tokens';
import React from 'react';
import { Text, View } from 'react-native';
import { useWalkthroughTarget } from '../../lib/walkthroughEngine';
import { CoverThumb } from '../CoverThumb';
import { DEMO_COVERS } from '../../lib/demoCoverUrls';

export function WtDemoLibrary() {
  const { ref, onLayout } = useWalkthroughTarget('library_content');

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f1ec' }}>
      <View style={{
        flexDirection: 'row', alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingTop: 24, paddingBottom: 16,
        paddingHorizontal: 20,
      }}>
        <View>
          <Text style={{
            fontSize: 28, fontWeight: '800', color: '#231f1b',
            letterSpacing: -0.5, lineHeight: 34,
          }}>
            Library
          </Text>
          <Text style={{ fontSize: 14, color: '#9e958d', marginTop: 2 }}>
            Your reading history
          </Text>
        </View>
      </View>

      <View style={{ paddingHorizontal: 20 }}>
        <Text style={{
          fontSize: 11, fontWeight: '700', color: '#9e958d',
          letterSpacing: 1, textTransform: 'uppercase',
          marginTop: 10, marginBottom: 8,
        }}>
          Currently Reading
        </Text>

        <View
          ref={ref}
          onLayout={onLayout}
          style={{
            backgroundColor: '#fefcf9',
            borderRadius: 14,
            marginVertical: 6,
            borderLeftWidth: 3,
            borderLeftColor: '#3b82f6',
            shadowColor: '#231f1b',
            shadowOpacity: 0.22,
            shadowRadius: 22,
            shadowOffset: { width: 0, height: 8 },
            elevation: 14,
            paddingTop: 14, paddingRight: 14,
            paddingBottom: 14, paddingLeft: 14,
            borderWidth: 1,
            borderColor: 'rgba(59, 130, 246, 0.15)',
            opacity: 0,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <CoverThumb
              url={DEMO_COVERS.midnightLibrary}
              title="The Midnight Library"
              width={44}
              height={64}
            />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{
                fontSize: 14, fontWeight: '700', color: '#231f1b',
                lineHeight: 19, marginBottom: 3,
              }} numberOfLines={2}>
                The Midnight Library
              </Text>
              <Text style={{ fontSize: 12, color: '#78716c' }}>Matt Haig</Text>
            </View>
          </View>

          <View style={{
            height: 3, backgroundColor: '#ede9e4',
            borderRadius: 2, overflow: 'hidden',
            marginTop: 10, marginBottom: 4,
          }}>
            <View style={{
              height: 3, width: '34%',
              backgroundColor: '#3b82f6', borderRadius: 2,
            }} />
          </View>
          <Text style={{ fontSize: 10, color: '#9e958d' }}>
            Page 145 of 432 · 34%
          </Text>
        </View>

        <Text style={{
          fontSize: 11, fontWeight: '700', color: '#c4b5a5',
          letterSpacing: 1, textTransform: 'uppercase',
          marginTop: 16, marginBottom: 8,
        }}>
          Library
        </Text>

        <View style={{
          paddingTop: 18, paddingBottom: 18,
          borderBottomWidth: 1, borderBottomColor: '#ede9e4',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <CoverThumb
              url={DEMO_COVERS.atomicHabits}
              title="Atomic Habits"
              width={40}
              height={58}
            />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{
                fontSize: 14, fontWeight: '600', color: '#231f1b',
                lineHeight: 19, marginBottom: 2,
              }} numberOfLines={1}>
                Atomic Habits
              </Text>
              <Text style={{ fontSize: 12, color: '#78716c' }}>James Clear</Text>
            </View>
            <View style={{
              backgroundColor: '#eaf1ea',
              borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
              borderWidth: 1, borderColor: '#7b9e7e',
            }}>
              <Text style={{ fontSize: 11, fontWeight: '600', color: SAGE_DEEP }}>
                Finished
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
