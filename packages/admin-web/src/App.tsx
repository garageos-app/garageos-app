import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/auth/AuthContext';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { Login } from '@/pages/Login';
import { SetPassword } from '@/pages/SetPassword';
import { PlatformConsole } from '@/pages/PlatformConsole';
import { CreateTenant } from '@/pages/CreateTenant';
import { TenantDetail } from '@/pages/TenantDetail';
import { TenantList } from '@/pages/TenantList';
import { AuditLogs } from '@/pages/AuditLogs';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

export function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/set-password" element={<SetPassword />} />

            {/* Protected routes — ProtectedRoute guards unauthenticated access */}
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<PlatformConsole />} />
              <Route path="/officine" element={<TenantList />} />
              <Route path="/officine/nuova" element={<CreateTenant />} />
              {/* /officine/nuova must come before /officine/:id so "nuova" is not
                  swallowed by the param — react-router v6 ranks static > dynamic,
                  but explicit order makes intent clear. */}
              <Route path="/officine/:id" element={<TenantDetail />} />
              <Route path="/audit" element={<AuditLogs />} />
            </Route>

            {/* Fallback redirect */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}
