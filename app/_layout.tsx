import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

async function ensureProfile(userId: string, email: string) {
  if (!supabase) return;
  const fallbackUsername = email.split('@')[0] || userId.slice(0, 8);
  await supabase
    .from('profiles')
    .upsert({ id: userId, username: fallbackUsername }, { onConflict: 'id', ignoreDuplicates: true });
}

export default function RootLayout() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (!supabase) {
      setSession(null);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      if (event === 'SIGNED_IN' && newSession) {
        ensureProfile(newSession.user.id, newSession.user.email ?? '');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session === undefined) return;

    const inAuth = segments[0] === '(auth)';
    if (session && inAuth) {
      router.replace('/(tabs)');
    } else if (!session && !inAuth) {
      router.replace('/(auth)/login');
    }
  }, [session, segments]);

  return <Stack screenOptions={{ headerShown: false }} />;
}
