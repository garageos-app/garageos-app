import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext, type AuthState } from '@/auth/AuthContext';
import { Login } from '@/pages/Login';

function renderLogin(state: AuthState, signIn = vi.fn()) {
  return render(
    <AuthContext.Provider
      value={{
        state,
        signIn,
        signOut: vi.fn(),
        getIdToken: vi.fn(),
        completeNewPassword: vi.fn(),
      }}
    >
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div>dashboard</div>} />
          <Route path="/set-password" element={<div>set-password-page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Login page', () => {
  it('renders email + password fields and a submit button', () => {
    renderLogin({ status: 'unauthenticated' });
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accedi/i })).toBeInTheDocument();
  });

  it('calls signIn with email + password on valid submit', async () => {
    const signIn = vi.fn().mockResolvedValue(undefined);
    renderLogin({ status: 'unauthenticated' }, signIn);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@garageos.it');
    await user.type(screen.getByLabelText(/password/i), 'Password123');
    await user.click(screen.getByRole('button', { name: /accedi/i }));
    expect(signIn).toHaveBeenCalledWith('admin@garageos.it', 'Password123');
  });

  it('shows auth error message when state has an error', () => {
    renderLogin({ status: 'unauthenticated', error: 'Email o password non corretti' });
    expect(screen.getByText('Email o password non corretti')).toBeInTheDocument();
  });

  it('redirects to /set-password when state is new_password_required', () => {
    renderLogin({ status: 'new_password_required' });
    expect(screen.getByText('set-password-page')).toBeInTheDocument();
  });
});
