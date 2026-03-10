import { Text, View } from 'react-native';
import { hasSupabaseConfig } from '../../lib/supabase';

export default function HomeScreen() {
  const smokeTest = hasSupabaseConfig
    ? 'Supabase init smoke test: OK (temporary)'
    : 'Supabase init smoke test: MISSING ENV (temporary)';

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Home placeholder</Text>
      <Text>{smokeTest}</Text>
    </View>
  );
}
