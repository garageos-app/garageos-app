import { Tabs, Redirect } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { LoadingState } from '@/components/LoadingState';
import { colors } from '@/theme/colors';

export default function TabsLayout() {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingState variant="fullscreen" />;
  if (status === 'unauthenticated') return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'I miei veicoli',
          tabBarLabel: 'Veicoli',
        }}
      />
      <Tabs.Screen
        name="deadlines"
        options={{
          title: 'Scadenze',
          tabBarLabel: 'Scadenze',
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profilo',
          tabBarLabel: 'Profilo',
        }}
      />
    </Tabs>
  );
}
