import { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

export default function ImportSettingsScreen() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/import/goodreads');
  }, []);

  return <View style={{ flex: 1, backgroundColor: '#faf9f7' }} />;
}
