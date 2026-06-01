import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { Login } from './Login';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const signInMock = vi.fn();
vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    state: { status: 'unauthenticated' as const },
    signIn: signInMock,
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderLogin(initialEntry: string | { pathname: string; state?: unknown } = '/login') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Login />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Login page', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    signInMock.mockClear();
  });

  it('renders the email and password fields', () => {
    renderLogin();
    expect(screen.getByLabelText(/Email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accedi/i })).toBeInTheDocument();
  });

  it('renders the forgot-password link', () => {
    renderLogin();
    const link = screen.getByRole('link', { name: /Password dimenticata/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/forgot-password');
  });

  it('does not render a flash banner when navigation state has no flash', () => {
    renderLogin({ pathname: '/login', state: {} });
    expect(
      screen.queryByText('Password aggiornata. Accedi con la nuova password.'),
    ).not.toBeInTheDocument();
  });

  it('renders the success flash from navigation state', () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: { flash: 'Password aggiornata. Accedi con la nuova password.' },
          },
        ]}
      >
        <Login />
      </MemoryRouter>,
    );
    expect(
      screen.getByText('Password aggiornata. Accedi con la nuova password.'),
    ).toBeInTheDocument();
  });
});
