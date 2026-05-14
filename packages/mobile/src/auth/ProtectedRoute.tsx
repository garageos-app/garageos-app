import { Redirect } from 'expo-router';
import { type ReactNode } from 'react';
import { useAuth } from './useAuth';
import { LoadingState } from '@/components/LoadingState';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingState variant="fullscreen" />;
  if (status === 'unauthenticated') return <Redirect href="/login" />;
  return <>{children}</>;
}
