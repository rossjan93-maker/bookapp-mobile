import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

async function ensureProfile(userId: string, email: string) {
  if (!supabase) return;
  const emailPrefix = email.split('@')[0] || 'user';
  const idSuffix = userId.replace(/-/g, '').slice(0, 6);
  const fallbackUsername = `${emailPrefix}_${idSuffix}`;
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
      if (data.session) {
        ensureProfile(data.session.user.id, data.session.user.email ?? '');
      }
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
      router.replace('/');
    } else if (!session && !inAuth) {
      router.replace('/login');
    }
  }, [session, segments]);

  return <Stack screenOptions={{ headerShown: false }} />;
}
