import { useEffect, useRef, useState } from 'react';
import { Animated, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_PREFIX = 'readstack_tooltip_v1_';

type Props = {
  id: string;
  text: string;
  position?: 'top' | 'bottom';
  children: React.ReactNode;
};

export function OnboardingTooltip({ id, text, position = 'bottom', children }: Props) {
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_PREFIX + id).then(val => {
      if (!val) {
        setVisible(true);
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          delay: 600,
          useNativeDriver: true,
        }).start();
        const t = setTimeout(dismiss, 5000);
        return () => clearTimeout(t);
      }
    });
  }, [id]);

  function dismiss() {
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setVisible(false);
    });
    AsyncStorage.setItem(STORAGE_PREFIX + id, '1').catch(() => {});
  }

  const bubbleStyle = {
    position: 'absolute' as const,
    left: '50%' as unknown as number,
    transform: [{ translateX: -100 }],
    width: 200,
    backgroundColor: '#1c1917',
    borderRadius: 8,
    padding: 10,
    zIndex: 100,
    ...(position === 'bottom'
      ? { top: '100%' as unknown as number, marginTop: 8 }
      : { bottom: '100%' as unknown as number, marginBottom: 8 }),
  };

  const arrowStyle = {
    position: 'absolute' as const,
    left: 92,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    ...(position === 'bottom'
      ? { top: -7, borderBottomWidth: 7, borderBottomColor: '#1c1917' }
      : { bottom: -7, borderTopWidth: 7, borderTopColor: '#1c1917' }),
  };

  return (
    <View style={{ position: 'relative' }}>
      {children}
      {visible && (
        <Animated.View style={{ opacity, ...bubbleStyle }}>
          <View style={arrowStyle} />
          <Text style={{ color: '#fff', fontSize: 12, lineHeight: 17 }}>{text}</Text>
          <TouchableOpacity onPress={dismiss} style={{ marginTop: 8, alignSelf: 'flex-end' }}>
            <Text style={{ color: '#a8a29e', fontSize: 11 }}>Got it</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}
