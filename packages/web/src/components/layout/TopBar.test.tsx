import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

// LocationSelector pulls from LocationFilterProvider (not mounted in these
// unit tests); stub it — its own behavior is covered in LocationSelector.test.tsx.
vi.mock('@/location-filter/LocationSelector', () => ({
  LocationSelector: () => null,
}));

// Per-test override of useProfileMe
const profileQueryRef = { current: { data: undefined as unknown } };
vi.mock('@/queries/profileMe', () => ({
  useProfileMe: () => profileQueryRef.current,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
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

// Custom wrapper that captures current path via a ref
function makeWrapperWithLocation(locationRef: { current: string }) {
  function LocationCapture() {
    const location = useLocation();
    useEffect(() => {
      locationRef.current = location.pathname + location.search;
    }, [location]);
    return null;
  }
  return function W({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <LocationCapture />
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('<TopBar /> global search', () => {
  it('renders a search input with Italian placeholder', () => {
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper });
    expect(screen.getByPlaceholderText('Cerca veicolo o cliente…')).toBeInTheDocument();
  });

  it('submits search by navigating to /search?q=<value>&t=plate for a valid plate', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'AB123CD');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=AB123CD&t=plate');
  });

  it('submits search with t=vin for a 17-char VIN', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'ZFA31200000123456');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=ZFA31200000123456&t=vin');
  });

  it('submits search with t=garage_code for a GO-XXX-XXXX code', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'GO-482-KXRT');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=GO-482-KXRT&t=garage_code');
  });

  it('does not navigate on empty submit', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.click(input);
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/');
  });

  it('trims whitespace before navigating', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, '   AB123CD   ');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=AB123CD&t=plate');
  });

  it('shows inline error and does not navigate when input is not a valid plate/VIN/garage_code', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'Mario Rossi');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Inserisci una targa, un VIN (17 caratteri) o un codice GO-XXX-XXXX.',
    );
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears inline error as soon as user edits the input again', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = { data: { firstName: 'Mario', lastName: 'Rossi', avatarUrl: null } };
    render(<TopBar />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'Mario Rossi');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.type(input, 'X');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });
});
