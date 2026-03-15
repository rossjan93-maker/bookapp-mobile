import { Image, Text, View } from 'react-native';

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
  const style = { width, height, borderRadius: 5 } as const;
  const derived = externalId ? deriveCoverUrl(externalId, editionKey) : editionKey ? `https://covers.openlibrary.org/b/olid/${editionKey}-M.jpg` : null;
  const src = url || derived;
  if (src) {
    return <Image source={{ uri: src }} style={style} resizeMode="cover" />;
  }
  const letter = title ? title.trim().charAt(0).toUpperCase() : '';
  if (letter) {
    return (
      <View style={[style, { backgroundColor: '#e7e5e4', alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ fontSize: Math.round(width * 0.45), fontWeight: '700', color: '#a8a29e' }}>
          {letter}
        </Text>
      </View>
    );
  }
  return <View style={[style, { backgroundColor: '#e7e5e4' }]} />;
}
