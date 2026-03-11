import { Text, TouchableOpacity, View } from 'react-native';
import { supabase } from '../../lib/supabase';

export default function ProfileScreen() {
  async function handleSignOut() {
    await supabase?.auth.signOut();
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Profile placeholder</Text>
      <TouchableOpacity
        onPress={handleSignOut}
        style={{
          marginTop: 24,
          padding: 12,
          borderWidth: 1,
          borderColor: '#000',
          borderRadius: 6,
        }}
      >
        <Text>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}
