import { createContext, useEffect, useState } from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { OnboardingWalkthrough, shouldShowWalkthrough } from '../../components/OnboardingWalkthrough';

type BadgeContextType = {
  newRecCount: number;
  setNewRecCount: (n: number) => void;
};

export const BadgeContext = createContext<BadgeContextType>({
  newRecCount: 0,
  setNewRecCount: () => {},
});

export default function TabsLayout() {
  const [newRecCount, setNewRecCount]         = useState(0);
  const [showWalkthrough, setShowWalkthrough] = useState(false);

  useEffect(() => {
    async function fetchCount() {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { count } = await supabase
        .from('recommendations')
        .select('*', { count: 'exact', head: true })
        .eq('to_user_id', user.id)
        .eq('status', 'sent');
      setNewRecCount(count ?? 0);
    }
    fetchCount();
  }, []);

  useEffect(() => {
    shouldShowWalkthrough().then(show => {
      if (show) {
        const t = setTimeout(() => setShowWalkthrough(true), 600);
        return () => clearTimeout(t);
      }
    });
  }, []);

  return (
    <BadgeContext.Provider value={{ newRecCount, setNewRecCount }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: '#1c1917',
          tabBarInactiveTintColor: '#a8a29e',
          tabBarStyle: {
            borderTopColor: '#e7e5e4',
            borderTopWidth: 1,
            paddingBottom: 8,
            paddingTop: 4,
            height: 62,
          },
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '500',
            marginTop: 2,
          },
          headerShown: false,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ focused, color }) => (
              <Ionicons name={focused ? 'home' : 'home-outline'} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="search"
          options={{
            title: 'Recommend',
            tabBarIcon: ({ focused, color }) => (
              <Ionicons name={focused ? 'paper-plane' : 'paper-plane-outline'} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="library"
          options={{
            title: 'Library',
            tabBarIcon: ({ focused, color }) => (
              <Ionicons name={focused ? 'library' : 'library-outline'} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="notes"
          options={{
            title: 'Inbox',
            tabBarBadge: newRecCount > 0 ? newRecCount : undefined,
            tabBarBadgeStyle: { backgroundColor: '#1c1917', fontSize: 10 },
            tabBarIcon: ({ focused, color }) => (
              <Ionicons name={focused ? 'mail' : 'mail-outline'} size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profile',
            tabBarIcon: ({ focused, color }) => (
              <Ionicons name={focused ? 'person-circle' : 'person-circle-outline'} size={22} color={color} />
            ),
          }}
        />
      </Tabs>

      {showWalkthrough && (
        <OnboardingWalkthrough onDone={() => setShowWalkthrough(false)} />
      )}
    </BadgeContext.Provider>
  );
}
