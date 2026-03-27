import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

const STORAGE_KEY = 'readstack_walkthrough_v1';

type Step = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  tabIndex?: number;
};

const STEPS: Step[] = [
  {
    icon: 'book',
    title: 'Welcome to Readstack',
    body: "You'll get personalized reading recommendations that get smarter every time you rate a book.",
  },
  {
    icon: 'paper-plane',
    title: 'Your recommendations',
    body: "Tap 'Recommend' to see your personalized picks. Save, dismiss, or ask for more like any book.",
    tabIndex: 1,
  },
  {
    icon: 'library',
    title: 'Your library',
    body: "Track every book you've read, are reading, or want to read. Ratings here fuel your recommendations.",
    tabIndex: 2,
  },
  {
    icon: 'barcode',
    title: 'Scan any book',
    body: "From the Recommend screen, tap the barcode icon to instantly see whether a book fits your taste.",
  },
];

type Props = {
  onDone: () => void;
};

export function OnboardingWalkthrough({ onDone }: Props) {
  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const { width: W, height: H } = Dimensions.get('window');

  const TAB_COUNT = 5;
  const TAB_W = W / TAB_COUNT;

  function nextStep() {
    Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      if (step < STEPS.length - 1) {
        setStep(s => s + 1);
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      } else {
        finish();
      }
    });
  }

  function finish() {
    AsyncStorage.setItem(STORAGE_KEY, '1').catch(() => {});
    onDone();
  }

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const tabHighlightLeft =
    current.tabIndex != null ? TAB_W * current.tabIndex : null;

  return (
    <Modal transparent animationType="fade" statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.72)' }}>

        <TouchableOpacity
          onPress={finish}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={{ position: 'absolute', top: 52, right: 20, zIndex: 10 }}
        >
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>Skip</Text>
        </TouchableOpacity>

        {tabHighlightLeft != null && (
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: tabHighlightLeft,
              width: TAB_W,
              height: 62,
              borderTopWidth: 2,
              borderTopColor: '#16a34a',
              backgroundColor: 'rgba(22,163,74,0.12)',
            }}
          />
        )}

        <Animated.View
          style={{
            opacity: fadeAnim,
            position: 'absolute',
            bottom: 82,
            left: 20,
            right: 20,
          }}
        >
          {tabHighlightLeft != null && (
            <View style={{ alignItems: 'center', marginBottom: 10 }}>
              <View
                style={{
                  width: 2,
                  height: 28,
                  backgroundColor: '#16a34a',
                  borderRadius: 1,
                }}
              />
            </View>
          )}

          <View
            style={{
              backgroundColor: '#fff',
              borderRadius: 16,
              padding: 22,
              shadowColor: '#000',
              shadowOpacity: 0.18,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 8 },
              elevation: 12,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: '#f5f5f4',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 12,
                }}
              >
                <Ionicons name={current.icon} size={18} color="#1c1917" />
              </View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#1c1917', flex: 1 }}>
                {current.title}
              </Text>
            </View>

            <Text style={{ fontSize: 14, color: '#57534e', lineHeight: 21, marginBottom: 20 }}>
              {current.body}
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {STEPS.map((_, i) => (
                  <View
                    key={i}
                    style={{
                      width: i === step ? 20 : 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: i === step ? '#1c1917' : '#e7e5e4',
                    }}
                  />
                ))}
              </View>

              <TouchableOpacity
                onPress={nextStep}
                activeOpacity={0.8}
                style={{
                  backgroundColor: '#1c1917',
                  paddingHorizontal: 20,
                  paddingVertical: 10,
                  borderRadius: 10,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>
                  {isLast ? 'Get started' : 'Next'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

export async function shouldShowWalkthrough(): Promise<boolean> {
  const val = await AsyncStorage.getItem(STORAGE_KEY);
  return val == null;
}
