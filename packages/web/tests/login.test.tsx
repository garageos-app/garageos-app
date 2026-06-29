import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext, type AuthState } from '@/auth/AuthContext';
import { Login } from '@/pages/Login';

function renderLogin(state: AuthState, signIn = vi.fn()) {
  return render(
    <AuthContext.Provider
      value={{ state, signIn, signOut: vi.fn(), getIdToken: vi.fn(), markAccountInactive: vi.fn() }}
    >
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div>dashboard</div>} />
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

  it('shows zod validation error when email is empty', async () => {
    renderLogin({ status: 'unauthenticated' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /accedi/i }));
    expect(await screen.findByText(/inserisci un'email valida/i)).toBeInTheDocument();
  });

  it('shows validation error when email is malformed', async () => {
    renderLogin({ status: 'unauthenticated' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/password/i), 'pwd');
    await user.click(screen.getByRole('button', { name: /accedi/i }));
    expect(await screen.findByText(/inserisci un'email valida/i)).toBeInTheDocument();
  });

  it('calls signIn with email + password on valid submit', async () => {
    const signIn = vi.fn().mockResolvedValue(undefined);
    renderLogin({ status: 'unauthenticated' }, signIn);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'giuseppe@officina-bianchi.it');
    await user.type(screen.getByLabelText(/password/i), 'Password123');
    await user.click(screen.getByRole('button', { name: /accedi/i }));
    expect(signIn).toHaveBeenCalledWith('giuseppe@officina-bianchi.it', 'Password123');
  });

  it('renders the destructive Alert with the auth error message', () => {
    renderLogin({
      status: 'unauthenticated',
      error: 'Email o password non corretti',
    });
    expect(screen.getByText('Email o password non corretti')).toBeInTheDocument();
  });

  it('disables submit and shows pending text while authenticating', () => {
    renderLogin({ status: 'authenticating' });
    const submit = screen.getByRole('button', { name: /accesso in corso/i });
    expect(submit).toBeDisabled();
  });

  it('redirects to / once status flips to authenticated', async () => {
    renderLogin({
      status: 'authenticated',
      user: { email: 'giuseppe@officina-bianchi.it' },
    });
    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('renders GarageOS brand logo', () => {
    renderLogin({ status: 'unauthenticated' });
    expect(screen.getByAltText(/garageos/i)).toBeInTheDocument();
  });

  it('renders AI Folly footer logo', () => {
    renderLogin({ status: 'unauthenticated' });
    expect(screen.getByAltText(/ai folly/i)).toBeInTheDocument();
  });

  it('renders product tagline', () => {
    renderLogin({ status: 'unauthenticated' });
    expect(screen.getByText(/libretto di manutenzione/i)).toBeInTheDocument();
  });
});
