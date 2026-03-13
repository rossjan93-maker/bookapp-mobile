import { Image, View } from 'react-native';

type Props = {
  url?: string | null;
  width?: number;
  height?: number;
};

export function CoverThumb({ url, width = 40, height = 58 }: Props) {
  const style = { width, height, borderRadius: 3 } as const;
  if (url) {
    return <Image source={{ uri: url }} style={style} resizeMode="cover" />;
  }
  return <View style={[style, { backgroundColor: '#e5e7eb' }]} />;
}
