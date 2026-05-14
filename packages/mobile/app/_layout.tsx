// Polyfills MUST be the very first imports, before any module that depends
// on global URL or crypto.getRandomValues (amazon-cognito-identity-js).
import '@/lib/crypto-polyfill';
import 'react-native-url-polyfill/auto';
import { Stack } from 'expo-router';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '@/auth/AuthContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ApiError } from '@/lib/api-error';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 0) return failureCount < 1;
          if (error.status === 401 || error.status === 403 || error.status === 404) return false;
          if (error.status >= 500) return failureCount < 2;
          return false;
        }
        return failureCount < 1;
      },
      staleTime: 5 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'garageos.query-cache',
  throttleTime: 1000,
});

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider>
          <PersistQueryClientProvider
            client={queryClient}
            persistOptions={{ persister, maxAge: 24 * 60 * 60 * 1000 }}
          >
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: false }} />
          </PersistQueryClientProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
