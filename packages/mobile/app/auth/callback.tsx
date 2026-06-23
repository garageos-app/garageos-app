import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { LoadingState } from '@/components/LoadingState';

// Transient landing route for the Cognito OAuth redirect (garageos://auth/callback).
// The redirect deep link is delivered to BOTH expo-web-browser (which resolves the
// auth session that the login/signup handler awaits) and expo-router. Without a
// matching route, expo-router renders its "Unmatched Route" error screen for the
// couple of seconds the token exchange takes. Render a neutral loading state
// instead: on success the auth status flips and we redirect into the app; on
// failure the originating handler navigates back to login/signup with a banner.
export default function AuthCallback() {
  const { status } = useAuth();
  if (status === 'authenticated') return <Redirect href="/(tabs)" />;
  return <LoadingState variant="fullscreen" />;
}
