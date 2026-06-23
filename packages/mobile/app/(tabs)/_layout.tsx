import { Tabs, Redirect, useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/auth/useAuth';
import { BrandLogo } from '@/components/BrandLogo';
import { LoadingState } from '@/components/LoadingState';
import { PushSoftAskModal } from '@/components/PushSoftAskModal';
import { colors } from '@/theme/colors';

// Brand lockup shown in the primary tab headers. Detail screens keep their own
// contextual titles (e.g. the vehicle name), so this is wired per-screen rather
// than in screenOptions.
const renderBrandTitle = () => <BrandLogo tone="onLight" size={24} showWordmark />;

export default function TabsLayout() {
  const { status } = useAuth();
  const router = useRouter();
  if (status === 'loading') return <LoadingState variant="fullscreen" />;
  if (status === 'unauthenticated') return <Redirect href="/login" />;

  return (
    <>
      <PushSoftAskModal />
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
            headerTitle: renderBrandTitle,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? 'car-sport' : 'car-sport-outline'}
                size={size}
                color={color}
              />
            ),
            headerRight: () => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Aggiungi veicolo"
                onPress={() => router.push('/claim-vehicle')}
                hitSlop={12}
                style={{ paddingHorizontal: 16 }}
              >
                <Ionicons name="add" size={26} color={colors.primary} />
              </Pressable>
            ),
          }}
        />
        <Tabs.Screen
          name="deadlines"
          options={{
            title: 'Scadenze',
            tabBarLabel: 'Scadenze',
            headerTitle: renderBrandTitle,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? 'calendar' : 'calendar-outline'}
                size={size}
                color={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profilo',
            tabBarLabel: 'Profilo',
            headerTitle: renderBrandTitle,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? 'person' : 'person-outline'} size={size} color={color} />
            ),
          }}
        />
        {/* #5: il dettaglio veicolo è sotto (tabs) → Expo Router lo registra come
            tab ("Fiat Panda"). href:null lo rimuove dalla bar, resta navigabile
            via router.push dalla lista veicoli. */}
        <Tabs.Screen name="vehicles/[id]" options={{ href: null }} />
      </Tabs>
    </>
  );
}
