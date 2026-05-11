// =============================================================================
// /taste-readout — post-intake "Here's what we heard" route.
//
// Shown ONCE in the new-user flow, between (a) quick-intake completion or
// (b) Goodreads import success, and (c) the For You tab. Loads the
// TasteProfile + intake genre prefs and hands them to <TasteReadout/>.
//
// Failure-tolerant: any data-load error renders the thin-state version so
// the user is never blocked. The CTA always routes cleanly to /(tabs)/search.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { computeTasteProfile, type TasteProfile } from '../lib/tasteProfile';
import { TasteReadout } from '../components/TasteReadout';
import { useScreenTopPadding } from '../lib/screenLayout';
import * as T from '../lib/tokens';

export default function TasteReadoutScreen() {
  const router = useRouter();
  const topPadding = useScreenTopPadding();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [favoriteGenres, setFavoriteGenres] = useState<string[]>([]);
  // UX-3B: avoid_genres from intake, surfaced as "Less of: X" chips. No
  // recommender wiring yet — purely reflection.
  const [avoidGenres, setAvoidGenres] = useState<string[]>([]);
  // UX-3E: diagnosis_answers (jsonb Record<string,string>) — used to surface
  // q_outcome ("Reading for: X") and q_tone ("Tone: X") as stated-preference
  // chips. Defaults to {} on missing or malformed data.
  const [diagnosisAnswers, setDiagnosisAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!supabase) {
          if (!cancelled) setLoading(false);
          return;
        }

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) setLoading(false);
          return;
        }

        // Run profile + prefs in parallel. Both are tolerant — any failure
        // collapses to the thin-state readout, never to a crash.
        const [tpResult, prefsResult] = await Promise.all([
          computeTasteProfile(supabase, user.id).catch(() => null),
          supabase
            .from('reader_preferences')
            .select('favorite_genres, avoid_genres, diagnosis_answers')
            .eq('user_id', user.id)
            .maybeSingle(),
        ]);

        if (cancelled) return;

        setProfile(tpResult);

        const prefs = (prefsResult.data ?? null) as
          | {
              favorite_genres?: string[] | null;
              avoid_genres?: string[] | null;
              diagnosis_answers?: Record<string, unknown> | null;
            }
          | null;
        setFavoriteGenres(Array.isArray(prefs?.favorite_genres) ? prefs!.favorite_genres! : []);
        setAvoidGenres(Array.isArray(prefs?.avoid_genres) ? prefs!.avoid_genres! : []);
        // diagnosis_answers is jsonb — coerce defensively to Record<string,string>
        // by keeping only string-valued entries. The selectors in
        // tasteReadoutCopy further guard against unknown keys, so anything
        // we keep here that isn't q_outcome / q_tone is silently ignored.
        const da = prefs?.diagnosis_answers;
        if (da && typeof da === 'object' && !Array.isArray(da)) {
          const cleaned: Record<string, string> = {};
          for (const [k, v] of Object.entries(da)) {
            if (typeof v === 'string') cleaned[k] = v;
          }
          setDiagnosisAnswers(cleaned);
        } else {
          setDiagnosisAnswers({});
        }
      } catch (err) {
        // Swallow — thin-state path will render.
        if (__DEV__) console.warn('[taste-readout] load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleSeeMyPicks() {
    router.replace('/(tabs)/search' as any);
  }

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: T.BG,
          paddingTop: topPadding,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={T.SAGE_DEEP} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, paddingTop: topPadding, backgroundColor: T.BG }}>
      <TasteReadout
        profile={profile}
        favoriteGenres={favoriteGenres}
        avoidGenres={avoidGenres}
        diagnosisAnswers={diagnosisAnswers}
        onSeeMyPicks={handleSeeMyPicks}
      />
    </View>
  );
}
