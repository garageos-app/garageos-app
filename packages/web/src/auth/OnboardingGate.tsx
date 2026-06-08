import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '@/auth/useAuth';
import { useTenantMe } from '@/queries/tenantMe';

function FullPageSpinner() {
  return (
    <div
      role="status"
      aria-label="Caricamento"
      className="min-h-screen grid place-items-center bg-background"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
    </div>
  );
}

// F-OFF-002 — gate nested under AppLayout. Redirects un-onboarded
// super_admins to /onboarding. Role is synchronous (JWT via useAuth);
// only super_admins fetch tenant state. Mechanics and completed tenants
// pass through. On tenant-query error, fail open to the app.
export function OnboardingGate() {
  const { state } = useAuth();
  const role = state.status === 'authenticated' ? state.user.role : undefined;
  const isSuperAdmin = role === 'super_admin';

  const tenantQ = useTenantMe({ enabled: isSuperAdmin });

  if (!isSuperAdmin) return <Outlet />;
  if (tenantQ.isPending) return <FullPageSpinner />;
  if (tenantQ.isError) return <Outlet />;
  if (tenantQ.data && tenantQ.data.onboardingCompletedAt == null) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Outlet />;
}
