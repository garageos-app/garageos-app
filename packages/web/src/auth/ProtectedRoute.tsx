import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './useAuth';

function FullPageSpinner() {
  return (
    <div
      role="status"
      aria-label="Caricamento"
      className="min-h-screen grid place-items-center bg-slate-50"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-slate-900" />
    </div>
  );
}

export function ProtectedRoute() {
  const { state } = useAuth();
  if (state.status === 'idle') return <FullPageSpinner />;
  if (state.status === 'unauthenticated') return <Navigate to="/login" replace />;
  return <Outlet />;
}
