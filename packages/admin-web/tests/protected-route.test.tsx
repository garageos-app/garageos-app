import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext, type AuthState } from '@/auth/AuthContext';
import { ProtectedRoute } from '@/auth/ProtectedRoute';

// Renders the ProtectedRoute wrapping a stub console page, alongside stub
// login and set-password destinations so Navigate redirects can be asserted.
function renderWithAuth(state: AuthState) {
  return render(
    <AuthContext.Provider
      value={{
        state,
        signIn: vi.fn(),
        signOut: vi.fn(),
        getIdToken: vi.fn(),
        completeNewPassword: vi.fn(),
      }}
    >
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/login" element={<div>login-page</div>} />
          <Route path="/set-password" element={<div>set-password-page</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<div>console-page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('ProtectedRoute', () => {
  it('redirects to /set-password when auth status is new_password_required', () => {
    renderWithAuth({ status: 'new_password_required' });
    expect(screen.getByText('set-password-page')).toBeInTheDocument();
    expect(screen.queryByText('console-page')).not.toBeInTheDocument();
  });

  it('redirects to /login when auth status is unauthenticated', () => {
    renderWithAuth({ status: 'unauthenticated' });
    expect(screen.getByText('login-page')).toBeInTheDocument();
    expect(screen.queryByText('console-page')).not.toBeInTheDocument();
  });

  it('renders the outlet when auth status is authenticated', () => {
    renderWithAuth({ status: 'authenticated', user: { email: 'admin@garageos.it' } });
    expect(screen.getByText('console-page')).toBeInTheDocument();
  });
});
