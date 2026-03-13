import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { CoverThumb } from '../../components/CoverThumb';
import { computePacingNote, computeGoalProgress } from '../../lib/pacing';

type Profile = {
  username: string;
  yearly_reading_goal: number | null;
};

type CurrentlyReading = {
  id: string;
  book_id: string;
  started_at: string | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

type PendingRequest = {
  id: string;
  requester_id: string;
  requester: { username: string } | null;
};

type SentRecommendation = {
  id: string;
  book_id: string;
  status: string;
  created_at: string;
  note: string | null;
  to_user: { username: string } | null;
  book: { title: string; author: string; cover_url: string | null; external_id: string } | null;
};

type ReaderPrefs = {
  favorite_genres: string[];
  avoid_genres: string[];
  reading_styles: string[];
  favorite_authors: string | null;
};

const REC_STATUS: Record<string, { bg: string; text: string; label: string }> = {
  sent:     { bg: '#f1f5f9', text: '#475569', label: 'Sent'          },
  saved:    { bg: '#e0f2fe', text: '#0369a1', label: 'Want to Read'  },
  started:  { bg: '#dbeafe', text: '#1d4ed8', label: 'Reading'       },
  finished: { bg: '#dcfce7', text: '#15803d', label: 'Finished'      },
  dnf:      { bg: '#fee2e2', text: '#b91c1c', label: 'Did Not Finish' },
};

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={{
      fontSize: 11,
      fontWeight: '700',
      color: '#a8a29e',
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      marginBottom: 12,
    }}>
      {children}
    </Text>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [currentlyReading, setCurrentlyReading] = useState<CurrentlyReading[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [sentRecs, setSentRecs] = useState<SentRecommendation[]>([]);
  const [prefs, setPrefs] = useState<ReaderPrefs | null>(null);
  const [stats, setStats] = useState<{
    friendsCount: number;
    finishedBooks: number;
    finishedThisYear: number;
    recsLanded: number;
    finishedFromRecs: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    async function load() {
      if (!supabase) { setError('Supabase not configured.'); setLoading(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('No signed-in user.'); setLoading(false); return; }

      setEmail(user.email ?? null);

      const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;

      const [
        profileRes,
        currentlyReadingRes,
        requestsRes,
        friendsRes,
        landedRes,
        finishedFromRecRes,
        finishedAllRes,
        finishedYearRes,
        sentRecsRes,
        prefsRes,
      ] = await Promise.all([
        supabase.from('profiles').select('username, yearly_reading_goal').eq('id', user.id).single(),
        supabase
          .from('user_books')
          .select('id, book_id, started_at, book:books(title, author, cover_url, external_id)')
          .eq('user_id', user.id)
          .eq('status', 'reading')
          .order('started_at', { ascending: false }),
        supabase
          .from('friendships')
          .select('id, requester_id, requester:profiles!friendships_requester_id_fkey(username)')
          .eq('addressee_id', user.id)
          .eq('status', 'pending'),
        supabase
          .from('friendships')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`),
        supabase
          .from('credibility_events')
          .select('*', { count: 'exact', head: true })
          .eq('from_user_id', user.id),
        supabase
          .from('credibility_events')
          .select('*', { count: 'exact', head: true })
          .eq('to_user_id', user.id),
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'finished'),
        supabase
          .from('user_books')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'finished')
          .gte('finished_at', yearStart),
        supabase
          .from('recommendations')
          .select(
            'id, book_id, status, created_at, note, ' +
            'to_user:profiles!recommendations_to_user_id_fkey(username), ' +
            'book:books!recommendations_book_id_fkey(title, author, cover_url, external_id)'
          )
          .eq('from_user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('reader_preferences')
          .select('favorite_genres, avoid_genres, reading_styles, favorite_authors')
          .eq('user_id', user.id)
          .maybeSingle(),
      ]);

      if (profileRes.error) {
        setError('Could not load profile.');
      } else {
        setProfile(profileRes.data);
      }

      setCurrentlyReading((currentlyReadingRes.data as CurrentlyReading[]) ?? []);
      setPendingRequests((requestsRes.data as PendingRequest[]) ?? []);
      setSentRecs((sentRecsRes.data as SentRecommendation[]) ?? []);
      setPrefs(prefsRes.data ?? null);
      setStats({
        friendsCount: friendsRes.count ?? 0,
        recsLanded: landedRes.count ?? 0,
        finishedFromRecs: finishedFromRecRes.count ?? 0,
        finishedBooks: finishedAllRes.count ?? 0,
        finishedThisYear: finishedYearRes.count ?? 0,
      });
      setLoading(false);
    }
    load();
  }, []));

  async function handleAccept(friendshipId: string) {
    if (!supabase) return;
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', friendshipId);
    if (!error) {
      setPendingRequests(prev => prev.filter(r => r.id !== friendshipId));
      setStats(prev => prev ? { ...prev, friendsCount: prev.friendsCount + 1 } : prev);
    }
  }

  async function handleSignOut() {
    await supabase?.auth.signOut();
  }

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf9f7' }}>
        <ActivityIndicator color="#78716c" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: '#b91c1c', textAlign: 'center', fontSize: 14 }}>{error}</Text>
      </View>
    );
  }

  const username = profile?.username ?? '—';
  const yearlyGoal = profile?.yearly_reading_goal ?? null;
  const goalProgress = stats ? computeGoalProgress(stats.finishedThisYear, yearlyGoal) : null;

  const hasTasteData = prefs && (
    (prefs.favorite_genres?.length ?? 0) > 0 ||
    (prefs.avoid_genres?.length ?? 0) > 0 ||
    (prefs.reading_styles?.length ?? 0) > 0 ||
    !!prefs.favorite_authors
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#faf9f7' }}
      contentContainerStyle={{ paddingBottom: 48 }}
    >
      {/* ── Hero header ── */}
      <View style={{
        backgroundColor: '#fff',
        paddingHorizontal: 20,
        paddingTop: 28,
        paddingBottom: 24,
        borderBottomWidth: 1,
        borderBottomColor: '#f5f5f4',
        shadowColor: '#000',
        shadowOpacity: 0.03,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 1 },
        elevation: 1,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: '#1c1917',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 16,
          }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: '#fff' }}>
              {username.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: '#1c1917', letterSpacing: -0.3 }}>
              {username}
            </Text>
            <Text style={{ fontSize: 13, color: '#a8a29e', marginTop: 2 }}>{email ?? '—'}</Text>
          </View>
          <TouchableOpacity
            onPress={() => router.push('/edit-preferences')}
            style={{
              borderWidth: 1,
              borderColor: '#e7e5e4',
              borderRadius: 8,
              paddingHorizontal: 11,
              paddingVertical: 7,
            }}
          >
            <Text style={{ fontSize: 12, color: '#57534e', fontWeight: '500' }}>Edit Taste</Text>
          </TouchableOpacity>
        </View>

        {/* Goal progress bar */}
        {goalProgress && (
          <View style={{
            marginTop: 18,
            backgroundColor: '#faf9f7',
            borderRadius: 10,
            padding: 12,
          }}>
            <Text style={{ fontSize: 13, color: '#57534e', fontWeight: '500' }}>{goalProgress}</Text>
            {yearlyGoal && stats && (
              <View style={{
                marginTop: 8,
                height: 4,
                backgroundColor: '#e7e5e4',
                borderRadius: 2,
                overflow: 'hidden',
              }}>
                <View style={{
                  height: 4,
                  width: `${Math.min(100, Math.round((stats.finishedThisYear / yearlyGoal) * 100))}%`,
                  backgroundColor: '#1c1917',
                  borderRadius: 2,
                }} />
              </View>
            )}
          </View>
        )}
        {!yearlyGoal && (
          <View style={{ marginTop: 14 }}>
            <Text style={{ fontSize: 12, color: '#a8a29e' }}>
              No reading goal set — add one in your settings to track pace.
            </Text>
          </View>
        )}
      </View>

      {/* ── Stats rail ── */}
      {stats && (
        <View style={{
          flexDirection: 'row',
          paddingHorizontal: 20,
          paddingVertical: 20,
          gap: 10,
        }}>
          <StatPill value={stats.finishedBooks} label="Finished" color="#1c1917" flex={1.4} />
          <StatPill value={stats.friendsCount}  label="Friends"  color="#57534e" flex={1} />
          <StatPill value={stats.recsLanded}    label="Recs Landed" color="#57534e" flex={1} />
        </View>
      )}

      {/* ── Taste profile teaser ── */}
      <View style={{ paddingHorizontal: 20, marginBottom: 24 }}>
        <TouchableOpacity
          onPress={() => router.push('/edit-preferences')}
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 16,
            flexDirection: 'row',
            alignItems: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: '#1c1917', marginBottom: 4 }}>
              {hasTasteData ? 'Reading Taste' : 'Build your taste profile'}
            </Text>
            {hasTasteData ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                {prefs!.favorite_genres.slice(0, 4).map(g => (
                  <View key={g} style={{
                    backgroundColor: '#f5f5f4',
                    borderRadius: 10,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                  }}>
                    <Text style={{ fontSize: 11, color: '#57534e' }}>{g}</Text>
                  </View>
                ))}
                {(prefs!.favorite_genres.length + prefs!.reading_styles.length) > 4 && (
                  <View style={{
                    backgroundColor: '#f5f5f4',
                    borderRadius: 10,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                  }}>
                    <Text style={{ fontSize: 11, color: '#a8a29e' }}>
                      +{prefs!.favorite_genres.length + prefs!.reading_styles.length - 4} more
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <Text style={{ fontSize: 13, color: '#a8a29e', lineHeight: 19 }}>
                Tell us your genres, styles, and authors — unlocks future taste insights.
              </Text>
            )}
          </View>
          <Text style={{ fontSize: 20, color: '#d6d3d1', marginLeft: 10 }}>›</Text>
        </TouchableOpacity>
      </View>

      {/* ── Currently Reading ── */}
      {currentlyReading.length > 0 && (
        <View style={{ marginBottom: 28 }}>
          <View style={{ paddingHorizontal: 20, marginBottom: 12 }}>
            <SectionLabel>Currently Reading</SectionLabel>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}
          >
            {currentlyReading.map(item => {
              const pacingNote = computePacingNote(item.started_at, yearlyGoal);
              return (
                <TouchableOpacity
                  key={item.id}
                  activeOpacity={0.75}
                  onPress={() => router.push({
                    pathname: '/book/[id]',
                    params: {
                      id: item.book_id,
                      title: item.book?.title ?? '',
                      author: item.book?.author ?? '',
                      coverUrl: item.book?.cover_url ?? '',
                      externalId: item.book?.external_id ?? '',
                      status: 'reading',
                      startedAt: item.started_at ?? '',
                      readingGoal: String(yearlyGoal ?? ''),
                    },
                  })}
                  style={{
                    backgroundColor: '#fff',
                    borderRadius: 14,
                    padding: 14,
                    width: 150,
                    shadowColor: '#000',
                    shadowOpacity: 0.06,
                    shadowRadius: 8,
                    shadowOffset: { width: 0, height: 2 },
                    elevation: 2,
                  }}
                >
                  <CoverThumb
                    url={item.book?.cover_url}
                    externalId={item.book?.external_id}
                    width={80}
                    height={116}
                  />
                  <Text
                    numberOfLines={2}
                    style={{
                      fontSize: 13,
                      fontWeight: '700',
                      color: '#1c1917',
                      marginTop: 10,
                      lineHeight: 18,
                    }}
                  >
                    {item.book?.title ?? '—'}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 12, color: '#a8a29e', marginTop: 3 }}
                  >
                    {item.book?.author ?? '—'}
                  </Text>
                  {pacingNote && (
                    <View style={{
                      backgroundColor: '#faf9f7',
                      borderRadius: 6,
                      paddingHorizontal: 7,
                      paddingVertical: 4,
                      marginTop: 8,
                    }}>
                      <Text style={{ fontSize: 10, color: '#78716c', lineHeight: 14 }}>
                        {pacingNote}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* ── Friend Requests ── */}
      <View style={{ paddingHorizontal: 20, marginBottom: 28 }}>
        <SectionLabel>
          {pendingRequests.length > 0
            ? `Friend Requests (${pendingRequests.length})`
            : 'Friend Requests'}
        </SectionLabel>
        {pendingRequests.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14 }}>No pending requests.</Text>
        ) : (
          pendingRequests.map(req => (
            <View
              key={req.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: 12,
                borderBottomWidth: 1,
                borderBottomColor: '#f3f4f6',
              }}
            >
              <Text style={{ fontSize: 15, color: '#1c1917' }}>
                {req.requester?.username ?? req.requester_id}
              </Text>
              <TouchableOpacity
                onPress={() => handleAccept(req.id)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  backgroundColor: '#1c1917',
                  borderRadius: 8,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '500' }}>Accept</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      {/* ── Sent Recommendations ── */}
      <View style={{ paddingHorizontal: 20, marginBottom: 28 }}>
        <SectionLabel>Recommendations Sent</SectionLabel>
        {sentRecs.length === 0 ? (
          <Text style={{ color: '#a8a29e', fontSize: 14 }}>No recommendations sent yet.</Text>
        ) : (
          sentRecs.map(rec => {
            const badge = REC_STATUS[rec.status] ?? { bg: '#f1f5f9', text: '#475569', label: rec.status };
            return (
              <TouchableOpacity
                key={rec.id}
                activeOpacity={0.7}
                onPress={() => router.push({
                  pathname: '/book/[id]',
                  params: {
                    id: rec.book_id,
                    title: rec.book?.title ?? '',
                    author: rec.book?.author ?? '',
                    coverUrl: rec.book?.cover_url ?? '',
                    externalId: rec.book?.external_id ?? '',
                    status: rec.status,
                    note: rec.note ?? '',
                    toUser: rec.to_user?.username ?? '',
                  },
                })}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: '#f3f4f6',
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                }}
              >
                <CoverThumb
                  url={rec.book?.cover_url}
                  externalId={rec.book?.external_id}
                  width={36}
                  height={52}
                />
                <View style={{ flex: 1, marginLeft: 12, marginRight: 10 }}>
                  <Text style={{ fontWeight: '600', fontSize: 15, color: '#111827', marginBottom: 2 }}>
                    {rec.book?.title ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#6b7280', marginBottom: 3 }}>
                    {rec.book?.author ?? '—'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#9ca3af' }}>
                    to {rec.to_user?.username ?? '—'}
                  </Text>
                  {rec.note ? (
                    <Text style={{ fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginTop: 4 }}>
                      "{rec.note}"
                    </Text>
                  ) : null}
                </View>
                <View style={{
                  backgroundColor: badge.bg,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  alignSelf: 'flex-start',
                }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: badge.text }}>
                    {badge.label}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </View>

      {/* ── Sign Out ── */}
      <TouchableOpacity
        onPress={handleSignOut}
        style={{
          alignSelf: 'center',
          paddingHorizontal: 24,
          paddingVertical: 10,
          borderWidth: 1,
          borderColor: '#e5e7eb',
          borderRadius: 8,
        }}
      >
        <Text style={{ fontSize: 14, color: '#6b7280' }}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function StatPill({
  value,
  label,
  color,
  flex = 1,
}: {
  value: number;
  label: string;
  color: string;
  flex?: number;
}) {
  return (
    <View style={{
      flex,
      backgroundColor: '#fff',
      borderRadius: 14,
      paddingVertical: 16,
      paddingHorizontal: 14,
      alignItems: 'flex-start',
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }}>
      <Text style={{ fontSize: 30, fontWeight: '800', color, letterSpacing: -0.5, lineHeight: 36 }}>
        {value}
      </Text>
      <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 4, lineHeight: 15 }}>
        {label}
      </Text>
    </View>
  );
}
