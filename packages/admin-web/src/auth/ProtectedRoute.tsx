import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './useAuth';

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

export function ProtectedRoute() {
  const { state } = useAuth();
  if (state.status === 'idle' || state.status === 'authenticating') {
    return <FullPageSpinner />;
  }
  if (state.status === 'unauthenticated') return <Navigate to="/login" replace />;
  // An admin mid-challenge (NEW_PASSWORD_REQUIRED) must not access protected
  // routes — redirect them to the set-password page. The set-password route is
  // public so there is no redirect loop.
  if (state.status === 'new_password_required') return <Navigate to="/set-password" replace />;
  // Only 'authenticated' falls through to the Outlet.
  return <Outlet />;
}
