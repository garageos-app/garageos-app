import { Redirect, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/auth/useAuth';
import { extractGarageCode } from '@/lib/qr';
import { LoadingState } from '@/components/LoadingState';

// Deep-link target for the invite/QR URL .../v/<code> (Specifiche §4.5). The
// canonical link is garageos://v/<code> (custom scheme, Expo Go) and, once a dev
// build ships universal links, https://app.garageos.it/v/<code> — both map here.
// This route only routes: it validates the code (BR-020) and hands off to the
// claim form. The server stays authoritative (POST /me/vehicles/claim).
export default function DeepLinkClaimScreen() {
  const { status } = useAuth();
  const { code } = useLocalSearchParams<{ code?: string }>();
  const valid = extractGarageCode(code ?? '');

  if (status === 'loading') return <LoadingState variant="fullscreen" />;

  if (status === 'unauthenticated') {
    // Defer: carry the code through login so a registered user lands on the
    // pre-filled claim form after signing in (login.tsx honors ?claimCode).
    return <Redirect href={valid ? `/login?claimCode=${valid}` : '/login'} />;
  }

  return <Redirect href={valid ? `/claim-vehicle?code=${valid}` : '/claim-vehicle'} />;
}
