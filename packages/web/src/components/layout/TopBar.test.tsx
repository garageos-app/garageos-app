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

// onMenuClick is required by TopBar; supply a no-op in all render calls.
const noop = vi.fn();

describe('TopBar', () => {
  it('renders avatar img when profile.avatarUrl present', () => {
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: 'https://signed-url',
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper });
    const img = screen.getByTestId('topbar-avatar-img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://signed-url/');
  });

  it('renders officina business name and assigned sede in the brand strip', () => {
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper });
    expect(screen.getByText('Officina Matula')).toBeInTheDocument();
    expect(screen.getByText(/Sede Milano/)).toBeInTheDocument();
  });

  it('shows only the officina name when the user has no assigned sede', () => {
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: null,
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper });
    expect(screen.getByText('Officina Matula')).toBeInTheDocument();
    expect(screen.queryByText(/Sede/)).not.toBeInTheDocument();
  });

  it('renders initials fallback when avatarUrl is null', () => {
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper });
    expect(screen.getByTestId('topbar-avatar-initials')).toHaveTextContent('MR');
  });

  it('renders ? initials when profile not yet loaded', () => {
    profileQueryRef.current = { data: undefined };
    render(<TopBar onMenuClick={noop} />, { wrapper });
    expect(screen.getByTestId('topbar-avatar-initials')).toHaveTextContent('?');
  });

  it('renders email next to avatar', () => {
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper });
    expect(screen.getByText('mario@officina.it')).toBeInTheDocument();
  });

  it('calls onMenuClick when the hamburger is pressed', async () => {
    const onMenuClick = vi.fn();
    profileQueryRef.current = { data: undefined };
    render(<TopBar onMenuClick={onMenuClick} />, { wrapper });
    await userEvent.click(screen.getByRole('button', { name: /apri menu/i }));
    expect(onMenuClick).toHaveBeenCalledOnce();
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
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper });
    expect(screen.getByPlaceholderText('Cerca veicolo o cliente…')).toBeInTheDocument();
  });

  it('navigates to /search?q=<raw> for a vehicle identifier (no t param)', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'AB123CD');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=AB123CD');
  });

  it('navigates to /search?q=<raw> for a free-text customer query', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'Mario Rossi');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=Mario%20Rossi');
  });

  it('navigates for a phone-like query', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, '3331234567');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=3331234567');
  });

  it('trims whitespace before navigating', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, '   AB123CD   ');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/search?q=AB123CD');
  });

  it('does not navigate on empty submit', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.click(input);
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/');
  });

  it('shows a hint and does not navigate for a 1-char query', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'a');
    await user.keyboard('{Enter}');

    expect(loc.current).toBe('/');
    expect(screen.getByRole('alert')).toHaveTextContent('Inserisci almeno 2 caratteri.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the hint as soon as the user edits the input again', async () => {
    const user = userEvent.setup();
    const loc = { current: '/' };
    profileQueryRef.current = {
      data: {
        firstName: 'Mario',
        lastName: 'Rossi',
        avatarUrl: null,
        tenant: { businessName: 'Matula' },
        location: { name: 'Sede Milano', city: 'Milano' },
      },
    };
    render(<TopBar onMenuClick={noop} />, { wrapper: makeWrapperWithLocation(loc) });

    const input = screen.getByPlaceholderText('Cerca veicolo o cliente…');
    await user.type(input, 'a');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.type(input, 'b');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });
});
