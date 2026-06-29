import { useAuth } from '@/auth/useAuth';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ACCOUNT_INACTIVE_MESSAGE } from '@/lib/error-messages';

// Terminal screen for the `account_inactive` auth state (backend
// `auth.session.inactive`: officine user disabled or tenant suspended).
// Rendered by ProtectedRoute instead of redirecting to /login — re-login
// cannot clear the denial, so a redirect would loop. The message is generic
// on purpose (BR-210: must not reveal whether it is the user or the tenant)
// and shared with the mutation-path toast via ACCOUNT_INACTIVE_MESSAGE.
//
// IT-strings — hardcoded, no i18n in this app.
export function AccountInactive() {
  const { signOut } = useAuth();
  return (
    <AuthLayout>
      <Alert variant="destructive" className="mb-4 bg-red-950/50 border-red-700 text-red-100">
        <AlertDescription>{ACCOUNT_INACTIVE_MESSAGE}</AlertDescription>
      </Alert>
      <Button
        onClick={signOut}
        className="w-full bg-[#4a90d9] hover:bg-[#3a7fc9] text-white font-medium"
      >
        Torna al login
      </Button>
    </AuthLayout>
  );
}
