import { Image, View } from 'react-native';

type Props = {
  url?: string | null;
  externalId?: string | null;
  width?: number;
  height?: number;
};

/**
 * Derives a cover URL from an Open Library external_id.
 *
 * external_id format: "/works/OL12345W"
 *
 * Open Library covers API:
 *   - /b/id/{numeric}    — numeric cover_i (stored in cover_url when available)
 *   - /w/olid/{work-id}  — works-level OLID  ← correct for work keys
 *   - /b/olid/{edition}  — edition OLID only (NOT usable from work keys)
 */
function deriveCoverUrl(externalId: string): string | null {
  const match = externalId.match(/\/works\/(OL\w+)/);
  if (!match) return null;
  return `https://covers.openlibrary.org/w/olid/${match[1]}-M.jpg`;
}

export function CoverThumb({ url, externalId, width = 40, height = 58 }: Props) {
  const style = { width, height, borderRadius: 4 } as const;
  const src = url || (externalId ? deriveCoverUrl(externalId) : null);
  if (src) {
    return <Image source={{ uri: src }} style={style} resizeMode="cover" />;
  }
  return <View style={[style, { backgroundColor: '#e5e7eb' }]} />;
}
