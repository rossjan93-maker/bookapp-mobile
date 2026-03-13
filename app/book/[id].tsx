import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CoverThumb } from '../../components/CoverThumb';

const STATUS_META: Record<string, { bg: string; text: string; label: string }> = {
  want_to_read: { bg: '#f1f5f9', text: '#475569', label: 'Want to Read' },
  reading:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'       },
  finished:     { bg: '#dcfce7', text: '#15803d', label: 'Finished'      },
  dnf:          { bg: '#fee2e2', text: '#b91c1c', label: 'DNF'           },
  sent:         { bg: '#f1f5f9', text: '#475569', label: 'Sent'          },
  saved:        { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read'  },
  started:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'       },
};

export default function BookDetailScreen() {
  const router = useRouter();
  const {
    title,
    author,
    coverUrl,
    externalId,
    status,
    note,
    fromUser,
    toUser,
  } = useLocalSearchParams<{
    id: string;
    title?: string;
    author?: string;
    coverUrl?: string;
    externalId?: string;
    status?: string;
    note?: string;
    fromUser?: string;
    toUser?: string;
  }>();

  const badge = status ? (STATUS_META[status] ?? null) : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingBottom: 60 }}
    >
      {/* ── Hero cover area ── */}
      <View style={{
        backgroundColor: '#f0ede8',
        alignItems: 'center',
        paddingTop: 60,
        paddingBottom: 36,
      }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: 56, left: 20, zIndex: 10 }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={{ fontSize: 14, color: '#6b7280' }}>← Back</Text>
        </TouchableOpacity>
        <CoverThumb
          url={coverUrl || null}
          externalId={externalId || null}
          width={110}
          height={162}
        />
      </View>

      {/* ── Metadata ── */}
      <View style={{ paddingHorizontal: 24, paddingTop: 28 }}>
        <Text style={{
          fontSize: 24,
          fontWeight: '800',
          color: '#111827',
          letterSpacing: -0.3,
          lineHeight: 30,
          marginBottom: 6,
        }}>
          {title ?? '—'}
        </Text>
        <Text style={{ fontSize: 16, color: '#6b7280', marginBottom: 22 }}>
          {author ?? '—'}
        </Text>

        {badge && (
          <View style={{ marginBottom: 22, flexDirection: 'row' }}>
            <View style={{
              backgroundColor: badge.bg,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 5,
            }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: badge.text }}>
                {badge.label}
              </Text>
            </View>
          </View>
        )}

        {note ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            marginBottom: 14,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 1,
          }}>
            <Text style={{
              fontSize: 10,
              fontWeight: '700',
              color: '#9ca3af',
              letterSpacing: 0.9,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}>
              Note
            </Text>
            <Text style={{ fontSize: 14, color: '#374151', fontStyle: 'italic', lineHeight: 22 }}>
              "{note}"
            </Text>
          </View>
        ) : null}

        {(fromUser || toUser) ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 1,
          }}>
            {fromUser ? (
              <Text style={{ fontSize: 14, color: '#6b7280', marginBottom: toUser ? 8 : 0 }}>
                Recommended by{' '}
                <Text style={{ fontWeight: '700', color: '#111827' }}>{fromUser}</Text>
              </Text>
            ) : null}
            {toUser ? (
              <Text style={{ fontSize: 14, color: '#6b7280' }}>
                Recommended to{' '}
                <Text style={{ fontWeight: '700', color: '#111827' }}>{toUser}</Text>
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
