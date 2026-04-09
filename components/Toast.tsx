import { useEffect, useRef, useState } from 'react';
import { Animated, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  type ToastOptions,
  type ToastVariant,
  registerToastListener,
  unregisterToastListener,
} from '../lib/toast';

const DURATION_MS   = 2500;
const SLIDE_PX      = 28;
const ANIMATE_IN_MS = 260;
const ANIMATE_OUT_MS = 200;

const VARIANT_BG: Record<ToastVariant, string> = {
  success: '#231f1b',
  error:   '#991b1b',
  info:    '#231f1b',
};

export function ToastContainer() {
  const insets = useSafeAreaInsets();

  const [current, setCurrent] = useState<ToastOptions | null>(null);
  const translateY = useRef(new Animated.Value(SLIDE_PX)).current;
  const opacity    = useRef(new Animated.Value(0)).current;
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  function dismiss() {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0, duration: ANIMATE_OUT_MS, useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: SLIDE_PX, duration: ANIMATE_OUT_MS, useNativeDriver: true,
      }),
    ]).start(() => setCurrent(null));
  }

  function show(opts: ToastOptions) {
    // Clear any running dismiss timer
    if (timerRef.current) clearTimeout(timerRef.current);

    // Reset and replace
    translateY.setValue(SLIDE_PX);
    opacity.setValue(0);
    setCurrent(opts);

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1, duration: ANIMATE_IN_MS, useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0, duration: ANIMATE_IN_MS, useNativeDriver: true,
      }),
    ]).start();

    timerRef.current = setTimeout(dismiss, DURATION_MS);
  }

  useEffect(() => {
    registerToastListener(show);
    return () => {
      unregisterToastListener();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!current) return null;

  const bg = VARIANT_BG[current.variant ?? 'success'];
  // Bottom offset: above the tab bar (≈60px) + safe area + breathing room
  const bottomOffset = Math.max(insets.bottom, 16) + 60 + 16;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position:  'absolute',
        bottom:    bottomOffset,
        left:      20,
        right:     20,
        zIndex:    9999,
        opacity,
        transform: [{ translateY }],
      }}
    >
      <View style={{
        backgroundColor:  bg,
        borderRadius:     24,
        paddingVertical:  12,
        paddingHorizontal: 18,
        flexDirection:    'row',
        alignItems:       'center',
        shadowColor:      '#000',
        shadowOpacity:    0.18,
        shadowRadius:     12,
        shadowOffset:     { width: 0, height: 4 },
        elevation:        8,
      }}>
        <Text style={{
          flex:       1,
          color:      '#fff',
          fontSize:   14,
          fontWeight: '500',
          lineHeight: 20,
        }}>
          {current.message}
        </Text>

        {current.action && (
          <TouchableOpacity
            onPress={() => {
              if (timerRef.current) clearTimeout(timerRef.current);
              current.action!.onPress();
              dismiss();
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ marginLeft: 12 }}
          >
            <Text style={{
              color:      'rgba(255,255,255,0.65)',
              fontSize:   13,
              fontWeight: '600',
            }}>
              {current.action.label}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}
