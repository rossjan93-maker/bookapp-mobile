import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CoverThumb } from '../../components/CoverThumb';

const STATUS_META: Record<string, { bg: string; text: string; label: string }> = {
  want_to_read: { bg: '#f1f5f9', text: '#475569', label: 'Want to Read' },
  reading:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'       },
  finished:     { bg: '#dcfce7', text: '#15803d', label: 'Finished'      },
  dnf:          { bg: '#fee2e2', text: '#b91c1c', label: 'DNF'           },
  sent:         { bg: '#f1f5f9', text: '#475569', label: 'New'           },
  saved:        { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read'  },
  started:      { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'       },
};

type OLMeta = {
  description: string | null;
  subjects: string[];
};

function extractOLID(externalId: string): string | null {
  const match = externalId.match(/\/works\/(OL\w+)/);
  return match ? match[1] : null;
}

async function fetchOLMeta(externalId: string): Promise<OLMeta> {
  const olid = extractOLID(externalId);
  if (!olid) return { description: null, subjects: [] };

  try {
    const res = await fetch(`https://openlibrary.org/works/${olid}.json`);
    if (!res.ok) return { description: null, subjects: [] };
    const data = await res.json();

    let description: string | null = null;
    if (typeof data.description === 'string') {
      description = data.description;
    } else if (data.description && typeof data.description.value === 'string') {
      description = data.description.value;
    }

    const subjects: string[] = Array.isArray(data.subjects)
      ? data.subjects.slice(0, 8)
      : [];

    return { description, subjects };
  } catch {
    return { description: null, subjects: [] };
  }
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 10,
      fontWeight: '700',
      color: '#9ca3af',
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginBottom: 10,
    }}>
      {children}
    </Text>
  );
}

export default function BookDetailScreen() {
  const router = useRouter();
  const {
    id,
    title,
    author,
    coverUrl,
    externalId,
    status,
    note,
    fromUser,
    toUser,
  } = useLocalSearchParams<{
    id?: string;
    title?: string;
    author?: string;
    coverUrl?: string;
    externalId?: string;
    status?: string;
    note?: string;
    fromUser?: string;
    toUser?: string;
  }>();

  const [olMeta, setOlMeta] = useState<OLMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);

  const badge = status ? (STATUS_META[status] ?? null) : null;
  const hasRecContext = !!(fromUser || toUser || note);

  useEffect(() => {
    if (!externalId) return;
    setMetaLoading(true);
    fetchOLMeta(externalId).then(meta => {
      setOlMeta(meta);
      setMetaLoading(false);
    });
  }, [externalId]);

  const descText = olMeta?.description ?? null;
  const DESC_LIMIT = 320;
  const descTruncated = descText && descText.length > DESC_LIMIT && !descExpanded;
  const displayDesc = descTruncated
    ? descText!.slice(0, DESC_LIMIT).trimEnd() + '…'
    : descText;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingBottom: 64 }}
    >
      {/* ── Hero cover area ── */}
      <View style={{
        backgroundColor: '#f0ede8',
        alignItems: 'center',
        paddingTop: 60,
        paddingBottom: 40,
      }}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={{ position: 'absolute', top: 56, left: 20, zIndex: 10 }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={{ fontSize: 14, color: '#78716c' }}>← Back</Text>
        </TouchableOpacity>
        <CoverThumb
          url={coverUrl || null}
          externalId={externalId || null}
          width={116}
          height={170}
        />
      </View>

      <View style={{ paddingHorizontal: 24, paddingTop: 28 }}>

        {/* ── Title + author ── */}
        <Text style={{
          fontSize: 24,
          fontWeight: '800',
          color: '#111827',
          letterSpacing: -0.4,
          lineHeight: 32,
          marginBottom: 6,
        }}>
          {title ?? '—'}
        </Text>
        <Text style={{ fontSize: 16, color: '#78716c', marginBottom: 20 }}>
          {author ?? '—'}
        </Text>

        {/* ── Status badge ── */}
        {badge && (
          <View style={{ flexDirection: 'row', marginBottom: 24 }}>
            <View style={{
              backgroundColor: badge.bg,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: badge.text }}>
                {badge.label}
              </Text>
            </View>
          </View>
        )}

        {/* ── Recommendation context ── */}
        {hasRecContext && (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            marginBottom: 18,
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 1,
          }}>
            {fromUser ? (
              <View style={{ marginBottom: note || toUser ? 12 : 0 }}>
                <SectionLabel>Recommended by</SectionLabel>
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#111827' }}>{fromUser}</Text>
              </View>
            ) : null}
            {toUser ? (
              <View style={{ marginBottom: note ? 12 : 0 }}>
                <SectionLabel>Recommended to</SectionLabel>
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#111827' }}>{toUser}</Text>
              </View>
            ) : null}
            {note ? (
              <View>
                <SectionLabel>Their note</SectionLabel>
                <Text style={{
                  fontSize: 14,
                  color: '#374151',
                  fontStyle: 'italic',
                  lineHeight: 22,
                }}>
                  "{note}"
                </Text>
              </View>
            ) : null}
          </View>
        )}

        {/* ── OL metadata: description ── */}
        {metaLoading ? (
          <View style={{ marginBottom: 18 }}>
            <ActivityIndicator color="#a8a29e" size="small" />
          </View>
        ) : displayDesc ? (
          <View style={{ marginBottom: 18 }}>
            <SectionLabel>About this book</SectionLabel>
            <Text style={{ fontSize: 14, color: '#374151', lineHeight: 23 }}>
              {displayDesc}
            </Text>
            {descText && descText.length > DESC_LIMIT && (
              <TouchableOpacity
                onPress={() => setDescExpanded(v => !v)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginTop: 6 }}
              >
                <Text style={{ fontSize: 13, color: '#78716c', textDecorationLine: 'underline' }}>
                  {descExpanded ? 'Show less' : 'Read more'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}

        {/* ── OL subjects / genres ── */}
        {olMeta && olMeta.subjects.length > 0 && (
          <View style={{ marginBottom: 22 }}>
            <SectionLabel>Subjects</SectionLabel>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {olMeta.subjects.map((subject, i) => (
                <View
                  key={i}
                  style={{
                    backgroundColor: '#f5f5f4',
                    borderRadius: 20,
                    paddingHorizontal: 12,
                    paddingVertical: 5,
                  }}
                >
                  <Text style={{ fontSize: 12, color: '#57534e' }}>{subject}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Taste Fit (foundation placeholder) ── */}
        {externalId ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            borderWidth: 1,
            borderColor: '#f0ede8',
            borderStyle: 'dashed',
            marginBottom: 8,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <View style={{
                backgroundColor: '#fef3c7',
                borderRadius: 6,
                paddingHorizontal: 8,
                paddingVertical: 3,
                marginRight: 10,
              }}>
                <Text style={{ fontSize: 10, fontWeight: '700', color: '#92400e', letterSpacing: 0.5 }}>
                  COMING SOON
                </Text>
              </View>
              <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917' }}>
                Taste Match
              </Text>
            </View>
            <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 20 }}>
              Once we know your reading history better, we'll explain why this book might (or might not) be a great fit for you.
            </Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
