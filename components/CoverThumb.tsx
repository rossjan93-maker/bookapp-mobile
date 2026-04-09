import { useRef } from 'react';
import { Animated, Text, View } from 'react-native';

type Props = {
  url?: string | null;
  externalId?: string | null;
  editionKey?: string | null;
  title?: string | null;
  width?: number;
  height?: number;
};

function deriveCoverUrl(externalId: string, editionKey?: string | null): string | null {
  if (editionKey) {
    return `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg`;
  }
  const match = externalId.match(/\/works\/(OL\w+)/);
  if (!match) return null;
  return `https://covers.openlibrary.org/w/olid/${match[1]}-M.jpg`;
}

export function CoverThumb({ url, externalId, editionKey, title, width = 40, height = 58 }: Props) {
  const imgOpacity = useRef(new Animated.Value(0)).current;
  const style = { width, height, borderRadius: 5 } as const;
  const derived = externalId
    ? deriveCoverUrl(externalId, editionKey)
    : editionKey
    ? `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg`
    : null;
  const src = url || derived;

  if (src) {
    return (
      <View style={[style, { backgroundColor: '#ede9e4', overflow: 'hidden' }]}>
        <Animated.Image
          source={{ uri: src }}
          style={[{ position: 'absolute', top: 0, left: 0, width, height }, { opacity: imgOpacity }]}
          resizeMode="cover"
          onLoad={() =>
            Animated.timing(imgOpacity, { toValue: 1, duration: 220, useNativeDriver: true }).start()
          }
        />
      </View>
    );
  }

  const letter = title ? title.trim().charAt(0).toUpperCase() : '';
  if (letter) {
    return (
      <View style={[style, { backgroundColor: '#ede9e4', alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ fontSize: Math.round(width * 0.45), fontWeight: '700', color: '#9e958d' }}>
          {letter}
        </Text>
      </View>
    );
  }
  return <View style={[style, { backgroundColor: '#ede9e4' }]} />;
}
