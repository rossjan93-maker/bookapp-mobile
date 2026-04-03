import { useRef } from 'react';
import { Animated, Pressable, StyleProp, Text, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

interface BackButtonProps {
  onPress:   () => void;
  label?:    string;
  disabled?: boolean;
  color?:    string;
  style?:    StyleProp<ViewStyle>;
}

export function BackButton({
  onPress,
  label,
  disabled = false,
  color    = '#78716c',
  style,
}: BackButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;

  function handlePressIn() {
    Animated.spring(scale, {
      toValue:         0.85,
      useNativeDriver: true,
      speed:           50,
      bounciness:      0,
    }).start();
  }

  function handlePressOut() {
    Animated.spring(scale, {
      toValue:         1,
      useNativeDriver: true,
      speed:           30,
      bounciness:      6,
    }).start();
  }

  function handlePress() {
    if (disabled) return;
    Haptics.selectionAsync().catch(() => {});
    onPress();
  }

  return (
    <Pressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      hitSlop={20}
      style={[{ alignSelf: 'flex-start' }, style]}
      accessibilityRole="button"
      accessibilityLabel={label ? `Back to ${label}` : 'Go back'}
    >
      <Animated.View
        style={{
          flexDirection: 'row',
          alignItems:    'center',
          gap:           1,
          opacity:       disabled ? 0.30 : 1,
          transform:     [{ scale }],
        }}
      >
        <Ionicons name="chevron-back" size={22} color={color} />
        {label ? (
          <Text style={{ fontSize: 15, color, fontWeight: '500', letterSpacing: -0.1 }}>
            {label}
          </Text>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}
