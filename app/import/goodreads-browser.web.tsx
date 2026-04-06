import { useEffect } from 'react';
import { useRouter } from 'expo-router';

// This route is native-only. On web, redirect immediately to the import screen.
// The web bundle never loads react-native-webview (goodreads-browser.tsx) because
// Metro/Expo resolves .web.tsx files first for the web target.
export default function GoodreadsBrowserWebStub() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/import/goodreads' as any);
  }, [router]);
  return null;
}
