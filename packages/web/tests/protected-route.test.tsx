import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { AuthContext } from '@/auth/AuthContext';
import type { AuthState } from '@/auth/AuthContext';

function withAuthState(state: AuthState) {
  return {
    state,
    signIn: vi.fn(),
    signOut: vi.fn(),
    getIdToken: vi.fn(),
  };
}

function renderWithStateAndPath(state: AuthState, initialPath = '/dashboard') {
  return render(
    <AuthContext.Provider value={withAuthState(state)}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div>protected content</div>} />
          </Route>
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('ProtectedRoute', () => {
  it('renders a spinner while idle', () => {
    renderWithStateAndPath({ status: 'idle' });
    expect(screen.getByRole('status', { name: /caricamento/i })).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('redirects unauthenticated users to /login', () => {
    renderWithStateAndPath({ status: 'unauthenticated' });
    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('renders the protected child when authenticated', () => {
    renderWithStateAndPath({
      status: 'authenticated',
      user: { email: 'giuseppe@officina-bianchi.it' },
    });
    expect(screen.getByText('protected content')).toBeInTheDocument();
  });
});
