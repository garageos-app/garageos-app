import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/theme/ThemeContext';
import { AuthProvider } from '@/auth/AuthContext';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { Login } from '@/pages/Login';
import { SetPassword } from '@/pages/SetPassword';
import { PlatformConsole } from '@/pages/PlatformConsole';
import { CreateTenant } from '@/pages/CreateTenant';
import { TenantDetail } from '@/pages/TenantDetail';
import { TenantList } from '@/pages/TenantList';
import { AuditLogs } from '@/pages/AuditLogs';
import { CatalogoInterventi } from '@/pages/CatalogoInterventi';

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
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Routes>
              {/* Public routes — outside the shell */}
              <Route path="/login" element={<Login />} />
              <Route path="/set-password" element={<SetPassword />} />

              {/* Protected routes — ProtectedRoute guards, AppLayout provides the shell */}
              <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                  <Route path="/" element={<PlatformConsole />} />
                  <Route path="/officine" element={<TenantList />} />
                  <Route path="/officine/nuova" element={<CreateTenant />} />
                  {/* /officine/nuova before /officine/:id — static ranks over dynamic. */}
                  <Route path="/officine/:id" element={<TenantDetail />} />
                  <Route path="/catalogo" element={<CatalogoInterventi />} />
                  {/* /catalogo before /catalogo/:id (Task 4) — static ranks over dynamic. */}
                  <Route path="/audit" element={<AuditLogs />} />
                </Route>
              </Route>

              {/* Fallback redirect */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
