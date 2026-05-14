import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { LoadingState } from '@/components/LoadingState';

export default function BootRedirect() {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingState variant="fullscreen" />;
  if (status === 'unauthenticated') return <Redirect href="/login" />;
  return <Redirect href="/(tabs)" />;
}
