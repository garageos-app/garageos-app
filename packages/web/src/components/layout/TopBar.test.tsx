import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TopBar } from './TopBar';

// Mock useAuth
vi.mock('@/auth/useAuth', () => ({
  useAuth: () => ({
    state: { status: 'authenticated', user: { email: 'mario@officina.it' } },
    signOut: vi.fn(),
  }),
}));

// Mock ThemeToggle (irrelevant for this test)
vi.mock('@/theme/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}));

// Per-test override of useProfileMe
const profileQueryRef = { current: { data: undefined as unknown } };
vi.mock('@/queries/profileMe', () => ({
  useProfileMe: () => profileQueryRef.current,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('TopBar', () => {
  it('renders avatar img when profile.avatarUrl present', () => {
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: 'https://signed-url',
      },
    };
    render(<TopBar />, { wrapper });
    const img = screen.getByTestId('topbar-avatar-img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://signed-url/');
  });

  it('renders initials fallback when avatarUrl is null', () => {
    profileQueryRef.current = {
      data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null },
    };
    render(<TopBar />, { wrapper });
    expect(screen.getByTestId('topbar-avatar-initials')).toHaveTextContent('MR');
  });

  it('renders ? initials when profile not yet loaded', () => {
    profileQueryRef.current = { data: undefined };
    render(<TopBar />, { wrapper });
    expect(screen.getByTestId('topbar-avatar-initials')).toHaveTextContent('?');
  });

  it('renders email next to avatar', () => {
    profileQueryRef.current = {
      data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null },
    };
    render(<TopBar />, { wrapper });
    expect(screen.getByText('mario@officina.it')).toBeInTheDocument();
  });
});
