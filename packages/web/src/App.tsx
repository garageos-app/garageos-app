import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/theme/ThemeContext';
import { AuthProvider } from '@/auth/AuthContext';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { Login } from '@/pages/Login';
import { HomeDashboard } from '@/pages/HomeDashboard';
import { SearchResults } from '@/pages/SearchResults';
import { VehicleDetail } from '@/pages/VehicleDetail';
import { CustomerList } from '@/pages/CustomerList';
import { CustomerDetail } from '@/pages/CustomerDetail';
import { DeadlineDashboard } from '@/pages/DeadlineDashboard';
import { InterventionCreate } from '@/pages/InterventionCreate';
import { InterventionDetail } from '@/pages/InterventionDetail';
import { Settings } from '@/pages/Settings';
import { AcceptInvitation } from '@/pages/AcceptInvitation';
import VerifyEmailPage from '@/pages/VerifyEmailPage';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';

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
              <Route path="/login" element={<Login />} />
              <Route path="/verify-email" element={<VerifyEmailPage />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/invitations/:token" element={<AcceptInvitation />} />
              <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                  <Route path="/" element={<HomeDashboard />} />
                  <Route path="/search" element={<SearchResults />} />
                  <Route path="/vehicles/:id" element={<VehicleDetail />} />
                  <Route path="/vehicles/:id/interventions/new" element={<InterventionCreate />} />
                  <Route path="/customers" element={<CustomerList />} />
                  <Route path="/customers/:id" element={<CustomerDetail />} />
                  <Route path="/interventions/:id" element={<InterventionDetail />} />
                  <Route path="/deadlines" element={<DeadlineDashboard />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/settings/users" element={<Settings />} />
                  <Route path="/settings/locations" element={<Settings />} />
                </Route>
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
