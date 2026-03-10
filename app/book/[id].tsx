import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

export default function BookDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Book placeholder: {id}</Text>
    </View>
  );
}
